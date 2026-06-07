# axona-bridge

WebSocket signaling broker for the [Axona](https://github.com/axona-net) protocol. A new peer connects here first; the bridge tells it about every other connected peer, and announces the new arrival to everyone else. The peers then negotiate WebRTC DataChannels through the bridge, after which they talk directly without going through it. The bridge also responds to direct pings as itself, so it shows up in each peer's UI as one of the lights in the mesh.

**v2.14.0**, embedding kernel **v2.31.0** (`axona/5` wire epoch). It runs an embedded `AxonaPeer` from [`@axona/protocol`](https://github.com/axona-net/axona-protocol) and acts as a server-class **highway** node in the network — persistent identity, larger synaptome cap, a routable target for any browser peer's lookups, and a root for region-keyed pub/sub.

What the bridge does today:

- **Signaling.** `peer-list`, `peer-joined`, `peer-left`, and opaque `signal` relay so peers can negotiate WebRTC DataChannels. After the channel opens they talk directly; the bridge is no longer in the data path. It also relays **mesh signaling** so peers can form *bridgeless* links through each other.
- **Authenticated admission + version gate.** Every connection runs the kernel's `axona/5` authenticated handshake. A `client-hello` is checked against `REQUIRED_WIRE_MAJOR` (=2) and a `flagDayFloor()` (kernel-namespace floor `MIN_KERNEL_VERSION` for 2.x, peer-app floor `MIN_PEER_APP_VERSION` for ≥3.x); a peer below the floor or on the wrong wire epoch is closed with **4426** (`upgrade required`). The `axona/4` production network and the `axona/5` testnet are partitioned by design.
- **Embedded protocol participant.** Persistent nodeId, NH-1 routing primitives over WebSocket, pub/sub root. `/healthz` and `/diag` surface the bridge nodeId, synaptome size, and the embedded **kernel version**.
- **TURN credential minting.** Hands browsers short-lived TURN credentials (the `draft-uberti-rtcweb-turn-rest` scheme, validated by self-hosted **coturn** in `use-auth-secret` mode) so WebRTC works across restrictive NATs.

The Axona wire frames piggyback on the browser ↔ bridge WebSocket as `{type: 'axona', payload: <req/res/ntf frame>}`. No `node-webrtc` dependency.

Configure the bridge's geographic prefix via env vars:

```bash
BRIDGE_LAT=51.5  BRIDGE_LNG=-0.1  BRIDGE_REGION_LABEL="London"  npm start
```

Identity persists in `bridge-identity.json` (override path with `BRIDGE_IDENTITY_PATH`).

## Quickstart (local)

```bash
npm install
npm start
# → {"ts":"…","level":"info","event":"listen","port":8080,"logLevel":"info","version":"2.14.0"}
```

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
# {"status":"ok","connections":0,"uptimeS":12,"version":"2.14.0","kernelVersion":"2.31.0",…}
```

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

Env vars (see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on |
| `LOG_LEVEL` | `info` | `debug` logs every ping/pong and signal relay (verbose) |
| `REQUIRED_WIRE_MAJOR` | `2` | reject any `client-hello` not on this wire major (the `axona/5` epoch is major 2) |
| `MIN_KERNEL_VERSION` | `2.28.0` | floor for kernel-namespace (2.x) peers; below → close 4426 |
| `MIN_PEER_APP_VERSION` | `3.25.0` | floor for peer-app-namespace (≥3.x) peers |
| `HELLO_TIMEOUT_MS` | — | how long to wait for a peer's authenticated hello before dropping |
| `TURN_URLS` | — | comma-separated TURN URLs handed to browsers (e.g. `turn:turn.axona.net:3478`) |
| `TURN_AUTH_SECRET` | — | shared secret for minting `use-auth-secret` TURN credentials (also read by coturn) |
| `BRIDGE_LAT` / `BRIDGE_LNG` / `BRIDGE_REGION_LABEL` | — | the bridge's geographic anchor (sets its S2 region prefix) |
| `BRIDGE_IDENTITY_PATH` | `bridge-identity.json` | where the persistent Ed25519 identity is stored |

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
│   ├── axona-bridge.service   # systemd unit
│   ├── nginx-axona-bridge.conf  # production reverse proxy + TLS
│   ├── nginx-testnet-app.conf   # testnet.axona.net (peer app + same-origin bridge)
│   ├── nginx-testnet-demo.conf  # demo-testnet.axona.net (kernel demo at root)
│   ├── testnet-setup.md         # SF testnet droplet + coturn setup
│   └── README.md              # one-time droplet setup
├── node_modules/@axona/protocol # kernel pinned via package.json (#v2.31.0)
├── .env.example
├── package.json
└── README.md
```

The kernel is pinned in `package.json` as `github:axona-net/axona-protocol#v2.31.0`; bump that tag and regenerate `package-lock.json` (the lock must track the pin) when moving the bridge to a new kernel.

## Deployment

- **Production** (`bridge.axona.net`, `turn.axona.net`): see `deploy/README.md` for the DigitalOcean / Ubuntu procedure (systemd + nginx TLS + coturn). Still on the `axona/4` kernel-2.16 network until the flag-day cutover.
- **SF testnet** (`testnet.axona.net` peer + same-origin bridge; `demo-testnet.axona.net` demo): see `deploy/testnet-setup.md`. Runs this `axona/5` line with self-hosted coturn.

## License

MIT
