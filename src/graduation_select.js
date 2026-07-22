// graduation_select.js — pure selection for vitality-based bridge graduation (#374).
//
// The bridge is capacity-bounded; when over cap it graduates one established,
// mesh-capable peer off (WS 4200) to free a bootstrap slot. This module decides
// WHICH peer, on two axes:
//
//   1. KEYSPACE BALANCE (primary) — graduate from the most over-represented
//      nodeId keyspace region, and NEVER a region's last representative, so the
//      set the bridge keeps always spans the full address space (newcomers can
//      always be introduced to a same-region + diverse anchor set).
//   2. VITALITY (secondary) — within that region, release the BEST-meshed peer:
//      the node whose departure the mesh best absorbs, chosen on the measured
//      `meshBound` it reports, not a uptime guess.
//
// Kept pure (no I/O, no server state) so it is unit-testable — the caller
// resolves each connection into a plain descriptor first. Mirrors the
// anchor_select.js / smoke-anchor-select.js pattern.

/**
 * @typedef {Object} GradCandidate
 * @property {string}  id           connId (opaque handle the caller closes)
 * @property {string|null} region   nodeId keyspace region (top byte hex), null if unbound
 * @property {number}  since        admit epoch ms
 * @property {number|null} meshBound  FRESH reported mesh size, or null if none/stale
 * @property {boolean} kernelOk     honours the 4200 graceful-close (≥ min kernel)
 * @property {boolean} inCooldown   graduated too recently (re-dial guard)
 */

/**
 * Choose the single peer to graduate, or null if none is eligible.
 *
 * @param {GradCandidate[]} candidates  all admitted connections, as descriptors
 * @param {Object} opts
 * @param {number} opts.now
 * @param {number} opts.safeFloor       min meshBound to be eligible on vitality
 * @param {number} opts.minUptimeMs     uptime proxy when no fresh meshBound
 * @param {number} opts.maxNurseryMs    hard uptime ceiling (graduate regardless)
 * @returns {{ id: string, region: string, meshBound: number|null, basis: 'vitality'|'uptime'|'ceiling' } | null}
 */
export function selectGraduate(candidates, { now, safeFloor, minUptimeMs, maxNurseryMs }) {
  // Region occupancy over ALL bound admitted peers (the balance signal + the
  // never-orphan guard both read this — computed over everyone, not just the
  // eligible subset, so a region with one eligible + one ineligible peer still
  // counts as 2 and its eligible peer can be released).
  const regionCount = new Map();
  for (const c of candidates) {
    if (c.region != null) regionCount.set(c.region, (regionCount.get(c.region) || 0) + 1);
  }

  const basisOf = (c) => {
    if (c.meshBound != null && c.meshBound >= safeFloor) return 'vitality';
    if ((now - c.since) >= maxNurseryMs)                 return 'ceiling';
    if (c.meshBound == null && (now - c.since) >= minUptimeMs) return 'uptime';
    return null;   // not eligible on any basis
  };

  const eligible = candidates.filter(c =>
    c.kernelOk && c.region != null && !c.inCooldown && basisOf(c) != null);
  if (eligible.length === 0) return null;

  // Primary: most over-represented region first. Secondary: highest fresh
  // meshBound first (unknown = -1 → sorts last, so a KNOWN-redundant node is
  // preferred over a guess). Tiebreak: oldest (longest to re-bootstrap if wrong).
  const mbKey = (c) => (c.meshBound == null ? -1 : c.meshBound);
  const sorted = [...eligible].sort((a, b) => {
    const rd = (regionCount.get(b.region) || 0) - (regionCount.get(a.region) || 0);
    if (rd !== 0) return rd;
    const vd = mbKey(b) - mbKey(a);
    if (vd !== 0) return vd;
    return a.since - b.since;
  });

  // Never a region's last representative — walk the ranked list until we find a
  // peer whose region still has ≥2 members (skip any that would orphan a region).
  for (const c of sorted) {
    if ((regionCount.get(c.region) || 0) > 1) {
      return { id: c.id, region: c.region, meshBound: c.meshBound, basis: basisOf(c) };
    }
  }
  return null;
}
