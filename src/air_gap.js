// =====================================================================
// air_gap.js — Bridge-Air-Gap-Plan v0.3 §7.2, as amended by v0.4 §7.2.1–7.2.3,
//              v0.5 §7.2.4/§7.2.6, v0.6 §7.2.2/§7.2.4/O6 (axona-docs/implementation).
//
// The bridge's one job is to introduce a node to the mesh. Every frame that
// reaches it is therefore either about THIS connection (control, handshake,
// signalling to one named neighbour), about the bridge's OWN table (discovery
// answered from local state, link maintenance), or about a named directory
// topic the bridge is terminal for. Nothing else. A frame outside that set is
// refused (requests) or dropped (notifications) and counted; a frame that would
// leave the bridge carrying another node's traffic is never written.
//
// This module holds the three things the plan makes observable:
//   1. the ingress partition — every application message handed to the decoder
//      lands in exactly ONE outcome bucket (v0.4 §7.2.2, v0.6 denominator);
//   2. the per-connection bounds behind those outcomes (v0.5 §7.2.4) — token
//      buckets on N tracked slots plus one overflow aggregate;
//   3. the egress classes at each physical write (v0.5 §7.2.6) — the client
//      socket's send and the uplink socket's send — with `genericTransit` the
//      class that is counted and NOT written.
// Plus the two transport-level labels outside the partition (v0.6 O6):
// `oversizeLocal` and `close1009`.
//
// Counters are fixed-size: outcome × a fixed type taxonomy (listed names,
// `direct_*` as one bucket, `other`). Nothing here allocates per unknown type.
// =====================================================================

// D5: one WebRTC data-channel message is ~16 KiB; a bridge frame is never larger.
export const MAX_PAYLOAD_BYTES = 16 * 1024;
// D5: per-connection bound state for this many connections; the rest share one
// overflow slot (still bounded, coarser).
export const TRACKED_SLOTS = 256;

// ── Ingress allow-lists (v0.4 §7.2.1) ─────────────────────────────────
// Bare frames: the six envelope types server.js recognises outside `axona`.
export const BARE_TYPES = Object.freeze(['client-hello', 'ping', 'peer-list-request', 'turn-refresh', 'signal', 'pong']);
// The bare request-like frames (they have their own bare replies).
export const BARE_REQUEST_LIKE = Object.freeze(new Set(['client-hello', 'ping', 'peer-list-request', 'turn-refresh']));
// `axona` requests the bridge answers from its own table, plus route_msg (gated further).
export const REQ_ALLOW = Object.freeze(new Set(['ping', 'lookup_step', 'find_closest_set', 'local_probe', 'lookahead_probe', 'route_msg']));
// `axona` notifications that terminate in the bridge's own table.
export const NTF_ALLOW = Object.freeze(new Set(['hello-ack', 'hop_cache', 'triadic_introduce', 'reinforce', 'lateral_spread', 'presence', 'peer-leaving']));
// route_msg inner verbs the bridge dispatches as a local root of a named directory topic.
export const ROUTE_MSG_VERBS = Object.freeze(new Set(['pubsub:sub', 'pubsub:unsub', 'pubsub:pull', 'pubsub:pullup', 'pubsub:pub']));
// Role-delivery and tunnelled frames: never dispatched at a bridge, whatever the addressing.
const DIRECT_RE = /^direct_|^axona:direct$|^mesh:signal$/;
const DISCOVERY_REQ = new Set(['lookup_step', 'find_closest_set', 'local_probe', 'lookahead_probe']);
const LINK_MAINT = new Set(['hop_cache', 'triadic_introduce', 'reinforce', 'lateral_spread', 'presence', 'peer-leaving', 'ping']);
// DELIVER, replay, PULLRESP to a subscriber of a named topic (§7.2.6 class 8).
const SERVE_VERBS = new Set(['pubsub:deliver', 'pubsub:replayup', 'pubsub:pullresp']);

// Per-connection bounds (v0.5 §7.2.4): token bucket {burst, perSec}. A frame
// over its bound is `droppedRate` / `refusedRate`. Before admission every bound
// except client-hello's is zero. These are per-CONNECTION bounds; no aggregate
// bound is claimed (D8 open).
export const BOUNDS = Object.freeze({
  'client-hello':      { burst: 1,   perSec: 0 },          // once per connection
  'ping':              { burst: 5,   perSec: 1 },          // 1 Hz (kernel heartbeat is ~0.1 Hz)
  'peer-list-request': { burst: 3,   perSec: 0.1 },
  'turn-refresh':      { burst: 3,   perSec: 1 / 60 },     // credential lives 2 h
  'signal':            { burst: 200, perSec: 40 },         // ICE trickle bursts
  'hello-ack':         { burst: 1,   perSec: 0 },          // once per connection
  'lookup_step':       { burst: 100, perSec: 20 },
  'find_closest_set':  { burst: 100, perSec: 20 },
  'local_probe':       { burst: 100, perSec: 20 },
  'lookahead_probe':   { burst: 600, perSec: 200 },        // D1: answered; pre-4.89 clients still probe
  'route_msg':         { burst: 60,  perSec: 20 },
  'hop_cache':         { burst: 200, perSec: 50 },
  'triadic_introduce': { burst: 200, perSec: 50 },
  'reinforce':         { burst: 200, perSec: 50 },
  'lateral_spread':    { burst: 200, perSec: 50 },
  'presence':          { burst: 200, perSec: 50 },
  'peer-leaving':      { burst: 20,  perSec: 1 },
});

// ── Fixed taxonomies ──────────────────────────────────────────────────
export const INGRESS_OUTCOMES = Object.freeze([
  'droppedInvalid',
  'responseMatched', 'droppedUnsolicited',
  'droppedUnlisted', 'droppedDirect', 'droppedRate', 'droppedSchema',
  'refusedUnlisted', 'refusedRate', 'refusedTransit', 'refusedNested', 'refusedSchema',
  'dispatchedLocal', 'signalRelayed',
]);
// Outcomes that carry a per-type breakdown (drops and refusals).
const NEGATIVE = new Set(INGRESS_OUTCOMES.filter((o) => /^(dropped|refused)/.test(o)));
export const EGRESS_CLASSES = Object.freeze([
  'directorySync', 'refusalReply', 'discoveryReply', 'discoveryRequest', 'controlReply',
  'controlBare',        // addition to v0.5 §7.2.6: bare admission/registry frames (version-gate,
                        // welcome, peer-list on admission, peer-joined, peer-left, turn) and the
                        // bridge's own client-side control frames on the uplink
  'hello', 'signalRelay', 'directoryServe', 'directoryOwnEntry', 'directoryRepublish',
  'linkMaintenance',    // addition: the bridge's own-table notifications to a neighbour
  'genericTransit',     // counted, never written
]);
const LISTED_TYPES = new Set([
  ...BARE_TYPES, ...REQ_ALLOW, ...NTF_ALLOW, 'hello', 'directory:sync', '__tunneled_direct__',
]);
export function typeKey(type) {
  if (typeof type !== 'string') return 'other';
  if (DIRECT_RE.test(type)) return 'direct_*';
  return LISTED_TYPES.has(type) ? type : 'other';
}
const TYPE_KEYS = Object.freeze([...LISTED_TYPES, 'direct_*', 'other']);

const lowerHex = (v) => {
  if (typeof v === 'bigint') return v.toString(16).padStart(66, '0');
  if (typeof v !== 'string') return null;
  const h = v.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(h) ? h.padStart(66, '0') : null;
};
export function topicOf(body) {
  if (!body || typeof body !== 'object') return null;
  return lowerHex(body.topicId ?? body.topic ?? null);
}

function zeroed(keys) { const o = {}; for (const k of keys) o[k] = 0; return o; }

export class AirGap {
  /**
   * @param {object} [o]
   * @param {string|bigint|null} [o.selfId]        this bridge's node id (hex or bigint)
   * @param {(topicHex: string|null) => boolean} [o.isDirectoryTopic]
   * @param {() => number} [o.now]
   * @param {number} [o.trackedSlots]
   * @param {object} [o.bounds]
   */
  constructor({ selfId = null, isDirectoryTopic = null, now = Date.now, trackedSlots = TRACKED_SLOTS, bounds = BOUNDS } = {}) {
    this._selfHex = lowerHex(selfId);
    this._isDirectoryTopic = typeof isDirectoryTopic === 'function' ? isDirectoryTopic : () => false;
    this._now = now;
    this._trackedSlots = trackedSlots;
    this._bounds = bounds;

    this.ingress = zeroed(INGRESS_OUTCOMES);
    this.ingressByType = {};
    for (const o of NEGATIVE) this.ingressByType[o] = zeroed(TYPE_KEYS);
    this.transport = { oversizeLocal: 0, close1009: 0 };
    this.egress = { client: zeroed(EGRESS_CLASSES), uplink: zeroed(EGRESS_CLASSES) };
    this.egressRefused = { client: 0, uplink: 0 };   // genericTransit writes NOT performed
    this.directory = { rootUnreachable: 0, staleRoot: 0, ownEntrySent: 0 };

    /** @type {Map<string, object>} connId → slot */
    this._slots = new Map();
    this._overflow = this._newSlot('overflow');
    this.overflowHits = 0;      // frames handled through the shared overflow slot (per frame, not per connection:
                                // a per-connection count would need per-connection state, which is what the cap avoids)
    this._logMark = this._snapshotCounts();
  }

  setSelfId(id) { this._selfHex = lowerHex(id); }
  get selfHex() { return this._selfHex; }

  // ── slots ───────────────────────────────────────────────────────────
  _newSlot(id) {
    return { id, buckets: new Map(), oversizeLocal: 0, close1009: 0, outcomes: zeroed(INGRESS_OUTCOMES) };
  }
  slotFor(connId) {
    let s = this._slots.get(connId);
    if (s) return s;
    if (this._slots.size >= this._trackedSlots) { this.overflowHits++; return this._overflow; }
    s = this._newSlot(connId);
    this._slots.set(connId, s);
    return s;
  }
  releaseSlot(connId) { this._slots.delete(connId); }
  get trackedCount() { return this._slots.size; }

  /** Token bucket per (slot, type). Returns true when the frame is inside its bound. */
  _withinBound(slot, type) {
    const b = this._bounds[type];
    if (!b) return true;                                  // no bound declared → unbounded (listed types all have one)
    const now = this._now();
    let bk = slot.buckets.get(type);
    if (!bk) { bk = { tokens: b.burst, last: now }; slot.buckets.set(type, bk); }
    else {
      const dt = Math.max(0, now - bk.last) / 1000;
      bk.tokens = Math.min(b.burst, bk.tokens + dt * b.perSec);
      bk.last = now;
    }
    if (bk.tokens >= 1) { bk.tokens -= 1; return true; }
    return false;
  }

  // ── ingress partition ───────────────────────────────────────────────
  _record(slot, outcome, type) {
    this.ingress[outcome]++;
    slot.outcomes[outcome]++;
    if (NEGATIVE.has(outcome)) this.ingressByType[outcome][typeKey(type)]++;
    return outcome;
  }

  /** Decode failed, or the decoded value is not a recognised envelope. */
  invalid(connId) { return this._record(this.slotFor(connId), 'droppedInvalid', null); }

  /**
   * A bare (non-`axona`) frame. Returns the outcome; `dispatchedLocal` means
   * server.js should handle it, `signalRelayed` is recorded by server.js AFTER a
   * relay succeeds via {@link signalRelayed}. `signal` returns `dispatchedLocal`
   * here when in bound; the destination check is server.js's (it owns the
   * registry) and reports back through {@link signalDropped}.
   */
  bare(connId, msg, { admitted }) {
    const slot = this.slotFor(connId);
    const type = msg?.type;
    if (!BARE_TYPES.includes(type)) return this._record(slot, 'droppedUnlisted', type);
    if (type === 'pong') return this._record(slot, 'droppedUnsolicited', type);   // the bridge never pings a client
    if (!admitted && type !== 'client-hello') return this._record(slot, 'droppedRate', type);   // bound is zero before admission
    if (admitted && type === 'client-hello') return this._record(slot, 'droppedRate', type);    // once per connection
    const req = BARE_REQUEST_LIKE.has(type);
    if (!this._withinBound(slot, type)) return this._record(slot, req ? 'refusedRate' : 'droppedRate', type);
    return this._record(slot, 'dispatchedLocal', type);
  }
  /** server.js relayed a bare signal to a named admitted connection. Moves the
   *  frame from dispatchedLocal to signalRelayed (one outcome per frame). */
  signalRelayed(connId) {
    const slot = this.slotFor(connId);
    this.ingress.dispatchedLocal--; slot.outcomes.dispatchedLocal--;
    this.ingress.signalRelayed++;  slot.outcomes.signalRelayed++;
  }
  /** server.js could not relay a bare signal (no/unadmitted destination). */
  signalDropped(connId) {
    const slot = this.slotFor(connId);
    this.ingress.dispatchedLocal--; slot.outcomes.dispatchedLocal--;
    this._record(slot, 'droppedSchema', 'signal');
  }

  /**
   * An `axona` payload {k, type, ...}. Returns { outcome, reply } where reply is
   * the refusal body for a request (null for notifications and responses).
   * `hasPending(id)` answers whether a `res` matches an outstanding request.
   */
  axona(connId, payload, { admitted, hasPending }) {
    const slot = this.slotFor(connId);
    if (!payload || typeof payload !== 'object') return { outcome: this._record(slot, 'droppedInvalid', null), reply: null };
    const { k, type } = payload;
    if (k === 'res') {
      const matched = typeof hasPending === 'function' && hasPending(payload.id);
      return { outcome: this._record(slot, matched ? 'responseMatched' : 'droppedUnsolicited', 'res'), reply: null };
    }
    if (k === 'ntf') {
      if (typeof type !== 'string') return { outcome: this._record(slot, 'droppedInvalid', null), reply: null };
      if (DIRECT_RE.test(type)) return { outcome: this._record(slot, 'droppedDirect', type), reply: null };
      if (!NTF_ALLOW.has(type)) return { outcome: this._record(slot, 'droppedUnlisted', type), reply: null };
      if (!admitted) return { outcome: this._record(slot, 'droppedRate', type), reply: null };
      if (!this._withinBound(slot, type)) return { outcome: this._record(slot, 'droppedRate', type), reply: null };
      if (payload.body !== undefined && (payload.body === null || typeof payload.body !== 'object')) {
        return { outcome: this._record(slot, 'droppedSchema', type), reply: null };
      }
      return { outcome: this._record(slot, 'dispatchedLocal', type), reply: null };
    }
    if (k === 'req') {
      if (typeof type !== 'string') return { outcome: this._record(slot, 'droppedInvalid', null), reply: null };
      const refuse = (outcome) => ({ outcome: this._record(slot, outcome, type), reply: this._refusal(type, outcome, payload) });
      if (!REQ_ALLOW.has(type)) return refuse('refusedUnlisted');            // includes __tunneled_direct__
      if (!admitted) return refuse('refusedRate');
      if (!this._withinBound(slot, type)) return refuse('refusedRate');
      if (type === 'route_msg') {
        const why = this.routeMsgOutcome(payload.body);
        if (why) return refuse(why);
      } else if (payload.body !== undefined && (payload.body === null || typeof payload.body !== 'object')) {
        return refuse('refusedSchema');
      }
      return { outcome: this._record(slot, 'dispatchedLocal', type), reply: null };
    }
    return { outcome: this._record(slot, 'droppedInvalid', null), reply: null };
  }

  /**
   * v0.4 §7.2.1/§7.2.2 for route_msg: null when the frame may be dispatched
   * locally, else the refusal outcome. Addressed to the bridge's own id or to a
   * named directory topic id; inner verb one of five; inner topic a named
   * directory topic; nothing nested.
   */
  routeMsgOutcome(body) {
    if (!body || typeof body !== 'object') return 'refusedSchema';
    const target = lowerHex(body.targetId);
    if (target === null) return 'refusedSchema';
    const self = this._selfHex;
    const toSelf = self !== null && target === self;
    const toDirectory = this._isDirectoryTopic(target);
    if (!toSelf && !toDirectory) return 'refusedTransit';
    const inner = body.type;
    if (typeof inner !== 'string') return 'refusedSchema';
    if (inner === 'route_msg' || inner === '__tunneled_direct__' || DIRECT_RE.test(inner)) return 'refusedNested';
    if (!ROUTE_MSG_VERBS.has(inner)) return 'refusedNested';
    const topic = topicOf(body.payload);
    if (topic === null) return 'refusedSchema';
    if (!this._isDirectoryTopic(topic)) return 'refusedNested';
    return null;
  }

  _refusal(type, outcome, payload) {
    const base = { error: 'transit-refused', outcome };
    if (type === 'route_msg') {
      const hops = Number.isInteger(payload?.body?.hops) ? payload.body.hops : 0;
      return { consumed: false, terminal: true, refused: true, hops, ...base };
    }
    return base;
  }

  // ── transport-level labels (v0.6 O6) ────────────────────────────────
  oversizeLocal(connId) { this.transport.oversizeLocal++; this.slotFor(connId).oversizeLocal++; }
  close1009(connId)     { this.transport.close1009++;     this.slotFor(connId).close1009++; }

  // ── egress classes (v0.5 §7.2.6) ─────────────────────────────────────
  /**
   * @param {object} msg   the outbound envelope (bare or {type:'axona', payload})
   * @param {object} [meta] { reqType, inReplyTo, republish }
   * @returns {string} one of EGRESS_CLASSES
   */
  classifyEgress(msg, meta = {}) {
    if (!msg || typeof msg !== 'object') return 'genericTransit';
    if (msg.type !== 'axona') {
      switch (msg.type) {
        case 'signal':       return 'signalRelay';
        case 'pong':         return 'controlReply';
        case 'peer-list':
        case 'turn':         return meta.inReplyTo ? 'controlReply' : 'controlBare';
        case 'version-gate': case 'welcome': case 'peer-joined': case 'peer-left':
        case 'client-hello': case 'ping': case 'peer-list-request': case 'turn-refresh':
          return 'controlBare';
        default:             return 'genericTransit';
      }
    }
    const p = msg.payload;
    if (!p || typeof p !== 'object') return 'genericTransit';
    if (p.k === 'res') {
      const b = p.body;
      if (b && typeof b === 'object' && (b.error === 'transit-refused' || b.refused === true)) return 'refusalReply';
      if (meta.reqType === 'directory:sync') return 'directorySync';
      if (DISCOVERY_REQ.has(meta.reqType)) return 'discoveryReply';
      return 'controlReply';
    }
    const t = p.type;
    if (p.k === 'ntf') {
      if (t === 'hello' || t === 'hello-ack') return 'hello';
      if (LINK_MAINT.has(t)) return 'linkMaintenance';
      if (typeof t === 'string' && t.startsWith('direct_')) {
        const inner = t.slice('direct_'.length);
        if (SERVE_VERBS.has(inner) && this._isDirectoryTopic(topicOf(p.body))) return 'directoryServe';
      }
      return 'genericTransit';
    }
    if (p.k === 'req') {
      if (t === 'directory:sync') return 'directorySync';
      if (t === 'lookup_step' || t === 'find_closest_set') return 'discoveryRequest';
      if (t === 'ping') return 'linkMaintenance';
      if (t === 'route_msg') {
        const b = p.body;
        if (!b || typeof b !== 'object') return 'genericTransit';
        const origin = lowerHex(b.originId);
        if (this._selfHex === null || origin !== this._selfHex) return 'genericTransit';   // carrying a received frame
        if (!this._isDirectoryTopic(topicOf(b.payload))) return 'genericTransit';
        if (b.type === 'pubsub:pub') return meta.republish ? 'directoryRepublish' : 'directoryOwnEntry';
        if (SERVE_VERBS.has(b.type)) return 'directoryServe';
        return 'genericTransit';
      }
      return 'genericTransit';
    }
    return 'genericTransit';
  }

  /**
   * Classify and count one physical write. Returns { cls, allowed }; a
   * `genericTransit` write is counted under egressRefused and NOT allowed.
   * @param {'client'|'uplink'} point
   */
  egressWrite(point, msg, meta = {}) {
    const cls = this.classifyEgress(msg, meta);
    const table = this.egress[point] ?? this.egress.client;
    table[cls]++;
    if (cls === 'genericTransit') { this.egressRefused[point === 'uplink' ? 'uplink' : 'client']++; return { cls, allowed: false }; }
    return { cls, allowed: true };
  }

  // ── reporting ───────────────────────────────────────────────────────
  _snapshotCounts() {
    return {
      ingress: { ...this.ingress },
      transport: { ...this.transport },
      egressClient: { ...this.egress.client },
      egressUplink: { ...this.egress.uplink },
      egressRefused: { ...this.egressRefused },
      directory: { ...this.directory },
    };
  }
  /** Operator-facing snapshot (/healthz full body, /diag). */
  snapshot() {
    const decoded = INGRESS_OUTCOMES.reduce((n, o) => n + this.ingress[o], 0);
    const transitAttempted = this.ingress.refusedTransit + this.ingress.refusedNested + this.ingress.droppedDirect;
    const byType = {};
    for (const o of NEGATIVE) {
      const row = {};
      for (const [k, v] of Object.entries(this.ingressByType[o])) if (v) row[k] = v;
      if (Object.keys(row).length) byType[o] = row;
    }
    return {
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      trackedSlots: this._trackedSlots,
      slotsInUse: this._slots.size,
      overflowHits: this.overflowHits,
      ingress: { ...this.ingress, decoded, transitAttempted },
      ingressByType: byType,
      transport: { ...this.transport },
      egress: { client: { ...this.egress.client }, uplink: { ...this.egress.uplink } },
      egressRefused: { ...this.egressRefused },
      forwardedGeneric: this.egress.client.genericTransit + this.egress.uplink.genericTransit,   // attempts; none written
      directory: { ...this.directory },
    };
  }
  /**
   * One aggregated row per interval (v0.5 §7.2.4): the deltas since the last
   * call, or null when nothing negative happened. Positive outcomes are omitted
   * from the row; they are on /healthz.
   */
  drainLog() {
    const cur = this._snapshotCounts();
    const prev = this._logMark;
    this._logMark = cur;
    const delta = {};
    let any = false;
    for (const [o, v] of Object.entries(cur.ingress)) {
      if (!NEGATIVE.has(o)) continue;
      const d = v - prev.ingress[o];
      if (d) { delta[o] = d; any = true; }
    }
    for (const k of ['oversizeLocal', 'close1009']) {
      const d = cur.transport[k] - prev.transport[k];
      if (d) { delta[k] = d; any = true; }
    }
    const gt = (cur.egressClient.genericTransit - prev.egressClient.genericTransit)
             + (cur.egressUplink.genericTransit - prev.egressUplink.genericTransit);
    if (gt) { delta.genericTransitRefused = gt; any = true; }
    for (const k of ['rootUnreachable', 'staleRoot']) {
      const d = cur.directory[k] - prev.directory[k];
      if (d) { delta[k] = d; any = true; }
    }
    return any ? delta : null;
  }
}
