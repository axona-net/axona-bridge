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
// Persistence: NONE (Phase 2). The bridge transport id is EPHEMERAL — a fresh
// kernel identity is derived on every start; nothing is written to disk. The
// bridge directory dedups + ranks on the bridge URL (not the signer), so a
// rotating signer just re-publishes the same-URL directory entry on restart;
// clients still discover, rank, and fail over to it. No bridge-identity.json,
// no BRIDGE_IDENTITY_PATH.
// =====================================================================

import { deriveIdentity as kernelDeriveIdentity } from '@axona/protocol';

const GEO_BITS = 8;

const DEFAULT_LAT = 38.0;     // US-East Virginia
const DEFAULT_LNG = -77.0;

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
  // Phase 2: the bridge transport id is EPHEMERAL — never persisted. The bridge
  // mints a fresh kernel identity on every start (no bridge-identity.json). The
  // bridge directory + first-party reputation are keyed on the bridge URL, not
  // on the (now-rotating) signer, so clients still find + rank it across
  // restarts; a fresh signer simply re-publishes the same-URL directory entry.
  const labels = regionFromEnv();
  const kernel = await kernelDeriveIdentity({ lat: labels.lat, lng: labels.lng });
  return buildHybrid(kernel, labels);
}

/** Build the hybrid identity object from a kernel identity. */
function buildHybrid(kernel, regionLabels) {
  // v1.1: full-width 264-bit node ID — same address space as
  // topic IDs so K-closest XOR distance is meaningful (top 8 bits
  // = S2 region prefix on both peer IDs and topic IDs).  Replaces
  // the previous .slice(0, 16) which left the bridge in a 64-bit
  // mesh while topics were 264-bit.
  const idBig = BigInt('0x' + kernel.id);
  return {
    // Legacy field name; value is now 264-bit BigInt.
    id:         idBig,
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

/** Format a 264-bit BigInt nodeId as a 66-char hex string (v1.1 wire
 *  convention: top 8 bits = S2 region prefix, rest = pubkey-derived
 *  hash; same width as topic IDs). */
export function idToHex(id) { return id.toString(16).padStart(66, '0'); }
