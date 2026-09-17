// fence_kernel_log.mjs — O1 observes the kernel and does nothing else.
//
// The claim this defends is not "the rows are useful". It is the narrower and
// more important one: a bridge with O1 armed makes the same routing decisions
// as a bridge without it, and a bridge with the flag unset is byte-identical
// to the bridge that shipped before O1 existed. Everything below is an attempt
// to falsify one of those two sentences.
//
// The dangerous failure this catches: a log line that throws. The kernel calls
// its sink from inside decision paths, and a context holding a BigInt is
// ordinary there. If serialization threw, an observability flag would start
// changing routing outcomes — the exact thing O1 promises it cannot do.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  installKernelLog, kernelLogOn, latTraceOn, safeContext, boundedContext,
  KERNEL_LOG_LEVELS, MAX_ARRAY, MAX_STRING,
} from '../src/kernel_log.js';
import { resolveConfig } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (f) => readFileSync(join(HERE, '..', 'src', f), 'utf8');
const KERNEL_LOG_SRC = SRC('kernel_log.js');
const SERVER_SRC = SRC('server.js');

let fail = 0;
const ok = (msg, cond, extra = '') => {
  if (cond) console.log(`  ok - ${msg}`);
  else { console.log(`  ✗  ${msg} ${extra}`); fail++; }
};

console.log('kernel log (O1) — observes, never steers\n');

// ── 1. The flag is off unless it is on ──────────────────────────────────────
ok('1. off with no environment', kernelLogOn({}) === false);
ok('   off when set to anything but on', kernelLogOn({ BRIDGE_KERNEL_LOG: 'yes' }) === false
  && kernelLogOn({ BRIDGE_KERNEL_LOG: '1' }) === false
  && kernelLogOn({ BRIDGE_KERNEL_LOG: 'true' }) === false);
ok('   on, case-insensitively', kernelLogOn({ BRIDGE_KERNEL_LOG: 'ON' }) === true
  && kernelLogOn({ BRIDGE_KERNEL_LOG: 'on' }) === true);
ok('   config.js agrees with the module', resolveConfig({}, {}).kernelLog === false
  && resolveConfig({}, { BRIDGE_KERNEL_LOG: 'on' }).kernelLog === true);
ok('   LAT_TRACE is read as the kernel reads it (exactly "1")',
  latTraceOn({ LAT_TRACE: '1' }) === true && latTraceOn({ LAT_TRACE: 'on' }) === false
  && latTraceOn({}) === false);

// ── 2. Flag off ⇒ nothing is registered at all ──────────────────────────────
// A spy peer/manager that FAILS the test if anything touches it.
const makeSpy = () => {
  const touched = [];
  const peer = {
    onLog: (level, h) => { touched.push(`onLog:${level}`); peer._h ??= []; peer._h.push([level, h]); return () => {}; },
    onError: (h) => { touched.push('onError'); peer._err = h; return () => {}; },
  };
  const am = {
    setLogSink: (fn) => { touched.push('setLogSink'); am._sink = fn; },
    inspectAdmission: () => ({ roles: 0, neverRoot: true }),
  };
  return { peer, am, touched };
};

{
  const { peer, am, touched } = makeSpy();
  const h = installKernelLog({ peer, axonaManager: am, sink: () => {}, env: {} });
  ok('2. flag off: installed is false', h.installed === false);
  ok('   flag off: nothing on the peer or manager was touched', touched.length === 0,
    touched.join(','));
  ok('   flag off: a sink is not even required', (() => {
    try { installKernelLog({ peer, axonaManager: am, env: {} }); return true; } catch { return false; }
  })());
  ok('   flag off: stats are zero and uninstall is safe',
    h.stats().emitted === 0 && h.stats().dropped === 0 && (h.uninstall(), true));
}

// ── 3. Flag on ⇒ both intakes, and rows arrive through EITHER ───────────────
const ENV_ON = { BRIDGE_KERNEL_LOG: 'on' };
{
  const { peer, am } = makeSpy();
  const rows = [];
  const h = installKernelLog({ peer, axonaManager: am, sink: (l, e, f) => rows.push([l, e, f]), env: ENV_ON });
  ok('3. both intakes registered', h.installed === true
    && h.intakes.includes('manager-sink') && h.intakes.includes('peer-onlog'), h.intakes.join(','));

  // Intake 1: the kernel's manager sink. `role-refused` is the row the probe
  // needs, and in 4.84.0 it arrives at INFO — see integ_kernel_log_real.mjs,
  // which drives the real admission path rather than assuming a level.
  am._sink('info', 'role-refused', { topic: 'ab', why: 'bridge', pushed: true });
  ok('   a manager row arrives, prefixed and level-preserved',
    rows.length === 1 && rows[0][0] === 'info' && rows[0][1] === 'kernel:role-refused'
    && rows[0][2].why === 'bridge', JSON.stringify(rows[0]));
  am._sink('warn', 'admitted-despite', { topic: 'ab', why: 'saturated' });
  ok('   a warn row keeps its level (the floor override is the loud one)',
    rows[1][0] === 'warn' && rows[1][1] === 'kernel:admitted-despite');

  // Intake 2: the peer's typed surface, which is what carries the rows once the
  // kernel repoints the manager sink at the peer on the first pub or sub.
  const infoHandler = peer._h.find(([lvl]) => lvl === 'info')[1];
  infoHandler('lat-stage', { stage: 'deliver:hop_tx', hopIdx: 2 });
  ok('   a peer row arrives on the same sink',
    rows.length === 3 && rows[2][0] === 'info' && rows[2][1] === 'kernel:lat-stage'
    && rows[2][2].stage === 'deliver:hop_tx');

  // debug is not in the level set and must not reach the log: on a bridge under
  // LAT_TRACE the debug channel is the loud one, and it is not what O1 is for.
  peer._h.filter(([lvl]) => lvl === 'debug').forEach(([, hh]) => hh('noise', {}));
  ok('   debug is never registered', peer._h.every(([lvl]) => KERNEL_LOG_LEVELS.includes(lvl)));
  ok('   background kernel errors are captured', (() => {
    peer._err({ code: 'TRANSPORT_FAILED', message: 'x' });
    const last = rows[rows.length - 1];
    return last[0] === 'error' && last[1] === 'kernel:TRANSPORT_FAILED';
  })());
  h.uninstall();
}

// ── 4. A log row can never take the process down ────────────────────────────
{
  const { peer, am } = makeSpy();
  let delivered = 0;
  const h = installKernelLog({ peer, axonaManager: am, sink: () => { delivered++; throw new Error('sink exploded'); }, env: ENV_ON });
  ok('4. a throwing sink does not propagate into the kernel', (() => {
    try { am._sink('info', 'x', {}); return true; } catch { return false; }
  })() && delivered === 1);

  const cyclic = { name: 'loop' }; cyclic.self = cyclic;
  ok('   a cyclic context does not propagate', (() => {
    try { am._sink('info', 'x', cyclic); return true; } catch { return false; }
  })());

  const hostile = { get boom() { throw new Error('getter exploded'); }, fine: 1 };
  ok('   a context whose getter throws does not propagate', (() => {
    try { am._sink('info', 'x', hostile); return true; } catch { return false; }
  })());
  h.uninstall();
}

// ── 5. BigInt ids survive as JOINABLE hex ───────────────────────────────────
// The whole point of the radix choice: a bridge row and a relay row must name
// the same node with the same string, or the analyzer silently sees two nodes.
{
  const id = BigInt('0x80933fee3c0cd774acdb5e3c4caaaa338d1571342550c54c2ac347641c097e6b56');
  const hex = safeContext(id);
  ok('5. a BigInt id becomes 66-char lowercase hex',
    typeof hex === 'string' && hex.length === 66 && hex === id.toString(16).padStart(66, '0'), hex);
  ok('   it matches idToHex exactly (same spelling as every other bridge row)',
    hex === id.toString(16).padStart(66, '0'));
  ok('   a small BigInt is still padded, so ids never collide with counters',
    safeContext(5n).length === 66);
  ok('   the whole row serializes', (() => {
    try { JSON.stringify(boundedContext({ from: id, to: 7n, n: 3 })); return true; } catch { return false; }
  })());
}

// ── 6. Bounded: a big context is summarized, never dropped in silence ───────
{
  const long = 'x'.repeat(MAX_STRING + 100);
  ok('6. a long string is cut and says how long it was',
    safeContext(long).length < long.length && safeContext(long).includes(String(long.length)));
  const arr = Array.from({ length: MAX_ARRAY + 10 }, (_, i) => i);
  const cut = safeContext(arr);
  ok('   a long array keeps its head and says how many there were',
    cut.length === MAX_ARRAY + 1 && String(cut[cut.length - 1]).includes(String(arr.length)));
  const huge = {}; for (let i = 0; i < 400; i++) huge[`k${i}`] = 'y'.repeat(200);
  const bounded = boundedContext(huge);
  ok('   an oversized context degrades to a shape with its byte count',
    bounded.oversized === true && typeof bounded.bytes === 'number' && Array.isArray(bounded.keys));
  ok('   deep nesting terminates', (() => {
    let d = { v: 1 }; for (let i = 0; i < 40; i++) d = { d };
    try { JSON.stringify(safeContext(d)); return true; } catch { return false; }
  })());
}

// ── 7. The rate cap counts what it drops ────────────────────────────────────
// A silent gap in this log would be indistinguishable from a bridge that made
// no decisions, which is the exact ambiguity O1 exists to remove.
{
  const { peer, am } = makeSpy();
  const rows = [];
  let clock = 1_000_000;
  const h = installKernelLog({
    peer, axonaManager: am, env: ENV_ON, maxRowsPerSec: 10,
    now: () => clock, sink: (l, e, f) => rows.push([l, e, f]),
  });
  for (let i = 0; i < 25; i++) am._sink('info', 'flood', { i });
  ok('7. the cap holds within one second', rows.length === 10, `got ${rows.length}`);
  ok('   the overflow is counted', h.stats().dropped === 15, `got ${h.stats().dropped}`);
  clock += 1000;
  am._sink('info', 'after', {});
  const throttle = rows.find(([, e]) => e === 'kernel-log-throttled');
  ok('   the next second announces what was missed',
    !!throttle && throttle[2].dropped === 15, JSON.stringify(throttle));
  ok('   and then rows flow again', rows[rows.length - 1][1] === 'kernel:after');
  h.uninstall();
}

// ── 8. Uninstall really detaches ────────────────────────────────────────────
{
  const { peer, am } = makeSpy();
  const rows = [];
  const h = installKernelLog({ peer, axonaManager: am, sink: (...a) => rows.push(a), env: ENV_ON });
  am._sink('info', 'before', {});
  h.uninstall();
  ok('8. uninstall clears the manager sink', am._sink === null || am._sink === undefined);
  ok('   no rows after uninstall', rows.length === 1);
}

// ── 9. SOURCE: the module cannot reach routing, and never imports ───────────
// A behavioural test cannot prove absence. These read the file instead.
{
  ok('9. kernel_log.js imports nothing', !/^\s*import\s/m.test(KERNEL_LOG_SRC));
  const forbidden = [
    'routeMessage', 'findKClosest', 'sendDirect', 'addCandidate', 'canAcceptRole',
    'admitPushedRole', 'publish(', 'subscribe(', 'axonRoles.set', 'axonRoles.delete',
    '_neverRoot =', 'lookup(',
  ];
  const found = forbidden.filter((f) => KERNEL_LOG_SRC.includes(f));
  ok('   it names no routing, placement or admission call', found.length === 0, found.join(','));
  ok('   the only kernel calls are registrations and reads',
    /setLogSink\(/.test(KERNEL_LOG_SRC) && /peer\.onLog\(/.test(KERNEL_LOG_SRC)
    && !/peer\.pub\b|peer\.sub\b/.test(KERNEL_LOG_SRC));
}

// ── 10. SOURCE: where server.js puts it ─────────────────────────────────────
// Ordering matters for a different reason than the uplink gate's did: install
// after start() so the manager exists, and before listen() so no decision made
// while serving goes unlogged.
{
  const iStart = SERVER_SRC.indexOf('await bridgeNode.start()');
  const iInstall = SERVER_SRC.indexOf('installKernelLog({');
  const iListen = SERVER_SRC.indexOf('httpServer.listen(');
  ok('10. installed after the node starts', iStart > 0 && iInstall > iStart, `${iStart} ${iInstall}`);
  ok('    and before the bridge listens', iListen > 0 && iInstall < iListen, `${iInstall} ${iListen}`);
  ok('    /diag exposes admission through safeContext, not raw',
    /admission:\s*\(\(\)\s*=>\s*\{[\s\S]{0,200}safeContext\(a\)/.test(SERVER_SRC));
  ok('    /diag reports whether the intake is armed and what it dropped',
    /kernelLog:\s*\{\s*\.\.\.kernelLog\.stats\(\)/.test(SERVER_SRC));
  ok('    the startup row states armed, intakes and latTrace',
    /log\('kernel-log',\s*\{[\s\S]{0,260}latTrace/.test(SERVER_SRC));
}

console.log(`\n${fail ? `✗ ${fail} failed` : '✓ all checks passed'}`);
process.exit(fail ? 1 : 0);
