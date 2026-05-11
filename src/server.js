// =====================================================================
// Axona Bridge — Phase 1
//
// A WebSocket server that accepts connections from axona-peer browser
// clients, echoes their ping messages as pongs, and exposes a small
// JSON health endpoint over HTTP.
//
// The bridge does not yet speak the Axona protocol; this layer exists
// only to prove the wire works (browser ↔ Node over wss://) before
// any DHT-level concerns land.
//
// Configuration via env vars (see .env.example):
//   PORT       — TCP port to listen on (default 8080)
//   LOG_LEVEL  — 'info' | 'debug' (default 'info'; debug logs every msg)
//
// Wire format (Phase 1):
//   client → server : { type: 'ping', t: <client epoch ms> }
//   server → client : { type: 'welcome', connId, serverT }   (on connect)
//                     { type: 'pong', t: <echoed>, serverT } (per ping)
// =====================================================================

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT      = Number.parseInt(process.env.PORT ?? '8080', 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const startTs   = Date.now();

let connSeq = 0;
/** @type {Map<string, {ws: WebSocket, ip: string, since: number, pings: number, pongs: number, ua: string}>} */
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

// ── HTTP server: /healthz + WebSocket upgrade host ───────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const body = JSON.stringify({
      status:      'ok',
      connections: connections.size,
      uptimeS:     Math.floor((Date.now() - startTs) / 1000),
      version:     '0.1.0',
    });
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('axona-bridge\n');
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

  const conn = { ws, ip, since, pings: 0, pongs: 0, ua };
  connections.set(id, conn);

  log('connect', { connId: id, ip, total: connections.size, ua: ua.slice(0, 80) });

  // Welcome the client with its assigned id and server time.
  try {
    ws.send(JSON.stringify({
      type:    'welcome',
      connId:  id,
      serverT: Date.now(),
    }));
  } catch (err) {
    logErr('welcome-send-failed', { connId: id, err: err.message });
  }

  ws.on('message', (data, isBinary) => {
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
      default:
        logDebug('unknown-type', { connId: id, type: msg.type });
    }
  });

  ws.on('close', (code, reason) => {
    const lifeS = Math.floor((Date.now() - since) / 1000);
    connections.delete(id);
    log('disconnect', {
      connId:    id,
      code,
      reason:    reason?.toString() ?? '',
      lifeS,
      pings:     conn.pings,
      pongs:     conn.pongs,
      remaining: connections.size,
    });
  });

  ws.on('error', (err) => {
    logErr('ws-error', { connId: id, err: err.message });
  });
});

// ── Boot ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log('listen', { port: PORT, logLevel: LOG_LEVEL });
});

// ── Graceful shutdown ────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown-begin', { signal, connections: connections.size });

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
