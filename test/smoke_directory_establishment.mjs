// =====================================================================
// smoke_directory_establishment.mjs
//
// REGRESSION FENCE for the 2026-07-27 east-bridge outage (~50 min down).
//
// The bug: a bridge published its directory entry at LAUNCH. At that moment its
// synaptome is empty, so the bridge is the only candidate for its own directory
// topic — TERMINAL for that address. Under the bridge fence (neverRoot, 4.46.0)
// it then refuses to root the very topic it is publishing; become() returns
// null; the declined PUB re-routes; the only node to route to is itself; and
// _onPub → _becomeRoot → admitRole → refuse → reroute spins SYNCHRONOUSLY and
// forever. The process still logs "listen" and then serves nothing at all.
//
// Two conditions were BOTH required, which is why nothing caught it:
//   - directory ON  (testnet publishes nothing → green there, always)
//   - fence ON      (2.97.0 had no fence → green there, always)
//
// What this test pins:
//   1. A bridge with directory ON + fence ON does NOT publish at launch.
//   2. It publishes only once established (uptime AND peers).
//   3. publish() refuses whatever the caller, so the hourly heartbeat and the
//      post-uplink re-emit can't reintroduce the launch-time condition.
//
// Deliberately NOT a live-network test: it drives startDirectoryPublisher with
// a fake peer, so it runs offline and can never touch the real directory. The
// standing rule is BRIDGE_DIRECTORY=off everywhere but production, and a test
// that needed a real bridge to prove this would be a test nobody dares run.
// =====================================================================

import { startDirectoryPublisher } from '../src/bridge_directory.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake peer: records publishes, reports a settable peer count. */
function fakePeer(peerCount = 0) {
  const pubs = [];
  return {
    pubs,
    _n: peerCount,
    peers() { return Array.from({ length: this._n }, (_, i) => `peer${i}`); },
    async pub(topic, entry) { pubs.push({ topic, entry }); },
    async sub() { return { stop() {} }; },
    async setAuthorClass() {},
  };
}

const baseEnv = {
  BRIDGE_DIRECTORY: 'on',
  BRIDGE_PUBLIC_URL: 'wss://fence-test.example',
  BRIDGE_DIRECTORY_POLL_MS: '40',          // keep the test quick
};
const identity = { region: { lat: 40.7, lng: -74.0, label: 'eagle' } };

console.log('\n[1] a fresh bridge does NOT publish at launch (the outage condition)');
{
  const peer = fakePeer(0);   // empty synaptome, 0s uptime — exactly boot
  const events = [];
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY_MIN_UPTIME_MS: '60000', BRIDGE_DIRECTORY_MIN_PEERS: '3' },
    log: (e, d) => events.push([e, d]),
  });
  await sleep(150);
  ok(pub.enabled === true, 'publisher is enabled (directory ON)');
  ok(peer.pubs.length === 0, 'NO publish at launch — this is the fix');
  ok(events.some(([e]) => e === 'awaiting-establishment'), 'logs why it is waiting');
  pub.stop();
}

console.log('\n[2] it publishes once established (uptime AND peers)');
{
  const peer = fakePeer(0);
  const events = [];
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY_MIN_UPTIME_MS: '0', BRIDGE_DIRECTORY_MIN_PEERS: '3' },
    log: (e, d) => events.push([e, d]),
  });
  await sleep(120);
  ok(peer.pubs.length === 0, 'still silent while the synaptome is empty');
  peer._n = 3;                                   // mesh arrives
  await sleep(200);
  ok(peer.pubs.length > 0, 'publishes once peers >= threshold');
  ok(events.some(([e]) => e === 'established'), 'logs establishment');
  pub.stop();
}

console.log('\n[3] uptime alone is not enough — peers are also required');
{
  const peer = fakePeer(0);
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY_MIN_UPTIME_MS: '0', BRIDGE_DIRECTORY_MIN_PEERS: '3' },
    log: () => {},
  });
  await sleep(200);
  ok(peer.pubs.length === 0, 'uptime satisfied but 0 peers ⇒ no publish');
  peer._n = 2;
  await sleep(150);
  ok(peer.pubs.length === 0, 'below threshold (2 < 3) ⇒ still no publish');
  pub.stop();
}

console.log('\n[4] peers alone is not enough — uptime is also required');
{
  const peer = fakePeer(10);
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY_MIN_UPTIME_MS: '60000', BRIDGE_DIRECTORY_MIN_PEERS: '3' },
    log: () => {},
  });
  await sleep(200);
  ok(peer.pubs.length === 0, 'healthy synaptome but too young ⇒ no publish');
  pub.stop();
}

console.log('\n[5] the gate holds for EVERY caller, not just launch');
{
  // republish() is the post-uplink re-emit; the hourly heartbeat takes the same
  // path. Both must refuse while unestablished, or a momentarily-empty mesh puts
  // the bridge back into the terminal-for-its-own-topic condition.
  const peer = fakePeer(0);
  const events = [];
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY_MIN_UPTIME_MS: '60000', BRIDGE_DIRECTORY_MIN_PEERS: '3' },
    log: (e, d) => events.push([e, d]),
  });
  await sleep(80);
  await pub.republish?.('post-uplink');
  await sleep(80);
  ok(peer.pubs.length === 0, 'republish() refuses while unestablished');
  ok(events.some(([e]) => e === 'publish-deferred'), 'and says so (publish-deferred)');
  pub.stop();
}

console.log('\n[6] BRIDGE_DIRECTORY=off still short-circuits everything');
{
  const peer = fakePeer(10);
  const pub = startDirectoryPublisher({
    peer, identity, version: 'test',
    env: { ...baseEnv, BRIDGE_DIRECTORY: 'off' },
    log: () => {},
  });
  await sleep(100);
  ok(pub.enabled === false, 'disabled when BRIDGE_DIRECTORY=off');
  ok(peer.pubs.length === 0, 'and publishes nothing');
  pub.stop();
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
