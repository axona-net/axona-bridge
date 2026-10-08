// =====================================================================
// Fence (2.154.0): an ADMITTED socket that never binds an identity is
// closed 4401 after BRIDGE_UNBOUND_KICK_MS — on the idle sweep's cadence.
//
// WHY. 2026-10-08, east production: sixteen sockets from one host ran a
// kernel-4.84.0 application that passed the client-hello gate, received
// `welcome`, ponged every ping, and never sent the authenticated hello. They
// sat admitted and identity-less for forty minutes, the idle sweep could not
// see them (they pong), and the anchor selection handed them to every
// newcomer by uptime. Howard's suite read 84/92 topics mismatched.
//
// Three checks against a real bridge child:
//   A. admitted, never authenticates → open before the deadline, closed 4401
//      after it, reason names the deadline, no version/upgrade language
//   B. silence (no client-hello)     → still 4408 (the hello-timeout path is untouched)
//   C. BRIDGE_UNBOUND_KICK_MS=0      → an admitted, unauthenticated socket is kept
// Mutant: delete the unbound block in sweepIdleConnections → A fails.
// =====================================================================

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';

const CLOSE_UNAUTHENTICATED  = 4401;
const CLOSE_HELLO_TIMEOUT    = 4408;
const UNBOUND_KICK_MS        = 1500;   // compressed for the test
const SWEEP_MS               = 300;
const HELLO_TIMEOUT_MS       = 800;

let passed = 0, failed = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label} ${extra}`); failed++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let bridgeChild = null;
function startBridge(port, extraEnv) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'info',
      MIN_PEER_VERSION: KERNEL_VERSION,
      HELLO_TIMEOUT_MS: String(HELLO_TIMEOUT_MS),
      IDLE_TIMEOUT_MS: '60000',               // the idle sweep must not be what closes A
      IDLE_CHECK_INTERVAL_MS: String(SWEEP_MS),
      BRIDGE_UNBOUND_KICK_MS: String(UNBOUND_KICK_MS),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const attach = (stream) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString();
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (line.includes('"event":"listen"')) started = true;
        if (process.env.VERBOSE && line.trim()) console.log(`[bridge] ${line}`);
      }
    });
  };
  attach(child.stdout); attach(child.stderr);
  bridgeChild = child;
  return { ready: () => started };
}
async function reapBridge() {
  const child = bridgeChild;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch {}
  await Promise.race([exited, sleep(1500)]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} await exited; }
  bridgeChild = null;
}
async function waitForReady(ready, timeoutMs = 5000) {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > timeoutMs) throw new Error('bridge did not start in time');
    await sleep(50);
  }
}
function connect(port, { hello } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const state = { code: null, reason: null, welcomed: false, closed: false, closedAt: 0 };
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome') state.welcomed = true;
    });
    ws.on('close', (code, reason) => { state.closed = true; state.closedAt = Date.now(); state.code = code; state.reason = reason.toString(); });
    ws.on('open', () => { if (hello) ws.send(JSON.stringify(hello)); resolve({ ws, state }); });
    ws.on('error', (e) => { if (!state.closed) reject(e); });
  });
}
const waitClosed = async (state, ms) => {
  const start = Date.now();
  while (!state.closed) { if (Date.now() - start > ms) break; await sleep(25); }
};
const currentHello = { type: 'client-hello', version: KERNEL_VERSION, kernelVersion: KERNEL_VERSION, wireVersion: WIRE_VERSION };

async function main() {
  console.log('fence: an admitted socket that never binds an identity is closed 4401 at BRIDGE_UNBOUND_KICK_MS\n');
  const PORT = 8139;
  const { ready } = startBridge(PORT, {});
  await waitForReady(ready);

  console.log('[A] admitted, never authenticates');
  {
    const t0 = Date.now();
    const { state } = await connect(PORT, { hello: currentHello });
    await sleep(Math.floor(UNBOUND_KICK_MS * 0.5));
    check('welcomed (admitted)', state.welcomed);
    check('still open at half the deadline', !state.closed);
    await waitClosed(state, UNBOUND_KICK_MS + SWEEP_MS * 4 + 1000);
    check('closed after the deadline', state.closed, `code=${state.code}`);
    check(`close code is ${CLOSE_UNAUTHENTICATED}`, state.code === CLOSE_UNAUTHENTICATED, `code=${state.code} reason=${state.reason}`);
    check('reason names the unbound deadline', /no identity bound within/i.test(state.reason || ''), state.reason);
    check('reason carries no version/upgrade verdict', !/upgrade|min peer|below minimum/i.test(state.reason || ''));
    check('closed no earlier than the deadline', state.closedAt - t0 >= UNBOUND_KICK_MS, `after ${state.closedAt - t0} ms`);
  }

  console.log('[B] silence: the hello-timeout path is untouched');
  {
    const { state } = await connect(PORT);
    await waitClosed(state, HELLO_TIMEOUT_MS + 2500);
    check(`closed ${CLOSE_HELLO_TIMEOUT} (hello timeout), not ${CLOSE_UNAUTHENTICATED}`, state.closed && state.code === CLOSE_HELLO_TIMEOUT, `code=${state.code}`);
  }
  await reapBridge();

  console.log('[C] BRIDGE_UNBOUND_KICK_MS=0 keeps an admitted, unauthenticated socket');
  {
    const PORT2 = 8140;
    const { ready: ready2 } = startBridge(PORT2, { BRIDGE_UNBOUND_KICK_MS: '0' });
    await waitForReady(ready2);
    const { ws, state } = await connect(PORT2, { hello: currentHello });
    await sleep(UNBOUND_KICK_MS + SWEEP_MS * 4 + 500);
    check('welcomed', state.welcomed);
    check('not closed with the kick disabled', !state.closed, `code=${state.code}`);
    try { ws.close(1000, 'fence done'); } catch {}
    await reapBridge();
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('fence crashed:', err);
  await reapBridge();
  process.exit(1);
});
