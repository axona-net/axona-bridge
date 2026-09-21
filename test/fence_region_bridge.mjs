// fence_region_bridge.mjs — 2.129.0: BRIDGE_REGION fails closed on a kernel that ignores the override, and the
// directory region set gains 'bridge' + the compatibility copy only under BRIDGE_REGION=bridge. No network.
import assert from 'node:assert/strict';
import { assertRegionApplied, REGION_BYTE_BY_NAME } from '../src/identity.js';
import { DIRECTORY_SYSTEM_REGION, DIRECTORY_COMPAT_REGIONS } from '../src/bridge_directory.js';
let n = 0; const ok = (m) => { n++; console.log('  ok ' + m); };
// unset: nothing to check
assertRegionApplied('89' + 'a'.repeat(64), null); ok('unset BRIDGE_REGION: any byte accepted');
// requested and honoured
assertRegionApplied('ff' + 'a'.repeat(64), 'bridge'); ok("BRIDGE_REGION=bridge with an 0xff id: accepted");
// requested but the kernel minted geo (the < 4.88.0 case): refuse
assert.throws(() => assertRegionApplied('89' + 'a'.repeat(64), 'bridge'), /does not honour the region override|needs @axona\/protocol >= 4\.88\.0/); ok('BRIDGE_REGION=bridge with a geo id: refuses to start (kernel < 4.88.0)');
// an unknown region name: refuse
assert.throws(() => assertRegionApplied('ff' + 'a'.repeat(64), 'mars'), /not a region this bridge knows/); ok('unknown BRIDGE_REGION value: refused');
assert.equal(REGION_BYTE_BY_NAME.bridge, 'ff'); assert.equal(DIRECTORY_SYSTEM_REGION, 'bridge'); assert.deepEqual([...DIRECTORY_COMPAT_REGIONS], ['useast']); ok("constants: bridge → 0xff; compat copy = ['useast']");
console.log(`fence_region_bridge: ${n} checks passed`);
