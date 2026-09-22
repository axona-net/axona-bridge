// =====================================================================
// fence_air_gap_unit.mjs — Bridge-Air-Gap-Plan §7.2 (v0.4 §7.2.1–7.2.3, v0.5
// §7.2.4/§7.2.6, v0.6 §7.2.2/O6), the AirGap module in isolation.
//
// Pins, against src/air_gap.js with an injected clock:
//   U1  one outcome per frame: the partition's buckets sum to messages delivered
//       to the decoder, decode failures INCLUDED (v0.6 denominator);
//   U2  precedence: unlisted before rate, direct before unlisted for ntf,
//       transit before nested before schema for route_msg;
//   U3  route_msg gate: own id / directory topic / five verbs / named topic;
//   U4  bounds: a listed type over its bucket is refusedRate (req) or
//       droppedRate (ntf/bare); pre-admission bound is zero except client-hello;
//   U5  slots: past the tracked cap a connection shares the overflow slot; hits counted per frame;
//   U6  egress classes: every row of the §7.2.6 table plus the two additions,
//       genericTransit is refused (allowed:false) and counted;
//   U7  transport labels stay OUTSIDE the partition;
//   U8  drainLog: deltas only, null when quiet, positives never logged.
// Author tests are not acceptance (Vega's challenge + Aster CP review follow).
// =====================================================================
import { AirGap, INGRESS_OUTCOMES, EGRESS_CLASSES, MAX_PAYLOAD_BYTES, TRACKED_SLOTS, typeKey } from '../src/air_gap.js';

let passed = 0, failed = 0;
const ok = (label, c, extra = '') => { const b = !!c; console.log(`  ${b ? '✓' : '✗'} ${label}${b ? '' : ' ' + extra}`); b ? passed++ : failed++; };

const SELF = 'ff'.padEnd(66, '0');
const DIR  = '89'.padEnd(66, '1');          // a named directory topic id
const OTHER = '80'.padEnd(66, '2');
let t = 1_000_000;
const now = () => t;
const mk = () => new AirGap({ selfId: SELF, isDirectoryTopic: (h) => h === DIR, now, trackedSlots: 4 });
const decoded = (g) => INGRESS_OUTCOMES.reduce((n, o) => n + g.ingress[o], 0);
const A = { admitted: true, hasPending: () => false };

console.log('[U1] partition sums to messages delivered to the decoder');
{
  const g = mk();
  g.invalid('c1');                                                        // decode failure
  g.bare('c1', { type: 'ping' }, { admitted: true });                     // dispatchedLocal
  g.axona('c1', { k: 'req', id: 1, type: 'nonsense', body: {} }, A);      // refusedUnlisted
  g.axona('c1', { k: 'ntf', type: 'direct_pubsub:deliver', body: {} }, A);// droppedDirect
  g.axona('c1', { k: 'res', id: 9, ok: true, body: {} }, A);              // droppedUnsolicited
  ok('five frames → five outcomes, decode failure inside the partition', decoded(g) === 5, String(decoded(g)));
  ok('droppedInvalid counted', g.ingress.droppedInvalid === 1);
  ok('snapshot.decoded equals the sum', g.snapshot().ingress.decoded === 5);
  ok('transitAttempted = refusedTransit + refusedNested + droppedDirect', g.snapshot().ingress.transitAttempted === 1);
}

console.log('\n[U2] precedence');
{
  const g = mk();
  const r1 = g.axona('c1', { k: 'ntf', type: 'axona:direct', body: {} }, A);
  ok('ntf axona:direct → droppedDirect (before unlisted)', r1.outcome === 'droppedDirect');
  const r2 = g.axona('c1', { k: 'ntf', type: 'mesh:signal', body: {} }, A);
  ok('ntf mesh:signal → droppedDirect', r2.outcome === 'droppedDirect');
  const r3 = g.axona('c1', { k: 'req', id: 2, type: '__tunneled_direct__', body: { targetId: SELF } }, A);
  ok('req __tunneled_direct__ → refusedUnlisted, with a transit-refused reply', r3.outcome === 'refusedUnlisted' && r3.reply?.error === 'transit-refused');
  const r4 = g.axona('c1', { k: 'req', id: 3, type: 'route_msg', body: { targetId: OTHER, type: 'route_msg', payload: {} } }, A);
  ok('route_msg to another node → refusedTransit even when nested', r4.outcome === 'refusedTransit');
  ok('route_msg refusal reply is the verdict shape', r4.reply?.consumed === false && r4.reply?.terminal === true && r4.reply?.refused === true && r4.reply?.outcome === 'refusedTransit');
  const r5 = g.axona('c1', { k: 'req', id: 4, type: 'route_msg', body: { targetId: SELF, type: 'route_msg', payload: { topicId: DIR } } }, A);
  ok('self-addressed but nested route_msg → refusedNested', r5.outcome === 'refusedNested');
  const r6 = g.axona('c1', { k: 'req', id: 5, type: 'route_msg', body: { targetId: SELF, type: 'pubsub:sub', payload: {} } }, A);
  ok('self-addressed, listed verb, no topic → refusedSchema', r6.outcome === 'refusedSchema');
  const r7 = g.axona('c1', { k: 'ntf', type: 'nope', body: {} }, A);
  ok('unlisted ntf → droppedUnlisted, no reply', r7.outcome === 'droppedUnlisted' && r7.reply === null);
}

console.log('\n[U3] route_msg gate');
{
  const g = mk();
  ok('to self, pubsub:sub, directory topic → dispatch', g.routeMsgOutcome({ targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } }) === null);
  ok('to the directory topic id itself → dispatch', g.routeMsgOutcome({ targetId: DIR, type: 'pubsub:pull', payload: { topicId: DIR } }) === null);
  ok('to self, pubsub:pub, directory topic → dispatch (signer check is WP3)', g.routeMsgOutcome({ targetId: SELF, type: 'pubsub:pub', payload: { topicId: DIR } }) === null);
  ok('to self, listed verb, NON-directory topic → refusedNested', g.routeMsgOutcome({ targetId: SELF, type: 'pubsub:sub', payload: { topicId: OTHER } }) === 'refusedNested');
  ok('to self, pubsub:deliver (not one of five) → refusedNested', g.routeMsgOutcome({ targetId: SELF, type: 'pubsub:deliver', payload: { topicId: DIR } }) === 'refusedNested');
  ok('to another node → refusedTransit', g.routeMsgOutcome({ targetId: OTHER, type: 'pubsub:sub', payload: { topicId: DIR } }) === 'refusedTransit');
  ok('bigint targetId accepted', g.routeMsgOutcome({ targetId: BigInt('0x' + SELF), type: 'pubsub:unsub', payload: { topicId: DIR } }) === null);
  ok('malformed targetId → refusedSchema', g.routeMsgOutcome({ targetId: 'zz', type: 'pubsub:sub', payload: { topicId: DIR } }) === 'refusedSchema');
  const g2 = new AirGap({ isDirectoryTopic: (h) => h === DIR, now });
  ok('no self id set → self-addressed cannot match, directory still can', g2.routeMsgOutcome({ targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } }) === 'refusedTransit' && g2.routeMsgOutcome({ targetId: DIR, type: 'pubsub:sub', payload: { topicId: DIR } }) === null);
}

console.log('\n[U4] bounds');
{
  const g = mk();
  let refused = 0;
  for (let i = 0; i < 70; i++) if (g.axona('c1', { k: 'req', id: i, type: 'route_msg', body: { targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } }, A).outcome === 'refusedRate') refused++;
  ok('route_msg burst 60 then refusedRate', refused === 10, String(refused));
  t += 1000;                                                              // 20/s refill
  const after = g.axona('c1', { k: 'req', id: 99, type: 'route_msg', body: { targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } }, A).outcome;
  ok('one second later the bucket has refilled', after === 'dispatchedLocal', after);
  let dropped = 0;
  for (let i = 0; i < 6; i++) if (g.bare('c1', { type: 'ping' }, { admitted: true }) === 'refusedRate') dropped++;
  ok('bare ping burst 5 then refusedRate (request-like)', dropped === 1, String(dropped));
  ok('second client-hello on an admitted socket → droppedRate', g.bare('c1', { type: 'client-hello' }, { admitted: true }) === 'droppedRate');
  ok('pre-admission ping → droppedRate (bound is zero)', g.bare('c2', { type: 'ping' }, { admitted: false }) === 'droppedRate');
  ok('pre-admission client-hello → dispatchedLocal', g.bare('c2', { type: 'client-hello' }, { admitted: false }) === 'dispatchedLocal');
  ok('unsolicited pong → droppedUnsolicited', g.bare('c1', { type: 'pong' }, { admitted: true }) === 'droppedUnsolicited');
  ok('second hello-ack → droppedRate', g.axona('c1', { k: 'ntf', type: 'hello-ack', body: {} }, A).outcome === 'dispatchedLocal' && g.axona('c1', { k: 'ntf', type: 'hello-ack', body: {} }, A).outcome === 'droppedRate');
  ok('pre-admission req → refusedRate', g.axona('c3', { k: 'req', id: 1, type: 'ping', body: {} }, { admitted: false, hasPending: () => false }).outcome === 'refusedRate');
  ok('by-type row exists for the refused type', g.snapshot().ingressByType.refusedRate?.route_msg === 10);
  ok('typeKey folds direct_* and unknowns', typeKey('direct_x') === 'direct_*' && typeKey('whatever') === 'other' && typeKey('route_msg') === 'route_msg');
}

console.log('\n[U5] tracked slots + overflow');
{
  const g = mk();                                                        // trackedSlots: 4
  for (const c of ['a', 'b', 'c', 'd', 'e', 'f']) g.bare(c, { type: 'ping' }, { admitted: true });
  ok('four tracked, two frames through the overflow slot', g.trackedCount === 4 && g.overflowHits === 2, `${g.trackedCount}/${g.overflowHits}`);
  for (let i = 0; i < 5; i++) g.bare('e', { type: 'ping' }, { admitted: true });
  ok('overflow slot bounds are shared (coarser, still bounded)', g.bare('f', { type: 'ping' }, { admitted: true }) === 'refusedRate');
  ok('overflow hits count frames, not connections', g.overflowHits === 8, String(g.overflowHits));
  g.releaseSlot('a');
  g.bare('g', { type: 'ping' }, { admitted: true });
  ok('a released slot is reusable', g.trackedCount === 4 && g.overflowHits === 8);
  ok('TRACKED_SLOTS default is 256, MAX_PAYLOAD_BYTES is 16 KiB (D5)', TRACKED_SLOTS === 256 && MAX_PAYLOAD_BYTES === 16384);
}

console.log('\n[U6] egress classes');
{
  const g = mk();
  const cls = (msg, meta) => g.classifyEgress(msg, meta);
  ok('version-gate/welcome/peer-joined/peer-left → controlBare', ['version-gate', 'welcome', 'peer-joined', 'peer-left'].every((type) => cls({ type }) === 'controlBare'));
  ok('pong → controlReply', cls({ type: 'pong' }) === 'controlReply');
  ok('peer-list on admission → controlBare; in reply → controlReply', cls({ type: 'peer-list' }) === 'controlBare' && cls({ type: 'peer-list' }, { inReplyTo: 'peer-list-request' }) === 'controlReply');
  ok('signal → signalRelay', cls({ type: 'signal', to: 'x', payload: {} }) === 'signalRelay');
  ok('ntf hello → hello', cls({ type: 'axona', payload: { k: 'ntf', type: 'hello', body: {} } }) === 'hello');
  ok('ntf reinforce → linkMaintenance', cls({ type: 'axona', payload: { k: 'ntf', type: 'reinforce', body: {} } }) === 'linkMaintenance');
  ok('res to lookahead_probe → discoveryReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: {} } }, { reqType: 'lookahead_probe' }) === 'discoveryReply');
  ok('res carrying transit-refused → refusalReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: false, body: { error: 'transit-refused' } } }, { reqType: 'route_msg' }) === 'refusalReply');
  ok('res verdict refused:true → refusalReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: { refused: true } } }, { reqType: 'route_msg' }) === 'refusalReply');
  ok('res to a dispatched route_msg → controlReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: { consumed: true } } }, { reqType: 'route_msg' }) === 'controlReply');
  ok('own-origin route_msg PUB to a directory topic → directoryOwnEntry', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: SELF, targetId: OTHER, type: 'pubsub:pub', payload: { topicId: DIR } } } }) === 'directoryOwnEntry');
  ok('same, republish meta → directoryRepublish', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: SELF, targetId: OTHER, type: 'pubsub:pub', payload: { topicId: DIR } } } }, { republish: true }) === 'directoryRepublish');
  ok('own-origin route_msg DELIVER for a directory topic → directoryServe', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: SELF, targetId: OTHER, type: 'pubsub:deliver', payload: { topicId: DIR } } } }) === 'directoryServe');
  ok('direct_pubsub:deliver ntf for a directory topic → directoryServe', cls({ type: 'axona', payload: { k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: DIR } } }) === 'directoryServe');
  ok('direct_pubsub:deliver ntf for another topic → genericTransit', cls({ type: 'axona', payload: { k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: OTHER } } }) === 'genericTransit');
  ok('route_msg with a FOREIGN originId → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: OTHER, targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } } }) === 'genericTransit');
  ok('own-origin route_msg PUB to a NON-directory topic → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: SELF, targetId: OTHER, type: 'pubsub:pub', payload: { topicId: OTHER } } } }) === 'genericTransit');
  ok('__tunneled_direct__ → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: '__tunneled_direct__', body: {} } }) === 'genericTransit');
  ok('lookup_step req → discoveryRequest', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'lookup_step', body: {} } }) === 'discoveryRequest');
  ok('directory:sync req → directorySync', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'directory:sync', body: {} } }) === 'directorySync');
  ok('uplink-side client frames → controlBare', ['client-hello', 'ping', 'peer-list-request', 'turn-refresh'].every((type) => cls({ type }) === 'controlBare'));
  ok('unknown bare type → genericTransit', cls({ type: 'whatever' }) === 'genericTransit');
  const w1 = g.egressWrite('client', { type: 'axona', payload: { k: 'req', id: 1, type: '__tunneled_direct__', body: {} } });
  const w2 = g.egressWrite('uplink', { type: 'axona', payload: { k: 'req', id: 2, type: 'route_msg', body: { originId: OTHER, targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } } });
  const w3 = g.egressWrite('client', { type: 'pong' });
  ok('genericTransit is NOT allowed on either point, everything else is', !w1.allowed && !w2.allowed && w3.allowed);
  ok('refused writes counted per point', g.egressRefused.client === 1 && g.egressRefused.uplink === 1 && g.egress.client.genericTransit === 1 && g.egress.uplink.genericTransit === 1);
  ok('snapshot.forwardedGeneric reports attempts (never writes)', g.snapshot().forwardedGeneric === 2);
  ok('every class name is in EGRESS_CLASSES', EGRESS_CLASSES.includes('genericTransit') && EGRESS_CLASSES.includes('controlBare') && EGRESS_CLASSES.includes('linkMaintenance') && EGRESS_CLASSES.length === 13);
}

console.log('\n[U7] transport labels outside the partition');
{
  const g = mk();
  g.oversizeLocal('c1'); g.close1009('c1'); g.close1009('c2');
  ok('oversizeLocal=1, close1009=2', g.transport.oversizeLocal === 1 && g.transport.close1009 === 2);
  ok('partition untouched', decoded(g) === 0);
}

console.log('\n[U8] drainLog');
{
  const g = mk();
  ok('quiet → null', g.drainLog() === null);
  g.bare('c1', { type: 'ping' }, { admitted: true });
  ok('positives alone → still null', g.drainLog() === null);
  g.axona('c1', { k: 'req', id: 1, type: 'nope', body: {} }, A);
  g.oversizeLocal('c1');
  g.egressWrite('client', { type: 'whatever' });
  const d = g.drainLog();
  ok('deltas: refusedUnlisted 1, oversizeLocal 1, genericTransitRefused 1', d && d.refusedUnlisted === 1 && d.oversizeLocal === 1 && d.genericTransitRefused === 1, JSON.stringify(d));
  ok('drained → null again', g.drainLog() === null);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
