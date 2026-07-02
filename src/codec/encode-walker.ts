/**
 * Encode walker — interprets the shared descriptor tables (`descriptors.ts`) to WRITE a capture's
 * structs, plus the handful of special handlers a flat table can't express (recursive
 * notRestoredReasons, keyed config/overhead maps, columnar profile slices). The decode mirror is
 * `decode-walker.ts`; both read the SAME descriptors, so they cannot drift.
 */

import { FieldEncoder, encodeJson, toTicks } from './field-encoder.js';
import {
  S, R, D, U, F, B, J, SA,
  NRR, SMAP, OMAP, PSLICES, NAV, RECTT,
  STREAM_INDEX, bad,
  STREAM_CONFIG, OVERHEAD_ENTRY,
  CLOCK, STREAM_MANIFEST_REST, CONFIG, OVERHEAD, RESOURCE, NAV_EXTRA, STREAM_T,
  type Desc, type NrrNode,
} from './descriptors.js';
import { COLUMNAR_MIN } from './constants.js';
import { STREAM_IDS, type StreamId } from '../registry.js';
import type { RelMs, DurationMs } from '../time.js';
import type { JsonValue } from '../json.js';
import type { Manifest } from '../manifest.js';
import type { OverheadReport } from '../capture.js';
import type { Rect } from '../streams/index.js';

// ── Generic walker ──────────────────────────────────────────────────────────────────────────────────

function field(e: FieldEncoder, v: unknown, t: unknown): void {
  if (typeof t === 'number') {
    if (t === S) e.str(v as string);
    else if (t === R) e.rel(v as RelMs);
    else if (t === D) e.dur(v as DurationMs);
    else if (t === U) e.varuint(v as number);
    else if (t === F) e.f64(v as number);
    else if (t === B) e.bool(v as boolean);
    else if (t === J) encodeJson(e, v as JsonValue);
    else if (t === SA) e.strArray(v as string[]);
    else bad(t);
  } else if (typeof t === 'string') {
    if (t === NRR) encNullableNrr(e, v as NrrNode | null);
    else if (t === SMAP) encStreamMap(e, v as Record<string, unknown>, STREAM_CONFIG);
    else if (t === OMAP) encStreamMap(e, v as Record<string, unknown>, OVERHEAD_ENTRY);
    else if (t === PSLICES) encSlices(e, v as ReadonlyArray<{ frameId: number; depth: number; start: number; duration: number }>);
    else if (t === RECTT) encRect(e, v as Rect);
    else if (t === NAV) {
      // navigation: one object written as two struct blocks (the resource-shaped base, then the
      // navigation extras) — see the descriptor comment on RESOURCE/NAV_EXTRA.
      encStruct(e, v, RESOURCE);
      encStruct(e, v, NAV_EXTRA);
    } else bad(t);
  } else if (typeof (t as Desc)[0] === 'number') {
    encStruct(e, v, t as Desc); // nested struct
  } else {
    const arr = v as unknown[];
    e.varuint(arr.length);
    const elem = (t as Desc)[0] as Desc;
    // Row-vs-columnar is derived from the count alone (COLUMNAR_MIN), so no flag byte is needed and
    // the decoder makes the identical choice.
    if (arr.length >= COLUMNAR_MIN) encColumnar(e, arr, elem);
    else for (const x of arr) encStruct(e, x, elem); // array of struct
  }
}

function encStruct(e: FieldEncoder, o: unknown, desc: Desc): void {
  const obj = o as Record<string, unknown>;
  const rc = desc[0] as number;
  const m = (desc.length - 1) >> 1; // total field count
  for (let i = 0; i < rc; i++) {
    const k = desc[1 + 2 * i] as string;
    const v = obj[k];
    // A required field must be present; a missing one (bad descriptor key, or a malformed capture that
    // skipped the type system) would silently encode "undefined"/false/NaN and corrupt the wire.
    if (v === undefined) throw new Error('missing required field ' + k);
    field(e, v, desc[2 + 2 * i]);
  }
  const flags: boolean[] = [];
  for (let i = rc; i < m; i++) flags.push(obj[desc[1 + 2 * i] as string] !== undefined);
  e.presence(flags);
  for (let i = rc; i < m; i++) {
    if (flags[i - rc]) field(e, obj[desc[1 + 2 * i] as string], desc[2 + 2 * i]);
  }
}

/**
 * Column-major struct array (count >= COLUMNAR_MIN; the count was already written). Layout: one
 * TRANSPOSED presence bit-column per optional field (entry j's bit within field i's column), then every
 * field as a contiguous column of the entries that have it. Same-field values compress far better side
 * by side than interleaved (statuses repeat, sizes share magnitude, presence runs are uniform), and R
 * columns chain independently (chainSwap) so a sorted startTime column becomes a run of small deltas —
 * this is the same reasoning as the profile-slice columns, generalized. Mirror: decColumnar.
 */
function encColumnar(e: FieldEncoder, arr: readonly unknown[], desc: Desc): void {
  const objs = arr as ReadonlyArray<Record<string, unknown>>;
  const rc = desc[0] as number;
  const m = (desc.length - 1) >> 1;
  for (let i = rc; i < m; i++) {
    const k = desc[1 + 2 * i] as string;
    e.presence(objs.map((o) => o[k] !== undefined));
  }
  for (let i = 0; i < m; i++) {
    const k = desc[1 + 2 * i] as string;
    const t = desc[2 + 2 * i];
    const outer = e.chainSwap(); // each column is its own delta sequence
    for (const o of objs) {
      const v = o[k];
      if (v === undefined) {
        // Same required-field guard as encStruct — never encode garbage for a malformed capture.
        if (i < rc) throw new Error('missing required field ' + k);
        continue;
      }
      field(e, v, t);
    }
    e.chainSwap(outer);
  }
}

// ── Special handlers (the shapes a flat descriptor can't express) ───────────────────────────────────

/** Integer-valued numbers that survive zigzag exactly. −0 is excluded (zigzag would decode it as +0;
 *  f64 keeps the sign bit), as are magnitudes near the ×2 zigzag headroom limit. */
const intOk = (v: number): boolean => Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) <= 2 ** 47;

/**
 * Rect — all 8 model fields are required, but browsers can only produce DOMRectReadOnly-consistent
 * rects, whose edges are DERIVED: left/top = min(x, x+width)/(y, y+height), right/bottom = the max
 * (https://drafts.fxtf.org/geometry/#dom-domrectreadonly-domrectreadonly-top). When the edges match
 * exactly (Object.is, so NaN/-0 stay honest), only x/y/width/height go on the wire and the decoder
 * recomputes the rest with the SAME float ops — bit-exact, so nothing is synthesized. CSS-pixel values
 * are usually integers, so each value carries an int flag: zigzag varint when integral, f64 otherwise.
 * A hand-built inconsistent rect falls back to all 8 verbatim behind flags=0. ~64 bytes → ~6 typical.
 * Mirror: decRect.
 */
function encRect(e: FieldEncoder, r: Rect): void {
  const right = Math.max(r.x, r.x + r.width);
  const bottom = Math.max(r.y, r.y + r.height);
  const derived =
    Object.is(r.left, Math.min(r.x, r.x + r.width)) &&
    Object.is(r.top, Math.min(r.y, r.y + r.height)) &&
    Object.is(r.right, right) &&
    Object.is(r.bottom, bottom);
  const vals = [r.x, r.y, r.width, r.height, r.top, r.right, r.bottom, r.left];
  const n = derived ? 4 : 8; // derived rects store only x/y/width/height
  let bm = 0; // int bitmap over the stored values (bit i = vals[i] rides zigzag, else f64)
  for (let i = 0; i < n; i++) if (intOk(vals[i] as number)) bm |= 1 << i;
  // derived: one byte [int-bits(4) | 1]; verbatim: a 0 byte then the 8-bit int bitmap.
  if (derived) e.u8(1 | (bm << 1));
  else {
    e.u8(0);
    e.u8(bm);
  }
  for (let i = 0; i < n; i++) {
    if ((bm >> i) & 1) e.zigzag(vals[i] as number);
    else e.f64(vals[i] as number);
  }
}

/** NotRestoredReasons tree — recursive, so it can't be a (TDZ-safe) self-referential descriptor. */
function encNrr(e: FieldEncoder, n: NrrNode): void {
  e.presence([n.url !== undefined, n.src !== undefined, n.id !== undefined, n.name !== undefined, n.reasons !== undefined, n.children !== undefined]);
  if (n.url !== undefined) e.str(n.url);
  if (n.src !== undefined) e.str(n.src);
  if (n.id !== undefined) e.str(n.id);
  if (n.name !== undefined) e.str(n.name);
  if (n.reasons !== undefined) {
    e.varuint(n.reasons.length);
    for (const r of n.reasons) e.str(r.reason);
  }
  if (n.children !== undefined) {
    e.varuint(n.children.length);
    for (const c of n.children) encNrr(e, c);
  }
}
/** A `T | null` field: a 1-byte discriminator after its presence bit keeps absent / null / tree distinct. */
function encNullableNrr(e: FieldEncoder, n: NrrNode | null): void {
  if (n === null) {
    e.u8(0);
  } else {
    e.u8(1);
    encNrr(e, n);
  }
}

/** A partial `Record<StreamId, V>` map: count + [streamIndex, V] pairs (V is a struct descriptor). */
function encStreamMap(e: FieldEncoder, map: Record<string, unknown>, valueDesc: Desc): void {
  const ids = STREAM_IDS.filter((id) => map[id] !== undefined);
  e.varuint(ids.length);
  for (const id of ids) {
    e.u8(STREAM_INDEX[id]);
    encStruct(e, map[id], valueDesc);
  }
}

/**
 * Profile slices — columnar. Four contiguous columns so gzip models each separately:
 *   frameId  — index into `frames` (raw varint).
 *   depth    — zigzag delta from the previous slice (pre-order depths move ±1 most of the time, so
 *              the deltas are tiny and very gzip-friendly — far smaller than raw depths up to 255).
 *   start    — first absolute µs tick, then non-negative µs deltas (pre-order ⇒ non-decreasing).
 *   duration — **1ms units**, not µs: slice durations are sample-INFERRED, accurate only to ±1 interval
 *              (~10ms), so storing microseconds would be false precision (and ~3 bytes/slice → ~1).
 * Nesting is implicit from depth + pre-order, so the per-sample form's interned `stacks` table is gone
 * entirely — far smaller on deep-stack pages. (Custom events, whose durations are MEASURED, do NOT use
 * this handler — they keep full µs precision through the generic `D` writer. See streams/customevents.)
 */
function encSlices(e: FieldEncoder, slices: ReadonlyArray<{ frameId: number; depth: number; start: number; duration: number }>): void {
  e.varuint(slices.length);
  if (slices.length === 0) return;
  for (const s of slices) e.varuint(s.frameId);
  let prevDepth = 0;
  for (const s of slices) {
    e.zigzag(s.depth - prevDepth); // zigzag: maps small ± deltas onto small varints
    prevDepth = s.depth;
  }
  let prevTick = 0;
  for (let i = 0; i < slices.length; i++) {
    const tick = toTicks(slices[i]!.start); // the shared µs grid — same rule as every R/D field
    e.tickDelta(i === 0 ? tick : tick - prevTick); // pre-order ⇒ non-decreasing ⇒ delta ≥ 0; scaled + GCD-probed
    prevTick = tick;
  }
  for (const s of slices) e.varuint(Math.round(s.duration)); // 1ms grid (inferred ±1 interval) — NOT µs ticks, so never scaled
}

// ── Public entry points (consumed by pack.ts) ───────────────────────────────────────────────────────

/**
 * Manifest: clock + the TOTAL per-stream record list + config. Each stream record is a self-describing
 * frame — `[streamIndex: u8][status: str][schemaVersion: varuint][byteLen: varuint][tail bytes]` behind
 * a leading count — so ANY reader (older or newer) can always recover which streams a writer knew,
 * their status, and their schema version, and skip record tails or whole unknown-stream records by
 * length. This is what makes "read newer files, pull what you know" sound; see FileFormat.md.
 */
export function encodeManifest(e: FieldEncoder, m: Manifest): void {
  encStruct(e, m.clock, CLOCK);
  e.varuint(STREAM_IDS.length);
  for (const id of STREAM_IDS) {
    const rec = m.streams[id];
    e.u8(STREAM_INDEX[id]);
    e.str(rec.status);
    e.varuint(rec.schemaVersion);
    // The tail (loss/provenance) is length-prefixed on its own sub-encoder; it shares the capture-wide
    // string table + tick scale but chains independently, because the decoder reads it standalone.
    const tail = e.sub();
    encStruct(tail, rec, STREAM_MANIFEST_REST);
    const bytes = tail.w.finish();
    e.varuint(bytes.length);
    e.w.bytes(bytes);
  }
  encStruct(e, m.config, CONFIG);
}

export function encodeOverhead(e: FieldEncoder, o: OverheadReport): void {
  encStruct(e, o, OVERHEAD);
}

/** Encode one stream's payload, fully descriptor-driven (STREAM_T is total, incl. navigation's NAV tag). */
export function encodeStream(e: FieldEncoder, id: StreamId, data: unknown): void {
  field(e, data, STREAM_T[id]);
}
