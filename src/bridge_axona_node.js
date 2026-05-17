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
  clz64,
} from '@axona/protocol';

import { BridgeEngine }       from './bridge_engine.js';
import { WebSocketTransport } from './ws_transport.js';
import { loadOrDeriveIdentity, idToHex } from './identity.js';

export class BridgeAxonaNode {
  /**
   * @param {Object} opts
   * @param {(connId: string, msg: object) => boolean} opts.sendToConn
   * @param {(connId: string) => boolean}              opts.isConnOpen
   * @param {(event:string, data?:object) => void}     [opts.log]
   */
  constructor({ sendToConn, isConnOpen, log }) {
    if (typeof sendToConn !== 'function' || typeof isConnOpen !== 'function') {
      throw new TypeError('BridgeAxonaNode: sendToConn + isConnOpen required');
    }
    this._sendToConn = sendToConn;
    this._isConnOpen = isConnOpen;
    this._log = log ?? (() => {});

    this._identity  = null;
    this._engine    = null;
    this._node      = null;
    this._transport = null;
    this._peer      = null;

    /** @type {Map<string, 'pending'|'complete'>} connId → handshake state */
    this._helloByConnId = new Map();
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
    this._identity = loadOrDeriveIdentity();
    this._log('identity-loaded', {
      nodeId: idToHex(this._identity.id),
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

    this._transport = new WebSocketTransport({
      localNodeId: this._identity.id,
      sendToConn:  this._sendToConn,
      isConnOpen:  this._isConnOpen,
      log: this._log,
    });
    this._node.transport = this._transport;
    await this._transport.start(this._identity.id);

    this._registerNH1Handlers();

    this._peer = new AxonaPeer({ engine: this._engine, node: this._node });
    await this._peer.start();

    return this;
  }

  async stop() {
    if (this._peer)      await this._peer.stop();
    if (this._transport) await this._transport.stop();
    this._peer = this._transport = this._engine = this._node = null;
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
    this._transport.handleConnClosed(connId);
  }

  /**
   * Called by server.js on welcome — kicks off the hello handshake
   * by sending our 'hello' notification down the browser's WS.
   * Browser replies with 'hello-ack' which our transport receives
   * via handleAxonaFrame; we then bindPeer + admit as Synapse.
   */
  sendHello(connId) {
    if (this._helloByConnId.has(connId)) return;
    this._helloByConnId.set(connId, 'pending');
    try {
      this._sendToConn(connId, {
        type: 'axona',
        payload: {
          k: 'ntf',
          type: 'hello',
          body: {
            proto: 'axona/3',
            nodeId: idToHex(this._identity.id),
          },
        },
      });
    } catch (err) {
      this._log('hello-send-failed', { connId, err: err.message });
    }
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

    t.onNotification('hello', (fromConnIdOrNodeId, body) => {
      if (typeof fromConnIdOrNodeId !== 'string') return;
      const peerNodeId = BigInt('0x' + body.nodeId);
      this._completeHandshake(fromConnIdOrNodeId, peerNodeId);
      // Reply with hello-ack.
      try {
        this._sendToConn(fromConnIdOrNodeId, {
          type: 'axona',
          payload: {
            k: 'ntf',
            type: 'hello-ack',
            body: {
              proto: 'axona/3',
              nodeId: idToHex(this._identity.id),
            },
          },
        });
      } catch (err) {
        this._log('hello-ack-failed', { err: err.message });
      }
    });

    t.onNotification('hello-ack', (fromConnIdOrNodeId, body) => {
      if (typeof fromConnIdOrNodeId !== 'string') return;
      const peerNodeId = BigInt('0x' + body.nodeId);
      this._completeHandshake(fromConnIdOrNodeId, peerNodeId);
    });

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
        queried:     payload.queried,
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
