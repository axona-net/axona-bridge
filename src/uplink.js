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
export async function buildUplink({ identity, env = process.env, book = null, selfUrl = null, log = () => {}, airGap = null }) {
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

  // Bridge-Air-Gap-Plan v0.5 §7.2.6 write point 2: the uplink socket. The
  // kernel's bridge transport writes through the WebSocket class we hand it, so
  // classifying `send` on a subclass instruments EXACTLY that write — a
  // genericTransit frame is counted and not written. Frames are small JSON text.
  const UplinkSocket = airGap ? class extends WebSocketImpl {
    send(data, ...rest) {
      let msg = null;
      try { msg = typeof data === 'string' ? JSON.parse(data) : null; } catch { msg = null; }
      // 'uplink-socket' is the trusted local cause: this class is instantiated
      // only by the kernel's web transport for this socket, and nothing else
      // writes it. The frame's own type is not evidence of anything.
      const { cls, allowed } = airGap.egressWrite('uplink', msg, { cause: 'uplink-socket' });
      if (!allowed) { log('egress-refused', { point: 'uplink', type: msg?.type, inner: msg?.payload?.type }); return; }
      airGap.egressInvoked('uplink', cls);
      let r;
      try { r = super.send(data, ...rest); }
      catch (err) { airGap.egressThrew('uplink', cls); throw err; }
      airGap.egressWritten('uplink', cls);
      return r;
    }
  } : WebSocketImpl;
  // Write point 3 (v0.8): the uplink's WebRTC data channels. The kernel's mesh
  // calls this gate at dc.send — the physical write — so a data-channel frame is
  // classified and counted where it leaves, and a genericTransit frame is refused
  // there, below the composite gate.
  const egressGate = airGap ? {
    // `cause` arrives from the kernel's own send sites (kernel-request /
    // kernel-notify / kernel-reply) or its keepalive — local metadata, never
    // read from the frame.
    before: (frame, _peerId, cause) => { const v = airGap.egressWrite('datachannel', frame, { cause: cause ?? null }); if (v.allowed) airGap.egressInvoked('datachannel', v.cls); return v; },
    after:  (cls)   => airGap.egressWritten('datachannel', cls),
    threw:  (cls)   => airGap.egressThrew('datachannel', cls),
  } : null;
  const transport = webTransport({
    bridgeUrl: upstream,
    identity:  uplinkIdentity,
    meshRelay: true,        // integrate fully (help relay signaling like a relay)
    reconnect: true,        // self-heal the uplink to this upstream
    WebSocketImpl: UplinkSocket,
    egressGate,
    log: (event, ctx) => log(`tx:${event}`, ctx),
  });

  log('selected', { upstream });
  return { transport, upstream };
}
