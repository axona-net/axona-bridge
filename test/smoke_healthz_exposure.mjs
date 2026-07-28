// =====================================================================
// smoke_healthz_exposure.mjs — RULE 14 FENCE: "a health surface must be able
// to report ill health" — plus the exposure split that makes that safe.
//
// THE DEFECT THIS GUARDS (N4, found 2026-07-28). GET /healthz returned, in full:
//     { "status": "ok", "version": "…", "kernelVersion": "…" }
// `status` was the literal string 'ok', unconditionally, forever. So the two
// severest findings of the 4.48.0 review — F1 (a neverRoot node's refresh tick
// dying silently, armed on BOTH prod bridges) and F6/N1 (helloPressure latching
// permanently after one stall) — were, on our own production infrastructure,
// completely unobservable from outside.
//
// THE EXPOSURE DECISION (review pass 6, amendment 3). Roles, capacity and
// refusal counts say WHERE and WHEN placement pressure would succeed, which is
// exactly what the E-1 placement-defence work asks us not to publish. So:
//   · PUBLIC   — one derived verdict: ok | degraded | unknown. Nothing else.
//   · OPERATOR — the full admission block, behind the existing token.
//
// WHAT THIS FENCE ASSERTS
//   1. the public body carries ONLY {status, version, kernelVersion}
//   2. `status` tracks saturation — it can say 'degraded', and does
//   3. an absent/older kernel reads 'unknown', never 'ok' (no false health)
//   4. the admission detail NEVER appears without the operator token
//   5. the operator token check is constant-time and fails CLOSED
//
// Run: node test/smoke_healthz_exposure.mjs
// =====================================================================

import { readFileSync } from 'node:fs';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) { console.log(`  ok ${++n} - ${m}`); }
  else   { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const NODE   = readFileSync(new URL('../src/bridge_axona_node.js', import.meta.url), 'utf8');

// Slice the /healthz handler out precisely. Anchoring on the first `} else {`
// in the file finds an unrelated branch hundreds of lines earlier — the reason
// this fence failed on its first run.
const HZ_START = SERVER.indexOf("if (req.url === '/healthz')");
const HZ_END   = SERVER.indexOf("if (req.url === '/diag')");
if (HZ_START < 0 || HZ_END < 0 || HZ_END < HZ_START) {
  console.error('  ✗ could not locate the /healthz handler — fence cannot run'); process.exit(1);
}
const HEALTHZ  = SERVER.slice(HZ_START, HZ_END);
const SPLIT    = HEALTHZ.indexOf('} else {');
// Strip line comments before any content assertion: the rationale comments in
// this handler necessarily NAME the fields they are explaining ("roles,
// capacity and refusal counts…"), and matching those is testing prose rather
// than code — the second reason this fence failed while the code was correct.
const code     = (s) => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const UNAUTHED = code(HEALTHZ.slice(0, SPLIT));
const AUTHED   = code(HEALTHZ.slice(SPLIT));

// ── 1. the public body is exactly three fields ────────────────────────────
{
  const m = SERVER.match(/body = JSON\.stringify\(\{ status: publicStatus, version: VERSION, kernelVersion: KERNEL_VERSION \}\)/);
  ok('public /healthz body is {status, version, kernelVersion} and nothing more', !!m);
  // The detail must not be reachable on the unauthenticated branch. The
  // `admission` key may appear only inside the authed body.
  ok('the unauthenticated branch never mentions admission detail',
    !/admission|roles|refusals|capacity/.test(UNAUTHED));
}

// ── 2+3. status is DERIVED, and unknown is not ok ─────────────────────────
{
  ok('status is derived from admission, not a literal',
    /const publicStatus = adm === null \? 'unknown' : \(degraded \? 'degraded' : 'ok'\)/.test(SERVER));
  ok('degraded is driven by kernel saturation',
    /const degraded = adm \? adm\.saturated === true : false/.test(SERVER));
  ok("a missing admission surface reads 'unknown', never 'ok'",
    /adm === null \? 'unknown'/.test(SERVER));
  ok('the AUTHED body reports the same verdict (one source of truth)',
    /status:\s+publicStatus,/.test(SERVER));

  // Behavioural check of the derivation itself, independent of the HTTP layer.
  const verdict = (adm) => (adm === null ? 'unknown' : (adm.saturated === true ? 'degraded' : 'ok'));
  ok('verdict(saturated)   === degraded', verdict({ saturated: true })  === 'degraded');
  ok('verdict(healthy)     === ok',       verdict({ saturated: false }) === 'ok');
  ok('verdict(no kernel)   === unknown',  verdict(null)                 === 'unknown');
}

// ── 4. the detail is operator-gated ───────────────────────────────────────
{
  ok('the admission block lives ONLY in the authed branch',
    /admission: adm,/.test(AUTHED) && !/admission: adm,/.test(UNAUTHED));
  ok('bridge exposes admission via the cheap kernel call, not full health()',
    /inspectAdmission\?\.\(\)/.test(NODE) && !/health\(\)\?\.admission/.test(NODE));
  ok('getAdmission returns null (=unknown) rather than throwing', /catch \{ return null; \}/.test(NODE));
}

// ── 5. the token check is constant-time and closed by default ─────────────
{
  ok('a single operatorAuthed() helper exists', /function operatorAuthed\(req\)/.test(SERVER));
  ok('…using timingSafeEqual', /crypto\.timingSafeEqual\(/.test(SERVER));
  ok('…over fixed-size digests (no length oracle)', /createHash\('sha256'\)/.test(SERVER));
  ok('…failing CLOSED when no token is configured', /if \(!HEALTHZ_TOKEN\) return false;/.test(SERVER));
  // The old timing-unsafe comparisons must be gone from BOTH call sites.
  const legacy = SERVER.match(/req\.headers\['x-healthz-token'\]\s*[!=]==\s*HEALTHZ_TOKEN/g) || [];
  ok('no direct === token comparison remains', legacy.length === 0, `found ${legacy.length}`);
  ok('both /healthz and /diag route through the helper',
    (SERVER.match(/operatorAuthed\(req\)/g) || []).length >= 2);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} healthz exposure: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
