// =====================================================================
// fence_adapter_neighbors_lookup.mjs — the bridge's pub/sub adapter carries
// `neighbors` and `lookup` (2.183.0; David 2026-11-09).
//
// The kernel guards three root mechanisms on these two functions and skips
// each one silently when the adapter lacks them. Without `neighbors`,
// selfClosestReachable compares nobody and _emitRootBeacons returns. Without
// `lookup`, _verifyRoots returns. On 2026-11-09 both production bridges held
// a root of axona:bridge-directory @ grizzly beside the relay root each of
// them had a socket to; east logged zero verify rows in 72 h.
//
// Checks:
//   N1  the adapter has neighbors() and lookup()
//   N2  unarmed bridge (the door reports no bound peers): a handshaken socket
//       peer is a neighbour
//   N3  a synaptome entry whose socket is no longer open is NOT a neighbour
//   N4  armed bridge: a bound socket peer with no synaptome entry is a neighbour
//   N5  neighbors() never lists the bridge itself
//   N6  no neighbour → meshBare() true → servingCapable() false past the role
//       grace; one neighbour → false / true (the kernel's alone-in-the-dark
//       guard now reads a real list on a bridge)
//   C1  selfClosestReachable is false for a topic a neighbour is closer to
//   C2  and true for a topic the bridge is closest to
//   B1  a root born on a bridge with a neighbour sends that neighbour a beacon
//   L1  lookup(non-bigint) → null
//   L2  lookup asks for K = 4 and returns { found, path, hops, time }, closest LAST
//   L3  an empty result and a throwing search both return found:false, path []
//   V1  the root self-verify launches on a bridge root, plants a verified
//       pointer at the closer node and sheds the claim (root-verify-demote)
//   V2  control: when the search visits nobody closer, the claim stands
//
// Mutants (each run, each restored):
//   M1  delete `neighbors` from the adapter → N1 N2 N3 N4 N5 N6 C1 B1 fail
//   M2  delete `lookup` from the adapter    → N1 L1 L2 L3 V1 V2 fail (V2: the
//       verify never stamps lastVerify)
//   M3  neighbors = the kernel adapter's body (bound peers, else the whole
//       synaptome) → N3 fails: a peer with no open channel is listed
//
// Offline: the node's sockets are fakes and the network search is stubbed, so
// this never touches a real mesh.
//
// Run: node test/fence_adapter_neighbors_lookup.mjs
// =====================================================================
import { BridgeAxonaNode } from '../src/bridge_axona_node.js';
import { ROOT_VERIFY_FIRST_MS } from '@axona/protocol/pubsub/constants.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString(16).slice(0, 10) : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => b.toString(16).padStart(66, '0');
const TOTAL = 14;
process.on('exit', (code) => { if (code === 0 && passed + failed < TOTAL) { console.log(`  ✗ exited after ${passed + failed} of ${TOTAL} checks`); process.exitCode = 1; } });

const TRIAD = { BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_ADMISSION_GATE: '1' };
// bridge_engine.js reads BRIDGE_NEVER_ROOT from process.env at construction.
process.env.BRIDGE_NEVER_ROOT = '0';
const mk = (open, env) => new BridgeAxonaNode({ sendToConn: () => true, isConnOpen: (c) => open.has(c), log: () => {}, env: { BRIDGE_NEVER_ROOT: '0', BRIDGE_NURSERY: '0', ...env } });
const quietTimers = (node) => { const p = node.peer; if (p?._maintainTimer) { clearInterval(p._maintainTimer); p._maintainTimer = null; } };

(async () => {
  console.log('fence_adapter_neighbors_lookup: the bridge adapter answers neighbors() and lookup()');

  // ── Unarmed bridge: the door reports no bound peers ───────────────────
  {
    const open = new Set();
    const node = mk(open, { BRIDGE_MAX_PEERS: '15', BRIDGE_MESH_MAX_PEERS: '0' });
    await node.start(); quietTimers(node);
    const am = node._axon, dht = am.dht, self = node.nodeId;
    check('N1 the adapter has neighbors() and lookup()', typeof dht.neighbors === 'function' && typeof dht.lookup === 'function',
      `neighbors=${typeof dht.neighbors} lookup=${typeof dht.lookup}`);
    const has = (fn) => typeof dht[fn] === 'function';
    const neigh = () => (has('neighbors') ? dht.neighbors() : null);

    am._joinedAt = 0;                                   // past the role grace
    const bare0 = am._rootClaim.meshBare(), serve0 = node._node.transport.servingCapable();

    const near = self ^ (1n << 200n), far = self ^ (1n << 250n);
    open.add('s1'); await node._completeHandshake('s1', near);
    open.add('s2'); await node._completeHandshake('s2', far);
    const n2 = neigh();
    check('N2 unarmed: handshaken socket peers are neighbours (the door itself has no boundPeers)',
      typeof node.transport.boundPeers === 'undefined' && Array.isArray(n2) && n2.includes(near) && n2.includes(far) && n2.every((x) => typeof x === 'bigint'), J(n2));
    check('N5 neighbors() never lists the bridge itself', Array.isArray(n2) && !n2.includes(self), J(n2));
    check('N6 no neighbour → meshBare, not serving; with neighbours → meshed and serving',
      bare0 === true && serve0 === false && am._rootClaim.meshBare() === false && node._node.transport.servingCapable() === true,
      `bare0=${bare0} serve0=${serve0} bare=${am._rootClaim.meshBare()} serve=${node._node.transport.servingCapable()}`);

    // C: the claim compares neighbours.
    const tNear = near ^ 1n;                            // `near` is 1 away; the bridge is 2^200 away
    const tSelf = self ^ 1n;                            // the bridge is 1 away
    check('C1 selfClosestReachable is false for a topic a neighbour is closer to', am._rootClaim.selfClosestReachable(tNear) === false);
    check('C2 and true for a topic the bridge is closest to', am._rootClaim.selfClosestReachable(tSelf) === true);

    // B: a root born here announces to its neighbours.
    const routed = [];
    dht.routeMessage = async (to, type, payload) => { routed.push({ to, type, payload }); return { consumed: true }; };
    const role = am._rootClaim.become(tSelf, 'sub-terminal');
    await sleep(10);
    const beacons = routed.filter((r) => r.type === 'pubsub:rootbeacon');
    check('B1 a root born on a bridge with neighbours sends them a beacon naming the topic',
      !!role?.isRoot && beacons.length >= 1 && beacons.every((b) => b.to === near || b.to === far) && beacons.some((b) => (b.payload?.topics || []).includes(hex(tSelf))),
      `root=${!!role?.isRoot} beacons=${beacons.length} types=${J([...new Set(routed.map((r) => r.type))])}`);

    // L: the lookup shape.
    const calls = [];
    const real = node.peer.findKClosest;
    node.peer.findKClosest = async (t, K) => { calls.push(K); return [near, self, far]; };   // ascending by distance to tNear
    const l1 = has('lookup') ? await dht.lookup('80e2') : 'absent';
    check('L1 lookup(non-bigint) → null', l1 === null, J(l1));
    const l2 = has('lookup') ? await dht.lookup(tNear) : null;
    check('L2 lookup asks for K = 4 and returns { found, path, hops, time } with the closest node LAST',
      !!l2 && calls[0] === 4 && l2.found === true && Array.isArray(l2.path) && l2.path.length === 3 && l2.path[2] === near && l2.path[0] === far && l2.hops === 2 && l2.time === 0, J({ l2, calls }));
    node.peer.findKClosest = async () => [];
    const l3a = has('lookup') ? await dht.lookup(tNear) : null;
    node.peer.findKClosest = async () => { throw new Error('search failed'); };
    const l3b = has('lookup') ? await dht.lookup(tNear) : null;
    check('L3 an empty result and a throwing search both return found:false with an empty path',
      !!l3a && !!l3b && l3a.found === false && l3a.path.length === 0 && l3b.found === false && l3b.path.length === 0, J({ l3a, l3b }));

    // V: the root self-verify.
    const logs = [];
    am.setLogSink((l, ev, ctx) => { logs.push({ ev: String(ev).replace('pubsub:', ''), ctx }); });
    // V2 control first: the search visits the bridge and a FARTHER node.
    node.peer.findKClosest = async () => [self, far];
    role.formedAt = Date.now() - ROOT_VERIFY_FIRST_MS - 1; role.lastVerify = 0;
    am._verifyRoots(Date.now());
    await sleep(30);
    check('V2 control: the search visits nobody closer → the claim stands, no demote row',
      am.axonRoles.get(tSelf)?.isRoot === true && role.lastVerify > 0 && !logs.some((l) => l.ev === 'root-verify-demote'), J(logs.map((l) => l.ev)));
    // V1: a root the bridge should not hold. tNear is closer to `near`.
    const spurious = am._rootClaim.become(tNear, 'reachable-fallback');
    node.peer.findKClosest = async () => [near, self, far];
    if (spurious) { spurious.formedAt = Date.now() - ROOT_VERIFY_FIRST_MS - 1; spurious.lastVerify = 0; }
    am._verifyRoots(Date.now());
    await sleep(30);
    const ptr = am._rootBeacons.get(tNear);
    const row = logs.find((l) => l.ev === 'root-verify-demote');
    check('V1 the verify launches on a bridge root, plants a verified pointer at the closer node and sheds the claim',
      !!spurious && am.axonRoles.get(tNear)?.isRoot === false && ptr?.verified === true && ptr?.root === hex(near) && row?.ctx?.to === hex(near).slice(0, 10),
      J({ born: !!spurious, isRoot: am.axonRoles.get(tNear)?.isRoot, ptr, row }));
    node.peer.findKClosest = real;

    // N3 last (it ends the socket): the entry stays in the synaptome, the channel does not.
    open.delete('s1');
    const n3 = neigh();
    check('N3 a synaptome entry whose socket is no longer open is NOT a neighbour',
      node._node.synaptome.has(near) && Array.isArray(n3) && !n3.includes(near) && n3.includes(far), J({ inSyn: node._node.synaptome.has(near), n3 }));
    await node.stop();
  }

  // ── Armed bridge: the door reports its bound sockets ──────────────────
  {
    const open = new Set();
    const node = mk(open, { ...TRIAD, BRIDGE_MESH_MAX_PEERS: '4', BRIDGE_MAX_PEERS: '15' });
    await node.start(); quietTimers(node);
    const dht = node._axon.dht, id = node.nodeId ^ (1n << 220n);
    open.add('a1'); node.transport.bindPeer(id, 'a1');   // bound at the door
    await sleep(10);
    node._node.synaptome.delete(id);                     // an armed door's bind admits the peer; take the table entry away
    const n4 = typeof dht.neighbors === 'function' ? dht.neighbors() : null;
    check('N4 armed: a bound socket peer with no synaptome entry is a neighbour',
      typeof node.transport.boundPeers === 'function' && !node._node.synaptome.has(id) && Array.isArray(n4) && n4.includes(id), J({ inSyn: node._node.synaptome.has(id), n4 }));
    await node.stop();
  }

  console.log(`\nfence_adapter_neighbors_lookup: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('fence_adapter_neighbors_lookup: threw', e); process.exit(1); });
