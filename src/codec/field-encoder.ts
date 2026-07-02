/**
 * Encode-side byte I/O: a growable `Writer`, the interning `StringTable` (build side), the
 * `FieldEncoder` the encode walker builds on, and the JsonValue encoder. Everything here is
 * hand-rolled and zero-dependency on purpose — this is the path that runs on a real user's page
 * (AGENTS "tiny on the page"), so it must be small, tree-shakeable, and free of any runtime import.
 * The decode mirror of every primitive lives in `field-decoder.ts`; the round-trip corpus proves the
 * two are exact inverses.
 *
 * (`FieldEncoder` was named `Encoder` before the encode/decode split; it was renamed to free `Encoder`
 * for the public streaming class in `../encoder.ts`.)
 */

import type { RelMs, DurationMs } from '../time.js';
import type { JsonValue } from '../json.js';
import {
  JSON_NULL,
  JSON_FALSE,
  JSON_TRUE,
  JSON_NUMBER,
  JSON_STRING,
  JSON_ARRAY,
  JSON_OBJECT,
} from './constants.js';

/**
 * Growable little-endian byte sink. Capacity doubles on demand; `finish()` returns a view of exactly
 * the written bytes (no copy). Numbers are written as LEB128 varints (the small non-negative integers
 * that dominate: counts, ids, sizes, string refs), zigzag varints (the fixed-point µs timeline ticks —
 * see `FieldEncoder.rel`/`dur`), or 8-byte IEEE-754 doubles (wall-clock `EpochMs` plus true floats —
 * rects, ratios, CLS value — that can be fractional or negative and are not on the µs timeline grid).
 */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b & 0xff;
  }

  /**
   * Unsigned LEB128. Uses `% 128` / `Math.floor(n / 128)` rather than `& 0x7f` / `>>> 7` so values
   * above 2^32 (e.g. large `decodedBodySize`) survive — JS bitwise ops truncate to 32 bits and would
   * corrupt them silently. Non-integer or negative input is a programming error (a field was routed
   * to the wrong writer); we throw loudly rather than encode a wrong value.
   */
  varuint(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`varuint expects a non-negative integer, got ${n}`);
    }
    this.ensure(10); // ceil(53/7) = 8 bytes max for a safe integer; 10 is comfortable headroom
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 128) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }

  /**
   * Signed LEB128 via zigzag (…, -2→3, -1→1, 0→0, 1→2, 2→4, …). Uses `* 2` / `* -2 - 1` rather than
   * `<< 1` / `>> 31` so it stays correct past 2^32 — a microsecond timestamp for a multi-minute
   * session already exceeds 2^31. Small magnitudes (the common case after delta-encoding) stay 1 byte.
   */
  zigzag(n: number): void {
    if (!Number.isInteger(n)) throw new RangeError(`zigzag expects an integer, got ${n}`);
    this.varuint(n >= 0 ? n * 2 : n * -2 - 1);
  }

  /** 8-byte IEEE-754 double, little-endian. Lossless for every JS number, including NaN and -0. */
  f64(x: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, x, true);
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

/**
 * String interning (build side). URLs, resource names, selectors, custom-event names/namespaces, and
 * the format's many small enum literals repeat heavily across a capture; storing each once and
 * referring to it by a varint id is the codec's single biggest size lever. Ids are assigned in
 * first-seen order during the encode pass, so the table can only be serialized once that pass is
 * complete — which is why the string-table section is emitted last but placed first in the file (see
 * pack.ts). The empty string is a normal, distinct value (e.g. `deliveryType: ''`) and interns like
 * any other; "absent" is carried by presence bits, never by the table. The read side is the free
 * function `decodeStringTable` in `field-decoder.ts`.
 *
 * Unicode carve-out (documented contract, see FileFormat.md): strings are stored as well-formed UTF-8
 * via `TextEncoder`, which replaces LONE SURROGATES with U+FFFD — the same USVString normalization the
 * platform applies to URLs, `fetch`, and `postMessage`. A DOMString-sourced value that carries an
 * unpaired surrogate (e.g. a mark name truncated mid-emoji) therefore decodes as its U+FFFD-normalized
 * form; this is the ONE way `unpack(pack(c))` may differ from `c` besides µs quantization.
 */
export class StringTable {
  private readonly index = new Map<string, number>();
  private readonly list: string[] = [];

  intern(s: string): number {
    let id = this.index.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(s);
      this.index.set(s, id);
    }
    return id;
  }

  encode(w: Writer): void {
    const enc = new TextEncoder();
    w.varuint(this.list.length);
    for (const s of this.list) {
      const b = enc.encode(s);
      w.varuint(b.length);
      w.bytes(b);
    }
  }
}

/**
 * Timeline timestamps are stored as fixed-point **integer microseconds** (zigzag varint), NOT raw f64.
 * Browsers coarsen `DOMHighResTimeStamp` to 100µs by default and at best 5µs when cross-origin isolated
 * (W3C High Resolution Time; verified against MDN + the Chrome cross-origin-isolated-timer blog), so
 * 1µs granularity captures everything real and the extra f64 digits are float noise, not signal.
 * Integer µs is ~2-4 bytes vs 8, makes deltas trivial, and `round(ms * 1000) / 1000` recovers the
 * canonical double exactly for any ≤1µs-resolution value. Only the branded `RelMs`/`DurationMs`
 * timeline values go through here; wall-clock `EpochMs` and true floats (rects, CLS value, ratios) stay
 * f64. Sign is supported (a `ContextClock.offsetToPage` can be negative). Mirror: `fromTicks` in
 * `field-decoder.ts`.
 */
const US_PER_MS = 1000;
/** ms → integer-µs ticks. Exported so the columnar slice encoder shares the ONE grid/rounding rule. */
export const toTicks = (ms: number): number => Math.round(ms * US_PER_MS);

/**
 * FieldEncoder = a byte `Writer` plus the capture-wide `StringTable`. One is created per section
 * (manifest, each stream, overhead, metadata) but they all share the same table, so a URL seen in
 * `resources` and again in `lcp` is stored once. This per-section split is also the incremental seam:
 * a driver can finalize each stream's bytes as that stream completes and flush only the (cheap) string
 * table at pagehide — never a big synchronous pack at unload (AGENTS "no unload cliff").
 */
export class FieldEncoder {
  readonly w = new Writer();
  constructor(readonly strings: StringTable) {}

  u8(b: number): void {
    this.w.u8(b);
  }
  varuint(n: number): void {
    this.w.varuint(n);
  }
  zigzag(n: number): void {
    this.w.zigzag(n);
  }
  f64(x: number): void {
    this.w.f64(x);
  }
  /** A point on the page timeline (RelMs) as integer-µs ticks. */
  rel(x: RelMs): void {
    this.w.zigzag(toTicks(x));
  }
  /** A duration (DurationMs) as integer-µs ticks. */
  dur(x: DurationMs): void {
    this.w.zigzag(toTicks(x));
  }
  bool(b: boolean): void {
    this.w.u8(b ? 1 : 0);
  }
  /** Intern `s` and write its varint id. All string-typed fields, including enum literals, go here. */
  str(s: string): void {
    this.w.varuint(this.strings.intern(s));
  }
  strArray(arr: readonly string[]): void {
    this.w.varuint(arr.length);
    for (const s of arr) this.str(s);
  }

  /**
   * Write a presence bitmap for a struct's optional fields, in declared order. Absent optionals then
   * cost one bit and nothing else — the "truly optional on the wire" tenet. A byte array (not a 32-bit
   * int) backs it so structs with >32 optionals (ResourceTiming has ~28, Navigation more) are fine.
   */
  presence(flags: readonly boolean[]): void {
    const n = flags.length;
    for (let i = 0; i < n; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < n; j++) if (flags[i + j]) b |= 1 << j;
      this.w.u8(b);
    }
  }
}

/**
 * `JsonValue` encoder for User Timing `detail`, custom-event `details`, and capture `metadata`. Numbers
 * are stored as f64 (JSON numbers are doubles; this is lossless and payloads are small, so a tighter
 * int path isn't worth the branch). Keys are interned like any other string. Mirror: `decodeJson`.
 *
 * Input is normalized with **`JSON.stringify` semantics** (documented contract — see `json.ts` and
 * FileFormat.md): `toJSON()` is honored (so a `Date` encodes as its ISO string), `undefined`/function/
 * symbol object properties are skipped, those values become `null` in arrays (and at the top level),
 * and non-finite numbers become `null`. This makes the encoder TOTAL — captures really do carry
 * `{ detail: { x: undefined } }` (structured clone preserves it) and that must never crash `pack()`.
 * Deviation from `JSON.stringify` (which throws): `bigint` encodes as `null`. Values that survive
 * normalization round-trip exactly.
 */
export function encodeJson(e: FieldEncoder, v: JsonValue): void {
  encodeJsonValue(e, v as unknown);
}

/** Is `v` kept as an object property under JSON.stringify rules? (Skipped ones cost zero bytes.) */
function keepInObject(v: unknown): boolean {
  const t = typeof v;
  return v !== undefined && t !== 'function' && t !== 'symbol';
}

function encodeJsonValue(e: FieldEncoder, v: unknown): void {
  // Order matters: the toJSON hook is consulted before the plain-object fallback, like JSON.stringify.
  if (v === null || v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
    e.u8(JSON_NULL); // array slots / top level: stringify's "not representable here" → null
  } else if (v === false) {
    e.u8(JSON_FALSE);
  } else if (v === true) {
    e.u8(JSON_TRUE);
  } else if (typeof v === 'number') {
    if (Number.isFinite(v)) {
      e.u8(JSON_NUMBER);
      e.f64(v);
    } else {
      e.u8(JSON_NULL); // NaN/±Infinity are not JSON — stringify emits null
    }
  } else if (typeof v === 'string') {
    e.u8(JSON_STRING);
    e.str(v);
  } else if (Array.isArray(v)) {
    e.u8(JSON_ARRAY);
    e.varuint(v.length);
    for (const item of v) encodeJsonValue(e, item);
  } else if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    // Date → ISO string, and any user type opting into JSON via toJSON(). A toJSON() returning a
    // non-JSON value falls through the same normalization (worst case: null).
    encodeJsonValue(e, (v as { toJSON(): unknown }).toJSON());
  } else {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => keepInObject(obj[k]));
    e.u8(JSON_OBJECT);
    e.varuint(keys.length);
    for (const k of keys) {
      e.str(k);
      encodeJsonValue(e, obj[k]);
    }
  }
}
