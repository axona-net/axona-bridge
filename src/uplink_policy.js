// =====================================================================
// uplink_policy.js — WHICH upstream a bridge may dial, with no I/O of its own.
//
// Split out of uplink.js so the choice can be tested offline: uplink.js pulls in
// the web transport and the node-datachannel polyfill at import time, and a test
// that must never touch the network should not have to load either.
//
// TWO MODES.
//
//   default   env seeds (BRIDGE_UPSTREAMS) ∪ the persisted bridge book ∪ the
//             built-in prod bridges, ranked, minus self. Unchanged behaviour.
//
//   upstreams-only (BRIDGE_UPSTREAMS_ONLY=on)
//             ONLY the env seeds, in the order given, minus self. The bridge
//             book and the built-in prod bridges are never candidates, and if no
//             env seed answers, there is no uplink at all. server.js then exits
//             non-zero BEFORE the directory publisher starts and BEFORE it
//             listens (the isolation gate).
//
// WHY upstreams-only EXISTS (testnet probe design, amendment 2, 2026-09-17). A
// second testnet bridge must federate to the testnet bridge and to nothing else.
// In default mode, an unreachable testnet bridge at launch makes the fallback
// seeds the answer, and those are the PRODUCTION bridges: a testnet bridge would
// join prod and advertise itself in the prod directory — the very thing
// BRIDGE_DIRECTORY=off exists to prevent. A persisted book can carry prod URLs
// too (it learns from the directory), so ignoring the defaults alone is not
// enough; the book is excluded as well.
//
// What this does NOT cover, stated so nobody reads more into it: reconnects. The
// web transport reconnects to the SAME url it was built with (it never re-ranks),
// so the choice made here holds for the life of the process; cross-upstream
// failover only happens on a new launch, which runs this policy again.
// =====================================================================

// Built-in fallback seeds: the known prod bridges. Self is filtered out.
export const DEFAULT_UPSTREAMS = Object.freeze(['wss://bridge.axona.net', 'wss://bridge-west.axona.net']);

/** BRIDGE_UPSTREAMS_ONLY=on (case-insensitive) → true. Anything else, or unset → false. */
export function upstreamsOnly(env = process.env) {
  return String(env.BRIDGE_UPSTREAMS_ONLY ?? 'off').toLowerCase() === 'on';
}

/** The explicit seeds from BRIDGE_UPSTREAMS, comma-separated, trimmed, in order. */
export function envUpstreams(env = process.env) {
  return String(env.BRIDGE_UPSTREAMS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const dedupeMinusSelf = (urls, selfUrl) => {
  const seen = new Set();
  return urls.filter((u) => u && u !== selfUrl && !seen.has(u) && seen.add(u));
};

/**
 * Ranked upstream candidates.
 *   default:        env ∪ persisted book ∪ built-in defaults, minus self
 *   upstreams-only: env only, minus self (book and defaults are never consulted)
 */
export function resolveSeeds({ env = process.env, book = null, selfUrl = null } = {}) {
  const fromEnv = envUpstreams(env);
  if (upstreamsOnly(env)) return dedupeMinusSelf(fromEnv, selfUrl);
  const roots = [...fromEnv, ...DEFAULT_UPSTREAMS];
  const ranked = book ? book.candidates(roots) : roots;
  return dedupeMinusSelf(ranked, selfUrl);
}

/**
 * Choose the upstream to dial: the first seed whose probe answers.
 *
 * @param {object}   o
 * @param {object}   [o.env]
 * @param {object}   [o.book]     bridge book (ignored in upstreams-only mode)
 * @param {string}   [o.selfUrl]
 * @param {(url:string) => Promise<boolean>} o.probe   reachability test (injected)
 * @param {(event:string, detail?:object) => void} [o.log]
 * @returns {Promise<{ upstream: string|null, seeds: string[], probed: string[], mode: 'default'|'upstreams-only' }>}
 */
export async function planUplink({ env = process.env, book = null, selfUrl = null, probe, log = () => {} } = {}) {
  if (typeof probe !== 'function') throw new TypeError('planUplink: probe is required');
  const mode = upstreamsOnly(env) ? 'upstreams-only' : 'default';
  const seeds = resolveSeeds({ env, book, selfUrl });
  const probed = [];
  if (!seeds.length) { log('no-seeds', { mode }); return { upstream: null, seeds, probed, mode }; }
  for (const url of seeds) {
    probed.push(url);
    if (await probe(url)) return { upstream: url, seeds, probed, mode };
    log('seed-unreachable', { url, mode });
  }
  log('no-reachable-seed', { tried: seeds.length, mode });
  return { upstream: null, seeds, probed, mode };
}
