// =====================================================================
// uplink.js — the bridge's OUTBOUND bootstrap link into the live mesh.
//
// A bridge is a node first: on launch it connects out to a known bridge
// from the directory list (env seeds ∪ persisted discovered list ∪ built-in
// defaults), integrates into the one shared connectome, and from then on its
// directory publish lands on the shared mesh (so every client — on any
// bridge — discovers it). This is the same stack a browser/relay runs:
// webTransport() over a node-datachannel + ws polyfill.
//
// The uplink is ONE outbound connection at a time, picked as the first
// reachable ranked candidate. webTransport reconnects to that same upstream
// if it drops; cross-upstream failover happens on the next process launch
// (or could be added by rebuilding the uplink — kept simple for now).
// =====================================================================

import { webTransport } from '@axona/protocol/transport/web/index.js';
import { sign as edSign } from '@axona/protocol';
import { WebSocketImpl } from './polyfill.js';

// Built-in fallback seeds: the known prod bridges. Self is filtered out.
const DEFAULT_UPSTREAMS = ['wss://bridge.axona.net', 'wss://bridge-west.axona.net'];

/** Can we open a WebSocket to `url`? (Cheap reachability probe.) */
function probe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false, ws;
    const fin = (ok) => { if (done) return; done = true; try { ws && ws.close(); } catch {} resolve(ok); };
    try { ws = new WebSocketImpl(url); } catch { resolve(false); return; }
    const t = setTimeout(() => fin(false), timeoutMs);
    ws.onopen  = () => { clearTimeout(t); fin(true); };
    ws.onerror = () => { clearTimeout(t); fin(false); };
    ws.onclose = () => { clearTimeout(t); fin(false); };
  });
}

/** Ranked upstream candidates: env ∪ persisted book ∪ defaults, minus self. */
export function resolveSeeds({ env = process.env, book = null, selfUrl = null }) {
  const fromEnv = String(env.BRIDGE_UPSTREAMS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const roots = [...fromEnv, ...DEFAULT_UPSTREAMS];
  const ranked = book ? book.candidates(roots) : roots;
  const seen = new Set();
  return ranked.filter((u) => u && u !== selfUrl && !seen.has(u) && seen.add(u));
}

/**
 * Build (don't start) the outbound uplink transport to the first reachable
 * seed. Returns { transport, upstream } or null if no seed is reachable
 * (e.g. the root bridge with nothing above it — it runs uplink-less).
 *
 * @param {object} o
 * @param {object} o.identity  bridge hybrid identity (idHex, pubkey(Hex), privateKey)
 * @param {object} [o.env]
 * @param {import('./bridge_book_store.js').BridgeBookStore|null} [o.book]
 * @param {string} [o.selfUrl] this bridge's own advertised url (excluded)
 * @param {(event:string, detail?:object)=>void} [o.log]
 */
export async function buildUplink({ identity, env = process.env, book = null, selfUrl = null, log = () => {} }) {
  const seeds = resolveSeeds({ env, book, selfUrl });
  if (!seeds.length) { log('no-seeds'); return null; }

  let upstream = null;
  for (const url of seeds) {
    if (await probe(url)) { upstream = url; break; }
    log('seed-unreachable', { url });
  }
  if (!upstream) { log('no-reachable-seed', { tried: seeds.length }); return null; }

  // Shape a kernel-Identity for webTransport's authenticated client hello.
  // The bridge's hybrid identity carries privateKey/pubkey(Hex)/idHex but no
  // sign()/pow; supply them (pow inert '' — transport PoW is difficulty 0).
  const uplinkIdentity = {
    id:         identity.idHex,
    pubkey:     identity.pubkey,
    pubkeyHex:  identity.pubkeyHex,
    privateKey: identity.privateKey,
    sign:       (bytes) => edSign(identity.privateKey, bytes),
    pow:        typeof identity.pow === 'string' ? identity.pow : '',
  };

  const transport = webTransport({
    bridgeUrl: upstream,
    identity:  uplinkIdentity,
    meshRelay: true,        // integrate fully (help relay signaling like a relay)
    reconnect: true,        // self-heal the uplink to this upstream
    WebSocketImpl,
    log: (event, ctx) => log(`tx:${event}`, ctx),
  });

  log('selected', { upstream });
  return { transport, upstream };
}
