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
// With BRIDGE_UPSTREAMS_ONLY=on the candidates are the env seeds ONLY (no book,
// no built-in prod bridges); see uplink_policy.js and the isolation gate in
// server.js.
//
// The uplink is ONE outbound connection at a time, picked as the first
// reachable ranked candidate. webTransport reconnects to that same upstream
// if it drops; cross-upstream failover happens on the next process launch
// (or could be added by rebuilding the uplink — kept simple for now).
// =====================================================================

import { webTransport } from '@axona/protocol/transport/web/index.js';
import { sign as edSign } from '@axona/protocol';
import { WebSocketImpl } from './polyfill.js';
import { planUplink, resolveSeeds, DEFAULT_UPSTREAMS } from './uplink_policy.js';

// Seed selection (and BRIDGE_UPSTREAMS_ONLY) lives in uplink_policy.js so it can
// be tested without loading the transport. Re-exported here for existing callers.
export { resolveSeeds, DEFAULT_UPSTREAMS };

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
  const { upstream } = await planUplink({ env, book, selfUrl, probe, log });
  if (!upstream) return null;

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

  // SYMMETRY (David 2026-09-24). BRIDGE_MAX_PEERS bounds the bridge's INBOUND
  // WebSocket population. It says nothing about the WebRTC mesh this uplink
  // joins, and on 2026-09-24 that was most of west's connectivity: one inbound
  // socket, seven WebRTC peers, synaptome seven. So the mesh gets the SAME
  // number by default — a bridge that is mediocre on one side and a full mesh
  // participant on the other is not capped, it is half-capped.
  // BRIDGE_MESH_MAX_PEERS overrides it; 0 disables the mesh cap alone.
  const wsCap   = Number.parseInt(env.BRIDGE_MAX_PEERS ?? '32', 10);
  const meshCap = Number.parseInt(env.BRIDGE_MESH_MAX_PEERS ?? String(wsCap), 10);
  const transport = webTransport({
    bridgeUrl: upstream,
    identity:  uplinkIdentity,
    meshRelay: true,        // integrate fully (help relay signaling like a relay)
    reconnect: true,        // self-heal the uplink to this upstream
    // Inert when meshCap is 0 or unparseable — the kernel treats that as
    // unbounded, which is the pre-4.95.0 behaviour.
    meshDegree: Number.isFinite(meshCap) && meshCap > 0 ? { maxPeers: meshCap } : null,
    WebSocketImpl,
    log: (event, ctx) => log(`tx:${event}`, ctx),
  });
  log('mesh-degree', { cap: Number.isFinite(meshCap) && meshCap > 0 ? meshCap : 0, wsCap });

  log('selected', { upstream });
  return { transport, upstream };
}
