/**
 * Decode-side byte I/O: a bounds-checked `Reader`, the interning-table read (`decodeStringTable`), the
 * `FieldDecoder` the decode walker builds on, and the JsonValue decoder. This half runs in tooling
 * (never on a user's page), so it favors clarity; it must never be reachable from the encode entry —
 * hence the physical split. Each primitive is the exact inverse of its `field-encoder.ts` peer; the
 * round-trip corpus is what proves it.
 *
 * (`FieldDecoder` was named `Decoder` before the encode/decode split.)
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

/** Cursor over a byte buffer. Every read is bounds-checked so a truncated/corrupt file fails loudly. */
export class Reader {
  private readonly view: DataView;
  pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new RangeError('unexpected end of capture data');
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  varuint(): number {
    let result = 0;
    let scale = 1;
    let byte: number;
    do {
      this.need(1);
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * scale; // multiply, not shift: stays correct past 2^32
      scale *= 128;
    } while (byte & 0x80);
    return result;
  }

  zigzag(): number {
    const u = this.varuint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * Read the interned string table (the mirror of `StringTable.encode`). A free function, not a static on
 * `StringTable`, so pulling in the decoder never drags the interning-build `Map`/`intern` code along.
 */
export function decodeStringTable(r: Reader): string[] {
  const dec = new TextDecoder();
  const n = r.varuint();
  const list = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const len = r.varuint();
    list[i] = dec.decode(r.bytes(len));
  }
  return list;
}

// Fixed-point µs timeline ticks → ms. Mirror of `toTicks` in `field-encoder.ts` (see its comment for
// the precision rationale). Exported so the columnar slice decoder shares the ONE grid rule.
const US_PER_MS = 1000;
export const fromTicks = (us: number): number => us / US_PER_MS;

/** FieldDecoder = a `Reader` plus the already-decoded string table. The mirror of `FieldEncoder`. */
export class FieldDecoder {
  constructor(
    readonly r: Reader,
    readonly strings: readonly string[],
  ) {}

  u8(): number {
    return this.r.u8();
  }
  varuint(): number {
    return this.r.varuint();
  }
  zigzag(): number {
    return this.r.zigzag();
  }
  f64(): number {
    return this.r.f64();
  }
  /** A page-timeline point (RelMs) decoded from integer-µs ticks. */
  rel(): RelMs {
    return fromTicks(this.r.zigzag()) as RelMs;
  }
  /** A duration (DurationMs) decoded from integer-µs ticks. */
  dur(): DurationMs {
    return fromTicks(this.r.zigzag()) as DurationMs;
  }
  bool(): boolean {
    return this.r.u8() !== 0;
  }
  str(): string {
    const id = this.r.varuint();
    const s = this.strings[id];
    if (s === undefined) throw new RangeError(`string id ${id} out of range`);
    return s;
  }
  strArray(): string[] {
    const n = this.r.varuint();
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = this.str();
    return out;
  }
  presence(n: number): boolean[] {
    const flags = new Array<boolean>(n);
    for (let i = 0; i < n; i += 8) {
      const b = this.r.u8();
      for (let j = 0; j < 8 && i + j < n; j++) flags[i + j] = (b & (1 << j)) !== 0;
    }
    return flags;
  }
}

/**
 * `JsonValue` decoder — the mirror of `encodeJson`. The 1-byte tag keeps `null` distinct from an absent
 * field and preserves object/array/scalar shape exactly.
 */
export function decodeJson(d: FieldDecoder): JsonValue {
  const tag = d.u8();
  switch (tag) {
    case JSON_NULL:
      return null;
    case JSON_FALSE:
      return false;
    case JSON_TRUE:
      return true;
    case JSON_NUMBER:
      return d.f64();
    case JSON_STRING:
      return d.str();
    case JSON_ARRAY: {
      const n = d.varuint();
      const arr: JsonValue[] = new Array<JsonValue>(n);
      for (let i = 0; i < n; i++) arr[i] = decodeJson(d);
      return arr;
    }
    case JSON_OBJECT: {
      const n = d.varuint();
      const obj: { [key: string]: JsonValue } = {};
      for (let i = 0; i < n; i++) {
        const k = d.str();
        const val = decodeJson(d);
        // Own-property rebuild, exactly like JSON.parse. Plain `obj[k] = val` would route a '__proto__'
        // key through the Object.prototype SETTER — swapping the object's prototype to file-controlled
        // data (verified prototype pollution when unpacking untrusted captures) and losing the key.
        Object.defineProperty(obj, k, { value: val, writable: true, enumerable: true, configurable: true });
      }
      return obj;
    }
    default:
      throw new RangeError(`unknown JSON tag ${tag}`);
  }
}
