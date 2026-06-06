# axona-bridge — San Francisco testnet droplet

A second Digital Ocean droplet that runs the **2.28.0 release build** (kernel
`v2.28.0`, bridge `2.13.0`) as an isolated testnet, hosted in San Francisco.
Identical in setup to the production droplet (`bridge.axona.net`, NYC) except:

| | production | SF testnet |
|---|---|---|
| region | NYC | **SFO3** |
| hostname | `bridge.axona.net` | **`testnet-bridge.axona.net`** (pick your own) |
| build | `main` (kernel 2.16.0) | **`release/2.28.0`** (kernel 2.28.0) |
| node geo | 38.00, −77.00 (us-east) | **37.77, −122.42 (us-west)** |
| TURN secret / identity | production's | **its own** (never reuse prod's) |

Because the 2.28.0 build carries the network partition (AUTH_PROTO `axona/5`,
WIRE_VERSION `2.0`), this testnet is **cryptographically isolated** from the
live 2.16.0 network by construction — a production node can't authenticate into
it and vice-versa, even though it's a separate endpoint. That's the point: it
lets you exercise the full flag-day build end-to-end before touching prod.

---

## 0. Create the droplet  (you — DO console or `doctl`)

Match the production droplet's plan (check the prod droplet's size in the DO
console first). Ubuntu 24.04 LTS, region **SFO3**, your SSH key added.

```bash
# doctl (run locally; provisions a billed resource on your account)
doctl compute droplet create axona-bridge-sf \
  --region sfo3 \
  --image ubuntu-24-04-x64 \
  --size <MATCH-PROD-SIZE e.g. s-1vcpu-1gb> \
  --ssh-keys <your-key-fingerprint> \
  --wait
doctl compute droplet list   # note the new public IPv4
```

Add a convenience SSH alias (optional), mirroring `axona-bridge`:

```sshconfig
# ~/.ssh/config
Host axona-bridge-sf
    HostName <NEW_DROPLET_IPV4>
    User root
```

## 1. DNS  (you)

Add an **A record**: `testnet-bridge.axona.net → <NEW_DROPLET_IPV4>`.
Wait for it to resolve (`dig +short testnet-bridge.axona.net`) before certbot.

## 2. One-time droplet setup  (on the droplet)

Identical to `deploy/README.md`:

```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt -y install nodejs nginx certbot python3-certbot-nginx
sudo useradd --system --no-create-home --shell /usr/sbin/nologin axona
sudo mkdir -p /opt/axona-bridge && sudo chown -R axona:axona /opt/axona-bridge
```

## 3. Deploy the release build

```bash
cd /opt/axona-bridge
sudo -u axona git clone -b release/2.28.0 https://github.com/axona-net/axona-bridge.git .
sudo -u axona npm ci --omit=dev      # vendors @axona/protocol#v2.28.0
```

### Environment — `/etc/axona-bridge.env`

```ini
PORT=8080
LOG_LEVEL=info

# SF geo (us-west) — the only behavioural difference from prod.
BRIDGE_LAT=37.77
BRIDGE_LNG=-122.42
BRIDGE_REGION_LABEL=testnet-sf

# Its OWN persistent identity keypair — do NOT copy prod's.
BRIDGE_IDENTITY_PATH=/opt/axona-bridge/identity.testnet.json

# Its OWN TURN secret (any fresh random string), or omit TURN_* entirely
# to run STUN-only (fine for same-LAN / same-NAT testing; cross-NAT pairs
# may need TURN). Never reuse the production TURN_AUTH_SECRET.
# TURN_AUTH_SECRET=<fresh-random>
# TURN_URLS=turn:<your-turn-host>:3478

# Partition floors ship as the build's defaults (REQUIRED_WIRE_MAJOR=2,
# MIN_KERNEL_VERSION=2.28.0, MIN_PEER_APP_VERSION=3.15.0). Override here
# only to loosen the gate for a mixed-version experiment.
```

```bash
sudo chmod 640 /etc/axona-bridge.env && sudo chown root:axona /etc/axona-bridge.env
sudo cp deploy/axona-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now axona-bridge
sudo systemctl status axona-bridge
```

## 4. nginx + TLS  (testnet hostname)

```bash
sudo cp deploy/nginx-axona-bridge.conf /etc/nginx/sites-available/axona-bridge
# point it at the testnet hostname:
sudo sed -i 's/bridge\.axona\.net/testnet-bridge.axona.net/g' \
  /etc/nginx/sites-available/axona-bridge
sudo ln -s /etc/nginx/sites-available/axona-bridge /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d testnet-bridge.axona.net
```

## 5. Verify

```bash
curl https://testnet-bridge.axona.net/healthz
# expect: "kernelVersion":"2.28.0", "version":"2.13.0",
#         "minKernelVersion":"2.28.0", "region":"testnet-sf (37.77, -122.42)"
```

## 6. Point a test client at it

Run a 2.28.0 / app-3.15.0 build with `bridgeUrl = wss://testnet-bridge.axona.net`
(a local/preview axona-peer build, or a separate testnet app deploy). Confirm:
two test clients form the mesh; a current production (2.16.0) client is **refused
at the gate** (`4426`), proving the partition.

## Updates

```bash
cd /opt/axona-bridge
sudo -u axona git pull            # stays on release/2.28.0
sudo -u axona npm ci --omit=dev
sudo systemctl restart axona-bridge
```
