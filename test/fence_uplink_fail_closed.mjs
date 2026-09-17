// fence_uplink_fail_closed.mjs — BRIDGE_UPSTREAMS_ONLY can never reach production.
//
// The hazard (testnet probe design, amendment 2, 2026-09-17). A second testnet
// bridge federates to the testnet bridge. In default mode, if that bridge is
// unreachable at launch, the uplink falls back to the built-in seeds — the PROD
// bridges — and a persisted bridge book can name prod bridges too. A testnet
// bridge would join production and advertise itself in the prod directory.
//
// What this pins, OFFLINE. No socket is opened: every probe is a fake that
// records the URL it was asked about, and the transport is never built.
//   1. upstreams-only: candidates are the env seeds only — a POISONED book full of
//      prod URLs and the built-in defaults are never candidates.
//   2. upstreams-only with every env seed unreachable: the prod bridges are never
//      probed, and the plan has no upstream.
//   3. upstreams-only with the named seed reachable: that seed, and only it.
//   4. upstreams-only with no env seeds: no candidates, nothing probed.
//   5. self is excluded; order and duplicates are handled.
//   6. default mode is unchanged: env first, then book ranking, then defaults.
//   7. the flag parses strictly: only "on" (any case) enables it.
//   8. server.js wiring: the gate is awaited, exits non-zero on failure, and sits
//      before the directory publisher and before listen; the background uplink
//      block is skipped in this mode.
//   9. config.js carries the setting with the same default server.js uses.
//
// What this does NOT prove, and why it is stated here rather than implied: that
// no process ever opens a socket to a prod host. That is an egress property of a
// running process, and it needs its own separately approved integration check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_UPSTREAMS, upstreamsOnly, envUpstreams, resolveSeeds, planUplink,
} from '../src/uplink_policy.js';
import { resolveConfig } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');

let fail = 0, pass = 0;
const ok = (msg, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok - ${msg}`); }
  else { fail++; console.log(`  ✗  ${msg} ${extra}`); }
};

const B1 = 'wss://testnet.axona.net';
const PROD = [...DEFAULT_UPSTREAMS];
const isProd = (u) => PROD.includes(u) || /(^|\/\/)bridge(-west)?\.axona\.net/.test(u);

/** A book that would happily hand back production bridges. */
const poisonedBook = {
  called: 0,
  candidates(roots) {
    this.called++;
    return ['wss://bridge-west.axona.net', 'wss://bridge.axona.net', 'wss://rogue.example', ...roots];
  },
};

/** Fake probe: records every URL; `up` is the set that answers. */
const fakeProbe = (up = new Set()) => {
  const asked = [];
  const fn = async (url) => { asked.push(url); return up.has(url); };
  fn.asked = asked;
  return fn;
};

console.log('uplink fail-closed — BRIDGE_UPSTREAMS_ONLY\n');

// ── 1. candidates ─────────────────────────────────────────────────────────
{
  const env = { BRIDGE_UPSTREAMS_ONLY: 'on', BRIDGE_UPSTREAMS: B1 };
  poisonedBook.called = 0;
  const seeds = resolveSeeds({ env, book: poisonedBook, selfUrl: null });
  ok('1. upstreams-only: candidates are exactly the env seeds', JSON.stringify(seeds) === JSON.stringify([B1]), JSON.stringify(seeds));
  ok('   no production bridge among the candidates', !seeds.some(isProd), JSON.stringify(seeds));
  ok('   the poisoned book is never consulted', poisonedBook.called === 0, `called ${poisonedBook.called}`);
}

// ── 2. every env seed unreachable ─────────────────────────────────────────
{
  const env = { BRIDGE_UPSTREAMS_ONLY: 'on', BRIDGE_UPSTREAMS: `${B1}, ws://127.0.0.1:9` };
  const probe = fakeProbe(new Set(PROD));          // prod WOULD answer, if asked
  const events = [];
  const plan = await planUplink({ env, book: poisonedBook, selfUrl: null, probe, log: (e, d) => events.push([e, d]) });
  ok('2. unreachable env seeds → no upstream', plan.upstream === null, JSON.stringify(plan));
  ok('   probed exactly the env seeds, in order', JSON.stringify(probe.asked) === JSON.stringify([B1, 'ws://127.0.0.1:9']), JSON.stringify(probe.asked));
  ok('   a production bridge was never probed (though it would have answered)', !probe.asked.some(isProd), JSON.stringify(probe.asked));
  ok('   mode reported as upstreams-only', plan.mode === 'upstreams-only');
  ok('   no-reachable-seed is logged', events.some(([e]) => e === 'no-reachable-seed'));
}

// ── 3. the named seed answers ─────────────────────────────────────────────
{
  const env = { BRIDGE_UPSTREAMS_ONLY: 'on', BRIDGE_UPSTREAMS: B1 };
  const probe = fakeProbe(new Set([B1, ...PROD]));
  const plan = await planUplink({ env, book: poisonedBook, selfUrl: null, probe });
  ok('3. reachable env seed → that seed is the upstream', plan.upstream === B1, JSON.stringify(plan));
  ok('   nothing else was probed', JSON.stringify(probe.asked) === JSON.stringify([B1]), JSON.stringify(probe.asked));
}

// ── 4. no env seeds at all ────────────────────────────────────────────────
{
  const env = { BRIDGE_UPSTREAMS_ONLY: 'on' };
  const probe = fakeProbe(new Set(PROD));
  const plan = await planUplink({ env, book: poisonedBook, selfUrl: null, probe });
  ok('4. no env seeds → no candidates, no upstream', plan.upstream === null && plan.seeds.length === 0, JSON.stringify(plan));
  ok('   nothing probed', probe.asked.length === 0, JSON.stringify(probe.asked));
}

// ── 5. self, order, duplicates ────────────────────────────────────────────
{
  const self = 'wss://testnet-b2.example';
  const env = { BRIDGE_UPSTREAMS_ONLY: 'on', BRIDGE_UPSTREAMS: ` ${self} ,${B1},${B1}, ws://b3.example ` };
  const seeds = resolveSeeds({ env, book: null, selfUrl: self });
  ok('5. self excluded, duplicates removed, order kept', JSON.stringify(seeds) === JSON.stringify([B1, 'ws://b3.example']), JSON.stringify(seeds));
}

// ── 6. default mode unchanged ─────────────────────────────────────────────
{
  const env = { BRIDGE_UPSTREAMS: B1 };
  ok('6. default mode, no book: env then built-in defaults',
    JSON.stringify(resolveSeeds({ env, book: null, selfUrl: null })) === JSON.stringify([B1, ...PROD]));
  let seenRoots = null;
  const book = { candidates(roots) { seenRoots = roots; return ['wss://learned.example', ...roots]; } };
  const seeds = resolveSeeds({ env, book, selfUrl: null });
  ok('   default mode, with book: book ranks env ∪ defaults', JSON.stringify(seenRoots) === JSON.stringify([B1, ...PROD]), JSON.stringify(seenRoots));
  ok('   default mode, with book: book order is kept', seeds[0] === 'wss://learned.example', JSON.stringify(seeds));
  ok('   the built-in defaults are still the two prod bridges', JSON.stringify(PROD) === JSON.stringify(['wss://bridge.axona.net', 'wss://bridge-west.axona.net']));
  ok('   defaults cannot be mutated', (() => { try { DEFAULT_UPSTREAMS.push('x'); return false; } catch { return true; } })());
}

// ── 7. strict flag parsing ────────────────────────────────────────────────
ok('7. unset → off', upstreamsOnly({}) === false);
ok('   "on" / "ON" → on', upstreamsOnly({ BRIDGE_UPSTREAMS_ONLY: 'on' }) && upstreamsOnly({ BRIDGE_UPSTREAMS_ONLY: 'ON' }));
ok('   "1", "true", "yes", "" → off (only "on" enables)',
  ['1', 'true', 'yes', ''].every((v) => upstreamsOnly({ BRIDGE_UPSTREAMS_ONLY: v }) === false));
ok('   envUpstreams trims and drops empties', JSON.stringify(envUpstreams({ BRIDGE_UPSTREAMS: ' a , ,b ' })) === JSON.stringify(['a', 'b']));

// ── 8. server.js wiring ───────────────────────────────────────────────────
{
  const flag = SERVER_SRC.indexOf("process.env.BRIDGE_UPSTREAMS_ONLY ?? 'off'");
  const gate = SERVER_SRC.indexOf('if (UPSTREAMS_ONLY) {');
  const awaited = SERVER_SRC.indexOf('await bridgeNode.startUplink({ book: null', gate);
  const exit1 = SERVER_SRC.indexOf('process.exit(1)', gate);
  const publisher = SERVER_SRC.indexOf('startDirectoryPublisher({');
  const listen = SERVER_SRC.indexOf('httpServer.listen(');
  const background = SERVER_SRC.indexOf('if (!UPSTREAMS_ONLY && DIRECTORY_ON && SELF_URL) {');
  ok('8. server.js reads BRIDGE_UPSTREAMS_ONLY with default off', flag > 0);
  ok('   the isolation gate exists', gate > 0);
  ok('   the gate awaits the uplink and passes no book', awaited > gate && awaited < gate + 600, `gate@${gate} await@${awaited}`);
  ok('   the gate exits non-zero on failure', exit1 > gate && exit1 < publisher, `gate@${gate} exit@${exit1} publisher@${publisher}`);
  ok('   the gate runs before the directory publisher starts', gate > 0 && gate < publisher, `gate@${gate} publisher@${publisher}`);
  ok('   the gate runs before listen', gate > 0 && listen > gate, `gate@${gate} listen@${listen}`);
  ok('   the background uplink block is skipped in this mode', background > publisher);
  ok('   no other startUplink call is unguarded',
    (SERVER_SRC.match(/bridgeNode\.startUplink\(/g) || []).length === 2,
    `count ${(SERVER_SRC.match(/bridgeNode\.startUplink\(/g) || []).length}`);
}

// ── 9. config.js ──────────────────────────────────────────────────────────
ok('9. config default is off', resolveConfig({}, {}).upstreamsOnly === false);
ok('   config reads the env the same way', resolveConfig({}, { BRIDGE_UPSTREAMS_ONLY: 'On' }).upstreamsOnly === true);

console.log(`\n${fail ? `✗ ${fail} failed` : `✓ all ${pass} checks passed`}`);
process.exit(fail ? 1 : 0);
