// =====================================================================
// identity.js — bridge's hybrid (legacy 64-bit + kernel 264-bit) identity.
//
// v0.3 (kernel 3.0.0): migrated to the kernel's createNodeIdentity (the
// connection/node identity factory; deriveIdentity was renamed) so the
// bridge is a kernel-conformant peer in the v1.0 wire protocol — signed
// envelopes work, peer topics derive correctly under the structured
// { region, name } addressing model.
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
// and no path setting exists for one.
// =====================================================================

import { createNodeIdentity as kernelCreateNodeIdentity } from '@axona/protocol';

const GEO_BITS = 8;

const DEFAULT_LAT = 38.0;     // US-East Virginia
const DEFAULT_LNG = -77.0;

// BRIDGE_REGION (2.129.0, kernel ≥ 4.88.0): an explicit region for the bridge's node id. The only
// value with a meaning today is `bridge` — the kernel's SYSTEM region 0xFF, which holds exactly one
// topic (the directory) and which no coordinate ever produces. Unset = the geo derivation from
// BRIDGE_LAT/LNG exactly as before. Lat/lng stay the bridge's location for its directory entry.
const BRIDGE_REGION = (process.env.BRIDGE_REGION ?? '').trim() || null;
export const REGION_BYTE_BY_NAME = Object.freeze({ bridge: 'ff' });

function regionFromEnv() {
  const lat = parseFloat(process.env.BRIDGE_LAT ?? DEFAULT_LAT);
  const lng = parseFloat(process.env.BRIDGE_LNG ?? DEFAULT_LNG);
  const label = process.env.BRIDGE_REGION_LABEL
    ?? `bridge (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
  return { lat, lng, label, id: 'bridge', region: BRIDGE_REGION };
}

/**
 * FAIL CLOSED (PLAN-v0.3 §6): when BRIDGE_REGION names a region, the minted id MUST carry that
 * region's byte. A kernel below 4.88.0 ignores the `region` argument and mints a geo id; that is
 * not a bridge in the requested region and the process must not come up pretending it is.
 * Exported for the fence test; called on every start.
 */
export function assertRegionApplied(kernelId, requestedRegion) {
  if (!requestedRegion) return;
  const want = REGION_BYTE_BY_NAME[requestedRegion];
  if (!want) throw new Error(`BRIDGE_REGION='${requestedRegion}' is not a region this bridge knows how to request (known: ${Object.keys(REGION_BYTE_BY_NAME).join(', ')})`);
  const got = String(kernelId).slice(0, 2).toLowerCase();
  if (got !== want) throw new Error(`BRIDGE_REGION='${requestedRegion}' requested byte 0x${want} but the kernel minted 0x${got}: the kernel does not honour the region override (needs @axona/protocol >= 4.88.0); refusing to start`);
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
 * Derive a fresh node/connection identity.  ASYNC — kernel
 * createNodeIdentity uses Web Crypto Ed25519 keygen (async).
 *
 * @returns {Promise<BridgeIdentity>}
 */
export async function loadOrDeriveIdentity() {
  // Phase 2: the bridge transport id is EPHEMERAL — never persisted. The bridge
  // mints a fresh kernel node identity on every start (no bridge-identity.json).
  // The bridge directory + first-party reputation are keyed on the bridge URL,
  // not on the (now-rotating) signer, so clients still find + rank it across
  // restarts; a fresh signer simply re-publishes the same-URL directory entry.
  const labels = regionFromEnv();
  const kernel = await kernelCreateNodeIdentity({ lat: labels.lat, lng: labels.lng, ...(labels.region ? { region: labels.region } : {}) });
  assertRegionApplied(kernel.id, labels.region);
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
      // the region NAME the id byte was minted in: 'bridge' under BRIDGE_REGION=bridge, else the geo name is
      // not known here (the kernel folds lat/lng); healthz/diag report `region` as the label and
      // `regionRequested` as this field so an operator can see the two apart.
      requested: regionLabels.region ?? null,
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
