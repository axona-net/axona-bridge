// =====================================================================
// Axona Bridge — Phase 2
//
// A WebSocket server that brokers introductions between axona-peer
// browser clients.  In Phase 1 the bridge only echoed pings back; in
// Phase 2 it adds the signaling-server role that lets peers discover
// each other and set up WebRTC DataChannels for direct peer-to-peer
// communication.  The bridge is still a participant (peers ping it
// directly, it pongs back), but the peer-to-peer ping/pong traffic
// flows over WebRTC, not through here.
//
// The bridge does not yet speak the Axona protocol.  Phase 3 will
// drop the protocol on top of the same transport seams.
//
// Configuration via env vars (see .env.example):
//   PORT       — TCP port to listen on (default 8080)
//   LOG_LEVEL  — 'info' | 'debug' (default 'info'; debug logs every msg)
//
// ── Wire format (Phase 2) ────────────────────────────────────────────
//
//   client → bridge:
//     { type: 'ping',   t: <client epoch ms> }
//     { type: 'signal', to: <peerId>, payload: <opaque-SDP-or-ICE> }
//
//   bridge → client (own connection):
//     { type: 'welcome',    connId, serverT }          (once on connect)
//     { type: 'peer-list',  peers:  [<peerId>, ...] }  (once on connect)
//     { type: 'pong',       t: <echoed>, serverT }     (per ping)
//     { type: 'signal',     from: <peerId>, payload }  (relayed from peer)
//
//   bridge → all other clients (broadcast):
//     { type: 'peer-joined', peerId, serverT }         (when someone joins)
//     { type: 'peer-left',   peerId, serverT }         (when someone leaves)
//
// The `signal` payload is opaque to the bridge — it's the bytes that
// the WebRTC negotiation needs to cross, and the bridge's only job is
// to put a `from` field on it and forward to `to`.
// =====================================================================

import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import http   from 'http';

const VERSION   = '0.4.0';
const PORT      = Number.parseInt(process.env.PORT ?? '8080', 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const startTs   = Date.now();

// ── TURN credential minting ─────────────────────────────────────────
//
// We mint short-lived (username, credential) pairs for each connecting
// peer using the scheme from draft-uberti-rtcweb-turn-rest, which is
// what coturn's `use-auth-secret` mode validates against:
//
//   username   = "<expiry-unix-seconds>:<peerId>"
//   credential = base64( HMAC-SHA1( secret, username ) )
//
// The secret is shared with coturn out-of-band (both read it from the
// same value — coturn from its conf file, the bridge from this env
// var).  Peers never see the secret; they get a derived credential
// that expires in TURN_TTL_SECONDS.  This is what keeps the bridge
// from baking long-term credentials into peer source.
const TURN_AUTH_SECRET = process.env.TURN_AUTH_SECRET ?? null;
const TURN_TTL_SECONDS = 60 * 60 * 2;   // 2h — longer than any realistic session
const TURN_URLS        = (process.env.TURN_URLS ?? 'turn:turn.axona.net:3478,turns:turn.axona.net:5349')
  .split(',').map(s => s.trim()).filter(Boolean);

function makeTurnCredential(peerId) {
  if (!TURN_AUTH_SECRET) return null;
  const expiry   = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${peerId}`;
  const credential = crypto
    .createHmac('sha1', TURN_AUTH_SECRET)
    .update(username)
    .digest('base64');
  return { urls: TURN_URLS, username, credential, ttlSeconds: TURN_TTL_SECONDS };
}

// Idle-timeout sweep.  Peers ping at 1Hz; anything that's gone more
// than IDLE_TIMEOUT_MS without sending us a single message is treated
// as dead and forcibly terminated.  This is what kills "ghost peers"
// — connections where the underlying TCP socket dropped without a
// WebSocket close frame, so the OS never told us the peer left.  Set
// generously enough (15s = 15 missed pings) that brief network
// hiccups don't false-positive.
const IDLE_TIMEOUT_MS         = 15_000;
const IDLE_CHECK_INTERVAL_MS  =  5_000;

let connSeq = 0;
/** @type {Map<string, {ws: any, ip: string, since: number, lastSeenAt: number, pings: number, pongs: number, signalsRelayed: number, ua: string}>} */
const connections = new Map();

// ── Structured JSON logging ──────────────────────────────────────────
function log(event, extra = {}) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event,
    ...extra,
  }) + '\n');
}
function logErr(event, extra = {}) {
  process.stderr.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    event,
    ...extra,
  }) + '\n');
}
function logDebug(event, extra = {}) {
  if (LOG_LEVEL !== 'debug') return;
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'debug',
    event,
    ...extra,
  }) + '\n');
}

// ── Send helpers ─────────────────────────────────────────────────────
function sendTo(peerId, msg) {
  const conn = connections.get(peerId);
  if (!conn) return false;
  try {
    conn.ws.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    logErr('send-failed', { connId: peerId, type: msg.type, err: err.message });
    return false;
  }
}

/** Broadcast to every peer except `exceptId` (typically the originator). */
function broadcast(msg, exceptId = null) {
  let count = 0;
  for (const [id, conn] of connections) {
    if (id === exceptId) continue;
    try {
      conn.ws.send(JSON.stringify(msg));
      count++;
    } catch (err) {
      logErr('broadcast-send-failed', { connId: id, type: msg.type, err: err.message });
    }
  }
  return count;
}

// ── HTTP server: /healthz + WebSocket upgrade host ───────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const body = JSON.stringify({
      status:      'ok',
      connections: connections.size,
      uptimeS:     Math.floor((Date.now() - startTs) / 1000),
      version:     VERSION,
    });
    res.writeHead(200, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control':  'no-store',
    });
    res.end(body);
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`axona-bridge ${VERSION}\n`);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

// ── WebSocket server ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const id = `c${(++connSeq).toString(36)}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          ?? req.socket.remoteAddress
          ?? 'unknown';
  const ua = req.headers['user-agent'] ?? '';
  const since = Date.now();

  // Snapshot the *existing* peer set BEFORE adding the new one — this
  // is what we'll send back as `peer-list`.  If we registered first,
  // the new peer would see itself in its own list.
  const existingPeers = [...connections.keys()];

  const conn = {
    ws, ip, since,
    lastSeenAt: since,
    pings: 0, pongs: 0, signalsRelayed: 0,
    ua,
  };
  connections.set(id, conn);

  log('connect', { connId: id, ip, total: connections.size, ua: ua.slice(0, 80) });

  // 1. Welcome the new peer with its assigned id and (if configured)
  //    a fresh HMAC-signed TURN credential.  The credential travels
  //    inside the welcome message so peer JS never has to ship a
  //    long-term secret; expiry is 2h, much longer than any plausible
  //    WebRTC session.
  const turn = makeTurnCredential(id);
  sendTo(id, {
    type:    'welcome',
    connId:  id,
    serverT: Date.now(),
    version: VERSION,
    turn,
  });

  // 2. Tell the new peer about everyone who was already here.
  //    The new peer is the *initiator* in WebRTC negotiation — it will
  //    send offers to each of these existing peers.
  sendTo(id, { type: 'peer-list', peers: existingPeers, serverT: Date.now() });

  // 3. Tell all existing peers that someone new arrived.  They will
  //    wait for the new peer to initiate.
  const announcedTo = broadcast(
    { type: 'peer-joined', peerId: id, serverT: Date.now() },
    id,
  );
  log('peer-announce', { connId: id, peers: existingPeers.length, announcedTo });

  ws.on('message', (data, isBinary) => {
    // Any inbound bytes — even a malformed payload — count as proof
    // the peer is still alive.  Stamping liveness before parse means
    // a peer that briefly sends junk doesn't get kicked for being
    // idle on top of that.
    conn.lastSeenAt = Date.now();

    if (isBinary) {
      logDebug('binary-dropped', { connId: id, bytes: data.length });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logErr('bad-json', { connId: id, err: err.message });
      return;
    }

    switch (msg.type) {
      case 'ping': {
        conn.pings++;
        try {
          ws.send(JSON.stringify({
            type:    'pong',
            t:       msg.t,                // echo client timestamp unchanged
            serverT: Date.now(),
          }));
          conn.pongs++;
          logDebug('pong', { connId: id, n: conn.pings });
        } catch (err) {
          logErr('pong-send-failed', { connId: id, err: err.message });
        }
        break;
      }

      case 'signal': {
        // Relay opaque SDP / ICE between peers.  The bridge does not
        // inspect `payload` — it only validates that `to` is connected
        // and rewrites the addressing so the recipient knows who sent it.
        const to = msg.to;
        if (typeof to !== 'string') {
          logErr('signal-missing-to', { connId: id });
          break;
        }
        if (!connections.has(to)) {
          // Recipient is gone — silently drop.  This is a normal race:
          // a peer-left event raced past the signaling message.  We
          // don't surface an error to the sender because the sender
          // will receive `peer-left` and clean up on its own.
          logDebug('signal-drop-unknown-to', { connId: id, to });
          break;
        }
        const delivered = sendTo(to, {
          type:    'signal',
          from:    id,
          payload: msg.payload,
        });
        if (delivered) {
          conn.signalsRelayed++;
          logDebug('signal-relay', { from: id, to, n: conn.signalsRelayed });
        }
        break;
      }

      default:
        logDebug('unknown-type', { connId: id, type: msg.type });
    }
  });

  ws.on('close', (code, reason) => {
    const lifeS = Math.floor((Date.now() - since) / 1000);
    connections.delete(id);

    // Tell everyone remaining that this peer is gone.  They'll tear
    // down their RTCPeerConnection for this id.
    const notifiedCount = broadcast(
      { type: 'peer-left', peerId: id, serverT: Date.now() },
      null,   // peer is already removed from the registry
    );

    log('disconnect', {
      connId:    id,
      code,
      reason:    reason?.toString() ?? '',
      lifeS,
      pings:     conn.pings,
      pongs:     conn.pongs,
      signals:   conn.signalsRelayed,
      notified:  notifiedCount,
      remaining: connections.size,
    });
  });

  ws.on('error', (err) => {
    logErr('ws-error', { connId: id, err: err.message });
  });
});

// ── Idle-timeout sweep ───────────────────────────────────────────────
//
// Scan every IDLE_CHECK_INTERVAL_MS for connections that haven't sent
// us anything in IDLE_TIMEOUT_MS.  Forcibly terminate them.  This is
// the cure for ghost peers: a peer whose underlying TCP socket gets
// silently dropped (radio off mid-flight, OS kills backgrounded tab,
// upstream router NATs out an idle binding) never sends a WebSocket
// close frame, so without this sweep the connection sits in our map
// forever and everyone else keeps trying to reach a corpse.
//
// terminate() rather than close() because close() blocks waiting for
// the dead peer's close-frame reply, which by definition will never
// arrive.  terminate() rips the socket and fires the 'close' event
// with code 1006 — our existing close handler then broadcasts the
// peer-left to the rest of the mesh.
function sweepIdleConnections() {
  const now = Date.now();
  const toKick = [];
  for (const [id, conn] of connections) {
    const idleMs = now - conn.lastSeenAt;
    if (idleMs > IDLE_TIMEOUT_MS) toKick.push({ id, conn, idleMs });
  }
  if (toKick.length === 0) return;
  // Terminate after the iteration so the close-handler's
  // connections.delete() doesn't mutate the map mid-walk.
  for (const { id, conn, idleMs } of toKick) {
    log('idle-kick', { connId: id, idleMs, lastPings: conn.pings });
    try { conn.ws.terminate(); }
    catch (err) { logErr('terminate-failed', { connId: id, err: err.message }); }
  }
}
const idleSweepTimer = setInterval(sweepIdleConnections, IDLE_CHECK_INTERVAL_MS);

// ── Boot ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log('listen', {
    port:                  PORT,
    logLevel:              LOG_LEVEL,
    version:               VERSION,
    idleTimeoutMs:         IDLE_TIMEOUT_MS,
    idleCheckIntervalMs:   IDLE_CHECK_INTERVAL_MS,
    turnMinting:           TURN_AUTH_SECRET ? 'enabled' : 'disabled (no TURN_AUTH_SECRET)',
    turnUrls:              TURN_AUTH_SECRET ? TURN_URLS : [],
    turnTtlSeconds:        TURN_AUTH_SECRET ? TURN_TTL_SECONDS : 0,
  });
});

// ── Graceful shutdown ────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown-begin', { signal, connections: connections.size });
  clearInterval(idleSweepTimer);

  for (const [id, { ws }] of connections) {
    try { ws.close(1001, 'server shutting down'); }
    catch (err) { logErr('close-failed', { connId: id, err: err.message }); }
  }

  httpServer.close(() => {
    log('shutdown-complete', {});
    process.exit(0);
  });

  // Force exit after 5s if hangouts won't release.
  setTimeout(() => {
    logErr('shutdown-forced', {});
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logErr('uncaught', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logErr('unhandled-rejection', { reason: String(reason) });
});
