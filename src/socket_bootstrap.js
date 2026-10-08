// socket_bootstrap.js — Socket-is-bootstrap v0.5 (axona-docs 7a27d24).
//
// "Once we establish a websocket connection to a bridge, we need to replace
//  it with a webrtc connection. The bridge relay should be the same as a
//  regular relay except that it can graduate a connected node to make room
//  for a newly introduced node." — David, 2026-10-07.
//
// WHAT THIS FILE HOLDS: the pure parts of the bridge half — the env
// resolver and its refusals, the door epoch, the reserved connection id the
// door advertises for itself, the door-domain signalling key and its
// parser, a sliding per-minute retire budget, and the two cooldown scopes
// (per identity, per connection). bridge_axona_node.js wires them into the
// kernel's composite (bind policy), the uplink mesh (attempt and degree
// policies, the door signal sink) and server.js (peer-list, signal, close).
//
// WHAT IT IS NOT: no socket is closed here, no channel retired, no peer
// admitted. Everything here is a decision or a label; the effects live in
// the callers, next to the kernel surfaces they act on.

/** The reserved id's prefix; the door's counter mints `c<n>` and never this. */
export const RESERVED_PREFIX = 'c-self-';
/** The door-domain key prefix: `d<epoch>:<connId>`. A node hex is 66 chars, an
 *  upstream connection id is `c<n>`; neither carries a colon. */
export const DOOR_KEY_PREFIX = 'd';

export const SOCKET_BOOTSTRAP_ENVS = Object.freeze({
  on:            'BRIDGE_SOCKET_IS_BOOTSTRAP',
  provisional:   'BRIDGE_PROVISIONAL_MAX',
  bindDeadline:  'BRIDGE_BIND_DEADLINE_MS',
  makeRoomRate:  'BRIDGE_MAKE_ROOM_PER_MIN',
  minKernel:     'BRIDGE_SOCKET_BOOTSTRAP_MIN_KERNEL',
  cooldownMs:    'BRIDGE_SOCKET_BOOTSTRAP_COOLDOWN_MS',
});

export const SOCKET_BOOTSTRAP_DEFAULTS = Object.freeze({
  provisionalMax:  20,       // open-but-unbound door channels; the newest above it is retired
  bindDeadlineMs:  15000,    // an open door channel still unbound after this is retired
  makeRoomPerMin:  4,        // incumbent retires per sliding minute; above it a newcomer at cap is refused
  minKernel:       '4.107.0',// the kernel that carries the composite route rule and the attempt id
  cooldownMs:      60000,    // identity and connection cooldown after a retire
});

const ON_VALUES = new Set(['1', 'on', 'true', 'yes']);

function strictPosInt(raw, name) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw new TypeError(`${name}: must be a positive integer, got ${JSON.stringify(raw)}`);
  const n = parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name}: must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Resolve the socket-bootstrap configuration from the environment. OFF unless
 * BRIDGE_SOCKET_IS_BOOTSTRAP is set to 1/on/true/yes; with it off every other
 * variable is ignored and the bridge is byte-identical to 2.151.0. With it on,
 * every numeric variable present must be a positive integer (a typo is a
 * refusal at construction, not a silent default).
 */
export function resolveSocketBootstrap(env = process.env) {
  const raw = env[SOCKET_BOOTSTRAP_ENVS.on];
  const on = typeof raw === 'string' && ON_VALUES.has(raw.trim().toLowerCase());
  if (!on) return { on: false };
  const d = SOCKET_BOOTSTRAP_DEFAULTS;
  const minKernel = env[SOCKET_BOOTSTRAP_ENVS.minKernel] ?? d.minKernel;
  if (!/^\d+\.\d+\.\d+$/.test(minKernel)) throw new TypeError(`${SOCKET_BOOTSTRAP_ENVS.minKernel}: must be a semver x.y.z, got ${JSON.stringify(minKernel)}`);
  return {
    on: true,
    provisionalMax: strictPosInt(env[SOCKET_BOOTSTRAP_ENVS.provisional],  SOCKET_BOOTSTRAP_ENVS.provisional)  ?? d.provisionalMax,
    bindDeadlineMs: strictPosInt(env[SOCKET_BOOTSTRAP_ENVS.bindDeadline], SOCKET_BOOTSTRAP_ENVS.bindDeadline) ?? d.bindDeadlineMs,
    makeRoomPerMin: strictPosInt(env[SOCKET_BOOTSTRAP_ENVS.makeRoomRate], SOCKET_BOOTSTRAP_ENVS.makeRoomRate) ?? d.makeRoomPerMin,
    cooldownMs:     strictPosInt(env[SOCKET_BOOTSTRAP_ENVS.cooldownMs],   SOCKET_BOOTSTRAP_ENVS.cooldownMs)   ?? d.cooldownMs,
    minKernel,
  };
}

/**
 * The kernel surfaces the flag needs (kernel ≥ 4.107.0). With the flag on
 * and any of them missing the bridge REFUSES to come up with a mesh, rather
 * than run a door that advertises itself to clients whose binds the composite
 * cannot route-switch. Returns the list of missing names (empty = ok).
 */
export function missingKernelSurfaces({ meshTransport, composite, peer }) {
  const missing = [];
  if (typeof composite?.setBindPolicy !== 'function')             missing.push('composite.setBindPolicy');
  if (typeof composite?.routeOf !== 'function')                   missing.push('composite.routeOf');
  if (typeof peer?.gatePreflight !== 'function')                  missing.push('peer.gatePreflight');
  if (typeof meshTransport?.setDoorSignalSink !== 'function')     missing.push('webTransport.setDoorSignalSink');
  if (typeof meshTransport?.mesh?.setAttemptPolicy !== 'function') missing.push('mesh.setAttemptPolicy');
  if (typeof meshTransport?.mesh?.setDegreePolicy !== 'function')  missing.push('mesh.setDegreePolicy');
  if (typeof meshTransport?.mesh?.retireForNewcomer !== 'function') missing.push('mesh.retireForNewcomer');
  return missing;
}
export function assertKernelSurfaces(parts) {
  const missing = missingKernelSurfaces(parts);
  if (missing.length) throw new Error(`socket-bootstrap refused: the installed kernel lacks ${missing.join(', ')} (needs @axona/protocol ≥ ${SOCKET_BOOTSTRAP_DEFAULTS.minKernel}); unset ${SOCKET_BOOTSTRAP_ENVS.on} or upgrade the pin`);
}

/** A short random door epoch, minted once per door process start. */
export function mintDoorEpoch(random = Math.random) {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}

export function reservedId(epoch)        { return `${RESERVED_PREFIX}${epoch}`; }
export function isReservedIdOf(id, epoch){ return typeof id === 'string' && id === reservedId(epoch); }
export function doorKey(epoch, connId)   { return `${DOOR_KEY_PREFIX}${epoch}:${connId}`; }

/** Parse a door-domain key; null for anything else (a node hex, a `c<n>`). */
export function parseDoorKey(key) {
  if (typeof key !== 'string' || key[0] !== DOOR_KEY_PREFIX) return null;
  const i = key.indexOf(':');
  if (i <= 1 || i === key.length - 1) return null;
  return { epoch: key.slice(1, i), connId: key.slice(i + 1) };
}

/** Is `key` a door key of THIS epoch? */
export function isOwnDoorKey(key, epoch) {
  const p = parseDoorKey(key);
  return !!p && p.epoch === epoch;
}

/** gte on dotted versions (same rule server.js uses). */
export function gteVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Sliding budget: at most `perMin` events in any trailing 60 s window (Aster
 * 96992789 B: a fixed window doubles at its boundary; this one cannot).
 */
export class SlidingBudget {
  constructor(perMin, windowMs = 60000) { this.perMin = perMin; this.windowMs = windowMs; this._ts = []; this.spent = 0; this.refused = 0; }
  _prune(now) { while (this._ts.length && now - this._ts[0] >= this.windowMs) this._ts.shift(); }
  ok(now = Date.now()) { this._prune(now); const ok = this._ts.length < this.perMin; if (!ok) this.refused++; return ok; }
  spend(now = Date.now()) { this._prune(now); this._ts.push(now); this.spent++; }
  inWindow(now = Date.now()) { this._prune(now); return this._ts.length; }
}

/**
 * The two cooldown scopes after a make-room retire, both AFTER identification
 * (§ Capacity: neither bounds pre-auth work): the victim's identity is refused
 * a bind for cooldownMs; the victim's connection id is refused a new
 * negotiation to the reserved id for cooldownMs.
 */
export class RecentlyRetired {
  constructor(cooldownMs) { this.cooldownMs = cooldownMs; this._ids = new Map(); this._conns = new Map(); this.refusedIdentity = 0; this.refusedConn = 0; }
  _live(map, key, now) {
    const at = map.get(key);
    if (at == null) return false;
    if (now - at < this.cooldownMs) return true;
    map.delete(key);
    return false;
  }
  markIdentity(idHex, now = Date.now()) { if (idHex) this._ids.set(idHex, now); this._bound(now); }
  markConn(connId, now = Date.now())    { if (connId) this._conns.set(connId, now); this._bound(now); }
  hasIdentity(idHex, now = Date.now())  { const r = this._live(this._ids, idHex, now); if (r) this.refusedIdentity++; return r; }
  hasConn(connId, now = Date.now())     { const r = this._live(this._conns, connId, now); if (r) this.refusedConn++; return r; }
  _bound(now) {
    if (this._ids.size > 1000)   for (const [k, t] of this._ids)   if (now - t >= this.cooldownMs) this._ids.delete(k);
    if (this._conns.size > 1000) for (const [k, t] of this._conns) if (now - t >= this.cooldownMs) this._conns.delete(k);
  }
  stats() { return { identities: this._ids.size, conns: this._conns.size, refusedIdentity: this.refusedIdentity, refusedConn: this.refusedConn }; }
}
