/**
 * check_kernel_pin — the DECLARED kernel pin must equal the INSTALLED artifact.
 *
 * This exists because of a real incident: axona-share published kernel 4.38.0 to
 * the public web for weeks while its package.json read `#v4.41.0`. Nothing was
 * lying — the pin, the lockfile, and the installed tree simply disagreed, and the
 * only one that reaches users is the installed tree.
 *
 * Three places state a version, and a release is only safe when all three match:
 *
 *   1. package.json      "@axona/protocol": "github:…#vX.Y.Z"   ← what we MEANT
 *   2. package-lock.json resolved commit + "version"            ← what npm WILL install
 *   3. node_modules/…/handshake.js  KERNEL_VERSION              ← what ACTUALLY ships
 *
 * (2) is the one that decides, because `npm ci` obeys the lockfile exactly and
 * ignores a changed pin in (1). That makes a stale lockfile silently authoritative
 * forever: the manifest reads correct while the artifact is wrong. Which is
 * exactly how nobody noticed.
 *
 * Run this in `npm test` AND in the deploy workflow before the site is assembled,
 * so the failure mode is a red build instead of a quiet mis-ship.
 *
 * Fix when it fails:
 *     rm -rf node_modules/@axona/protocol
 *     # drop the stale "resolved"/"integrity" from the lockfile entry, then
 *     npm install            # (--legacy-peer-deps where the repo needs it)
 */

import { readFileSync, existsSync } from 'node:fs';

const PKG  = 'package.json';
const LOCK = 'package-lock.json';
const INSTALLED = 'node_modules/@axona/protocol/src/transport/handshake.js';

const fail = (msg) => { console.error(`\ncheck_kernel_pin: ${msg}\n`); process.exit(1); };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// ── 1. declared pin ──────────────────────────────────────────────────────
const pkg = JSON.parse(read(PKG) ?? '{}');
const spec = pkg.dependencies?.['@axona/protocol'] ?? pkg.devDependencies?.['@axona/protocol'];
if (!spec) { console.log('check_kernel_pin: no @axona/protocol dependency — nothing to check'); process.exit(0); }

const declared = spec.match(/#v?(\d+\.\d+\.\d+)/)?.[1];
if (!declared) fail(`cannot read a version out of the pin ${JSON.stringify(spec)} — pin by tag (…#vX.Y.Z) so it is checkable`);

// ── 2. what the lockfile will actually install ───────────────────────────
const lockRaw = read(LOCK);
if (!lockRaw) fail(`${LOCK} is missing — a git-pinned dependency without a lockfile is unreproducible`);
const lock = JSON.parse(lockRaw);
const entry = Object.entries(lock.packages ?? {}).find(([k]) => k.endsWith('node_modules/@axona/protocol'))?.[1];
if (!entry) fail(`${LOCK} has no @axona/protocol entry — run npm install so the pin is recorded`);
const locked = entry.version ?? null;

// ── 3. what is actually on disk and will ship ────────────────────────────
if (!existsSync(INSTALLED)) fail(`${INSTALLED} is missing — install before checking (the point is to inspect the ARTIFACT, not the manifest)`);
const installed = read(INSTALLED)?.match(/KERNEL_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
if (!installed) fail(`could not read KERNEL_VERSION out of ${INSTALLED}`);

// ── verdict ──────────────────────────────────────────────────────────────
const rows = [
  ['declared  (package.json pin)', declared],
  ['locked    (package-lock.json)', locked],
  ['INSTALLED (node_modules)', installed],
];
const agree = locked === declared && installed === declared;
if (!agree) {
  console.error('\ncheck_kernel_pin: KERNEL PIN MISMATCH — the version you declared is not the version that ships.\n');
  for (const [label, v] of rows) console.error(`  ${label.padEnd(30)} ${v ?? '(none)'}`);
  if (locked !== declared) console.error(`\n  → the LOCKFILE disagrees, and npm ci obeys the lockfile. This is the one that ships.`);
  if (installed !== declared) console.error(`  → the INSTALLED tree disagrees. Reinstall after clearing the stale resolved/integrity.`);
  console.error(`\n  Fix: rm -rf node_modules/@axona/protocol, drop "resolved"/"integrity" from the`);
  console.error(`       lockfile entry, then npm install. Re-run this check — do not trust package.json.\n`);
  process.exit(1);
}

console.log(`check_kernel_pin: declared = locked = installed = ${declared} ✓`);
