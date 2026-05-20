// =====================================================================
// identity.js — bridge's hybrid (legacy 64-bit + kernel 264-bit) identity.
//
// I4: migrated to the kernel's deriveIdentity / dumpIdentity /
// loadIdentity so the bridge is a kernel-conformant peer in the
// v1.0 wire protocol — signed envelopes work, peer.pub topics
// derive correctly under both publisher-keyed and public modes.
//
// Returned shape (matches axona-peer/src/identity.js after #46):
//
//   Legacy (preserved for ws_transport / bridge_axona_node — they
//   carry BigInt nodeIds in the hello/hello-ack envelopes that
//   peer browsers still parse via hexToId)
//     id        — BigInt 64-bit, top 64 bits of kernel hex id.
//                 Same S2 prefix at the top (preserves geographic
//                 routing locality); bottom 56 bits deterministic
//                 from sha256(pubkey).
//     geoBits   — 8
//     region    — { lat, lng, label, id: 'bridge' }
//     createdAt — ms
//
//   Kernel (new)
//     idHex      — 66-char hex (kernel's full 264-bit nodeId)
//     pubkey     — Uint8Array (Ed25519)
//     privateKey — Web Crypto Ed25519 CryptoKey
//     pubkeyHex  — 64-char hex
//
// Persistence: bridge-identity.json on disk now stores the kernel
// envelope (id, pubkey, privkey:base64-pkcs8, region, createdAt)
// produced by kernel.dumpIdentity.  The bridge identity IS stable
// across restarts — kernel.loadIdentity verifies the stored id is
// internally consistent with the pubkey + region on each load.
//
// Old v0.x bridge-identity.json files (which only had a 64-bit
// hex `id`, no pubkey/privkey) are NOT readable — the bridge logs
// a warning and generates a fresh kernel identity, which has a
// DIFFERENT nodeId than the old persistence.  Acceptable in the
// testing era (the v1.0 cutover is a flag-day; deployed bridges
// rotate identity at the same time peers do).
// =====================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  deriveIdentity as kernelDeriveIdentity,
  dumpIdentity,
  loadIdentity,
} from '@axona/protocol';

const GEO_BITS = 8;

const DEFAULT_LAT = 38.0;     // US-East Virginia
const DEFAULT_LNG = -77.0;

function pathFromEnv() {
  return process.env.BRIDGE_IDENTITY_PATH ?? 'bridge-identity.json';
}

function regionFromEnv() {
  const lat = parseFloat(process.env.BRIDGE_LAT ?? DEFAULT_LAT);
  const lng = parseFloat(process.env.BRIDGE_LNG ?? DEFAULT_LNG);
  const label = process.env.BRIDGE_REGION_LABEL
    ?? `bridge (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
  return { lat, lng, label, id: 'bridge' };
}

/**
 * @typedef {Object} BridgeIdentity
 * @property {bigint}     id          legacy 64-bit BigInt (top 64 bits of kernel hex)
 * @property {number}     geoBits     8
 * @property {Object}     region      { lat, lng, label, id }
 * @property {number}     createdAt   ms
 * @property {string}     idHex       kernel 66-char hex node ID
 * @property {Uint8Array} pubkey
 * @property {CryptoKey}  privateKey
 * @property {string}     pubkeyHex
 */

/**
 * Load the persisted identity from disk, or derive a fresh one and
 * persist it.  ASYNC now — kernel deriveIdentity uses Web Crypto
 * Ed25519 keygen (async).
 *
 * @returns {Promise<BridgeIdentity>}
 */
export async function loadOrDeriveIdentity() {
  const path = pathFromEnv();
  const labels = regionFromEnv();

  if (existsSync(path)) {
    try {
      const raw      = readFileSync(path, 'utf8');
      const envelope = JSON.parse(raw);

      // Old v0.x format had id length 16 (BigInt 64-bit hex); detect
      // and reject — no pubkey/privkey to bootstrap signing from.
      if (typeof envelope?.id === 'string' && envelope.id.length === 16) {
        console.error(
          `bridge-identity: legacy v0.x identity at ${path} (16-char hex); ` +
          'I4 migration re-derives a fresh v1.0 identity.  ' +
          'Delete the file or remove the path to silence this.');
      } else {
        // Kernel envelope.  loadIdentity verifies internal consistency.
        const kernel = await loadIdentity(envelope);
        return buildHybrid(kernel, envelope.region ?? labels);
      }
    } catch (err) {
      console.error(
        `bridge-identity: failed to read ${path}: ${err.message}; generating fresh`);
    }
  }

  // Fresh kernel identity.
  const kernel   = await kernelDeriveIdentity({ lat: labels.lat, lng: labels.lng });
  const identity = buildHybrid(kernel, labels);

  // Persist as kernel envelope + extended region (we keep label/id
  // alongside lat/lng for the bridge's own logging/UI use).
  try {
    const envelope = await dumpIdentity(kernel);
    envelope.region = { ...envelope.region, label: labels.label, id: labels.id };
    const parent = dirname(path);
    if (parent && parent !== '.' && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(envelope, null, 2));
  } catch (err) {
    console.error(`bridge-identity: failed to persist to ${path}: ${err.message}`);
  }
  return identity;
}

/** Build the hybrid identity object from a kernel identity. */
function buildHybrid(kernel, regionLabels) {
  // Top 64 bits of kernel hex = same S2 prefix in top 8 bits, then
  // 56 bits derived from sha256(pubkey).  Deterministic per identity.
  const idLegacy = BigInt('0x' + kernel.id.slice(0, 16));
  return {
    // Legacy
    id:         idLegacy,
    geoBits:    GEO_BITS,
    region:     {
      lat:   kernel.region.lat,
      lng:   kernel.region.lng,
      label: regionLabels.label ?? `bridge (${kernel.region.lat.toFixed(2)}, ${kernel.region.lng.toFixed(2)})`,
      id:    regionLabels.id    ?? 'bridge',
    },
    createdAt:  kernel.createdAt,
    // Kernel
    idHex:      kernel.id,
    pubkey:     kernel.pubkey,
    privateKey: kernel.privateKey,
    pubkeyHex:  kernel.pubkeyHex,
  };
}

/** Format a 64-bit BigInt nodeId as a 16-char hex string (Axona wire
 *  convention for the legacy mesh / bridge handshake). */
export function idToHex(id) { return id.toString(16).padStart(16, '0'); }
