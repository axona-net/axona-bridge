// =====================================================================
// integ_turn_refresh.mjs — RUNTIME bridge↔client integration for the
// in-band TURN credential refresh (kernel 4.60.x, GH #44).
//
// Council (Aster, seq 363) held the deploy on a gap the static fence
// (fence_turn_refresh.mjs) could not close: that fence is source
// inspection plus a reimplementation of the credential math. It never
// executes the bridge handler, admits a client, sends `turn-refresh`,
// or observes an emitted `turn` frame — so it cannot establish the
// server's actual dispatch/auth/send path.
//
// This test closes it end to end. It spawns the REAL bridge process,
// opens a real WebSocket, completes admission with a client-hello,
// then:
//   1. proves the admitted-only gate: a `turn-refresh` sent BEFORE the
//      hello is dropped — no `turn` frame comes back;
//   2. proves mint-on-connect: the welcome frame already carries a
//      client-parseable REST credential;
//   3. proves the refresh path: after admission, a `turn-refresh`
//      yields a FRESH standalone `turn` frame (new token, not an echo),
//      with urls + credential the client will accept;
//   4. proves the socket is untouched: it stays OPEN and still
//      round-trips (ping → pong) after the refresh.
//
// It exercises the admission gate, the `turn-refresh` case,
// makeTurnCredential, and sendTo — the real paths, in a real process.
//
// Run: node test/integ_turn_refresh.mjs
// =====================================================================

import { spawn }        from 'node:child_process';
import net             from 'node:net';
import { WebSocket }   from 'ws';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) { console.log(`  ok ${++n} - ${m}`); }
  else   { console.log(`  ✗  ${++n} - ${m}${extra ? '  ' + extra : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A client-acceptable TURN credential (matches the kernel's strict parser
// turnExpiryMs): username leads with all-digits `<expiry>:`, plus a
// credential and at least one url.
const clientAccepts = (t) =>
  !!t && typeof t.username === 'string' && /^\d+:/.test(t.username) &&
  typeof t.credential === 'string' && t.credential.length > 0 &&
  ((Array.isArray(t.urls) && t.urls.length > 0) || typeof t.urls === 'string');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Retry a WS dial until the freshly-spawned server accepts it (or time out).
async function dialWhenReady(url, deadlineMs) {
  const start = Date.now();
  for (;;) {
    const sock = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const done = (val) => { ws.removeAllListeners(); resolve(val); };
      ws.once('open',  () => done(ws));
      ws.once('error', () => { try { ws.terminate(); } catch {} done(null); });
    });
    if (sock) return sock;
    if (Date.now() - start > deadlineMs) return null;
    await sleep(100);
  }
}

async function main() {
  console.log('bridge ↔ client — TURN credential refresh, runtime integration\n');

  const PORT   = await freePort();
  const SECRET = 'integ-turn-secret-not-prod';
  const URLS   = 'turn:turn.integ.test:3478,turns:turn.integ.test:5349';

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      TURN_AUTH_SECRET: SECRET, TURN_URLS: URLS,
      BRIDGE_DIRECTORY: 'off',        // independent seed — no uplink/directory
      LOG_LEVEL: 'error',             // keep the child quiet under the test
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let childExited = false;
  child.on('exit', () => { childExited = true; });

  const cleanup = () => { try { if (!childExited) child.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);

  try {
    const ws = await dialWhenReady(`ws://127.0.0.1:${PORT}`, 8000);
    ok('spawned bridge accepts a WebSocket connection', !!ws);
    if (!ws) throw new Error('server never accepted a socket');

    // Collect every frame; index the ones we assert on.
    const frames = [];
    let welcome = null;
    const turnFrames = [];            // standalone {type:'turn'} — refresh replies only
    let pong = null;
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      frames.push(m);
      if (m.type === 'welcome') welcome = m;
      if (m.type === 'turn')    turnFrames.push(m);
      if (m.type === 'pong')    pong = m;
    });

    // ── 1. admitted-only gate: turn-refresh BEFORE the hello is dropped ──
    ws.send(JSON.stringify({ type: 'turn-refresh' }));
    await sleep(400);
    ok('pre-admission turn-refresh is dropped (no turn frame, no welcome yet)',
      turnFrames.length === 0 && welcome === null);

    // ── admission: a valid client-hello (version/wire gate) ─────────────
    ws.send(JSON.stringify({
      type: 'client-hello', version: '4.60.1', wireVersion: '4.0', kernelVersion: '4.60.1',
    }));
    // wait for welcome
    for (let i = 0; i < 50 && !welcome; i++) await sleep(50);
    ok('client-hello admitted — welcome frame received', !!welcome);

    // ── 2. mint-on-connect: welcome carries a client-acceptable cred ────
    ok('welcome carries a client-acceptable TURN credential', clientAccepts(welcome && welcome.turn));
    const welcomeUser = welcome && welcome.turn && welcome.turn.username;

    // ── 3. refresh path: turn-refresh → a FRESH standalone turn frame ───
    ws.send(JSON.stringify({ type: 'turn-refresh' }));
    for (let i = 0; i < 50 && turnFrames.length === 0; i++) await sleep(50);
    ok('turn-refresh returns a standalone turn frame', turnFrames.length >= 1);
    const refreshed = turnFrames[0] && turnFrames[0].turn;
    ok('the refreshed credential is client-acceptable', clientAccepts(refreshed));
    ok('the refreshed credential is FRESH (new token, not an echo of welcome)',
      !!refreshed && refreshed.username !== welcomeUser);

    // ── 4. socket untouched: still OPEN and still round-trips ───────────
    ok('socket stayed OPEN across the refresh (never closed for a refresh)',
      ws.readyState === WebSocket.OPEN);
    const stamp = Date.now();
    ws.send(JSON.stringify({ type: 'ping', t: stamp }));
    for (let i = 0; i < 50 && !pong; i++) await sleep(50);
    ok('same socket still round-trips after the refresh (ping → pong)',
      !!pong && pong.t === stamp && ws.readyState === WebSocket.OPEN);

    try { ws.close(); } catch {}
  } finally {
    cleanup();
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} turn-refresh runtime integration: ${n} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('integration threw:', err); process.exit(2); });
