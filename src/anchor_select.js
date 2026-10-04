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

// THE REGION IS A FIELD, NOT A PREFIX OF THE ID (Hold-and-Fill v0.5 row 2,
// axona-docs 4334504). The ids in `candidates` are the bridge's connection
// handles, minted as `c${seq.toString(36)}` (server.js), so `id.slice(0, 2)`
// was "c1", "c2", … "cz": the first two characters of a sequence number.
// Same-region affinity and keyspace diversity were grouping by connection
// order. The kernel made the identical mistake at 4.95.0 (web/index.js, the
// mesh-degree cap read a region off a handle and never fired). The caller
// resolves each candidate's region from its BOUND nodeId (server.js
// connRegion) and passes it as `region`, null while the connection has not
// authenticated; the newcomer's region arrives as `newRegion` and is null
// when the bridge does not know it yet (it binds the newcomer's nodeId only
// on hello-ack, AFTER this list is sent, so until the client-hello carries a
// nodeId the newcomer has no region here and pass 0 is skipped).
const regionOf = (c) => (typeof c?.region === 'string' && c.region.length ? c.region : null);

/**
 * @param {Array<{id:string, admitted:boolean, since:number, anchorUses?:number, region?:string|null}>} candidates
 * @param {{newId:string, newRegion?:string|null, now:number, k?:number, minUptimeMs?:number, wLoad?:number, minPool?:number}} opts
 * @returns {{anchors:string[], fellBack:boolean, eligibleCount:number}}
 */
export function selectAnchors(candidates, {
  newId, newRegion = null, now, k = 8, minUptimeMs = 15000, wLoad = 0.35, minPool = k * 3,
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
    return { id: c.id, region: regionOf(c), s: uptimeN - wLoad * loadN };
  }).sort((a, b) => b.s - a.s);

  const chosen = [], usedRegions = new Set();
  // Pass 0: SAME-REGION AFFINITY (#362). A newcomer's region-mates are its
  // future cohort — replica recruitment and graceful-leave heir resolution
  // are region-homogeneous, so a node that never meshes with its region-mates
  // becomes a SINGLETON root whose history either dies with it or gets handed
  // to out-of-region holders that routed reads can never find (the alert-bot
  // ~10% deterministic loss). Guarantee up to half the anchor slots to the
  // newcomer's own region before the diversity pass. Skipped when the
  // newcomer's region is unknown: a null never equals a region.
  const newR = (typeof newRegion === 'string' && newRegion.length) ? newRegion : null;
  if (newR != null) {
    for (const { id, region } of scored) {
      if (chosen.length >= Math.max(1, Math.floor(k / 2))) break;
      if (region === newR) { chosen.push(id); usedRegions.add(newR); }
    }
  }
  // Pass 1: highest score in a not-yet-used keyspace region (diversity). An
  // unbound candidate (region null) has no region to contribute and waits
  // for pass 2.
  for (const { id, region } of scored) {
    if (chosen.length >= k) break;
    if (region == null) continue;
    if (!usedRegions.has(region) && !chosen.includes(id)) { chosen.push(id); usedRegions.add(region); }
  }
  // Pass 2: fill remaining slots with the next-highest scorers.
  for (const { id } of scored) {
    if (chosen.length >= k) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  return { anchors: chosen, fellBack: false, eligibleCount: eligible.length };
}

/**
 * The newcomer's region CLAIM from its client-hello. The bridge binds the
 * authenticated nodeId only on hello-ack, after the peer-list is sent, so the
 * region used for anchor affinity and list order at admission can only be a
 * claim. It is an UNTRUSTED SELECTION/ORDER HINT: it picks anchors for the
 * claimant and orders the claimant's list, and through the chosen anchors'
 * shared anchorUses counters it shifts later newcomers' scores (Aster
 * c771508b). It is never a binding, an authentication, a graduation region
 * or a custody authority; those read the bound identity (server.js
 * connRegion). This parser is the only reader of the field.
 * @param {any} msg   the client-hello frame
 * @returns {string|null} top byte of a well-formed 66-hex nodeId, else null
 */
export function claimedRegion(msg) {
  const v = msg?.nodeId;
  return (typeof v === 'string' && /^[0-9a-f]{66}$/.test(v)) ? v.slice(0, 2) : null;
}

/**
 * SAME-REGION FIRST ordering of a peer-list (#362): the kernel dials the list
 * in order and only the first few ICE negotiations complete inside the connect
 * window, so list order decides which links form. Stable partition: the
 * newcomer's region-mates keep their relative order up front, the rest follow
 * unchanged. With the newcomer's region unknown the list is returned as is.
 * @param {string[]} peers           connection handles, in their current order
 * @param {(id:string)=>string|null} regionOfId   bound-nodeId region of a handle, null if unbound
 * @param {string|null} newRegion    the newcomer's region, null if unknown
 * @returns {string[]}
 */
export function orderSameRegionFirst(peers, regionOfId, newRegion) {
  const newR = (typeof newRegion === 'string' && newRegion.length) ? newRegion : null;
  if (newR == null || !Array.isArray(peers)) return Array.isArray(peers) ? peers.slice() : [];
  const same = [], rest = [];
  for (const p of peers) {
    let r = null;
    try { r = regionOfId(p); } catch { r = null; }
    (r === newR ? same : rest).push(p);
  }
  return [...same, ...rest];
}
