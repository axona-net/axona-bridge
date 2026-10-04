// smoke-anchor-select.js — W2 bridge anchor selection.
//
//   1. bounded: returns exactly k anchors when enough are eligible
//   2. uptime gate: peers younger than minUptime are never anchors
//   3. cold-network safety: < k eligible → falls back to the full admitted list
//   4. anti-concentration: repeated selection spreads across many anchors
//      (a heavily-used anchor is deprioritized)
//   5. keyspace diversity: distinct region prefixes preferred
//   6. never selects the newcomer itself
//
//   7. ROW 2 FENCE (Hold-and-Fill v0.5, axona-docs 4334504): the region is
//      the candidate's `region` field (its bound nodeId's top byte), never
//      the id's first two characters. Ids here are connection handles
//      (`c1`, `c2`, …), as on the real bridge. With the handle-prefix
//      reading restored, 7a–7d fail.
//   8. orderSameRegionFirst: region-mates first by bound-nodeId region,
//      stable; unknown newcomer region → order unchanged.
//
// Run: node scripts/smoke-anchor-select.js
import { selectAnchors, orderSameRegionFirst } from '../src/anchor_select.js';

let pass = 0, fail = 0;
const ok = (m, c, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m} ${x}`); c ? pass++ : fail++; };

const NOW = 1_000_000;
// helper: a candidate whose id is a bridge CONNECTION HANDLE (c<seq base36>)
// and whose region is a separate field, as server.js builds them.
const handle = (n) => `c${n.toString(36)}`;
const regionHex = (r) => r.toString(16).padStart(2, '0');
function pool(count, { region = (i) => i % 6, ageMs = 60_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: handle(i + 1), region: regionHex(region(i)), admitted: true, since: NOW - ageMs, anchorUses: 0,
  }));
}
const regionOfIn = (cands) => (id) => cands.find((c) => c.id === id)?.region ?? null;

// 1. bounded to k (pool comfortably above minPool = 3k = 24)
{
  const cands = pool(30);
  const { anchors, fellBack } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('returns exactly k=8 anchors', anchors.length === 8, `(${anchors.length})`);
  ok('not a fallback when 30 eligible (> 3k)', fellBack === false);
}

// 1b. min-pool threshold: a pool larger than k but below 3k does NOT bound
{
  const cands = pool(20); // 20 eligible, k=8 → below minPool 24 → full list
  const { anchors, fellBack } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('20 eligible (>k but <3k) → NOT bounded, full list', fellBack === true && anchors.length === 20);
  // explicit minPool override still respected
  const bounded = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000, minPool: 10 });
  ok('minPool=10 override → bounds a 20-pool to k', bounded.fellBack === false && bounded.anchors.length === 8);
}

// 2. uptime gate
{
  const cands = pool(20, { ageMs: 5_000 }); // all younger than 15s
  const { anchors, fellBack, eligibleCount } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('young peers not eligible → 0 eligible', eligibleCount === 0, `(${eligibleCount})`);
  ok('falls back to full admitted list when none eligible', fellBack === true && anchors.length === 20);
}

// 3. cold-network safety: fewer than k eligible
{
  const cands = pool(5); // only 5 eligible, k=8
  const { anchors, fellBack } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('< k eligible → fallback to all admitted', fellBack === true && anchors.length === 5);
}

// 4. anti-concentration: heavily-used anchors deprioritized
{
  // 12 eligible, all same age; give ids 0..3 huge usage. They should be
  // rotated OUT in favour of low-usage peers.
  const cands = pool(12, { region: () => 0 }); // single region so load dominates
  for (let i = 0; i < 4; i++) cands[i].anchorUses = 100;
  const { anchors } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000, wLoad: 0.35, minPool: 1 });
  const heavyChosen = anchors.filter(a => cands.slice(0, 4).some(c => c.id === a)).length;
  ok('heavily-used anchors mostly excluded', heavyChosen <= 1, `(heavy chosen=${heavyChosen})`);
}

// 5. keyspace diversity: distinct regions preferred
{
  const cands = pool(12, { region: (i) => i % 6 }); // 6 regions, 2 each
  const { anchors } = selectAnchors(cands, { newId: 'new', now: NOW, k: 6, minUptimeMs: 15000, minPool: 1 });
  const regions = new Set(anchors.map(regionOfIn(cands)));
  ok('picks all 6 distinct regions for k=6', regions.size === 6, `(regions=${regions.size})`);
}

// 7. ROW 2 FENCE: region is the field, never the handle prefix.
{
  // 7a. Two handles with different prefixes ("c1…" vs "c2…") in ONE region
  //     are one region: with k=2 and a second region present, diversity
  //     picks one of them and one from the other region.
  const cands = [
    { id: 'c1a', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c2b', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c3c', region: '80', admitted: true, since: NOW - 60_000, anchorUses: 0 },
  ];
  const { anchors } = selectAnchors(cands, { newId: 'c9', newRegion: null, now: NOW, k: 2, minUptimeMs: 15000, minPool: 1 });
  const regions = anchors.map(regionOfIn(cands));
  ok('7a two handles in one region are one region (k=2 → one 7f, one 80)',
    anchors.length === 2 && regions.includes('7f') && regions.includes('80'), `(${anchors} → ${regions})`);

  // 7b. Two handles sharing a prefix ("c1a", "c1b") in DIFFERENT regions are
  //     two regions: both chosen for k=2 ahead of a third in a used region.
  const cands2 = [
    { id: 'c1a', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c1b', region: '80', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c2c', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
  ];
  const r2 = selectAnchors(cands2, { newId: 'c9', newRegion: null, now: NOW, k: 2, minUptimeMs: 15000, minPool: 1 });
  ok('7b two handles sharing a prefix in different regions are two regions',
    r2.anchors.includes('c1a') && r2.anchors.includes('c1b'), `(${r2.anchors})`);

  // 7c. Same-region affinity keys on newRegion, not on the newcomer's handle:
  //     newcomer handle "c1z" (prefix c1) with newRegion '80' gets the '80'
  //     peer first even though every '7f' peer shares its handle prefix.
  const cands3 = [
    { id: 'c1a', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c1b', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c1c', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c2d', region: '80', admitted: true, since: NOW - 60_000, anchorUses: 0 },
  ];
  const r3 = selectAnchors(cands3, { newId: 'c1z', newRegion: '80', now: NOW, k: 2, minUptimeMs: 15000, minPool: 1 });
  ok('7c affinity follows newRegion (80), not the handle prefix (c1)', r3.anchors[0] === 'c2d', `(${r3.anchors})`);

  // 7d. Unknown newcomer region → no affinity pass, diversity still runs:
  //     k=2 over three regions picks two distinct regions.
  const r4 = selectAnchors(cands3, { newId: 'c1z', newRegion: null, now: NOW, k: 2, minUptimeMs: 15000, minPool: 1 });
  const reg4 = new Set(r4.anchors.map(regionOfIn(cands3)));
  ok('7d null newRegion: no affinity, diversity picks two regions', reg4.size === 2, `(${r4.anchors})`);

  // 7e. An unbound candidate (region null) never counts as a region in the
  //     diversity pass but can still fill: k=3 over {7f, null, 80}.
  const cands5 = [
    { id: 'c1a', region: '7f', admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c2b', region: null, admitted: true, since: NOW - 60_000, anchorUses: 0 },
    { id: 'c3c', region: '80', admitted: true, since: NOW - 60_000, anchorUses: 0 },
  ];
  const r5 = selectAnchors(cands5, { newId: 'c9', newRegion: null, now: NOW, k: 2, minUptimeMs: 15000, minPool: 1 });
  ok('7e unbound candidate is not a region: k=2 picks 7f and 80', r5.anchors.includes('c1a') && r5.anchors.includes('c3c'), `(${r5.anchors})`);
  const r5b = selectAnchors(cands5, { newId: 'c9', newRegion: null, now: NOW, k: 3, minUptimeMs: 15000, minPool: 1 });
  ok('7e unbound candidate still fills at k=3', r5b.anchors.length === 3 && r5b.anchors.includes('c2b'));
}

// 8. orderSameRegionFirst
{
  const cands = [
    { id: 'c1', region: '7f' }, { id: 'c2', region: '80' }, { id: 'c3', region: '7f' },
    { id: 'c4', region: null }, { id: 'c5', region: '80' },
  ];
  const regionOf = regionOfIn(cands);
  const peers = cands.map((c) => c.id);
  ok('8a region-mates first, stable, rest unchanged',
    orderSameRegionFirst(peers, regionOf, '80').join(',') === 'c2,c5,c1,c3,c4');
  ok('8b unknown newcomer region leaves the order unchanged',
    orderSameRegionFirst(peers, regionOf, null).join(',') === 'c1,c2,c3,c4,c5');
  ok('8c a region nobody is in leaves the order unchanged',
    orderSameRegionFirst(peers, regionOf, 'ff').join(',') === 'c1,c2,c3,c4,c5');
  ok('8d handle prefix is never consulted: newRegion "c1" matches nothing',
    orderSameRegionFirst(peers, regionOf, 'c1').join(',') === 'c1,c2,c3,c4,c5');
  ok('8e returns a copy', orderSameRegionFirst(peers, regionOf, '80') !== peers);
}

// 6. never the newcomer itself
{
  const cands = pool(20);
  cands[0].id = 'newself';
  const { anchors } = selectAnchors(cands, { newId: 'newself', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('newcomer never anchors itself', !anchors.includes('newself'));
}

console.log(`\n${fail ? '✗' : '✓'} smoke-anchor-select: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
