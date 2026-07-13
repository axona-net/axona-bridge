// =====================================================================
// smoke-loop-stall.js — event-loop-stall protections (bridge v2.67.0).
//
// Kernel invariant I-5: a client is never judged by time the server
// wasn't listening. Prod finding (2026-07-08): a stalled event loop left
// client-hellos and pings unread in socket buffers, then every timer
// fired at once on resumption → hello-timeout closes and idle-kicks
// against provably-live clients. This smoke reproduces the stall on
// demand (BRIDGE_TEST_STALL=on exposes /__test/stall, a synchronous
// busy-wait inside the bridge's own loop) and asserts the grace paths:
//
//   1. client-hello grace: a hello that sat buffered under a stall that
//      outlived HELLO_TIMEOUT_MS is still admitted (one re-armed round),
//      never closed with client-hello-timeout.
//   2. idle-sweep skip: a client whose idle window overlapped the stall
//      is NOT idle-kicked; the sweep logs idle-sweep-skipped instead.
//   3. grace is a delay, not a mask: a genuinely-silent client IS kicked
//      once the stall taint ages out of the idle window.
//   4. /healthz reports the stall counters (loop.stalls / maxStallMs /
//      lastStallMs / lastStallAgoS) to the operator token, and does not
//      leak them unauthenticated (G-8).
//
// Time is compressed via the env knobs (HELLO_TIMEOUT_MS=2000,
// IDLE_TIMEOUT_MS=3000, IDLE_CHECK_INTERVAL_MS=1000); STALL_MIN_MS stays
// at its production value — the detector itself is what's under test.
// Each stall is 3500ms so the measured heartbeat lag is ≥ 2500ms no
// matter where the sampler tick fell before the freeze.
//
// Runs under Node:  `node scripts/smoke-loop-stall.js`
// =====================================================================

import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { WebSocket } from 'ws';
import { WIRE_VERSION, KERNEL_VERSION } from '@axona/protocol';

const BRIDGE_PORT   = 19083;   // distinct from smoke-axona's 19082
const BRIDGE_WS     = `ws://localhost:${BRIDGE_PORT}`;
const BRIDGE_HTTP   = `http://localhost:${BRIDGE_PORT}`;
const HEALTHZ_TOKEN = 'smoke-healthz-token';

// Compressed judgment windows (env-overridable on the bridge for exactly
// this purpose); the stall detector's constants are NOT touched.
const HELLO_TIMEOUT_MS      = 2_000;
const IDLE_TIMEOUT_MS       = 3_000;
const IDLE_CHECK_INTERVAL_MS = 1_000;
const STALL_MS              = 3_500;   // ≥ STALL_MIN_MS + STALL_SAMPLE_MS + margin

// Posing as the vendored kernel version always clears the admission floors
// (same reasoning as smoke-axona.js).
const PEER_VERSION_FOR_SMOKE = KERNEL_VERSION;
const PEER_WIRE_FOR_SMOKE    = WIRE_VERSION;

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Bridge child + structured-log capture ───────────────────────────
// Both streams are parsed as JSON-lines into one event list so the smoke
// can assert on the bridge's own telemetry (loop-stall, client-hello-grace,
// idle-sweep-skipped, idle-kick).
let bridgeChild = null;
const events = [];
const hasEvent = (name, pred = () => true) =>
  events.some(e => e.event === name && pred(e));

async function reapBridge() {
  const child = bridgeChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch {}
  const grace = new Promise((r) => setTimeout(r, 1500));
  await Promise.race([exited, grace]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await exited;
  }
}

function startBridge() {
  const identityPath = `/tmp/axona-bridge-stall-smoke-${process.pid}.json`;
  try { unlinkSync(identityPath); } catch {}

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      BRIDGE_IDENTITY_PATH: identityPath,
      LOG_LEVEL: 'info',
      MIN_PEER_VERSION: PEER_VERSION_FOR_SMOKE,
      HEALTHZ_TOKEN,
      // The whole point of this smoke:
      BRIDGE_TEST_STALL:      'on',
      HELLO_TIMEOUT_MS:       String(HELLO_TIMEOUT_MS),
      IDLE_TIMEOUT_MS:        String(IDLE_TIMEOUT_MS),
      IDLE_CHECK_INTERVAL_MS: String(IDLE_CHECK_INTERVAL_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let started = false;
  const attach = (stream, tag) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString();
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
        if (line.includes('"event":"listen"')) started = true;
        if (process.env.VERBOSE) console.log(`[bridge:${tag}] ${line}`);
      }
    });
  };
  attach(child.stdout, 'out');
  attach(child.stderr, 'err');
  return { child, identityPath, ready: () => started };
}

async function waitForReady(ready, timeoutMs = 5000) {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > timeoutMs) throw new Error('bridge did not start in time');
    await sleep(50);
  }
}

// ── WS client helpers (inbox pattern, as in smoke-axona.js) ─────────
function openSocket({ helloOnOpen }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS);
    const buffered = [];
    const waiters  = [];
    ws._inbox = { buffered, waiters };
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { return; }
      const idx = waiters.findIndex(w => w.predicate(msg));
      if (idx >= 0) {
        const w = waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        buffered.push(msg);
      }
    });
    ws.on('open', () => {
      if (helloOnOpen) {
        try { sendHello(ws); } catch (err) { reject(err); return; }
      }
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function sendHello(ws) {
  ws.send(JSON.stringify({
    type: 'client-hello',
    version: PEER_VERSION_FOR_SMOKE,
    wireVersion: PEER_WIRE_FOR_SMOKE,
  }));
}

function nextMessage(ws, predicate, timeoutMs = 2000) {
  const { buffered, waiters } = ws._inbox;
  const idx = buffered.findIndex(m => predicate(m));
  if (idx >= 0) return Promise.resolve(buffered.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiters.findIndex(w => w.resolve === resolve);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    waiters.push({ predicate, resolve, reject, timer });
  });
}

// Ask the bridge to freeze its own event loop for `ms` (test hook).
// Resolves only after the loop resumes and the handler responds.
const triggerStall = (ms) => fetch(`${BRIDGE_HTTP}/__test/stall?ms=${ms}`);

async function main() {
  console.log('axona-bridge loop-stall protection smoke (invariant I-5)');

  const { child, identityPath, ready } = startBridge();
  bridgeChild = child;
  try {
    await waitForReady(ready);
  } catch (err) {
    console.error('FAIL: bridge did not start —', err.message);
    await reapBridge();
    process.exit(2);
  }

  // ── 1. client-hello grace ─────────────────────────────────────────
  // Connect but DON'T send the hello yet; freeze the loop past the hello
  // deadline; send the hello INTO the frozen socket (it buffers server-side,
  // the prod condition). On resumption the expired hello timer must re-arm
  // (grace) instead of closing, and the drained hello must admit us.
  console.log('\n[1] hello buffered under a stall that outlives HELLO_TIMEOUT_MS');
  const wsA = await openSocket({ helloOnOpen: false });
  await nextMessage(wsA, m => m.type === 'version-gate');
  const stallA = triggerStall(STALL_MS);   // resolves when the loop resumes
  await sleep(400);                        // stall is underway; hello timer due mid-freeze
  sendHello(wsA);                          // sits unread in the socket buffer
  let welcomeA = null;
  try { welcomeA = await nextMessage(wsA, m => m.type === 'welcome', STALL_MS + 3000); }
  catch {}
  await stallA;
  await sleep(300);                        // let the bridge's log lines flush
  check('welcome arrived — buffered hello admitted after the stall', welcomeA != null);
  check('bridge detected the stall (loop-stall logged)',             hasEvent('loop-stall'));
  check('hello timer re-armed instead of closing (client-hello-grace)', hasEvent('client-hello-grace'));
  check('no client-hello-timeout was issued',                        !hasEvent('client-hello-timeout'));
  check('connection still open',                                     wsA.readyState === WebSocket.OPEN);

  // ── 2 + 3. idle-sweep skip under stall taint ──────────────────────
  // wsA pings on schedule throughout (its pings buffer during the freeze —
  // the prod capture showed kicked clients with lastPings 40-57). A second,
  // genuinely-silent control client proves the sweep still works: grace
  // delays judgment until the taint ages out, it doesn't disable the sweep.
  console.log('\n[2] idle window overlapping a stall — live client kept, silent client kicked later');
  const pingTimer = setInterval(() => {
    try { wsA.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
  }, 500);
  const wsControl = await openSocket({ helloOnOpen: true });
  const welcomeC  = await nextMessage(wsControl, m => m.type === 'welcome');
  const controlClosed = new Promise((r) => wsControl.on('close', (code) => r(code)));
  await sleep(800);            // let the control age inside (but not past) the idle window
  await triggerStall(STALL_MS);
  await sleep(300);
  check('idle sweep skipped while the window is stall-tainted (idle-sweep-skipped)',
    hasEvent('idle-sweep-skipped'));
  check('live client (buffered pings) not idle-kicked at resumption',
    !hasEvent('idle-kick', e => e.connId === welcomeA?.connId));
  check('live client connection survived the stall', wsA.readyState === WebSocket.OPEN);

  // Taint ages out ≤ IDLE_TIMEOUT_MS after the stall ends; the silent
  // control must then be kicked within a sweep interval or two.
  const kicked = await Promise.race([
    controlClosed,
    sleep(IDLE_TIMEOUT_MS + 4 * IDLE_CHECK_INTERVAL_MS + 2000).then(() => 'timeout'),
  ]);
  check('genuinely-idle control client kicked once the taint aged out', kicked !== 'timeout');
  check('idle-kick names the control conn',
    hasEvent('idle-kick', e => e.connId === welcomeC.connId));
  check('live client still not kicked after sweeps resumed',
    wsA.readyState === WebSocket.OPEN &&
    !hasEvent('idle-kick', e => e.connId === welcomeA?.connId));
  clearInterval(pingTimer);

  // ── 4. /healthz stall counters ────────────────────────────────────
  console.log('\n[3] healthz reports the stall counters');
  const hz = await fetch(`${BRIDGE_HTTP}/healthz`,
    { headers: { 'x-healthz-token': HEALTHZ_TOKEN } }).then(r => r.json());
  check('healthz carries a loop section',       hz.loop != null);
  check('loop.stalls counts both stalls (≥ 2)', hz.loop?.stalls >= 2);
  check('loop.maxStallMs ≥ STALL_MIN_MS',       hz.loop?.maxStallMs >= 2000);
  check('loop.lastStallMs ≥ STALL_MIN_MS',      hz.loop?.lastStallMs >= 2000);
  check('loop.lastStallAgoS is a live gauge',   Number.isInteger(hz.loop?.lastStallAgoS));
  // G-8: unauthenticated healthz stays liveness-only.
  const hzAnon = await fetch(`${BRIDGE_HTTP}/healthz`).then(r => r.json());
  check('unauthenticated healthz does not leak loop telemetry', hzAnon.loop === undefined);

  // ── Tear down ─────────────────────────────────────────────────────
  try { wsA.close(); } catch {}
  try { wsControl.close(); } catch {}
  await reapBridge();
  try { unlinkSync(identityPath); } catch {}

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('smoke threw:', err);
  await reapBridge();   // never leave the spawned bridge squatting on the port
  process.exit(2);
});
