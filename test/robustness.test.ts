/**
 * Hardening coverage for the review findings: cross-version tolerance of the manifest/stream framing,
 * duplicate-section rejection, the JSON.stringify normalization contract (incl. `__proto__` safety and
 * nested `undefined`), the U+FFFD lone-surrogate carve-out, Encoder post-finish guards, metadata copy
 * semantics, and `checkConsistency` robustness on rule-breaking captures.
 *
 * File-crafting here reaches into the codec internals (relative `../src` imports) on purpose: these
 * tests simulate OTHER writers — future/older format versions and corrupt bodies — that the public
 * `pack()` can never produce.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  pack,
  unpack,
  checkConsistency,
  Encoder,
  FORMAT_VERSION,
  STREAM_IDS,
  STREAM_SCHEMA_VERSIONS,
  asRelMs,
  asDurationMs,
  type Capture,
  type JsonValue,
  type StreamId,
  type StreamManifestEntry,
} from 'rumcap';
import { minimalEmpty } from './fixtures.js';
import { Writer, FieldEncoder, StringTable } from '../src/codec/field-encoder.js';
import { encodeStream } from '../src/codec/encode-walker.js';
import { STREAM_INDEX } from '../src/codec/descriptors.js';
import {
  MAGIC,
  CODEC_VERSION,
  SECTION_STRING_TABLE,
  SECTION_MANIFEST,
  SECTION_STREAM,
  SECTION_METADATA,
} from '../src/codec/constants.js';

// ── Hand-crafted file assembly (simulating foreign writers) ─────────────────────────────────────────

interface RawSection {
  tag: number;
  bytes: Uint8Array;
}

function writeSection(w: Writer, tag: number, payload: Uint8Array): void {
  w.u8(tag);
  w.varuint(payload.length);
  w.bytes(payload);
}

/** Assemble a complete `.rcap` file from raw sections. The string table is NOT added implicitly —
 *  pass it in `sections` (usually first) so duplicate/mis-ordered-table cases stay expressible. */
function assembleFile(formatVersion: number, sections: RawSection[]): Uint8Array {
  const body = new Writer();
  for (const s of sections) writeSection(body, s.tag, s.bytes);
  const out = new Writer();
  out.bytes(MAGIC as Uint8Array);
  out.varuint(CODEC_VERSION);
  out.varuint(formatVersion);
  out.bytes(gzipSync(body.finish()));
  return out.finish();
}

function tableSection(strings: StringTable): RawSection {
  const w = new Writer();
  strings.encode(w);
  return { tag: SECTION_STRING_TABLE, bytes: w.finish() };
}

interface CraftedRecord {
  idx: number;
  status: string;
  schemaVersion: number;
  /** Raw record-tail bytes. Default: one zero presence byte = loss/provenance absent. */
  tail?: Uint8Array;
}

/** A minimal valid MANIFEST section: clock (5 required fields, no optionals) + the given stream
 *  records + a minimal config — byte-compatible with what `encodeManifest` writes. */
function manifestSection(strings: StringTable, records: CraftedRecord[]): RawSection {
  const e = new FieldEncoder(strings);
  // clock: timeOrigin f64, captureStart/captureEnd rel, unit/base strings, then presence(2) = 0.
  e.f64(1_700_000_000_000);
  e.rel(asRelMs(0));
  e.rel(asRelMs(100));
  e.str('ms');
  e.str('timeOrigin');
  e.u8(0);
  e.varuint(records.length);
  for (const r of records) {
    e.u8(r.idx);
    e.str(r.status);
    e.varuint(r.schemaVersion);
    const tail = r.tail ?? new Uint8Array([0]);
    e.varuint(tail.length);
    e.w.bytes(tail);
  }
  // config: version=1, then presence(5) = 0.
  e.varuint(1);
  e.u8(0);
  return { tag: SECTION_MANIFEST, bytes: e.w.finish() };
}

/** All streams this build knows, as plain records (status/version as the current writer would emit). */
function knownRecords(): CraftedRecord[] {
  return STREAM_IDS.map((id) => ({
    idx: STREAM_INDEX[id],
    status: 'not-requested',
    schemaVersion: STREAM_SCHEMA_VERSIONS[id],
  }));
}

function visibilitySection(strings: StringTable): RawSection {
  const e = new FieldEncoder(strings);
  e.u8(STREAM_INDEX.visibility);
  encodeStream(e, 'visibility', { states: [{ state: 'visible', startTime: asRelMs(0) }] });
  return { tag: SECTION_STREAM, bytes: e.w.finish() };
}

// ── Reading across versions ─────────────────────────────────────────────────────────────────────────

describe('reading files from newer writers (pull what you know)', () => {
  it('skips unknown manifest records, record-tail extensions, unknown streams, and unknown sections', async () => {
    const strings = new StringTable();
    const records = knownRecords();
    records[STREAM_INDEX.visibility] = { ...records[STREAM_INDEX.visibility]!, status: 'present' };
    // A known record whose tail a "newer format" extended: our REST parse (one presence byte) does not
    // consume it fully, so the detail is dropped and the frame fields survive.
    records[STREAM_INDEX.cls] = { ...records[STREAM_INDEX.cls]!, tail: new Uint8Array([0, 0xaa, 0xbb]) };
    // A record for a stream index this build has never heard of.
    records.push({ idx: STREAM_IDS.length, status: 'present', schemaVersion: 1 });

    const vis = visibilitySection(strings);
    const unknownStream: RawSection = { tag: SECTION_STREAM, bytes: new Uint8Array([STREAM_IDS.length, 1, 2, 3]) };
    const unknownSection: RawSection = { tag: 9, bytes: new Uint8Array([0xde, 0xad]) };
    const manifest = manifestSection(strings, records);

    const bytes = assembleFile(FORMAT_VERSION + 1, [tableSection(strings), manifest, vis, unknownStream, unknownSection]);
    const back = await unpack(bytes);

    expect(back.formatVersion).toBe(FORMAT_VERSION + 1);
    // The streams we know decoded; the unknown stream/section left no trace and no error.
    expect(back.streams.visibility).toEqual({ states: [{ state: 'visible', startTime: 0 }] });
    expect(Object.keys(back.manifest.streams).sort()).toEqual([...STREAM_IDS].sort());
    // The extended-tail record kept its guaranteed frame fields and dropped only the unparsable detail.
    expect(back.manifest.streams.cls).toEqual({ status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS.cls });
  });

  it('skips a stream payload written with a newer per-stream schema, and checkConsistency explains it', async () => {
    const strings = new StringTable();
    const records = knownRecords();
    records[STREAM_INDEX.visibility] = {
      idx: STREAM_INDEX.visibility,
      status: 'present',
      schemaVersion: STREAM_SCHEMA_VERSIONS.visibility + 1,
    };
    // The payload bytes are valid for TODAY's layout, but the reader must not even try: the manifest
    // says the layout is newer than this build parses. (Sections are built BEFORE the table section —
    // interning happens as they encode, and the table must serialize last, like pack() does.)
    const manifest = manifestSection(strings, records);
    const vis = visibilitySection(strings);
    const bytes = assembleFile(FORMAT_VERSION, [tableSection(strings), manifest, vis]);
    const back = await unpack(bytes);

    expect(back.streams.visibility).toBeUndefined();
    expect(back.manifest.streams.visibility.schemaVersion).toBe(STREAM_SCHEMA_VERSIONS.visibility + 1);
    expect(checkConsistency(back).some((i) => i.includes('skipped on decode'))).toBe(true);
  });
});

describe('reading files from older writers', () => {
  it('fills streams the writer predates as unsupported/schemaVersion 0, keeping the manifest total', async () => {
    const strings = new StringTable();
    // An "older" writer that knew every stream except the last one (customEvents). Build the manifest
    // before serializing the table — interning happens during section encode.
    const records = knownRecords().filter((r) => r.idx !== STREAM_INDEX.customEvents);
    const manifest = manifestSection(strings, records);
    const bytes = assembleFile(1, [tableSection(strings), manifest]);
    const back = await unpack(bytes);

    expect(back.manifest.streams.customEvents).toEqual({ status: 'unsupported', schemaVersion: 0 });
    expect(Object.keys(back.manifest.streams).sort()).toEqual([...STREAM_IDS].sort());
  });
});

describe('corruption stays loud under the tolerant framing', () => {
  it('rejects a same-version manifest record with trailing tail bytes', async () => {
    const strings = new StringTable();
    const records = knownRecords();
    records[STREAM_INDEX.cls] = { ...records[STREAM_INDEX.cls]!, tail: new Uint8Array([0, 0xaa]) };
    const manifest = manifestSection(strings, records); // built before the table — interning order
    const bytes = assembleFile(FORMAT_VERSION, [tableSection(strings), manifest]);
    await expect(unpack(bytes)).rejects.toThrow(/trailing bytes/);
  });

  it('rejects duplicate string-table / manifest / metadata / stream sections', async () => {
    const strings = new StringTable();
    const manifest = manifestSection(strings, knownRecords());
    const vis = visibilitySection(strings);
    const metaEnc = new FieldEncoder(strings);
    // JSON object with zero keys: tag 6 + varuint 0.
    metaEnc.u8(6);
    metaEnc.varuint(0);
    const meta: RawSection = { tag: SECTION_METADATA, bytes: metaEnc.w.finish() };
    const table = tableSection(strings);

    await expect(unpack(assembleFile(FORMAT_VERSION, [table, table, manifest]))).rejects.toThrow(
      /duplicate string-table/,
    );
    await expect(unpack(assembleFile(FORMAT_VERSION, [table, manifest, manifest]))).rejects.toThrow(
      /duplicate manifest/,
    );
    await expect(unpack(assembleFile(FORMAT_VERSION, [table, manifest, meta, meta]))).rejects.toThrow(
      /duplicate metadata/,
    );
    await expect(unpack(assembleFile(FORMAT_VERSION, [table, manifest, vis, vis]))).rejects.toThrow(
      /duplicate section for stream "visibility"/,
    );
  });

  it('rejects a stream section that precedes the manifest', async () => {
    const strings = new StringTable();
    const vis = visibilitySection(strings);
    const manifest = manifestSection(strings, knownRecords());
    await expect(unpack(assembleFile(FORMAT_VERSION, [tableSection(strings), vis, manifest]))).rejects.toThrow(
      /precedes the manifest/,
    );
  });
});

// ── JsonValue contract ──────────────────────────────────────────────────────────────────────────────

function withMetadata(meta: Record<string, JsonValue>): Capture {
  const c = structuredClone(minimalEmpty);
  c.metadata = meta;
  return c;
}

describe('JsonValue payloads', () => {
  it('round-trips an own __proto__ key without touching the prototype (no pollution)', async () => {
    const meta = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, JsonValue>;
    expect(Object.keys(meta)).toContain('__proto__'); // JSON.parse makes it an OWN property
    const back = await unpack(await pack(withMetadata(meta)));
    const decoded = back.metadata!;
    expect(Object.keys(decoded)).toContain('__proto__');
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect((decoded as { polluted?: unknown }).polluted).toBeUndefined();
    expect(decoded).toEqual(meta);
  });

  it('normalizes with JSON.stringify semantics: toJSON, undefined, non-finite numbers, bigint', async () => {
    // Deliberately NOT JsonValue-shaped — this is exactly what real pages hand a capture (structured
    // clone preserves undefined-valued properties in mark detail).
    const dirty = {
      a: undefined,
      arr: [1, undefined, 2],
      when: new Date(0),
      n: NaN,
      inf: Infinity,
      fn: () => 1,
      big: 10n,
    } as unknown as Record<string, JsonValue>;
    const back = await unpack(await pack(withMetadata(dirty)));
    expect(back.metadata).toEqual({
      arr: [1, null, 2],
      when: '1970-01-01T00:00:00.000Z',
      n: null,
      inf: null,
      big: null,
    });
  });
});

describe('string carve-out (documented normalization)', () => {
  it('normalizes a lone surrogate to U+FFFD and keeps well-formed strings exact', async () => {
    const c = structuredClone(minimalEmpty);
    c.manifest.streams.userTiming = { status: 'present', schemaVersion: STREAM_SCHEMA_VERSIONS.userTiming };
    c.streams.userTiming = {
      marks: [
        { name: 'a\uD800b', startTime: asRelMs(1) },
        { name: 'ok-\u{1F600}', startTime: asRelMs(2) },
      ],
      measures: [],
    };
    const back = await unpack(await pack(c));
    expect(back.streams.userTiming!.marks[0]!.name).toBe('a�b');
    expect(back.streams.userTiming!.marks[1]!.name).toBe('ok-\u{1F600}');
  });
});

// ── Encoder contract ────────────────────────────────────────────────────────────────────────────────

describe('Encoder post-finish and metadata semantics', () => {
  it('a held Timeline throws on any feed after finish()', async () => {
    const enc = new Encoder({ now: () => asRelMs(0) });
    const tl = enc.timeline('app');
    await enc.finish();
    expect(() => tl.instant('late')).toThrow(/already finished/);
    expect(() => tl.begin('late')).toThrow(/already finished/);
    expect(() => tl.event({ name: 'late', start: asRelMs(1), duration: asDurationMs(0) })).toThrow(
      /already finished/,
    );
    expect(() => enc.timeline('other')).toThrow(/already finished/);
  });

  it('a held Span force-ended by finish() stays a documented double-end no-op', async () => {
    const enc = new Encoder({ now: () => asRelMs(0) });
    const span = enc.timeline('app').begin('work');
    await enc.finish(); // _finalize force-ends the open span
    expect(() => span.end()).not.toThrow();
  });

  it('copies metadata: putMetadata never mutates the caller object or a sibling Encoder', async () => {
    const base: Record<string, JsonValue> = { app: 'x' };
    const e1 = new Encoder({ now: () => asRelMs(0), metadata: base });
    const e2 = new Encoder({ now: () => asRelMs(0), metadata: base });
    e1.putMetadata('variant', 'A');
    expect(base).toEqual({ app: 'x' });
    const back2 = await unpack(await e2.finish());
    expect(back2.metadata).toEqual({ app: 'x' });
    const back1 = await unpack(await e1.finish());
    expect(back1.metadata).toEqual({ app: 'x', variant: 'A' });
  });
});

// ── checkConsistency robustness ─────────────────────────────────────────────────────────────────────

describe('checkConsistency on rule-breaking captures', () => {
  it('reports (not crashes on) a missing manifest record', () => {
    const c = structuredClone(minimalEmpty);
    delete (c.manifest.streams as Partial<Record<StreamId, StreamManifestEntry>>).cls;
    const issues = checkConsistency(c);
    expect(issues.some((i) => i.includes('"cls"') && i.includes('no manifest record'))).toBe(true);
  });

  it('surfaces an unknown status string (a newer writer) as an issue', () => {
    const c = structuredClone(minimalEmpty);
    (c.manifest.streams.cls as { status: string }).status = 'weird-new-status';
    const issues = checkConsistency(c);
    expect(issues.some((i) => i.includes('unknown manifest status "weird-new-status"'))).toBe(true);
  });
});
