// =====================================================================
// anchor_select.js — W2 bridge bootstrap-nursery anchor selection.
//
// Replaces "hand every newcomer the full admitted peer-list" with a
// BOUNDED, curated, load-spread, keyspace-diverse anchor set. The newcomer
// connects to those anchors and self-expands into the rest of the mesh via
// mesh-relayed signalling (proven bridgeless — mesh_relay_multihop_e2e).
//
// REDUCED port of the sim-validated BridgeNursery. A bridge can only observe
// its OWN connections, so of the sim's composite eligibility we keep the
// bridge-observable signals:
//   · uptime            — connection age (conn.since); also the hard gate
//   · anti-concentration — the bridge's own per-anchor usage counter (the
//                          crucial factor: a relative-load penalty spreads
//                          introductions so a few peers aren't every newcomer's
//                          first contact — an eclipse surface)
//   · keyspace diversity — peerId high byte (region), spread across anchors
// Degree / inbound-degree are NOT bridge-observable and are omitted; the sim
// showed they add little once anti-concentration is in.
//
// Sim result (dht-sim results/w2): with the load penalty, eclipse gini fell
// 0.75→0.20 while fill/reachability held (reach 100%). See W2 SWEEP-RESULTS.md.
// =====================================================================

const regionKey = (idHex) => (typeof idHex === 'string' ? idHex.slice(0, 2) : '');

/**
 * @param {Array<{id:string, admitted:boolean, since:number, anchorUses?:number}>} candidates
 * @param {{newId:string, now:number, k?:number, minUptimeMs?:number, wLoad?:number}} opts
 * @returns {{anchors:string[], fellBack:boolean, eligibleCount:number}}
 */
export function selectAnchors(candidates, {
  newId, now, k = 8, minUptimeMs = 15000, wLoad = 0.35, minPool = k * 3,
} = {}) {
  const admitted = candidates.filter(c => c.admitted && c.id !== newId);
  const eligible = admitted.filter(c => (now - c.since) >= minUptimeMs);

  // Only ENGAGE bounding when the eligible pool is comfortably larger than k
  // (default ≥ 3·k). Bounding a network barely larger than k is all cost / no
  // benefit: it drops critical nodes with no redundancy to absorb the loss.
  // (Observed live — on a 9-relay testnet with k=8 the nursery dropped the one
  // relay rooting a cross-region topic and broke that direction's delivery; the
  // sim couldn't model the cross-region-root-over-slow-ICE dynamic.) Below the
  // threshold — including a cold/small/just-restarted network — hand the full
  // list so bootstrap and cross-region convergence never starve. The nursery is
  // thus inert on small networks and auto-engages only at the scale the sim
  // proved it helps.
  if (eligible.length < minPool) {
    return { anchors: admitted.map(c => c.id), fellBack: true, eligibleCount: eligible.length };
  }

  let maxUses = 0;
  for (const c of eligible) if ((c.anchorUses || 0) > maxUses) maxUses = c.anchorUses || 0;

  const scored = eligible.map(c => {
    const uptimeN = Math.min(1, (now - c.since) / (minUptimeMs * 10)); // saturating longevity
    const loadN   = maxUses > 0 ? (c.anchorUses || 0) / maxUses : 0;   // relative usage
    return { id: c.id, s: uptimeN - wLoad * loadN };
  }).sort((a, b) => b.s - a.s);

  const chosen = [], usedRegions = new Set();
  // Pass 1: highest score in a not-yet-used keyspace region (diversity).
  for (const { id } of scored) {
    if (chosen.length >= k) break;
    const r = regionKey(id);
    if (!usedRegions.has(r)) { chosen.push(id); usedRegions.add(r); }
  }
  // Pass 2: fill remaining slots with the next-highest scorers.
  for (const { id } of scored) {
    if (chosen.length >= k) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  return { anchors: chosen, fellBack: false, eligibleCount: eligible.length };
}
