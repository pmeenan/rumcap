/**
 * Header sniffing: identify a `.rcap` and read its versions from the CLEARTEXT prefix — the magic and
 * the two varuint versions live outside the gzip precisely so tooling can route/filter/version-gate
 * files without decompressing (FileFormat.md "Overall layout"). Detection is by magic bytes, never by
 * file extension. Returns `null` for anything that isn't a well-formed `.rcap` prefix; it never
 * throws. Unlike `unpack`, an unknown codec version is still REPORTED here (the header is readable
 * even when the body isn't walkable) — that is what lets a tool say "newer than this build" precisely.
 *
 * Deliberately self-contained (magic + two LEB128 reads) rather than reusing the body decoder: sniff
 * must stay cheap to import and total over hostile input, where the body reader is right to throw.
 */

import { MAGIC, CODEC_VERSION } from './constants.js';

export interface RcapHeader {
  codecVersion: number;
  formatVersion: number;
  /** Whether THIS build's `unpack` can walk the body (`codecVersion` ≤ its `CODEC_VERSION`). */
  readable: boolean;
}

export function sniff(bytes: Uint8Array | ArrayBuffer): RcapHeader | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < MAGIC.length) return null;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return null;
  let offset = MAGIC.length;
  // Unsigned LEB128, bounded: a version needs ≤ 5 bytes (they are tiny in practice); anything longer
  // in the header is not a version we could have written — treat as not-a-`.rcap` rather than looping.
  const varuint = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (offset >= b.length) return null; // truncated header
      const byte = b[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  const codecVersion = varuint();
  const formatVersion = varuint();
  if (codecVersion === null || formatVersion === null) return null;
  return { codecVersion, formatVersion, readable: codecVersion <= CODEC_VERSION };
}
