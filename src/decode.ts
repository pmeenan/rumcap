// `rumcap/decode` — the decode surface: unpack `.rcap` bytes back into the capture model, plus the
// manifest/payload consistency check and the shared constants/brands/types. This entry (and its
// import graph) runs in tooling only; it is kept physically apart from `rumcap/encode` so the decoder
// and `DecompressionStream` can never reach a user's page.

// ── Runtime (decode) ────────────────────────────────────────────────────────────────────────────────
export { unpack } from './codec/unpack.js';
// Manifest-vs-payload consistency check for tests/tooling/ingest (not a hot path).
export { checkConsistency } from './codec/validate.js';

// ── The shared contract (constants + types; identical set on `rumcap/encode`) ──────────────────────
export * from './contract.js';
