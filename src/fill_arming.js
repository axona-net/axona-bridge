// fill_arming.js — Bridge fill v0.8 (axona-docs 9b1ed08): arm Hold-and-Fill
// Rule 2 on the bridge's embedded peer, the way the relay launcher arms it.
//
// Three PURE pieces, unit-tested in test/fence_bridge_fill.mjs:
//
//   legacyMeshCap(env)      the resolver uplink.js has ALWAYS run for the mesh
//                           degree cap, verbatim: an ABSENT BRIDGE_MESH_MAX_PEERS
//                           inherits the door's cap (BRIDGE_MAX_PEERS, 32 in
//                           code), a finite positive parse sets the cap, and
//                           0 / a negative / an unparseable string leave it
//                           OFF. parseInt semantics are kept on purpose:
//                           '12x' is 12 and '1.5' is 1 today and stay so while
//                           the triad is off. This is what every unarmed bridge
//                           runs, and nothing here changes it.
//   strictCap(raw)          the ARMED resolver: present, digits only, and a
//                           finite safe integer greater than zero
//                           (Number.isSafeInteger on the converted value), or
//                           null. '0050' is 50 — the predicate decides and no
//                           leading-zero rule is in it. A digit string whose
//                           conversion is not a safe integer is refused as a
//                           representation, not accepted as a threshold.
//   resolveFillArming(env)  env → { armedEnvs, armed, options, cap, meshCap }
//                           with the relay launcher's refusals ported:
//                           BRIDGE_SYNAPTOME_MAINTAIN=1 without the guard AND
//                           the gate refuses (maintenance alone is the
//                           2026-06-29 storm, which 2.49.0 reverted); the triad
//                           with no strict cap refuses (a fill with no ceiling
//                           has nothing for "at cap" to mean). The options are
//                           the relay's constants, so a bridge grows "in the
//                           same way regular nodes do" (David 2026-10-07).
//
// ONE CAP. When armed, `cap` feeds both the fill's target (node._maxSynaptome)
// and the mesh's retire threshold (meshDegree.maxPeers) — `meshCap` is `cap`.
// When not armed, `meshCap` is the legacy resolver's answer and `cap` is null.
// The two counters count different things (synaptome entries vs open mesh
// channels), which the design note states; equal numbers are a precondition,
// not a guarantee.

export const BRIDGE_ARM_ENVS = ['BRIDGE_SYNAPTOME_MAINTAIN', 'BRIDGE_ATTEMPT_GUARD', 'BRIDGE_ADMISSION_GATE'];

/** Today's mesh-cap resolver, verbatim from uplink.js (radix 10 in both calls). 0 means off. */
export function legacyMeshCap(env = process.env) {
  const wsCap   = Number.parseInt(env.BRIDGE_MAX_PEERS ?? '32', 10);
  const meshCap = Number.parseInt(env.BRIDGE_MESH_MAX_PEERS ?? String(wsCap), 10);
  return Number.isFinite(meshCap) && meshCap > 0 ? meshCap : 0;
}

/** The armed resolver: a positive safe integer written in digits, or null. */
export function strictCap(raw) {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return (Number.isSafeInteger(n) && n > 0) ? n : null;
}

/** Hold-and-Fill Rule 2, row 12, ported from axona-relay/src/relay.js. */
export function assertArmingCoherent(armedEnvs) {
  if (!armedEnvs || !armedEnvs.includes('BRIDGE_SYNAPTOME_MAINTAIN')) return;
  const missing = ['BRIDGE_ATTEMPT_GUARD', 'BRIDGE_ADMISSION_GATE'].filter((e) => !armedEnvs.includes(e));
  if (missing.length === 0) return;
  throw new Error(
    `arming refused: BRIDGE_SYNAPTOME_MAINTAIN=1 set without ${missing.join(' and ')} — ` +
    `maintenance is armed only with the attempt guard and the admission gate (Hold-and-Fill Rule 2; ` +
    `maintenance alone is the 2026-06-29 storm, reverted in 2.49.0). Set ${missing.map((e) => e + '=1').join(' and ')}, or unset BRIDGE_SYNAPTOME_MAINTAIN.`);
}

/**
 * Resolve the embedded peer's arming from the environment.
 * @returns {{ armedEnvs: string[], armed: boolean, options: object, cap: number|null, meshCap: number }}
 */
export function resolveFillArming(env = process.env) {
  const armedEnvs = BRIDGE_ARM_ENVS.filter((e) => env[e] === '1');
  assertArmingCoherent(armedEnvs);
  const armMaintain = env.BRIDGE_SYNAPTOME_MAINTAIN === '1';
  const armGuard    = env.BRIDGE_ATTEMPT_GUARD === '1';
  const armGate     = env.BRIDGE_ADMISSION_GATE === '1';
  const armed = armMaintain && armGuard && armGate;   // the fill (kernel _fillArmed) needs all three

  let cap = null;
  if (armed) {
    cap = strictCap(env.BRIDGE_MESH_MAX_PEERS);
    if (cap === null) {
      throw new Error(
        `arming refused: the fill triad is set but BRIDGE_MESH_MAX_PEERS is ${env.BRIDGE_MESH_MAX_PEERS === undefined ? 'absent' : JSON.stringify(env.BRIDGE_MESH_MAX_PEERS)} — ` +
        `an armed bridge needs an explicit cap written as a positive integer in digits (one number for the fill target and the mesh retire threshold; ` +
        `the engine's 256 is not a cap anyone chose). Set BRIDGE_MESH_MAX_PEERS=<N>, or unset the triad.`);
    }
  }

  // The relay launcher's constants (axona-relay/src/relay.js armingFromEnv),
  // so a bridge fills exactly as a relay does.
  const options = {
    ...(armMaintain ? { synaptomeMaintain: { kNear: 5, intervalMs: 15000, maxPerTick: 3 } } : {}),
    ...(armGate     ? { admissionGate: { kNear: 5, sparseFloor: 2, kJoin: 2, laneCooldownMs: 5000, laneWindowMs: 300000 } } : {}),
    ...(armGuard    ? { attemptGuard: { maxAttempts: 4, baseMs: 30000, factor: 2, refillWindowMs: 60000, deficitBaseMs: 30000, deficitFactor: 2 } } : {}),
  };

  return { armedEnvs, armed, options, cap, meshCap: armed ? cap : legacyMeshCap(env) };
}

/** Post-construction proof that every requested module LANDED on the peer (ported from relay.js). */
export function assertArmedModules(peer, armedEnvs) {
  const missing = [];
  const effective = {};
  if (armedEnvs.includes('BRIDGE_SYNAPTOME_MAINTAIN')) {
    if (!peer._maintainCfg) missing.push('synaptomeMaintain');
    else effective.synaptomeMaintain = { ...peer._maintainCfg };
  }
  if (armedEnvs.includes('BRIDGE_ADMISSION_GATE')) {
    if (!peer._gateCfg) missing.push('admissionGate');
    else effective.admissionGate = { ...peer._gateCfg };
  }
  if (armedEnvs.includes('BRIDGE_ATTEMPT_GUARD')) {
    if (!peer._attemptGuard) missing.push('attemptGuard');
    else effective.attemptGuard = {
      maxAttempts: peer._attemptGuard.maxAttempts, baseMs: peer._attemptGuard.baseMs,
      factor: peer._attemptGuard.factor, refillWindowMs: peer._attemptGuard.refillWindowMs,
    };
  }
  if (missing.length > 0) {
    throw new Error(
      `arming refused: requested module(s) did not land on the peer: ${missing.join(', ')}. ` +
      `The pinned kernel accepted the option name(s) without building the machinery — do not serve in this state.`);
  }
  return effective;
}
