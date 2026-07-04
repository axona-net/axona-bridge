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
// Run: node scripts/smoke-anchor-select.js
import { selectAnchors } from '../src/anchor_select.js';

let pass = 0, fail = 0;
const ok = (m, c, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m} ${x}`); c ? pass++ : fail++; };

const NOW = 1_000_000;
// helper: build a candidate with region-prefixed id
const hex = (region, n) => region.toString(16).padStart(2, '0') + String(n).padStart(64, '0');
function pool(count, { region = (i) => i % 6, ageMs = 60_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: hex(region(i), i), admitted: true, since: NOW - ageMs, anchorUses: 0,
  }));
}

// 1. bounded to k
{
  const cands = pool(20);
  const { anchors, fellBack } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000 });
  ok('returns exactly k=8 anchors', anchors.length === 8, `(${anchors.length})`);
  ok('not a fallback when 20 eligible', fellBack === false);
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
  const { anchors } = selectAnchors(cands, { newId: 'new', now: NOW, k: 8, minUptimeMs: 15000, wLoad: 0.35 });
  const heavyChosen = anchors.filter(a => cands.slice(0, 4).some(c => c.id === a)).length;
  ok('heavily-used anchors mostly excluded', heavyChosen <= 1, `(heavy chosen=${heavyChosen})`);
}

// 5. keyspace diversity: distinct regions preferred
{
  const cands = pool(12, { region: (i) => i % 6 }); // 6 regions, 2 each
  const { anchors } = selectAnchors(cands, { newId: 'new', now: NOW, k: 6, minUptimeMs: 15000 });
  const regions = new Set(anchors.map(a => a.slice(0, 2)));
  ok('picks all 6 distinct regions for k=6', regions.size === 6, `(regions=${regions.size})`);
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
