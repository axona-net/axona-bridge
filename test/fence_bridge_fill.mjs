#!/usr/bin/env node
// fence_bridge_fill.mjs — Bridge fill v0.8 (axona-docs 9b1ed08): the bridge
// half. A bridge is a node: armed, its embedded peer runs Hold-and-Fill Rule 2
// toward ONE explicit cap; unarmed, nothing about it moves.
//
//   A. RESOLVERS. legacyMeshCap is uplink.js's resolver verbatim (absent →
//      the door cap, '12x' → 12, '1.5' → 1, 0/negative/junk → off); strictCap
//      is digits-only + safe integer > 0 ('0050' → 50, overflow → null).
//   B. ARMING. All three unset → no options, cap null, legacy meshCap.
//      MAINTAIN without the guard and the gate → refuses with the relay's
//      words. The triad with an absent / 0 / '12x' / '1.5' / overflow cap →
//      refuses with the cap's words. The triad with '50' → the relay's
//      constants, cap 50, meshCap 50. Guard or gate alone → that option only,
//      nothing armed, legacy meshCap.
//   C. THE DOOR REPORTS ONLY WHEN ARMED. WebSocketTransport without
//      reportBound has no boundPeers and no onPeerBound (today's surface);
//      with it, boundPeers lists open bound sockets and bindPeer fires the
//      handler with (nodeId, connId, null).
//   D. THE NODE. Constructed and started unarmed: no maintain/guard/gate on
//      the peer, _maxSynaptome unset, the WS transport reports nothing,
//      fillStatus().armed false. Armed with cap 50: all three land,
//      _maxSynaptome 50, the transport reports, fillStatus() carries armed,
//      cap, meshCap and the four counters. Constructed with MAINTAIN alone:
//      throws at construction, nothing built.
//   E. ONE CAP into the uplink: meshDegreeFor(50) = {maxPeers: 50},
//      meshDegreeFor(0) = null; buildUplink takes `meshCap` and falls back to
//      the legacy expression only when it is undefined.
//   F. HEALTHZ. `fill: bridgeNode.fillStatus?.()` sits in the operator
//      branch only; the public body is untouched (smoke_healthz_exposure
//      keeps that fence).
//
// Mutants: make strictCap accept '1.5' → A, B fail; drop the cap refusal → B,
// D fail; always report bound → C, D fail; set _maxSynaptome unconditionally →
// D fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { legacyMeshCap, strictCap, resolveFillArming, assertArmingCoherent, BRIDGE_ARM_ENVS } from '../src/fill_arming.js';
import { WebSocketTransport } from '../src/ws_transport.js';
import { BridgeAxonaNode } from '../src/bridge_axona_node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString(16).slice(0, 8) : x));
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e && e.message)); } };
const TRIAD = { BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_ADMISSION_GATE: '1' };

(async () => {
  console.log('fence_bridge_fill: bridge fill v0.8 — two cap resolvers, the triad, the door reports only when armed, one cap');

  // ── A. resolvers ─────────────────────────────────────────────────────────
  {
    check('A1 legacy: absent variable inherits the door cap (code default 32)', legacyMeshCap({}) === 32);
    check('A2 legacy: absent variable inherits a custom door cap (15, both production bridges)', legacyMeshCap({ BRIDGE_MAX_PEERS: '15' }) === 15);
    check('A3 legacy: 0 is off (what production runs)', legacyMeshCap({ BRIDGE_MESH_MAX_PEERS: '0' }) === 0);
    check('A4 legacy: a negative is off', legacyMeshCap({ BRIDGE_MESH_MAX_PEERS: '-3' }) === 0);
    check('A5 legacy: \'12x\' parses to 12 and sets a cap (parseInt, as today)', legacyMeshCap({ BRIDGE_MESH_MAX_PEERS: '12x' }) === 12);
    check('A6 legacy: \'1.5\' parses to 1 and sets a cap (as today)', legacyMeshCap({ BRIDGE_MESH_MAX_PEERS: '1.5' }) === 1);
    check('A7 legacy: an unparseable string is off', legacyMeshCap({ BRIDGE_MESH_MAX_PEERS: 'abc' }) === 0);
    check('A8 strict: \'50\' → 50', strictCap('50') === 50);
    check('A9 strict: \'0050\' → 50 (the predicate decides; no leading-zero rule)', strictCap('0050') === 50);
    check('A10 strict: absent, \'0\', \'-3\', \'1.5\', \'12x\', \'\' → null', [undefined, '0', '-3', '1.5', '12x', ''].every(v => strictCap(v) === null));
    check('A11 strict: a digit string whose conversion is not a safe integer → null (\'9007199254740993\' converts to 2^53)', strictCap('9007199254740993') === null && strictCap('9007199254740991') === 9007199254740991);
  }

  // ── B. arming ────────────────────────────────────────────────────────────
  {
    const off = resolveFillArming({ BRIDGE_MAX_PEERS: '15', BRIDGE_MESH_MAX_PEERS: '0' });
    check('B1 all three unset: not armed, no options, cap null, meshCap = legacy (0 here, production\'s row)', off.armed === false && Object.keys(off.options).length === 0 && off.cap === null && off.meshCap === 0 && off.armedEnvs.length === 0);
    const offAbsent = resolveFillArming({ BRIDGE_MAX_PEERS: '15' });
    check('B2 unarmed with the variable absent: meshCap inherits the door cap 15, cap null', offAbsent.meshCap === 15 && offAbsent.cap === null && offAbsent.armed === false);
    check('B3 MAINTAIN alone refuses with the relay\'s words', throwsWith(() => resolveFillArming({ BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_MESH_MAX_PEERS: '50' }), /arming refused: BRIDGE_SYNAPTOME_MAINTAIN=1 set without BRIDGE_ATTEMPT_GUARD and BRIDGE_ADMISSION_GATE/));
    check('B3b MAINTAIN with the guard but no gate refuses naming the gate', throwsWith(() => resolveFillArming({ BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_MESH_MAX_PEERS: '50' }), /without BRIDGE_ADMISSION_GATE/));
    check('B3c assertArmingCoherent is the same refusal, exported', throwsWith(() => assertArmingCoherent(['BRIDGE_SYNAPTOME_MAINTAIN']), /arming refused/) && assertArmingCoherent(BRIDGE_ARM_ENVS) === undefined);
    const capRe = /arming refused: the fill triad is set but BRIDGE_MESH_MAX_PEERS is/;
    check('B4 the triad with the cap ABSENT refuses with the cap\'s words (not the legacy inheritance)', throwsWith(() => resolveFillArming({ ...TRIAD, BRIDGE_MAX_PEERS: '15' }), capRe));
    check('B5 the triad with cap 0 refuses', throwsWith(() => resolveFillArming({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: '0' }), capRe));
    check('B6 the triad with \'12x\', \'1.5\', a negative and an overflow refuses each', ['12x', '1.5', '-3', '9007199254740993'].every(v => throwsWith(() => resolveFillArming({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: v }), capRe)));
    const on = resolveFillArming({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: '50', BRIDGE_MAX_PEERS: '15' });
    check('B7 the triad with \'50\': armed, cap 50, meshCap 50 (not the door\'s 15), all three envs listed', on.armed === true && on.cap === 50 && on.meshCap === 50 && on.armedEnvs.length === 3);
    check('B8 the options are the relay launcher\'s constants', on.options.synaptomeMaintain?.kNear === 5 && on.options.synaptomeMaintain?.intervalMs === 15000 && on.options.synaptomeMaintain?.maxPerTick === 3
      && on.options.admissionGate?.kNear === 5 && on.options.admissionGate?.sparseFloor === 2 && on.options.admissionGate?.kJoin === 2 && on.options.admissionGate?.laneCooldownMs === 5000 && on.options.admissionGate?.laneWindowMs === 300000
      && on.options.attemptGuard?.maxAttempts === 4 && on.options.attemptGuard?.baseMs === 30000 && on.options.attemptGuard?.factor === 2 && on.options.attemptGuard?.refillWindowMs === 60000 && on.options.attemptGuard?.deficitBaseMs === 30000 && on.options.attemptGuard?.deficitFactor === 2, JSON.stringify(on.options));
    const on0050 = resolveFillArming({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: '0050' });
    check('B9 \'0050\' arms with 50', on0050.armed && on0050.cap === 50 && on0050.meshCap === 50);
    const guardOnly = resolveFillArming({ BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_MAX_PEERS: '15' });
    check('B10 the guard alone: that option only, NOT armed, cap null, legacy meshCap', !!guardOnly.options.attemptGuard && !guardOnly.options.synaptomeMaintain && guardOnly.armed === false && guardOnly.cap === null && guardOnly.meshCap === 15);
  }

  // ── C. the door reports only when armed ─────────────────────────────────
  {
    const open = new Set(['c1', 'c2']);
    const mk = (reportBound) => new WebSocketTransport({ localNodeId: 1n, sendToConn: () => true, isConnOpen: (c) => open.has(c), log: () => {}, reportBound });
    const quiet = mk(false);
    check('C1 without reportBound: NO boundPeers and NO onPeerBound (today\'s exact surface)', typeof quiet.boundPeers === 'undefined' && typeof quiet.onPeerBound === 'undefined');
    quiet.bindPeer(11n, 'c1');
    check('C1b binding on the quiet transport fires nothing and still binds', quiet.connIdFor(11n) === 'c1');
    const loud = mk(true);
    const got = []; const unsub = loud.onPeerBound((id, meshId, inc) => got.push([id, meshId, inc]));
    loud.bindPeer(21n, 'c1'); loud.bindPeer(22n, 'c2'); loud.bindPeer(23n, 'c3');   // c3 is not open
    check('C2 with reportBound: bindPeer fires the handler with (nodeId, connId, null)', got.length === 3 && got[0][0] === 21n && got[0][1] === 'c1' && got[0][2] === null);
    check('C3 boundPeers lists the bound identities whose socket is OPEN only', JSON.stringify(loud.boundPeers().map(String).sort()) === JSON.stringify(['21', '22']));
    unsub(); loud.bindPeer(24n, 'c2');
    check('C4 unsubscribe detaches', got.length === 3);
  }

  // ── D. the node ──────────────────────────────────────────────────────────
  {
    const mkNode = (env) => new BridgeAxonaNode({ sendToConn: () => true, isConnOpen: () => true, log: () => {}, env });
    // D1 unarmed
    const unarmed = mkNode({ BRIDGE_MAX_PEERS: '15', BRIDGE_MESH_MAX_PEERS: '0' });
    await unarmed.start();
    const up = unarmed.peer;
    check('D1 unarmed: the peer has no maintain, no gate, no guard; _maxSynaptome unset; the WS transport reports nothing',
      !up._maintainCfg && !up._gateCfg && !up._attemptGuard && unarmed._node._maxSynaptome === undefined && typeof unarmed.transport.boundPeers === 'undefined' && typeof unarmed.transport.onPeerBound === 'undefined');
    const fs0 = unarmed.fillStatus();
    check('D1b unarmed fillStatus: armed false, cap null, meshCap 0 (legacy), state null, counters present with admitted 0', fs0.armed === false && fs0.cap === null && fs0.meshCap === 0 && fs0.state === null && fs0.counters.admitted === 0 && fs0.counters.meshOpen === null && fs0.counters.pendingAllocations === null, JSON.stringify(fs0));
    check('D1c unarmed: the kernel\'s fill is not armed on the peer', up._fillArmed() === false);
    await unarmed.stop();

    // D2 armed with 50
    const armed = mkNode({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: '50', BRIDGE_MAX_PEERS: '15' });
    await armed.start();
    const ap = armed.peer;
    check('D2 armed: maintain, gate and guard all landed on the peer; the kernel\'s fill is armed', !!ap._maintainCfg && !!ap._gateCfg && !!ap._attemptGuard && ap._fillArmed() === true);
    check('D2b armed: node._maxSynaptome is 50 — the fill target is the typed cap, not the engine\'s 256', armed._node._maxSynaptome === 50 && armed._engine.MAX_SYNAPTOME === 256);
    check('D2c armed: the WS transport reports (boundPeers and onPeerBound present)', typeof armed.transport.boundPeers === 'function' && typeof armed.transport.onPeerBound === 'function');
    const fs1 = armed.fillStatus();
    check('D2d armed fillStatus: armed true, cap 50, meshCap 50, envs ×3, four counters (admitted 0, boundSockets 0, meshOpen null without an uplink, pending null)',
      fs1.armed === true && fs1.cap === 50 && fs1.meshCap === 50 && fs1.envs.length === 3 && fs1.counters.admitted === 0 && fs1.counters.boundSockets === 0 && fs1.counters.meshOpen === null && fs1.counters.pendingAllocations === null, JSON.stringify(fs1));
    // The kernel reads the cap: availability with an empty synaptome is 50.
    check('D2e the kernel\'s fill availability reads the cap: 50 with an empty table', ap._fillAvailability() === 50, String(ap._fillAvailability()));
    if (ap._maintainTimer) { clearInterval(ap._maintainTimer); ap._maintainTimer = null; }
    await armed.stop();

    // D3 MAINTAIN alone: refuses at construction
    check('D3 MAINTAIN alone refuses AT CONSTRUCTION (nothing built)', throwsWith(() => mkNode({ BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_MESH_MAX_PEERS: '50' }), /arming refused: BRIDGE_SYNAPTOME_MAINTAIN=1 set without/));
    check('D4 the triad with no cap refuses AT CONSTRUCTION', throwsWith(() => mkNode({ ...TRIAD }), /the fill triad is set but BRIDGE_MESH_MAX_PEERS is absent/));
  }

  // ── G. the refusal path on a real bridge + kernel: RETAINED binding ─────
  // Vega 5ca291ea / 761ed13b, Aster BF-CODE-1: when armed, bindPeer fires the
  // kernel's bind handler; the gate may refuse and call closeConnection on the
  // door. Before this fence the door unbound without closing — an orphan
  // socket, handshake-complete, in no map. Now the binding is RETAINED: the
  // peer stays bound, out of the table, reachable, and RECONCILE re-offers it.
  {
    const open = new Set();
    const mkNode = (env) => new BridgeAxonaNode({ sendToConn: () => true, isConnOpen: (c) => open.has(c), log: () => {}, env });
    // cap 4 with the relay's kJoin 2: two ordinary slots, then the join lane
    // (one lane admission per 5 s cooldown), so five fast handshakes end with
    // AT MOST four admitted and at least one refused.
    const node = mkNode({ ...TRIAD, BRIDGE_MESH_MAX_PEERS: '4', BRIDGE_MAX_PEERS: '15' });
    await node.start();
    const peer = node.peer; if (peer._maintainTimer) { clearInterval(peer._maintainTimer); peer._maintainTimer = null; }
    const ids = [];
    for (let i = 1; i <= 5; i++) { const c = `g${i}`; open.add(c); const id = (node.nodeId ^ (1n << BigInt(40 + i))); ids.push([c, id]); await node._completeHandshake(c, id); }
    const syn = node._node.synaptome;
    const admitted = ids.filter(([, id]) => syn.has(id)).length;
    const refused  = ids.filter(([, id]) => !syn.has(id));
    check('G1 five fast handshakes on a bridge armed at cap 4: at most 4 admitted, at least 1 refused', admitted <= 4 && refused.length >= 1, `admitted=${admitted} refused=${refused.length} syn=${syn.size}`);
    check('G2 EVERY refused peer is still bound at the door (connIdFor, isConnected, in boundPeers): no orphan', refused.every(([c, id]) => node.transport.connIdFor(id) === c && node.transport.isConnected(id) && node.transport.boundPeers().includes(id)), J(refused.map(([c]) => c)));
    check('G3 and its handshake stays complete (a second hello is a no-op, not an orphan)', refused.every(([c]) => node._helloByConnId.get(c) === 'complete'));
    const before = peer._reconcileLast;
    peer._reconcileBound();
    const rl = peer._reconcileLast;
    check('G4 RECONCILE sees the retained identities as bound and offers them again (bound = 5 sockets, offered ≥ refused)', rl.bound === 5 && rl.offered >= refused.length, J(rl));
    check('G5 reconcile dialled nothing: the composite\'s open is bound-only and the door never dials', typeof node.transport.connectViaRelay === 'undefined');
    // Free room BELOW the operational table (cap 4 − kJoin 2 = 2): the gate's
    // join lane is time-paced (one lane admission per 5 s) and the fence is
    // not, so the retained peers must re-enter through the ordinary path.
    for (const [, id] of ids.filter(([, id]) => syn.has(id)).slice(0, 3)) syn.delete(id);
    check('G6a setup: table at 1, below cap − kJoin', syn.size === 1);
    peer._reconcileBound();
    const rl2 = peer._reconcileLast;
    check('G6 with room, a reconcile admits retained peers with zero dials (admitted ≥ 1) and the table does not exceed the cap', rl2.admitted >= 1 && syn.size <= 4 && syn.size > 1, J(rl2) + ` syn=${syn.size}`);
    // The kernel's own close on a socket peer: retained too (the eviction path at AxonaPeer.js:5352 goes through the same method).
    const [c0, id0] = ids[0];
    await node.transport.closeConnection(id0);
    check('G7 a direct closeConnection on the armed door keeps the binding (retained) and never closes the socket', node.transport.connIdFor(id0) === c0 && open.has(c0));
    // G10 the socket actually closes: the bridge's conn-closed feed unbinds, the peer leaves boundPeers, and the kernel drops it.
    const [c1, id1] = ids.find(([, id]) => syn.has(id)) ?? ids[0];
    open.delete(c1); node.handleConnClosed(c1); await new Promise(r => setTimeout(r, 20));
    check('G10 physical close (handleConnClosed): unbound at the door, out of boundPeers, out of the synaptome, handshake state cleared',
      node.transport.connIdFor(id1) === null && !node.transport.boundPeers().includes(id1) && !syn.has(id1) && node._helloByConnId.get(c1) === undefined, `conn=${node.transport.connIdFor(id1)} syn=${syn.has(id1)}`);
    await node.stop();

    // Unarmed: the door does not report, and a close unbinds as it always has.
    const quiet = mkNode({ BRIDGE_MAX_PEERS: '15', BRIDGE_MESH_MAX_PEERS: '0' });
    await quiet.start();
    open.add('q1'); const qid = quiet.nodeId ^ (1n << 50n);
    await quiet._completeHandshake('q1', qid);
    check('G8 unarmed: the handshake admits through the bridge\'s own path as before (synaptome has the peer; the door has no boundPeers)', quiet._node.synaptome.has(qid) && typeof quiet.transport.boundPeers === 'undefined');
    await quiet.transport.closeConnection(qid);
    check('G9 unarmed: closeConnection unbinds, exactly today\'s behaviour', quiet.transport.connIdFor(qid) === null);
    await quiet.stop();
  }

  // ── H. DIAL through the one dialer (needs the composite-dialer kernel) ──
  // Runs only against a kernel whose CompositeTransport names a dialer
  // (axona-protocol composite-dialer / 4.106.0+); on 4.105.0 it is reported
  // as skipped, not passed.
  {
    const open = new Set();
    const node = new BridgeAxonaNode({ sendToConn: () => true, isConnOpen: (c) => open.has(c), log: () => {}, env: { ...TRIAD, BRIDGE_MESH_MAX_PEERS: '6', BRIDGE_MAX_PEERS: '15' } });
    await node.start();
    const peer = node.peer; if (peer._maintainTimer) { clearInterval(peer._maintainTimer); peer._maintainTimer = null; }
    const kv = JSON.parse(readFileSync(join(HERE, '..', 'node_modules', '@axona', 'protocol', 'package.json'), 'utf8')).version ?? '0.0.0';   // the installed kernel, as check_kernel_pin reads it
    const [kM, km] = String(kv).split('.').map(Number);
    const expectsDialer = kM > 4 || (kM === 4 && km >= 106);   // 4.106.0 carries composite-dialer
    if (typeof node._composite.dialer !== 'function') {
      if (expectsDialer) check(`H0 the pinned kernel ${kv} is expected to carry the composite dialer and does not`, false);
      else console.log(`  · H skipped: the pinned kernel ${kv} predates the composite dialer (4.106.0); on that pin the kernel's own fence covers the dial path`);
    } else {
      check(`H0 the pinned kernel ${kv} carries the composite dialer`, true);
      // A stub uplink: the dialer. It owns nothing, dials on request, binds when told.
      const { Transport } = await import('@axona/protocol/contracts/Transport.js');
      const { depositDispatchCapability } = await import('@axona/protocol/registry/index.js');
      class StubUplink extends Transport {
        constructor() { super(); this.relay = []; this.bound = new Set(); this.boundHandlers = []; depositDispatchCapability(this, { request: () => {}, notification: () => {} }); }
        async start() {} async stop() {} getLocalNodeId() { return 0n; }
        async openConnection(id) { return this.bound.has(id); } async closeConnection() {}
        isConnected(id) { return this.bound.has(id); }
        async send() { throw new Error('stub'); } async notify() {}
        onPeerDied() { return () => {}; } getLatency() { return 20; }
        boundPeers() { return [...this.bound]; }
        onPeerBound(h) { this.boundHandlers.push(h); return () => {}; }
        connectViaRelay(hex) { this.relay.push(hex); const inc = 'inc-' + this.relay.length; (this.incByHex ??= new Map()).set(hex, inc); return inc; }
        mayDial() { return true; }
        // The bind carries the incarnation THIS peer's dial returned (R8-2: the
        // kernel rejects a bind on any other incarnation as stale).
        bind(id) { this.bound.add(id); const hex = id.toString(16).padStart(66, '0'); const inc = this.incByHex?.get(hex) ?? null; for (const h of this.boundHandlers) h(id, 'm' + hex.slice(-4), inc); }
      }
      const up = new StubUplink(); node._composite.addSubtransport(up);
      check('H1 the stub uplink is the bridge composite\'s one dialer', node._composite.dialer() === up && typeof node._composite.connectViaRelay === 'function');
      // Two socket peers at the door, admitted on handshake.
      for (let i = 1; i <= 2; i++) { const c = `h${i}`; open.add(c); await node._completeHandshake(c, node.nodeId ^ (1n << BigInt(60 + i))); }
      const syn = node._node.synaptome;
      const sockets0 = node.transport.boundPeers().length;
      check('H2 two sockets admitted with zero dials (sockets 2, admitted 2, relay 0)', sockets0 === 2 && syn.size === 2 && up.relay.length === 0);
      // Nominate four strangers and tick: the deficit (6 − 2) is closed by DIAL through the dialer only.
      const strangers = [1, 2, 3, 4].map(k => node.nodeId ^ (1n << BigInt(70 + k)));
      for (const s of strangers) peer._nominateCandidate(s, 'fence');
      peer._deficitBackoff?.reset?.();
      await peer._maintainSynaptome();
      const fs = node.fillStatus();
      check('H3 the tick dialled through the dialer (relay > 0, each a nominated stranger), sockets unchanged, nothing admitted yet', up.relay.length > 0 && up.relay.length <= 3 && node.transport.boundPeers().length === 2 && syn.size === 2, `relay=${up.relay.length} syn=${syn.size} state=${fs.state}`);
      // Binds arrive: admitted rises by one per bind; sockets never change.
      const dialled = strangers.filter(s => up.relay.some(h => BigInt('0x' + h) === s));
      // A bind on a STALE incarnation first: rejected, nothing admitted (R8-2 through the real composite).
      const first = dialled[0]; const synBefore = syn.size;
      for (const h of up.boundHandlers) h(first, 'mstale', 'inc-stale');
      check('H4a a bind carrying a stale incarnation is rejected: admitted unchanged', syn.size === synBefore);
      for (const s of dialled) up.bind(s);
      check('H4 each bind with its own incarnation raises admitted by one; sockets stay 2', syn.size === 2 + dialled.length && node.transport.boundPeers().length === 2, `syn=${syn.size} dialled=${dialled.length}`);
      const fs2 = node.fillStatus();
      check('H5 fillStatus reports the four counters apart: admitted, boundSockets 2, meshOpen null (stub has no degree stats), pending null', fs2.counters.admitted === syn.size && fs2.counters.boundSockets === 2 && fs2.counters.meshOpen === null && fs2.counters.pendingAllocations === null, J(fs2.counters));
    }
    await node.stop();
  }

  // ── E. one cap into the uplink ───────────────────────────────────────────
  {
    const { meshDegreeFor } = await import('../src/uplink.js');
    check('E1 meshDegreeFor(50) = {maxPeers: 50}; meshDegreeFor(0) and NaN = null', meshDegreeFor(50)?.maxPeers === 50 && meshDegreeFor(0) === null && meshDegreeFor(NaN) === null);
    const src = readFileSync(join(HERE, '..', 'src', 'uplink.js'), 'utf8');
    check('E2 buildUplink takes `meshCap` and computes the legacy expression only when it is undefined', /meshCap = undefined \}\)/.test(src) && /if \(meshCap === undefined\) meshCap = Number\.parseInt\(env\.BRIDGE_MESH_MAX_PEERS \?\? String\(wsCap\), 10\);/.test(src) && /meshDegree: meshDegreeFor\(meshCap\),/.test(src));
    const node = readFileSync(join(HERE, '..', 'src', 'bridge_axona_node.js'), 'utf8');
    check('E3 startUplink passes the ONE resolved cap (this._arming.meshCap) to buildUplink', /meshCap: this\._arming\.meshCap/.test(node));
    check('E4 the node sets _maxSynaptome from the same resolution, only when armed', /if \(this\._arming\.armed\) this\._node\._maxSynaptome = this\._arming\.cap;/.test(node));
    check('E5 the WS transport\'s reportBound is the arming', /reportBound: this\._arming\.armed/.test(node));
  }

  // ── F. healthz ───────────────────────────────────────────────────────────
  {
    const server = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');
    const pub = server.indexOf("body = JSON.stringify({ status: publicStatus, version: VERSION, kernelVersion: KERNEL_VERSION })");
    const fill = server.indexOf('fill: bridgeNode.fillStatus?.() ?? null,');
    const elseIdx = server.indexOf('} else {', pub);
    check('F1 the public body is unchanged and `fill` appears only after the operator branch begins', pub > 0 && fill > elseIdx && elseIdx > pub);
    check('F2 /diag carries the same report', (server.match(/fill: bridgeNode\.fillStatus\?\.\(\) \?\? null,/g) || []).length === 2);
  }

  console.log(`\nfence_bridge_fill: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
