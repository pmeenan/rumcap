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
 *  so readers can pull what they know from newer files — see FileFormat.md "Reading across versions". */
export const CODEC_VERSION = 2;

/** Canonical file extension for a packed capture. (The npm package is `rumcap`; the format is `rcap`.) */
export const FILE_EXTENSION = '.rcap';

// Body section tags. Each section is [ tag:u8 ][ byteLen:varuint ][ payload ]; an unknown tag is
// skipped via its length prefix, so a newer file never breaks an older reader (forward-compat).
export const SECTION_STRING_TABLE = 1;
export const SECTION_MANIFEST = 2;
export const SECTION_STREAM = 3;
export const SECTION_OVERHEAD = 4;
export const SECTION_METADATA = 5; // capture-level metadata (arbitrary JSON); added in FORMAT_VERSION 2

// JsonValue codec discriminators (User Timing `detail`, custom-event `details`, capture `metadata`).
// A 1-byte tag keeps `null` distinct from an absent field and preserves object/array/scalar shape.
export const JSON_NULL = 0;
export const JSON_FALSE = 1;
export const JSON_TRUE = 2;
export const JSON_NUMBER = 3;
export const JSON_STRING = 4;
export const JSON_ARRAY = 5;
export const JSON_OBJECT = 6;
