// =====================================================================
// Fence: the hello-timeout close code is SPLIT from the version-gate code.
//
// A client that sends no client-hello in time (a suspended / slow-waking
// tab, overwhelmingly) must be closed 4408 — a NON-terminal code the kernel
// treats as a plain disconnect and reconnects from — NOT 4426, which makes
// the kernel print "UPGRADE REQUIRED — update @axona/protocol", a false
// diagnosis a sleep/wake triggers routinely (observed on axona.chat prod).
//
// A genuine version-too-old hello must STILL close 4426 (terminal upgrade),
// so the two meanings stay on distinct codes.
//
// Three checks against a real bridge child:
//   A. silence            → close 4408, reason names the timeout, no "upgrade"
//   B. old-version hello   → close 4426 (version gate unchanged)
//   C. current hello       → admitted (welcome), NOT closed at the timeout
// =====================================================================

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';

const BRIDGE_PORT    = 8137;
const BRIDGE_WS      = `ws://127.0.0.1:${BRIDGE_PORT}`;
const HELLO_TIMEOUT_MS = 1200;              // compressed for the test
const CLOSE_HELLO_TIMEOUT   = 4408;
const CLOSE_UPGRADE_REQUIRED = 4426;

let passed = 0, failed = 0;
const check = (label, cond) => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label}`); failed++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── bridge child ────────────────────────────────────────────────────
let bridgeChild = null;
function startBridge() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      LOG_LEVEL: 'info',
      MIN_PEER_VERSION: KERNEL_VERSION,      // current build clears the floor
      HELLO_TIMEOUT_MS: String(HELLO_TIMEOUT_MS),
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
}
async function waitForReady(ready, timeoutMs = 5000) {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > timeoutMs) throw new Error('bridge did not start in time');
    await sleep(50);
  }
}

// Open a socket; optionally send a hello on open. Resolve with a handle
// exposing the close outcome and the raw socket.
function connect({ hello } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS);
    const state = { code: null, reason: null, welcomed: false, closed: false };
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome') state.welcomed = true;
    });
    ws.on('close', (code, reason) => {
      state.closed = true; state.code = code; state.reason = reason.toString();
    });
    ws.on('open', () => {
      if (hello) ws.send(JSON.stringify(hello));
      resolve({ ws, state });
    });
    ws.on('error', (e) => { if (!state.closed) reject(e); });
  });
}
const waitClosed = async (state, ms) => {
  const start = Date.now();
  while (!state.closed) { if (Date.now() - start > ms) break; await sleep(25); }
};

async function main() {
  console.log('fence: hello-timeout close-code split (4408) vs version gate (4426)\n');
  const { ready } = startBridge();
  await waitForReady(ready);

  // ── A. silence → 4408, reconnectable, no upgrade language ──────────
  console.log('[A] socket that sends no client-hello');
  {
    const { state } = await connect();               // no hello
    await waitClosed(state, HELLO_TIMEOUT_MS + 2500);
    check('closed', state.closed);
    check(`close code is ${CLOSE_HELLO_TIMEOUT} (not ${CLOSE_UPGRADE_REQUIRED})`,
      state.code === CLOSE_HELLO_TIMEOUT);
    check('reason names the timeout', /not received within/i.test(state.reason || ''));
    check('reason carries no version/upgrade verdict',
      !/upgrade|min peer|below minimum/i.test(state.reason || ''));
  }

  // ── B. old-version hello → 4426 (unchanged) ────────────────────────
  console.log('[B] client-hello with an ancient version');
  {
    const { state } = await connect({
      hello: { type: 'client-hello', version: '0.9.0', wireVersion: WIRE_VERSION },
    });
    await waitClosed(state, 3000);
    check('closed', state.closed);
    check(`close code is ${CLOSE_UPGRADE_REQUIRED} (version gate intact)`,
      state.code === CLOSE_UPGRADE_REQUIRED);
  }

  // ── C. current hello → admitted, NOT killed at the timeout ─────────
  console.log('[C] client-hello with the current build');
  {
    const { ws, state } = await connect({
      hello: { type: 'client-hello', version: KERNEL_VERSION, wireVersion: WIRE_VERSION },
    });
    await sleep(HELLO_TIMEOUT_MS + 800);             // outlive the timeout window
    check('received welcome', state.welcomed);
    check('not closed at the hello-timeout', !state.closed);
    try { ws.close(1000, 'fence done'); } catch {}
  }

  await reapBridge();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('fence crashed:', err);
  await reapBridge();
  process.exit(1);
});
