// smoke-graduation-select.js — unit test for vitality-based graduation (#374).
//
// Verifies selectGraduate()'s two axes and its safety gates:
//   · keyspace balance: graduate from the most over-represented region
//   · vitality: within it, release the BEST-meshed (highest meshBound) peer
//   · never orphan a region (skip a region's last representative)
//   · eligibility: safe-floor, uptime fallback, hard ceiling, kernel, cooldown
//
// Run: node scripts/smoke-graduation-select.js

import { selectGraduate } from '../src/graduation_select.js';

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label}`); failed++; }
}

const NOW = 1_000_000_000;
const OPTS = { now: NOW, safeFloor: 4, minUptimeMs: 30_000, maxNurseryMs: 600_000 };
// A well-meshed, long-enough, eligible baseline candidate; override per case.
const cand = (o = {}) => ({
  id: 'x', region: 'aa', since: NOW - 60_000, meshBound: 8,
  kernelOk: true, inCooldown: false, ...o,
});

console.log('selectGraduate — keyspace balance + vitality (#374)\n');

// 1. Most over-represented region first, highest meshBound within it.
{
  const cands = [
    cand({ id: 'a1', region: 'aa', meshBound: 5 }),
    cand({ id: 'a2', region: 'aa', meshBound: 9 }),   // best-meshed in the crowded region
    cand({ id: 'a3', region: 'aa', meshBound: 7 }),
    cand({ id: 'b1', region: 'bb', meshBound: 20 }),  // higher meshBound, but region bb is sparse
  ];
  const r = selectGraduate(cands, OPTS);
  check('picks the most over-represented region (aa, not bb)', r?.region === 'aa');
  check('within it, the highest-meshBound peer (a2)', r?.id === 'a2');
  check('basis is vitality', r?.basis === 'vitality');
}

// 2. Never orphan a region: the crowded region's peers are all ineligible →
//    fall to the next region that still has ≥2 members.
{
  const cands = [
    cand({ id: 'a1', region: 'aa', meshBound: 9, inCooldown: true }),  // crowded but blocked
    cand({ id: 'a2', region: 'aa', meshBound: 9, kernelOk: false }),   // crowded but blocked
    cand({ id: 'b1', region: 'bb', meshBound: 6 }),
    cand({ id: 'b2', region: 'bb', meshBound: 5 }),
  ];
  const r = selectGraduate(cands, OPTS);
  check('falls to region bb when aa has no eligible peer', r?.region === 'bb');
  check('best-meshed eligible in bb (b1)', r?.id === 'b1');
}

// 3. Never a region's LAST representative — a solo-region peer is never graduated.
{
  const cands = [
    cand({ id: 'solo', region: 'zz', meshBound: 50 }),  // only zz member
    cand({ id: 'a1',   region: 'aa', meshBound: 6 }),
    cand({ id: 'a2',   region: 'aa', meshBound: 5 }),
  ];
  const r = selectGraduate(cands, OPTS);
  check('does not orphan the solo region zz', r?.region !== 'zz');
  check('graduates from the region with ≥2 (aa)', r?.id === 'a1');
}

// 4. Vitality floor: a fresh report BELOW the safe floor is not eligible on
//    vitality (and a fresh report means no uptime fallback).
{
  const cands = [
    cand({ id: 'weak', region: 'aa', meshBound: 2 }),   // below floor 4
    cand({ id: 'weak2', region: 'aa', meshBound: 3 }),  // below floor 4
  ];
  const r = selectGraduate(cands, OPTS);
  check('sub-floor reporters are not graduated', r === null);
}

// 5. Uptime fallback: no fresh report + old enough → eligible via uptime.
{
  const cands = [
    cand({ id: 'u1', region: 'aa', meshBound: null, since: NOW - 40_000 }),
    cand({ id: 'u2', region: 'aa', meshBound: null, since: NOW - 40_000 }),
  ];
  const r = selectGraduate(cands, OPTS);
  check('falls back to uptime when meshBound is absent', r?.basis === 'uptime');
  check('a too-young no-report peer is NOT eligible',
    selectGraduate([cand({ region: 'aa', meshBound: null, since: NOW - 5_000 }),
                    cand({ id: 'y', region: 'aa', meshBound: null, since: NOW - 5_000 })], OPTS) === null);
}

// 6. Known-redundant beats a guess: a fresh above-floor reporter is graduated
//    before an uptime-fallback peer in the same region.
{
  const cands = [
    cand({ id: 'known', region: 'aa', meshBound: 5 }),
    cand({ id: 'guess', region: 'aa', meshBound: null, since: NOW - 90_000 }),
  ];
  const r = selectGraduate(cands, OPTS);
  check('measured-redundant peer preferred over uptime guess', r?.id === 'known');
}

// 7. Hard ceiling: a long-held slot graduates even below the vitality floor,
//    bounding a peer that under-reports to keep its slot.
{
  const cands = [
    cand({ id: 'hog', region: 'aa', meshBound: 0, since: NOW - 700_000 }),  // past 600s ceiling
    cand({ id: 'a2',  region: 'aa', meshBound: 0, since: NOW - 10_000 }),   // young, sub-floor → not eligible
  ];
  const r = selectGraduate(cands, OPTS);
  check('ceiling graduates a long-held under-reporter', r?.id === 'hog');
  check('basis is ceiling', r?.basis === 'ceiling');
}

// 8. Nothing eligible → null (kernel gate, cooldown, unbound).
{
  const cands = [
    cand({ id: 'old',  region: 'aa', kernelOk: false }),
    cand({ id: 'cd',   region: 'aa', inCooldown: true }),
    cand({ id: 'unb',  region: null }),
  ];
  check('returns null when nothing is eligible', selectGraduate(cands, OPTS) === null);
}

// 9. Empty input → null, no throw.
check('empty candidate list → null', selectGraduate([], OPTS) === null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
