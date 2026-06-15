# Running an Axona bridge

A guide for **operators** who want to stand up their own Axona bridge and have
it join the public network. You do **not** need to be affiliated with the Axona
project — anyone can run a bridge, and a well-behaved bridge makes the whole
network more resilient.

- **Easiest:** [one-command installer](#path-a-one-command-installer) (a fresh
  Ubuntu/Debian VPS)
- **Containers:** [Docker Compose](#path-b-docker-compose) (any Linux Docker host)
- **Full control:** [manual install](#path-c-manual-install)

---

## What a bridge is (and why it's safe to run one)

Browsers can't accept inbound connections, so two browser peers can't find each
other unbidden. A **bridge** is a public WebSocket rendezvous: peers connect to
it, it relays the WebRTC handshake, and the peers then talk **directly,
peer-to-peer**. The bridge also runs an **embedded peer** so it participates in
the mesh like any node.

A bridge is **not** trusted with content or identity:

- It only brokers signaling. Peer-to-peer links are end-to-end encrypted (DTLS);
  the bridge can't read or inject mesh traffic.
- Peers mutually authenticate with channel binding, so a bridge can't
  impersonate a peer.
- Clients treat the directory as **fallbacks**, never auto-replacing their
  configured primary, and rank bridges by their *own* observed success.

So adding your bridge can only **help** the network — clients that discover it
gain another way to get connected, and lose nothing if it misbehaves.

### TURN is part of the deal

About a third of peers sit behind NAT that blocks direct WebRTC. For them the
only path is a **TURN relay**. A bridge without TURN silently fails those peers,
so **always run TURN with your bridge** — all three paths below set up
[coturn](https://github.com/coturn/coturn) for you. The bridge mints
short-lived TURN credentials for peers in its `welcome` message and advertises
its TURN endpoint in the directory; credentials are never published.

---

## Prerequisites (all paths)

1. **A host** — a small Linux VPS is plenty (1 vCPU / 1 GB RAM). Ubuntu 22.04 or
   24.04 LTS for the script path; any Linux with Docker for the container path.
2. **A domain name** you control, e.g. `bridge.example.org`, with an **A record
   pointing at the host's public IPv4**. Browsers need `wss://` (TLS), and TLS
   needs a real hostname.
3. **Open ports** on any provider/cloud firewall (the script can also manage the
   host `ufw`):

   | Port | Proto | Why |
   |------|-------|-----|
   | 22 | tcp | SSH (don't lock yourself out) |
   | 80 | tcp | ACME HTTP-01 challenge + HTTP→HTTPS redirect |
   | 443 | tcp | `wss://` to the bridge |
   | 3478 | udp + tcp | TURN control |
   | 49152–65535 | udp | TURN relay range |
   | 5349 | tcp | `turns://` (only if you enable TLS TURN) |

> Verify DNS before you start: `dig +short bridge.example.org` should print your
> host's IP. TLS issuance fails until it does.

---

## Path A — one-command installer

On a fresh Ubuntu/Debian host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/axona-net/axona-bridge/main/deploy/install.sh \
  | sudo BRIDGE_DOMAIN=bridge.example.org LETSENCRYPT_EMAIL=you@example.org bash
```

…or clone first and run it (same thing, lets you read it first):

```bash
git clone https://github.com/axona-net/axona-bridge.git
sudo bash axona-bridge/deploy/install.sh        # prompts for domain + email
```

It installs Node + nginx + certbot + coturn, creates the service user, fetches
and builds the bridge, writes `/etc/axona-bridge.env`, provisions a Let's
Encrypt cert, configures the TURN relay with a per-host secret, and starts
everything under systemd. Re-running it later is safe — it updates the code and
re-applies config, keeping your identity and TURN secret.

**Useful knobs** (environment variables):

| Var | Default | Meaning |
|-----|---------|---------|
| `BRIDGE_DOMAIN` | *(required)* | Public hostname |
| `LETSENCRYPT_EMAIL` | *(required)* | Cert-expiry notices |
| `BRIDGE_REGION_LABEL` | `self` | Short label shown in the directory |
| `BRIDGE_LAT` / `BRIDGE_LNG` | `38` / `-77` | Advertised location (proximity ranking) |
| `BRIDGE_REF` | `main` | Branch/tag to deploy |
| `ENABLE_TURNS` | `0` | Also serve `turns://` (TLS) on 5349 — reuses your cert |
| `CONFIGURE_UFW` | `0` | Configure **and enable** the host `ufw` firewall |
| `SKIP_TLS` | `0` | HTTP-only (testing; clients need `wss` in prod) |

Example, non-interactive with TLS TURN and firewall:

```bash
sudo BRIDGE_DOMAIN=bridge.example.org LETSENCRYPT_EMAIL=you@example.org \
     BRIDGE_REGION_LABEL=eu-west BRIDGE_LAT=53.3 BRIDGE_LNG=-6.2 \
     ENABLE_TURNS=1 CONFIGURE_UFW=1 \
     bash axona-bridge/deploy/install.sh
```

Then jump to [Verify](#verify).

---

## Path B — Docker Compose

Any Linux Docker host with ports 80/443 free and DNS pointing at it. Caddy
handles TLS automatically; coturn runs on host networking (TURN needs the relay
UDP range and real client IPs).

```bash
git clone https://github.com/axona-net/axona-bridge.git && cd axona-bridge
cp .env.docker.example .env
openssl rand -hex 32                      # use this as TURN_AUTH_SECRET
$EDITOR .env                              # set DOMAIN, PUBLIC_IP, TURN_AUTH_SECRET (+ BRIDGE_* / TURN_URLS to match DOMAIN)
docker compose up -d --build
```

The single `.env` feeds all three services — keep `DOMAIN` and
`TURN_AUTH_SECRET` consistent across them. The bridge's identity and discovered
bridges persist in the `bridge-data` volume, so its node-id is stable across
restarts.

> **TURN on Docker is `turn://` (3478) only.** Sharing a TLS cert between Caddy
> and coturn for `turns://` is fiddly; if you need `turns://` (peers on networks
> that block UDP/3478), use **Path A** with `ENABLE_TURNS=1`.

Update later: `git pull && docker compose up -d --build`.

Then jump to [Verify](#verify).

---

## Path C — manual install

Use this on a non-Debian distro or when you want to place each piece yourself.
Full step-by-step (apt prereqs, service user, systemd unit, nginx, certbot, the
coturn config, the firewall, and every real-world gotcha we hit) lives in
[`testnet-setup.md`](testnet-setup.md) — follow it but use **your own**
hostname, a fresh TURN secret, and `BRIDGE_DIRECTORY=on` (the testnet doc opts
*out* of the directory; you want *in*).

The shapes you need are in this repo:

- `deploy/axona-bridge.service` — the hardened systemd unit
- `deploy/nginx-axona-bridge.conf` — the nginx vhost
- `.env.example` — the full set of environment variables, documented

Minimum env (`/etc/axona-bridge.env`):

```ini
PORT=8080
BRIDGE_PUBLIC_URL=wss://bridge.example.org   # advertise + federate
BRIDGE_DIRECTORY=on
BRIDGE_REGION_LABEL=eu-west
BRIDGE_LAT=53.3
BRIDGE_LNG=-6.2
BRIDGE_IDENTITY_PATH=/var/lib/axona-bridge/identity.json
TURN_AUTH_SECRET=<same secret as coturn's static-auth-secret>
TURN_URLS=turn:bridge.example.org:3478       # add ,turns:...:5349 if you run TLS TURN
```

---

## Verify

```bash
curl https://bridge.example.org/healthz
```

You want to see:

- `"version"` — the bridge version, `"kernelVersion"` — the protocol kernel.
- `"directory": { "enabled": true, "url": "wss://bridge.example.org", ... }`
  → your bridge is advertising itself.
- `"uplink": { "upstream": "wss://…", "connected": true }`
  → it has federated into the live mesh (so other bridges/clients see it).

**Confirm TURN actually answers** (no browser needed) — reproduce the exact
credential the bridge mints and allocate against coturn:

```bash
SECRET=$(sudo grep '^TURN_AUTH_SECRET=' /etc/axona-bridge.env | cut -d= -f2)   # Path A/C
EXPIRY=$(( $(date +%s) + 3600 )); USER="$EXPIRY:test"
CRED=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
turnutils_uclient -y -u "$USER" -w "$CRED" -p 3478 bridge.example.org
# success → allocation lines.  NEGATIVE test: a bogus -w MUST be refused (401),
# else coturn is misconfigured as an open relay.
```

**End to end:** open any Axona app, and it will discover your bridge through the
directory and may fail over to it. Watch your logs while a peer connects:

```bash
journalctl -u axona-bridge -f          # Path A/C
docker compose logs -f bridge          # Path B
```

---

## Operating notes

- **Updates** — Path A: re-run `install.sh` (or `git pull && npm ci --omit=dev
  && systemctl restart axona-bridge`). Path B: `git pull && docker compose up -d
  --build`. The protocol gates on version, so keep reasonably current — a bridge
  too far behind the network's kernel floor is refused.
- **Identity is precious-ish** — the keypair at `BRIDGE_IDENTITY_PATH` (or the
  `bridge-data` volume) is your bridge's stable directory identity and the key
  clients build reputation on. Back it up; if you lose it the bridge simply
  reappears as a new, fresh entry.
- **Stay a good citizen** — run TURN, keep TLS valid (certbot auto-renews;
  `certbot renew --dry-run` to check), and set an honest `BRIDGE_REGION_LABEL` /
  lat-lng (clients rank by proximity — a wrong location just gets you ranked
  poorly).
- **Going private** — set `BRIDGE_DIRECTORY=off` to run an isolated bridge that
  neither advertises itself nor federates (e.g. a private deployment or a
  testnet). It still works as a rendezvous for clients you point at it directly.
- **Never share secrets across bridges** — each bridge gets its own
  `TURN_AUTH_SECRET` and its own identity.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `certbot` fails | DNS isn't pointing at the host yet, or port 80 is blocked. Fix DNS, re-run `certbot --nginx -d <domain>`. |
| `/healthz` works on `:8080` but not over HTTPS | nginx/Caddy or the cert isn't up. `nginx -t && systemctl reload nginx`; check `docker compose logs caddy`. |
| `directory.enabled: false` | `BRIDGE_PUBLIC_URL` missing/not `wss://`, or `BRIDGE_DIRECTORY=off`. |
| `uplink.connected: false` | No upstream reachable yet (fine if you're the only/first bridge — you become the seed). Optionally set `BRIDGE_UPSTREAMS=wss://a,wss://b`. |
| TURN test refused with a *valid* credential | coturn didn't load its config (restart it), or the secret in coturn ≠ the bridge's `TURN_AUTH_SECRET`. |
| Peers connect but never relay through TURN | relay UDP range `49152–65535` or `3478` blocked at the cloud firewall; `external-ip` wrong. |
| `npm ci` fails on `~/.npm` (manual path) | the service user has no home: `install -d -o axona -g axona /home/axona/.npm`. |
