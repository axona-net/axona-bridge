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

import { readFileSync }    from 'node:fs';
import { BridgeAxonaNode } from './bridge_axona_node.js';
import { startDirectoryPublisher } from './bridge_directory.js';
import { idToHex }         from './identity.js';
import { KERNEL_VERSION, makeNonce } from '@axona/protocol';

// Derive from package.json so /healthz never drifts from the deployed build
// (the hardcoded literal lagged twice — showed 2.18.0 then 2.19.0 while
// package.json was already a version ahead).
const VERSION   = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT      = Number.parseInt(process.env.PORT ?? '8080', 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// Version gate.  Browsers running an older peer can't be trusted to
// participate in pub/sub (no mountPubsub handler → silently drops
// 'pubsub:deliver' AND fails to forward, creating a black hole in the
// gossip graph) or anything else we add to the wire protocol.  We
// reject sub-minimum peers with a custom close code at handshake time
// and the peer-side UI shows a "please reload" banner.
//
// Bump MIN_PEER_VERSION whenever a non-backwards-compatible wire
// change ships in the peer.  Override via the environment when you
// need to temporarily relax the gate (eg. emergency rollback).
// 0.13.0 is the first peer build that sends the client-hello frame.
// Lower values can never admit (they always hit the hello timeout) —
// keep this in sync with the version that introduced client-hello on
// the peer side.
// 0.14.0 is the first peer build that uses AxonaManager pubsub
// (replacing the flood-publish overlay).  Older peers send
// 'pubsub:deliver' notifications the new bridge doesn't handle, and
// don't send the K-closest 'pubsub:subscribe-k' / 'pubsub:publish-k'
// frames the new path expects — so they'd be silent in the new
// topology.  Block them at the gate instead.
// I5 / v1.0 cutover: gate is bumped to 1.0.0 — the new wire format
// (264-bit hex node IDs, kernel-driven AxonaPeer + AxonaManager,
// public-mode topics, signed envelopes via Ed25519) is incompatible
// with anything pre-1.0.  Old peers get UPGRADE_REQUIRED (close 4426).
// v1.1 cutover: completes the 264-bit migration so peer IDs really
// occupy the same 264-bit address space as topic IDs (axona-peer/-bridge
// previously truncated to 64 bits at the identity layer, making K-closest
// XOR distance meaningless against topics).  Wire format now carries
// 66-char hex nodeIds in every hello/hello-ack/peer-list/tunneled-direct
// envelope; 1.0.x peers send 16-char ids and get UPGRADE_REQUIRED.
const MIN_PEER_VERSION   = process.env.MIN_PEER_VERSION ?? '1.1.0';
const HELLO_TIMEOUT_MS   = Number.parseInt(process.env.HELLO_TIMEOUT_MS ?? '5000', 10);
const CLOSE_UPGRADE_REQUIRED = 4426;   // mirrors HTTP 426 "Upgrade Required"

// ── Flag-day floors for the v2.9.0 envelope format (findings C-2/E-4) ──────
// The signed-envelope format changed (per-publisher `seq` + freshness window +
// signature domain separation), so a pre-2.9.0 client and a ≥2.9.0 client can't
// verify each other's publishes — a hard flag-day.  Without a gate, an old
// (often browser-CACHED) tab is admitted and then fails *silently* at the
// envelope layer, which reads to the user as "my publish isn't delivered."
// Reject it here instead, with a clear UPGRADE_REQUIRED (close 4426) that the
// kernel surfaces to the user.
//
// Clients report `version` in TWO namespaces, so one threshold can't separate
// them (2.9.0 < 3.9.0):
//   - the kernel example/demo reports its KERNEL version → major 2.x
//   - the axona.net peer app reports its APP   version   → major 3.x
// Gate each namespace at the first build that vendors kernel ≥ 2.9.0:
//   demo kernel 2.9.0  ·  peer app 3.14.0.  Both env-overridable.
// 2026-06 NETWORK PARTITION flag-day. The kernel bumped AUTH_PROTO axona/4→5 and
// WIRE_VERSION 1.0→2.0, so a pre-bump (kernel ≤2.16) node can NEVER form an
// authenticated channel with a post-bump node — the partition is hermetic at the
// auth layer. These floors make the refusal happen cleanly at admission with a
// clear UPGRADE_REQUIRED instead of a silent post-admit auth failure: gate each
// namespace at the first build that vendors kernel ≥ 2.28.0: demo kernel 2.28.0,
// and peer app 3.25.0 (the post-partition release — one bump above the deployed
// 3.24.0, so every pre-partition app is below the floor). Both env-overridable
// for staged rollout / rollback.
const MIN_KERNEL_VERSION   = process.env.MIN_KERNEL_VERSION   ?? '2.28.0';
const MIN_PEER_APP_VERSION = process.env.MIN_PEER_APP_VERSION ?? '3.25.0';

// Wire-format major the new network speaks (kernel WIRE_VERSION '2.0'). The
// client-hello now carries `wireVersion`; the gate rejects any peer whose major
// differs — OR (pre-flag-day peers) that omits it entirely — so only new-network
// peers are admitted. Bridge-local (NOT the vendored kernel's WIRE_VERSION) so
// it stays correct even before the bridge re-vendors. Env-overridable.
const REQUIRED_WIRE_MAJOR  = process.env.REQUIRED_WIRE_MAJOR  ?? '2';

/** Three-component numeric semver compare; returns true iff a >= b. */
function gteVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0, bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

/** Select the flag-day floor for a reported client `version`, by its
 *  major-version namespace (kernel-2.x vs peer-app-3.x).  Returns
 *  `{ floor, ns }`.  Major ≥ 3 → peer-app namespace; otherwise kernel. */
function flagDayFloor(version) {
  const major = parseInt(String(version).split('.')[0], 10) || 0;
  return major >= 3
    ? { floor: MIN_PEER_APP_VERSION, ns: 'peer-app' }
    : { floor: MIN_KERNEL_VERSION,   ns: 'kernel' };
}
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
//
// BigInt-aware JSON: the Axona wire protocol uses BigInt node IDs
// throughout (path[], queried set, fromId, etc.).  Native
// JSON.stringify throws on BigInts; we use a replacer that emits
// "<digits>n" suffixed strings, mirrored by an inverse reviver on
// the receive side.  This is a transitional convention while the
// canonical hex-encoding from the wire spec is rolled out across
// every field.
function bigintReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString() + 'n';
  if (value instanceof Set)      return [...value];
  return value;
}

function bigintReviver(_key, value) {
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

function sendTo(peerId, msg) {
  const conn = connections.get(peerId);
  if (!conn) return false;
  try {
    conn.ws.send(JSON.stringify(msg, bigintReplacer));
    return true;
  } catch (err) {
    logErr('send-failed', { connId: peerId, type: msg.type, err: err.message });
    return false;
  }
}

/** Broadcast to every peer except `exceptId` (typically the originator).
 *  Skips connections that haven't completed the client-hello version
 *  check — they should never appear in peer-list or get peer-joined
 *  notifications. */
function broadcast(msg, exceptId = null) {
  let count = 0;
  for (const [id, conn] of connections) {
    if (id === exceptId)  continue;
    if (!conn.admitted)   continue;
    try {
      conn.ws.send(JSON.stringify(msg, bigintReplacer));
      count++;
    } catch (err) {
      logErr('broadcast-send-failed', { connId: id, type: msg.type, err: err.message });
    }
  }
  return count;
}

// ── Embedded Axona peer (Phase 3) ────────────────────────────────────
//
// The bridge runs its own AxonaPeer as a server-class highway node.
// Its WebSocket transport piggybacks on the existing browser-bridge
// WebSocket connections; no node-webrtc dependency.  See
// `bridge_axona_node.js` and `ws_transport.js` for the wire shape.
const bridgeNode = new BridgeAxonaNode({
  sendToConn: (connId, msg) => sendTo(connId, msg),
  isConnOpen: (connId) => connections.has(connId),
  // axona/4 — close a connection with the Upgrade-Required code when its
  // peer can't complete the authenticated handshake (e.g. it speaks the
  // legacy axona/3 hello).  This is the clean, proto-level upgrade
  // signal: the peer's kernel prints "[axona] UPGRADE REQUIRED …" on a
  // 4426 close.  (The WS-level version gate can't separate v3 from v4
  // because the peer app version is already numerically above any kernel
  // threshold; the proto at the hello layer is the real boundary.)
  closeConn: (connId, reason) => {
    const conn = connections.get(connId);
    if (conn?.ws) { try { conn.ws.close(CLOSE_UPGRADE_REQUIRED, reason); } catch { /* dying */ } }
  },
  log: (event, detail) => logDebug(`axona:${event}`, detail),
});
await bridgeNode.start();
log('axona-ready', {
  nodeId: idToHex(bridgeNode.nodeId),
  region: bridgeNode.identity.region.label,
});

// ── Bridge directory (Phase: bridge discovery + failover) ────────────
// Advertise this bridge's location on the public directory topic so
// clients can discover it and fail over to it. The testnet bridge opts
// out via BRIDGE_DIRECTORY=off (independent fleet).
const directory = startDirectoryPublisher({
  peer:     bridgeNode.peer,
  identity: bridgeNode.identity,
  version:  VERSION,
  log:      (event, detail) => log(`directory:${event}`, detail),
});

// ── HTTP server: /healthz + WebSocket upgrade host ───────────────────
const httpServer = http.createServer((req, res) => {
  // CORS — /healthz and /diag are read-only diagnostic endpoints that
  // peers fetch from their browser console (axona.net origin) to
  // introspect bridge state.  Permissive Access-Control-Allow-Origin
  // is safe here because the data is non-sensitive (no credentials,
  // no per-user info) and any peer that connects to the bridge could
  // already infer it from its own state.  GET only; we also handle the
  // pre-flight OPTIONS so browsers don't reject the simple request.
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.url === '/healthz') {
    // Count admitted vs pending so operators can see how many
    // connections passed the version gate.
    let admittedCount = 0, pendingCount = 0;
    for (const c of connections.values()) {
      if (c.admitted) admittedCount++; else pendingCount++;
    }
    const body = JSON.stringify({
      status:         'ok',
      connections:    connections.size,
      admitted:       admittedCount,
      pending:        pendingCount,
      minPeerVersion:    MIN_PEER_VERSION,
      minKernelVersion:  MIN_KERNEL_VERSION,
      minPeerAppVersion: MIN_PEER_APP_VERSION,
      uptimeS:        Math.floor((Date.now() - startTs) / 1000),
      version:        VERSION,
      kernelVersion:  KERNEL_VERSION,
      axona: {
        nodeId:         idToHex(bridgeNode.nodeId),
        region:         bridgeNode.identity.region.label,
        synaptomeSize:  bridgeNode.getSynaptome().length,
      },
      directory: {
        enabled: directory.enabled,
        url:     directory.url,
      },
    });
    res.writeHead(200, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control':  'no-store',
      ...cors,
    });
    res.end(body);
    return;
  }
  // ── /diag — per-connection diagnostic snapshot ─────────────────────
  // Returns enough state to chase "why doesn't peer X receive my publishes":
  //   - is their conn admitted (client-hello passed)?
  //   - is their nodeId bound to a connId in WSTransport?
  //   - is that nodeId actually in the bridge's NH-1 synaptome?
  //     (if NOT, the bridge's pubsub fan-out skips them — root cause)
  //   - how long since we heard from them
  if (req.url === '/diag') {
    const synaptome    = bridgeNode.getSynaptome();
    const synaptomeIds = new Set(synaptome.map(s => s.peerId));   // BigInts
    const now = Date.now();

    const conns = [];
    for (const [connId, conn] of connections) {
      const boundNodeId = bridgeNode.transport?.nodeIdFor?.(connId) ?? null;
      conns.push({
        connId,
        admitted:     conn.admitted,
        peerVersion:  conn.peerVersion,
        ageS:         Math.floor((now - conn.since)      / 1000),
        lastSeenAgoS: Math.floor((now - conn.lastSeenAt) / 1000),
        nodeId:       boundNodeId ? idToHex(boundNodeId) : null,
        inSynaptome:  boundNodeId ? synaptomeIds.has(boundNodeId) : false,
        ip:           conn.ip,
        ua:           (conn.ua ?? '').slice(0, 80),
      });
    }

    // Axon roles the bridge currently holds.  Each entry shows the
    // topicId, whether the bridge created this role (root vs sub),
    // how many children (subscribers) are registered, and the
    // current cache size (how many messages are sitting in
    // replayCache waiting for late-arriving subscribers).  This is
    // the critical observability surface for debugging
    // publish-before-subscribe replay failures.
    const axonRoles = [];
    // The AxonaManager lives at peer._axonaManager (the kernel's lazily-
    // built pub/sub engine), NOT bridgeNode._axon — that legacy field
    // was never set, so this readout silently reported zero roles
    // regardless of actual state.  Reach through the AxonaPeer.
    const axon = bridgeNode._peer?._axonaManager ?? bridgeNode._axon;
    if (axon?.axonRoles) {
      for (const [topicId, role] of axon.axonRoles) {
        axonRoles.push({
          topic:        idToHex(topicId),
          isRoot:       !!role.isRoot,
          children:     [...(role.children?.keys?.() ?? [])].map(idToHex),
          cacheSize:    role.replayCache?.length ?? 0,
          createdAgoS:  role.roleCreatedAt
            ? Math.floor((now - role.roleCreatedAt) / 1000) : null,
          emptiedAgoS:  role.emptiedAt
            ? Math.floor((now - role.emptiedAt) / 1000) : null,
        });
      }
    }

    const body = JSON.stringify({
      version:        VERSION,
      kernelVersion:  KERNEL_VERSION,
      minPeerVersion:    MIN_PEER_VERSION,
      minKernelVersion:  MIN_KERNEL_VERSION,
      minPeerAppVersion: MIN_PEER_APP_VERSION,
      bridge: {
        nodeId:        idToHex(bridgeNode.nodeId),
        region:        bridgeNode.identity.region.label,
        synaptomeSize: synaptome.length,
      },
      // The connections list shows BOTH admitted & pending so we can
      // see peers stuck in the client-hello race or post-admit but
      // pre-handshake.
      counts: {
        connections: connections.size,
        admitted:    conns.filter(c => c.admitted).length,
        pending:     conns.filter(c => !c.admitted).length,
        inSynaptome: conns.filter(c => c.inSynaptome).length,
        // boundButNotInSynaptome is the "I told you so" bucket — the
        // bridge can't pubsub-forward to these.
        boundButNotInSynaptome:
          conns.filter(c => c.nodeId && !c.inSynaptome).length,
        axonRoles:   axonRoles.length,
      },
      axonRoles,
      connections: conns,
    }, null, 2);

    res.writeHead(200, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control':  'no-store',
      ...cors,
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
    admitted: false,      // flipped to true after client-hello version check
    helloTimer: null,
    peerVersion: null,
  };
  connections.set(id, conn);

  log('connect', { connId: id, ip, total: connections.size, ua: ua.slice(0, 80) });

  // 1. Tell the peer the version gate exists *before* we close.  This
  //    isn't a `welcome` — peer-list / peer-joined / hello are
  //    deferred until client-hello passes.  The peer side sends
  //    'client-hello' immediately after open; if nothing arrives
  //    within HELLO_TIMEOUT_MS, we close with the upgrade-required
  //    code so old clients trying to ride through get an obvious
  //    failure mode instead of a silent ghost connection.
  sendTo(id, {
    type:           'version-gate',
    minPeerVersion: MIN_PEER_VERSION,
    serverT:        Date.now(),
  });

  conn.helloTimer = setTimeout(() => {
    if (conn.admitted) return;
    logErr('client-hello-timeout', { connId: id, ms: HELLO_TIMEOUT_MS });
    try {
      ws.close(CLOSE_UPGRADE_REQUIRED,
        `client-hello not received within ${HELLO_TIMEOUT_MS}ms; ` +
        `min peer v${MIN_PEER_VERSION} required`);
    } catch {}
  }, HELLO_TIMEOUT_MS);

  function admitConnection() {
    clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.admitted = true;

    // 1a. Mint a short-lived TURN credential (2h expiry) bundled
    //     into welcome so peer JS never sees a long-term secret.
    const turn = makeTurnCredential(id);
    // axona/4 — mint a fresh per-connection nonce; it (with the connId)
    // is the channel-binding value the peer folds into its signed hello,
    // and we fold into ours.  A hello captured on one connection can't
    // be replayed onto another.
    const serverNonce = makeNonce();
    conn.serverNonce = serverNonce;
    sendTo(id, {
      type:          'welcome',
      connId:        id,
      serverT:       Date.now(),
      version:       VERSION,
      kernelVersion: KERNEL_VERSION,
      serverNonce,
      turn,
    });

    // 2. Tell the new peer about everyone ALREADY admitted.
    const admittedPeers = [];
    for (const [otherId, otherConn] of connections) {
      if (otherId === id) continue;
      if (!otherConn.admitted) continue;
      admittedPeers.push(otherId);
    }
    sendTo(id, { type: 'peer-list', peers: admittedPeers, serverT: Date.now() });

    // 3. Tell existing admitted peers that someone new arrived.
    const announcedTo = broadcast(
      { type: 'peer-joined', peerId: id, serverT: Date.now() },
      id,
    );
    log('peer-announce', { connId: id, peers: admittedPeers.length, announcedTo });

    // 4. Axona bootstrap-offer.  The peer's BridgeTransport replies
    //    with an authenticated hello-ack proving its nodeId; that's
    //    when our bridge node admits this browser into its synaptome.
    bridgeNode.sendHello(id, serverNonce);
  }

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
      msg = JSON.parse(data.toString(), bigintReviver);
    } catch (err) {
      logErr('bad-json', { connId: id, err: err.message });
      return;
    }

    // Version gate.  Before client-hello passes, the ONLY message we
    // accept is client-hello itself.  Everything else (ping, signal,
    // axona, etc.) is silently dropped so we don't leak state — and
    // never relay axona-protocol frames from un-validated peers.
    if (!conn.admitted) {
      if (msg.type !== 'client-hello') {
        logDebug('pre-hello-message-dropped', { connId: id, type: msg.type });
        return;
      }
      const peerVersion = typeof msg.version === 'string' ? msg.version : null;
      conn.peerVersion = peerVersion;
      if (!peerVersion) {
        logErr('client-hello-missing-version', { connId: id });
        try {
          ws.close(CLOSE_UPGRADE_REQUIRED,
            `client-hello must include 'version' (min v${MIN_PEER_VERSION})`);
        } catch {}
        return;
      }
      // Wire-format major gate (2026-06 partition). The new network speaks
      // wire major REQUIRED_WIRE_MAJOR; a peer that sends a different major — or
      // (a pre-flag-day peer) omits wireVersion entirely — belongs to the old
      // network and is refused here, before any frame is relayed. This is the
      // clean early half of the partition; the auth-proto bump is the hermetic
      // backstop even if a peer reaches the channel layer.
      const peerWireMajor = (typeof msg.wireVersion === 'string')
        ? msg.wireVersion.split('.')[0] : null;
      if (peerWireMajor !== REQUIRED_WIRE_MAJOR) {
        logErr('client-hello-wire-mismatch', {
          connId: id, peerVersion, peerWire: msg.wireVersion ?? null, requiredMajor: REQUIRED_WIRE_MAJOR,
        });
        try {
          ws.close(CLOSE_UPGRADE_REQUIRED,
            `wire ${msg.wireVersion ?? 'legacy'} incompatible (need major ${REQUIRED_WIRE_MAJOR}); ` +
            `reload axona.net / the demo to upgrade`);
        } catch {}
        return;
      }
      // Two-stage gate: the absolute floor (MIN_PEER_VERSION) AND the
      // namespace-aware flag-day floor for the v2.9.0 envelope (C-2/E-4).
      // Report whichever bound actually binds (the higher of the two), so
      // the close reason names the version the client must reach.
      const { floor, ns } = flagDayFloor(peerVersion);
      const effectiveMin = gteVersion(floor, MIN_PEER_VERSION) ? floor : MIN_PEER_VERSION;
      if (!gteVersion(peerVersion, MIN_PEER_VERSION) || !gteVersion(peerVersion, floor)) {
        logErr('client-hello-too-old', {
          connId: id, peerVersion, ns, floor, minPeerVersion: MIN_PEER_VERSION, effectiveMin,
        });
        try {
          ws.close(CLOSE_UPGRADE_REQUIRED,
            `peer v${peerVersion} below minimum v${effectiveMin} (${ns}); ` +
            `reload axona.net / the demo to upgrade`);
        } catch {}
        return;
      }
      log('client-hello-admitted', {
        connId: id, peerVersion, ns, floor, minPeerVersion: MIN_PEER_VERSION,
      });
      admitConnection();
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

      case 'axona': {
        // Axona wire frame from the peer.  The transport unpacks
        // req/res/ntf, dispatches to handlers, and writes the
        // response back through the same connection.
        if (msg.payload && typeof msg.payload === 'object') {
          bridgeNode.handleAxonaFrame(id, msg.payload);
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
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    connections.delete(id);

    // Let the embedded Axona node clean up its bindings + reject any
    // pending requests to this peer.
    bridgeNode.handleConnClosed(id);

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
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown-begin', { signal, connections: connections.size });
  clearInterval(idleSweepTimer);
  directory.stop();

  // Graceful departure (kernel ≥2.13.0).  The bridge is super-central —
  // in every peer's synaptome and XOR-close to every us-east/* topic, so
  // it's a root axon for most topics.  A hard `systemctl restart` drops
  // all sockets at once and wipes those in-memory roots; peers only
  // re-anchor on their next refreshTick (≤10 s), which is when pub/sub
  // visibly stalls mesh-wide.  Announcing `peer-leaving` over the
  // still-open sockets first lets every peer evict the bridge and
  // re-anchor their subscriptions/roles immediately — a proactive
  // sub-second handoff instead of a reactive stall.  Bounded so a slow
  // or dead peer can't wedge the shutdown.
  try {
    const peer = bridgeNode?.peer;
    if (peer && typeof peer.leave === 'function') {
      await Promise.race([
        peer.leave({ drain: true, notify: true, timeoutMs: 1000 }),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
      log('shutdown-peer-left', {});
    }
  } catch (err) {
    logErr('shutdown-peer-leave-failed', { err: err.message });
  }

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
