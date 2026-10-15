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
/** The kernel's meshDegree option for a resolved cap: {maxPeers} when > 0, null (unbounded) otherwise. */
export function meshDegreeFor(meshCap) {
  return Number.isFinite(meshCap) && meshCap > 0 ? { maxPeers: meshCap } : null;
}

/**
 * TWO POOLS: parse BRIDGE_MESH_POOLS (`M=50,I=50,H=100[,pPending=..,cInbound=..,
 * serveFloor=..,promoteMs=..,hostBudget=..,doorSockets=..]`). Absent/empty →
 * null (not armed). Malformed → refused at start. With a mesh cap configured,
 * M must equal it (one cap, one source; the kernel refuses the pair otherwise).
 * doorSockets defaults to wsCap: the door's sockets live outside H.
 */
export function poolsFromEnv(env = process.env, { meshCap = undefined, wsCap = undefined } = {}) {
  const raw = env.BRIDGE_MESH_POOLS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const out = {};
  for (const part of String(raw).split(',')) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(-?\d+)\s*$/.exec(part);
    if (!m) throw new Error(`arming refused: BRIDGE_MESH_POOLS ${JSON.stringify(raw)} is not a comma list of NAME=integer (got ${JSON.stringify(part)})`);
    const key = m[1];
    if (!['M', 'I', 'H', 'pPending', 'cInbound', 'serveFloor', 'promoteMs', 'hostBudget', 'doorSockets'].includes(key)) {
      throw new Error(`arming refused: BRIDGE_MESH_POOLS names ${JSON.stringify(key)}, which the profile does not have`);
    }
    out[key] = Number.parseInt(m[2], 10);
  }
  if (out.M === undefined || out.I === undefined) throw new Error(`arming refused: BRIDGE_MESH_POOLS ${JSON.stringify(raw)} must name M and I`);
  const cap = Number.isFinite(meshCap) && meshCap > 0 ? meshCap : 0;
  if (cap > 0 && out.M !== cap) {
    throw new Error(`arming refused: BRIDGE_MESH_POOLS M=${out.M} but the mesh cap (BRIDGE_MESH_MAX_PEERS / BRIDGE_MAX_PEERS) is ${cap} — one cap, one source`);
  }
  if (out.doorSockets === undefined && Number.isFinite(wsCap) && wsCap > 0) out.doorSockets = wsCap;
  return out;
}

export async function buildUplink({ identity, env = process.env, book = null, selfUrl = null, log = () => {}, meshCap = undefined, meshOnly = false }) {
  const { upstream } = await planUplink({ env, book, selfUrl, probe, log });
  if (!upstream && !meshOnly) return null;

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
  // Bridge fill v0.8 (axona-docs 9b1ed08): the caller may hand in the ONE
  // resolved cap (fill_arming.js: the legacy resolver below when the triad is
  // off, the strict armed cap when it is on) so the fill's target and this
  // retire threshold are the same number read once. Absent that, the resolver
  // this file has always run.
  const wsCap   = Number.parseInt(env.BRIDGE_MAX_PEERS ?? '32', 10);
  if (meshCap === undefined) meshCap = Number.parseInt(env.BRIDGE_MESH_MAX_PEERS ?? String(wsCap), 10);
  // TWO POOLS (bridge 2.162.0; kernel 4.114.0): BRIDGE_MESH_POOLS, same
  // grammar as the relay's RELAY_MESH_POOLS. Absent → not armed. The profile's
  // M must equal the one mesh cap this bridge already runs (the kernel refuses
  // two caps at construction), and the door's sockets are declared OUTSIDE H
  // as doorSockets = BRIDGE_MAX_PEERS unless the profile names its own.
  const meshPools = poolsFromEnv(env, { meshCap, wsCap });
  if (!upstream) {
    // Socket-is-bootstrap v0.5 (axona-docs 7a27d24): a SEED bridge with no
    // bridge above it still needs a mesh, because its newcomers dial it over
    // WebRTC through its own door. The kernel's mesh-only web transport opens
    // no upstream socket; its only signalling domain is the door sink the
    // bridge node installs.
    const transport = webTransport({
      bridgeUrl: null, meshOnly: true,
      identity:  uplinkIdentity,
      meshRelay: true,
      reconnect: false,
      autoHandshake: false,
      meshDegree: meshDegreeFor(meshCap),
      meshPools,
      WebSocketImpl,
      log: (event, ctx) => log(`tx:${event}`, ctx),
    });
    log('mesh-degree', { cap: Number.isFinite(meshCap) && meshCap > 0 ? meshCap : 0, wsCap, meshOnly: true });
    log('pools', meshPools ? { armed: true, ...meshPools, enforce: false } : { armed: false });
    log('selected', { upstream: null, meshOnly: true });
    return { transport, upstream: null, meshOnly: true };
  }
  const transport = webTransport({
    bridgeUrl: upstream,
    identity:  uplinkIdentity,
    meshRelay: true,        // integrate fully (help relay signaling like a relay)
    reconnect: true,        // self-heal the uplink to this upstream
    // Inert when meshCap is 0 or unparseable — the kernel treats that as
    // unbounded, which is the pre-4.95.0 behaviour.
    meshDegree: meshDegreeFor(meshCap),
    meshPools,
    WebSocketImpl,
    log: (event, ctx) => log(`tx:${event}`, ctx),
  });
  log('mesh-degree', { cap: Number.isFinite(meshCap) && meshCap > 0 ? meshCap : 0, wsCap });
  log('pools', meshPools ? { armed: true, ...meshPools, enforce: false } : { armed: false });

  log('selected', { upstream });
  return { transport, upstream };
}
