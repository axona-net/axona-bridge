// kernel_log.js — O1: the bridge's kernel events reach the bridge's log.
//
// WHY THIS EXISTS. A bridge runs a full kernel peer, and that peer already
// decides things we cannot otherwise see: it refuses a role (`role-refused`
// with a `why`), it declines a reroute (`undeliverable refused-no-forward`),
// it answers placement queries. None of that reaches the bridge's stdout,
// because nothing on a bridge ever subscribes to the kernel's log surface. So
// in the alert-bot diagnosis every bridge-side cell reads UNKNOWN, and a
// refusal at a bridge can only be inferred from the PREVIOUS hop's ledger.
// This module closes that gap, and nothing else.
//
// WHY IT IS NOT A ROUTING CHANGE, and how to check that claim rather than
// take it. Every call here is a registration or a read:
//   - `am.setLogSink(fn)` assigns one field the kernel calls on the way OUT of
//     a decision that has already been made (AxonaManager._log). Its return
//     value is discarded and it is wrapped in try/catch by the caller.
//   - `peer.onLog(level, fn)` appends to a handler set. On a bridge the peer
//     holds no `_transport`, so the kernel's transport log hook returns early
//     and not even that field is rewritten.
// There is no call into placement, admission, routing or the wire. A reviewer
// should be able to confirm that by reading this file top to bottom; it
// deliberately imports nothing.
//
// THE TWO INTAKES, and why both. The kernel has one log sink per manager, and
// AxonaPeer claims it lazily: `_wireManagerLog` points the sink at the peer's
// own `_emitLog` the first time anything calls `_requireAxonaManager` (a pub
// or a sub). A bridge with the directory ON eventually publishes and so gets
// that wiring; a bridge with `BRIDGE_DIRECTORY=off` may never publish at all
// and would keep whatever sink it had. Wiring only one intake therefore loses
// rows on one of the two bridges. Wiring both loses none, and cannot double:
// there is exactly one `_logSink` field, so either it is ours (direct rows) or
// it is the peer's (rows arrive through `onLog`) — never both at once.
//
// COST CONTROL. With LAT_TRACE=1 the kernel emits a row per hop per message.
// On an idle testnet that is nothing; under a burst it is a lot, and a bridge
// that fills its disk during a run destroys the run it was installed to
// measure. So rows are bounded per second and the overflow is COUNTED, not
// hidden: a `kernel-log-throttled` row carries how many were dropped. A gap in
// this log is always visible as a number.

/** Levels forwarded to the bridge log. `debug` is deliberately not one of them. */
export const KERNEL_LOG_LEVELS = Object.freeze(['info', 'warn', 'error']);

/** Default ceiling on rows per second, per level-set. Overflow is counted. */
export const DEFAULT_MAX_ROWS_PER_SEC = 400;

/** Longest string kept inside a context value before it is cut. */
export const MAX_STRING = 512;

/** Most array elements kept inside a context value. */
export const MAX_ARRAY = 32;

/** Ceiling on one row's serialized context. Over this, the row is summarized. */
export const MAX_CONTEXT_BYTES = 4096;

/** Is O1 armed? Off unless explicitly on, so an unset environment is today's bridge. */
export function kernelLogOn(env = process.env) {
  return String(env.BRIDGE_KERNEL_LOG ?? 'off').toLowerCase() === 'on';
}

/** Is the kernel's per-stage trace armed? Read for reporting only — the kernel owns this gate. */
export function latTraceOn(env = process.env) {
  return String(env.LAT_TRACE ?? '') === '1';
}

/**
 * Make a kernel context safe to hand to JSON.stringify, and bounded.
 *
 * BigInts become 66-character lowercase hex, the same spelling `idToHex` gives
 * every other node id in this log, so a bridge row joins to a relay row by
 * string equality. That is the whole reason for not using the wire's
 * "<digits>n" convention here: the wire is for peers, this file is for an
 * analyst. Values that are neither id-shaped nor serializable degrade to a
 * tagged string rather than throwing — a log line must never be able to kill
 * the process it is describing.
 */
export function safeContext(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'bigint') {
    try { return value.toString(16).padStart(66, '0'); } catch { return '<bigint>'; }
  }
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
  if (t === 'function') return '<fn>';
  if (t === 'symbol') return String(value);
  if (depth >= 4) return '<depth>';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => safeContext(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…(${value.length})`] : head;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Map) return safeContext([...value.keys()].slice(0, MAX_ARRAY), depth + 1);
  if (value instanceof Set) return safeContext([...value].slice(0, MAX_ARRAY), depth + 1);
  if (t === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n >= 64) { out['…'] = 'keys truncated'; break; }
      try { out[k] = safeContext(value[k], depth + 1); } catch { out[k] = '<unserializable>'; }
      n++;
    }
    return out;
  }
  return String(value);
}

/**
 * Serialize a context and keep it under MAX_CONTEXT_BYTES. An oversized row is
 * replaced by its own shape — key names and byte count — because "this row was
 * too big, here is what it was about" is diagnosable and a silent drop is not.
 */
export function boundedContext(ctx) {
  const safe = safeContext(ctx);
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) return { value: safe };
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(safe)); } catch { bytes = MAX_CONTEXT_BYTES + 1; }
  if (bytes <= MAX_CONTEXT_BYTES) return safe;
  return { oversized: true, bytes, keys: Object.keys(safe).slice(0, 64) };
}

/**
 * Wire the bridge's kernel peer and pub/sub manager into the bridge's own
 * structured log.
 *
 * @param {object}   o
 * @param {object}   [o.peer]           the AxonaPeer (for the onLog intake)
 * @param {object}   [o.axonaManager]   the bridge's AxonaManager (for the sink intake)
 * @param {(level: string, event: string, fields: object) => void} o.sink
 * @param {object}   [o.env]            defaults to process.env
 * @param {number}   [o.maxRowsPerSec]
 * @param {() => number} [o.now]        injectable clock, for the fence
 * @returns {{installed: boolean, reason: string|null, intakes: string[],
 *            stats: () => object, uninstall: () => void}}
 */
export function installKernelLog({
  peer = null,
  axonaManager = null,
  sink,
  env = process.env,
  maxRowsPerSec = DEFAULT_MAX_ROWS_PER_SEC,
  now = Date.now,
} = {}) {
  const state = { emitted: 0, dropped: 0, byLevel: { info: 0, warn: 0, error: 0 }, second: 0, inSecond: 0 };
  const undo = [];
  const stats = () => ({
    emitted: state.emitted,
    dropped: state.dropped,
    byLevel: { ...state.byLevel },
    maxRowsPerSec,
  });
  const uninstall = () => { while (undo.length) { try { undo.pop()(); } catch { /* going away */ } } };

  if (!kernelLogOn(env)) {
    return { installed: false, reason: 'BRIDGE_KERNEL_LOG is not on', intakes: [], stats, uninstall };
  }
  if (typeof sink !== 'function') {
    throw new TypeError('installKernelLog: sink must be a function (level, event, fields) => void');
  }

  // One row. Bounded by a per-second budget; overflow is counted and announced
  // once per second rather than dropped in silence.
  const emit = (level, msg, ctx) => {
    if (!KERNEL_LOG_LEVELS.includes(level)) return;
    const sec = Math.floor(now() / 1000);
    if (sec !== state.second) {
      const missed = state.inSecond > maxRowsPerSec ? state.inSecond - maxRowsPerSec : 0;
      state.second = sec;
      state.inSecond = 0;
      if (missed > 0) {
        try { sink('warn', 'kernel-log-throttled', { dropped: missed, maxRowsPerSec, droppedTotal: state.dropped }); }
        catch { /* the sink is the last thing that may take us down */ }
      }
    }
    state.inSecond++;
    if (state.inSecond > maxRowsPerSec) { state.dropped++; return; }
    state.emitted++;
    state.byLevel[level]++;
    let fields;
    try { fields = boundedContext(ctx); } catch { fields = { unserializable: true }; }
    try { sink(level, `kernel:${msg}`, fields); } catch { /* never throw into the kernel */ }
  };

  const intakes = [];

  // Intake 1 — the manager's log sink. This is the one that carries the rows
  // the probe is for: role-refused, undeliverable, and every LAT_TRACE stage.
  if (axonaManager && typeof axonaManager.setLogSink === 'function') {
    axonaManager.setLogSink((level, msg, ctx) => emit(level, msg, ctx));
    undo.push(() => { try { axonaManager.setLogSink(null); } catch { /* */ } });
    intakes.push('manager-sink');
  }

  // Intake 2 — the peer's typed surface. Catches the same rows if the kernel
  // later repoints the manager sink at the peer, plus anything else the kernel
  // routes through `_emitLog`.
  if (peer && typeof peer.onLog === 'function') {
    for (const level of KERNEL_LOG_LEVELS) {
      try {
        const off = peer.onLog(level, (msg, ctx) => emit(level, msg, ctx));
        if (typeof off === 'function') undo.push(off);
      } catch { /* a peer build without this level is not fatal */ }
    }
    intakes.push('peer-onlog');
  }

  // Background kernel errors, which are not log rows at all.
  if (peer && typeof peer.onError === 'function') {
    try {
      const off = peer.onError((err) => emit('error', err?.code || 'kernel-error', { message: err?.message ?? null }));
      if (typeof off === 'function') undo.push(off);
      intakes.push('peer-onerror');
    } catch { /* optional */ }
  }

  return {
    installed: intakes.length > 0,
    reason: intakes.length > 0 ? null : 'no peer or manager exposed a log surface',
    intakes,
    stats,
    uninstall,
  };
}
