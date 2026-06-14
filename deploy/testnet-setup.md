# axona-bridge — San Francisco testnet droplet

A second Digital Ocean droplet that runs the **2.28.0 release build** (kernel
`v2.28.0`, bridge `2.13.0`) as an isolated testnet, hosted in San Francisco.
Identical in setup to the production droplet (`bridge.axona.net`, NYC) except:

| | production | SF testnet |
|---|---|---|
| region | NYC | **SFO3** |
| hostname | `bridge.axona.net` | **`testnet.axona.net`** (pick your own) |
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

Add an **A record**: `testnet.axona.net → <NEW_DROPLET_IPV4>`.
Wait for it to resolve (`dig +short testnet.axona.net`) before certbot.

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

# Bridge directory: the testnet runs an INDEPENDENT fleet and must NOT advertise
# itself into the public directory the production apps read. Opt out explicitly.
# (Belt-and-suspenders: without BRIDGE_PUBLIC_URL the bridge skips publishing
# anyway, but set this so an accidental BRIDGE_PUBLIC_URL can't leak it.)
BRIDGE_DIRECTORY=off

# Its OWN TURN secret (any fresh random string), or omit TURN_* entirely
# to run STUN-only (fine for same-LAN / same-NAT testing; cross-NAT pairs
# may need TURN). Never reuse the production TURN_AUTH_SECRET.
# TURN_AUTH_SECRET=<fresh-random>
# TURN_URLS=turn:<your-turn-host>:3478

# Partition floors ship as the build's defaults (REQUIRED_WIRE_MAJOR=2,
# MIN_KERNEL_VERSION=2.28.0, MIN_PEER_APP_VERSION=3.25.0). Override here
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
sudo sed -i 's/bridge\.axona\.net/testnet.axona.net/g' \
  /etc/nginx/sites-available/axona-bridge
sudo ln -s /etc/nginx/sites-available/axona-bridge /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d testnet.axona.net
```

## 4b. TURN relay — self-hosted coturn (optional)

The bridge does **not** run TURN; it mints short-lived coturn `use-auth-secret`
credentials and hands them to peers in the `welcome` (only when
`TURN_AUTH_SECRET` is set — otherwise peers run STUN-only). So "adding TURN"
means standing up a coturn server that shares the same secret. Simplest for an
isolated testnet: run coturn on this same droplet.

```bash
sudo apt -y install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

# One shared secret — the SAME value goes in coturn AND the bridge env.
SECRET=$(openssl rand -hex 32); echo "$SECRET"
```

`/etc/turnserver.conf` (replace `<PUBLIC_IP>` with the droplet's public IPv4):

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<SECRET>          # == bridge TURN_AUTH_SECRET
realm=testnet.axona.net
listening-ip=0.0.0.0
external-ip=<PUBLIC_IP>
min-port=49152
max-port=65535
no-cli
no-tlsv1
no-tlsv1_1
# turns:// (TLS) reuses the Let's Encrypt cert from step 5's certbot run:
cert=/etc/letsencrypt/live/testnet.axona.net/fullchain.pem
pkey=/etc/letsencrypt/live/testnet.axona.net/privkey.pem
```

```bash
sudo systemctl enable --now coturn
```

Open the firewall (DO cloud firewall and/or ufw) — TURN needs the control
ports **and** the relay range:

```bash
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp                      # turns (TLS)
sudo ufw allow 49152:65535/udp               # relay range
```

Then add to `/etc/axona-bridge.env` (the secret MUST match coturn's) and restart:

```ini
TURN_AUTH_SECRET=<SECRET>
TURN_URLS=turn:testnet.axona.net:3478,turns:testnet.axona.net:5349
```

```bash
sudo systemctl restart axona-bridge
```

Sanity-check the credential scheme without a browser — reproduce exactly what the
bridge mints (`username = <expiry>:<peerId>`, `credential =
base64(HMAC-SHA1(secret, username))`) and allocate against coturn:

```bash
EXPIRY=$(( $(date +%s) + 3600 )); USER="$EXPIRY:test"
CRED=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
turnutils_uclient -y -u "$USER" -w "$CRED" -p 3478 testnet.axona.net
# success → allocation lines; auth failure → the secret/scheme don't match.
```

> Alternative (not recommended for isolation): point `TURN_URLS` at an existing
> relay (e.g. prod's `turn.axona.net`) using that relay's secret. Works, but
> shares relay infra with production and means handling prod's secret.
> Self-hosting keeps the testnet clean.

## 5. Verify

```bash
curl https://testnet.axona.net/healthz
# expect: "kernelVersion":"2.28.0", "version":"2.13.0",
#         "minKernelVersion":"2.28.0", "region":"testnet-sf (37.77, -122.42)"
```

## 6. Point a test client at it

Run a 2.28.0 / app-3.25.0 build with `bridgeUrl = wss://testnet.axona.net`
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

## Corrections applied during the live SF bring-up

Real snags hit deploying `testnet.axona.net` — apply these (they supersede the
steps above where noted). The first two also affect the **production** flag-day.

1. **`npm ci` needs a home for the service user.** `useradd --no-create-home`
   leaves `/home/axona` absent, so npm's cache write fails (`EACCES`). Before
   step 3's `npm ci`:
   ```bash
   mkdir -p /home/axona && chown axona:axona /home/axona
   ```
2. **Regenerate the lockfile when bumping the kernel pin (PROD-CRITICAL).**
   Bumping `package.json` to `#v2.28.0` without updating `package-lock.json`
   makes `npm ci` silently install the OLD kernel (the lock wins). Fixed on this
   branch; for any future bump: `rm -f package-lock.json && npm install
   --omit=dev`, verify the lock resolves the new version, commit it.
3. **certbot `--nginx` can't run against this template** (its `listen 443 ssl`
   block ships with the cert lines commented → `nginx -t` fails). Use
   `certonly --standalone`, then uncomment the cert lines:
   ```bash
   systemctl stop nginx
   certbot certonly --standalone -d testnet.axona.net
   sed -i 's/# ssl_certificate/ssl_certificate/g' /etc/nginx/sites-available/axona-bridge
   nginx -t && systemctl start nginx
   ```
   Then add a renewal deploy-hook to reload nginx, AND switch the cert's renewal
   authenticator from `standalone` to `nginx` — otherwise renewal fails forever
   (standalone can't bind port 80 while nginx holds it; `certbot renew --dry-run`
   catches this). The `--nginx` switch works now that the cert exists and the
   config is valid:
   ```bash
   mkdir -p /etc/letsencrypt/renewal-hooks/deploy
   printf '#!/bin/sh\nsystemctl reload nginx\n' \
     > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
   chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
   # re-issue via the nginx authenticator → rewrites renewal to authenticator=nginx
   certbot certonly --nginx -d testnet.axona.net --cert-name testnet.axona.net --force-renewal
   systemctl reload nginx
   certbot renew --dry-run   # must end: "all simulated renewals succeeded"
   ```
4. **Restart coturn after writing its config.** The package auto-starts coturn
   at install with the default config; `systemctl enable --now` won't restart an
   already-running unit, so `/etc/turnserver.conf` isn't loaded until an explicit
   `systemctl restart coturn`. Verify with a NEGATIVE test (a bogus credential
   MUST return `401`/allocation-refused — else coturn is an open relay).
5. **Firewall.** The raw bridge port (8080) is world-reachable by default. Use a
   DO **cloud firewall** allowing only inbound 22 / 80 / 443 / 3478(tcp+udp) /
   49152–65535(udp) — that drops 8080 automatically. (If using host `ufw`,
   allow `OpenSSH` first to avoid lockout.)
