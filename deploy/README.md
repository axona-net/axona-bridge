# axona-bridge deployment

Operational artifacts for deploying the bridge to a Digital Ocean droplet (Ubuntu 24.04 LTS).

## One-time droplet setup

```bash
# DNS first: A record from bridge.axona.net → droplet IPv4.

sudo apt update && sudo apt -y upgrade

# Node.js (LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt -y install nodejs

# nginx + certbot
sudo apt -y install nginx certbot python3-certbot-nginx

# TURN — ALWAYS deploy a TURN server with a bridge (not optional): a STUN-only
# bridge can't relay for peers behind symmetric NAT. Stand up coturn on this
# droplet (shared static-auth-secret), set TURN_AUTH_SECRET (== coturn's) +
# TURN_URLS in the env; the bridge then mints creds in its welcome AND advertises
# the TURN endpoint in its directory entry. Full coturn config: deploy/testnet-setup.md §4b.

# Service user + workdir
sudo useradd --system --no-create-home --shell /usr/sbin/nologin axona
sudo mkdir -p /opt/axona-bridge
sudo chown -R axona:axona /opt/axona-bridge
```

## Deploy the code

```bash
# As the axona user (or via sudo -u axona)
cd /opt/axona-bridge
sudo -u axona git clone https://github.com/axona-net/axona-bridge.git .
sudo -u axona npm ci --omit=dev

# Environment
sudo cp .env.example /etc/axona-bridge.env
sudo $EDITOR /etc/axona-bridge.env   # set PORT, LOG_LEVEL, BRIDGE_PUBLIC_URL
sudo chmod 640 /etc/axona-bridge.env
sudo chown root:axona /etc/axona-bridge.env
# Bridge directory: set BRIDGE_PUBLIC_URL=wss://<this-bridge> so the bridge
# advertises itself for client discovery/failover. The TESTNET bridge MUST
# set BRIDGE_DIRECTORY=off (independent fleet — do not advertise it into the
# public directory). Verify which mode is live via /healthz → directory.{enabled,url}.
#
# Federation (v2.23.0+): when BRIDGE_DIRECTORY is on, the bridge also bootstraps
# INTO the live mesh as a node — an OUTBOUND uplink to a known bridge — so its
# directory entry is visible network-wide. This pulls in `node-datachannel` (a
# native WebRTC module; `npm ci` installs a prebuilt for linux-x64). Optional
# BRIDGE_UPSTREAMS=wss://a,wss://b overrides the seed list (self is excluded; a
# bridge with nothing reachable runs uplink-less as the seed). /healthz →
# uplink.{upstream,connected}. The first/root bridge can stay the seed
# (uplink-less); it does NOT need the new code for others to federate onto it.

# systemd unit
sudo cp deploy/axona-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now axona-bridge
sudo systemctl status axona-bridge
journalctl -u axona-bridge -f
```

## nginx + TLS

```bash
sudo cp deploy/nginx-axona-bridge.conf /etc/nginx/sites-available/axona-bridge
sudo ln -s /etc/nginx/sites-available/axona-bridge /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Provision the cert (certbot rewrites the nginx config in place)
sudo certbot --nginx -d bridge.axona.net

# Verify
curl https://bridge.axona.net/healthz
```

## Smoke test against the deployed bridge

From any machine:

```bash
BRIDGE=wss://bridge.axona.net node scripts/smoke-client.js
```

## Updates

```bash
cd /opt/axona-bridge
sudo -u axona git pull
sudo -u axona npm ci --omit=dev
sudo systemctl restart axona-bridge
```
