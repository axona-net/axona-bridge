// =====================================================================
// fence_diag_role_fields.mjs — /diag's role rows must read fields that EXIST.
//
// THE DEFECT THIS GUARDS (found 2026-09-24). The /diag role block built its own
// row per role by hand and read three names the kernel has never had:
//     role.replayCache      the field is `cache`; replayCacheSize is a
//                           CONSTRUCTOR OPTION, not a role field
//     role.roleCreatedAt    the field is `createdAt`
//     role.emptiedAt        no such field anywhere in the kernel
// JavaScript answers `undefined` and the mapper turned that into `0` and
// `null`, so every role on every bridge had reported cacheSize 0 and null ages
// for as long as the endpoint existed. On 2026-09-23 I used that zero in public
// to argue that a production bridge held "141 roles with ZERO cached messages".
// It was a missing property, not a measurement. A diagnostic that cannot be
// wrong out loud is worse than no diagnostic.
//
// THE RULE. /diag reads roles through the kernel's own accessor,
// `inspectRoles()`, which is maintained beside the role shape. This fence pulls
// the property names the mapper actually reads OUT OF THE SOURCE and checks
// each one against a row from a REAL AxonaManager holding a REAL makeRole role.
// Add a field to the mapper and the check follows it; rename one in the kernel
// and this fails before a deploy does.
//
// Run: node test/fence_diag_role_fields.mjs
// =====================================================================

import { readFileSync } from 'node:fs';
import { AxonaManager } from '@axona/protocol/pubsub/AxonaManager.js';
import { makeRole } from '@axona/protocol/pubsub/rootClaim.js';
import { depositDispatchCapability } from '@axona/protocol/registry/index.js';
// The real constant, never a literal: this fence's whole claim is about what
// the rollups compare against, and a copied 60_000 would keep passing after the
// kernel moved the window.
import { BACKUP_EVICT_MS } from '@axona/protocol/pubsub/constants.js';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) { console.log(`  ok ${++n} - ${m}`); }
  else   { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const D_START = SERVER.indexOf("if (req.url === '/diag')");
const D_END   = SERVER.indexOf("if (req.url === '/')", D_START);
if (D_START < 0 || D_END < 0) {
  console.error('  ✗ could not locate the /diag handler — fence cannot run'); process.exit(1);
}
// Strip line comments before any content assertion: the comment above the role
// block NAMES all three dead fields on purpose, and matching prose is not
// testing code.
const DIAG = SERVER.slice(D_START, D_END).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// ── a real kernel, a real role ────────────────────────────────────────────
const SELF = (0x89n << 248n) | 0x3000n;
const hex  = (b) => b.toString(16).padStart(66, '0');
const dht = {
  verdictsSupported: true,
  routeMessage: async () => ({ consumed: false }),
  getSelfId: () => hex(SELF),
  onRoutedMessage() {}, onDirectMessage() {},
  neighbors: () => [], bridgeId: () => null,
  isTransit: () => false, isIntroduction: () => false, introductionIds: () => [],
};
depositDispatchCapability(dht, { routed: () => {} });
const axon = new AxonaManager({ dht });
axon._log = () => {};

const TOPIC = 0x4242n;
const role = makeRole(TOPIC, true, Date.now());
role.subscribers.set('a'.repeat(66), { since: 0, lastRenewed: Date.now() });
role.subscribers.set('b'.repeat(66), { since: 0, lastRenewed: Date.now() });
role.children.add('a'.repeat(66));
role.cache.push({ msgId: 'm0', publishTs: Date.now(), json: '{}', bytes: 80 });
role.cacheIds.add('m0');
axon.axonRoles.set(TOPIC, role);

const rows = axon.inspectRoles();
ok('inspectRoles() returns one row for the seeded role', rows.length === 1, String(rows.length));
const row = rows[0] || {};

// ── 1. every property the mapper reads exists on a real row ───────────────
{
  const block = DIAG.slice(DIAG.indexOf('inspectRoles()'), DIAG.indexOf(': []'));
  const read = [...new Set([...block.matchAll(/\br\.(\w+)/g)].map(m => m[1]))];
  ok('the mapper reads at least five role properties', read.length >= 5, read.join(','));
  for (const f of read) {
    ok(`inspectRoles() actually provides \`${f}\``, Object.hasOwn(row, f) && row[f] !== undefined,
      `got ${JSON.stringify(row[f])}`);
  }
}

// ── 2. the three dead names are gone from the handler ─────────────────────
for (const dead of ['replayCache\\b(?!Size)', 'roleCreatedAt', 'emptiedAt']) {
  ok(`/diag no longer reads \`${dead.replace('\\b(?!Size)', '')}\``, !new RegExp(dead).test(DIAG));
}
// …and the kernel really does not have them, which is why they were always
// undefined. If a future kernel introduces one, this fence should be revisited
// deliberately rather than quietly passing.
for (const dead of ['replayCache', 'roleCreatedAt', 'emptiedAt']) {
  ok(`a real role has no \`${dead}\` field`, !Object.hasOwn(role, dead));
}

// ── 3. the values are REAL, not structurally-correct zeros ────────────────
ok('subscribers is the seated COUNT', row.subscribers === 2, String(row.subscribers));
ok('children is the child list (a count on the wire)', Array.isArray(row.children) && row.children.length === 1,
  JSON.stringify(row.children));
ok('replayCacheSize follows role.cache and is NON-ZERO when the role holds a message',
  row.replayCacheSize === 1, String(row.replayCacheSize));
ok('nature and holder are present', typeof row.nature === 'string' && typeof row.holder === 'boolean',
  `${row.nature}/${row.holder}`);
ok('/diag publishes children as a COUNT, never node ids', /children:\s*r\.children\.length/.test(DIAG));

// ── 4. the subscriber rollups and the reap counters are on the body ───────
for (const key of ['axonRolesSubscribed', 'axonRolesUnsubscribed', 'axonSubscribers', 'axonRolesCaching']) {
  ok(`/diag counts carry \`${key}\``, new RegExp(`${key}:`).test(DIAG));
}
ok('/diag lifts the reap counters to the top level', /^\s*reaped,\s*$/m.test(DIAG));
{
  // The counters themselves: a climbing role count is ambiguous unless an
  // operator can see whether the reaper is firing at all.
  const adm = axon.inspectAdmission();
  ok('inspectAdmission() carries a reaped block', !!adm.reaped, JSON.stringify(adm.reaped));
  ok('…with numeric dead and idle counters',
    typeof adm.reaped?.dead === 'number' && typeof adm.reaped?.idle === 'number', JSON.stringify(adm.reaped));
}

// ── 5. lastReplicaAt: NEVER and LONG AGO must not read alike ──────────────
// Added 2026-09-25. The standby-population question — is a given empty backup
// waiting on a live principal or a departed one — was unanswerable from outside
// the process because this stamp was not on any surface. Every claim made about
// those roles rested on inference. The trap the fence exists for: `0` means
// never stamped, and `now - 0` is an age of fifty-six years, which would read as
// the stalest possible backup rather than as no reading at all.
{
  ok('a never-stamped role reports lastReplicaAt 0', row.lastReplicaAt === 0, String(row.lastReplicaAt));
  ok('…and its age is NULL, not a number measured from the epoch',
    row.lastReplicaAgeMs === null, JSON.stringify(row.lastReplicaAgeMs));

  // A stamped backup, on a clock we control, so the age is checked against a
  // known elapsed time rather than against whatever Date.now() happened to be.
  let clock = 1_000_000;
  const axon2 = new AxonaManager({ dht, now: () => clock });
  axon2._log = () => {};
  const T2 = 0x99n;
  const backup = makeRole(T2, false, clock);
  backup.backupOf = 'c'.repeat(66);          // nature: backup
  backup.lastReplicaAt = clock;              // principal just spoke
  axon2.axonRoles.set(T2, backup);

  const fresh = axon2.inspectRoles()[0];
  ok('a just-stamped backup has nature backup', fresh.nature === 'backup', fresh.nature);
  ok('…and age 0 at the instant of the stamp', fresh.lastReplicaAgeMs === 0, String(fresh.lastReplicaAgeMs));

  clock += 45_000;
  ok('…the age tracks the clock (45s later reads 45000)',
    axon2.inspectRoles()[0].lastReplicaAgeMs === 45_000, String(axon2.inspectRoles()[0].lastReplicaAgeMs));

  clock += 30_000;                            // 75s total: past BACKUP_EVICT_MS
  const stale = axon2.inspectRoles()[0];
  ok('…and keeps climbing past the discharge window', stale.lastReplicaAgeMs === 75_000, String(stale.lastReplicaAgeMs));
  ok('…while lastReplicaAt stays the STAMP, not the age', stale.lastReplicaAt === 1_000_000, String(stale.lastReplicaAt));

  // A clock that steps backwards (NTP correction) must not yield a negative age.
  clock = 999_000;
  ok('a backwards clock floors the age at 0, never negative',
    axon2.inspectRoles()[0].lastReplicaAgeMs === 0, String(axon2.inspectRoles()[0].lastReplicaAgeMs));
}

// ── 6. /diag ships the threshold and the standby split ────────────────────
ok('/diag publishes backupEvictMs beside the ages', /backupEvictMs:/.test(DIAG));
for (const key of ['backupsFresh', 'backupsStale', 'backupsNever']) {
  ok(`/diag counts carry \`${key}\``, new RegExp(`${key}:`).test(DIAG));
}
// NEVER is counted off the stamp, not off the age, so it cannot be folded into
// STALE by an age comparison that treats null as large.
ok('backupsNever tests lastReplicaAt === 0, not the age',
  /backupsNever:[^\n]*lastReplicaAt === 0/.test(DIAG));
ok('backupsStale excludes null ages explicitly',
  /backupsStale:[^\n]*lastReplicaAgeMs != null/.test(DIAG));

// ── 7. A RETIRED backup keeps its stamp — the age becomes a FOSSIL ────────
// Added 2026-09-27, from a real misreading of production. becomeBackup()
// stamps lastReplicaAt; retireBackup() clears backupOf and _backupTopics and
// leaves the stamp alone. So a role that finished its standby life goes on
// ageing a clock nobody winds. West showed nature=child at an age of 28.7 h
// against a 60 s window, and the obvious reading — a standby stale for over a
// day — was exactly backwards: that role's discharge path had WORKED.
//
// The rollups are right because they filter on nature === 'backup'. This fence
// pins the DISAGREEMENT itself: the nature-blind count and the nature-filtered
// count must differ on this role. Drop the nature filter from either rollup and
// the two counts converge and this fails. Stop producing the fossil and it also
// fails, at the line that says the stamp survived — which is the honest signal
// that the comment above the field needs rewriting, not that the test is stale.
{
  let clock = 5_000_000;
  const axon3 = new AxonaManager({ dht, now: () => clock });
  axon3._log = () => {};
  const T3 = 0xabn;
  const role3 = makeRole(T3, false, clock);
  axon3.axonRoles.set(T3, role3);

  // REAL transitions, not hand-set fields: a fence that assigns backupOf itself
  // proves nothing about the functions that assign it in production.
  axon3._rootClaim.becomeBackup(T3, role3, 'd'.repeat(66));
  const stampedAt = role3.lastReplicaAt;
  ok('becomeBackup stamps the role', stampedAt === 5_000_000, String(stampedAt));

  clock += 100_000;                              // well past BACKUP_EVICT_MS
  axon3._rootClaim.retireBackup(T3, role3, 'rehomed-idle');

  const fossil = axon3.inspectRoles()[0];
  ok('retireBackup drops the backup nature', fossil.nature !== 'backup', fossil.nature);
  ok('…but the stamp SURVIVES retirement', fossil.lastReplicaAt === stampedAt,
    `${fossil.lastReplicaAt} vs ${stampedAt}`);
  ok('…so the age keeps climbing past the window on a non-backup',
    fossil.lastReplicaAgeMs === 100_000, String(fossil.lastReplicaAgeMs));

  // The discriminating pair. These two numbers MUST NOT agree.
  const rows = axon3.inspectRoles();
  const natureBlindStale = rows.filter(r =>
    r.lastReplicaAgeMs != null && r.lastReplicaAgeMs > BACKUP_EVICT_MS).length;
  const natureFilteredStale = rows.filter(r =>
    r.nature === 'backup' && r.lastReplicaAgeMs != null && r.lastReplicaAgeMs > BACKUP_EVICT_MS).length;
  ok('a nature-BLIND stale scan counts the fossil', natureBlindStale === 1, String(natureBlindStale));
  ok('…while the rollup, filtered on nature, does NOT', natureFilteredStale === 0, String(natureFilteredStale));
  ok('…and the two therefore disagree, which is the whole point',
    natureBlindStale !== natureFilteredStale, `${natureBlindStale} vs ${natureFilteredStale}`);

  // The pair above pins the SEMANTICS against a real kernel. It does not pin
  // the ENDPOINT — strip the nature filter out of server.js and every check so
  // far still passes while /diag starts reporting fossils as stale standbys.
  // So assert the filter in the source too, per rollup.
  for (const key of ['backupsFresh', 'backupsStale', 'backupsNever']) {
    ok(`${key} filters on nature === 'backup' in the source`,
      new RegExp(`${key}:[^\\n]*nature === 'backup'`).test(DIAG));
  }
}

console.log(fail ? `\n  ${fail} FAILED` : `\n  all ${n} checks passed`);
process.exit(fail ? 1 : 0);
