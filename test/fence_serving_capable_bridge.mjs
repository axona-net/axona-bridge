// =====================================================================
// fence_serving_capable_bridge.mjs — R4 of Routed-Walk-Terminals v0.6
// (axona-docs 88d6871), the bridge's half.
//
// The kernel asks transport.servingCapable() before it lets a node be a
// routing terminal or birth a root. The bridge's node answers: seated AND not
// neverRoot. Both production bridges run BRIDGE_NEVER_ROOT=0 and hold roles,
// so for them the answer is "seated"; a bridge on the default (neverRoot) must
// answer false, because a kernel without this predicate would take its
// exception branch and treat the bridge as capable — the one case where that
// branch gives the wrong answer.
//
// Checks:
//   1  the composite exposes servingCapable() after start()
//   2  BRIDGE_NEVER_ROOT=0, not yet seated (inside the role grace) → false
//   3  BRIDGE_NEVER_ROOT=0, seated (grace elapsed, a non-bridge neighbour) → true
//   4  BRIDGE_NEVER_ROOT unset (neverRoot), seated → false
//   5  the predicate never throws when the manager is gone (stopped node) → false
//
// Mutant: delete the servingCapable assignment in bridge_axona_node.js → 1
// fails (and the kernel would log serving-capable-unknown and treat a
// neverRoot bridge as capable).
//
// Run: node test/fence_serving_capable_bridge.mjs
// =====================================================================
import { BridgeAxonaNode } from '../src/bridge_axona_node.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };

// bridge_engine.js reads BRIDGE_NEVER_ROOT from process.env at construction
// (bridge_engine.js:247), not from the node's env — so the fence sets both.
const mk = (env) => {
  if (env.BRIDGE_NEVER_ROOT === undefined) delete process.env.BRIDGE_NEVER_ROOT; else process.env.BRIDGE_NEVER_ROOT = env.BRIDGE_NEVER_ROOT;
  return new BridgeAxonaNode({ sendToConn: () => true, isConnOpen: () => true, log: () => {}, env });
};
const seat = (node) => {
  // seated() = joined longer than the role grace AND not meshBare(). Both are
  // the manager's own facts; the fence sets them the way time and a mesh would.
  node._axon._joinedAt = 0;
  node._axon._rootClaim.meshBare = () => false;
};

(async () => {
  console.log('fence_serving_capable_bridge: R4 — the bridge node serves when seated and not neverRoot');
  {
    const node = mk({ BRIDGE_NEVER_ROOT: '0', BRIDGE_NURSERY: '0' });
    await node.start();
    const t = node._node?.transport;
    check('1 the composite exposes servingCapable() after start()', typeof t?.servingCapable === 'function');
    check('2 NEVER_ROOT=0 but not yet seated → false', t.servingCapable() === false, String(t.servingCapable()));
    seat(node);
    check('3 NEVER_ROOT=0 and seated → true', t.servingCapable() === true, String(t.servingCapable()));
    await node.stop?.();
    check('5 after stop the predicate answers false and does not throw', (() => { try { return t.servingCapable() === false; } catch { return false; } })());
  }
  {
    const node = mk({ BRIDGE_NURSERY: '0' });   // BRIDGE_NEVER_ROOT unset → neverRoot
    await node.start();
    const t = node._node?.transport;
    seat(node);
    check('4 neverRoot and seated → false', t.servingCapable() === false, String(t.servingCapable()));
    await node.stop?.();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
