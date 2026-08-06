// config.js — every bridge setting, resolved from arguments instead of grabbed
// from the global environment.
//
// WHY THIS EXISTS (Howard, #axona.dev 2026-08-05). The bridge read 34 settings
// straight out of `process.env`, scattered through server.js at the point of
// use. That is fine for a process you launch from a shell and nothing else. It
// is wrong the moment somebody IMPORTS the bridge into a program that already
// has its own configuration — they would have to mutate the global environment
// of their own server to configure ours, and hope no other component reads the
// same names.
//
// The ask behind it is worth restating, because it explains the shape: we want
// as many people running bridges as possible, and for anyone who already has a
// server with a certificate and a port and a proxy, standing up a second stack
// beside it is most of the work. Settings-as-arguments plus a mountable
// websocket (see bridge.js) turns "run a bridge" into "add a bridge to the
// server you already run".
//
// PRECEDENCE, and it is deliberately in this order:
//
//   explicit argument  >  environment variable  >  default
//
// so an embedder names what it cares about and inherits the rest, and a
// standalone process behaves EXACTLY as it did before this file existed —
// which is what fence_config_parity.mjs pins.
//
// Defaults are reproduced here verbatim from where they used to live. When you
// change one, change it HERE — this is now the only place a bridge default is
// written down, and the README env table is generated from the same list.
import { join as pathJoin } from 'node:path';

const int = (v, dflt) => Number.parseInt(v ?? dflt, 10);

// The full setting table. `env` is the variable name honoured for backward
// compatibility; `read` turns a raw string into the value the bridge uses.
// Anything absent from here is NOT configurable, on purpose.
export const SETTINGS = [
  // ── where it listens (ignored when mounted on someone else's server) ──
  { key: 'port',                 env: 'PORT',                             read: v => int(v, '8080') },
  { key: 'host',                 env: 'HOST',                             read: v => v ?? '0.0.0.0' },

  // ── operational surface ──
  { key: 'healthzToken',         env: 'HEALTHZ_TOKEN',                    read: v => v ?? null },
  { key: 'logLevel',             env: 'LOG_LEVEL',                        read: v => v ?? 'info' },

  // ── who is allowed to connect ──
  { key: 'minPeerVersion',       env: 'MIN_PEER_VERSION',                 read: v => v ?? '1.1.0' },
  { key: 'minKernelVersion',     env: 'MIN_KERNEL_VERSION',               read: v => v ?? '3.15.0' },
  { key: 'minPeerAppVersion',    env: 'MIN_PEER_APP_VERSION',             read: v => v ?? '3.15.0' },
  { key: 'strictMinKernel',      env: 'STRICT_MIN_KERNEL',                read: v => v ?? null },
  { key: 'requiredWireMajor',    env: 'REQUIRED_WIRE_MAJOR',              read: v => v ?? '4' },
  { key: 'helloTimeoutMs',       env: 'HELLO_TIMEOUT_MS',                 read: v => int(v, '5000') },

  // ── idle reaping ──
  { key: 'idleTimeoutMs',        env: 'IDLE_TIMEOUT_MS',                  read: v => int(v, '15000') },
  { key: 'idleCheckIntervalMs',  env: 'IDLE_CHECK_INTERVAL_MS',           read: v => int(v, '5000') },

  // ── TURN credentials handed to clients ──
  { key: 'turnAuthSecret',       env: 'TURN_AUTH_SECRET',                 read: v => v ?? null },
  { key: 'turnUrls',             env: 'TURN_URLS',
    read: v => (v ?? 'turn:turn.axona.net:3478,turns:turn.axona.net:5349')
      .split(',').map(s => s.trim()).filter(Boolean) },

  // ── bootstrap nursery + anchors ──
  { key: 'nurseryOn',            env: 'BRIDGE_NURSERY',                   read: v => (v ?? 'on') !== 'off' },
  { key: 'anchorK',              env: 'BRIDGE_ANCHOR_K',                  read: v => int(v, '8') },
  { key: 'anchorMinUptimeMs',    env: 'BRIDGE_ANCHOR_MIN_UPTIME_MS',      read: v => int(v, '15000') },
  { key: 'maxPeers',             env: 'BRIDGE_MAX_PEERS',                 read: v => int(v, '32') },

  // ── graduation ──
  { key: 'graduationMinUptimeMs',   env: 'BRIDGE_GRADUATION_MIN_UPTIME_MS',   read: v => int(v, '30000') },
  { key: 'graduationMinKernel',     env: 'BRIDGE_GRADUATION_MIN_KERNEL',      read: v => v ?? '4.35.0' },
  { key: 'graduationSafeFloor',     env: 'BRIDGE_GRADUATION_SAFE_FLOOR',      read: v => int(v, '4') },
  { key: 'graduationVitalityTtlMs', env: 'BRIDGE_GRADUATION_VITALITY_TTL_MS', read: v => int(v, '20000') },
  { key: 'graduationMaxNurseryMs',  env: 'BRIDGE_GRADUATION_MAX_NURSERY_MS',  read: v => int(v, '600000') },
  { key: 'graduationSlack',         env: 'BRIDGE_GRADUATION_SLACK',           read: v => int(v, '2') },
  { key: 'graduationIntervalMs',    env: 'BRIDGE_GRADUATION_INTERVAL_MS',     read: v => int(v, '3000') },
  { key: 'graduationCooldownMs',    env: 'BRIDGE_GRADUATION_COOLDOWN_MS',     read: v => int(v, '60000') },

  // ── bridge directory (how other bridges find this one) ──
  { key: 'directoryOn',          env: 'BRIDGE_DIRECTORY',
    read: v => String(v ?? 'on').toLowerCase() !== 'off' },
  { key: 'publicUrl',            env: 'BRIDGE_PUBLIC_URL',                read: v => v || null },

  // ── test hook ──
  { key: 'testStall',            env: 'BRIDGE_TEST_STALL',                read: v => v === 'on' },
];

/**
 * Resolve every bridge setting.
 *
 * @param {object} [overrides]  Named settings. Keys are the `key` column above.
 *                              A key present here wins over the environment,
 *                              INCLUDING when its value is null — passing
 *                              `{healthzToken: null}` means "no token", not
 *                              "fall back to the environment".
 * @param {object} [env]        Defaults to process.env. Pass `{}` to resolve
 *                              pure defaults with no environment at all, which
 *                              is what an embedder usually wants.
 * @returns {object}            Frozen settings, plus derived paths.
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const cfg = {};
  for (const { key, env: name, read } of SETTINGS) {
    // `in` rather than `!== undefined`: an explicit null is a real choice.
    cfg[key] = (key in overrides) ? overrides[key] : read(env[name]);
  }

  // anchorMinPool defaults to 3× anchorK, so it has to be resolved AFTER
  // anchorK — it was written that way inline and the relationship is easy to
  // lose when the two lines drift apart.
  cfg.anchorMinPool = ('anchorMinPool' in overrides)
    ? overrides.anchorMinPool
    : int(env.BRIDGE_ANCHOR_MIN_POOL, String(cfg.anchorK * 3));

  // State paths: an explicit path wins; otherwise a state directory places
  // both files; otherwise the process working directory.
  const stateDir = ('stateDir' in overrides) ? overrides.stateDir : (env.STATE_DIRECTORY || null);
  cfg.stateDir = stateDir;
  cfg.bookPath = ('bookPath' in overrides) ? overrides.bookPath
    : (env.BRIDGE_BOOK_PATH || (stateDir ? pathJoin(stateDir, 'bridges.json') : 'bridges.json'));
  cfg.authorPath = ('authorPath' in overrides) ? overrides.authorPath
    : (env.BRIDGE_AUTHOR_PATH || (stateDir ? pathJoin(stateDir, 'author.json') : 'author.json'));

  // Reject unknown keys loudly. A silently-ignored setting is the failure mode
  // this whole file exists to remove: the embedder believes they configured
  // the bridge and the bridge is running on a default.
  const known = new Set([...SETTINGS.map(s => s.key),
    'anchorMinPool', 'stateDir', 'bookPath', 'authorPath']);
  const unknown = Object.keys(overrides).filter(k => !known.has(k));
  if (unknown.length) {
    throw new TypeError(
      `resolveConfig: unknown setting(s) ${unknown.join(', ')}. ` +
      `Known settings: ${[...known].sort().join(', ')}`);
  }

  return Object.freeze(cfg);
}
