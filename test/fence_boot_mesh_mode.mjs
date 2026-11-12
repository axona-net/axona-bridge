#!/usr/bin/env node
// fence_boot_mesh_mode — 2.187.0. With socket-is-bootstrap on, a bridge with the
// directory off still starts a mesh, and that mesh NEVER consults the upstream
// planner (whose fallback seeds are the production bridges).
//
//   A. bootMeshMode truth table.
//   B. buildUplink: noUpstream without meshOnly is refused before anything else.
//   C. buildUplink: noUpstream skips the planner. Driven with
//      BRIDGE_UPSTREAMS_ONLY=on and no seeds, so that if the skip were removed
//      the planner would log 'no-seeds' and still touch no network. The call
//      then fails on the null identity, after the point under test.
//   D. Control: the same call without noUpstream DOES reach the planner.
//   E. Statics: server.js starts the mesh through bootMeshMode and passes
//      noUpstream for 'mesh-only'; uplink.js tests noUpstream before planUplink.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootMeshMode } from '../src/socket_bootstrap.js';
import { buildUplink } from '../src/uplink.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const EXPECTED = 13;
process.on('exit', (code) => { if (code === 0 && passed + failed < EXPECTED) { console.log(`  ✗ exited after ${passed + failed} of ${EXPECTED} checks`); process.exitCode = 1; } });

console.log('fence_boot_mesh_mode: a mesh-only boot never plans an upstream');

// A
const m = (o) => bootMeshMode(o);
check('A1 upstreams-only: no background mesh, whatever else is set', m({ upstreamsOnly: true, directoryOn: true, selfUrl: 'wss://x', socketBootstrapOn: true }) === null);
check('A2 directory on with a public URL: federated', m({ upstreamsOnly: false, directoryOn: true, selfUrl: 'wss://x', socketBootstrapOn: false }) === 'federated');
check('A3 federated wins over the flag (the planner is the existing behaviour there)', m({ upstreamsOnly: false, directoryOn: true, selfUrl: 'wss://x', socketBootstrapOn: true }) === 'federated');
check('A4 directory off, flag on: mesh-only', m({ upstreamsOnly: false, directoryOn: false, selfUrl: null, socketBootstrapOn: true }) === 'mesh-only');
check('A5 directory on but no public URL, flag on: mesh-only', m({ upstreamsOnly: false, directoryOn: true, selfUrl: null, socketBootstrapOn: true }) === 'mesh-only');
check('A6 directory off, flag off: nothing (byte-identical to before)', m({ upstreamsOnly: false, directoryOn: false, selfUrl: null, socketBootstrapOn: false }) === null);
check('A7 a truthy non-boolean flag is not "on"', m({ upstreamsOnly: false, directoryOn: false, selfUrl: null, socketBootstrapOn: 'yes' }) === null);

const SAFE_ENV = { BRIDGE_UPSTREAMS_ONLY: 'on' };   // if the planner runs, it has zero seeds and dials nothing
const drive = async (opts) => { const logs = []; let err = null; try { await buildUplink({ identity: null, env: SAFE_ENV, log: (e) => logs.push(e), ...opts }); } catch (e) { err = e; } return { logs, err }; };

// B
{ const r = await drive({ noUpstream: true, meshOnly: false });
  check('B noUpstream without meshOnly is refused, before the planner', /noUpstream requires meshOnly/.test(r.err?.message ?? '') && r.logs.length === 0, JSON.stringify({ err: r.err?.message, logs: r.logs })); }
// C
{ const r = await drive({ noUpstream: true, meshOnly: true });
  check('C1 noUpstream logs plan-skipped', r.logs.includes('plan-skipped'), JSON.stringify(r.logs));
  check('C2 noUpstream never reaches the planner', !r.logs.some((e) => ['no-seeds', 'seed-unreachable', 'no-reachable-seed'].includes(e)), JSON.stringify(r.logs)); }
// D
{ const r = await drive({ noUpstream: false, meshOnly: true });
  check('D control: without noUpstream the planner IS consulted', r.logs.includes('no-seeds') && !r.logs.includes('plan-skipped'), JSON.stringify(r.logs)); }
// E
{ const server = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');
  const uplink = readFileSync(join(HERE, '..', 'src', 'uplink.js'), 'utf8');
  check('E1 server.js: the background mesh starts through bootMeshMode and mesh-only passes noUpstream with no book',
    server.includes('const BOOT_MESH = bootMeshMode({') && server.includes("noUpstream: BOOT_MESH === 'mesh-only'") && server.includes("book: BOOT_MESH === 'federated' ? bridgeBook : null") && !server.includes('if (!UPSTREAMS_ONLY && DIRECTORY_ON && SELF_URL) {\n  bridgeNode.startUplink'));
  const body = uplink.slice(uplink.indexOf('export async function buildUplink('));
  const iGuard = body.indexOf('noUpstream ? { upstream: null }'), iPlan = body.indexOf('await planUplink(');
  check('E2 uplink.js: the planner call sits behind the noUpstream test', iGuard > 0 && iPlan > iGuard && iPlan - iGuard < 80, JSON.stringify({ iGuard, iPlan })); }

console.log(`\nfence_boot_mesh_mode: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
