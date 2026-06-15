#!/usr/bin/env bash
# =====================================================================
# install.sh — one-command Axona bridge installer for a fresh
# Ubuntu/Debian host (22.04 / 24.04 tested).
#
# Stands up the WHOLE bridge stack, wired the way a production bridge
# should be:
#   • Node.js LTS + the bridge service (systemd, hardened unit)
#   • nginx reverse proxy + Let's Encrypt TLS (wss://)
#   • coturn TURN relay (always — a bridge without TURN can't relay for
#     peers behind symmetric NAT) with a per-host secret
#   • the bridge env, with directory advertising + federation ON, and
#     the bridge's own TURN endpoint advertised in its directory entry
#
# USAGE (run as root on the target host):
#
#   # Interactive — prompts for the bits it needs:
#   sudo bash deploy/install.sh
#
#   # Non-interactive — everything via env:
#   sudo BRIDGE_DOMAIN=bridge.example.org LETSENCRYPT_EMAIL=you@example.org \
#        BRIDGE_REGION_LABEL=eu-west BRIDGE_LAT=53.3 BRIDGE_LNG=-6.2 \
#        bash deploy/install.sh
#
#   # Remote bootstrap (no local checkout needed):
#   curl -fsSL https://raw.githubusercontent.com/axona-net/axona-bridge/main/deploy/install.sh \
#     | sudo BRIDGE_DOMAIN=bridge.example.org LETSENCRYPT_EMAIL=you@example.org bash
#
# Re-running is safe (idempotent): it reuses the existing TURN secret and
# identity, updates the code, and re-applies config.
#
# Knobs (all optional except where noted), via environment:
#   BRIDGE_DOMAIN        (required) public hostname, e.g. bridge.example.org
#   LETSENCRYPT_EMAIL    (required unless SKIP_TLS=1) email for cert expiry notices
#   BRIDGE_LAT/BRIDGE_LNG/BRIDGE_REGION_LABEL   advertised location (default: us-east-ish, "self")
#   BRIDGE_REPO          git URL (default: https://github.com/axona-net/axona-bridge.git)
#   BRIDGE_REF           branch/tag (default: main)
#   INSTALL_DIR          (default: /opt/axona-bridge)
#   ENABLE_TURN          1|0 (default: 1) — set 0 only if you run TURN elsewhere
#   ENABLE_TURNS         1|0 (default: 0) — also serve turns:// (TLS) on 5349
#   PUBLIC_IP            override autodetected public IPv4 (for external-ip)
#   CONFIGURE_UFW        1|0 (default: 0) — also configure + enable the ufw host firewall
#   SKIP_TLS             1|0 (default: 0) — HTTP-only (testing; clients need wss in prod)
#   SKIP_DNS_CHECK       1|0 (default: 0) — skip the "does DNS point here?" preflight
#   NONINTERACTIVE       1|0 (default: 0) — never prompt; fail if a required var is missing
# =====================================================================
set -euo pipefail

# ── pretty logging ───────────────────────────────────────────────────
BOLD=$(tput bold 2>/dev/null || true); DIM=$(tput dim 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true); GRN=$(tput setaf 2 2>/dev/null || true)
YLW=$(tput setaf 3 2>/dev/null || true); RST=$(tput sgr0 2>/dev/null || true)
step() { printf '\n%s==>%s %s%s\n' "$BOLD$GRN" "$RST$BOLD" "$*" "$RST"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

INSTALL_DIR="${INSTALL_DIR:-/opt/axona-bridge}"
BRIDGE_REPO="${BRIDGE_REPO:-https://github.com/axona-net/axona-bridge.git}"
BRIDGE_REF="${BRIDGE_REF:-main}"
ENABLE_TURN="${ENABLE_TURN:-1}"
ENABLE_TURNS="${ENABLE_TURNS:-0}"
CONFIGURE_UFW="${CONFIGURE_UFW:-0}"
SKIP_TLS="${SKIP_TLS:-0}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
SERVICE_USER="axona"
ENV_FILE="/etc/axona-bridge.env"

# ── 0. preflight ─────────────────────────────────────────────────────
step "Preflight checks"
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash deploy/install.sh)."
command -v apt-get >/dev/null || die "This installer targets Debian/Ubuntu (apt). For other distros, see deploy/INSTALL.md (manual path)."
. /etc/os-release 2>/dev/null || true
info "Host: ${PRETTY_NAME:-unknown} ($(uname -m))"

prompt() { # prompt VAR "question" ["default"]
  local __var="$1" __q="$2" __def="${3:-}" __ans
  if [ -n "${!__var:-}" ]; then return; fi
  if [ "$NONINTERACTIVE" = "1" ] || [ ! -t 0 ]; then
    [ -n "$__def" ] && { printf -v "$__var" '%s' "$__def"; return; }
    die "$__var is required (set it in the environment; running non-interactively)."
  fi
  if [ -n "$__def" ]; then read -r -p "    $__q [$__def]: " __ans; __ans="${__ans:-$__def}";
  else read -r -p "    $__q: " __ans; fi
  printf -v "$__var" '%s' "$__ans"
}

prompt BRIDGE_DOMAIN "Public hostname for this bridge (e.g. bridge.example.org)"
[ -n "${BRIDGE_DOMAIN:-}" ] || die "BRIDGE_DOMAIN is required."
[[ "$BRIDGE_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "BRIDGE_DOMAIN looks malformed: $BRIDGE_DOMAIN"
if [ "$SKIP_TLS" != "1" ]; then
  prompt LETSENCRYPT_EMAIL "Email for Let's Encrypt expiry notices"
  [ -n "${LETSENCRYPT_EMAIL:-}" ] || die "LETSENCRYPT_EMAIL is required (or set SKIP_TLS=1)."
fi
BRIDGE_LAT="${BRIDGE_LAT:-38.0}"
BRIDGE_LNG="${BRIDGE_LNG:--77.0}"
BRIDGE_REGION_LABEL="${BRIDGE_REGION_LABEL:-self}"

detect_ip() {
  PUBLIC_IP="${PUBLIC_IP:-}"
  [ -n "$PUBLIC_IP" ] && return
  PUBLIC_IP=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null \
           || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null \
           || ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)
  [ -n "$PUBLIC_IP" ] || die "Could not detect the public IPv4. Set PUBLIC_IP=<addr> and re-run."
}
detect_ip
info "Public IPv4: $PUBLIC_IP"

if [ "$SKIP_DNS_CHECK" != "1" ] && [ "$SKIP_TLS" != "1" ]; then
  resolved=$(getent hosts "$BRIDGE_DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
  if [ -z "$resolved" ]; then
    warn "$BRIDGE_DOMAIN does not resolve yet. Add an A record → $PUBLIC_IP and wait for it to propagate; TLS issuance will fail otherwise."
  elif [ "$resolved" != "$PUBLIC_IP" ]; then
    warn "$BRIDGE_DOMAIN resolves to $resolved, not this host ($PUBLIC_IP). TLS issuance will fail until DNS points here."
  else
    info "DNS OK: $BRIDGE_DOMAIN → $PUBLIC_IP"
  fi
fi

info "Plan: domain=$BRIDGE_DOMAIN region='$BRIDGE_REGION_LABEL' ($BRIDGE_LAT,$BRIDGE_LNG) TURN=$([ "$ENABLE_TURN" = 1 ] && echo yes || echo no) TURNS=$([ "$ENABLE_TURNS" = 1 ] && echo yes || echo no) TLS=$([ "$SKIP_TLS" = 1 ] && echo no || echo yes)"

# ── 1. system packages ───────────────────────────────────────────────
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
PKGS="nginx certbot python3-certbot-nginx git curl openssl ca-certificates"
[ "$ENABLE_TURN" = "1" ] && PKGS="$PKGS coturn"
[ "$CONFIGURE_UFW" = "1" ] && PKGS="$PKGS ufw"
apt-get install -y -qq $PKGS >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  info "Installing Node.js LTS from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
info "node $(node -v)  npm $(npm -v)"

# ── 2. service user + directories ────────────────────────────────────
step "Service user + directories"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "/home/$SERVICE_USER" "$SERVICE_USER"
fi
# npm needs a real, writable HOME for its cache even for a --system user
# (--no-create-home would break `npm ci` with EACCES on ~/.npm).
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "/home/$SERVICE_USER" "/home/$SERVICE_USER/.npm"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"

# ── 3. fetch the code ────────────────────────────────────────────────
step "Fetching bridge source ($BRIDGE_REF)"
if [ -d "$INSTALL_DIR/.git" ]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"   # heal any root-owned objects
  sudo -H -u "$SERVICE_USER" git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRIDGE_REF"
  sudo -H -u "$SERVICE_USER" git -C "$INSTALL_DIR" checkout -B "$BRIDGE_REF" FETCH_HEAD
elif [ -f "$(dirname "$0")/../package.json" ] && [ "$(realpath "$(dirname "$0")/..")" = "$INSTALL_DIR" ]; then
  info "Using existing checkout at $INSTALL_DIR"
else
  sudo -H -u "$SERVICE_USER" git clone --depth 1 -b "$BRIDGE_REF" "$BRIDGE_REPO" "$INSTALL_DIR"
fi
step "Installing dependencies (npm ci)"
sudo -H -u "$SERVICE_USER" npm --prefix "$INSTALL_DIR" ci --omit=dev
KERNEL_DEP=$(node -p "require('$INSTALL_DIR/package.json').dependencies['@axona/protocol']" 2>/dev/null || echo '?')
BRIDGE_VER=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo '?')
info "axona-bridge $BRIDGE_VER  (kernel $KERNEL_DEP)"

# ── 4. TURN secret (reuse if already provisioned) ────────────────────
TURN_SECRET=""
if [ -f "$ENV_FILE" ]; then
  TURN_SECRET=$(grep -E '^TURN_AUTH_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
fi
if [ "$ENABLE_TURN" = "1" ] && [ -z "$TURN_SECRET" ]; then
  TURN_SECRET=$(openssl rand -hex 32)
fi

# ── 5. coturn ────────────────────────────────────────────────────────
if [ "$ENABLE_TURN" = "1" ]; then
  step "Configuring coturn (TURN relay)"
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  {
    echo "listening-port=3478"
    echo "fingerprint"
    echo "use-auth-secret"
    echo "static-auth-secret=$TURN_SECRET"
    echo "realm=$BRIDGE_DOMAIN"
    echo "listening-ip=0.0.0.0"
    echo "external-ip=$PUBLIC_IP"
    echo "min-port=49152"
    echo "max-port=65535"
    echo "no-cli"
    echo "no-tlsv1"
    echo "no-tlsv1_1"
    if [ "$ENABLE_TURNS" = "1" ]; then
      echo "tls-listening-port=5349"
      echo "cert=/etc/coturn/certs/fullchain.pem"
      echo "pkey=/etc/coturn/certs/privkey.pem"
    fi
  } > /etc/turnserver.conf
  chmod 640 /etc/turnserver.conf; chown root:turnserver /etc/turnserver.conf 2>/dev/null || true
  TURN_URLS="turn:$BRIDGE_DOMAIN:3478"
  [ "$ENABLE_TURNS" = "1" ] && TURN_URLS="$TURN_URLS,turns:$BRIDGE_DOMAIN:5349"
else
  warn "ENABLE_TURN=0 — this bridge will be STUN-only unless TURN_AUTH_SECRET/TURN_URLS are set manually in $ENV_FILE."
  TURN_URLS=""
fi

# ── 6. bridge env ────────────────────────────────────────────────────
step "Writing $ENV_FILE"
{
  echo "# Generated by deploy/install.sh — $(date -u +%FT%TZ 2>/dev/null || echo)"
  echo "PORT=8080"
  echo "LOG_LEVEL=info"
  echo "BRIDGE_PUBLIC_URL=wss://$BRIDGE_DOMAIN"
  echo "BRIDGE_DIRECTORY=on"
  echo "BRIDGE_LAT=$BRIDGE_LAT"
  echo "BRIDGE_LNG=$BRIDGE_LNG"
  echo "BRIDGE_REGION_LABEL=$BRIDGE_REGION_LABEL"
  echo "BRIDGE_IDENTITY_PATH=/var/lib/axona-bridge/identity.json"
  if [ "$ENABLE_TURN" = "1" ]; then
    echo "TURN_AUTH_SECRET=$TURN_SECRET"
    echo "TURN_URLS=$TURN_URLS"
  fi
} > "$ENV_FILE"
chmod 640 "$ENV_FILE"; chown root:"$SERVICE_USER" "$ENV_FILE"

# ── 7. systemd unit ──────────────────────────────────────────────────
step "Installing systemd unit"
install -m 644 "$INSTALL_DIR/deploy/axona-bridge.service" /etc/systemd/system/axona-bridge.service
# honor a non-default INSTALL_DIR (the unit ships pinned to /opt/axona-bridge)
[ "$INSTALL_DIR" != "/opt/axona-bridge" ] && \
  sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$INSTALL_DIR#" /etc/systemd/system/axona-bridge.service
systemctl daemon-reload
systemctl enable --now axona-bridge >/dev/null 2>&1 || systemctl restart axona-bridge
sleep 3

# ── 8. nginx (HTTP first; certbot adds TLS) ──────────────────────────
step "Configuring nginx"
cat > /etc/nginx/sites-available/axona-bridge <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $BRIDGE_DOMAIN;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location = /healthz {
        proxy_pass http://127.0.0.1:8080/healthz;
        proxy_set_header Host \$host;
        access_log off;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/axona-bridge /etc/nginx/sites-enabled/axona-bridge
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 9. TLS via certbot (clones the :80 vhost into a :443 TLS vhost) ──
if [ "$SKIP_TLS" != "1" ]; then
  step "Provisioning TLS certificate (Let's Encrypt)"
  if certbot --nginx -d "$BRIDGE_DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect; then
    info "TLS active for https/wss://$BRIDGE_DOMAIN"
  else
    warn "certbot failed (DNS not pointing here yet?). The bridge runs on HTTP for now; re-run: certbot --nginx -d $BRIDGE_DOMAIN"
  fi
fi

# ── 9b. turns:// cert plumbing (optional) ────────────────────────────
if [ "$ENABLE_TURN" = "1" ] && [ "$ENABLE_TURNS" = "1" ] && [ "$SKIP_TLS" != "1" ]; then
  step "Wiring turns:// TLS cert for coturn"
  install -d -o turnserver -g turnserver -m 750 /etc/coturn/certs
  HOOK=/etc/letsencrypt/renewal-hooks/deploy/coturn-cert.sh
  cat > "$HOOK" <<HK
#!/bin/sh
# Copy the renewed LE cert into a coturn-readable location and reload.
D="$BRIDGE_DOMAIN"
install -o turnserver -g turnserver -m 600 "/etc/letsencrypt/live/\$D/fullchain.pem" /etc/coturn/certs/fullchain.pem
install -o turnserver -g turnserver -m 600 "/etc/letsencrypt/live/\$D/privkey.pem"   /etc/coturn/certs/privkey.pem
systemctl restart coturn
HK
  chmod +x "$HOOK"
  if [ -d "/etc/letsencrypt/live/$BRIDGE_DOMAIN" ]; then sh "$HOOK" || warn "turns:// cert copy failed; coturn will serve turn:// only."; fi
fi

# ── 10. start coturn (restart so the new config is loaded) ───────────
if [ "$ENABLE_TURN" = "1" ]; then
  step "Starting coturn"
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
fi

# ── 11. firewall (opt-in) ────────────────────────────────────────────
if [ "$CONFIGURE_UFW" = "1" ]; then
  step "Configuring host firewall (ufw)"
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  if [ "$ENABLE_TURN" = "1" ]; then
    ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null
    ufw allow 49152:65535/udp >/dev/null
    [ "$ENABLE_TURNS" = "1" ] && ufw allow 5349/tcp >/dev/null
  fi
  ufw --force enable >/dev/null
  info "ufw enabled (22, 80, 443$([ "$ENABLE_TURN" = 1 ] && echo ', 3478, 49152-65535/udp'))"
else
  warn "Host firewall NOT configured. Ensure your provider/host firewall allows: 22, 80, 443$([ "$ENABLE_TURN" = 1 ] && echo ', 3478 tcp+udp, 49152-65535/udp')$([ "$ENABLE_TURNS" = 1 ] && echo ', 5349 tcp'). Re-run with CONFIGURE_UFW=1 to manage ufw here."
fi

# ── 12. verify ───────────────────────────────────────────────────────
step "Verifying"
sleep 2
HEALTH=$(curl -fsS --max-time 8 http://127.0.0.1:8080/healthz 2>/dev/null || true)
if [ -n "$HEALTH" ]; then
  ET="$ENABLE_TURN" node -e "const d=JSON.parse(process.argv[1]); console.log('    bridge', d.version, '| kernel', d.kernelVersion||d.kernel||'?', '| region', d.region||'?', '| directory', JSON.stringify(d.directory||{}), '| turnMinting', (process.env.ET==='1'?'enabled':'disabled'));" "$HEALTH" 2>/dev/null || echo "    $HEALTH"
else
  warn "Local /healthz did not respond yet. Check: journalctl -u axona-bridge -n 50"
fi
[ "$ENABLE_TURN" = "1" ] && info "coturn: $(systemctl is-active coturn)"
info "bridge: $(systemctl is-active axona-bridge)"

cat <<DONE

$BOLD$GRN✔ Axona bridge installed.$RST

  Public endpoint : ${BOLD}wss://$BRIDGE_DOMAIN${RST}$([ "$SKIP_TLS" = 1 ] && echo "  (TLS skipped — clients need wss in production)")
  Health          : curl https://$BRIDGE_DOMAIN/healthz
  Service logs    : journalctl -u axona-bridge -f
  Config          : $ENV_FILE   (edit, then: systemctl restart axona-bridge)
  Update later    : sudo bash $INSTALL_DIR/deploy/install.sh   (re-run; safe)

  This bridge advertises itself on the public bridge-directory and federates
  into the mesh, so existing apps/bridges can discover and fail over to it.
  See deploy/INSTALL.md for verification, TURN testing, and operator notes.
DONE
