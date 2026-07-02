/**
 * Wire constants shared by the encode and decode halves of the codec. Kept in ONE module so a magic
 * byte, a version, a section tag, or a JSON discriminator can never skew between the side that WRITES
 * it (pack/encode) and the side that SWITCHES on it (unpack/decode) — both read the same source of
 * truth. Pure data, no logic: importing it from the encode path drags nothing decode-only in.
 */

/** File signature: `\xF5RUM`. `0xF5` is an always-invalid UTF-8 lead byte → unmistakably binary. */
export const MAGIC: Readonly<Uint8Array> = new Uint8Array([0xf5, 0x52, 0x55, 0x4d]);

/** Wire/codec version, independent of the schema `FORMAT_VERSION`. Bumped only on a wire-layout change.
 *  v2: manifest stream records became self-describing frames ([index][status][schemaVersion][len][rest])
 *  so readers can pull what they know from newer files — see FileFormat.md "Reading across versions".
 *  v3: measured size pass (corpus: −14.5% post-gzip) — a capture-wide tick-scale prelude (the GCD of
 *  all µs ticks, so coarse-clock captures shrink), R values delta-chained per encoder scope, struct
 *  arrays ≥ COLUMNAR_MIN stored column-major with transposed presence, and rects packed as 4 values
 *  with spec-derived edges. See FileFormat.md. */
export const CODEC_VERSION = 3;

/** Canonical file extension for a packed capture — the ONE place the short name survives; the
 *  package, repo, and format are all named `rumcap`. */
export const FILE_EXTENSION = '.rcap';

// Body section tags. Each section is [ tag:u8 ][ byteLen:varuint ][ payload ]; an unknown tag is
// skipped via its length prefix, so a newer file never breaks an older reader (forward-compat).
export const SECTION_STRING_TABLE = 1;
export const SECTION_MANIFEST = 2;
export const SECTION_STREAM = 3;
export const SECTION_OVERHEAD = 4;
export const SECTION_METADATA = 5; // capture-level metadata (arbitrary JSON); added in FORMAT_VERSION 2

/** Struct arrays with at least this many entries encode column-major (see the walkers). A wire framing
 *  rule, not a heuristic: both sides derive row-vs-columnar from the array count alone, so the choice
 *  never needs a flag byte. Below the threshold the transposed presence padding (one byte minimum per
 *  optional field) can exceed the row form on wide structs like ResourceTiming. */
export const COLUMNAR_MIN = 8;

// JsonValue codec discriminators (User Timing `detail`, custom-event `details`, capture `metadata`).
// A 1-byte tag keeps `null` distinct from an absent field and preserves object/array/scalar shape.
export const JSON_NULL = 0;
export const JSON_FALSE = 1;
export const JSON_TRUE = 2;
export const JSON_NUMBER = 3;
export const JSON_STRING = 4;
export const JSON_ARRAY = 5;
export const JSON_OBJECT = 6;
