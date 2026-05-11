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
sudo $EDITOR /etc/axona-bridge.env   # set PORT, LOG_LEVEL
sudo chmod 640 /etc/axona-bridge.env
sudo chown root:axona /etc/axona-bridge.env

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
