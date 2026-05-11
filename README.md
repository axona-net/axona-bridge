# axona-bridge

Phase 1 WebSocket bridge for the [Axona](https://github.com/axona-net) protocol. A new peer connects here first; once we add the Axona protocol the bridge will hand the peer off to the rest of the mesh. For now its only job is to prove the wire works: accept WebSocket connections, echo `ping` as `pong`, expose a JSON health endpoint.

The bridge does **not** yet speak the Axona protocol. It is the substrate Phase 2 builds on.

## Quickstart (local)

```bash
npm install
npm start
# → {"ts":"…","level":"info","event":"listen","port":8080,"logLevel":"info"}
```

Smoke-test it with the bundled client:

```bash
npm run smoke
# [open] connected to ws://localhost:8080
# [welcome] connId=c1
# [pong] 1/5  rtt=1ms
# [pong] 2/5  rtt=1ms
# …
# [summary] sent=5 received=5  avg=0.80ms  max=2ms
```

Or with `curl` against the health endpoint:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","connections":0,"uptimeS":12,"version":"0.1.0"}
```

## Wire format

Phase 1 has three message types. All JSON.

| Direction | Type | Payload |
|---|---|---|
| client → server | `ping` | `{ type, t: <client epoch ms> }` |
| server → client | `welcome` | `{ type, connId, serverT }` (sent once on connect) |
| server → client | `pong` | `{ type, t: <echoed unchanged>, serverT }` |

The client computes round-trip time as `Date.now() - msg.t` on each pong; the unchanged `t` echo means the server doesn't need any clock-skew assumptions.

## Configuration

Env vars (see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on |
| `LOG_LEVEL` | `info` | `debug` logs every ping/pong; verbose |

## Logging

The bridge writes one JSON line per event to stdout. Canonical events:

- `listen` — server up
- `connect` — new WS connection (includes `connId`, `ip`, `total`)
- `disconnect` — connection closed (includes `connId`, `code`, `lifeS`, `pings`, `pongs`, `remaining`)
- `ws-error`, `bad-json`, `pong-send-failed` — errors
- `pong` (debug only) — per-ping
- `shutdown-begin`, `shutdown-complete` — graceful exit

systemd captures stdout/stderr; tail with `journalctl -u axona-bridge -f`.

## Layout

```
axona-bridge/
├── src/server.js              # the bridge
├── scripts/smoke-client.js    # reference WS client / smoke test
├── deploy/
│   ├── axona-bridge.service   # systemd unit
│   ├── nginx-axona-bridge.conf # nginx reverse proxy + TLS
│   └── README.md              # one-time droplet setup
├── .env.example
├── package.json
└── README.md
```

## Deployment

See `deploy/README.md` for the Digital Ocean / Ubuntu 24.04 procedure.

## License

MIT
