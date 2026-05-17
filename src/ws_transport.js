// =====================================================================
// ws_transport.js — server-side Transport implementation for the bridge
//                   that carries Axona wire frames over the existing
//                   bridge ↔ browser WebSocket connections.
//
// The integration plan's "Phase 3" originally specified a node-webrtc
// transport — real WebRTC channels from the bridge to every browser.
// This WebSocket-backed variant is functionally equivalent for the
// bridge's role (be a routable peer in the Axona network) while
// avoiding the native-binding complications of node-webrtc.
//
// How it works:
//   - The bridge already maintains a WebSocket per connected browser.
//   - We piggyback Axona wire frames as a new message type:
//         { type: 'axona', payload: { k: 'req'|'res'|'ntf', ... } }
//   - The browser side has a matching WebSocketTransport that does
//     the same (axona-peer/src/bridge_transport.js, future).
//
// nodeId ↔ meshId binding works the same way the browser's
// WebRTCTransport does: an external orchestrator (server.js) calls
// bindPeer(nodeId, connId) after the hello / hello-ack handshake.
// =====================================================================

import { Transport } from '@axona/protocol';

const REQUEST_TIMEOUT_MS = 5000;
const MAX_REQ_ID = 0x7fffffff;

export class WebSocketTransport extends Transport {
  /**
   * @param {Object} opts
   * @param {bigint} opts.localNodeId
   * @param {(connId: string, msg: object) => boolean} opts.sendToConn
   *        Synchronous send hook.  Returns true if the WebSocket
   *        accepted the frame.  Wraps the WebSocketServer's per-
   *        connection state outside the transport.
   * @param {(connId: string) => boolean} opts.isConnOpen
   * @param {(event:string, data?:object) => void} [opts.log]
   */
  constructor({ localNodeId, sendToConn, isConnOpen, log }) {
    super();
    if (typeof localNodeId !== 'bigint') {
      throw new TypeError('WebSocketTransport: localNodeId must be bigint');
    }
    if (typeof sendToConn !== 'function' || typeof isConnOpen !== 'function') {
      throw new TypeError('WebSocketTransport: sendToConn + isConnOpen required');
    }

    this._localNodeId = localNodeId;
    this._sendToConn  = sendToConn;
    this._isConnOpen  = isConnOpen;
    this._log         = log ?? (() => {});

    this._reqHandlers = new Map();
    this._ntfHandlers = new Map();
    this._pending     = new Map();
    this._nextId      = 1;
    this._peerDiedHandlers = [];

    // nodeId ↔ connId binding (same shape as WebRTCTransport).
    /** @type {Map<bigint, string>} */ this._connIdByNodeId = new Map();
    /** @type {Map<string, bigint>} */ this._nodeIdByConnId = new Map();

    this._started = false;
  }

  async start(localNodeId) {
    if (localNodeId !== undefined) this._localNodeId = localNodeId;
    this._started = true;
  }

  async stop() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('transport-stopped'));
    }
    this._pending.clear();
    this._started = false;
  }

  getLocalNodeId() { return this._localNodeId; }

  // ── nodeId ↔ connId binding (matches WebRTCTransport surface) ─────

  bindPeer(nodeId, connId) {
    if (typeof nodeId !== 'bigint') throw new TypeError('nodeId must be bigint');
    if (typeof connId !== 'string') throw new TypeError('connId must be string');
    this._connIdByNodeId.set(nodeId, connId);
    this._nodeIdByConnId.set(connId, nodeId);
  }

  unbindPeer(connId) {
    const nodeId = this._nodeIdByConnId.get(connId);
    if (nodeId !== undefined) this._connIdByNodeId.delete(nodeId);
    this._nodeIdByConnId.delete(connId);
  }

  connIdFor(nodeId) { return this._connIdByNodeId.get(nodeId) ?? null; }
  nodeIdFor(connId) { return this._nodeIdByConnId.get(connId) ?? null; }

  // ── Channel pool ─────────────────────────────────────────────────

  async openConnection(nodeId) {
    const connId = this._connIdByNodeId.get(nodeId);
    return connId != null && this._isConnOpen(connId);
  }

  async closeConnection(nodeId) {
    const connId = this._connIdByNodeId.get(nodeId);
    if (connId) this.unbindPeer(connId);
  }

  isConnected(nodeId) {
    const connId = this._connIdByNodeId.get(nodeId);
    return connId != null && this._isConnOpen(connId);
  }

  // ── Messaging ────────────────────────────────────────────────────

  async send(nodeId, type, body) {
    if (!this._started) throw new Error('WebSocketTransport.send: not started');
    const connId = this._connIdByNodeId.get(nodeId);
    if (!connId || !this._isConnOpen(connId)) {
      throw new Error(`WebSocketTransport.send: peer ${nodeId} not connected`);
    }
    const id = this._nextId;
    this._nextId = (this._nextId >= MAX_REQ_ID) ? 1 : this._nextId + 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { nodeId, resolve, reject, timer });

      try {
        this._sendToConn(connId, { type: 'axona', payload: { k: 'req', id, type, body } });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async notify(nodeId, type, body) {
    if (!this._started) throw new Error('WebSocketTransport.notify: not started');
    const connId = this._connIdByNodeId.get(nodeId);
    if (!connId || !this._isConnOpen(connId)) return;
    try {
      this._sendToConn(connId, { type: 'axona', payload: { k: 'ntf', type, body } });
    } catch (err) {
      this._log('notify-failed', { nodeId: nodeId.toString(16), type, err: err.message });
    }
  }

  onRequest(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('onRequest: handler must be a function');
    this._reqHandlers.set(type, handler);
  }

  onNotification(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('onNotification: handler must be a function');
    this._ntfHandlers.set(type, handler);
  }

  // ── Liveness & latency ───────────────────────────────────────────

  onPeerDied(handler) {
    if (typeof handler !== 'function') throw new TypeError('onPeerDied: handler must be a function');
    this._peerDiedHandlers.push(handler);
    return () => {
      const i = this._peerDiedHandlers.indexOf(handler);
      if (i >= 0) this._peerDiedHandlers.splice(i, 1);
    };
  }

  /** RTT in ms.  The bridge gets ping/pong RTT samples in server.js
   *  alongside the application-level Phase 2 ping; for now we surface
   *  a sentinel.  Future: thread through the actual sampled RTT. */
  getLatency(_nodeId) { return 50; }

  // ── Inbound dispatch ─────────────────────────────────────────────

  /**
   * Called from server.js when an `{type:'axona', payload:...}`
   * message arrives on a WebSocket.  `connId` is the per-WebSocket
   * id the bridge assigned in `welcome`.
   */
  handleIncoming(connId, payload) {
    if (!payload || typeof payload !== 'object') return;
    const fromNodeId = this._nodeIdByConnId.get(connId) ?? null;

    if (payload.k === 'req') {
      this._handleRequest(connId, fromNodeId, payload);
    } else if (payload.k === 'res') {
      this._handleResponse(payload);
    } else if (payload.k === 'ntf') {
      this._handleNotification(connId, fromNodeId, payload);
    }
  }

  async _handleRequest(connId, fromNodeId, msg) {
    const handler = this._reqHandlers.get(msg.type);
    if (!handler) {
      this._reply(connId, msg.id, false, { error: `no handler for '${msg.type}'` });
      return;
    }
    try {
      const result = await handler(fromNodeId, msg.body);
      this._reply(connId, msg.id, true, result);
    } catch (err) {
      this._reply(connId, msg.id, false, { error: err.message ?? String(err) });
    }
  }

  _reply(connId, id, ok, body) {
    try {
      this._sendToConn(connId, { type: 'axona', payload: { k: 'res', id, ok, body } });
    } catch (err) {
      this._log('reply-failed', { connId, id, err: err.message });
    }
  }

  _handleResponse(msg) {
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.body);
    else {
      const errMsg = (msg.body && typeof msg.body === 'object')
        ? (msg.body.error ?? 'remote-error') : 'remote-error';
      pending.reject(new Error(errMsg));
    }
  }

  _handleNotification(connId, fromNodeId, msg) {
    const handler = this._ntfHandlers.get(msg.type);
    if (!handler) return;
    try {
      handler(fromNodeId ?? connId, msg.body);
    } catch (err) {
      this._log('ntf-handler-threw', { type: msg.type, err: err.message });
    }
  }

  /**
   * Server.js calls this when a WebSocket closes; if the conn was
   * bound to a nodeId, fire onPeerDied and unbind.
   */
  handleConnClosed(connId) {
    const nodeId = this._nodeIdByConnId.get(connId);
    const reported = nodeId ?? connId;
    for (const h of this._peerDiedHandlers) {
      try { h(reported); }
      catch (err) { this._log('peer-died-handler-threw', { err: err.message }); }
    }
    for (const [id, p] of this._pending.entries()) {
      if (p.nodeId !== nodeId) continue;
      clearTimeout(p.timer);
      this._pending.delete(id);
      p.reject(new Error('peer-died'));
    }
    this.unbindPeer(connId);
  }
}
