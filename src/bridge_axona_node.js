// =====================================================================
// bridge_axona_node.js — orchestrates the bridge's embedded AxonaPeer.
//
// Analogous to axona-peer/src/axona_node.js (AxonaNode), but on the
// server side:
//   - Uses BridgeEngine (server flavor, MAX_SYNAPTOME=256)
//   - Uses WebSocketTransport over the bridge's existing WebSocket
//     connections (browser ↔ bridge), not WebRTC
//   - Identity is loaded from disk (persistent across restarts)
//
// Public class: BridgeAxonaNode.  Construct, call start(),
// then use the methods exposed below to feed bridge events
// (sendToConn, isConnOpen, handleConnClosed, handleIncoming) so the
// transport can reach the bridge's WebSocket pool.
//
// The hello / hello-ack handshake is the same envelope shape the
// browser uses on its WebRTC mesh:
//   bridge → browser:  { k: 'ntf', type: 'hello',
//                        body: { proto: 'axona/3', nodeId: <hex> } }
//   browser → bridge:  { k: 'ntf', type: 'hello-ack',
//                        body: { proto: 'axona/3', nodeId: <hex> } }
// Server.js triggers the hello on welcome, and on hello-ack the
// transport binds nodeId↔connId.
// =====================================================================

import {
  AxonaPeer,
  NeuronNode,
  Synapse,
  buildAuthHello,
  verifyAuthHello,
  cbvFromNonces,
  sign as edSign,
} from '@axona/protocol';

// I4: kernel v1.0 dropped clz64 in favour of the 264-bit clz264 (it
// lives at utils/hexid.js).  Bridge node.id is still on the legacy
// 64-bit BigInt path (top 64 bits of kernel hex identity from #46-style
// migration), so we keep a fast Math.clz32-chunks shim here — same
// shape as axona-peer/src/axona_node.js and dht-sim's TransportAxonaEngine.
function clz64(x) {
  if (x === 0n) return 64;
  const hi = Number((x >> 32n) & 0xFFFFFFFFn);
  if (hi !== 0) return Math.clz32(hi);
  const lo = Number(x & 0xFFFFFFFFn);
  return 32 + Math.clz32(lo);
}

import { CompositeTransport } from '@axona/protocol/transport/web/composite.js';
import { BridgeEngine }       from './bridge_engine.js';
import { WebSocketTransport } from './ws_transport.js';
import { loadOrDeriveIdentity, idToHex } from './identity.js';
// NB: ./uplink.js (and its node-datachannel polyfill) is imported LAZILY inside
// startUplink() so the native WebRTC module only loads when an uplink is actually
// used — the testnet/uplink-off path never pays for it.
// pubsub_axonal.js (legacy { msg, publisher } wrapper) retired in I4.
// Bridge participates in pub/sub via the kernel's unified API on
// AxonaPeer — peer.pub / peer.sub / peer.pull / peer.metrics.

export class BridgeAxonaNode {
  /**
   * @param {Object} opts
   * @param {(connId: string, msg: object) => boolean} opts.sendToConn
   * @param {(connId: string) => boolean}              opts.isConnOpen
   * @param {(event:string, data?:object) => void}     [opts.log]
   */
  constructor({ sendToConn, isConnOpen, closeConn = null, log }) {
    if (typeof sendToConn !== 'function' || typeof isConnOpen !== 'function') {
      throw new TypeError('BridgeAxonaNode: sendToConn + isConnOpen required');
    }
    this._sendToConn = sendToConn;
    this._isConnOpen = isConnOpen;
    this._closeConn  = typeof closeConn === 'function' ? closeConn : () => {};
    this._log = log ?? (() => {});

    this._identity  = null;
    this._engine    = null;
    this._node      = null;
    this._transport = null;   // inbound server WS (browser ↔ bridge); kept for feed methods
    this._composite = null;   // node.transport = [server WS, (optional) outbound uplink]
    this._uplink    = null;   // { transport, upstream } once the bootstrap uplink is up
    this._peer      = null;

    // axona/4 — signer adapter for the authenticated handshake (the
    // identity object holds privateKey + pubkeyHex but no sign()), and
    // the per-connection serverNonce that anchors each link's CBV.
    this._authIdentity     = null;
    this._serverNonceByConn = new Map();

    /** @type {Map<string, 'pending'|'complete'>} connId → handshake state */
    this._helloByConnId = new Map();
  }

  /** CBV for a bridge link = the connection's serverNonce + connId. */
  _bridgeCbv(connId) {
    const nonce = this._serverNonceByConn.get(connId);
    if (!nonce) return null;
    return cbvFromNonces(nonce, connId, 'bridge');
  }

  get identity()  { return this._identity; }
  get nodeId()    { return this._identity?.id ?? null; }
  get peer()      { return this._peer; }
  get transport() { return this._transport; }

  /**
   * Bring the embedded peer up.  Synchronous-friendly: callers
   * await once and then can immediately use the public methods.
   */
  async start() {
    // I4: loadOrDeriveIdentity is async now (kernel deriveIdentity
    // uses Web Crypto Ed25519 keygen).
    this._identity = await loadOrDeriveIdentity();
    // axona/4 — adapter shaped like the kernel Identity that
    // buildAuthHello expects: { id: hex, pubkeyHex, sign(bytes) }.
    this._authIdentity = {
      id:        this._identity.idHex,
      pubkeyHex: this._identity.pubkeyHex,
      sign:      (bytes) => edSign(this._identity.privateKey, bytes),
    };
    this._log('identity-loaded', {
      nodeId: idToHex(this._identity.id),
      idHex:  this._identity.idHex,
      region: this._identity.region.label,
      createdAt: this._identity.createdAt,
    });

    this._engine = new BridgeEngine({ k: 20 });

    this._node = new NeuronNode({
      id:  this._identity.id,
      lat: this._identity.region.lat,
      lng: this._identity.region.lng,
    });
    this._node.temperature = this._engine.T_INIT;
    this._engine.setTheNode(this._node);

    // Inbound server transport (browsers → bridge). Kept as `this._transport`
    // for the bridge's feed methods (handleAxonaFrame/handleConnClosed) and the
    // inbound NH1 admission handshake.
    this._transport = new WebSocketTransport({
      localNodeId: this._identity.id,
      sendToConn:  this._sendToConn,
      isConnOpen:  this._isConnOpen,
      log: this._log,
    });

    // `node.transport` is a CompositeTransport so the kernel's pub/sub + routing
    // handlers fan across BOTH the inbound server WS and an OUTBOUND bootstrap
    // uplink (added later by startUplink). One peer, one connectome.
    this._composite = new CompositeTransport({ localNodeId: this._identity.id, log: this._log });
    this._composite.addSubtransport(this._transport);
    this._node.transport = this._composite;
    await this._composite.start(this._identity.id);

    this._registerNH1Handlers();

    // v0.3: AxonaPeer takes the NODE/connection identity as `nodeIdentity`
    // (was `identity`); the publish key is no longer a peer-level field —
    // authorship is supplied per-publish via { signWith } (see bridge_directory).
    this._peer = new AxonaPeer({
      engine:       this._engine,
      node:         this._node,
      nodeIdentity: this._identity,
      // Synaptome maintenance ON (Synaptome-Maintenance-v0.1; dev decision 2026-06-29).
      synaptomeMaintain: { kNear: 5, intervalMs: 15000, maxPerTick: 3 },
    });
    await this._peer.start();

    // Register peer with engine so axonaManagerFor(node) resolves
    // when peer.pub / peer.sub call _requireAxonaManager.  The
    // BridgeEngine.axonaManagerFor alias (added in this commit)
    // delegates to axonFor.  No more mountAxonalPubsub wrapper —
    // bridge uses the kernel unified pub/sub directly.
    this._engine.setPeerForNode(this._node, this._peer);

    // Eagerly build the bridge's AxonaManager NOW, at startup.
    //
    // Regression fix (introduced in I4, commit 8a54a6e): before I4 the
    // bridge built its pub/sub engine eagerly via
    //   this._axon = this._engine.axonFor(this._node);
    // I4 dropped that line, relying on the kernel's lazy
    // _requireAxonaManager — which only fires on peer.sub / peer.pub.
    // The bridge never subscribes or publishes, so its AxonaManager was
    // never constructed, and the pubsub:subscribe-k / publish-k /
    // deliver direct-message handlers (registered in the AxonaManager
    // constructor) were never installed.  Every pub/sub frame addressed
    // to the bridge was silently dropped.
    //
    // Because the bridge is in every peer's synaptome (universal
    // connector) and is XOR-close to regional topics (its 0x89 us-east
    // prefix matches us-east/* topic IDs), peers routinely pick the
    // bridge as a K-closest axon — and it black-holed those
    // subscriptions, so publishes routed by other peers reached some
    // subscribers and missed others (the cross-app delivery asymmetry).
    //
    // Building it here registers the handlers and makes the bridge a
    // real relay axon again.  arm refreshTick so its role children get
    // TTL-swept and its K-closest cache stays fresh.
    this._axon = this._engine.axonaManagerFor(this._node);
    this._axon?.start?.();

    this._registerRouteMsgHandler();

    return this;
  }

  /**
   * Bootstrap this bridge INTO the live mesh as a node: open an outbound uplink
   * to a known bridge (env ∪ persisted ∪ default seeds), integrate into the one
   * shared connectome — so the bridge's directory publish becomes visible
   * network-wide and clients on any bridge discover it. NON-FATAL: a failed or
   * absent uplink (e.g. the root bridge with nothing above it) leaves the bridge
   * running server-only. Returns the chosen upstream url, or null.
   *
   * @param {object} [o]
   * @param {object} [o.env]
   * @param {import('./bridge_book_store.js').BridgeBookStore|null} [o.book]
   * @param {string} [o.selfUrl]  this bridge's advertised url (excluded from seeds)
   */
  async startUplink({ env = process.env, book = null, selfUrl = null } = {}) {
    if (this._uplink) return this._uplink.upstream;          // idempotent
    let built = null;
    try {
      const { buildUplink } = await import('./uplink.js');   // lazy: loads node-datachannel only now
      built = await buildUplink({
        identity: this._identity, env, book, selfUrl,
        log: (event, ctx) => this._log(`uplink:${event}`, ctx),
      });
    } catch (err) {
      this._log('uplink-build-failed', { err: err?.message });
      return null;
    }
    if (!built) return null;
    try {
      await built.transport.start();                         // upstream handshake
      this._composite.addSubtransport(built.transport);      // fans existing handlers onto it
      this._uplink = built;
      this._log('uplink-up', { upstream: built.upstream });
      return built.upstream;
    } catch (err) {
      this._log('uplink-start-failed', { upstream: built.upstream, err: err?.message });
      try { await built.transport.stop?.(); } catch { /* dying */ }
      return null;
    }
  }

  /** Uplink status for /healthz. */
  uplinkStatus() {
    return { upstream: this._uplink?.upstream ?? null, connected: !!this._uplink };
  }

  async stop() {
    if (this._uplink)    { try { await this._uplink.transport.stop(); } catch { /* dying */ } }
    if (this._peer)      await this._peer.stop();
    if (this._transport) await this._transport.stop();
    this._peer = this._transport = this._composite = this._uplink = this._engine = this._node = null;
  }

  // ── Public API: feed bridge events into the transport ─────────────

  /**
   * Called by server.js when an `{type:'axona', payload:...}` frame
   * arrives on a browser's WebSocket.
   */
  handleAxonaFrame(connId, payload) {
    this._transport.handleIncoming(connId, payload);
  }

  /**
   * Called by server.js when a browser's WebSocket closes.
   */
  handleConnClosed(connId) {
    this._helloByConnId.delete(connId);
    this._serverNonceByConn.delete(connId);
    this._transport.handleConnClosed(connId);
  }

  /**
   * Called by server.js on welcome — kicks off the hello handshake
   * by sending our 'hello' notification down the browser's WS.
   * Browser replies with 'hello-ack' which our transport receives
   * via handleAxonaFrame; we then bindPeer + admit as Synapse.
   */
  sendHello(connId, serverNonce) {
    if (this._helloByConnId.has(connId)) return;
    this._helloByConnId.set(connId, 'pending');
    if (serverNonce) this._serverNonceByConn.set(connId, serverNonce);
    const cbv = this._bridgeCbv(connId);
    if (!cbv) { this._log('hello-no-cbv', { connId }); return; }
    // Build our AUTHENTICATED hello, signed over the per-connection CBV.
    buildAuthHello({ identity: this._authIdentity, cbv })
      .then((hello) => {
        try {
          this._sendToConn(connId, { type: 'axona', payload: { k: 'ntf', type: 'hello', body: hello } });
        } catch (err) {
          this._log('hello-send-failed', { connId, err: err.message });
        }
      })
      .catch((err) => this._log('hello-build-failed', { connId, err: err.message }));
  }

  // ── Observability for server.js / healthz ─────────────────────────
  getSynaptome() { return this._peer?.getSynaptome() ?? []; }
  getMetrics()   { return this._peer?.getMetrics()   ?? null; }

  // ─────────────────────────────────────────────────────────────────
  // Internal: NH-1 transport handlers + handshake completion
  // ─────────────────────────────────────────────────────────────────

  _registerNH1Handlers() {
    const t = this._transport;
    const node = this._node;
    const engine = this._engine;
    const peer = () => this._peer;

    // Hello / hello-ack ────────────────────────────────────────────
    //
    // Pre-bind notifications arrive with fromMeshIdOrNodeId being a
    // STRING (the connId).  Post-bind they arrive as BigInt (the
    // peer's nodeId).  The orchestrator uses the type to decide.

    // axona/4 — verify the peer's authenticated hello/hello-ack before
    // admitting it.  The peer must prove the nodeId it claims (pubkey
    // hashes to the nodeId suffix + Ed25519 signature over this link's
    // CBV).  A peer that can't — notably one still speaking the legacy
    // axona/3 hello — is closed with 4426 so its kernel prints the
    // upgrade-required console message.
    const verifyPeerHello = async (connId, body, label) => {
      if (typeof connId !== 'string') return;
      const cbv = this._bridgeCbv(connId);
      if (!cbv) { this._log('auth-no-cbv', { connId, label }); return; }
      const res = await verifyAuthHello(body, { cbv });
      if (!res.ok) {
        this._log('auth-peer-rejected', { connId, label, reason: res.reason });
        // Legacy / unauthenticatable peer → tell it to upgrade.
        this._closeConn(connId, `upgrade required: this network speaks axona/4 (${res.reason})`);
        return;
      }
      const peerNodeId = BigInt('0x' + res.nodeId);
      this._completeHandshake(connId, peerNodeId);
      // On an inbound hello, reply with our own authenticated hello-ack.
      if (label === 'hello') {
        try {
          const ack = await buildAuthHello({ identity: this._authIdentity, cbv });
          this._sendToConn(connId, { type: 'axona', payload: { k: 'ntf', type: 'hello-ack', body: ack } });
        } catch (err) {
          this._log('hello-ack-failed', { err: err.message });
        }
      }
    };

    t.onNotification('hello',     (connId, body) => { verifyPeerHello(connId, body, 'hello'); });
    t.onNotification('hello-ack', (connId, body) => { verifyPeerHello(connId, body, 'hello-ack'); });

    // NH-1 routing handlers ────────────────────────────────────────

    t.onRequest('ping', async () => 'pong');

    t.onRequest('lookahead_probe', async (_fromId, payload) => {
      const target   = payload.target;
      const fromDist = payload.fromDist;
      const fwd = [];
      for (const syn of node.synaptome.values()) {
        if ((syn.peerId ^ target) < fromDist) fwd.push(syn);
      }
      if (fwd.length === 0) {
        return { peerId: node.id, latency: 0, terminal: true };
      }
      const best = node.bestByAP(fwd, target, 0);
      return { peerId: best.peerId, latency: best.latency, terminal: false };
    });

    t.onRequest('local_probe', async (fromId, _payload) => {
      const peerIds = [];
      for (const syn of node.synaptome.values()) {
        if (syn.peerId !== fromId) peerIds.push(syn.peerId);
      }
      return peerIds;
    });

    t.onRequest('find_closest_set', async (_fromId, payload) => {
      const targetBig = payload.target;
      const K = payload.K ?? 20;
      const top = [];
      for (const syn of node.synaptome.values()) {
        const d = syn.peerId ^ targetBig;
        if (top.length < K) {
          let i = 0;
          while (i < top.length && top[i].d < d) i++;
          top.splice(i, 0, { peerId: syn.peerId, d });
        } else if (d < top[K - 1].d) {
          let i = 0;
          while (i < top.length && top[i].d < d) i++;
          top.splice(i, 0, { peerId: syn.peerId, d });
          top.pop();
        }
      }
      return top.map(t => t.peerId);
    });

    t.onRequest('lookup_step', async (_fromId, payload) => {
      return await peer()._lookupStep({
        sourceId:    payload.sourceId,
        targetKey:   payload.targetKey,
        hops:        payload.hops,
        path:        payload.path,
        trace:       payload.trace,
        queried:     payload.queried instanceof Set
                       ? payload.queried
                       : Array.isArray(payload.queried)
                           ? new Set(payload.queried)
                           : new Set(),
        totalTimeMs: payload.totalTimeMs,
      });
    });

    t.onNotification('reinforce', (_fromId, payload) => {
      const syn = node.synaptome.get(payload.synapsePeerId);
      if (!syn) return;
      syn.reinforce(engine.simEpoch, engine.INERTIA_DURATION);
      syn.useCount = (syn.useCount ?? 0) + 1;
    });

    t.onNotification('triadic_introduce', async (_fromId, payload) => {
      if (!payload?.peerId) return;
      if (node.synaptome.has(payload.peerId)) return;
      const stratum = clz64(node.id ^ payload.peerId);
      const syn = new Synapse({ peerId: payload.peerId, latencyMs: 0, stratum });
      syn.weight   = 0.5;
      syn.inertia  = engine.simEpoch;
      syn._addedBy = 'triadic';
      try { await peer()._addByVitality(syn); } catch {}
    });

    t.onNotification('hop_cache', async (_fromId, payload) => {
      if (!payload?.target) return;
      if (node.synaptome.has(payload.target)) return;
      const stratum = clz64(node.id ^ payload.target);
      const syn = new Synapse({ peerId: payload.target, latencyMs: 0, stratum });
      syn.weight   = 0.5;
      syn.inertia  = engine.simEpoch;
      syn._addedBy = 'hopCache';
      try { await peer()._addByVitality(syn); } catch {}
    });
    t.onNotification('lateral_spread', async () => { /* no-op */ });

    if (!node._deadPeers) node._deadPeers = new Set();
    t.onPeerDied((deadId) => {
      if (typeof deadId === 'bigint') node._deadPeers.add(deadId);
    });
  }

  /** Multi-hop routed dispatch (mirrors axona-peer/axona_node.js). */
  _registerRouteMsgHandler() {
    // Bind on the composite so routed messages arriving on EITHER the inbound
    // server WS or the outbound uplink reach the router.
    const t = this._node.transport;
    const peer = () => this._peer;
    t.onRequest('route_msg', async (_fromId, body) => {
      const { type, payload, targetId, originId } = body ?? {};
      if (!peer()) return { consumed: false, atNode: null, hops: 0, exhausted: true };
      return peer().routeMessage(targetId, type, payload, { fromId: originId });
    });
  }

  async _completeHandshake(connId, peerNodeId) {
    if (this._helloByConnId.get(connId) === 'complete') return;
    this._helloByConnId.set(connId, 'complete');
    this._transport.bindPeer(peerNodeId, connId);

    // Admit the browser as a Synapse.  Latency stub: getLatency on
    // ws_transport returns 50ms for now.
    if (!this._node.synaptome.has(peerNodeId)) {
      const stratum = clz64(this._node.id ^ peerNodeId);
      const syn = new Synapse({ peerId: peerNodeId, latencyMs: 50, stratum });
      syn.weight   = 0.5;
      syn.inertia  = 0;
      syn._addedBy = 'handshake';
      try { await this._peer._addByVitality(syn); }
      catch (err) {
        this._log('admit-failed', { peerNodeId: idToHex(peerNodeId), err: err.message });
      }
    }

    this._log('handshake-complete', {
      connId,
      peerNodeId: idToHex(peerNodeId),
      synaptomeSize: this._node.synaptome.size,
    });
  }
}
