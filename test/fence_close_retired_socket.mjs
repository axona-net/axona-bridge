#!/usr/bin/env node
// fence_close_retired_socket — Close a Retired Socket (bridge 2.189.0).
// David 2026-11-12: "Close a retired websocket."
//
// Before this the bridge closed a superseded door socket only when the client
// reported 4 or more mesh peers. A thin client kept an open socket that
// carried nothing, and when its channel to the bridge died it held a socket
// and no channel (axona-docs design/client-bridge-relation-states.md, state E).
//
//   A. THE VERDICT, capable kernel (4.136.0+): closed once retired or
//      door-bound with a fresh report of 1 or more, WHATEVER the mesh size;
//      never without a fresh report; never when neither retired nor bound.
//   B. THE VERDICT, older kernel: the floor rule, unchanged.
//   C. THE TRANSPORT remembers which connection was retired and forgets it
//      when that connection closes.
//   D. STATICS on server.js: the heartbeat path uses the verdict; the minimum
//      kernel is the exported default unless the operator overrides it.
//
// Mutants (each run by hand; the section named fails): drop the fresh-report
// test → A3; close a capable kernel only at the floor → A1, A2; apply the new
// rule to every kernel → B1, B2; never clear a retired connection → C3.
import { readFileSync } from 'node:fs';
import { bootstrapSocketVerdict, CLOSE_RETIRED_MIN_KERNEL_DEFAULT } from '../src/socket_bootstrap.js';
import { WebSocketTransport } from '../src/ws_transport.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const base = { safeFloor: 4, graduationMinKernel: '4.35.0' };
const v = (o) => bootstrapSocketVerdict({ ...base, ...o });

console.log('fence_close_retired_socket: a retired door socket is closed, whatever the client\'s mesh size, for a kernel that keeps the release');

// ── A. capable kernel ──────────────────────────────────────────────────
check('precondition: the default minimum kernel is 4.136.0', CLOSE_RETIRED_MIN_KERNEL_DEFAULT === '4.136.0');
{ const r = v({ kernelVersion: '4.136.0', retired: true, doorBound: true, meshBound: 1 });
  check('A1 mesh 1 (the bridge alone), retired → close', r.close === true && r.why === 'retired', JSON.stringify(r)); }
{ const r = v({ kernelVersion: '4.140.2', retired: true, doorBound: false, meshBound: 2 });
  check('A2 retired on a socket with no door channel of its own (a reconnect), mesh 2 → close', r.close === true, JSON.stringify(r)); }
check('A3 retired, NO fresh report → not closed', v({ kernelVersion: '4.136.0', retired: true, doorBound: true, meshBound: null }).close === false);
check('A3b retired, report of 0 → not closed', v({ kernelVersion: '4.136.0', retired: true, doorBound: true, meshBound: 0 }).close === false);
check('A4 neither retired nor door-bound, mesh 9 → not closed', v({ kernelVersion: '4.136.0', retired: false, doorBound: false, meshBound: 9 }).close === false);
check('A5 hostile reports (string, NaN, negative, float) → not closed', ['3', NaN, -1, 1.5, {}].every((m) => v({ kernelVersion: '4.136.0', retired: true, doorBound: true, meshBound: m }).close === false));

// ── B. older kernel: the floor rule ────────────────────────────────────
check('B1 4.135.0, retired, mesh 1 → NOT closed (it would reconnect at once)', v({ kernelVersion: '4.135.0', retired: true, doorBound: true, meshBound: 1 }).close === false);
check('B2 4.131.0, door-bound, mesh 3 → not closed; mesh 4 → closed by the floor', v({ kernelVersion: '4.131.0', retired: true, doorBound: true, meshBound: 3 }).close === false && v({ kernelVersion: '4.131.0', retired: true, doorBound: true, meshBound: 4 }).why === 'floor');
check('B3 older kernel, retired but its own door channel unbound → not closed', v({ kernelVersion: '4.131.0', retired: true, doorBound: false, meshBound: 9 }).close === false);
check('B4 below the graduation minimum → not closed', v({ kernelVersion: '4.30.0', retired: true, doorBound: true, meshBound: 9 }).close === false);
check('B5 no version at all is an old kernel', v({ kernelVersion: undefined, retired: true, doorBound: true, meshBound: 1 }).close === false);
check('B6 the operator can move the minimum', v({ kernelVersion: '4.135.0', retired: true, doorBound: true, meshBound: 1, closeRetiredMinKernel: '4.135.0' }).close === true);

// ── C. the transport's record ──────────────────────────────────────────
{
  const t = new WebSocketTransport({ localNodeId: 1n, sendToConn: () => true, isConnOpen: () => true, log: () => {} });
  t.bindPeer(7n, 'c1'); t.bindPeer(8n, 'c2');
  check('C1 nothing is retired before a supersession', t.isRetired('c1') === false && t.isRetired('c2') === false);
  t.supersedePeer(7n);
  check('C2 the superseded identity\'s connection is retired, the other is not', t.isRetired('c1') === true && t.isRetired('c2') === false);
  t.handleConnClosed('c1');
  check('C3 closing that connection clears the record', t.isRetired('c1') === false);
  let threw = false; try { t.supersedePeer(99n); } catch { threw = true; }
  check('C4 superseding an identity with no connection records nothing and does not throw', !threw && t.isRetired(undefined) === false);
}

// ── D. statics ─────────────────────────────────────────────────────────
{
  const srv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const mc = srv.slice(srv.indexOf('function maybeCloseBootstrapSocket('), srv.indexOf('// ── Embedded Axona peer'));
  check('D1 the close is decided by the verdict', /bootstrapSocketVerdict\(\{/.test(mc) && /if \(!verdict\.close\) return false;/.test(mc));
  check('D2 the verdict is given the retired flag, the door flag and the fresh report', /retired: bridgeNode\.socketRetired\?\.\(connId\) === true/.test(mc) && /doorBound: bridgeNode\.doorChannelBound\?\.\(connId\) === true/.test(mc) && /meshBound: mb/.test(mc) && /freshMeshBound\(c, now\)/.test(mc));
  check('D3 the minimum kernel comes from the exported default unless overridden', /const CLOSE_RETIRED_MIN_KERNEL = process\.env\.BRIDGE_CLOSE_RETIRED_MIN_KERNEL \?\? CLOSE_RETIRED_MIN_KERNEL_DEFAULT;/.test(srv));
  check('D4 the close still uses 4200', /c\.ws\.close\(CLOSE_GRADUATED,/.test(mc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
