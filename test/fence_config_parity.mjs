// fence_config_parity.mjs — the settings refactor changed no behaviour.
//
// Moving 34 settings out of server.js and into config.js is mechanical, which
// is exactly why it is dangerous: one mistyped default changes production and
// nothing fails. A test that only checks config.js against numbers I typed into
// the test would prove that I typed the same thing twice.
//
// So this reads the defaults back out of server.js's OWN source text and
// requires config.js to agree. The two files are independent statements of the
// same fact, and this fails the moment they disagree — in either direction.
//
// When server.js finally stops reading process.env directly, the parity section
// finds nothing to compare and says so loudly rather than passing vacuously.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveConfig, SETTINGS } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');

let fail = 0;
const ok = (msg, cond, extra = '') => {
  if (cond) console.log(`  ok - ${msg}`);
  else { console.log(`  ✗  ${msg} ${extra}`); fail++; }
};

console.log('config parity — config.js agrees with server.js\n');

// ── 1. Every setting resolves from a bare environment to its default ────────
const bare = resolveConfig({}, {});
ok('1. resolves with no environment at all', bare && typeof bare === 'object');
ok('   port defaults to 8080', bare.port === 8080, `got ${bare.port}`);
ok('   host defaults to 0.0.0.0', bare.host === '0.0.0.0', `got ${bare.host}`);
ok('   turnUrls parses to a list', Array.isArray(bare.turnUrls) && bare.turnUrls.length === 2,
  JSON.stringify(bare.turnUrls));
ok('   nursery is ON by default', bare.nurseryOn === true);
ok('   directory is ON by default', bare.directoryOn === true);

// ── 2. PARITY: server.js's own defaults, read from its source ───────────────
// Matches `process.env.NAME ?? 'literal'` and `process.env.NAME ?? "literal"`.
const declared = new Map();
const re = /process\.env\.([A-Z_]+)\s*\?\?\s*'([^']*)'/g;
let m;
while ((m = re.exec(SERVER_SRC)) !== null) {
  if (!declared.has(m[1])) declared.set(m[1], m[2]);
}
ok(`2. found defaults to compare in server.js (${declared.size})`, declared.size >= 20,
  `only ${declared.size} — if server.js no longer reads process.env, retire this section deliberately`);

let compared = 0, mismatched = [];
for (const { key, env: name, read } of SETTINGS) {
  if (!declared.has(name)) continue;
  const fromServer = read(declared.get(name));   // server's literal, our reader
  const fromConfig = bare[key];                  // our default, no environment
  const same = JSON.stringify(fromServer) === JSON.stringify(fromConfig);
  if (!same) mismatched.push(`${name}: server=${JSON.stringify(fromServer)} config=${JSON.stringify(fromConfig)}`);
  compared++;
}
ok(`   every shared default agrees (${compared} compared)`, mismatched.length === 0,
  mismatched.join(' | '));

// ── 3. Precedence: argument beats environment beats default ────────────────
const env = { PORT: '9999', LOG_LEVEL: 'debug', BRIDGE_MAX_PEERS: '5' };
const fromEnv = resolveConfig({}, env);
ok('3. environment beats default', fromEnv.port === 9999 && fromEnv.logLevel === 'debug');
const fromArg = resolveConfig({ port: 1234 }, env);
ok('   argument beats environment', fromArg.port === 1234 && fromArg.logLevel === 'debug');

// An explicit null is a CHOICE, not an absence. This is the one that bites:
// `{healthzToken: null}` must mean "no token", not "go look at the env".
const withToken = { HEALTHZ_TOKEN: 'secret' };
ok('   explicit null overrides a set environment variable',
  resolveConfig({ healthzToken: null }, withToken).healthzToken === null,
  `got ${JSON.stringify(resolveConfig({ healthzToken: null }, withToken).healthzToken)}`);
ok('   omitting the key still reads the environment',
  resolveConfig({}, withToken).healthzToken === 'secret');

// ── 4. Derived values ──────────────────────────────────────────────────────
ok('4. anchorMinPool derives from anchorK (3x)',
  resolveConfig({ anchorK: 5 }, {}).anchorMinPool === 15,
  `got ${resolveConfig({ anchorK: 5 }, {}).anchorMinPool}`);
ok('   an explicit anchorMinPool wins over the derivation',
  resolveConfig({ anchorK: 5, anchorMinPool: 2 }, {}).anchorMinPool === 2);
const stated = resolveConfig({ stateDir: '/var/lib/axona' }, {});
ok('   stateDir places both state files',
  stated.bookPath === '/var/lib/axona/bridges.json' &&
  stated.authorPath === '/var/lib/axona/author.json',
  `${stated.bookPath} ${stated.authorPath}`);
ok('   with no stateDir they sit in the working directory',
  bare.bookPath === 'bridges.json' && bare.authorPath === 'author.json');

// ── 5. Unknown settings are refused, not ignored ───────────────────────────
// The failure this prevents: an embedder writes `maxPeer` (no s), the bridge
// runs on the default, and nothing anywhere says so.
let threw = false;
try { resolveConfig({ maxPeer: 4 }, {}); } catch (e) { threw = /unknown setting/i.test(e.message); }
ok('5. an unknown setting throws rather than being ignored', threw);
ok('   a known setting does not throw',
  (() => { try { resolveConfig({ maxPeers: 4 }, {}); return true; } catch { return false; } })());

// ── 6. The result cannot be mutated after the fact ─────────────────────────
const frozen = resolveConfig({}, {});
try { frozen.port = 1; } catch { /* strict mode throws, fine either way */ }
ok('6. resolved settings are frozen', frozen.port === 8080, `got ${frozen.port}`);

console.log(`\n${fail ? `✗ ${fail} failed` : '✓ all checks passed'}`);
process.exit(fail ? 1 : 0);
