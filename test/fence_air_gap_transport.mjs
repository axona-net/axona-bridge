// =====================================================================
// fence_air_gap_transport.mjs — Bridge-Air-Gap-Plan v0.3 §7.1.2 / v0.5 §7.1.2 on
// the bridge's server-side WebSocketTransport, no network.
//
//   T1  capability: unbound → 'unknown'; bound + open → 'introduction'; a closed
//       socket → 'unknown' (fails closed); NEVER 'transport', whatever the caller.
//   T2  rebind (Aster 66db253a): bind → unbind → bind again on a NEW connection
//       moves the generation and keeps the capability 'introduction'; the old
//       connection's generation is gone; a pin taken before the rebind is stale.
//   T3  the partition runs BEFORE any handler: a refused request never reaches
//       its handler; a dropped notification never reaches its handler; exactly one
//       reply per refused request; none for a dropped notification; none to an
//       unadmitted socket.
//   T4  reqType rides to the write hook so the egress classifier can tell a
//       discovery reply from a control reply.
//   T5  handleConnClosed releases the air-gap slot and unbinds.
//   T6  the role matrix is a constructor property of the manager, untouched by
//       bind/unbind/rebind on the transport (no re-enabled role acquisition).
// Author tests are not acceptance (Vega's challenge + Aster CP review follow).
// =====================================================================
import { WebSocketTransport } from '../src/ws_transport.js';
import { AirGap } from '../src/air_gap.js';
import { AxonaManager } from '@axona/protocol/pubsub/AxonaManager.js';
import { depositDispatchCapability } from '@axona/protocol/registry/index.js';

let passed = 0, failed = 0;
const ok = (label, c, extra = '') => { const b = !!c; console.log(`  ${b ? '✓' : '✗'} ${label}${b ? '' : ' ' + extra}`); b ? passed++ : failed++; };

const SELF = (0xffn << 248n) | 0x1n;
const A = (0x89n << 248n) | 0x1000n;
const hex = (b) => b.toString(16).padStart(66, '0');
const DIR = '89'.padEnd(66, '1');

function build() {
  const open = new Set();
  const writes = [];
  const airGap = new AirGap({ selfId: SELF, isDirectoryTopic: (h) => h === DIR });
  const t = new WebSocketTransport({
    localNodeId: SELF,
    sendToConn: (connId, msg, meta) => { writes.push({ connId, msg, meta }); return true; },
    isConnOpen: (connId) => open.has(connId),
    log: () => {},
    airGap,
  });
  return { t, open, writes, airGap };
}

console.log('[T1] capability');
{
  const { t, open } = build();
  ok('unbound → unknown', t.capabilityFor(A) === 'unknown');
  open.add('c1'); t.bindPeer(A, 'c1');
  ok('bound + open → introduction', t.capabilityFor(A) === 'introduction');
  open.delete('c1');
  ok('bound but socket closed → unknown (fails closed)', t.capabilityFor(A) === 'unknown');
  ok('ownsPeer / boundPeers reflect the binding', t.ownsPeer(A) && t.boundPeers().includes(A));
}

console.log('\n[T2] rebind moves the generation, keeps the class');
{
  const { t, open } = build();
  open.add('c1'); t.bindPeer(A, 'c1');
  const g1 = t.generationFor(A);
  ok('first bind: generation > 0', g1 > 0, String(g1));
  t.unbindPeer('c1'); open.delete('c1');
  ok('after unbind: unknown, generation 0', t.capabilityFor(A) === 'unknown' && t.generationFor(A) === 0);
  open.add('c2'); t.bindPeer(A, 'c2');
  const g2 = t.generationFor(A);
  ok('rebind on a new connection: introduction again, generation moved', t.capabilityFor(A) === 'introduction' && g2 > g1, `${g1} → ${g2}`);
  ok('the old connection no longer resolves the node', t.nodeIdFor('c1') === null && t.connIdFor(A) === 'c2');
  ok('a pin taken before the rebind is stale (g1 ≠ current)', g1 !== t.generationFor(A));
}

console.log('\n[T3] partition before handler');
{
  const { t, open, writes } = build();
  await t.start();
  open.add('c1'); t.bindPeer(A, 'c1');
  let reqCalls = 0, ntfCalls = 0;
  t.onRequest('lookahead_probe', async () => { reqCalls++; return { peerId: SELF, terminal: true }; });
  t.onRequest('route_msg', async () => { reqCalls++; return { consumed: true }; });
  t.onNotification('direct_pubsub:deliver', () => { ntfCalls++; });
  t.onNotification('reinforce', () => { ntfCalls++; });
  const o1 = t.handleIncoming('c1', { k: 'req', id: 1, type: 'lookahead_probe', body: {} }, { admitted: true });
  await new Promise((r) => setTimeout(r, 5));
  ok('listed request dispatched to its handler, one reply', o1 === 'dispatchedLocal' && reqCalls === 1 && writes.length === 1 && writes[0].msg.payload.k === 'res');
  const o2 = t.handleIncoming('c1', { k: 'req', id: 2, type: 'route_msg', body: { targetId: hex(A), type: 'pubsub:sub', payload: { topicId: DIR }, hops: 1 } }, { admitted: true });
  await new Promise((r) => setTimeout(r, 5));
  ok('route_msg to another node: refusedTransit, handler NOT called, exactly one reply carrying the verdict',
    o2 === 'refusedTransit' && reqCalls === 1 && writes.length === 2 && writes[1].msg.payload.body.refused === true && writes[1].msg.payload.body.hops === 1, JSON.stringify(writes[1]?.msg));
  const o3 = t.handleIncoming('c1', { k: 'ntf', type: 'direct_pubsub:deliver', body: {} }, { admitted: true });
  ok('direct_* notification: droppedDirect, handler NOT called, no reply', o3 === 'droppedDirect' && ntfCalls === 0 && writes.length === 2);
  const o4 = t.handleIncoming('c1', { k: 'ntf', type: 'reinforce', body: {} }, { admitted: true });
  ok('listed notification dispatched, no reply', o4 === 'dispatchedLocal' && ntfCalls === 1 && writes.length === 2);
  const o5 = t.handleIncoming('c9', { k: 'req', id: 3, type: 'lookahead_probe', body: {} }, { admitted: false });
  ok('unadmitted socket: refusedRate and NO reply', o5 === 'refusedRate' && writes.length === 2 && reqCalls === 1);
  const o6 = t.handleIncoming('c1', { k: 'res', id: 77, ok: true, body: {} }, { admitted: true });
  ok('unsolicited response: droppedUnsolicited, no reply', o6 === 'droppedUnsolicited' && writes.length === 2);
  const o7 = t.handleIncoming('c1', 'garbage', { admitted: true });
  ok('non-object payload: droppedInvalid', o7 === 'droppedInvalid');
}

console.log('\n[T4] reqType rides to the write hook');
{
  const { t, open, writes } = build();
  await t.start();
  open.add('c1'); t.bindPeer(A, 'c1');
  t.onRequest('find_closest_set', async () => []);
  t.handleIncoming('c1', { k: 'req', id: 5, type: 'find_closest_set', body: { target: hex(A) } }, { admitted: true });
  await new Promise((r) => setTimeout(r, 5));
  ok('meta.reqType = find_closest_set on the res write', writes.length === 1 && writes[0].meta?.reqType === 'find_closest_set', JSON.stringify(writes[0]?.meta));
  const { airGap } = build();
  ok('…which the classifier reads as discoveryReply', airGap.classifyEgress(writes[0].msg, writes[0].meta) === 'discoveryReply');
}

console.log('\n[T5] close releases the slot');
{
  const { t, open, airGap } = build();
  open.add('c1'); t.bindPeer(A, 'c1');
  t.handleIncoming('c1', { k: 'ntf', type: 'nope', body: {} }, { admitted: true });
  ok('slot in use after a frame', airGap.trackedCount === 1);
  t.handleConnClosed('c1');
  ok('released and unbound on close', airGap.trackedCount === 0 && t.capabilityFor(A) === 'unknown' && !t.ownsPeer(A));
}

console.log('\n[T6] the role matrix does not move with the transport');
{
  const routed = new Map();
  const dht = {
    verdictsSupported: true, routeMessage: async () => ({ consumed: false }), getSelfId: () => hex(SELF),
    onRoutedMessage: (type, h) => routed.set(type, h), onDirectMessage() {},
    neighbors: () => [], bridgeId: () => null, isTransit: () => false, isIntroduction: () => true, introductionIds: () => [A],
  };
  depositDispatchCapability(dht, { routed: (type, h) => dht.onRoutedMessage(type, h) });
  const allow = new Set([DIR]);
  const mgr = new AxonaManager({ dht, introductionOnly: true, rootAllowList: allow });
  mgr._log = () => {};
  const other = '80'.padEnd(66, '2');
  const dirBig = BigInt('0x' + DIR), otherBig = BigInt('0x' + other);
  const before = { dirRoot: mgr.canAcceptRole(dirBig, 'root').hard !== true, otherRoot: mgr.canAcceptRole(otherBig, 'root').hard === true, backup: mgr.admitPushedRole(dirBig, 'backup') === false };
  const { t, open } = build();
  open.add('c1'); t.bindPeer(A, 'c1'); t.unbindPeer('c1'); open.add('c2'); t.bindPeer(A, 'c2');
  const after = { dirRoot: mgr.canAcceptRole(dirBig, 'root').hard !== true, otherRoot: mgr.canAcceptRole(otherBig, 'root').hard === true, backup: mgr.admitPushedRole(dirBig, 'backup') === false };
  ok('before rebind: directory root allowed, other root HARD refused, pushed backup refused', before.dirRoot && before.otherRoot && before.backup, JSON.stringify(before));
  ok('after rebind: identical', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
  allow.add(other);
  ok('the live allow-list admits a copy learned later (D3), still root only', mgr.canAcceptRole(otherBig, 'root').hard !== true && mgr.admitPushedRole(otherBig, 'child') === false);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
