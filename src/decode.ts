// `rumcap/decode` — the decode surface: unpack `.rcap` bytes back into the capture model, plus the
// manifest/payload consistency check and the shared constants/brands/types. This entry (and its
// import graph) runs in tooling only; it is kept physically apart from `rumcap/encode` so the decoder
// and `DecompressionStream` can never reach a user's page.

// ── Runtime (decode) ────────────────────────────────────────────────────────────────────────────────
export { unpack } from './codec/unpack.js';
// Manifest-vs-payload consistency check for tests/tooling/ingest (not a hot path).
export { checkConsistency } from './codec/validate.js';
// Cleartext-header sniff: identify a `.rcap` (by magic, never extension) + read its versions without
// decompressing — for tooling that routes/filters files.
export { sniff } from './codec/sniff.js';
export type { RcapHeader } from './codec/sniff.js';

// ── The shared contract (constants + types; identical set on `rumcap/encode`) ──────────────────────
export * from './contract.js';
