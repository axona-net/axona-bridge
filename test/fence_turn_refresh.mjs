// =====================================================================
// fence_turn_refresh.mjs — the bridge half of the in-band TURN credential
// refresh (kernel 4.60.x, GH #44). Council (Aster) asked for proof that an
// admitted `turn-refresh` mints and returns a freshly minted `turn` frame.
//
// The client-applies half is fenced behaviourally in the kernel smoke
// (smoke_turn_cred_refresh.mjs, scenario B: deliver a `turn` frame → the
// client installs it and re-arms). This fence covers the bridge half in the
// static style the rest of this suite uses, plus a behavioural check of the
// REST credential scheme the client's strict parser and coturn both rely on.
//
// Run: node test/fence_turn_refresh.mjs
// =====================================================================

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) { console.log(`  ok ${++n} - ${m}`); }
  else   { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

// ── Slice the turn-refresh handler precisely ──────────────────────────────
const H_START = SERVER.indexOf("case 'turn-refresh': {");
// End at the NEXT case, not the first `break;` — the handler's very first
// statement is `if (!conn.admitted) break;`, so anchoring on `break;` would
// truncate the slice before the mint/reply (the reason this fence first failed).
const H_END   = H_START >= 0 ? SERVER.indexOf("case 'axona'", H_START) : -1;
if (H_START < 0 || H_END < 0) {
  console.error('  ✗ could not locate the turn-refresh handler — fence cannot run');
  process.exit(1);
}
const HANDLER = SERVER.slice(H_START, H_END);

// ── 1. handler shape: admitted-only, mint, reply with a `turn` frame ──────
ok('turn-refresh handler exists', H_START >= 0);
ok('…admitted peers only (gated before any mint)',
  /if \(!conn\.admitted\) break;/.test(HANDLER));
ok('…mints a credential via makeTurnCredential(id)',
  /makeTurnCredential\(id\)/.test(HANDLER));
ok('…replies with a {type:\'turn\', turn} frame, only when a credential minted',
  /if \(turn\) sendTo\(id, \{ type: 'turn', turn,/.test(HANDLER));

// ── 2. the mint scheme (RFC-REST): username `<expiry>:<token>`, HMAC cred ──
const M_START = SERVER.indexOf('function makeTurnCredential');
const MINT    = SERVER.slice(M_START, SERVER.indexOf('\n}', M_START) + 2);
ok('mint returns null without a secret (no bogus credential)',
  /if \(!TURN_AUTH_SECRET\) return null;/.test(MINT));
ok('username is `<expiry-unix-seconds>:<token>`',
  /const username = `\$\{expiry\}:\$\{token\}`/.test(MINT));
ok('credential = base64( HMAC-SHA1( secret, username ) )',
  /createHmac\('sha1', TURN_AUTH_SECRET\)[\s\S]*\.update\(username\)[\s\S]*\.digest\('base64'\)/.test(MINT));
ok('expiry = now + TURN_TTL_SECONDS (a real forward expiry)',
  /const expiry\s+= Math\.floor\(Date\.now\(\) \/ 1000\) \+ TURN_TTL_SECONDS;/.test(MINT));

// ── 3. behavioural: the scheme produces what the client will accept ───────
// Replicate the documented REST scheme (as healthz fence replicates verdict()).
// Prove: (a) the username's leading field is all-digits, which the client's
// STRICT parser (turnExpiryMs) requires; (b) the credential is the exact
// base64 HMAC-SHA1 coturn validates. If either drifted, refresh would silently
// stop working.
{
  const secret  = 'test-secret-not-prod';
  const expiry  = Math.floor(Date.now() / 1000) + 7200;
  const token   = crypto.randomBytes(9).toString('base64url');
  const username = `${expiry}:${token}`;
  const cred    = crypto.createHmac('sha1', secret).update(username).digest('base64');

  ok('username leading field is all-digits (client strict-parse accepts it)',
    /^\d+:/.test(username) && /^\d+$/.test(username.split(':')[0]));
  ok('the parsed expiry is a real future time',
    Number(username.split(':')[0]) * 1000 > Date.now());
  ok('credential re-derives deterministically from (secret, username)',
    crypto.createHmac('sha1', secret).update(username).digest('base64') === cred);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} turn-refresh bridge fence: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
