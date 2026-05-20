// =====================================================================
// bridge_engine.js — engine stub for the bridge's embedded AxonaPeer.
//
// Mirrors axona-peer/src/browser_engine.js — same surface, server-
// flavored defaults.  The bridge is configured as a server-class
// highway node:
//
//   - maxSynaptome:  256   (highway tier — ~5× browser cap)
//   - usually persisted; this version regenerates state per process
//     (the synaptome is rebuilt from handshakes after restart)
//
// All other constants match NH-1 defaults the package's AxonaPeer
// expects.  AxonaPeer's methods read from `this._engine.X`; the
// engine owns shared state (simEpoch, _eventListeners, etc.) and the
// node reference (the bridge has one local node).
// =====================================================================

import { AxonManager } from '@axona/protocol/pubsub/AxonManager.js';

export class BridgeEngine {
  constructor(config = {}) {
    const r = config.rules ?? {};

    // ── Routing / structural constants ───────────────────────────────
    this._k                  = config.k                  ?? 20;
    this.MAX_SYNAPTOME       = r.maxSynaptome            ?? 256;   // highway
    this.LOOKAHEAD_ALPHA     = r.lookaheadAlpha          ?? 5;
    this.MAX_HOPS            = r.maxGreedyHops           ?? 40;
    this.EPSILON             = r.explorationEpsilon      ?? 0.05;
    this.WEIGHT_SCALE        = r.weightScale             ?? 0.40;
    this.ANNEAL_COOLING      = r.annealCooling           ?? 0.9997;
    this.DECAY_GAMMA         = r.decayGamma              ?? 0.995;
    this.DECAY_GAMMA_MIN     = r.decayGammaMin           ?? 0.990;
    this.DECAY_GAMMA_MAX     = r.decayGammaMax           ?? 0.9998;
    this.USE_SATURATION      = r.useSaturation           ?? 20;
    this.INERTIA_DURATION    = r.inertiaDuration         ?? 20;
    this.PROMOTE_THRESHOLD   = r.promoteThreshold        ?? 2;
    this.TRIADIC_THRESHOLD   = r.triadicThreshold        ?? 2;
    this.EN_LATERAL_SPREAD   = r.lateralSpread           ?? true;
    this.EN_ADAPTIVE_DECAY   = r.adaptiveDecay           ?? false;
    this.LATERAL_K           = r.lateralK                ?? 2;
    this.ANNEAL_LOCAL_SAMPLE = r.annealLocalSample       ?? 50;
    this.ANNEAL_RATE_SCALE   = r.annealRateScale         ?? 1.0;
    this.GEO_BITS            = config.geoBits ?? 8;
    this.GEO_REGION_BITS     = r.geoRegionBits ?? Math.min(4, this.GEO_BITS);
    this.STRATA_GROUPS       = 16;
    this.RECENCY_HALF_LIFE   = r.recencyHalfLife         ?? 50;
    this.DECAY_INTERVAL      = 100;
    this.T_INIT              = 1.0;
    this.T_MIN               = 0.05;
    this.T_REHEAT            = 0.5;
    this.VITALITY_FLOOR      = 0.05;

    // ── Shared counters ─────────────────────────────────────────────
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._emaHops          = null;
    this._emaTime          = null;

    // ── Per-node stats ──────────────────────────────────────────────
    this._nodeStats = new Map();

    // ── Event listeners ─────────────────────────────────────────────
    this._eventListeners = new Set();

    // ── Per-node routed/direct handler tables ───────────────────────
    this._routedHandlers = new Map();
    this._directHandlers = new Map();

    this._theNode = null;

    // Per-node AxonManager + AxonaPeer back-ref (set by orchestrator
    // after constructing the AxonaPeer).
    this._peerByNode = new Map();
    this._axonByNode = new Map();
  }

  _emit(event) {
    if (this._eventListeners.size === 0) return;
    for (const h of this._eventListeners) {
      try { h(event); }
      catch (err) { console.error('BridgeEngine: event listener threw:', err); }
    }
  }

  onEvent(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('BridgeEngine.onEvent: handler must be a function');
    }
    this._eventListeners.add(handler);
    return () => this._eventListeners.delete(handler);
  }

  _tickDecay() {
    const node = this._theNode;
    if (!node || !node.alive) return;
    for (const syn of node.synaptome.values()) {
      if (syn.inertia > this.simEpoch) continue;
      let gamma;
      if (this.EN_ADAPTIVE_DECAY) {
        const useFrac = Math.min(1, (syn.useCount ?? 0) / this.USE_SATURATION);
        gamma = this.DECAY_GAMMA_MIN
              + (this.DECAY_GAMMA_MAX - this.DECAY_GAMMA_MIN) * useFrac;
        if (syn.bootstrap) gamma = gamma + (this.DECAY_GAMMA_MAX - gamma) * 0.5;
      } else {
        gamma = this.DECAY_GAMMA;
      }
      syn.decay(gamma);
    }
  }

  _bumpLookupStats(node, found, hops, latency) {
    let s = this._nodeStats.get(node);
    if (!s) {
      s = { attempted: 0, succeeded: 0, sumHops: 0, sumLatency: 0 };
      this._nodeStats.set(node, s);
    }
    s.attempted++;
    if (found) {
      s.succeeded++;
      s.sumHops    += hops;
      s.sumLatency += latency;
    }
  }

  setPeerForNode(node, peer) {
    if (!node || !peer) throw new Error('setPeerForNode: node and peer required');
    this._peerByNode.set(node, peer);
  }

  /** I4: alias `axonManagerFor` → `axonFor` so the kernel's
   *  AxonaPeer._requireAxonManager resolution chain finds our
   *  per-node AxonManager and peer.pub / peer.sub etc. work
   *  without the SDK pre-stashing a handle.  Same pattern as
   *  axona-peer's BrowserEngine (commit 6e613d7). */
  axonManagerFor(node) { return this.axonFor(node); }

  axonFor(node) {
    if (!node) throw new Error('axonFor: node required');
    const cached = this._axonByNode.get(node);
    if (cached) return cached;
    const peer = this._peerByNode.get(node);
    if (!peer) {
      throw new Error(
        'BridgeEngine.axonFor: AxonaPeer not registered for this node. ' +
        'Call engine.setPeerForNode(node, peer) after constructing the peer.'
      );
    }
    // sendDirect: see browser_engine.js for the full rationale.
    //   self        → local dispatch
    //   directly    → peer.sendDirect (1-hop transport.notify)
    //     bound
    //   else        → peer.routeMessage with a '__tunneled_direct__'
    //                 envelope; receiver's routed handler unwraps and
    //                 dispatches into its direct handler table.
    const self = peer.getNodeId();
    const engine = this;
    const dht = {
      getSelfId:       () => peer.getNodeId(),
      findKClosest:    (...args) => peer.findKClosest(...args),
      routeMessage:    (...args) => peer.routeMessage(...args),
      sendDirect:      async (peerId, type, payload) => {
        if (peerId === self) {
          // I4 / Phase 5a: direct-handler table lives on the peer now.
          const h = peer._directHandlers?.get(type);
          if (!h) return false;
          try {
            await h(payload, { fromId: self.toString(16).padStart(16, '0'), type });
            return true;
          } catch (err) {
            console.error('BridgeEngine self-sendDirect handler threw:', err);
            return false;
          }
        }
        // Probe: is the target's connId currently bound + WS open on
        // our WebSocketTransport?  If yes, direct delivery works.
        if (node.transport?.isConnected?.(peerId)) {
          return peer.sendDirect(peerId, type, payload);
        }
        peer.routeMessage(peerId, '__tunneled_direct__', {
          targetId:  peerId.toString(16).padStart(16, '0'),
          innerType: type,
          innerPayload: payload,
        }).catch(err => console.error('BridgeEngine routed sendDirect failed:', err));
        return true;
      },
      onRoutedMessage: (type, h) => peer.onRoutedMessage(type, h),
      onDirectMessage: (type, h) => peer.onDirectMessage(type, h),
    };

    peer.onRoutedMessage('__tunneled_direct__', async (payload, meta) => {
      const targetBig = typeof meta.targetId === 'bigint'
        ? meta.targetId
        : (typeof meta.targetId === 'string'
            ? BigInt('0x' + meta.targetId.replace(/^0x/, ''))
            : null);
      if (targetBig == null) return 'forward';
      if (targetBig !== self) return 'forward';
      // I4 / Phase 5a: direct-handler table lives on the peer now.
      const handler = peer._directHandlers?.get(payload.innerType);
      if (!handler) return 'consumed';
      try {
        await handler(payload.innerPayload, {
          fromId: meta.fromId,
          type:   payload.innerType,
        });
      } catch (err) {
        console.error('BridgeEngine tunneled-direct dispatch threw:', err);
      }
      return 'consumed';
    });

    const axon = new AxonManager({ dht });
    this._axonByNode.set(node, axon);
    return axon;
  }

  setTheNode(node) { this._theNode = node; }
}
