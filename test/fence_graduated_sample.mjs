#!/usr/bin/env node
// fence_graduated_sample — "The introduction represents the mesh, not the
// socket" v0.1 (axona-docs c7b0230), P1.a and P1.b, the bridge half.
//
//   A. RESOLVER. Off unless BRIDGE_GRADUATED_SAMPLE is on; every other
//      variable ignored then. On: strict positive integers, R_sample ≤ M_reg,
//      Q3's defaults (16 / 24 h / 4096).
//   B. REGISTRY. Only 66-hex is written; the bound evicts the OLDEST; L_reg
//      expires from the front; a re-graduation is a new registration; the
//      sample is uniform without replacement, never the excluded id, never a
//      duplicate, at most R, empty on an empty registry; status carries sizes
//      and counters and no id.
//   C. THROUGH A REAL BRIDGE CHILD (flag on, R 3, cap 2, ceiling 300 ms):
//      kernel clients bind identities and are graduated into the registry;
//      a later raw client's peer-list carries `graduated` with ≤ R hexes none
//      of which is a connection handle, and `peers` carries no 66-hex id;
//      the operator /healthz reports the size and never an id; the public
//      body carries nothing of it.
//   D. OFF IS BYTE-IDENTICAL. Flag off: no `graduated` field on any list, no
//      registry on /healthz beyond `on:false`.
//   E. THE GATE (P1.b). Gate on, door off, registry off, one cohort above
//      the cap: nothing graduates before the ceiling (held counts up); at the
//      ceiling they graduate with `graduated-cohort-only` naming the cohort.
//      With T_cohort 1 ms every earlier anchor is older: graduation proceeds.
//   F. STATICS. The field is never written into `peers`; both graduation
//      sites write the registry; the gate runs before selectGraduate.
//
// Mutants (each run by hand; the section named fails): write the sample into
// `peers` → C, F; drop noteGraduated at the vitality site → C; drop the gate
// filter → E; evict the newest instead of the oldest → B.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { KERNEL_VERSION, WIRE_VERSION } from '@axona/protocol';
import { connect } from '@axona/protocol/connect.js';
import { resolveGraduatedSample, GraduatedRegistry, isHex66, GRADUATED_SAMPLE_DEFAULTS } from '../src/graduated_registry.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e && e.message)); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hexN = (n) => n.toString(16).padStart(66, '0');
const TOKEN = 'fence-token';

// ── bridge child ───────────────────────────────────────────────────────
let child = null; let lines = [];
function startBridge(port, extraEnv) {
  lines = [];
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'info', MIN_PEER_VERSION: KERNEL_VERSION, HEALTHZ_TOKEN: TOKEN,
      BRIDGE_DIRECTORY: 'off', BRIDGE_NURSERY: 'on', BRIDGE_ANCHOR_MIN_POOL: '1000',
      BRIDGE_MAX_PEERS: '2', BRIDGE_GRADUATION_SLACK: '0', BRIDGE_GRADUATION_MIN_UPTIME_MS: '50',
      BRIDGE_GRADUATION_MAX_NURSERY_MS: '300', BRIDGE_GRADUATION_INTERVAL_MS: '30', BRIDGE_GRADUATION_MIN_KERNEL: '4.0.0',
      BRIDGE_GRADUATION_COOLDOWN_MS: '100', HELLO_TIMEOUT_MS: '3000', IDLE_TIMEOUT_MS: '60000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  const attach = (stream) => { let rest = ''; stream.on('data', (chunk) => { rest += chunk.toString(); const ls = rest.split('\n'); rest = ls.pop(); for (const l of ls) { lines.push(l); if (l.includes('"event":"listen"')) started = true; if (process.env.VERBOSE && l.trim()) console.log(`[bridge] ${l}`); } }); };
  attach(child.stdout); attach(child.stderr);
  return { ready: () => started, exited: () => child.exitCode !== null };
}
async function reap() { const c = child; if (!c || c.exitCode !== null) return; const ex = new Promise(r => c.once('exit', r)); try { c.kill('SIGTERM'); } catch {} await Promise.race([ex, sleep(1500)]); if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch {} await ex; } }
async function waitReady(b, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (b.ready()) return true; if (b.exited()) return false; await sleep(25); } return false; }
async function healthz(port) { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'X-Healthz-Token': TOKEN } }); return r.json(); }
async function publicHealthz(port) { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return r.json(); }
/** A raw client: client-hello only; returns the peer-list frame it receives. */
function rawPeerList(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const t = setTimeout(() => { ws.terminate(); reject(new Error('no peer-list')); }, 4000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'client-hello', version: KERNEL_VERSION, wireVersion: WIRE_VERSION, kernelVersion: KERNEL_VERSION })));
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'peer-list') { clearTimeout(t); ws.terminate(); resolve(m); } });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
/** A real kernel client that binds an identity on the door and stays. */
async function kernelClient(port) {
  const r = await connect({ bridge: `ws://127.0.0.1:${port}`, location: { lat: 38, lng: -77 }, author: false, ready: false });
  return r;
}

(async () => {
  console.log('fence_graduated_sample: P1.a registry + sample field, P1.b graduation gate (axona-docs c7b0230)');

  // ── A. resolver ────────────────────────────────────────────────────────
  {
    check('A1 absent → off', resolveGraduatedSample({}).on === false);
    check('A2 off ignores junk numbers', resolveGraduatedSample({ BRIDGE_GRADUATED_R_SAMPLE: 'x' }).on === false);
    const d = resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: '1' });
    check('A3 on → Q3 defaults 16 / 24 h / 4096', d.on && d.rSample === 16 && d.lRegMs === 86400000 && d.mReg === 4096 && d.rSample === GRADUATED_SAMPLE_DEFAULTS.rSample);
    check('A4 "on"/"yes" accepted, "0" is off', resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: 'YES' }).on && !resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: '0' }).on);
    check('A5 a typo refuses by name', throwsWith(() => resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: '1', BRIDGE_GRADUATED_M_REG: '1.5' }), /BRIDGE_GRADUATED_M_REG/) && throwsWith(() => resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: '1', BRIDGE_GRADUATED_L_REG_MS: '0' }), /BRIDGE_GRADUATED_L_REG_MS/));
    check('A6 R_sample above M_reg refuses', throwsWith(() => resolveGraduatedSample({ BRIDGE_GRADUATED_SAMPLE: '1', BRIDGE_GRADUATED_R_SAMPLE: '5', BRIDGE_GRADUATED_M_REG: '4' }), /exceeds/));
  }

  // ── B. registry ────────────────────────────────────────────────────────
  {
    const r = new GraduatedRegistry({ lRegMs: 1000, mReg: 4 });
    check('B1 non-hex refused and counted', !r.note('c17', 0) && !r.note(hexN(0xabcdef).toUpperCase(), 0) && !r.note(hexN(1).slice(1), 0) && r.size === 0 && r.rejected === 3);
    check('B2 66-hex written', r.note(hexN(1), 0) && r.has(hexN(1)) && r.size === 1);
    for (let i = 2; i <= 5; i++) r.note(hexN(i), i);
    check('B3 the bound evicts the OLDEST', r.size === 4 && !r.has(hexN(1)) && r.has(hexN(5)) && r.evicted === 1);
    r.note(hexN(2), 10);
    check('B4 a re-graduation is a new registration (moves to the back)', r.size === 4 && [...r._map.keys()].pop() === hexN(2));
    check('B5 L_reg expires from the front', r.prune(1003) === 1 && !r.has(hexN(3)) && r.expired === 1 && r.size === 3);
    const big = new GraduatedRegistry({ lRegMs: 10000, mReg: 100 });
    for (let i = 1; i <= 20; i++) big.note(hexN(i), 0);
    const s = big.sample(5, { exclude: hexN(7), now: 1 });
    check('B6 sample ≤ R, distinct, all 66-hex, never the excluded id', s.length === 5 && new Set(s).size === 5 && s.every(isHex66) && !s.includes(hexN(7)));
    let k = 0; const rng = () => ((k++ * 7919) % 1000) / 1000;
    const s2 = big.sample(20, { now: 1, rng });
    check('B7 R above the registry returns all, each once', s2.length === 20 && new Set(s2).size === 20);
    const counts = new Map(); for (let t = 0; t < 400; t++) for (const h of big.sample(3, { now: 1 })) counts.set(h, (counts.get(h) || 0) + 1);
    const vals = [...counts.values()];
    check('B8 uniform enough: every id drawn, max/min under 2.5 over 400 draws of 3 from 20', counts.size === 20 && Math.max(...vals) / Math.min(...vals) < 2.5, JSON.stringify(vals));
    check('B9 empty registry → empty sample; R 0 → empty', new GraduatedRegistry().sample(5).length === 0 && big.sample(0).length === 0);
    check('B10 expired entries never sampled', big.sample(20, { now: 20001 }).length === 0 && big.size === 0);
    const st = r.status();
    check('B11 status carries sizes and counters, no id', st.size === 3 && st.mReg === 4 && st.lRegMs === 1000 && !JSON.stringify(st).match(/[0-9a-f]{66}/));
  }

  // ── C. through a real bridge child, flag on ─────────────────────────────
  {
    const port = 43710 + Math.floor(Math.random() * 200);
    const b = startBridge(port, { BRIDGE_GRADUATED_SAMPLE: '1', BRIDGE_GRADUATED_R_SAMPLE: '3' });
    check('C0 bridge child listens', await waitReady(b));
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) { clients.push(await kernelClient(port)); await sleep(80); }
      await sleep(900);   // above cap 2 since the third; ceiling 300 ms; one graduation per 30 ms
      const h = await healthz(port);
      check('C1 kernel clients graduated into the registry (healthz size ≥ 2, no id anywhere in the body)', (h.graduatedSample?.size ?? 0) >= 2 && !JSON.stringify(h.graduatedSample).match(/[0-9a-f]{66}/), JSON.stringify(h.graduatedSample));
      const pl = await rawPeerList(port);
      check('C2 a later client\'s peer-list carries `graduated`: ≤ 3 lowercase 66-hex ids, distinct', Array.isArray(pl.graduated) && pl.graduated.length >= 1 && pl.graduated.length <= 3 && pl.graduated.every(isHex66) && new Set(pl.graduated).size === pl.graduated.length, JSON.stringify(pl.graduated));
      check('C3 `peers` carries connection handles only, no 66-hex id', Array.isArray(pl.peers) && pl.peers.every(p => !isHex66(p)), JSON.stringify(pl.peers));
      const pub = await publicHealthz(port);
      check('C4 the public /healthz body carries nothing of the registry', !('graduatedSample' in pub) && !JSON.stringify(pub).includes('graduated'));
      check('C5 operator readout: on, rSample 3, counters', h.graduatedSample.on === true && h.graduatedSample.rSample === 3 && typeof h.graduatedSample.evicted === 'number');
    } finally { for (const c of clients) { try { await c.disconnect?.(); } catch {} } await reap(); }
  }

  // ── D. off is byte-identical ───────────────────────────────────────────
  {
    const port = 43910 + Math.floor(Math.random() * 200);
    const b = startBridge(port, {});
    check('D0 bridge child listens (flag off)', await waitReady(b));
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) { clients.push(await kernelClient(port)); await sleep(80); }
      await sleep(700);
      const pl = await rawPeerList(port);
      check('D1 no `graduated` field on the list', !('graduated' in pl) && pl.peers.every(p => !isHex66(p)));
      const h = await healthz(port);
      check('D2 operator /healthz: graduatedSample on:false only', JSON.stringify(h.graduatedSample) === '{"on":false}');
    } finally { for (const c of clients) { try { await c.disconnect?.(); } catch {} } await reap(); }
  }

  // ── E. the gate (P1.b) ─────────────────────────────────────────────────
  {
    const port = 44110 + Math.floor(Math.random() * 200);
    const b = startBridge(port, { BRIDGE_GRADUATION_GATE: '1', BRIDGE_COHORT_MS: '100000', BRIDGE_GRADUATION_MAX_NURSERY_MS: '900' });
    check('E0 bridge child listens (gate on, one cohort)', await waitReady(b));
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) { clients.push(await kernelClient(port)); await sleep(60); }
      await sleep(450);   // above cap, past min uptime 50 ms, below the 900 ms ceiling
      const h1 = await healthz(port);
      check('E1 before the ceiling nothing graduates; the gate counts holds', h1.nursery.graduated === 0 && h1.graduationGate.on === true && h1.graduationGate.held > 0, JSON.stringify(h1.graduationGate));
      await sleep(900);
      const h2 = await healthz(port);
      const cohortLines = lines.filter(l => l.includes('"event":"graduated-cohort-only"'));
      check('E2 at the ceiling they graduate, each with a graduated-cohort-only line naming the cohort', h2.nursery.graduated >= 1 && cohortLines.length >= 1 && cohortLines.every(l => /"cohort":[0-9]+/.test(l)) && h2.graduationGate.cohortOnlyGraduated >= 1, `graduated=${h2.nursery.graduated} lines=${cohortLines.length}`);
    } finally { for (const c of clients) { try { await c.disconnect?.(); } catch {} } await reap(); }

    const port2 = 44310 + Math.floor(Math.random() * 200);
    const b2 = startBridge(port2, { BRIDGE_GRADUATION_GATE: '1', BRIDGE_COHORT_MS: '1', BRIDGE_GRADUATION_MAX_NURSERY_MS: '5000' });
    check('E3 bridge child listens (gate on, T_cohort 1 ms)', await waitReady(b2));
    const clients2 = [];
    try {
      for (let i = 0; i < 4; i++) { clients2.push(await kernelClient(port2)); await sleep(60); }
      await sleep(500);
      const h3 = await healthz(port2);
      check('E4 with every anchor older than T_cohort the gate opens: graduations before the ceiling, none cohort-only', h3.nursery.graduated >= 1 && h3.graduationGate.cohortOnlyGraduated === 0, JSON.stringify({ g: h3.nursery.graduated, gate: h3.graduationGate }));
    } finally { for (const c of clients2) { try { await c.disconnect?.(); } catch {} } await reap(); }
  }

  // ── F. statics ─────────────────────────────────────────────────────────
  {
    const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    check('F1 the sample never enters `peers` (no push/concat of graduatedSample into admittedPeers)', !/admittedPeers\.(push|unshift|concat)\([^)]*graduatedSample/.test(src) && (src.match(/graduated: graduatedSample, serverT/g) || []).length === 2);
    check('F2 both graduation sites write the registry', (src.match(/^\s*noteGraduated\(nh, now\);/gm) || []).length === 2);
    check('F3 the gate filters before selectGraduate', src.indexOf('const gated = !GRADUATION_GATE_ON') < src.indexOf('selectGraduate(gated'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('fence crashed:', e); await reap(); process.exit(2); });
