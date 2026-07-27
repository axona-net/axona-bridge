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

import { BRIDGE_DIRECTORY_TOPIC, buildBridgeEntry, createAuthorIdentity, regionNameForLatLng } from '@axona/protocol';

const HOUR_MS = 60 * 60 * 1000;   // heartbeat cadence — see the timer below

// v0.3: the directory is a well-known OPEN topic. The pre-v0.3 scheme was a
// public (publisher: null → 0x00 global) topic keyed solely on the topic NAME
// 'axona:bridge-directory'. v0.3 removes the global region: an open topic must
// name a real, populated region, and every bridge + client must derive the SAME
// (region, name) so they meet on one topic id. We pin the directory to the
// 'eagle' region (the design doc's "deliberate, app-visible hot spot" pattern
// for a topic the whole network must share) and reuse the kernel's topic-name
// constant verbatim, so the directory keeps a single canonical placement.
// The directory is an ORDINARY open topic — nothing hosts it specially, it roots
// wherever its address lands, exactly like every other topic (INVARIANT: hosting
// is decided by ADDRESS, never by who cares about the data).
//
// It is published into EVERY region that already has a bridge, not one global
// region, so no single region's coverage is a dependency for global discovery.
// The set is self-expanding and needs no seed list: we know our own region, and
// we learn the others from the directory entries we have already seen (each
// carries the publishing bridge's lat/lng). A new region joins the set the
// moment a bridge lands there.
const topicIn = (region) => ({ region, name: BRIDGE_DIRECTORY_TOPIC });

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
export function startDirectoryPublisher({ peer, identity, version = '', env = process.env, book = null, authorStore = null, log = () => {} }) {
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
  // The bridge's AUTHOR key is DURABLE (I-ID: durable WHO, ephemeral WHERE), so a
  // client can verify "this is the same bridge that announced an hour ago"
  // instead of trusting the URL alone. It is the ONLY key a bridge persists —
  // its transport identity is still minted fresh every start and written nowhere.
  // Minted lazily so a disabled/misconfigured bridge does no keygen.
  let stopped = false;
  let author = null;
  async function ensureAuthor() {
    if (author) return author;
    author = authorStore
      ? await createAuthorIdentity({ persistAs: 'bridge', store: authorStore })
      : await createAuthorIdentity();
    return author;
  }

  /**
   * Every region that currently has a bridge: our own, plus the region of each
   * bridge we already know about. Bounded by the number of populated regions,
   * and it converges as the book fills.
   */
  function bridgeRegions() {
    const set = new Set();
    const own = regionNameForLatLng(region.lat, region.lng);
    if (own) set.add(own);
    for (const e of (book?.entries?.() ?? [])) {
      const r = regionNameForLatLng(e?.lat, e?.lng);
      if (r) set.add(r);
    }
    return [...set];
  }

  // ── ESTABLISHMENT GATE (2026-07-27) ───────────────────────────────────
  // A bridge must NOT advertise itself the instant it boots. At launch its
  // synaptome is empty, so it is the only candidate for its own directory
  // topic — it is TERMINAL for that address. Under the bridge fence it then
  // refuses to root the topic it is trying to publish, and the declined PUB
  // re-routes to the only node there is: itself. That is an unbounded
  // synchronous loop; it took the east prod bridge down for ~50 min on
  // 2026-07-27 (see ops/STATE.md INCIDENT).
  //
  // A bridge has no business announcing "connect to me" before it can carry
  // traffic anyway, so the fix is also the honest behaviour: wait until the
  // bridge is ESTABLISHED — some minutes of uptime AND a real synaptome —
  // then publish, and let the existing hourly beat keep it fresh. A launch
  // publish is worth nothing: nobody is listening to a mesh this bridge has
  // not joined yet.
  const MIN_UPTIME_MS = Number(env.BRIDGE_DIRECTORY_MIN_UPTIME_MS ?? 5 * 60_000);
  const MIN_PEERS     = Number(env.BRIDGE_DIRECTORY_MIN_PEERS     ?? 3);
  const POLL_MS       = Number(env.BRIDGE_DIRECTORY_POLL_MS       ?? 15_000);
  const bootAt = Date.now();

  /** Established = enough uptime AND a healthy synaptome. */
  function establishment() {
    const upMs  = Date.now() - bootAt;
    const peers = (() => { try { return peer.peers()?.length ?? 0; } catch { return 0; } })();
    return { ok: upMs >= MIN_UPTIME_MS && peers >= MIN_PEERS, upMs, peers };
  }

  /** Resolve once the bridge is established (or when stopped). */
  function whenEstablished() {
    return new Promise((resolve) => {
      const tick = () => {
        if (stopped) return resolve(false);
        const e = establishment();
        if (e.ok) { log('established', { upMs: e.upMs, peers: e.peers, minUptimeMs: MIN_UPTIME_MS, minPeers: MIN_PEERS }); return resolve(true); }
        log('awaiting-establishment', { upMs: e.upMs, peers: e.peers, needUptimeMs: MIN_UPTIME_MS, needPeers: MIN_PEERS });
        const t = setTimeout(tick, POLL_MS);
        if (typeof t.unref === 'function') t.unref();
      };
      tick();
    });
  }

  async function publish(reason) {
    // Never publish while unestablished, whatever the caller. The heartbeat and
    // the post-uplink re-emit both come through here, and a mesh that has just
    // emptied puts us right back to being terminal for our own topic.
    const est = establishment();
    if (!est.ok) { log('publish-deferred', { reason, upMs: est.upMs, peers: est.peers }); return; }
    const regions = bridgeRegions();
    if (!regions.length) { log('publish-skipped', { reason, why: 'no known bridge region' }); return; }
    const entry = makeEntry();
    for (const r of regions) {
      try {
        // Ordinary open publish. Nothing is hosted; the topic roots wherever its
        // address lands in that region, like any other topic.
        await peer.pub(topicIn(r), entry, { signWith: author });
        log('published', { url, reason, region: r });
      } catch (err) {
        log('publish-failed', { reason, region: r, err: err?.message });
      }
    }
  }

  // REMOVED 2026-07-25 — the bridge used to host() this topic so it was a durable
  // root for its own entry, because the launch publish lands before peers
  // reconnect and would otherwise be lost into an empty mesh. The hourly beat
  // below solves that properly: a lost publish is harmless when the next one is
  // an hour away, so the topic no longer needs an exception to the address rule.
  let sub = null;
  (async () => {
    await ensureAuthor();
    // Was: an immediate publish('launch'). See the ESTABLISHMENT GATE above.
    if (!(await whenEstablished())) return;   // stopped before we ever qualified
    await publish('established');
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
        // Subscribe in every bridge region too, so we learn from all of them.
        const subs = [];
        for (const r of bridgeRegions()) subs.push(await peer.sub(topicIn(r), (envp) => {
          if (!envp || envp.deleted || !envp.signerPubkey) return;
          if (envp.message?.url === url) return;          // skip our own entry
          if (book.merge(envp.message, envp.signerPubkey)) {
            log('learned', { url: envp.message?.url, known: book.count });
          }
        }, { since: 'all' }));
        sub = { stop() { for (const x of subs) { try { x?.stop?.(); } catch { /* dying */ } } } };
      } catch (err) { log('subscribe-failed', { err: err?.message }); }
    }
  })();
  // HOURLY heartbeat. Two jobs at once: it repopulates an entry that missed the
  // mesh, and it makes freshness the liveness signal — an entry older than an
  // hour or two means that bridge has almost certainly gone, with no tombstone
  // or departure protocol needed. Entries age out on the ordinary 24h ceiling,
  // so nothing needs pruning.
  const timer = setInterval(() => publish('heartbeat'), HOUR_MS);
  if (typeof timer.unref === 'function') timer.unref();   // don't keep the process alive

  return {
    enabled: true,
    url,
    // Re-emit the entry — called once the bootstrap uplink integrates, so the
    // entry lands on the SHARED mesh (the launch publish lands on the local
    // mesh before the uplink is up).
    republish: (reason = 'manual') => publish(reason),
    stop() { stopped = true; clearInterval(timer); try { sub?.stop?.(); } catch { /* dying */ } },
  };
}
