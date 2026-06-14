// =====================================================================
// bridge_directory.js — publish this bridge's location to the public
// bridge-directory topic so clients can discover it and fail over to it.
//
// A bridge publishes a SIGNED entry { url, lat, lng, label, ver, ts } on
// launch and once a day. Clients collect these, rank by first-party
// reputation + proximity, and fall over to a saved alternate if their
// configured primary is unreachable (see @axona/protocol/bridgeDirectory
// and axona-peer/src/bridgeBook.js).
//
// OPT-OUT: the testnet bridge sets BRIDGE_DIRECTORY=off — it runs an
// independent fleet (potentially a different protocol) and must not
// advertise itself into the public directory the production apps consume.
// =====================================================================

import { BRIDGE_DIRECTORY_TOPIC, buildBridgeEntry } from '@axona/protocol';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start publishing this bridge to the directory.
 *
 * @param {object}  o
 * @param {object}  o.peer       the bridge's embedded AxonaPeer (peer.pub)
 * @param {object}  o.identity   bridge identity ({ region:{lat,lng,label} })
 * @param {string}  o.version    bridge version string
 * @param {object}  [o.env=process.env]
 * @param {(event:string, detail?:object)=>void} [o.log]
 * @returns {{ enabled:boolean, url:string|null, stop:()=>void }}
 */
export function startDirectoryPublisher({ peer, identity, version = '', env = process.env, log = () => {} }) {
  const off = String(env.BRIDGE_DIRECTORY ?? 'on').toLowerCase() === 'off';
  if (off) {
    log('disabled', { reason: 'BRIDGE_DIRECTORY=off' });
    return { enabled: false, url: null, stop() {} };
  }

  const url = env.BRIDGE_PUBLIC_URL;
  if (typeof url !== 'string' || !/^wss:\/\/[^\s]+$/.test(url)) {
    log('skip', { reason: 'BRIDGE_PUBLIC_URL missing or not wss://' });
    return { enabled: false, url: null, stop() {} };
  }

  const region = identity?.region ?? {};
  const makeEntry = () => buildBridgeEntry({
    url,
    lat:   region.lat,
    lng:   region.lng,
    label: region.label ?? '',
    ver:   version,
  });

  async function publish(reason) {
    try {
      // Public topic (publisher: null) → globally discoverable; the
      // bridge signs it, so its signerPubkey is its stable directory id.
      await peer.pub(BRIDGE_DIRECTORY_TOPIC, makeEntry(), { publisher: null });
      log('published', { url, reason });
    } catch (err) {
      log('publish-failed', { reason, err: err?.message });
    }
  }

  // Publish once on launch, then keep the entry fresh once a day.
  publish('launch');
  const timer = setInterval(() => publish('daily'), DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();   // don't keep the process alive

  return { enabled: true, url, stop() { clearInterval(timer); } };
}
