// =====================================================================
// smoke-pubsub-relay.js — regression guard for the bridge's pub/sub
//                         relay role.
//
// THE FAILURE MODE THIS GUARDS
// ---------------------------------------------------------------------
// The bridge is a relay: it never calls peer.sub / peer.pub itself.
// The kernel builds a node's AxonaManager LAZILY, on the first
// sub/pub.  So unless the bridge eagerly constructs its AxonaManager at
// startup, the AM is never built, the pub/sub wire handlers (registered
// from the AM constructor via wireHandlers._registerHandlers) are never
// installed, and every pub/sub frame routed to the bridge falls through
// to `_deliverRouted`'s "no handler → forward" path.  On a bridge that
// is the routing terminus, "forward" means the frame dies there.
//
// This exact regression shipped in commit 8a54a6e (I4) and went
// unnoticed for several releases because nothing asserted it: the
// bridge started fine, relayed signaling + lookups fine, and only
// pub/sub fan-out was a black hole.  bridge v2.1.0 restored the eager
// build; this test fails loudly if it's ever dropped again.
//
// WHY THIS TEST WAS REWRITTEN (2026-07-31)
// ---------------------------------------------------------------------
// The original version asserted four hard-coded handler names
//   'pubsub:subscribe-k' / 'publish-k' / 'deliver' / 'unsubscribe-k'
// against `peer._directHandlers`.  Both halves went stale:
//
//   · the NAMES — the wire vocabulary is 'pubsub:sub' / 'pubsub:pub' /
//     'pubsub:unsub' / 'pubsub:deliver' (pubsub/constants.js, `T`);
//   · the TABLE — pub/sub handlers are ROUTED handlers
//     (`peer._routedHandlers`, registered via onRoutedMessage).
//     `_directHandlers` is empty on a bridge; nothing in the kernel
//     calls onDirectMessage any more.
//
// So those four checks were red on every kernel we could find, whether
// or not the bug they guard was present — which made the guard's exit
// code useless: CI could not tell a healthy bridge from a black-holing
// one.  A guard stuck red is a guard switched off.
//
// The fix is two-fold, and deliberately avoids re-creating that trap:
//
//   1. The vocabulary check now imports `T` from the kernel's own
//      constants instead of hard-coding strings, so it tracks any
//      future rename automatically and can never drift again.
//   2. It no longer trusts the handler table as a PROXY for working
//      relay behaviour — it drives real routed SUB / UNSUB / PUB frames
//      at the bridge and asserts a live handler consumed them.  That is
//      the actual black-hole question, asked directly.
//
// ORDERING TRAP — DO NOT REORDER THE CHECKS
// ---------------------------------------------------------------------
// BridgeEngine.axonFor() (and its axonaManagerFor alias, and
// node.getAdmission() which calls it) CONSTRUCTS the AxonaManager on
// demand and caches it.  Any of those calls therefore *repairs* the
// very regression we are testing for, and a probe run after one would
// pass on a bridge that had lost its eager build.  The behavioural
// probe must run FIRST, against the untouched post-start() state.
// Reading the plain `node._axon` field is safe — it builds nothing.
//
// In-process (no subprocess) so it can introspect the peer directly.
//
// Run:  node scripts/smoke-pubsub-relay.js
// =====================================================================

import { T } from '@axona/protocol/pubsub/constants.js';
import { BridgeAxonaNode } from '../src/bridge_axona_node.js';

let passed = 0, failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); failed++; }
}

// Well-formed synthetic ids.  A node id is ALWAYS 66 hex chars, and the
// kernel drops malformed ones before a handler ever sees them, so a
// sloppy id here would look exactly like a black hole.  The topic's
// leading byte is the bridge's own us-east region prefix (0x89) so the
// region gate can't be what decides the outcome.
const SUBSCRIBER = 'aa' + '11'.repeat(32);
const TOPIC_HEX  = '89' + 'cd'.repeat(32);
const TOPIC_BIG  = BigInt('0x' + TOPIC_HEX);

async function main() {
  console.log('bridge pub/sub-relay regression guard\n');

  const node = new BridgeAxonaNode({
    sendToConn: () => true,
    isConnOpen: () => true,
    log: () => {},
  });
  await node.start();

  // ── 1. Eager build (plain field read — constructs nothing) ────────
  check('AxonaManager built eagerly at startup (node._axon set)',
    !!node._axon);

  // ── 2. Behavioural: are real pub/sub frames actually consumed? ────
  //
  // This is the guard proper.  routeMessage() is the call the bridge's
  // own `route_msg` request handler makes for every pub/sub frame that
  // arrives off a browser's WebSocket, so this is the production
  // ingress path one level below the wire decode.
  //
  // The bridge has an empty synaptome here, so it is the routing
  // terminus for everything: a frame is either consumed by a live
  // handler ({consumed:true}) or it dies at this node
  // ({consumed:false, terminal:true}) — which is precisely the
  // black hole.  Verified both ways on 2026-07-31: with the eager
  // build removed, all three of these flip to false.
  const probe = async (label, type, payload) => {
    const r = await node._peer.routeMessage(TOPIC_BIG, type, payload,
      { fromId: SUBSCRIBER });
    check(`routed ${type} consumed by a live handler`, r.consumed === true,
      r.consumed === false ? 'frame died at the bridge — pub/sub is a black hole' : '');
  };

  await probe('SUB',   T.SUB,   { topicId: TOPIC_HEX, subscriberId: SUBSCRIBER, since: 0 });
  await probe('UNSUB', T.UNSUB, { topicId: TOPIC_HEX, subscriberId: SUBSCRIBER });
  await probe('PUB',   T.PUB,   { topicId: TOPIC_HEX, msgId: 'smoke-1',
                                 body: 'smoke', publisherId: SUBSCRIBER });

  // ── 3. Did the SUB reach the pub/sub plane, or merely vanish quietly? ──
  //
  // `consumed` proves a handler ran; this proves WHICH plane it reached.
  // The bridge is hard-fenced from taking roles (neverRoot), so a SUB
  // that genuinely arrives at the axonic layer must be DECIDED on — the
  // admission gate refuses it and bumps refusals.bridge.  A bridge that
  // silently swallowed the frame leaves that counter at zero.
  //
  // NB: getAdmission() lazily builds the AM, so this must stay AFTER the
  // probe above (see ORDERING TRAP in the header).  In the regressed
  // case it builds a fresh AM whose counters are all zero — so the
  // assertion still fails, which is the outcome we want.
  const refusedBridge = node.getAdmission()?.refusals?.bridge ?? 0;
  check('SUB reached the axonic admission gate (refusals.bridge > 0)',
    refusedBridge > 0, `refusals.bridge = ${refusedBridge}`);

  // ── 4. Vocabulary: every kernel pub/sub wire type has a handler ────
  //
  // Names come from the kernel's own `T` — never hard-code them here
  // again (that is what rotted the previous version of this test).
  // Handlers live in the ROUTED table; `_directHandlers` is unused by
  // pub/sub.
  const routed  = node._peer?._routedHandlers;
  check('peer exposes a routed-handler table',
    !!routed && typeof routed.has === 'function');

  // RESERVED wire types the kernel deliberately does NOT register a
  // handler for.  Today that is only UNPUB: the sender and handler were
  // removed in kernel v4.3.0 and the string is retained purely so a
  // legacy frame is IGNORED rather than misrouted onto a live type.
  //
  // The exclusion is asserted, not assumed — if the kernel ever gives
  // one of these a handler again, the second check below fails and
  // tells us to move it into the live set, instead of the exclusion
  // quietly hiding a type nobody is testing.
  const RESERVED = new Set([T.UNPUB]);
  const live = Object.values(T).filter(type => !RESERVED.has(type));

  const missing = live.filter(type => routed?.has?.(type) !== true);
  check(`all ${live.length} live kernel pub/sub wire types have a routed handler`,
    missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');

  const resurrected = [...RESERVED].filter(type => routed?.has?.(type) === true);
  check('reserved wire types are still unregistered',
    resurrected.length === 0,
    resurrected.length ? `now handled — move out of RESERVED: ${resurrected.join(', ')}` : '');

  // ── 5. One manager: incoming frames dispatch into the SAME AM that
  //       holds the roles.  (Lazily builds — must stay last.)
  const viaEngine = node._engine?.axonaManagerFor?.(node._node);
  check('engine resolves the same AxonaManager instance',
    viaEngine && viaEngine === node._axon);

  await node.stop?.();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('smoke-pubsub-relay threw:', err);
  process.exit(2);
});
