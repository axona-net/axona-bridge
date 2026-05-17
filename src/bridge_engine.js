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

  axonFor(_node) {
    throw new Error(
      'BridgeEngine.axonFor: pub/sub not yet wired in the bridge.  ' +
      'Roadmap item; ed25519 keypair + AxonPubSub instance follow.'
    );
  }

  setTheNode(node) { this._theNode = node; }
}
