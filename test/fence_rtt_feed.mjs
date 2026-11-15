#!/usr/bin/env node
// fence_rtt_feed — the bridge's socket transport keeps a measured round trip
// per bound client socket (bridge 2.191.0). David 2026-11-15: "Wire the bridge
// app's transport to feed the measurement."
//
// THE FACT THIS RESTS ON. The bridge does not time a client socket. The
// client pings with its own clock and the bridge echoes. So the only real
// round trip of that socket is the client's, and a 4.148.0+ client carries it
// on its ping as `rtt`. server.js hands it to the transport for the
// connection it arrived on.
//
// The estimator's arithmetic is the kernel's and is fenced there
// (fence_rtt_measurement.mjs). This fence uses a recording stand-in and pins
// the WIRING:
//   A. a sample lands on the identity bound to that connection, marked as
//      reported; an unbound or superseded connection is refused
//   B. a new socket for the same identity starts cold; the old socket's close
//      does not wipe the new one's estimate
//   C. the table is bounded; no estimator class (an older kernel) measures
//      nothing and breaks nothing
//   D. getLatency still answers 50
//   E. statics on server.js: the ping handler feeds the transport before any
//      early exit; /diag shows the estimate; nothing else reads it
import { readFileSync } from 'node:fs';
import { WebSocketTransport, RTT_PEERS_MAX } from '../src/ws_transport.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const J = (v) => JSON.stringify(v);

/** A stand-in with the kernel estimator's surface; it records what it was given. */
class Recorder {
  constructor() { this.got = []; }
  sample(ms, opts) { if (typeof ms !== 'number' || ms < 0) return false; this.got.push({ ms, source: opts?.source, now: opts?.now }); return true; }
  snapshot() { return { cold: this.got.length === 0, srtt: this.got.at(-1)?.ms ?? null, rttvar: null, last: this.got.at(-1)?.ms ?? null, min: null, max: null, samples: this.got.length, ageMs: 0, sources: this.got.map((g) => g.source) }; }
}
const mk = (opts = {}) => new WebSocketTransport({ localNodeId: 1n, sendToConn: () => true, isConnOpen: () => true, log() {}, rttEstimator: Recorder, ...opts });

console.log('fence_rtt_feed: the client\'s reported round trip is kept per bound socket and read by nothing');

// ── A. a sample lands on the bound identity ──────────────────────────────
{
  const t = mk();
  check('A1 an identity that was never fed answers null', t.getRtt(7n) === null);
  check('A2 a sample for a connection that is not bound is refused', t.recordRtt('c1', 30) === false && t.rttStats().peers === 0);
  t.bindPeer(7n, 'c1');
  check('A3 a sample on the bound connection is kept for that identity', t.recordRtt('c1', 30, 1000) === true && t.getRtt(7n)?.srtt === 30 && t.getRtt(7n).samples === 1, J(t.getRtt(7n)));
  check('A4 it is marked as REPORTED: the client measured it, not the bridge', J(t.getRtt(7n).sources) === '["reported"]', J(t.getRtt(7n).sources));
  t.bindPeer(8n, 'c2'); t.recordRtt('c2', 90);
  check('A5 estimates are per identity', t.getRtt(7n).srtt === 30 && t.getRtt(8n).srtt === 90 && t.rttStats().peers === 2);
  check('A6 a sample the estimator refuses is reported as refused', t.recordRtt('c1', -5) === false && t.getRtt(7n).samples === 1);
  check('A7 rttStats says this build measures', t.rttStats().measuring === true);
}

// ── B. a new socket starts cold ──────────────────────────────────────────
{
  const t = mk();
  t.bindPeer(7n, 'c1'); t.recordRtt('c1', 30); t.recordRtt('c1', 32);
  t.bindPeer(7n, 'c9');                                  // the same identity on a NEW socket
  check('B1 a rebind on a new connection drops the old socket\'s estimate', t.getRtt(7n) === null);
  check('B2 a late sample on the OLD connection is refused', t.recordRtt('c1', 31) === false && t.getRtt(7n) === null);
  check('B3 the new connection samples from cold', t.recordRtt('c9', 55) === true && t.getRtt(7n).samples === 1 && t.getRtt(7n).srtt === 55);
  t.unbindPeer('c1');                                    // the old socket closes late
  check('B4 the old socket\'s close does not wipe the new socket\'s estimate', t.getRtt(7n)?.srtt === 55, J(t.getRtt(7n)));
  t.bindPeer(7n, 'c9');                                  // a repeat bind on the SAME connection
  check('B5 a repeat bind on the same connection keeps the estimate', t.getRtt(7n)?.srtt === 55);
  t.unbindPeer('c9');
  check('B6 the current socket\'s close drops the estimate', t.getRtt(7n) === null && t.rttStats().peers === 0);
}

// ── C. bounds, and an older kernel ───────────────────────────────────────
{
  const t = mk();
  for (let i = 0; i < RTT_PEERS_MAX; i++) { t.bindPeer(BigInt(i + 10), 'k' + i); t.recordRtt('k' + i, 1); }
  t.bindPeer(999999n, 'over');
  check('C1 the table is bounded at RTT_PEERS_MAX', RTT_PEERS_MAX === 4096 && t.rttStats().peers === RTT_PEERS_MAX && t.recordRtt('over', 1) === false && t.getRtt(999999n) === null);
  check('C1b a peer already held still samples at the bound', t.recordRtt('k5', 2) === true && t.getRtt(15n).samples === 2);
  const old = mk({ rttEstimator: null });
  old.bindPeer(7n, 'c1');
  check('C2 with no estimator class (an older kernel) nothing is measured and nothing throws', old.recordRtt('c1', 30) === false && old.getRtt(7n) === null && old.rttStats().measuring === false && old.rttStats().peers === 0);
  old.bindPeer(7n, 'c2'); old.unbindPeer('c2');
  check('C3 and bind and unbind work as before on that build', old.connIdFor(7n) === null);
  const junk = mk({ rttEstimator: 'not a class' });
  check('C4 a non-class estimator option reads as none', junk.rttStats().measuring === false);
}

// ── D. getLatency ────────────────────────────────────────────────────────
{
  const t = mk(); t.bindPeer(7n, 'c1'); t.recordRtt('c1', 400);
  check('D1 getLatency still answers the constant 50', t.getLatency(7n) === 50 && t.getLatency(123n) === 50);
}

// ── E. statics on server.js and the transport ────────────────────────────
{
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const ws = readFileSync(new URL('../src/ws_transport.js', import.meta.url), 'utf8');
  const ping = server.slice(server.indexOf("case 'ping': {"), server.indexOf("type:    'pong'"));
  check('E1 the ping handler hands a numeric rtt to the transport for THIS connection', /if \(typeof msg\.rtt === 'number'\) \{\s+try \{ bridgeNode\.transport\?\.recordRtt\?\.\(id, msg\.rtt\); \}/.test(ping));
  check('E2 it does so BEFORE the report block that can close the socket and break', ping.indexOf('recordRtt') > 0 && ping.indexOf('recordRtt') < ping.indexOf('maybeCloseBootstrapSocket'));
  check('E3 /diag carries the estimate for a bound connection', /rtt:\s+\(\(\) => \{ try \{ const r = boundNodeId \? bridgeNode\.transport\?\.getRtt\?\.\(boundNodeId\) : null;/.test(server));
  check('E4 server.js reads the estimate in /diag and nowhere else', (server.match(/\.getRtt\?\.\(/g) || []).length === 1 && (server.match(/recordRtt/g) || []).length === 1);
  check('E5 the transport still answers getLatency with 50', /getLatency\(_nodeId\) \{ return 50; \}/.test(ws));
  check('E6 the estimator comes from the kernel, guarded for an older one', /await import\('@axona\/protocol\/transport\/rtt\.js'\)\); \} catch \{ KernelRttEstimator = null; \}/.test(ws));
  const others = ['bridge_axona_node.js', 'bridge_engine.js', 'socket_bootstrap.js'].filter((f) => { try { return /getRtt|recordRtt/.test(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')); } catch { return false; } });
  check('E7 no other bridge module reads or feeds it', others.length === 0, J(others));
}

console.log(`\nfence_rtt_feed: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
