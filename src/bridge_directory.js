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

import { BRIDGE_DIRECTORY_TOPIC, buildBridgeEntry, createAuthorIdentity } from '@axona/protocol';

const DAY_MS = 24 * 60 * 60 * 1000;

// v0.3: the directory is a well-known OPEN topic. The pre-v0.3 scheme was a
// public (publisher: null → 0x00 global) topic keyed solely on the topic NAME
// 'axona:bridge-directory'. v0.3 removes the global region: an open topic must
// name a real, populated region, and every bridge + client must derive the SAME
// (region, name) so they meet on one topic id. We pin the directory to the
// 'useast' region (the design doc's "deliberate, app-visible hot spot" pattern
// for a topic the whole network must share) and reuse the kernel's topic-name
// constant verbatim, so the directory keeps a single canonical placement.
const DIRECTORY_TOPIC = { region: 'useast', name: BRIDGE_DIRECTORY_TOPIC };

/**
 * Start publishing this bridge to the directory.
 *
 * @param {object}  o
 * @param {object}  o.peer       the bridge's embedded AxonaPeer (peer.pub)
 * @param {object}  o.identity   bridge identity ({ region:{lat,lng,label} })
 * @param {string}  o.version    bridge version string
 * @param {object}  [o.env=process.env]
 * @param {import('./bridge_book_store.js').BridgeBookStore|null} [o.book]
 *        persist discovered bridges (the bridge learns the list like any node)
 * @param {(event:string, detail?:object)=>void} [o.log]
 * @returns {{ enabled:boolean, url:string|null, stop:()=>void }}
 */
export function startDirectoryPublisher({ peer, identity, version = '', env = process.env, book = null, log = () => {} }) {
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
    turn:  env.TURN_URLS,          // advertise this bridge's TURN endpoint(s), if any
  });

  // v0.3 separates the node/connection key from the AUTHORSHIP key: a publish
  // must be signed with an Author identity (peer.pub({signWith})). The directory
  // dedups + ranks on the entry URL, not the signer (the bridge transport id is
  // ephemeral and the signer rotates every restart), so an ephemeral author is
  // fine here — it proves the entry wasn't tampered in transit, nothing more.
  // Minted lazily so a disabled/misconfigured bridge does no keygen.
  let author = null;

  async function publish(reason) {
    try {
      if (!author) author = await createAuthorIdentity();
      // Open topic (write:'open') in a fixed region → globally discoverable; the
      // bridge signs it, so its signerPubkey is its (rotating) directory id.
      await peer.pub(DIRECTORY_TOPIC, makeEntry(), { signWith: author });
      log('published', { url, reason });
    } catch (err) {
      log('publish-failed', { reason, err: err?.message });
    }
  }

  // HOST the directory topic first, so the bridge is a durable root for it
  // and stores+serves its own entry — even the launch publish (which lands
  // before peers reconnect) is then retrievable by any later subscriber that
  // routes to the bridge (it's in every peer's synaptome). Without this the
  // launch publish would route into an empty mesh and be lost as the real
  // region-closest roots fill in. Best-effort.
  let sub = null;
  (async () => {
    try { await peer.host(DIRECTORY_TOPIC); log('hosting', {}); }
    catch (err) { log('host-failed', { err: err?.message }); }
    await publish('launch');
    // Self-identify: declare this signer's author-class as 'bridge' (kernel
    // attestation on the signer's own owner-only profile topic). A client that
    // resolves the directory entry's signerPubkey via getAuthorClass then sees
    // it's a bridge, not a person/agent. The signer is ephemeral (rotates per
    // restart), so we re-declare each launch. Best-effort + tolerant of an
    // older kernel that doesn't know the 'bridge' class (→ caught here).
    if (author) {
      try { await peer.setAuthorClass('bridge', { signWith: author, label: url }); log('class-declared', { class: 'bridge' }); }
      catch (err) { log('class-failed', { err: err?.message }); }
    }
    // Subscribe to the directory and persist what we learn — a bridge keeps the
    // list like any node, so it can bootstrap from saved bridges next launch.
    if (book) {
      try {
        sub = await peer.sub(DIRECTORY_TOPIC, (envp) => {
          if (!envp || envp.deleted || !envp.signerPubkey) return;
          if (envp.message?.url === url) return;          // skip our own entry
          if (book.merge(envp.message, envp.signerPubkey)) {
            log('learned', { url: envp.message?.url, known: book.count });
          }
        }, { since: 'all' });
      } catch (err) { log('subscribe-failed', { err: err?.message }); }
    }
  })();
  const timer = setInterval(() => publish('daily'), DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();   // don't keep the process alive

  return {
    enabled: true,
    url,
    // Re-emit the entry — called once the bootstrap uplink integrates, so the
    // entry lands on the SHARED mesh (the launch publish lands on the local
    // mesh before the uplink is up).
    republish: (reason = 'manual') => publish(reason),
    stop() { clearInterval(timer); try { sub?.stop?.(); } catch { /* dying */ } },
  };
}
