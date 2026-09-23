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
//   H. A's received SUB whose surviving via names client B: the no-role REROUTE
//      branch restamps it with the bridge's own id addressed to B, a directly
//      connected client on an introduction edge. B must receive nothing and no
//      forbidden invocation may occur at any of the three write points.
//   G. A's route_msg addressed to the BRIDGE ITSELF with SUB for the legacy
//      directory copy: consumed locally (the bridge roots it), B untouched, the
//      only new socket invocations are the reply and the serve to A (Aster 89e85dea).
//   F. two authenticated clients A and B (NH1 complete, both in the synaptome):
//      A's route_msg / direct_* / __tunneled_direct__ addressed to B → refusal
//      verdict to A, NOTHING at B, zero genericTransit attempts and writes.
// Author tests are not acceptance (Vega's challenge + Aster CP review follow).
// =====================================================================
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION, createNodeIdentity, buildAuthHello, cbvFromNonces } from '@axona/protocol';
import { MAX_PAYLOAD_BYTES } from '../src/air_gap.js';
import { deriveTopicIdBig } from '@axona/protocol/pubsub/post.js';
import { BRIDGE_DIRECTORY_TOPIC } from '@axona/protocol';

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
    const eg = h.airGap.egress.client.returned;
    const inv = h.airGap.egress.client.invoked;
    const at = h.airGap.egress.client.attempts;
    check('genericTransit INVOKED = 0 and ATTEMPTS = 0 on every point (nothing tried to leave carrying another node\'s frame)',
      inv.genericTransit === 0 && at.genericTransit === 0 && h.airGap.genericTransitAttempts === 0 && h.airGap.forwardedGeneric === 0 && h.airGap.egressRefused.client === 0);
    check('every class: returned ≤ invoked ≤ attempts, and equal here (no send threw)', Object.keys(eg).every((k) => eg[k] <= inv[k] && inv[k] <= at[k]) && Object.keys(eg).every((k) => eg[k] === at[k]), JSON.stringify({ at, inv, eg }));
    check('threw and asyncFailed are 0 on the client point', Object.values(h.airGap.egress.client.threw).every((v) => v === 0) && Object.values(h.airGap.egress.client.asyncFailed).every((v) => v === 0));
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

  // ── F. two AUTHENTICATED clients: a received frame addressed to another ──
  //      directly connected client (Aster 66db253a) over write point 1
  console.log('[F] a received client frame addressed to ANOTHER directly connected client');
  {
    // Complete the NH1 handshake so both are bound in the bridge's synaptome:
    // welcome → bridge hello (ntf) → our authenticated hello-ack.
    async function authed() {
      const { ws: w, st: s } = await connect();
      await until(() => s.welcomed);
      const welcome = s.frames.find((m) => m.type === 'welcome');
      await until(() => s.frames.some((m) => m.type === 'axona' && m.payload?.type === 'hello'));
      const me = await createNodeIdentity({ lat: 38.0, lng: -77.0 });
      const cbv = cbvFromNonces(welcome.serverNonce, welcome.connId, 'bridge');
      const ack = await buildAuthHello({ identity: me, cbv });
      w.send(axona({ k: 'ntf', type: 'hello-ack', body: ack }));
      return { ws: w, st: s, idHex: me.id };
    }
    const A = await authed();
    const B = await authed();
    await sleep(200);
    const h0 = await healthz();
    check('both clients are bound in the bridge synaptome (the addressee IS directly connected)', h0.axona.synaptomeSize >= 2, String(h0.axona.synaptomeSize));
    const bFramesBefore = B.st.frames.length;
    const dirTopic = '89'.padEnd(66, '1');
    A.ws.send(axona({ k: 'req', id: 31, type: 'route_msg', body: { type: 'pubsub:sub', payload: { topicId: dirTopic, subscriberId: A.idHex }, targetId: B.idHex, hops: 0, originId: A.idHex } }));
    const v = await until(() => resFor(A.st, 31)) && resFor(A.st, 31).payload.body;
    check('A → route_msg addressed to B: A gets the refusal verdict (refusedTransit)', v && v.refused === true && v.outcome === 'refusedTransit', JSON.stringify(v));
    A.ws.send(axona({ k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: dirTopic, targetId: B.idHex } }));
    A.ws.send(axona({ k: 'req', id: 32, type: '__tunneled_direct__', body: { targetId: B.idHex, innerType: 'pubsub:deliver', innerPayload: {} } }));
    await until(() => resFor(A.st, 32));
    await sleep(300);
    check('B received NOTHING from A across the bridge (no req, no ntf, no tunnelled frame)', B.st.frames.length === bFramesBefore, `${B.st.frames.length - bFramesBefore} frames`);
    const h = await healthz();
    check('genericTransit attempts AND writes still 0 on every point', h.airGap.genericTransitAttempts === 0 && h.airGap.forwardedGeneric === 0, JSON.stringify({ a: h.airGap.genericTransitAttempts, w: h.airGap.forwardedGeneric }));
    check('the data-channel point is reported (attempts/invoked/returned, zero without an uplink)', h.airGap.egress.datachannel && h.airGap.egress.datachannel.invoked.genericTransit === 0 && h.airGap.egress.datachannel.attempts.genericTransit === 0);

    const bridgeHello = A.st.frames.find((m) => m.type === 'axona' && m.payload?.type === 'hello');
    const bridgeId = bridgeHello.payload.body.nodeId;
    const legacy = (await deriveTopicIdBig({ region: 'bridge', name: BRIDGE_DIRECTORY_TOPIC })).toString(16).padStart(66, '0');

    // ── H. the _reroute regression, deterministic (Aster 32556d0d) ──────
    //     A's RECEIVED publish carries via [bridge, B]. The bridge holds no role, so
    //     _topicDecision takes its no-role REROUTE branch: via is popped and the
    //     payload is restamped with the bridge's own id, addressed to B — a
    //     DIRECTLY CONNECTED client on an introduction edge. That is precisely
    //     the case where "the bridge has no transit edges" is not the argument:
    //     the origin addressee exception would otherwise deliver it. It must not,
    //     because the bridge received this frame; it did not originate it.
    console.log('[H] a received PUB restamped toward a directly connected client is NOT delivered');
    {
      const diag0 = await (await fetch(`http://127.0.0.1:${PORT}/diag`, { headers: { 'x-healthz-token': TOKEN } })).json();
      check('PRECONDITION: the bridge holds NO role for this copy, so _topicDecision must take its no-role REROUTE branch (not local consumption)',
        !diag0.axonRoles.some((r) => r.topic === legacy), JSON.stringify(diag0.axonRoles));
      const hb2 = await healthz();
      const invB = { ...hb2.airGap.egress.client.invoked };
      const dcB = { ...hb2.airGap.egress.datachannel.invoked };
      const upB = { ...hb2.airGap.egress.uplink.invoked };
      const bBefore3 = B.st.frames.length;
      // A PUB, not a SUB: once restamped with the bridge's own originId this is
      // byte-indistinguishable at the write from the bridge's OWN directory entry
      // (class directoryOwnEntry, which is ALLOWED). The egress classifier cannot
      // catch it. The origin rule in the hop choice is the only thing that can.
      A.ws.send(axona({ k: 'req', id: 51, type: 'route_msg', body: { type: 'pubsub:pub', payload: { topicId: legacy, via: [bridgeId, B.idHex], json: JSON.stringify({ msgId: 'a-entry', v: 1, text: 'A entry' }) }, targetId: bridgeId, hops: 0, originId: A.idHex } }));
      const v51 = await until(() => resFor(A.st, 51), 4000) && resFor(A.st, 51).payload.body;
      check('the frame is accepted at ingress and consumed (it is addressed to the bridge for a directory copy)', v51 && v51.consumed === true, JSON.stringify(v51));
      await sleep(500);
      const atB = B.st.frames.slice(bBefore3);
      console.log('      [B received]', JSON.stringify(atB.map((m) => (m.type === 'axona' ? `${m.payload?.k}:${m.payload?.type}` : m.type))));
      check('B received NO route_msg and NO pubsub verb: A\'s publish never crossed the bridge',
        atB.every((m) => !(m.type === 'axona' && (m.payload?.type === 'route_msg' || String(m.payload?.type || '').startsWith('pubsub:') || String(m.payload?.type || '').startsWith('direct_')))),
        JSON.stringify(atB.map((m) => m.payload?.type ?? m.type)));
      check('anything B did receive is a DISCOVERY query about the bridge\'s own placement, which §7.1 permits over an introduction edge',
        atB.every((m) => m.type === 'axona' && m.payload?.k === 'req' && ['lookup_step', 'find_closest_set', 'local_probe', 'lookahead_probe'].includes(m.payload?.type)),
        JSON.stringify(atB.map((m) => m.payload?.type ?? m.type)));
      const ha2 = await healthz();
      const inv2 = ha2.airGap.egress.client.invoked;
      check('zero forbidden invocations at ALL THREE physical points', ha2.airGap.forwardedGeneric === 0 && inv2.genericTransit === 0 && ha2.airGap.egress.uplink.invoked.genericTransit === 0 && ha2.airGap.egress.datachannel.invoked.genericTransit === 0, JSON.stringify({ c: inv2.genericTransit, u: ha2.airGap.egress.uplink.invoked.genericTransit, d: ha2.airGap.egress.datachannel.invoked.genericTransit }));
      check('no new invocation of any class at the uplink or data-channel points', JSON.stringify(ha2.airGap.egress.uplink.invoked) === JSON.stringify(upB) && JSON.stringify(ha2.airGap.egress.datachannel.invoked) === JSON.stringify(dcB));
      const grew2 = Object.keys(inv2).filter((kk) => inv2[kk] !== invB[kk]);
      check('at the client socket the only new invocation classes are the reply to A, directory service to A, and the bridge\'s own discovery query — no transit class',
        grew2.every((kk) => kk === 'controlReply' || kk === 'directoryServe' || kk === 'discoveryRequest'), JSON.stringify(grew2));
      const diag1 = await (await fetch(`http://127.0.0.1:${PORT}/diag`, { headers: { 'x-healthz-token': TOKEN } })).json();
      check('EVIDENCE the reroute branch ran: the via-addressed PUB ended as a LOCAL root here, which only the pop-to-bare-topic path produces',
        diag1.axonRoles.some((r) => r.topic === legacy && r.isRoot === true), JSON.stringify(diag1.axonRoles));
    }

    // ── G. the ONE received-frame path the bridge can reach: a route_msg
    //      addressed to the bridge itself for a directory copy (Aster 89e85dea)
    console.log('[G] self-addressed SUB for a directory copy the bridge now roots: served locally, never re-emitted');
    const hb = await healthz();
    const invBefore = { ...hb.airGap.egress.client.invoked };
    const bBefore2 = B.st.frames.length;
    A.ws.send(axona({ k: 'req', id: 41, type: 'route_msg', body: { type: 'pubsub:sub', payload: { topicId: legacy, via: [bridgeId], subscriberId: A.idHex, since: 0 }, targetId: bridgeId, hops: 0, originId: A.idHex } }));
    const v41 = await until(() => resFor(A.st, 41), 4000) && resFor(A.st, 41).payload.body;
    check('the bridge CONSUMES it (verdict consumed:true, no refusal)', v41 && v41.consumed === true && v41.refused !== true, JSON.stringify(v41));
    await sleep(400);
    const diag = await (await fetch(`http://127.0.0.1:${PORT}/diag`, { headers: { 'x-healthz-token': TOKEN } })).json();
    check('the bridge holds ROOT of the legacy directory copy and serves A from it (rootAllowList admits it)', diag.axonRoles.some((r) => r.topic === legacy && r.isRoot === true), JSON.stringify(diag.axonRoles));
    check('the legacy copy is in rootAllowList, nothing else was seated', diag.rootAllowList.includes(legacy) && diag.axonRoles.length === 1, String(diag.axonRoles.length));
    const atB2 = B.st.frames.slice(bBefore2);
    check('B received no route_msg and no pubsub verb: the subscribe was served here, not re-emitted',
      atB2.every((m) => !(m.type === 'axona' && (m.payload?.type === 'route_msg' || String(m.payload?.type || '').startsWith('pubsub:') || String(m.payload?.type || '').startsWith('direct_')))),
      JSON.stringify(atB2.map((m) => m.payload?.type ?? m.type)));
    const ha = await healthz();
    const inv = ha.airGap.egress.client.invoked;
    const grew = Object.keys(inv).filter((k) => inv[k] !== invBefore[k]);
    check('the only NEW client-socket invocation classes are the reply to A, directory service to A and the bridge\'s own discovery query; nothing generic, nothing re-emitted',
      grew.every((k) => k === 'controlReply' || k === 'directoryServe' || k === 'discoveryRequest') && inv.genericTransit === 0 && ha.airGap.forwardedGeneric === 0, JSON.stringify({ grew, gt: inv.genericTransit }));

    try { A.ws.close(1000); B.ws.close(1000); } catch {}
  }

  check('no egress-refused log row (the invariant held during the run)', !lines.some((l) => l.includes('"event":"egress-refused"')));
  try { ws.close(1000, 'done'); } catch {}
  await reap();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => { console.error('fence crashed:', err); await reap(); process.exit(1); });
