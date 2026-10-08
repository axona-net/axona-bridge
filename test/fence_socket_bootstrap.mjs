#!/usr/bin/env node
// fence_socket_bootstrap — Socket-is-bootstrap v0.5 (axona-docs 7a27d24): the
// BRIDGE half. "Once we establish a websocket connection to a bridge, we need
// to replace it with a webrtc connection. The bridge relay should be the same
// as a regular relay except that it can graduate a connected node to make
// room for a newly introduced node." — David, 2026-10-07.
//
//   A. RESOLVER. Off unless the flag is on; every other variable ignored
//      then. On: strict positive integers, semver min kernel; bad → refuse.
//   B. LABELS. Door epoch, reserved id, door key, parser, own-key test; the
//      sliding budget cannot double at a window boundary; both cooldown
//      scopes expire.
//   C. OFF IS BYTE-IDENTICAL. A node without the flag: no reserved id, door
//      signals not consumed, no socket-bootstrap report, door closeConnection
//      as before.
//   D. THROUGH THE REAL NODE (flag on, armed, cap 3): the reserved id goes
//      only to an eligible kernel; a signal to it enters the mesh under the
//      door key and the answer returns over THAT socket from the reserved id;
//      the open channel is PROVISIONAL (not counted by the degree pass) until
//      its identity binds; a bind runs the bind policy → gatePreflight →
//      kernel admission: one synaptome entry; the socket hello that lands
//      AFTER the channel bound admits nothing (born superseded); the socket's
//      close evicts nothing; the channel's death evicts the identity.
//   E. HELLO FIRST. A socket hello before the channel admits over the
//      socket; the channel bind is a SWITCH (no re-admission, one entry);
//      the socket close is swallowed; the mesh death evicts.
//   F. MAKE ROOM AT BIND. At cap 3 a fourth newcomer's bind retires ONE
//      incumbent (never the newcomer, never a provisional) and is admitted;
//      the victim's identity is refused at its next bind (cooldown) and its
//      channel closed; budget spent → refused; protected set → refused; an
//      ineligible newcomer (gate) retires only its own channel, no incumbent,
//      no budget.
//   G. STATICS on server.js and the node.
//
// Mutants (each run by hand; the section named fails): let the door's own
// death handler mark a superseded identity dead → D7; make the bind policy
// skip gatePreflight → F6, F7; retire before the budget check → F4–F7, G6;
// deliver reserved-id signals from an unadmitted connection → G1; count
// provisional in the degree pass → D4 (kernel fence too). NOTE: removing the
// born-superseded `return` in _completeHandshake is behaviourally
// EQUIVALENT (the existing synaptome.has check already skips admission);
// that return saves work and is not what protects the identity — the
// composite's route rule is (kernel fence_route_token).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BridgeAxonaNode } from '../src/bridge_axona_node.js';
import {
  resolveSocketBootstrap, mintDoorEpoch, reservedId, doorKey, parseDoorKey, isOwnDoorKey,
  SlidingBudget, RecentlyRetired, SOCKET_BOOTSTRAP_DEFAULTS,
} from '../src/socket_bootstrap.js';
import { MeshManager }      from '@axona/protocol/transport/web/mesh.js';
import { WebRTCTransport }  from '@axona/protocol/transport/web/webrtc.js';
import { CompositeTransport } from '@axona/protocol/transport/web/composite.js';
import { KERNEL_VERSION }   from '@axona/protocol/transport/handshake.js';
import { idToHex }          from '../src/identity.js';
import { missingKernelSurfaces, gteVersion } from '../src/socket_bootstrap.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };

// PIN GATE (as fence_bridge_fill H0): the kernel surfaces this design needs
// ship in kernel ≥ 4.107.0. On an older pin the kernel sections are SKIPPED
// (the bridge runs with the flag off there, and with it on it refuses at
// startUplink); on a pin that claims ≥ 4.107.0 and lacks them, this FAILS.
const kernelMissing = missingKernelSurfaces({
  meshTransport: { setDoorSignalSink: () => {}, mesh: MeshManager.prototype },
  composite: CompositeTransport.prototype,
  peer: { gatePreflight: (await import('@axona/protocol')).AxonaPeer?.prototype?.gatePreflight },
});
const kernelHasSurfaces = kernelMissing.length === 0;
if (!kernelHasSurfaces && gteVersion(KERNEL_VERSION, SOCKET_BOOTSTRAP_DEFAULTS.minKernel)) {
  console.log(`  ✗ P0 installed kernel ${KERNEL_VERSION} claims ≥ ${SOCKET_BOOTSTRAP_DEFAULTS.minKernel} but lacks ${kernelMissing.join(', ')}`);
  process.exit(1);
}
if (!kernelHasSurfaces) console.log(`  (installed kernel ${KERNEL_VERSION} lacks ${kernelMissing.join(', ')}: sections C–F skipped, the flag refuses on this pin)`);
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a fake RTCPeerConnection for the real MeshManager ───────────────────
class FakeDC { constructor() { this.readyState = 'connecting'; this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; } send() {} close() { this.readyState = 'closed'; } }
class FakePC {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.remoteDescription = null; this.localDescription = null; this.onconnectionstatechange = null; this.oniceconnectionstatechange = null; this.onicecandidate = null; this.ondatachannel = null; this.closeCalls = 0; }
  createDataChannel() { return new FakeDC(); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  async getStats() { return new Map(); }
  close() { this.closeCalls++; this.connectionState = 'closed'; queueMicrotask(() => { try { this.onconnectionstatechange?.(); } catch {} }); }
}
globalThis.RTCPeerConnection = FakePC;

const ARMED_ENV = { BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_ADMISSION_GATE: '1', BRIDGE_MESH_MAX_PEERS: '3' };
const ON_ENV = { ...ARMED_ENV, BRIDGE_SOCKET_IS_BOOTSTRAP: '1', BRIDGE_MAKE_ROOM_PER_MIN: '1', BRIDGE_BIND_DEADLINE_MS: '60', BRIDGE_PROVISIONAL_MAX: '2' };

/**
 * A door harness: sockets by connId, frames captured per connId; plus the
 * "uplink" mesh transport the node would get from a mesh-only webTransport —
 * a real MeshManager + WebRTCTransport under a CompositeTransport, with the
 * door sink surface and the mesh's sendSignal routed to it.
 */
function makeDoor() {
  const open = new Set(); const frames = new Map();
  const sendToConn = (cid, msg) => { if (!open.has(cid)) throw new Error('closed'); (frames.get(cid) ?? frames.set(cid, []).get(cid)).push(msg); return true; };
  return { open, frames, sendToConn, isConnOpen: (cid) => open.has(cid), closeConn: (cid) => open.delete(cid), closed: [], framesOf: (cid) => frames.get(cid) ?? [] };
}
function makeMeshTransport(localIdBig, degreeCap) {
  let webrtcRef = null; let sink = null;
  const mesh = new MeshManager({
    sendSignal: (to, payload) => { if (typeof sink === 'function' && sink(to, payload) === true) return; mesh.__unrouted = (mesh.__unrouted ?? 0) + 1; },
    log: () => {}, ledger: false,
    degree: { maxPeers: degreeCap, slack: 0, intervalMs: 0, minUptimeMs: 0,
      regionOf: (id) => { const n = webrtcRef?.nodeIdFor?.(id); return typeof n === 'bigint' ? idToHex(n).slice(0, 2) : null; },
      isProtected: () => false },
  });
  const webrtc = new WebRTCTransport({ mesh, localNodeId: localIdBig, log: () => {} });
  webrtcRef = webrtc;
  const t = new CompositeTransport({ localNodeId: localIdBig, log: () => {} });
  t.addSubtransport(webrtc);
  t.mesh = mesh; t.webrtc = webrtc;
  t.setDoorSignalSink = (fn) => { sink = fn; };
  return t;
}
async function makeNode(env, door, degreeCap = 3) {
  const node = new BridgeAxonaNode({ sendToConn: door.sendToConn, isConnOpen: door.isConnOpen, closeConn: door.closeConn, log: () => {}, env });
  await node.start();
  if (node._peer?._maintainTimer) { clearInterval(node._peer._maintainTimer); node._peer._maintainTimer = null; }
  const t = makeMeshTransport(node._identity.id, degreeCap);
  await t.start(node._identity.id);
  node._composite.addSubtransport(t);
  node._uplink = { transport: t, upstream: null, meshOnly: true };
  if (node.socketBootstrapOn()) node._wireDoorMesh(t);
  return { node, t, mesh: t.mesh, webrtc: t.webrtc };
}
const openDc = (st) => { st.pc.ondatachannel({ channel: new FakeDC() }); st.dc.readyState = 'open'; st.dc.onopen(); };
const idOf = (node, k) => node._identity.id ^ (1n << BigInt(120 + k));
const idOfRegion = (node, k) => (node._identity.id ^ (1n << BigInt(120 + k))) ^ (1n << 259n);   // flips the top byte → another region

/** Drive one door newcomer: offer in, answer out, channel open; returns the state and key. */
async function newcomer(node, door, mesh, connId, attempt = 'A') {
  door.open.add(connId);
  const consumed = node.deliverDoorSignal(connId, { kind: 'sdp-offer', sdp: 'v=0 offer', attempt });
  await tick(); await tick();
  const key = doorKey(node._doorEpoch, connId);
  const st = mesh._peers.get(key);
  if (st) openDc(st);
  return { consumed, key, st };
}

(async () => {
  console.log('fence_socket_bootstrap: socket-is-bootstrap v0.5 — the bridge half');

  // ── A. resolver ──────────────────────────────────────────────────────
  {
    check('A1 off by default', resolveSocketBootstrap({}).on === false);
    check('A1b off ignores every other variable', resolveSocketBootstrap({ BRIDGE_PROVISIONAL_MAX: 'junk' }).on === false);
    const on = resolveSocketBootstrap({ BRIDGE_SOCKET_IS_BOOTSTRAP: '1' });
    check('A2 on with the defaults', on.on === true && on.provisionalMax === SOCKET_BOOTSTRAP_DEFAULTS.provisionalMax && on.bindDeadlineMs === SOCKET_BOOTSTRAP_DEFAULTS.bindDeadlineMs && on.makeRoomPerMin === SOCKET_BOOTSTRAP_DEFAULTS.makeRoomPerMin && on.minKernel === SOCKET_BOOTSTRAP_DEFAULTS.minKernel);
    let threw = null; try { resolveSocketBootstrap({ BRIDGE_SOCKET_IS_BOOTSTRAP: 'on', BRIDGE_MAKE_ROOM_PER_MIN: '4x' }); } catch (e) { threw = e; }
    check('A3 a non-integer numeric variable refuses at construction', threw instanceof TypeError && /BRIDGE_MAKE_ROOM_PER_MIN/.test(threw.message));
    threw = null; try { resolveSocketBootstrap({ BRIDGE_SOCKET_IS_BOOTSTRAP: 'true', BRIDGE_PROVISIONAL_MAX: '0' }); } catch (e) { threw = e; }
    check('A3b zero refuses', threw instanceof TypeError);
    threw = null; try { resolveSocketBootstrap({ BRIDGE_SOCKET_IS_BOOTSTRAP: '1', BRIDGE_SOCKET_BOOTSTRAP_MIN_KERNEL: 'latest' }); } catch (e) { threw = e; }
    check('A4 a non-semver min kernel refuses', threw instanceof TypeError);
    check('A5 explicit values are taken', resolveSocketBootstrap({ BRIDGE_SOCKET_IS_BOOTSTRAP: 'yes', BRIDGE_PROVISIONAL_MAX: '7', BRIDGE_SOCKET_BOOTSTRAP_MIN_KERNEL: '4.108.0' }).provisionalMax === 7);
  }

  // ── B. labels, budget, cooldowns ─────────────────────────────────────
  {
    const e = mintDoorEpoch(() => 0.5);
    check('B1 the epoch is 8 hex chars', /^[0-9a-f]{8}$/.test(e));
    const rid = reservedId(e);
    check('B2 the reserved id is of the door form the counter never mints', rid.startsWith('c-self-') && !/^c[0-9a-z]+$/.test(rid));
    const k = doorKey(e, 'c7');
    const p = parseDoorKey(k);
    check('B3 a door key parses back to its epoch and connId', p && p.epoch === e && p.connId === 'c7' && isOwnDoorKey(k, e) && !isOwnDoorKey(k, 'ffffffff'));
    check('B4 a node hex, an upstream c<n> and junk are not door keys', parseDoorKey('ab'.repeat(33)) === null && parseDoorKey('c7') === null && parseDoorKey('d:') === null && parseDoorKey('dabc') === null);
    const b = new SlidingBudget(2, 1000);
    check('B5 budget: two spends in a window, the third refused', b.ok(0) && (b.spend(0), b.ok(500)) && (b.spend(500), !b.ok(900)));
    check('B5b sliding: at t=1000 the first spend left the window, one is allowed, not two', b.ok(1000) && (b.spend(1000), !b.ok(1200)));
    const r = new RecentlyRetired(100);
    r.markIdentity('aa', 0); r.markConn('c7', 0);
    check('B6 both cooldown scopes hold inside the window', r.hasIdentity('aa', 50) && r.hasConn('c7', 50) && !r.hasIdentity('bb', 50));
    check('B6b and expire after it', !r.hasIdentity('aa', 150) && !r.hasConn('c7', 150));
  }

  // ── C. off is byte-identical ─────────────────────────────────────────
  if (kernelHasSurfaces) {
    const door = makeDoor();
    const { node } = await makeNode(ARMED_ENV, door);
    check('C1 without the flag the node is off: no reserved id, not consumed, no report', node.socketBootstrapOn() === false && node.reservedId === null && node.reservedIdFor({ kernelVersion: '9.0.0' }) === null && node.deliverDoorSignal('c1', { kind: 'sdp-offer' }) === false && node.fillStatus().socketBootstrap === null);
    const src = readFileSync(new URL('../src/ws_transport.js', import.meta.url), 'utf8');
    check('C2 the door transport is a bootstrap route and can supersede', node._transport.isBootstrap === true && typeof node._transport.supersedePeer === 'function' && /close-retained/.test(src));
    await node.stop();
  }

  // ── D. channel first, through the real node ──────────────────────────
  if (kernelHasSurfaces) {
    const door = makeDoor();
    const { node, mesh, webrtc } = await makeNode(ON_ENV, door);
    const rid = node.reservedId;
    check('D1 the reserved id goes only to an eligible kernel', node.reservedIdFor({ kernelVersion: '4.107.0' }) === rid && node.reservedIdFor({ kernelVersion: '4.106.0' }) === null && node.reservedIdFor({}) === null);
    const { consumed, key, st } = await newcomer(node, door, mesh, 'c7');
    check('D2 a signal to the reserved id is consumed into the mesh under the door key', consumed === true && st && st.role === 'responder' && st.attempt === 'A');
    const out = door.framesOf('c7');
    check('D3 the answer returns over THAT socket, from the reserved id, carrying the attempt', out.length === 1 && out[0].type === 'signal' && out[0].from === rid && out[0].payload.kind === 'sdp-answer' && out[0].payload.attempt === 'A');
    check('D4 the open channel is PROVISIONAL: not counted by the degree pass, counted as provisional', mesh.provisionalCount() === 1 && mesh.openNonProvisionalCount() === 0 && mesh.degreeStats().provisional === 1);
    check('D4b a signal without an attempt id on the door key is dropped', (node.deliverDoorSignal('c7', { kind: 'ice', candidate: {} }), mesh.attemptStats.missing === 1));
    const P = idOf(node, 1);
    webrtc.bindPeer(P, key);
    await tick();
    check('D5 the channel bind ran the policy and the kernel admitted ONE entry', node._node.synaptome.has(P) && node.doorChannelBound('c7') === true && node._composite.routeOf(P)?.sub === node._uplink.transport && node._sbStats.refused.gate === 0);
    check('D5b bound: no longer provisional, bind deadline cleared', mesh.provisionalCount() === 0 && mesh.openNonProvisionalCount() === 1 && st.bindTimer == null);
    const size = node._node.synaptome.size;
    await node._completeHandshake('c7', P);
    check('D6 the socket hello landing AFTER the channel bound admits nothing (born superseded)', node._node.synaptome.size === size && node._sbStats.bornSuperseded === 1 && node._composite.routeOf(P)?.sub === node._uplink.transport && node._transport.connIdFor(P) === 'c7');
    check('D6b routing to the identity goes to the mesh, not the door', node._composite._routeFor(P) === node._uplink.transport);
    door.open.delete('c7'); node.handleConnClosed('c7');
    check('D7 the socket close evicts nothing (its death was swallowed)', node._node.synaptome.has(P) && !node._node._deadPeers?.has?.(P) && node._composite.routeStats.deathSwallowed >= 1);
    mesh._retire(key, 'pc-closed'); await tick();
    check('D8 the channel death evicts the identity', !node._node.synaptome.has(P));
    // provisional bound: a third provisional above max 2 is retired; a stale one times out
    const a = await newcomer(node, door, mesh, 'c8', 'A8'); const b = await newcomer(node, door, mesh, 'c9', 'A9'); const c = await newcomer(node, door, mesh, 'ca', 'Aa');
    check('D9 the newest provisional above BRIDGE_PROVISIONAL_MAX is retired, the others kept', a.st && b.st && !mesh._peers.has(c.key) && mesh.degreeStats().provisionalRefused === 1);
    await sleep(120);
    check('D10 provisional channels still unbound after BRIDGE_BIND_DEADLINE_MS are retired', !mesh._peers.has(a.key) && !mesh._peers.has(b.key) && mesh.degreeStats().bindTimeouts === 2);
    await node.stop();
  }

  // ── E. hello first ───────────────────────────────────────────────────
  if (kernelHasSurfaces) {
    const door = makeDoor();
    const { node, mesh, webrtc } = await makeNode(ON_ENV, door);
    door.open.add('c7');
    const P = idOf(node, 2);
    await node._completeHandshake('c7', P);
    check('E1 the socket hello admits over the socket', node._node.synaptome.has(P) && node._composite.routeOf(P)?.sub === node._transport);
    const size = node._node.synaptome.size;
    const { key } = await newcomer(node, door, mesh, 'c7', 'B');
    webrtc.bindPeer(P, key); await tick();
    check('E2 the channel bind is a SWITCH: one entry, route now the mesh, the door superseded', node._node.synaptome.size === size && node._composite.routeOf(P)?.sub === node._uplink.transport && node._composite.routeStats.switched === 1 && node._composite._routeFor(P) === node._uplink.transport);
    check('E2b a route replacement ran no make-room and no bind policy refusal', node._sbStats.makeRoomRetires === 0 && Object.values(node._sbStats.refused).every((n) => n === 0));
    door.open.delete('c7'); node.handleConnClosed('c7');
    check('E3 the socket close is swallowed', node._node.synaptome.has(P));
    mesh._retire(key, 'pc-closed'); await tick();
    check('E4 the mesh death evicts', !node._node.synaptome.has(P));
    await node.stop();
  }

  // ── F. make room at bind ─────────────────────────────────────────────
  // Cap 8: the kernel's gate protects the kNear (5) closest and every sparse
  // band, so a swap exists only when more than five incumbents share a band.
  // The lane cooldown (5 s between lane admissions, a relay constant) is set
  // to 0 here so eight incumbents can be seated inside one fence run; the
  // make-room mechanics under test do not depend on it.
  if (kernelHasSurfaces) {
    const door = makeDoor();
    const F_ENV = { ...ON_ENV, BRIDGE_MESH_MAX_PEERS: '8' };
    const { node, mesh, webrtc } = await makeNode(F_ENV, door, 8);
    node._peer._gateCfg.laneCooldownMs = 0;
    const inc = [];
    for (let k = 0; k < 8; k++) {
      const cid = `c${k + 1}`; const { key } = await newcomer(node, door, mesh, cid, `I${k}`);
      const P = idOf(node, 10 + k); webrtc.bindPeer(P, key); await tick(); inc.push({ cid, key, P });
    }
    check('F1 eight incumbents admitted at cap 8, none retired', inc.every((i) => node._node.synaptome.has(i.P)) && mesh.openNonProvisionalCount() === 8 && node._sbStats.makeRoomRetires === 0, JSON.stringify(node._sbStats.refused));
    // a ninth newcomer from ANOTHER region (the gate's improve rule has a swap; the mesh selector a victim)
    const n9 = await newcomer(node, door, mesh, 'c9', 'N9'); const P9 = idOfRegion(node, 20);
    webrtc.bindPeer(P9, n9.key); await tick();
    const victims = inc.filter((i) => !mesh._peers.has(i.key));
    check('F2 the ninth bind retired exactly ONE incumbent and was admitted', victims.length === 1 && node._node.synaptome.has(P9) && mesh._peers.has(n9.key) && node._sbStats.makeRoomRetires === 1 && node.doorChannelBound('c9') && node._node.synaptome.size === 8, JSON.stringify({ victims: victims.map((v) => v.cid), refused: node._sbStats.refused, size: node._node.synaptome.size }));
    const victim = victims[0];
    check('F2b the victim is in both cooldown scopes and out of the table', node._sbRetired.hasIdentity(idToHex(victim.P)) && node._sbRetired.hasConn(victim.cid) && !node._node.synaptome.has(victim.P));
    // the victim re-dials on a FRESH socket: the offer is answered (pre-auth), the bind is refused by the identity cooldown
    const re = await newcomer(node, door, mesh, 'ca', 'R5');
    check('F3 the victim on a fresh connection spends one negotiation (offer answered)', re.st && door.framesOf('ca').length === 1);
    webrtc.bindPeer(victim.P, re.key); await tick(); await tick();
    check('F3b and is refused at bind by the identity cooldown; its own channel is closed, no incumbent touched', !node._node.synaptome.has(victim.P) && node._sbStats.refused.cooldown === 1 && !mesh._peers.has(re.key) && node._sbStats.makeRoomRetires === 1);
    // the victim's old connection is refused a new offer
    const again = node.deliverDoorSignal(victim.cid, { kind: 'sdp-offer', sdp: 'v=0', attempt: 'Z' });
    check('F3c the victim\'s retired connection id is refused a new negotiation to the reserved id', again === true && node._sbStats.offersRefusedCooldown === 1);
    // a newcomer at cap with the budget (1/min) spent → refused, its own channel closed, no incumbent retired
    const nb = await newcomer(node, door, mesh, 'cb', 'N6'); const Pb = idOfRegion(node, 21) ^ (1n << 100n);
    const before = [...mesh._peers.keys()].filter((k) => k !== nb.key).length;
    webrtc.bindPeer(Pb, nb.key); await tick(); await tick();
    check('F4 budget spent → the newcomer is refused, its channel closed, no incumbent retired', !node._node.synaptome.has(Pb) && node._sbStats.refused.budget === 1 && !mesh._peers.has(nb.key) && [...mesh._peers.keys()].length === before, JSON.stringify(node._sbStats.refused));
    // protected set: budget refilled, every incumbent protected → noVictim
    node._sbBudget = new SlidingBudget(10);
    mesh._degreeProtected = () => true;
    const nc = await newcomer(node, door, mesh, 'cc', 'N7'); const Pc = idOfRegion(node, 22) ^ (1n << 101n);
    webrtc.bindPeer(Pc, nc.key); await tick(); await tick();
    check('F5 every incumbent protected → refused (noVictim), newcomer channel closed, nothing retired', !node._node.synaptome.has(Pc) && node._sbStats.refused.noVictim === 1 && !mesh._peers.has(nc.key) && node._sbStats.makeRoomRetires === 1, JSON.stringify(node._sbStats.refused));
    mesh._degreeProtected = () => false;
    // gate-ineligible newcomer: same band as the incumbents (no admissible swap) → the kernel's gate refuses in preflight → no retire, no budget spent
    const spentBefore = node._sbBudget.spent;
    const nd = await newcomer(node, door, mesh, 'cd', 'N8'); const Pd = idOf(node, 30);
    webrtc.bindPeer(Pd, nd.key); await tick(); await tick();
    check('F6 a gate-ineligible newcomer is refused by the preflight BEFORE any retire: no incumbent lost, no budget spent', node._sbStats.refused.gate === 1 && !node._node.synaptome.has(Pd) && !mesh._peers.has(nd.key) && node._sbBudget.spent === spentBefore && node._sbStats.makeRoomRetires === 1, JSON.stringify(node._sbStats.refused));
    check('F7 the report carries the counters', (() => { const s = node.fillStatus().socketBootstrap; return s && s.on === true && s.makeRoomRetires === 1 && s.refused.cooldown === 1 && s.refused.budget === 1 && s.refused.noVictim === 1 && s.refused.gate === 1 && typeof s.routes?.switched === 'number'; })());
    await node.stop();
  }

  // ── G. statics ───────────────────────────────────────────────────────
  {
    const srv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const sig = srv.slice(srv.indexOf("case 'signal': {"), srv.indexOf("default:\n        logDebug('unknown-type'"));
    check('G1 the reserved-id branch sits BEFORE the connections.has(to) drop and requires an admitted connection', sig.indexOf('isReservedId') > 0 && sig.indexOf('isReservedId') < sig.indexOf('connections.has(to)') && /conn\.admitted && bridgeNode\.isReservedId/.test(sig));
    check('G2 both peer-lists put the reserved id first, only when reservedIdFor says so', (srv.match(/reservedIdFor\?\.\(conn\)/g) || []).length === 2 && /\[selfRid, \.\.\.admittedPeers\]/.test(srv) && /admittedPeers\.unshift\(selfRid\)/.test(srv));
    const ping = srv.slice(srv.indexOf("case 'ping': {"), srv.indexOf("case 'turn-refresh': {"));
    check('G3 the heartbeat with a fresh report calls the rule-4 close', /maybeCloseBootstrapSocket\(id\)/.test(ping));
    const mc = srv.slice(srv.indexOf('function maybeCloseBootstrapSocket('), srv.indexOf('// ── Embedded Axona peer'));
    check('G4 rule 4 closes only when the channel bound AND the report is fresh and ≥ the safe floor, with 4200', /doorChannelBound/.test(mc) && /freshMeshBound/.test(mc) && /GRADUATION_SAFE_FLOOR/.test(mc) && /CLOSE_GRADUATED/.test(mc));
    const bn = readFileSync(new URL('../src/bridge_axona_node.js', import.meta.url), 'utf8');
    const ch = bn.slice(bn.indexOf('async _completeHandshake('), bn.length);
    check('G5 _completeHandshake binds first, then skips admission for a born-superseded socket', ch.indexOf('this._transport.bindPeer(') < ch.indexOf('handshake-born-superseded') && ch.indexOf('handshake-born-superseded') < ch.indexOf('_addByVitality'));
    const bp = bn.slice(bn.indexOf('_bindPolicy(nodeId, sub, token) {'), bn.indexOf('deliverDoorSignal(connId, payload) {'));
    check('G6 the bind policy orders cooldown → gatePreflight → budget → dry-run victim → retire, and never touches an incumbent on refusal', bp.indexOf('hasIdentity') < bp.indexOf('gatePreflight') && bp.indexOf('gatePreflight') < bp.indexOf('_sbBudget.ok') && bp.indexOf('_sbBudget.ok') < bp.indexOf('dryRun: true') && bp.indexOf('dryRun: true') < bp.indexOf('mesh.retireForNewcomer(token);'));
  }

  console.log(`\nfence_socket_bootstrap: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
