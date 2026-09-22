// =====================================================================
// fence_air_gap_ingress.mjs — Bridge-Air-Gap-Plan §7.2 against a REAL bridge
// child (src/server.js on a local port), a synthetic client on a raw WebSocket,
// and the operator /healthz body. WP4 rows I1–I4 (ingress), O6 (oversize and
// close accounting), and the O2 positive controls this fence can drive through
// write point 1 (the client socket).
//
//   A. oversize: a frame over MAX_PAYLOAD_BYTES → the PEER sees close 1009; the
//      bridge counts oversizeLocal=1 from its local ws error. MEASURED on ws 8.21.0
//      (2026-09-22): the bridge's own close event for that socket reads 1006, not
//      1009 — the library destroys the socket after sending the close frame and
//      never waits for the peer's echo — so close1009 stays 0 for a LOCAL
//      rejection and v0.6 O6's expectation of 'one close1009' there is wrong for
//      this library. A peer-sent close 1009 → close1009 = 1, oversizeLocal unchanged.
//      The two labels are never merged; this fence pins what the library does.
//   B. ingress partition on an admitted socket:
//      unlisted req → one res {ok:false, error:'transit-refused', outcome:'refusedUnlisted'};
//      route_msg to another id → verdict {consumed:false, terminal:true, refused:true};
//      __tunneled_direct__ → refusedUnlisted; direct_* ntf → NO reply, droppedDirect;
//      unsolicited res → droppedUnsolicited, no reply; lookahead_probe → answered (D1).
//   C. bounds: ping over its bucket → refusedRate, no pong.
//   D. the partition sums to what the decoder saw; genericTransit egress = 0;
//      welcome/hello/pong/refusal replies classified on the client point.
//   E. pre-admission: a req before client-hello gets no reply (bound zero).
// Author tests are not acceptance (Vega's challenge + Aster CP review follow).
// =====================================================================
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';
import { MAX_PAYLOAD_BYTES } from '../src/air_gap.js';

const PORT = 8141;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'fence-air-gap-token';   // test-only; the bridge reads HEALTHZ_TOKEN from env

let passed = 0, failed = 0;
const check = (label, c, extra = '') => { const b = !!c; console.log(`  ${b ? '✓' : '✗'} ${label}${b ? '' : ' ' + extra}`); b ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
function startBridge() {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'info', HEALTHZ_TOKEN: TOKEN, MIN_PEER_VERSION: KERNEL_VERSION, BRIDGE_DIRECTORY: 'off', BRIDGE_UPSTREAMS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const lines = [];
  const attach = (stream) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString();
      const parts = rest.split('\n'); rest = parts.pop();
      for (const line of parts) {
        if (line.includes('"event":"listen"')) started = true;
        lines.push(line);
        if (process.env.VERBOSE && line.trim()) console.log(`[bridge] ${line}`);
      }
    });
  };
  attach(child.stdout); attach(child.stderr);
  return { ready: () => started, lines };
}
async function reap() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch {}
  await Promise.race([exited, sleep(1500)]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} await exited; }
}
async function waitReady(ready, ms = 8000) {
  const t0 = Date.now();
  while (!ready()) { if (Date.now() - t0 > ms) throw new Error('bridge did not start'); await sleep(50); }
}
async function healthz() {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { headers: { 'x-healthz-token': TOKEN } });
  return r.json();
}

/** A raw client: collects every frame; resolves helpers for waiting on one. */
function connect({ hello = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const st = { frames: [], closed: false, code: null, welcomed: false };
    ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } st.frames.push(m); if (m.type === 'welcome') st.welcomed = true; });
    ws.on('close', (code) => { st.closed = true; st.code = code; });
    ws.on('error', () => {});
    ws.on('open', () => {
      if (hello) ws.send(JSON.stringify({ type: 'client-hello', version: KERNEL_VERSION, wireVersion: WIRE_VERSION, kernelVersion: KERNEL_VERSION }));
      resolve({ ws, st });
    });
    ws.on('error', (e) => reject(e));
  });
}
const until = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
const axona = (payload) => JSON.stringify({ type: 'axona', payload });
const resFor = (st, id) => st.frames.find((m) => m.type === 'axona' && m.payload?.k === 'res' && m.payload.id === id);

async function main() {
  console.log('fence: air-gap ingress partition, bounds, oversize accounting, egress classes (real bridge)\n');
  const { ready, lines } = startBridge();
  await waitReady(ready);
  const base = await healthz();
  check('operator /healthz carries airGap', base.airGap && base.airGap.maxPayloadBytes === MAX_PAYLOAD_BYTES, JSON.stringify(base.airGap)?.slice(0, 80));

  // ── A. oversize ────────────────────────────────────────────────────
  console.log('[A] oversize frame and close accounting');
  {
    const { ws, st } = await connect();
    check('admitted (welcome)', await until(() => st.welcomed));
    ws.send(JSON.stringify({ type: 'ping', t: 1, pad: 'x'.repeat(MAX_PAYLOAD_BYTES + 512) }));
    check('socket closed by the bridge', await until(() => st.closed, 4000));
    check('close code 1009', st.code === 1009, String(st.code));
    await sleep(150);
    const h = await healthz();
    check('oversizeLocal = 1 (the local ws error, the only proof of a local size rejection)', h.airGap.transport.oversizeLocal === 1, String(h.airGap.transport.oversizeLocal));
    check('close1009 = 0 for a LOCAL rejection (ws 8.21.0 reports 1006 locally; measured, see header)', h.airGap.transport.close1009 === 0, String(h.airGap.transport.close1009));
    check('the oversize frame is OUTSIDE the partition (decoded unchanged by it)', h.airGap.ingress.droppedInvalid === 0);
    const { ws: ws2, st: st2 } = await connect();
    await until(() => st2.welcomed);
    ws2.close(1009, 'peer-sent');
    await until(() => st2.closed);
    await sleep(150);
    const h2 = await healthz();
    check('a PEER-sent 1009 → close1009 = 1, oversizeLocal still 1 (labels never merged)', h2.airGap.transport.close1009 === 1 && h2.airGap.transport.oversizeLocal === 1, JSON.stringify(h2.airGap.transport));
  }

  // ── B. ingress partition ───────────────────────────────────────────
  console.log('[B] partition on an admitted socket');
  const { ws, st } = await connect();
  await until(() => st.welcomed);
  {
    ws.send(axona({ k: 'req', id: 11, type: 'nonsense', body: {} }));
    check('unlisted req → one transit-refused reply', await until(() => resFor(st, 11)) && resFor(st, 11).payload.ok === false && resFor(st, 11).payload.body.error === 'transit-refused' && resFor(st, 11).payload.body.outcome === 'refusedUnlisted', JSON.stringify(resFor(st, 11)?.payload));
    const other = '80'.padEnd(66, '2');
    ws.send(axona({ k: 'req', id: 12, type: 'route_msg', body: { type: 'pubsub:sub', payload: { topicId: '89'.padEnd(66, '1') }, targetId: other, hops: 3, originId: other } }));
    const v = await until(() => resFor(st, 12)) && resFor(st, 12).payload.body;
    check('route_msg to another node → the refusal VERDICT', v && v.consumed === false && v.terminal === true && v.refused === true && v.hops === 3 && v.outcome === 'refusedTransit', JSON.stringify(v));
    ws.send(axona({ k: 'req', id: 13, type: '__tunneled_direct__', body: { targetId: other, innerType: 'x', innerPayload: {} } }));
    check('__tunneled_direct__ → refusedUnlisted', await until(() => resFor(st, 13)) && resFor(st, 13).payload.body.outcome === 'refusedUnlisted');
    const before = st.frames.length;
    ws.send(axona({ k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: other } }));
    ws.send(axona({ k: 'res', id: 999, ok: true, body: {} }));
    ws.send(axona({ k: 'ntf', type: 'whatever', body: {} }));
    await sleep(300);
    check('direct_* ntf, unsolicited res, unlisted ntf → NO reply at all', st.frames.length === before, `${st.frames.length - before} extra frames`);
    ws.send(axona({ k: 'req', id: 14, type: 'lookahead_probe', body: { target: other } }));
    check('lookahead_probe is answered (D1)', await until(() => resFor(st, 14)), 'no reply');
    const h = await healthz();
    const ig = h.airGap.ingress;
    check('refusedUnlisted=2 refusedTransit=1 droppedDirect=1 droppedUnsolicited=1 droppedUnlisted=1',
      ig.refusedUnlisted === 2 && ig.refusedTransit === 1 && ig.droppedDirect === 1 && ig.droppedUnsolicited === 1 && ig.droppedUnlisted === 1, JSON.stringify(ig));
    check('transitAttempted = 2 (refusedTransit + droppedDirect)', ig.transitAttempted === 2, String(ig.transitAttempted));
    check('by-type rows: refusedUnlisted.other=1, refusedUnlisted.__tunneled_direct__=1, droppedDirect.direct_*=1',
      h.airGap.ingressByType.refusedUnlisted?.other === 1 && h.airGap.ingressByType.refusedUnlisted?.__tunneled_direct__ === 1 && h.airGap.ingressByType.droppedDirect?.['direct_*'] === 1, JSON.stringify(h.airGap.ingressByType));
  }

  // ── C. bounds ──────────────────────────────────────────────────────
  console.log('[C] per-connection bound');
  {
    const pongsBefore = st.frames.filter((m) => m.type === 'pong').length;
    for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: 'ping', t: i }));
    await sleep(300);
    const pongs = st.frames.filter((m) => m.type === 'pong').length - pongsBefore;
    check('8 pings in a burst → 5 pongs (burst 5), the rest refusedRate', pongs === 5, String(pongs));
    const h = await healthz();
    check('refusedRate ≥ 3 with ping in its by-type row', h.airGap.ingress.refusedRate >= 3 && h.airGap.ingressByType.refusedRate?.ping >= 3, JSON.stringify(h.airGap.ingressByType.refusedRate));
  }

  // ── D. sums and egress ─────────────────────────────────────────────
  console.log('[D] partition sum and egress classes');
  {
    const h = await healthz();
    const ig = h.airGap.ingress;
    const sum = Object.entries(ig).filter(([k]) => k !== 'decoded' && k !== 'transitAttempted').reduce((n, [, v]) => n + v, 0);
    check('buckets sum to messages delivered to the decoder', sum === ig.decoded, `${sum} vs ${ig.decoded}`);
    const eg = h.airGap.egress.client;
    check('genericTransit = 0 on both write points, egressRefused 0', eg.genericTransit === 0 && h.airGap.egress.uplink.genericTransit === 0 && h.airGap.egressRefused.client === 0);
    check('controlBare ≥ 3 sockets × (version-gate + welcome + peer-list)', eg.controlBare >= 9, String(eg.controlBare));
    check('hello ≥ 3 (one NH1 hello from the bridge per admitted socket)', eg.hello >= 3, String(eg.hello));
    check('refusalReply = 3 (11, 12, 13)', eg.refusalReply === 3, String(eg.refusalReply));
    check('discoveryReply = 1 (14), controlReply ≥ 5 pongs', eg.discoveryReply === 1 && eg.controlReply >= 5, JSON.stringify(eg));
    check('forwardedGeneric = 0', h.airGap.forwardedGeneric === 0);
    check('slotsInUse counts live connections only', h.airGap.slotsInUse === 1, String(h.airGap.slotsInUse));
  }

  // ── E. pre-admission ───────────────────────────────────────────────
  console.log('[E] before client-hello');
  {
    const { ws: w, st: s } = await connect({ hello: false });
    w.send(axona({ k: 'req', id: 21, type: 'lookahead_probe', body: {} }));
    await sleep(300);
    check('a req before admission gets no reply', !resFor(s, 21));
    const h = await healthz();
    check('…and is counted refusedRate (bound is zero before admission)', h.airGap.ingressByType.refusedRate?.lookahead_probe === 1, JSON.stringify(h.airGap.ingressByType.refusedRate));
    try { w.close(1000); } catch {}
  }

  check('no egress-refused log row (the invariant held during the run)', !lines.some((l) => l.includes('"event":"egress-refused"')));
  try { ws.close(1000, 'done'); } catch {}
  await reap();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => { console.error('fence crashed:', err); await reap(); process.exit(1); });
