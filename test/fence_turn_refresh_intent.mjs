// =====================================================================
// Fence (2.155.0): a client-hello with `intent: 'turn-refresh'` is a
// credential-only exchange — welcome, then release with 4200; no peer-list,
// no announce to the others.
//
// WHY. A graduated kernel node must refresh its TURN credential every TTL −
// safety and had no socket to do it on, so it re-dialled as a newcomer: the
// bridge handed it a peer-list, announced it, and the node dialled anchors it
// already held. 2026-10-09: two Windows relays froze deduplicating those
// duplicates. Kernel 4.108.0 sends the intent; this is the bridge half.
//
// Against a real bridge child:
//   A. a normal client B is admitted and receives a peer-list (control)
//   B. client A with intent: welcome received, NO peer-list within the
//      window, closed with 4200 shortly after, reason names the credential
//   C. B never receives peer-joined for A
//   D. a normal client C (no intent) after A: welcome + peer-list as before
// Mutant: remove the `conn.turnRefreshOnly` early return → B and C fail.
// =====================================================================
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';

const CLOSE_GRADUATED = 4200;
const PORT = 8141;
const RELEASE_MS = 150;

let passed = 0, failed = 0;
const check = (label, cond, extra = '') => { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.log(`  ✗ ${label} ${extra}`); failed++; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let bridgeChild = null;
function startBridge() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'info', MIN_PEER_VERSION: KERNEL_VERSION, HELLO_TIMEOUT_MS: '5000', BRIDGE_TURN_REFRESH_RELEASE_MS: String(RELEASE_MS), BRIDGE_NURSERY: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const attach = (stream) => { let rest = ''; stream.on('data', (chunk) => { rest += chunk.toString(); const lines = rest.split('\n'); rest = lines.pop(); for (const line of lines) { if (line.includes('"event":"listen"')) started = true; if (process.env.VERBOSE && line.trim()) console.log(`[bridge] ${line}`); } }); };
  attach(child.stdout); attach(child.stderr);
  bridgeChild = child;
  return { ready: () => started };
}
async function reapBridge() { const c = bridgeChild; if (!c || c.exitCode !== null) return; const exited = new Promise((r) => c.once('exit', r)); try { c.kill('SIGTERM'); } catch {} await Promise.race([exited, sleep(1500)]); if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch {} await exited; } }
async function waitForReady(ready, timeoutMs = 5000) { const start = Date.now(); while (!ready()) { if (Date.now() - start > timeoutMs) throw new Error('bridge did not start in time'); await sleep(50); } }
function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const state = { frames: [], code: null, reason: null, closed: false, closedAt: 0 };
    ws.on('message', (data) => { try { state.frames.push(JSON.parse(data.toString())); } catch {} });
    ws.on('close', (code, reason) => { state.closed = true; state.closedAt = Date.now(); state.code = code; state.reason = reason.toString(); });
    ws.on('open', () => { if (hello) ws.send(JSON.stringify(hello)); resolve({ ws, state }); });
    ws.on('error', (e) => { if (!state.closed) reject(e); });
  });
}
const types = (st) => st.frames.map((f) => f.type);
const base = { type: 'client-hello', version: KERNEL_VERSION, kernelVersion: KERNEL_VERSION, wireVersion: WIRE_VERSION };

async function main() {
  console.log('fence: intent turn-refresh = welcome + 4200, no peer-list, no announce\n');
  const { ready } = startBridge();
  await waitForReady(ready);

  console.log('[A] control: a normal client gets welcome + peer-list');
  const B = await connect(base);
  await sleep(400);
  check('B welcomed and listed', types(B.state).includes('welcome') && types(B.state).includes('peer-list'), types(B.state).join(','));
  const bFramesBefore = B.state.frames.length;

  console.log('[B] credential-only client');
  const t0 = Date.now();
  const A = await connect({ ...base, intent: 'turn-refresh' });
  await sleep(RELEASE_MS * 4 + 400);
  check('A received welcome', types(A.state).includes('welcome'), types(A.state).join(','));
  check('A received NO peer-list', !types(A.state).includes('peer-list'), types(A.state).join(','));
  check(`A closed with ${CLOSE_GRADUATED}`, A.state.closed && A.state.code === CLOSE_GRADUATED, `closed=${A.state.closed} code=${A.state.code}`);
  check('A\'s close reason names the credential', /turn credential refreshed/i.test(A.state.reason || ''), A.state.reason);
  check('A was released no earlier than the release delay', A.state.closedAt - t0 >= RELEASE_MS, `${A.state.closedAt - t0} ms`);

  console.log('[C] the others never heard of A');
  const bNew = B.state.frames.slice(bFramesBefore);
  check('B received no peer-joined for A', !bNew.some((f) => f.type === 'peer-joined'), JSON.stringify(bNew.map((f) => f.type)));

  console.log('[D] a normal client after A is admitted as before');
  const C = await connect(base);
  await sleep(400);
  check('C welcomed and listed', types(C.state).includes('welcome') && types(C.state).includes('peer-list'), types(C.state).join(','));
  check('C is still open at the release delay (not a credential-only client)', !C.state.closed);

  try { B.ws.close(1000); C.ws.close(1000); } catch {}
  await reapBridge();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (err) => { console.error('fence crashed:', err); await reapBridge(); process.exit(1); });
