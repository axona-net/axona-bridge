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
//   U6  egress classes: shape AND trusted local cause AND point; one allowed and one
//       forbidden case per class; genericTransit refused; invoked/returned/threw/asyncFailed;
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

console.log('\n[U6] egress classes: shape AND trusted local cause AND point (v0.9); one allowed and one forbidden case per class');
{
  const g = mk();
  const cls = (msg, meta, point) => g.classifyEgress(msg, meta, point);
  const own = (inner, topic = DIR, extra = {}) => ({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: SELF, targetId: OTHER, type: inner, payload: { topicId: topic }, ...extra } } });
  // controlBare: the closed list, each with its emitting transition
  ok('version-gate + connect → controlBare; without the cause → genericTransit', cls({ type: 'version-gate' }, { cause: 'connect' }) === 'controlBare' && cls({ type: 'version-gate' }) === 'genericTransit');
  ok('welcome / peer-list / turn + admission → controlBare', ['welcome', 'peer-list', 'turn'].every((type) => cls({ type }, { cause: 'admission' }) === 'controlBare'));
  ok('peer-list with NO cause → genericTransit (a received peer-list relabelled as admission)', cls({ type: 'peer-list' }) === 'genericTransit' && cls({ type: 'peer-list' }, { cause: 'kernel-notify' }) === 'genericTransit');
  ok('peer-joined + admission → controlBare; peer-joined + close → genericTransit', cls({ type: 'peer-joined' }, { cause: 'admission' }) === 'controlBare' && cls({ type: 'peer-joined' }, { cause: 'close' }) === 'genericTransit');
  ok('peer-left + close → controlBare; peer-left + admission → genericTransit', cls({ type: 'peer-left' }, { cause: 'close' }) === 'controlBare' && cls({ type: 'peer-left' }, { cause: 'admission' }) === 'genericTransit');
  ok('upstream-only bare frames at the UPLINK point with the socket cause → controlBare', ['client-hello', 'ping', 'peer-list-request', 'turn-refresh'].every((type) => cls({ type }, { cause: 'uplink-socket' }, 'uplink') === 'controlBare'));
  ok('the SAME frames toward a CLIENT → genericTransit (wrong destination)', ['client-hello', 'ping', 'peer-list-request', 'turn-refresh'].every((type) => cls({ type }, { cause: 'admission' }, 'client') === 'genericTransit'));
  ok('at the uplink point without the socket cause → genericTransit', cls({ type: 'ping' }, {}, 'uplink') === 'genericTransit');
  // controlReply
  ok('pong + reply → controlReply; pong without the cause → genericTransit', cls({ type: 'pong' }, { cause: 'reply' }) === 'controlReply' && cls({ type: 'pong' }) === 'genericTransit');
  ok('peer-list + reply + inReplyTo → controlReply', cls({ type: 'peer-list' }, { cause: 'reply', inReplyTo: 'peer-list-request' }) === 'controlReply');
  // signalRelay
  ok('signal + signal-relay → signalRelay; signal with no cause → genericTransit', cls({ type: 'signal', to: 'x', payload: {} }, { cause: 'signal-relay' }) === 'signalRelay' && cls({ type: 'signal', to: 'x', payload: {} }) === 'genericTransit');
  // hello
  ok('ntf hello + admission → hello; ntf hello + kernel-notify → genericTransit (only the admission emits it)', cls({ type: 'axona', payload: { k: 'ntf', type: 'hello', body: {} } }, { cause: 'admission' }) === 'hello' && cls({ type: 'axona', payload: { k: 'ntf', type: 'hello', body: {} } }, { cause: 'kernel-notify' }) === 'genericTransit');
  // linkMaintenance: kernel-originated only
  ok('ntf reinforce + kernel-notify → linkMaintenance', cls({ type: 'axona', payload: { k: 'ntf', type: 'reinforce', body: {} } }, { cause: 'kernel-notify' }) === 'linkMaintenance');
  ok('the SAME reinforce with no cause → genericTransit (a received frame cannot be relabelled as maintenance)', cls({ type: 'axona', payload: { k: 'ntf', type: 'reinforce', body: {} } }) === 'genericTransit');
  ok('presence + admission (wrong transition) → genericTransit', cls({ type: 'axona', payload: { k: 'ntf', type: 'presence', body: {} } }, { cause: 'admission' }) === 'genericTransit');
  ok('req ping + kernel-request → linkMaintenance; + reply → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'ping', body: {} } }, { cause: 'kernel-request' }) === 'linkMaintenance' && cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'ping', body: {} } }, { cause: 'reply' }) === 'genericTransit');
  // replies
  ok('res + kernel-reply + reqType lookahead_probe → discoveryReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: {} } }, { cause: 'kernel-reply', reqType: 'lookahead_probe' }) === 'discoveryReply');
  ok('res with no cause → genericTransit (a res the bridge did not produce)', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: {} } }, { reqType: 'lookahead_probe' }) === 'genericTransit');
  ok('res carrying transit-refused + kernel-reply → refusalReply; verdict refused:true too', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: false, body: { error: 'transit-refused' } } }, { cause: 'kernel-reply', reqType: 'route_msg' }) === 'refusalReply' && cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: { refused: true } } }, { cause: 'kernel-reply', reqType: 'route_msg' }) === 'refusalReply');
  ok('res to a dispatched route_msg + kernel-reply → controlReply', cls({ type: 'axona', payload: { k: 'res', id: 1, ok: true, body: { consumed: true } } }, { cause: 'kernel-reply', reqType: 'route_msg' }) === 'controlReply');
  // directory: own origin AND the kernel's own send
  ok('own-origin PUB to a directory topic + kernel-request → directoryOwnEntry', cls(own('pubsub:pub'), { cause: 'kernel-request' }) === 'directoryOwnEntry');
  ok('the SAME frame with no cause → genericTransit (originId is a frame-supplied claim)', cls(own('pubsub:pub')) === 'genericTransit');
  ok('own-origin PUB + kernel-request + republish → directoryRepublish', cls(own('pubsub:pub'), { cause: 'kernel-request', republish: true }) === 'directoryRepublish');
  ok('own-origin DELIVER for a directory topic + kernel-request → directoryServe', cls(own('pubsub:deliver'), { cause: 'kernel-request' }) === 'directoryServe');
  ok('direct_pubsub:deliver ntf for a directory topic + kernel-notify → directoryServe; for another topic → genericTransit', cls({ type: 'axona', payload: { k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: DIR } } }, { cause: 'kernel-notify' }) === 'directoryServe' && cls({ type: 'axona', payload: { k: 'ntf', type: 'direct_pubsub:deliver', body: { topicId: OTHER } } }, { cause: 'kernel-notify' }) === 'genericTransit');
  ok('route_msg with a FOREIGN originId + kernel-request → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'route_msg', body: { originId: OTHER, targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } } }, { cause: 'kernel-request' }) === 'genericTransit');
  ok('own-origin PUB to a NON-directory topic → genericTransit', cls(own('pubsub:pub', OTHER), { cause: 'kernel-request' }) === 'genericTransit');
  ok('__tunneled_direct__ + kernel-request → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: '__tunneled_direct__', body: {} } }, { cause: 'kernel-request' }) === 'genericTransit');
  ok('lookup_step req + kernel-request → discoveryRequest; without cause → genericTransit', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'lookup_step', body: {} } }, { cause: 'kernel-request' }) === 'discoveryRequest' && cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'lookup_step', body: {} } }) === 'genericTransit');
  ok('directory:sync req + kernel-request → directorySync', cls({ type: 'axona', payload: { k: 'req', id: 1, type: 'directory:sync', body: {} } }, { cause: 'kernel-request' }) === 'directorySync');
  ok('unknown bare type → genericTransit whatever the cause', cls({ type: 'whatever' }, { cause: 'admission' }) === 'genericTransit');
  // data channel: keepalive cause for bare ping/pong, kernel causes for envelopes
  ok('data channel: bare ping + keepalive → linkMaintenance; bare pong + keepalive → controlReply; ping without keepalive → genericTransit', g.classifyDataChannel({ type: 'ping' }, { cause: 'keepalive' }) === 'linkMaintenance' && g.classifyDataChannel({ type: 'pong' }, { cause: 'keepalive' }) === 'controlReply' && g.classifyDataChannel({ type: 'ping' }, {}) === 'genericTransit');
  ok('data channel: {k:ntf,type:reinforce} + kernel-notify → linkMaintenance; without cause → genericTransit', g.classifyDataChannel({ k: 'ntf', type: 'reinforce', body: {} }, { cause: 'kernel-notify' }) === 'linkMaintenance' && g.classifyDataChannel({ k: 'ntf', type: 'reinforce', body: {} }, {}) === 'genericTransit');
  // send-call observations
  const w1 = g.egressWrite('client', { type: 'axona', payload: { k: 'req', id: 1, type: '__tunneled_direct__', body: {} } }, { cause: 'kernel-request' });
  const w2 = g.egressWrite('uplink', { type: 'axona', payload: { k: 'req', id: 2, type: 'route_msg', body: { originId: OTHER, targetId: SELF, type: 'pubsub:sub', payload: { topicId: DIR } } } }, { cause: 'uplink-socket' });
  const w3 = g.egressWrite('client', { type: 'pong' }, { cause: 'reply' });
  ok('genericTransit is NOT allowed on either point, everything else is', !w1.allowed && !w2.allowed && w3.allowed);
  ok('refused ATTEMPTS counted per point', g.egressRefused.client === 1 && g.egressRefused.uplink === 1 && g.egress.client.attempts.genericTransit === 1 && g.egress.uplink.attempts.genericTransit === 1);
  g.egressInvoked('client', w3.cls); g.egressWritten('client', w3.cls);
  ok('pong: attempts 1, invoked 1, returned 1, threw 0', g.egress.client.attempts.controlReply === 1 && g.egress.client.invoked.controlReply === 1 && g.egress.client.returned.controlReply === 1 && g.egress.client.threw.controlReply === 0);
  g.egressInvoked('client', w3.cls); g.egressThrew('client', w3.cls); g.egressAsyncFailed('client', w3.cls);
  ok('a throwing or later-failing send is invoked but not returned', g.egress.client.invoked.controlReply === 2 && g.egress.client.returned.controlReply === 1 && g.egress.client.threw.controlReply === 1 && g.egress.client.asyncFailed.controlReply === 1);
  ok('genericTransit: attempts 2, INVOKED 0 — measured at the invocation site, not declared', g.snapshot().genericTransitAttempts === 2 && g.snapshot().forwardedGeneric === 0);
  g.egressInvoked('client', 'genericTransit');   // what a bypass would look like: the counter is live
  ok('…and the invoked counter is live: a forbidden invocation would show (test-only call)', g.snapshot().forwardedGeneric === 1 && g.drainLog()?.genericTransitINVOKED === 1);
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
  g.egressWrite('client', { type: 'whatever' }, { cause: 'admission' });
  const d = g.drainLog();
  ok('deltas: refusedUnlisted 1, oversizeLocal 1, genericTransitRefused 1', d && d.refusedUnlisted === 1 && d.oversizeLocal === 1 && d.genericTransitRefused === 1, JSON.stringify(d));
  ok('drained → null again', g.drainLog() === null);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
