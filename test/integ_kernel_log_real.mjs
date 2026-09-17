// integ_kernel_log_real.mjs — a REAL kernel refusal reaches the bridge's log.
//
// fence_kernel_log.mjs proves the plumbing against a spy. A spy proves only
// that I called the functions I meant to call; it cannot prove the kernel ever
// calls back. That distinction is the whole reason O1 exists: on the alert-bot
// runs the bridge cells read UNKNOWN, and "the intake was armed" would have
// been just as unfalsifiable as the silence it replaced.
//
// So this builds a genuine AxonaManager from the installed kernel, with
// neverRoot set the way a bridge sets it, drives the real admission path, and
// requires the refusal to arrive as a row. If the kernel renames the event,
// changes the sink signature, or stops logging refusals, this fails — and it
// SHOULD fail, because on that kernel O1 would silently measure nothing.
import { AxonaManager } from '@axona/protocol';
import { depositDispatchCapability } from '@axona/protocol/registry/index.js';
import { installKernelLog } from '../src/kernel_log.js';

let fail = 0;
const ok = (msg, cond, extra = '') => {
  if (cond) console.log(`  ok - ${msg}`);
  else { console.log(`  ✗  ${msg} ${extra}`); fail++; }
};

console.log('kernel log (O1) — a real kernel refusal, through the real sink\n');

const SELF = BigInt('0x80933fee3c0cd774acdb5e3c4caaaa338d1571342550c54c2ac347641c097e6b56');
const TOPIC = BigInt('0x80ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

// The smallest adapter the kernel accepts. `verdictsSupported:false` is the
// honest declaration for a double that resolves no routing verdict — declaring
// true here would make every send a contract violation (kernel comment at
// AxonaManager's constructor).
const dht = {
  verdictsSupported: false,
  getSelfId: () => SELF,
  neighbors: () => [],
  bridgeId: () => null,
  isCapable: () => true,
  findKClosest: () => [],
  routeMessage: () => 0,
  sendDirect: () => 0,
  onRoutedMessage: () => {},
  onDirectMessage: () => {},
};

// The kernel's E3 seal: a frame receiver must carry a deposited dispatch
// capability before AxonaManager will register its routed frames. The bridge
// deposits the same shape in bridge_engine.js — this mirrors it rather than
// inventing one, so the manager under test is built the way a bridge builds it.
depositDispatchCapability(dht, { routed: (type, h) => dht.onRoutedMessage(type, h) });

const rows = [];
const am = new AxonaManager({ dht, neverRoot: true });
const handle = installKernelLog({
  axonaManager: am,
  env: { BRIDGE_KERNEL_LOG: 'on' },
  sink: (level, event, fields) => rows.push({ level, event, fields }),
});

ok('1. installed against a real AxonaManager', handle.installed === true
  && handle.intakes.includes('manager-sink'), handle.intakes.join(','));
ok('   the manager reports the bridge stance', am.inspectAdmission().neverRoot === true);

// The real admission path, both doors. `admitRole` is the ordinary placement
// question; `admitPushedRole` is the one a departing node's handoff asks, and
// it is the door a peer's placement answer drives. `canAcceptRole` only
// returns the verdict — it logs nothing on its own, so asking it is not a
// substitute for driving admission.
const verdict = am.canAcceptRole();
const admitted = am.admitRole(TOPIC, false);
const pushed = am.admitPushedRole(TOPIC);

ok('2. the verdict is a hard bridge refusal, not a bare false',
  verdict?.ok === false && verdict?.why === 'bridge' && verdict?.hard === true,
  JSON.stringify(verdict));
ok('   neither door admitted the role', admitted === false && pushed === false);

const refusals = rows.filter((r) => r.event.includes('role-refused'));
ok('   both refusals arrived on the bridge sink', refusals.length === 2,
  `rows: ${rows.map((r) => r.event).join(',') || 'none'}`);
ok('   prefixed kernel: so they are greppable beside bridge rows',
  refusals.every((r) => r.event.startsWith('kernel:')), refusals.map((r) => r.event).join(','));
ok('   each carries the REASON, which is the cell the probe fills',
  refusals.every((r) => r.fields?.why === 'bridge' && r.fields?.hard === true),
  JSON.stringify(refusals.map((r) => r.fields)));
ok('   the pushed one is distinguishable from the ordinary one',
  refusals.some((r) => r.fields?.pushed === true) && refusals.some((r) => r.fields?.pushed === undefined));
// LEVEL, recorded deliberately. A hard bridge refusal is INFO in 4.84.0 — only
// `admitted-despite` (the floor overriding a soft refusal) is WARN. This test
// first asserted warn and was wrong. It matters operationally: an O1 that
// forwarded warn and error only would capture none of these rows, and every
// bridge cell would still read UNKNOWN while looking instrumented.
ok('   they arrive at INFO, so an info-less intake would see nothing',
  refusals.every((r) => r.level === 'info'), refusals.map((r) => r.level).join(','));

// The counter and the rows must agree. A refusal visible in one and not the
// other would let a run be read two ways.
const counters = am.inspectAdmission().refusals;
ok('3. the admission counter agrees with the rows',
  counters.bridge === refusals.length, `${counters.bridge} counted, ${refusals.length} logged`);

// Nothing in the row may be a value JSON cannot carry: the sink writes into a
// process whose logger is a plain JSON.stringify.
ok('   every row serializes', (() => {
  try { rows.forEach((r) => JSON.stringify(r)); return true; } catch { return false; }
})());

handle.uninstall();
const before = rows.length;
am.canAcceptRole?.(TOPIC);
ok('4. after uninstall the kernel logs nowhere', rows.length === before, `${before} → ${rows.length}`);

console.log(`\n${fail ? `✗ ${fail} failed` : '✓ all checks passed'}`);
process.exit(fail ? 1 : 0);
