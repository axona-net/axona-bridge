# axona-bridge

WebSocket signaling broker for the [Axona](https://github.com/axona-net) protocol. A new peer connects here first; the bridge tells it about every other connected peer, and announces the new arrival to everyone else. The peers then negotiate WebRTC DataChannels through the bridge, after which they talk directly without going through it. The bridge also responds to direct pings as itself, so it shows up in each peer's UI as one of the lights in the mesh.

**v2.154.0**, embedding kernel **4.107.2** (wire **4.0**, `axona/5` authenticated handshake; the pinned kernel version is in `package.json` and served live at `/healthz`). It runs an embedded `AxonaPeer` from [`@axona/protocol`](https://github.com/axona-net/axona-protocol) and acts as a server-class **highway** node in the network — persistent identity, larger synaptome cap, a routable target for any browser peer's lookups, and, with `BRIDGE_NEVER_ROOT=0` as the production bridges run, an ordinary root for region-keyed pub/sub (see [the section on roots](#roots-and-bridge_never_root) below). The bridge is **bootstrap-only, not a data path**: peers that are already meshed can form new links with the bridge process dead (peer-relayed signaling), so it strengthens the network without owning it.

## Run your own bridge

Anyone can run a bridge and have it join the public network — it makes the mesh
more resilient and is safe to operate (a bridge only brokers signaling; it can't
read or impersonate peer traffic). This is deliberate: the bridge is the
network's one semi-centralized touchpoint, so bridges **advertise themselves in
the directory** and nodes **collect that list on launch** to turn that single
point of failure into a moving target — no single *fixed* address to block,
automatic failover, and new bridges discovered without a client update. (Caveats:
this defeats ad-hoc blocking, not a determined adversary who
enumerates the whole fleet at once; and it does *not* by itself stop bridge
Sybil/false-advertising — client-side ranking bounds that. See
[deploy/INSTALL.md](deploy/INSTALL.md).) **[deploy/INSTALL.md](deploy/INSTALL.md)**
is the operator manual. The fast path, on a fresh Ubuntu/Debian host:

```bash
curl -fsSL https://raw.githubusercontent.com/axona-net/axona-bridge/main/deploy/install.sh \
  | sudo BRIDGE_DOMAIN=bridge.example.org LETSENCRYPT_EMAIL=you@example.org bash
```

That sets up the whole stack — Node service (systemd), nginx + Let's Encrypt
TLS, and a **coturn TURN relay** (always deployed with a bridge) — and the
bridge advertises itself in the directory and federates into the mesh. Prefer
containers? `cp .env.docker.example .env && docker compose up -d --build`
(Caddy auto-TLS + coturn). Both paths and a manual walkthrough are in
[deploy/INSTALL.md](deploy/INSTALL.md).

What the bridge does today:

- **Signaling.** `peer-list`, `peer-joined`, `peer-left`, and opaque `signal` relay so peers can negotiate WebRTC DataChannels. After the channel opens they talk directly; the bridge is no longer in the data path. It also relays **mesh signaling** so peers can form *bridgeless* links through each other.
- **Authenticated admission + version gate.** Every connection runs the kernel's `axona/5` authenticated handshake. A `client-hello` is checked against `REQUIRED_WIRE_MAJOR` (=4) and the kernel-version floor; a peer below the floor or on the wrong wire epoch is closed with **4426** (`upgrade required`). Peers on retired wire epochs are partitioned out by design.
- **Embedded protocol participant.** Persistent nodeId, NH-1 routing primitives over WebSocket, pub/sub root. `/healthz` and `/diag` surface the bridge nodeId, synaptome size, and the embedded **kernel version**.
- **TURN credential minting.** Hands browsers short-lived TURN credentials (the `draft-uberti-rtcweb-turn-rest` scheme, validated by self-hosted **coturn** in `use-auth-secret` mode) so WebRTC works across restrictive NATs.

The Axona wire frames piggyback on the browser ↔ bridge WebSocket as `{type: 'axona', payload: <req/res/ntf frame>}`. No `node-webrtc` dependency.

Configure the bridge's geographic prefix via env vars:

```bash
BRIDGE_LAT=51.5  BRIDGE_LNG=-0.1  BRIDGE_REGION_LABEL="London"  npm start
```

The bridge's transport identity is **ephemeral** — a fresh keypair and nodeId every
start, written nowhere (INVARIANT I-ID: a nodeId that survived restarts would be a
durable correlator for the host's IP and location, and would buy nothing back).
The bridge directory and first-party reputation are keyed on the bridge **URL**, not
on its signer, so clients still discover, rank, and fail over to it across restarts.

## Quickstart (local)

```bash
npm install
npm start
# → {"ts":"…","level":"info","event":"listen","host":"0.0.0.0","port":8080,"logLevel":"info","version":"2.154.0","idleTimeoutMs":15000,"idleCheckIntervalMs":5000,"turnMinting":…}
```

That line is the shape a production bridge logged on 2026-10-02. Note that a bridge
started this way joins the PUBLIC network: `BRIDGE_DIRECTORY` defaults to `on`, so it
uplinks into production and, once established, advertises itself. For a bridge that
must stay off production, set `BRIDGE_DIRECTORY=off`, or `BRIDGE_UPSTREAMS` with
`BRIDGE_UPSTREAMS_ONLY=on`.

Smoke tests:

```bash
npm run smoke
#   single client × N pings; sanity test of the ping/pong path.

npm run smoke:signal
#   two simulated clients exercising welcome / peer-list / peer-joined /
#   bidirectional signal relay / peer-left.
```

Quick health check (reports the embedded kernel version):

```bash
curl http://localhost:8080/healthz
# {"status":"ok","version":"2.154.0","kernelVersion":"4.107.2"}

curl -H "X-Healthz-Token: $HEALTHZ_TOKEN" http://localhost:8080/healthz
# {"status":"ok","connections":…,"admitted":…,"pending":…,"minPeerVersion":"1.1.0",
#  "minKernelVersion":"3.15.0","minPeerAppVersion":"3.15.0","uptimeS":…,
#  "version":"2.154.0","kernelVersion":"4.107.2","nursery":{…},"axona":{…},
#  "directory":{…},"uplink":{…},"meshDegree":{…},"admission":{…},"loop":{…}}
```

Without the token a bridge reports three keys and nothing that fingerprints
topology. With it, the full operator body; each bridge has its OWN token, and a wrong
one returns the short body rather than an error.

**`status` is `ok`, `degraded` or `unknown`, and `degraded` currently means less than it
sounds.** It is exactly `admission.saturated === true` (`src/server.js:824`). On an
idle bridge that predicate follows the kernel's ~60-second ROOT refresh cycle: the
oldest root obligation ages toward its 60,000 ms deadline, `servicePressure` crosses
0.6, and `saturated` reads true for roughly 40% of every minute with nothing overdue,
nothing unserviced and no stalls. The sawtooth was timed on east on 2026-10-01; on
2026-10-02 both production bridges' public endpoints returned `degraded` between
`ok`s. So an external monitor reading this endpoint will see a healthy bridge flap to
`degraded` about once a minute. Read the token body's `admission`
before acting on it. The coincidence of the two 60-second periods is the subject of
[axona-protocol#72](https://github.com/axona-net/axona-protocol/issues/72).

## Wire format

All messages are JSON. The `payload` of a `signal` is opaque to the bridge — it's whatever bytes the peers' WebRTC negotiation needs to pass (SDP offer/answer, ICE candidate, end-of-candidates marker).

### Client → bridge

| Type | Payload | Purpose |
|---|---|---|
| `ping` | `{ t: <client epoch ms> }` | Direct ping to the bridge (same as Phase 1). |
| `signal` | `{ to: <peerId>, payload: <opaque> }` | Relay an SDP / ICE message to another peer. |

### Bridge → client (own socket)

| Type | Payload | When |
|---|---|---|
| `welcome` | `{ connId, serverT, version }` | Once, immediately on connect. The client's assigned peer ID. |
| `peer-list` | `{ peers: [<peerId>, ...], serverT }` | Once, immediately after `welcome`. Lists every other currently-connected peer. **The new peer is the WebRTC initiator** to everyone in this list. |
| `pong` | `{ t: <echoed unchanged>, serverT }` | Response to each `ping`. |
| `signal` | `{ from: <peerId>, payload }` | Relayed message from another peer. |

### Bridge → all other peers (broadcast)

| Type | Payload | When |
|---|---|---|
| `peer-joined` | `{ peerId, serverT }` | A new peer connected. Existing peers **wait** for an offer from this peer. |
| `peer-left` | `{ peerId, serverT }` | A peer's socket closed. Tear down the WebRTC connection to it. |

### The connection-initiation rule

When two peers need to set up a WebRTC connection, the bridge's announcements deterministically assign roles:

- The peer in someone's `peer-list` is the **initiator** — it creates the SDP offer and sends it via `signal`.
- The peer in someone's `peer-joined` event is the **responder** — it waits for the offer, creates the answer, sends it back.

This means *new peers initiate, established peers respond*. There's no race where both sides try to offer simultaneously.

```
   ┌────────┐  1. welcome + peer-list:[]              ┌─────────┐
   │   P1   │ ◄────────────────────────────────────── │ Bridge  │
   └────────┘                                         │         │
                                                      │         │
   ┌────────┐  2. welcome + peer-list:[P1]            │         │
   │   P2   │ ◄────────────────────────────────────── │         │
   └───┬────┘  3. peer-joined:P2 ────────────────────►│         │
       │                                              └────┬────┘
       │ 4. signal {to:P1, payload:sdp-offer} ────────────►│
       │                                                   │
       │                ◄──── 4'. signal {from:P2, payload:sdp-offer}
       │                                            ┌──────┴──┐
       │                                            │   P1    │
       │                                            └──────┬──┘
       │ 5'. signal {from:P1, payload:sdp-answer} ◄────────┤
       │                                                   │
       │ … ICE candidates trickle the same way …           │
       │                                                   │
       │ ═══════════ WebRTC DataChannel open ══════════════╪═══
       │ ════════════ peer-to-peer ping/pong ═════════════►│
       └───────────────────────────────────────────────────┘
                  (bridge is no longer in the data path)
```

## Configuration

Every variable the bridge reads, with its default as written in code on 2026-10-02
(`src/config.js` for most; `bridge_directory.js`, `bridge_engine.js`, `identity.js`,
`kernel_log.js`, `uplink_policy.js` and `bridge_axona_node.js` for the rest). The
`.env.example` files carry only the common ones.

This table had drifted to 19 of the 47 variables by 2026-10-02. `src/config.js` says
the table is generated from its `SETTINGS` list; no generator exists yet, so treat a
default here as a claim to check against the code, not the reverse.

| Var | Default | Notes |
|---|---|---|
| **Listening** | | |
| `PORT` | `8080` | TCP port. Ignored when the bridge is mounted on an existing server (`src/bridge.js`) |
| `HOST` | `0.0.0.0` | interface to bind |
| **Operator surface** | | |
| `HEALTHZ_TOKEN` | unset | token for the full `/healthz` and `/diag` bodies, sent as `X-Healthz-Token`. Unset = only the three-key public body. Each bridge has its own |
| `LOG_LEVEL` | `info` | `debug` logs every ping/pong and signal relay (verbose) |
| **Who may connect** | | |
| `REQUIRED_WIRE_MAJOR` | `4` | reject any `client-hello` not on this wire major |
| `MIN_KERNEL_VERSION` | `3.15.0` | the legacy flag-day kernel floor; below → close 4426 |
| `MIN_PEER_VERSION` | `1.1.0` | floor on the client app's own `version`; 1.1.0 is the 264-bit node-id cutover |
| `MIN_PEER_APP_VERSION` | `3.15.0` | floor for peer-app-versioned clients |
| `STRICT_MIN_KERNEL` | unset | when set, close 4426 on any hello whose `kernelVersion` is missing or below it. Gates the exact kernel build, to isolate a single-kernel island. Unset = no gate |
| `HELLO_TIMEOUT_MS` | `5000` | how long to wait for a peer's authenticated hello before dropping it |
| `FLEET_ALLOWLIST` | unset | comma-separated node ids. When set, admit only a cryptographically proven identity on the list. Unset = allow all, which is production |
| **Idle reaping** | | |
| `IDLE_TIMEOUT_MS` | `15000` | a connection silent this long is a ghost, its TCP dropped without a close frame, and is terminated |
| `IDLE_CHECK_INTERVAL_MS` | `5000` | how often the idle sweep runs |
| `BRIDGE_TURN_REFRESH_RELEASE_MS` | `250` | 2.155.0. A client-hello with `intent: 'turn-refresh'` (kernel ≥ 4.108.0, a graduate back for a TURN credential only) gets the welcome with the credential and nothing else — no peer-list, no announce, no bootstrap hello — and its socket is released with 4200 this long after the welcome. `/healthz` `nursery.turnRefreshOnly` counts them |
| `BRIDGE_UNBOUND_KICK_MS` | `120000` | 2.154.0. An admitted socket that has not bound an identity (the authenticated hello over this socket) this long is closed 4401, a plain-disconnect code the kernel reconnects from. The idle sweep cannot see such a socket: it pongs. `0` = never. `/healthz` `nursery.unboundKicked` counts them |
| **TURN** | | |
| `TURN_AUTH_SECRET` | unset | shared secret for minting `use-auth-secret` credentials, also read by coturn. Unset = none minted |
| `TURN_URLS` | `turn:turn.axona.net:3478` | comma-separated TURN URLs handed to browsers. Advertise only what is served: a `turns:` URL with nothing listening costs every client ICE time |
| **Nursery and anchors** | | |
| `BRIDGE_NURSERY` | `on` | hand a newcomer a bounded, keyspace-diverse anchor set instead of the full peer list. `off` restores the full list AND disables graduation |
| `BRIDGE_ANCHOR_K` | `8` | anchors handed to each newcomer |
| `BRIDGE_ANCHOR_MIN_POOL` | `3 × BRIDGE_ANCHOR_K` | below this many eligible peers the bridge hands the full list, so the nursery stays inert on a small network. Production runs `10`. Since 2.154.0 a bounded selection takes BOUND identities first (one per region, then by score) and an unbound socket only when fewer than `BRIDGE_ANCHOR_K` bound ones exist |
| `BRIDGE_ANCHOR_MIN_UPTIME_MS` | `15000` | minimum uptime for a peer to be offered as an anchor |
| `BRIDGE_MAX_PEERS` | `32` | admitted connections held before graduation begins. Production east runs `15` |
| `BRIDGE_MESH_MAX_PEERS` | `= BRIDGE_MAX_PEERS` | the same bound on the bridge's own WebRTC mesh degree, so a bridge is not capped on one side and unbounded on the other. `0` disables the mesh cap alone; the production bridges' `/diag` reads `meshDegree.cap: 0` |
| **Graduation** (close 4200 — "you are meshed; freeing the bridge slot") | | |
| `BRIDGE_SOCKET_IS_BOOTSTRAP` | unset (off) | 2.152.0, kernel ≥ 4.107.0. ON: the door advertises a reserved id for the bridge itself first in every peer-list; a newcomer's WebRTC channel to the bridge replaces its socket (closed with 4200 once the channel has bound and a fresh `meshBound` ≥ the safe floor); at the mesh cap an eligible newcomer's bind retires one incumbent. Off: byte-identical to 2.151.0. Refuses to start a mesh on a kernel pin without the surfaces |
| `BRIDGE_PROVISIONAL_MAX` | `20` | with the flag on: open door channels whose identity has not bound; the newest above it is retired |
| `BRIDGE_BIND_DEADLINE_MS` | `15000` | with the flag on: an open door channel still unbound after this is retired |
| `BRIDGE_MAKE_ROOM_PER_MIN` | `4` | with the flag on: incumbent retires per sliding minute; above it a newcomer at cap is refused as a relay refuses |
| `BRIDGE_SOCKET_BOOTSTRAP_MIN_KERNEL` | `4.107.0` | with the flag on: clients below this kernel are never offered the reserved id |
| `BRIDGE_SOCKET_BOOTSTRAP_COOLDOWN_MS` | `60000` | with the flag on: a retired identity is refused a bind, and its connection a new negotiation to the reserved id, for this long |
| `BRIDGE_GRADUATION_MIN_UPTIME_MS` | `30000` | a peer must be this old before it can be graduated |
| `BRIDGE_GRADUATION_MIN_KERNEL` | `4.35.0` | only clients that honour close 4200 are graduated; older ones count toward the cap and are never dropped |
| `BRIDGE_GRADUATION_SAFE_FLOOR` | `4` | minimum reported `meshBound` to be eligible — one above the client's own floor of 3 |
| `BRIDGE_GRADUATION_VITALITY_TTL_MS` | `20000` | a `meshBound` report older than this is stale; that peer falls back to the uptime proxy |
| `BRIDGE_GRADUATION_MAX_NURSERY_MS` | `600000` | a peer holding a slot this long is graduated on uptime alone. Never a region's last representative |
| `BRIDGE_GRADUATION_SLACK` | `2` | start graduating only above cap + slack (hysteresis) |
| `BRIDGE_GRADUATION_INTERVAL_MS` | `3000` | at most one graduation per interval |
| `BRIDGE_GRADUATION_COOLDOWN_MS` | `60000` | never re-graduate the same node within this window |
| **Directory and federation** | | |
| `BRIDGE_DIRECTORY` | `on` | advertise this bridge in the public directory and uplink it into the live mesh. `off` = an independent fleet, as the testnet bridge runs |
| `BRIDGE_PUBLIC_URL` | unset | the `wss://` URL this bridge advertises. With the directory on, also turns on the durable author key |
| `BRIDGE_DIRECTORY_MIN_UPTIME_MS` | `300000` | uptime required before this bridge advertises itself (the establishment gate) |
| `BRIDGE_DIRECTORY_MIN_PEERS` | `3` | mesh peers required before it advertises |
| `BRIDGE_DIRECTORY_POLL_MS` | `15000` | how often a not-yet-established bridge rechecks the two gates above |
| `BRIDGE_UPSTREAMS` | — | comma-separated upstream bridges to uplink to, tried first (then the bridge book, then the built-in prod bridges) |
| `BRIDGE_UPSTREAMS_ONLY` | `off` | `on` = fail-closed federation: dial only `BRIDGE_UPSTREAMS`, never the book or the prod bridges; if none answers, exit non-zero before advertising or listening. For a test bridge that must never join production |
| **State on disk** | | |
| `STATE_DIRECTORY` | unset (the working directory) | where `bridges.json` (the bridge book) and `author.json` live. The author key is the ONLY key a bridge persists; its transport identity is minted fresh every start |
| `BRIDGE_BOOK_PATH` | `$STATE_DIRECTORY/bridges.json` | explicit path for the bridge book |
| `BRIDGE_AUTHOR_PATH` | `$STATE_DIRECTORY/author.json` | explicit path for the author key |
| **Identity and region** | | |
| `BRIDGE_LAT` / `BRIDGE_LNG` / `BRIDGE_REGION_LABEL` | `38.0` / `-77.0` / `bridge (<lat>, <lng>)` | the bridge's geographic anchor: sets its S2 region prefix unless `BRIDGE_REGION` is set, and is always its location in the directory entry |
| `BRIDGE_REGION` | unset | `bridge` (kernel ≥ 4.88.0): mint the node id in the SYSTEM region 0xFF. All four Axona bridges run `bridge` (east since 2026-09-21; west, B1, B2 since 2026-10-09, David: every bridge lives in 0xFF). A kernel that does not honour the override makes the bridge **refuse to start** (the minted byte is checked). This bridge publishes and subscribes the directory in `eagle` (its home, 2.130.0, David 2026-09-21) and never in `bridge`; that is a property of this publisher only — the kernel still admits an 0xFF directory descriptor from other publishers, and no fence stops an 0xFF node from taking a role when nearer candidates are unavailable (separate design). Testnet-first; see `ops/region-0xff/` in the workspace. |
| **Roots** | | |
| `BRIDGE_NEVER_ROOT` | unset = **on** | on: the kernel refuses every topic role at the HARD tier. **Both production bridges set `0`.** Read [roots](#roots-and-bridge_never_root) before running a public bridge on the default |
| **Observability** | | |
| `BRIDGE_KERNEL_LOG` | `off` | `on` = forward the embedded kernel peer's info/warn/error events into this bridge's structured log as `kernel:<event>` rows, and add `admission` + `kernelLog` to `/diag`. Registration and reads only; routing is untouched. Pair with `LAT_TRACE=1` for per-hop ledger rows. Rows are capped per second and the overflow is reported as `kernel-log-throttled` |
| `LAT_TRACE` | — | `1` arms the kernel's own per-stage delivery trace. Read by the kernel at construction, so it must be set before start. Only reaches a bridge's log when `BRIDGE_KERNEL_LOG=on` |
| `BRIDGE_TEST_STALL` | unset | test hook for the loop-stall smoke. Never set in production |

## Logging

One JSON line per event to stdout. Canonical events:

- `listen` — server up (includes `port`, `version`)
- `connect` — new WS connection (`connId`, `ip`, `total`, `ua`)
- `peer-announce` — sent `peer-list` to newcomer + `peer-joined` to others (`connId`, `peers`, `announcedTo`)
- `signal-relay` (debug) — forwarded a signal between peers
- `signal-drop-unknown-to` (debug) — recipient is gone; silently dropped
- `disconnect` — connection closed (`connId`, `code`, `lifeS`, `pings`, `pongs`, `signals`, `notified`, `remaining`)
- `ws-error`, `bad-json`, `send-failed`, `broadcast-send-failed` — error paths
- `pong` (debug) — per-ping
- `shutdown-begin`, `shutdown-complete` — graceful exit

The list above is the original set. Most of a production log today is these:

- `client-hello-admitted` — passed the version gate (`peerVersion`, `floor`)
- `client-hello-timeout` (error) — connected and sent no hello within `HELLO_TIMEOUT_MS`
- `peer-graduated` — graduated off to free the slot (`kernelVersion`, `region`, `meshBound`, `basis`); followed by a `disconnect` with code **4200**
- `idle-kick` — no traffic for `IDLE_TIMEOUT_MS`; followed by a `disconnect` with code 1006

Rows carry `connId`; `nodeId` appears only on `disconnect`. Join on `connId`.

systemd captures stdout/stderr; tail with `journalctl -u axona-bridge -f`.

## Layout

```
axona-bridge/
├── src/
│   ├── server.js              # the bridge: WS host, version gate, signaling, TURN minting
│   ├── bridge_engine.js       # embedded AxonaPeer wiring (highway node, pub/sub root)
│   ├── bridge_axona_node.js   # the embedded protocol node
│   ├── ws_transport.js        # kernel Transport over the browser WebSocket
│   └── identity.js            # persistent Ed25519 identity (region-anchored)
├── scripts/
│   ├── smoke-client.js        # ping/pong smoke test
│   └── signal-smoke.js        # signaling smoke test
├── deploy/
│   ├── install.sh            # one-command installer (bridge + nginx/TLS + coturn + systemd)
│   ├── INSTALL.md            # operator manual — start here to run your own bridge
│   ├── axona-bridge.service   # systemd unit
│   ├── nginx-axona-bridge.conf  # production reverse proxy + TLS
│   ├── nginx-testnet-app.conf   # testnet.axona.net (peer app + same-origin bridge)
│   ├── nginx-testnet-demo.conf  # demo-testnet.axona.net (kernel demo at root)
│   ├── docker/Caddyfile        # auto-TLS reverse proxy for the Docker stack
│   ├── testnet-setup.md         # SF testnet droplet + coturn setup
│   └── README.md              # one-time droplet setup
├── Dockerfile                 # container image
├── docker-compose.yml         # bridge + Caddy (auto-TLS) + coturn stack
├── .env.docker.example        # Compose env template
├── node_modules/@axona/protocol # kernel pinned via package.json (tagged release)
├── .env.example
├── package.json
└── README.md
```

The kernel is pinned in `package.json` as `github:axona-net/axona-protocol#<tag>`. To move the bridge to a new kernel, run the release ritual:

```bash
scripts/repin-kernel.sh v4.107.2       # re-pin + lockfile + npm test gate + version bump + commit
```

It regenerates `package-lock.json` (the lock must track the pin), verifies the lockfile reproduces with `npm ci`, and **refuses to commit unless `npm test` (the embedded-peer smoke) passes** — then leaves push and deploy as deliberate manual steps. The bridge is one of about
twenty surfaces a kernel version moves through, and the order matters: bridges before
apps, or an app pinned above its bridge connects and never completes. The whole sequence,
with its gates, is [`RELEASE-PROCEDURE.md`](https://github.com/axona-net/axona-docs/blob/main/RELEASE-PROCEDURE.md).

## Deployment

- **Run your own** — [`deploy/INSTALL.md`](deploy/INSTALL.md): the operator manual covering the one-command installer (`deploy/install.sh`), the Docker Compose stack (`docker-compose.yml`), and a manual walkthrough. This is the place to start.
- **Production** (`bridge.axona.net` + `bridge-west.axona.net`): the Docker Compose stack in this repo (bridge, Caddy for TLS, coturn), each on its own dedicated-CPU host. Deployed by `ops/release.sh bridges <ver>` in the operators' workspace: east first, verified through its public name, then west. `docker compose up -d` recreates the container; a plain `restart` does not re-read `.env`. Both run `BRIDGE_NEVER_ROOT=0` (see [roots](#roots-and-bridge_never_root)). Federated; each advertises its TURN endpoint in the directory.
- **SF testnet** (`testnet.axona.net`): see `deploy/testnet-setup.md`. Runs an isolated fleet with `BRIDGE_DIRECTORY=off`.

## The establishment gate

A bridge does **not** advertise itself into the directory on launch. It waits for
`BRIDGE_DIRECTORY_MIN_UPTIME_MS` (5 min) **and** `BRIDGE_DIRECTORY_MIN_PEERS` (3),
then publishes; the hourly beat keeps the entry fresh. While it waits you will
see `directory:awaiting-establishment` in the log — that bridge is healthy and
serving traffic, it is simply not yet listed for others to bootstrap through.

A bridge shouldn't say "connect to me" before it can carry traffic, and the gate
also removes a real failure: at launch a bridge is TERMINAL for its own directory
topic, because nobody is closer, so under the default fence it would refuse to root the
very topic it is publishing. Before kernel 4.48.0 that
declined message re-routed to the only node available, itself, forever. It took
a production bridge down for ~50 minutes on 2026-07-27.

## Roots and BRIDGE_NEVER_ROOT

What should a bridge do when it is the node closest to a topic?

The DEFAULT answer is the bridge fence. With `BRIDGE_NEVER_ROOT` unset, `neverRoot` is
on and the kernel refuses every topic role at the HARD tier, which the admission floor
may not override (`src/bridge_engine.js:247`). It arrived with kernel 4.46.0, on the
principle that a bridge transports and introduces and does not hold data.

**Both production bridges run `BRIDGE_NEVER_ROOT=0`, and have since kernel 4.86.0.** The
fence stranded topics. The kernel refuses to route a topic toward a node's OWN bridge —
the one it dialled — and has no way to exclude anyone else's. A foreign bridge arrives
in peers' neighbour answers like any other node, wins on XOR distance, and then refuses
the root. On 2026-09-14, 42 of the 62 topics that failed an alert-bot run on 4.84.0 were
XOR-closest to the west bridge; 0 of the 122 that passed were. With the fence off a
bridge roots like any other node and the strand does not occur.

That is [axona-protocol#69](https://github.com/axona-net/axona-protocol/issues/69), and it
is still OPEN. The kernel-side fix — a node able to tell its neighbours it never holds a
role, so they stop choosing it — does not exist yet.

So the default is NOT what production runs, and the difference matters to anyone who
runs a public bridge. A bridge on the default joins the shared network as a foreign
bridge to every node that did not dial it, which is the #69 shape. Production's setting
for a federated bridge is `BRIDGE_NEVER_ROOT=0`. The fence is safe on a bridge that
never federates (`BRIDGE_DIRECTORY=off`).

The other guard still holds either way: `host()` was removed from the directory
publisher in July, so a bridge never hosts a topic it was not routed to.

See the [Services Guide](https://github.com/axona-net/axona-docs/blob/main/programmer-guide/Axona-Services-Guide-v4.48.0.md).

## License

MIT
