// =====================================================================
// fence_signal_rate.mjs — R5 of Routed-Walk-Terminals v0.6 (axona-docs
// 88d6871), the bridge's half: relayed signals are METERED per socket per
// window; the excess is dropped and logged once per window; the socket is
// never closed.
//
// WHY. 2026-10-11, east production: one Safari tab that never bound a mesh
// peer re-requested the peer list every minute and sent 5699 relayed signals
// in an hour, a third of the door's signalling, at every other socket
// including the operator's fresh tabs. Nothing bounded it.
//
// Against a real bridge child with BRIDGE_SIGNAL_RATE=5 and a 1.5 s window:
//   A. two admitted clients; A sends 8 signals to B inside one window →
//      B receives exactly 5; healthz signals.rateLimited reads 3; the child
//      logged `signal-rate-limited` once for A's socket
//   B. A's socket is still open after the drops (never closed by the meter)
//   C. after the window A sends 2 more → both arrive (the meter resets)
//   D. BRIDGE_SIGNAL_RATE=0 turns the meter off: 8 of 8 arrive
// Mutant: delete the `if (conn.sigWinCount > SIGNAL_RATE)` drop branch →
// A receives 8 and the counter stays 0.
//
// Run: node test/fence_signal_rate.mjs
// =====================================================================
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';

const RATE = 5, WINDOW_MS = 1500, TOKEN = 'fence-signal-rate';
let passed = 0, failed = 0;
const check = (label, cond, extra = '') => { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.log(`  ✗ ${label} ${extra}`); failed++; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let bridgeChild = null, logLines = [];
function startBridge(port, extraEnv) {
  logLines = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'info', MIN_PEER_VERSION: KERNEL_VERSION,
      HELLO_TIMEOUT_MS: '5000', IDLE_TIMEOUT_MS: '60000', IDLE_CHECK_INTERVAL_MS: '5000',
      BRIDGE_UNBOUND_KICK_MS: '0', BRIDGE_NURSERY: '0', HEALTHZ_TOKEN: TOKEN,
      BRIDGE_SIGNAL_RATE: String(RATE), BRIDGE_SIGNAL_WINDOW_MS: String(WINDOW_MS), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const attach = (stream) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString(); const lines = rest.split('\n'); rest = lines.pop();
      for (const line of lines) { if (line.includes('"event":"listen"')) started = true; logLines.push(line); if (process.env.VERBOSE && line.trim()) console.log(`[bridge] ${line}`); }
    });
  };
  attach(child.stdout); attach(child.stderr);
  bridgeChild = child;
  return { ready: () => started };
}
async function reapBridge() {
  const child = bridgeChild; if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch {}
  await Promise.race([exited, sleep(1500)]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} await exited; }
  bridgeChild = null;
}
async function waitForReady(ready, timeoutMs = 5000) {
  const start = Date.now();
  while (!ready()) { if (Date.now() - start > timeoutMs) throw new Error('bridge did not start in time'); await sleep(50); }
}
const hello = { type: 'client-hello', version: KERNEL_VERSION, kernelVersion: KERNEL_VERSION, wireVersion: WIRE_VERSION };
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const st = { connId: null, signals: 0, closed: false, code: null };
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome') { st.connId = msg.connId; }
      if (msg.type === 'signal') st.signals++;
    });
    ws.on('close', (code) => { st.closed = true; st.code = code; });
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve({ ws, st }); });
    ws.on('error', (e) => { if (!st.closed) reject(e); });
  });
}
async function waitFor(pred, ms) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; }
async function healthz(port) {
  const r = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'X-Healthz-Token': TOKEN } });
  return r.json();
}

async function main() {
  console.log('fence_signal_rate: R5 — relayed signals are metered per socket per window, never closed\n');
  const PORT = 8142;
  {
    const { ready } = startBridge(PORT, {});
    await waitForReady(ready);
    const A = await connect(PORT), B = await connect(PORT);
    check('setup: both admitted with connIds', await waitFor(() => A.st.connId && B.st.connId, 3000), `${A.st.connId} ${B.st.connId}`);
    console.log('[A] 8 signals inside one window');
    for (let i = 0; i < 8; i++) A.ws.send(JSON.stringify({ type: 'signal', to: B.st.connId, payload: { i } }));
    await sleep(400);
    check(`B received exactly ${RATE} of 8`, B.st.signals === RATE, `got ${B.st.signals}`);
    const h = await healthz(PORT);
    check('healthz signals.rateLimited reads 3', h?.signals?.rateLimited === 3, JSON.stringify(h?.signals));
    check('healthz names the limit and window', h?.signals?.rateLimit === RATE && h?.signals?.windowMs === WINDOW_MS, JSON.stringify(h?.signals));
    const lim = logLines.filter((l) => l.includes('"event":"signal-rate-limited"'));
    check('the child logged signal-rate-limited exactly once for the window', lim.length === 1 && lim[0].includes(`"connId":"${A.st.connId}"`), `${lim.length} lines`);
    console.log('[B] the meter never closes the socket');
    check('A is still open after the drops', !A.st.closed && !B.st.closed, `A.closed=${A.st.closed} code=${A.st.code}`);
    console.log('[C] after the window the meter resets');
    await sleep(WINDOW_MS + 200);
    for (let i = 0; i < 2; i++) A.ws.send(JSON.stringify({ type: 'signal', to: B.st.connId, payload: { i: 100 + i } }));
    await sleep(300);
    check(`B received ${RATE + 2} in total (2 more after the window)`, B.st.signals === RATE + 2, `got ${B.st.signals}`);
    A.ws.close(); B.ws.close();
    await reapBridge();
  }
  {
    console.log('[D] BRIDGE_SIGNAL_RATE=0 turns the meter off');
    const { ready } = startBridge(PORT, { BRIDGE_SIGNAL_RATE: '0' });
    await waitForReady(ready);
    const A = await connect(PORT), B = await connect(PORT);
    await waitFor(() => A.st.connId && B.st.connId, 3000);
    for (let i = 0; i < 8; i++) A.ws.send(JSON.stringify({ type: 'signal', to: B.st.connId, payload: { i } }));
    await sleep(400);
    const h = await healthz(PORT);
    check('all 8 arrive and the counter stays 0', B.st.signals === 8 && h?.signals?.rateLimited === 0 && h?.signals?.rateLimit === 0, `got ${B.st.signals} ${JSON.stringify(h?.signals)}`);
    A.ws.close(); B.ws.close();
    await reapBridge();
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error('fence crashed:', e); await reapBridge(); process.exit(1); });
