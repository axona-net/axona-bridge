// =====================================================================
// fence_no_channel_ticks.mjs — bridge 2.184.0: BRIDGE_NO_CHANNEL_TICKS arms
// the kernel's No-Channel Sweep (kernel 4.132.0) on the embedded peer.
//
//   A. ABSENT: resolveFillArming returns exactly the 2.182.0 options
//      (synaptomeMaintain has no noChannelTicks key) and noChannelTicks 0.
//   B. Set with the triad: synaptomeMaintain.noChannelTicks is the number,
//      and the other maintain constants are unchanged.
//   C. Refused: '0', '-1', '3.5', 'abc', '3x', ' 3' each throw.
//   D. Refused: a valid value WITHOUT BRIDGE_SYNAPTOME_MAINTAIN=1 throws
//      (the sweep rides the maintain tick and would never run).
//   E. '0003' is 3 (the strict resolver's own rule, as for the cap).
//
// With the passthrough removed from the options, B fails. With the
// maintain precondition removed, D fails.
// Run: node test/fence_no_channel_ticks.mjs
// =====================================================================
import { resolveFillArming, resolveNoChannelTicks } from '../src/fill_arming.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const TRIAD = { BRIDGE_SYNAPTOME_MAINTAIN: '1', BRIDGE_ATTEMPT_GUARD: '1', BRIDGE_ADMISSION_GATE: '1', BRIDGE_MESH_MAX_PEERS: '50' };
const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

console.log('fence_no_channel_ticks: BRIDGE_NO_CHANNEL_TICKS reaches the kernel option, and only when it can run');
{
  const r = resolveFillArming({ ...TRIAD });
  check('A absent: synaptomeMaintain is exactly the 2.182.0 constants', JSON.stringify(r.options.synaptomeMaintain) === JSON.stringify({ kNear: 5, intervalMs: 15000, maxPerTick: 3 }), JSON.stringify(r.options.synaptomeMaintain));
  check('A absent: noChannelTicks reported 0 (OFF)', r.noChannelTicks === 0);
  const u = resolveFillArming({});
  check('A unarmed bridge, nothing set: no synaptomeMaintain at all, OFF', u.options.synaptomeMaintain === undefined && u.noChannelTicks === 0);
}
{
  const r = resolveFillArming({ ...TRIAD, BRIDGE_NO_CHANNEL_TICKS: '3' });
  check('B set with the triad: synaptomeMaintain.noChannelTicks === 3', r.options.synaptomeMaintain?.noChannelTicks === 3 && r.noChannelTicks === 3, JSON.stringify(r.options.synaptomeMaintain));
  check('B the other maintain constants are unchanged', r.options.synaptomeMaintain.kNear === 5 && r.options.synaptomeMaintain.intervalMs === 15000 && r.options.synaptomeMaintain.maxPerTick === 3);
  check('B the gate, the guard and the cap are unchanged', r.armed === true && r.cap === 50 && r.meshCap === 50 && !!r.options.admissionGate && !!r.options.attemptGuard);
}
for (const bad of ['0', '-1', '3.5', 'abc', '3x', ' 3']) {
  const m = throws(() => resolveFillArming({ ...TRIAD, BRIDGE_NO_CHANNEL_TICKS: bad }));
  check(`C refused: ${JSON.stringify(bad)}`, typeof m === 'string' && m.includes('BRIDGE_NO_CHANNEL_TICKS'), String(m));
}
{
  const m = throws(() => resolveFillArming({ BRIDGE_NO_CHANNEL_TICKS: '3' }));
  check('D refused without BRIDGE_SYNAPTOME_MAINTAIN=1', typeof m === 'string' && m.includes('without BRIDGE_SYNAPTOME_MAINTAIN=1'), String(m));
  check('D the resolver alone agrees', throws(() => resolveNoChannelTicks({ BRIDGE_NO_CHANNEL_TICKS: '3' }, false)) !== null && resolveNoChannelTicks({ BRIDGE_NO_CHANNEL_TICKS: '3' }, true) === 3);
}
check("E '0003' is 3", resolveFillArming({ ...TRIAD, BRIDGE_NO_CHANNEL_TICKS: '0003' }).noChannelTicks === 3);
check("E '' is OFF, the same as absent", resolveFillArming({ ...TRIAD, BRIDGE_NO_CHANNEL_TICKS: '' }).noChannelTicks === 0);

console.log(`\nfence_no_channel_ticks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
