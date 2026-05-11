// =====================================================================
// Phase 1 smoke client.  Connects to the bridge, sends N pings, prints
// the per-ping RTT, and exits.  Used in local end-to-end tests and as a
// reference implementation of the wire format.
//
// Usage:
//   node scripts/smoke-client.js               # 5 pings to ws://localhost:8080
//   BRIDGE=ws://localhost:8080 N=10 node scripts/smoke-client.js
// =====================================================================

import { WebSocket } from 'ws';

const BRIDGE = process.env.BRIDGE ?? 'ws://localhost:8080';
const N      = Number.parseInt(process.env.N ?? '5', 10);
const PERIOD = Number.parseInt(process.env.PERIOD_MS ?? '1000', 10);

const ws = new WebSocket(BRIDGE);
let sent = 0;
let received = 0;
const rtts = [];

ws.on('open', () => {
  console.log(`[open] connected to ${BRIDGE}`);
  const timer = setInterval(() => {
    if (sent >= N) {
      clearInterval(timer);
      // Allow time for the last pong to arrive.
      setTimeout(() => ws.close(1000, 'smoke complete'), Math.min(PERIOD, 200));
      return;
    }
    ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    sent++;
  }, PERIOD);
  // Send the first ping immediately so we don't wait a full PERIOD.
  ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  sent++;
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'welcome') {
    console.log(`[welcome] connId=${msg.connId}`);
    return;
  }
  if (msg.type === 'pong') {
    const rtt = Date.now() - msg.t;
    rtts.push(rtt);
    received++;
    console.log(`[pong] ${received}/${N}  rtt=${rtt}ms`);
  }
});

ws.on('close', (code, reason) => {
  console.log(`[close] code=${code} reason=${reason.toString()}`);
  if (rtts.length > 0) {
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    const max = Math.max(...rtts);
    console.log(`[summary] sent=${sent} received=${received}  avg=${avg.toFixed(2)}ms  max=${max}ms`);
  }
  process.exit(received === sent ? 0 : 1);
});

ws.on('error', (err) => {
  console.error(`[error] ${err.message}`);
  process.exit(2);
});
