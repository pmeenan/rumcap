/**
 * Decode walker — interprets the shared descriptor tables (`descriptors.ts`) to READ a capture's
 * structs, mirroring `encode-walker.ts` field-for-field. Both read the SAME descriptors, so an
 * older/newer struct layout can't drift between the two sides. Runs in tooling, never on a user's page.
 */

import { FieldDecoder, Reader, decodeJson, fromTicks } from './field-decoder.js';
import {
  S, R, D, U, F, B, J, SA,
  NRR, SMAP, OMAP, PSLICES, NAV,
  bad,
  STREAM_CONFIG, OVERHEAD_ENTRY,
  CLOCK, STREAM_MANIFEST_REST, CONFIG, OVERHEAD, RESOURCE, NAV_EXTRA, STREAM_T,
  type Desc, type NrrNode,
} from './descriptors.js';
import { STREAM_IDS, type StreamId } from '../registry.js';
import { FORMAT_VERSION } from '../version.js';
import type { Manifest, StreamManifestEntry } from '../manifest.js';
import type { OverheadReport } from '../capture.js';

// ── Generic walker ──────────────────────────────────────────────────────────────────────────────────

function dfield(d: FieldDecoder, t: unknown): unknown {
  if (typeof t === 'number') {
    if (t === S) return d.str();
    if (t === R) return d.rel();
    if (t === D) return d.dur();
    if (t === U) return d.varuint();
    if (t === F) return d.f64();
    if (t === B) return d.bool();
    if (t === J) return decodeJson(d);
    if (t === SA) return d.strArray();
    return bad(t);
  } else if (typeof t === 'string') {
    if (t === NRR) return decNullableNrr(d);
    if (t === SMAP) return decStreamMap(d, STREAM_CONFIG);
    if (t === OMAP) return decStreamMap(d, OVERHEAD_ENTRY);
    if (t === PSLICES) return decSlices(d);
    if (t === NAV) {
      // navigation mirror: the resource-shaped base block, then the navigation extras, one object.
      const base = decStruct(d, RESOURCE);
      return Object.assign(base, decStruct(d, NAV_EXTRA));
    }
    return bad(t);
  } else if (typeof (t as Desc)[0] === 'number') {
    return decStruct(d, t as Desc); // nested struct
  } else {
    const elem = (t as Desc)[0] as Desc;
    const n = d.varuint();
    const arr: unknown[] = new Array<unknown>(n);
    for (let i = 0; i < n; i++) arr[i] = decStruct(d, elem); // array of struct
    return arr;
  }
}

function decStruct(d: FieldDecoder, desc: Desc): Record<string, unknown> {
  const rc = desc[0] as number;
  const m = (desc.length - 1) >> 1;
  const o: Record<string, unknown> = {};
  for (let i = 0; i < rc; i++) o[desc[1 + 2 * i] as string] = dfield(d, desc[2 + 2 * i]);
  const flags = d.presence(m - rc);
  for (let i = rc; i < m; i++) {
    if (flags[i - rc]) o[desc[1 + 2 * i] as string] = dfield(d, desc[2 + 2 * i]);
  }
  return o;
}

// ── Special handlers (mirror of encode-walker) ──────────────────────────────────────────────────────

function decNrr(d: FieldDecoder): NrrNode {
  const p = d.presence(6);
  const n: NrrNode = {};
  if (p[0]) n.url = d.str();
  if (p[1]) n.src = d.str();
  if (p[2]) n.id = d.str();
  if (p[3]) n.name = d.str();
  if (p[4]) {
    const c = d.varuint();
    const a: Array<{ reason: string }> = new Array<{ reason: string }>(c);
    for (let i = 0; i < c; i++) a[i] = { reason: d.str() };
    n.reasons = a;
  }
  if (p[5]) {
    const c = d.varuint();
    const a: NrrNode[] = new Array<NrrNode>(c);
    for (let i = 0; i < c; i++) a[i] = decNrr(d);
    n.children = a;
  }
  return n;
}
function decNullableNrr(d: FieldDecoder): NrrNode | null {
  return d.u8() === 0 ? null : decNrr(d);
}

function decStreamMap(d: FieldDecoder, valueDesc: Desc): Record<string, unknown> {
  const n = d.varuint();
  const map: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const idx = d.u8();
    const id = STREAM_IDS[idx];
    const v = decStruct(d, valueDesc); // decode even if id is unknown, to advance the cursor
    if (id !== undefined) map[id] = v;
  }
  return map;
}

/** Profile slices — columnar (see `encSlices` for the layout rationale). */
function decSlices(d: FieldDecoder): Array<{ frameId: number; depth: number; start: number; duration: number }> {
  const n = d.varuint();
  const out = new Array<{ frameId: number; depth: number; start: number; duration: number }>(n);
  if (n === 0) return out;
  const frameId = new Array<number>(n);
  const depth = new Array<number>(n);
  const start = new Array<number>(n);
  const duration = new Array<number>(n);
  for (let i = 0; i < n; i++) frameId[i] = d.varuint();
  let prevDepth = 0;
  for (let i = 0; i < n; i++) {
    prevDepth += d.zigzag(); // un-zigzag (the shared primitive), then accumulate
    depth[i] = prevDepth;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = i === 0 ? d.varuint() : acc + d.varuint();
    start[i] = acc;
  }
  for (let i = 0; i < n; i++) duration[i] = d.varuint();
  for (let i = 0; i < n; i++) {
    out[i] = { frameId: frameId[i]!, depth: depth[i]!, start: fromTicks(start[i]!), duration: duration[i]! }; // start µs→ms via the shared grid; duration already ms
  }
  return out;
}

// ── Public entry points (consumed by unpack.ts) ─────────────────────────────────────────────────────

/**
 * Manifest: clock + the counted, self-describing per-stream record list + config (see encodeManifest
 * for the record frame). Tolerance rules, per FileFormat.md "Reading across versions":
 *   - a record whose streamIndex this build doesn't know → skipped whole (its status is unreadable only
 *     because the MODEL has nowhere to put an unknown stream);
 *   - a known record's frame fields (status/schemaVersion) are ALWAYS decoded — their encoding is
 *     frozen — and its tail (loss/provenance) is decoded strictly for same-or-older files, best-effort
 *     for newer ones (a changed tail layout must consume exactly its length to be believed);
 *   - a known stream the (older) writer had no record for is filled as `unsupported`/schemaVersion 0:
 *     that writer could not have captured it, and the model's TOTAL manifest must stay total.
 */
export function decodeManifest(d: FieldDecoder, fileFormatVersion: number): Manifest {
  const clock = decStruct(d, CLOCK);
  const streams: Record<string, unknown> = {};
  const count = d.varuint();
  for (let i = 0; i < count; i++) {
    const idx = d.u8();
    const status = d.str();
    const schemaVersion = d.varuint();
    const len = d.varuint();
    const tailBytes = d.r.bytes(len);
    const id = STREAM_IDS[idx];
    if (id === undefined) continue; // future stream — frame consumed, record skipped whole
    const entry: Record<string, unknown> = { status, schemaVersion };
    const tail = new FieldDecoder(new Reader(tailBytes), d.strings);
    if (fileFormatVersion <= FORMAT_VERSION) {
      // Same-or-older file: the tail layout is fully known — a mis-sized tail is corruption.
      Object.assign(entry, decStruct(tail, STREAM_MANIFEST_REST));
      if (!tail.r.atEnd) throw new RangeError(`corrupt .rcap: manifest record for "${id}" has trailing bytes`);
    } else {
      // Newer file: best-effort on the optional tail; the frame fields above are the guarantee. A
      // changed tail layout must consume exactly its length to be believed, else it is dropped.
      try {
        const rest = decStruct(tail, STREAM_MANIFEST_REST);
        if (tail.r.atEnd) Object.assign(entry, rest);
      } catch {
        // A newer tail layout this build can't parse — keep status/schemaVersion, drop the detail.
      }
    }
    streams[id] = entry;
  }
  // An older writer may not have known all of OUR streams; keep the model's manifest TOTAL with the
  // truthful fill: that writer could not have captured the stream (schemaVersion 0 = "predates it").
  for (const id of STREAM_IDS) {
    if (streams[id] === undefined) {
      streams[id] = { status: 'unsupported', schemaVersion: 0 } satisfies StreamManifestEntry;
    }
  }
  const config = decStruct(d, CONFIG);
  return { clock, streams, config } as unknown as Manifest;
}

export function decodeOverhead(d: FieldDecoder): OverheadReport {
  return decStruct(d, OVERHEAD) as unknown as OverheadReport;
}

/** Decode one stream's payload, fully descriptor-driven (STREAM_T is total, incl. navigation's NAV tag). */
export function decodeStream(d: FieldDecoder, id: StreamId): unknown {
  return dfield(d, STREAM_T[id]);
}
