// Public surface of `rumcap` (the `.` entry) — the convenience union of the encode and decode halves.
// Prefer the split entries when you only need one side: `rumcap/encode` (pack + streaming Encoder,
// ships no decoder) or `rumcap/decode` (unpack). This barrel re-exports the encode surface (which
// already carries the shared constants/brands/types) and adds the decode-only symbols.

export * from './encode.js';
export { unpack } from './codec/unpack.js';
export { checkConsistency } from './codec/validate.js';
