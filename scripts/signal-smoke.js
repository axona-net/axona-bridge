// =====================================================================
// Phase 2 signaling smoke test.
//
// Spawns two simulated peers and exercises the bridge's signaling
// behavior:
//
//   1. P1 connects → receives `welcome` + `peer-list: []`
//   2. P2 connects → receives `welcome` + `peer-list: [P1]`,
//                    P1 receives `peer-joined: P2`
//   3. P2 sends `signal {to: P1, payload: 'hello'}` → P1 receives
//                                                     `signal {from: P2, payload: 'hello'}`
//   4. P1 replies in kind
//   5. P2 disconnects → P1 receives `peer-left: P2`
//   6. P1 disconnects
//
// Exits 0 on success, non-zero on the first assertion failure.
//
// Usage:
//   node scripts/signal-smoke.js
//   BRIDGE=ws://localhost:8080 node scripts/signal-smoke.js
// =====================================================================

import { WebSocket } from 'ws';

const BRIDGE = process.env.BRIDGE ?? 'ws://localhost:8080';
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
    failures.push(label);
  }
}

function open(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE);
    const events = [];
    ws.on('open', () => resolve({ ws, events, label }));
    ws.on('error', reject);
    ws.on('message', (data) => {
      try { events.push(JSON.parse(data.toString())); }
      catch { events.push({ type: 'bad-json', raw: data.toString() }); }
    });
  });
}

function nextEvent(peer, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    // First, scan events that have already arrived.
    const existing = peer.events.find(predicate);
    if (existing) {
      peer.events.splice(peer.events.indexOf(existing), 1);
      return resolve(existing);
    }
    // Otherwise wait.
    const t0 = Date.now();
    const interval = setInterval(() => {
      const found = peer.events.find(predicate);
      if (found) {
        clearInterval(interval);
        peer.events.splice(peer.events.indexOf(found), 1);
        resolve(found);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timeout waiting for event on ${peer.label}`));
      }
    }, 10);
  });
}

async function main() {
  console.log(`bridge: ${BRIDGE}`);

  // ── Step 1: P1 connects, receives welcome + peer-list ────────────
  //   We don't assert peer-list is empty — other connections may be
  //   open (the user's browser tab, for example).  We just record
  //   what was there so we can verify P1 is added to it for P2.
  console.log('\n[1] P1 connects');
  const P1 = await open('P1');
  const p1Welcome  = await nextEvent(P1, m => m.type === 'welcome');
  check('P1 welcome arrived', p1Welcome.connId?.startsWith('c'));
  const p1Id = p1Welcome.connId;

  const p1List = await nextEvent(P1, m => m.type === 'peer-list');
  check('P1 peer-list arrived', Array.isArray(p1List.peers),
        `got: ${JSON.stringify(p1List.peers)}`);
  check('P1 peer-list does NOT contain self',
        !p1List.peers.includes(p1Id));
  const baselinePeers = p1List.peers;
  if (baselinePeers.length > 0) {
    console.log(`    (note: ${baselinePeers.length} other peer(s) already connected: ${baselinePeers.join(', ')})`);
  }

  // ── Step 2: P2 connects, sees P1 in peer-list; P1 hears peer-joined
  console.log('\n[2] P2 connects, both sides notice');
  const P2 = await open('P2');
  const p2Welcome = await nextEvent(P2, m => m.type === 'welcome');
  const p2Id = p2Welcome.connId;
  check('P2 has a distinct connId', p2Id && p2Id !== p1Id);

  const p2List = await nextEvent(P2, m => m.type === 'peer-list');
  check('P2 peer-list contains P1',
        Array.isArray(p2List.peers) && p2List.peers.includes(p1Id),
        `got: ${JSON.stringify(p2List.peers)}`);
  check('P2 peer-list does NOT contain self',
        !p2List.peers.includes(p2Id));
  check('P2 peer-list also contains all baseline peers',
        baselinePeers.every(p => p2List.peers.includes(p)),
        `baseline=${JSON.stringify(baselinePeers)} got=${JSON.stringify(p2List.peers)}`);

  const p1Joined = await nextEvent(P1, m => m.type === 'peer-joined' && m.peerId === p2Id);
  check('P1 received peer-joined for P2', p1Joined.peerId === p2Id,
        `got peerId=${p1Joined.peerId}`);

  // ── Step 3: P2 signals P1 ────────────────────────────────────────
  console.log('\n[3] P2 → P1 signal relay');
  P2.ws.send(JSON.stringify({
    type:    'signal',
    to:      p1Id,
    payload: { kind: 'sdp-offer', sdp: 'opaque-offer-blob' },
  }));
  const p1Signal = await nextEvent(P1, m => m.type === 'signal');
  check('P1 received signal from P2', p1Signal.from === p2Id);
  check('signal payload preserved',
        p1Signal.payload?.kind === 'sdp-offer' && p1Signal.payload?.sdp === 'opaque-offer-blob',
        `got: ${JSON.stringify(p1Signal.payload)}`);

  // ── Step 4: P1 replies ───────────────────────────────────────────
  console.log('\n[4] P1 → P2 signal relay');
  P1.ws.send(JSON.stringify({
    type:    'signal',
    to:      p2Id,
    payload: { kind: 'sdp-answer', sdp: 'opaque-answer-blob' },
  }));
  const p2Signal = await nextEvent(P2, m => m.type === 'signal');
  check('P2 received signal from P1', p2Signal.from === p1Id);
  check('reply payload preserved',
        p2Signal.payload?.kind === 'sdp-answer');

  // ── Step 5: signal to unknown peer is silently dropped ───────────
  console.log('\n[5] signal to unknown peer is a silent drop');
  P1.ws.send(JSON.stringify({
    type:    'signal',
    to:      'c-does-not-exist',
    payload: { kind: 'oops' },
  }));
  // Should not error; we just confirm P1 receives no follow-up.
  let stray = null;
  try { stray = await nextEvent(P1, m => m.type === 'signal', 200); }
  catch { /* timeout is the success path */ }
  check('no spurious signal echoed back', stray === null);

  // ── Step 6: P2 disconnects, P1 hears peer-left ───────────────────
  console.log('\n[6] P2 disconnects');
  P2.ws.close(1000, 'smoke complete');
  const p1Left = await nextEvent(P1, m => m.type === 'peer-left');
  check('P1 received peer-left for P2', p1Left.peerId === p2Id);

  // ── Step 7: P1 ping/pong still works (Phase 1 behavior) ──────────
  console.log('\n[7] Phase 1 ping/pong still works');
  P1.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  const pong = await nextEvent(P1, m => m.type === 'pong');
  check('P1 received pong', typeof pong.serverT === 'number' && typeof pong.t === 'number');

  // ── Cleanup ──────────────────────────────────────────────────────
  P1.ws.close(1000, 'smoke complete');
  await new Promise((r) => setTimeout(r, 100));

  console.log('\n──────────────────────────────');
  if (failures.length === 0) {
    console.log('✓ All checks passed.');
    process.exit(0);
  } else {
    console.log(`✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke harness error:', err);
  process.exit(2);
});
