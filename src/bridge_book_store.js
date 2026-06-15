// =====================================================================
// bridge_book_store.js — the bridge's on-disk record of OTHER bridges it
// has discovered via the directory. The server-side analogue of
// axona-peer/src/bridgeBook.js.
//
// Why a bridge keeps this: like any node, a bridge bootstraps into the
// network through the known-bridge list. It persists the bridges it learns
// from the directory so that on a later launch it can bootstrap from that
// saved list (ranked by proximity/tenure) instead of relying solely on a
// hardcoded seed. Reuses the kernel's validate + rank helpers.
// =====================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateBridgeEntry, rankBridges, BRIDGE_ENTRY_MAX_AGE_MS } from '@axona/protocol';

export class BridgeBookStore {
  /**
   * @param {object} o
   * @param {string} o.path     JSON file path (StateDirectory)
   * @param {string} o.selfUrl  this bridge's own url (excluded from candidates)
   * @param {{lat:number,lng:number}} o.self  this bridge's location (proximity rank)
   * @param {(event:string, detail?:object)=>void} [o.log]
   */
  constructor({ path, selfUrl, self, log = () => {} }) {
    this._path = path;
    this._selfUrl = selfUrl || null;
    this._self = self || null;
    this._log = log;
    this._entries = {};   // url -> { url,lat,lng,label,ver,ts,signerKey,firstSeen }
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(readFileSync(this._path, 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries) this._entries = raw.entries;
      this._log('book-loaded', { count: this.count });
    } catch { /* no file yet — first launch */ }
  }

  _save() {
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify({ entries: this._entries }, null, 2));
    } catch (err) { this._log('book-save-failed', { err: err?.message }); }
  }

  /** Merge one received directory entry. Returns true if it changed the book. */
  merge(entry, signerKey, now = Date.now()) {
    const v = validateBridgeEntry(entry);
    if (!v) return false;
    const prev = this._entries[v.url];
    if (prev && (prev.ts || 0) >= v.ts) return false;       // keep latest per url
    this._entries[v.url] = {
      ...v,
      signerKey: signerKey || prev?.signerKey || null,
      firstSeen: prev?.firstSeen || now,                    // tenure
    };
    for (const url of Object.keys(this._entries)) {         // drop dead bridges
      if (now - (this._entries[url].ts || 0) > BRIDGE_ENTRY_MAX_AGE_MS) delete this._entries[url];
    }
    this._save();
    return true;
  }

  /**
   * Ranked upstream-bridge candidate URLs for bootstrap (best first),
   * excluding self. `extraRoots` (env seeds / built-in defaults) lead.
   */
  candidates(extraRoots = [], now = Date.now()) {
    const entries = Object.values(this._entries);
    const reputation = {};
    for (const e of entries) reputation[e.url] = { firstSeen: e.firstSeen };
    const ranked = rankBridges({ roots: extraRoots, entries, reputation, self: this._self, now })
      .map((c) => c.url);
    // de-dupe + drop self
    const seen = new Set();
    return ranked.filter((u) => u && u !== this._selfUrl && !seen.has(u) && seen.add(u));
  }

  get count() { return Object.keys(this._entries).length; }
}
