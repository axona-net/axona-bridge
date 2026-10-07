// directory_feed.js — Bridge fill v0.8 (axona-docs 9b1ed08), the DIRECTORY step
// on a bridge: "a relay asks the bridge for introductions; a bridge IS the
// directory, its candidates are its own admitted connections … plus the
// peer-lists its uplink receives."
//
// WHY THIS EXISTS. The kernel's fill (AxonaPeer._fillDirectoryStep) asks its
// transport `requestPeerIntroductions()` every T drawn in [T/2, 3T/2] while
// below cap, and takes the answer through `transport.onPeerList(handler)`.
// On a relay both are the web transport's: a `peer-list-request` frame to the
// bridge, and the bridge's `peer-list` frame back. A bridge's node transport
// is a CompositeTransport over its WebSocket server and its uplink; neither
// sub-transport asks a bridge for introductions, so on the armed testnet
// bridges of 2026-10-07 the directory step read "none" and the fill reported
// fill-stalled:supply with the door's own population standing right there.
//
// WHAT IT IS. A sealed, peer-less sub-transport that does two things:
//   · `onPeerList(handler)` — the composite's class method fans the kernel's
//     handler onto any sub that exposes this, including one added after the
//     kernel subscribed; so this feed is how a peer-list reaches the kernel.
//   · `request()` — installed on the composite as `requestPeerIntroductions`
//     by the bridge node (only when the fill is armed): draws a sample of at
//     most R_SAMPLE identities from the bridge's own SOURCE (the server hands
//     in a function returning hex nodeIds: admitted bound sockets and
//     recently graduated peers), excludes the bridge itself, and hands it to
//     the handlers ON THE NEXT TURN of the event loop. The deferral matters:
//     the kernel records `sent` after `requestPeerIntroductions()` returns
//     and `answered` when the handler runs (R12-3 — sendability is never an
//     answer); an answer delivered synchronously would be overwritten by
//     `sent`. Returns false when no source is configured ("unavailable");
//     an empty pool is an ANSWER (an empty list), not an outage.
//
// WHAT IT IS NOT. It dials nothing, owns no peer, admits nothing, and orders
// nothing: the kernel's candidate cache ranks by XOR distance and refuses
// what it holds already (in the table or bound), so bound socket identities
// in the sample cost one refused nomination each and are otherwise harmless.
// It is not the bridge directory of v0.15's *Discovery across cohorts* (the
// registry, the sample into a newcomer's handshake, re-contact admission).
import { Transport } from '@axona/protocol/contracts/Transport.js';
import { depositDispatchCapability } from '@axona/protocol/registry/index.js';

/** The design's R_sample (Hold-and-Fill v0.15 parameter table). */
export const R_SAMPLE = 16;

const HEX66 = /^[0-9a-f]{66}$/i;

export class DirectoryFeed extends Transport {
  /**
   * @param {object} opts
   * @param {string} opts.selfHex              this bridge's 66-hex nodeId (never offered)
   * @param {() => string[]} [opts.source]      hex nodeIds the bridge knows of; set later with setSource
   * @param {number} [opts.sampleSize=R_SAMPLE]
   * @param {(event:string, data?:object) => void} [opts.log]
   * @param {() => number} [opts.random=Math.random]  injectable for tests
   */
  constructor({ selfHex, source = null, sampleSize = R_SAMPLE, log = () => {}, random = Math.random }) {
    super();
    if (typeof selfHex !== 'string' || !HEX66.test(selfHex)) throw new TypeError('DirectoryFeed: selfHex must be a 66-hex nodeId');
    this._selfHex = selfHex.toLowerCase();
    this._source = typeof source === 'function' ? source : null;
    this._sampleSize = Number.isInteger(sampleSize) && sampleSize > 0 ? sampleSize : R_SAMPLE;
    this._log = log;
    this._random = random;
    this._handlers = new Set();
    this._pending = new Set();      // deferred deliveries not yet fired (cancelled by stop)
    this._generation = 0;           // bumped by stop; a delivery from an older generation does not fire
    this.stats = { requests: 0, unavailable: 0, served: 0, failed: 0, lastPool: 0, lastSample: 0, lastAt: 0 };
    // The composite fans request/notification handlers onto every sub through
    // its deposited capability and throws on an undeposited one; this feed
    // carries no frames, so both closures accept and drop.
    depositDispatchCapability(this, { request: () => {}, notification: () => {} });
  }

  setSource(fn) { this._source = typeof fn === 'function' ? fn : null; }

  // ── the one surface the kernel reads: peer-lists ─────────────────────
  onPeerList(handler) {
    if (typeof handler !== 'function') throw new TypeError('onPeerList: handler must be a function');
    this._handlers.add(handler);
    return () => { this._handlers.delete(handler); };
  }

  /**
   * Serve one introductions request. Returns true when a sample will be
   * delivered (possibly empty), false when there is no source.
   */
  request() {
    this.stats.requests++;
    if (!this._source) { this.stats.unavailable++; return false; }
    // DF-1 (Aster 26503fb7): a source that throws or returns a non-array is a
    // FAILED evaluation, reported to the kernel as unavailable (false), never
    // as a confirmed empty supply. Only a real array is an answer.
    let pool;
    try { pool = this._source(); } catch (err) { this.stats.unavailable++; this.stats.failed++; this._log('directory-feed-source-threw', { err: err?.message }); return false; }
    if (!Array.isArray(pool)) { this.stats.unavailable++; this.stats.failed++; this._log('directory-feed-source-malformed', { type: typeof pool }); return false; }
    const seen = new Set();
    const cand = [];
    for (const p of pool) {
      if (typeof p !== 'string') continue;
      const h = p.toLowerCase();
      if (!HEX66.test(h) || h === this._selfHex || seen.has(h)) continue;
      seen.add(h); cand.push(h);
    }
    // Uniform sample without replacement (partial Fisher–Yates).
    for (let i = 0; i < cand.length && i < this._sampleSize; i++) {
      const j = i + Math.floor(this._random() * (cand.length - i));
      [cand[i], cand[j]] = [cand[j], cand[i]];
    }
    const sample = cand.slice(0, this._sampleSize);
    this.stats.served++; this.stats.lastPool = cand.length; this.stats.lastSample = sample.length; this.stats.lastAt = Date.now();
    this._log('directory-feed', { pool: cand.length, sample: sample.length });
    // DF-2 (Aster 26503fb7): delivery is deferred to the next turn, but the
    // handlers are read AT FIRE TIME from the live set — a handler that
    // unsubscribed in between (the kernel's stop does) is not called — and a
    // stop() before the turn cancels the delivery outright (the timer is
    // cleared and the generation no longer matches).
    const gen = this._generation;
    const t = setTimeout(() => {
      this._pending.delete(t);
      if (gen !== this._generation) return;
      for (const h of [...this._handlers]) { try { h(sample); } catch (err) { this._log('directory-feed-handler-threw', { err: err?.message }); } }
    }, 0);
    t.unref?.();
    this._pending.add(t);
    return true;
  }

  // ── Transport contract: a peer-less sub-transport ────────────────────
  async start() {}
  async stop() {
    // Cancel every deferred delivery and invalidate any that already left the
    // timer queue; a later start() serves new requests under the new generation.
    this._generation++;
    for (const t of this._pending) clearTimeout(t);
    this._pending.clear();
  }
  getLocalNodeId() { return null; }
  isConnected() { return false; }
  async openConnection() { return false; }
  async closeConnection() {}
  async send(nodeId, type) { throw new Error(`DirectoryFeed.send: owns no peer (${type})`); }
  async notify() {}
  onPeerDied() { return () => {}; }
  getLatency() { return -1; }
}
