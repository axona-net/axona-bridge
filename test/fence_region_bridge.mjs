// fence_region_bridge.mjs — 2.129.0: BRIDGE_REGION fails closed on a kernel that ignores the override, and the
// directory region set gains 'bridge' + the compatibility copy only under BRIDGE_REGION=bridge. No network.
//
// Four layers, from the helper up to the real startup path (Aster CP 22a7023e #2, Vega 3cd6bede):
//   1. assertRegionApplied on stub ids (the guard's own contract).
//   2. startDirectoryPublisher with a FAKE peer: the regions actually published to and subscribed in,
//      under BRIDGE_REGION=bridge and when unset, east and west; one publish per region CODE ('useast' and
//      'eagle' are one region).
//   3. The REAL loadOrDeriveIdentity in a child process against the INSTALLED kernel, whatever the pin
//      is today: below 4.88.0, BRIDGE_REGION=bridge refuses to start with the fail-closed message; at or
//      above it, the same child comes up with an 'ff' id. Unset mints a geo id on any kernel; nothing is
//      written to the child's cwd or HOME in any case. (Refusal was exercised at pin 4.87.0; the success
//      path at pin 4.88.0.)
//   4. Derivability of the 'bridge' directory on the installed kernel, version-conditioned the same way.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KERNEL_VERSION, deriveTopicId, resolveRegion, BRIDGE_DIRECTORY_TOPIC } from '@axona/protocol';
import { assertRegionApplied, REGION_BYTE_BY_NAME } from '../src/identity.js';
import { startDirectoryPublisher, DIRECTORY_SYSTEM_REGION, DIRECTORY_COMPAT_REGIONS } from '../src/bridge_directory.js';

let n = 0, failed = 0;
const ok = (m, c = true) => { if (c) { n++; console.log('  ok ' + m); } else { failed++; console.log('  ✗  ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vparts = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
const atLeast = (v, want) => { const a = vparts(v), b = vparts(want); for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; } return true; };
const KERNEL_HONOURS_OVERRIDE = atLeast(KERNEL_VERSION, '4.88.0');
console.log(`installed kernel ${KERNEL_VERSION} (honours the region override: ${KERNEL_HONOURS_OVERRIDE})`);

console.log('\n[1] assertRegionApplied — the guard\'s own contract (stub ids)');
assertRegionApplied('89' + 'a'.repeat(64), null); ok('unset BRIDGE_REGION: any byte accepted');
assertRegionApplied('ff' + 'a'.repeat(64), 'bridge'); ok("BRIDGE_REGION=bridge with an 0xff id: accepted");
assert.throws(() => assertRegionApplied('89' + 'a'.repeat(64), 'bridge'), /does not honour the region override|needs @axona\/protocol >= 4\.88\.0/); ok('BRIDGE_REGION=bridge with a geo id: refuses to start (kernel < 4.88.0)');
assert.throws(() => assertRegionApplied('ff' + 'a'.repeat(64), 'mars'), /not a region this bridge knows/); ok('unknown BRIDGE_REGION value: refused');
assert.equal(REGION_BYTE_BY_NAME.bridge, 'ff'); assert.equal(DIRECTORY_SYSTEM_REGION, 'bridge'); assert.deepEqual([...DIRECTORY_COMPAT_REGIONS], ['useast']); ok("constants: bridge → 0xff; compat copy = ['useast']");

console.log('\n[2] startDirectoryPublisher with a fake peer — which regions the directory is published to and subscribed in');
function fakePeer() {
  const pubs = [], subs = [];
  return {
    pubs, subs,
    peers() { return ['p0', 'p1', 'p2']; },
    async pub(topic, entry, opts) { pubs.push({ topic, entry, signed: !!opts?.signWith }); },
    async sub(topic) { subs.push(topic); return { stop() {} }; },
    async setAuthorClass() {},
  };
}
const fakeBook = { entries: () => [], merge: () => false, count: 0 };
const env = { BRIDGE_DIRECTORY: 'on', BRIDGE_PUBLIC_URL: 'wss://fence-test.example', BRIDGE_DIRECTORY_MIN_UPTIME_MS: '0', BRIDGE_DIRECTORY_MIN_PEERS: '3', BRIDGE_DIRECTORY_POLL_MS: '20' };
async function regionsFor(identity) {
  const peer = fakePeer(); const events = [];
  const pub = startDirectoryPublisher({ peer, identity, version: 'test', env, book: fakeBook, log: (e, d) => events.push([e, d]) });
  for (let i = 0; i < 50 && !events.some(([e]) => e === 'published'); i++) await sleep(20);
  await sleep(60);                                   // let the subscribe loop run after the publish
  pub.stop();
  return { pubs: peer.pubs, subs: peer.subs, events };
}
const east = { lat: 38, lng: -77, label: 'east' };
{
  const { pubs, subs, events } = await regionsFor({ region: { ...east, requested: 'bridge' } });
  const regions = pubs.map((p) => p.topic.region);
  ok(`east + BRIDGE_REGION=bridge: published to exactly ['eagle','bridge'] (got ${JSON.stringify(regions)})`, JSON.stringify(regions) === JSON.stringify(['eagle', 'bridge']));
  ok("…'useast' is the SAME region as the east bridge's own 'eagle' (one publish, not two of one topic id)", resolveRegion('useast') === resolveRegion('eagle') && regions.filter((r) => resolveRegion(r) === 0x89).length === 1);
  ok('…every publish names the directory topic and is signed', pubs.every((p) => p.topic.name === BRIDGE_DIRECTORY_TOPIC && p.signed));
  ok('…the entry carries the bridge location and URL', pubs.every((p) => p.entry.lat === 38 && p.entry.lng === -77 && p.entry.url === env.BRIDGE_PUBLIC_URL));
  ok(`…and it subscribes in the same regions (got ${JSON.stringify(subs.map((s) => s.region))})`, JSON.stringify(subs.map((s) => s.region)) === JSON.stringify(['eagle', 'bridge']));
  ok('…no publish-failed with the fake peer', !events.some(([e]) => e === 'publish-failed'));
}
{
  const { pubs, subs } = await regionsFor({ region: { ...east } });
  ok(`east, BRIDGE_REGION unset: published to exactly ['eagle'] — unchanged geo behaviour (got ${JSON.stringify(pubs.map((p) => p.topic.region))})`, JSON.stringify(pubs.map((p) => p.topic.region)) === JSON.stringify(['eagle']));
  ok("…never 'bridge' when not requested", !pubs.some((p) => p.topic.region === 'bridge') && !subs.some((s) => s.region === 'bridge'));
}
{
  const { pubs } = await regionsFor({ region: { ...east, requested: null } });
  ok('east, requested: null: same as unset', JSON.stringify(pubs.map((p) => p.topic.region)) === JSON.stringify(['eagle']));
}
{
  const west = { lat: 37.4, lng: -122.1, label: 'west' };
  const { pubs } = await regionsFor({ region: { ...west, requested: 'bridge' } });
  const regions = pubs.map((p) => p.topic.region);
  ok(`west + BRIDGE_REGION=bridge: published to ['grizzly','bridge','useast'] — its own region, the system region, the compat copy (got ${JSON.stringify(regions)})`, JSON.stringify(regions) === JSON.stringify(['grizzly', 'bridge', 'useast']));
  const { pubs: pubsUnset } = await regionsFor({ region: { ...west } });
  ok("west, unset: ['grizzly'] only", JSON.stringify(pubsUnset.map((p) => p.topic.region)) === JSON.stringify(['grizzly']));
}

console.log('\n[3] the REAL startup path: loadOrDeriveIdentity in a child process against the installed kernel');
const identitySrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'identity.js');
function startChild(extraEnv) {
  const cwd = mkdtempSync(join(tmpdir(), 'fence-region-bridge-'));
  const script = `import { loadOrDeriveIdentity } from ${JSON.stringify(pathToFileURL(identitySrc).href)};\n` +
    `const id = await loadOrDeriveIdentity();\n` +
    `console.log(JSON.stringify({ idHex: id.idHex, requested: id.region.requested, lat: id.region.lat, lng: id.region.lng }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { HOME: cwd, BRIDGE_LAT: '38', BRIDGE_LNG: '-77', ...extraEnv },   // minimal: no inherited BRIDGE_* leaks in
  });
  const written = readdirSync(cwd);
  rmSync(cwd, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', written, timedOut: !!r.error };
}
{
  const r = startChild({});
  ok(`unset BRIDGE_REGION: the child starts (exit ${r.status})`, r.status === 0 && !r.timedOut);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not json */ }
  ok('…mints a geo id (0x89 for 38,-77) with region.requested null', out?.idHex?.startsWith('89') && out?.requested === null && out?.lat === 38);
  ok('…and writes nothing (no persisted identity in cwd/HOME)', r.written.length === 0);
}
{
  const r = startChild({ BRIDGE_REGION: 'bridge' });
  if (!KERNEL_HONOURS_OVERRIDE) {
    ok(`BRIDGE_REGION=bridge on kernel ${KERNEL_VERSION}: the child REFUSES to start (exit ${r.status})`, r.status !== 0 && !r.timedOut);
    ok('…with the fail-closed message naming the kernel requirement', /does not honour the region override/.test(r.stderr) && /4\.88\.0/.test(r.stderr));
    ok('…and never printed an identity', !/idHex/.test(r.stdout));
  } else {
    ok(`BRIDGE_REGION=bridge on kernel ${KERNEL_VERSION}: the child starts (exit ${r.status})`, r.status === 0 && !r.timedOut);
    let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not json */ }
    ok("…with an 'ff' id and region.requested 'bridge'", out?.idHex?.startsWith('ff') && out?.requested === 'bridge');
  }
  ok('…and writes nothing either way', r.written.length === 0);
}
{
  const r = startChild({ BRIDGE_REGION: 'mars' });
  ok(`BRIDGE_REGION=mars: refused on any kernel (exit ${r.status})`, r.status !== 0 && !r.timedOut);
}

console.log('\n[4] derivability of the bridge directory on the installed kernel');
{
  let derived = null, err = null;
  try { derived = await deriveTopicId({ region: 'bridge', name: BRIDGE_DIRECTORY_TOPIC }); } catch (e) { err = e; }
  if (!KERNEL_HONOURS_OVERRIDE) ok(`kernel ${KERNEL_VERSION}: the 'bridge' directory is UNDERIVABLE (${err?.message?.slice(0, 60) ?? 'no error'})`, err !== null && derived === null);
  else ok(`kernel ${KERNEL_VERSION}: the 'bridge' directory derives to an 'ff' id`, typeof derived === 'string' && derived.startsWith('ff'));
  ok("the 'useast' copy derives to an 0x89 id on any kernel", (await deriveTopicId({ region: 'useast', name: BRIDGE_DIRECTORY_TOPIC })).startsWith('89'));
}

console.log(`\nfence_region_bridge: ${n} checks passed, ${failed} failed`);
if (failed) process.exit(1);
