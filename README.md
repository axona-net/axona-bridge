# axona-bridge

WebSocket signaling broker for the [Axona](https://github.com/axona) protocol. A new peer connects here first; the bridge tells it about every other connected peer, and announces the new arrival to everyone else. The peers then negotiate WebRTC DataChannels through the bridge, after which they talk directly without going through it. The bridge also responds to direct pings as itself, so it shows up in each peer's UI as one of the lights in the mesh.

The bridge does **not** yet speak the Axona protocol — that's Phase 3. The two earlier phases prove the wire works:

| Phase | Role of bridge |
|---|---|
| 1 | Single-peer connectivity test (`ping` → `pong` only) |
| **2** (current) | Adds signaling: `peer-list`, `peer-joined`, `peer-left`, opaque `signal` relay |
| 3 (future) | Drops in the Axona DHT protocol; bridge becomes the bootstrap peer |

## Quickstart (local)

```bash
npm install
npm start
# → {"ts":"…","level":"info","event":"listen","port":8080,"logLevel":"info","version":"0.2.0"}
```

Two smoke tests:

```bash
npm run smoke
#   single client × N pings; sanity test of Phase 1 ping/pong path.

npm run smoke:signal
#   two simulated clients exercising welcome / peer-list / peer-joined /
#   bidirectional signal relay / peer-left.
```

Quick health check:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","connections":0,"uptimeS":12,"version":"0.2.0"}
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
├── src/server.js              # the bridge
├── scripts/
│   ├── smoke-client.js        # Phase 1 ping/pong smoke test
│   └── signal-smoke.js        # Phase 2 signaling smoke test
├── deploy/
│   ├── axona-bridge.service   # systemd unit
│   ├── nginx-axona-bridge.conf # nginx reverse proxy + TLS
│   └── README.md              # one-time droplet setup
├── .env.example
├── package.json
└── README.md
```

## Deployment

See `deploy/README.md` for the Digital Ocean / Ubuntu 24.04 procedure. The deployment artifacts are unchanged from Phase 1 — the bridge process serves both phases from the same binary.

## License

MIT
