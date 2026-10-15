#!/usr/bin/env node
// fence_mesh_pools_env.mjs — bridge 2.162.0: BRIDGE_MESH_POOLS → the kernel's
// meshPools profile on the uplink's transport. Absent = not armed; malformed
// = refused; M must equal the mesh cap (one cap, one source); doorSockets
// defaults to BRIDGE_MAX_PEERS so the door lives outside H.
// Mutant: drop the M === meshCap check → check 3 fails.
import { poolsFromEnv } from '../src/uplink.js';

let passed = 0, failed = 0;
const check = (l, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${l}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const refuses = (env, o) => { try { poolsFromEnv(env, o); return false; } catch (e) { return /arming refused/.test(e.message); } };

console.log('fence_mesh_pools_env: BRIDGE_MESH_POOLS');
check('1 absent → null (not armed)', poolsFromEnv({}, { meshCap: 50, wsCap: 15 }) === null);
const p = poolsFromEnv({ BRIDGE_MESH_POOLS: 'M=50,I=50,H=100' }, { meshCap: 50, wsCap: 15 });
check('2 the production row parses; doorSockets defaults to BRIDGE_MAX_PEERS (the door is outside H)', p.M === 50 && p.I === 50 && p.H === 100 && p.doorSockets === 15, JSON.stringify(p));
check('3 M that disagrees with the mesh cap is refused (one cap, one source)', refuses({ BRIDGE_MESH_POOLS: 'M=40,I=50,H=100' }, { meshCap: 50, wsCap: 15 }));
check('4 malformed is refused', refuses({ BRIDGE_MESH_POOLS: 'M=50' }, { meshCap: 50 }) && refuses({ BRIDGE_MESH_POOLS: 'M=50,I=50,Q=1' }, { meshCap: 50 }));
check('5 with the mesh cap off (0) M is not checked against it; an explicit doorSockets wins', poolsFromEnv({ BRIDGE_MESH_POOLS: 'M=50,I=50,H=100,doorSockets=20' }, { meshCap: 0, wsCap: 15 }).doorSockets === 20);
console.log(`\nfence_mesh_pools_env: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
