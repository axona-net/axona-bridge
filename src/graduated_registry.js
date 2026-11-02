// graduated_registry.js — "The introduction represents the mesh, not the
// socket" v0.1 (axona-docs c7b0230), P1.a: the bridge keeps a REGISTRY of the
// ids it has graduated and every peer-list carries a SAMPLE of it, in a field
// of its own (`graduated`), never in `peers`.
//
// WHY. After graduation the bridge's connection table forgets a node; the id
// survived only in a sixty-second cooldown map. A cohort that restarts
// together is then introduced only to itself (the 2026-10-28 partition). The
// registry is the bridge's memory of the mesh, kept for L_reg and bounded at
// M_reg; the sample is what a newcomer learns of it: R_sample ids drawn
// uniformly without replacement, minus the newcomer. A 66-hex id is not a
// connection handle (Orion, MPSH-3): the kernel NOMINATES the sample into its
// candidate cache as source `directory` and the fill dials under its budget;
// the mesh never dials the field.
//
// WHAT THIS FILE HOLDS: the env resolver and its refusals, and the registry
// (write at graduation, expiry, bound, sample, size). server.js wires it:
// the write at both graduation sites, the sample at both peer-list sites,
// the size on the operator /healthz. Nothing here sends a frame.
//
// Q3 (David, 2026-11-02 "Proceed with Q1-Q4"): R_sample 16, L_reg 24 h,
// M_reg 4096 are the defaults. Q4: the registry is bootstrap state and does
// not survive a restart; nothing here touches disk.

export const GRADUATED_SAMPLE_ENVS = Object.freeze({
  on:      'BRIDGE_GRADUATED_SAMPLE',
  rSample: 'BRIDGE_GRADUATED_R_SAMPLE',
  lRegMs:  'BRIDGE_GRADUATED_L_REG_MS',
  mReg:    'BRIDGE_GRADUATED_M_REG',
});

export const GRADUATED_SAMPLE_DEFAULTS = Object.freeze({
  rSample: 16,                 // ids per peer-list
  lRegMs:  24 * 60 * 60 * 1000, // a registered id expires after this; it is never refreshed
  mReg:    4096,               // entries; the oldest is evicted above it (about 270 KB of ids)
});

const ON_VALUES = new Set(['1', 'on', 'true', 'yes']);
const HEX66 = /^[0-9a-f]{66}$/;

function strictPosInt(raw, name) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw new TypeError(`${name}: must be a positive integer, got ${JSON.stringify(raw)}`);
  const n = parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name}: must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Resolve the graduated-sample configuration from the environment. OFF unless
 * BRIDGE_GRADUATED_SAMPLE is 1/on/true/yes; off, every other variable is
 * ignored and the bridge is byte-identical to 2.175.0. On, every numeric
 * variable present must be a positive integer (a typo refuses at
 * construction, not at the first peer-list), and R_sample may not exceed
 * M_reg.
 */
export function resolveGraduatedSample(env = process.env) {
  const raw = env[GRADUATED_SAMPLE_ENVS.on];
  const on = typeof raw === 'string' && ON_VALUES.has(raw.trim().toLowerCase());
  if (!on) return { on: false };
  const rSample = strictPosInt(env[GRADUATED_SAMPLE_ENVS.rSample], GRADUATED_SAMPLE_ENVS.rSample) ?? GRADUATED_SAMPLE_DEFAULTS.rSample;
  const lRegMs  = strictPosInt(env[GRADUATED_SAMPLE_ENVS.lRegMs],  GRADUATED_SAMPLE_ENVS.lRegMs)  ?? GRADUATED_SAMPLE_DEFAULTS.lRegMs;
  const mReg    = strictPosInt(env[GRADUATED_SAMPLE_ENVS.mReg],    GRADUATED_SAMPLE_ENVS.mReg)    ?? GRADUATED_SAMPLE_DEFAULTS.mReg;
  if (rSample > mReg) throw new TypeError(`${GRADUATED_SAMPLE_ENVS.rSample}: ${rSample} exceeds ${GRADUATED_SAMPLE_ENVS.mReg} ${mReg}`);
  return { on: true, rSample, lRegMs, mReg };
}

/** True for a lowercase 66-hex node id and nothing else. */
export function isHex66(v) { return typeof v === 'string' && HEX66.test(v); }

/**
 * The registry. Insertion-ordered: the oldest registration is first, so the
 * bound evicts from the front and expiry sweeps from the front. A
 * re-graduation of a known id is a new registration (its old entry is
 * removed, its new one appended): the fact "graduated at t" is new, and a
 * re-contact that would refresh an entry without a graduation does not exist
 * (v0.1 § Freshness, without a return).
 */
export class GraduatedRegistry {
  constructor({ lRegMs = GRADUATED_SAMPLE_DEFAULTS.lRegMs, mReg = GRADUATED_SAMPLE_DEFAULTS.mReg } = {}) {
    if (!Number.isSafeInteger(lRegMs) || lRegMs <= 0) throw new TypeError('GraduatedRegistry: lRegMs must be a positive integer');
    if (!Number.isSafeInteger(mReg) || mReg <= 0) throw new TypeError('GraduatedRegistry: mReg must be a positive integer');
    this.lRegMs = lRegMs;
    this.mReg = mReg;
    this._map = new Map();   // hex → registered-at (ms)
    this.rejected = 0;       // writes refused for not being 66-hex
    this.evicted = 0;        // entries evicted by the bound
    this.expired = 0;        // entries swept at L_reg
  }

  get size() { return this._map.size; }

  /** Record a graduation. Returns true when written, false when refused. */
  note(hex, now = Date.now()) {
    if (!isHex66(hex)) { this.rejected++; return false; }
    if (this._map.has(hex)) this._map.delete(hex);
    this._map.set(hex, now);
    while (this._map.size > this.mReg) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this.evicted++;
    }
    return true;
  }

  /** Sweep entries registered L_reg or more ago. Returns the number swept. */
  prune(now = Date.now()) {
    let n = 0;
    for (const [hex, at] of this._map) {
      if (now - at < this.lRegMs) break;   // insertion order: the first live entry ends the sweep
      this._map.delete(hex); n++;
    }
    this.expired += n;
    return n;
  }

  has(hex) { return this._map.has(hex); }

  /**
   * R ids drawn uniformly without replacement from the live registry, minus
   * `exclude` (the newcomer's own id when the bridge knows it). Partial
   * Fisher–Yates over a copy; `rng` is injectable for a fence and defaults
   * to Math.random. Fewer than R when the registry is smaller; empty when it
   * is empty.
   */
  sample(r, { exclude = null, now = Date.now(), rng = Math.random } = {}) {
    if (!Number.isSafeInteger(r) || r <= 0) return [];
    this.prune(now);
    const pool = [];
    for (const hex of this._map.keys()) if (hex !== exclude) pool.push(hex);
    const n = Math.min(r, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, n);
  }

  /** Operator readout: sizes and counters only; never an id. */
  status() {
    return { size: this._map.size, lRegMs: this.lRegMs, mReg: this.mReg, rejected: this.rejected, evicted: this.evicted, expired: this.expired };
  }
}
