// =====================================================================
// smoke-pubsub-relay.js — regression guard for the bridge's pub/sub
//                         relay role.
//
// The bridge is a relay: it never calls peer.sub / peer.pub itself.
// The kernel builds a node's AxonaManager LAZILY, on the first
// sub/pub.  So unless the bridge eagerly constructs its AxonaManager
// at startup, the AM is never built and the pubsub:subscribe-k /
// publish-k / deliver direct-message handlers (registered in the
// AxonaManager constructor) are never installed — every pub/sub frame
// addressed to the bridge is silently dropped.
//
// This exact regression shipped in commit 8a54a6e (I4) and went
// unnoticed for several releases because nothing asserted it: the
// bridge started fine, relayed signaling + lookups fine, and only
// pub/sub fan-out was a black hole.  bridge v2.1.0 restored the eager
// build; this test fails loudly if it's ever dropped again.
//
// In-process (no subprocess) so it can introspect the peer's direct
// handler table directly.
//
// Run:  node scripts/smoke-pubsub-relay.js
// =====================================================================

import { BridgeAxonaNode } from '../src/bridge_axona_node.js';

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

async function main() {
  console.log('bridge pub/sub-relay regression guard\n');

  const node = new BridgeAxonaNode({
    sendToConn: () => true,
    isConnOpen: () => true,
    log: () => {},
  });
  await node.start();

  check('AxonaManager built eagerly at startup (node._axon set)',
    !!node._axon);

  const dh = node._peer?._directHandlers;
  check('peer exposes a direct-handler table', !!dh && typeof dh.has === 'function');

  for (const type of ['pubsub:subscribe-k', 'pubsub:publish-k',
                      'pubsub:deliver', 'pubsub:unsubscribe-k']) {
    check(`relay handler registered: ${type}`, dh?.has?.(type) === true);
  }

  // The AM should also be the one the engine resolves for this node,
  // so incoming frames dispatch into the SAME manager that holds roles.
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
