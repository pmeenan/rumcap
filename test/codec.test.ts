import { describe, it, expect } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  pack,
  unpack,
  checkConsistency,
  MAGIC,
  CODEC_VERSION,
  FILE_EXTENSION,
  FORMAT_VERSION,
  STREAM_IDS,
  asRelMs,
  asDurationMs,
  type Capture,
  type StreamId,
} from 'rumcap';
import { fixtures, richChrome, minimalEmpty, profileHeavy } from './fixtures.js';

/** The uncompressed body (after the 6-byte cleartext header) — what the byte-goldens pin. */
const bodyOf = async (c: Capture): Promise<Uint8Array> => gunzipSync((await pack(c)).subarray(6));

// The Phase-0 exit criterion: capture -> pack -> unpack -> DEEP EQUALITY on the golden corpus,
// including the degraded/partial captures. pack/unpack are deterministic for a fixed input (nothing
// volatile is generated), so this is a full structural equality — no scrubbing required. (Scrubbing
// is for the *capture-vs-stored-golden* comparison a later phase will do, where timestamps differ
// run-to-run; it is not what a same-object round-trip needs.)
describe('codec round-trips the golden corpus losslessly', () => {
  for (const { name, capture } of fixtures) {
    it(`${name}: unpack(pack(c)) deep-equals c`, async () => {
      const bytes = await pack(capture);
      const back = await unpack(bytes);
      expect(back).toEqual(capture);
    });
  }
});

describe('file framing', () => {
  it('starts with the F5 52 55 4D magic, then gzip (1f 8b) after the cleartext header', async () => {
    const bytes = await pack(minimalEmpty);
    expect([...bytes.subarray(0, 4)]).toEqual([0xf5, 0x52, 0x55, 0x4d]);
    expect([...MAGIC]).toEqual([0xf5, 0x52, 0x55, 0x4d]);
    // header = 4 magic + 1 codecVersion + 1 formatVersion (both single-byte varints here)
    expect(bytes[4]).toBe(CODEC_VERSION);
    expect(bytes[5]).toBe(richChrome.formatVersion); // == FORMAT_VERSION
    expect(bytes[6]).toBe(0x1f);
    expect(bytes[7]).toBe(0x8b);
  });

  it('exposes the canonical extension', () => {
    expect(FILE_EXTENSION).toBe('.rcap');
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const bytes = await pack(minimalEmpty);
    const copy = bytes.slice(); // own its buffer, then hand over the ArrayBuffer
    const back = await unpack(copy.buffer);
    expect(back).toEqual(minimalEmpty);
  });
});

describe('determinism', () => {
  it('packs the same capture to identical bytes every time', async () => {
    const a = await pack(richChrome);
    const b = await pack(richChrome);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('corruption is rejected, not silently mis-decoded', () => {
  it('rejects a stream that does not start with the magic', async () => {
    const notOurs = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]); // a bare gzip header
    await expect(unpack(notOurs)).rejects.toThrow(/magic/i);
  });

  it('rejects an unknown codec version', async () => {
    const bytes = await pack(minimalEmpty);
    const tampered = bytes.slice();
    tampered[4] = CODEC_VERSION + 1; // bump the codec-version byte
    await expect(unpack(tampered)).rejects.toThrow(/codec version/i);
  });

  it('rejects a body that is not valid gzip', async () => {
    const bytes = new Uint8Array([0xf5, 0x52, 0x55, 0x4d, CODEC_VERSION, 1, 0x00, 0x01, 0x02, 0x03]);
    await expect(unpack(bytes)).rejects.toThrow();
  });

  it('rejects truncated capture bytes', async () => {
    const bytes = await pack(richChrome);
    await expect(unpack(bytes.subarray(0, bytes.length - 6))).rejects.toThrow();
  });

  it('throws on a capture missing a required field rather than encoding garbage', async () => {
    const broken = structuredClone(richChrome);
    // Drop a required field (navigation.name). The descriptor walker's required-field guard must
    // fail loud instead of silently writing "undefined" to the wire.
    delete (broken.streams.navigation as unknown as Record<string, unknown>).name;
    await expect(pack(broken)).rejects.toThrow(/required field/i);
  });
});

// These distinctions are the whole point of "unknown != zero" and the presence-bitmap design; assert
// them directly rather than trusting that `toEqual` happened to catch them inside the big fixtures.
describe('absent / empty / null are preserved distinctly', () => {
  it('keeps an empty array distinct from an absent one', async () => {
    const back = await unpack(await pack(richChrome));
    expect(back.streams.navigation!.serverTiming).toEqual([]); // present-but-empty
    expect(back.streams.errors).toEqual({ errors: [] });
    expect(back.streams.navigation!.workerStart).toBeUndefined(); // absent (0-phase normalized out)
  });

  it('keeps detail:null distinct from an absent detail', async () => {
    const back = await unpack(await pack(richChrome));
    const measures = back.streams.userTiming!.measures;
    const hydration = measures.find((m) => m.name === 'hydration')!;
    const contentVisible = measures.find((m) => m.name === 'content visible')!;
    expect('detail' in hydration).toBe(true);
    expect(hydration.detail).toBeNull();
    expect('detail' in contentVisible).toBe(false);
  });

  it('keeps the empty string distinct from an absent string', async () => {
    const back = await unpack(await pack(richChrome));
    expect(back.streams.navigation!.deliveryType).toBe(''); // '' is a real value
    const opaque = back.streams.resources!.find((r) => r.name.endsWith('pixel.gif'))!;
    expect(opaque.deliveryType).toBeUndefined(); // never set
  });

  it('round-trips a populated notRestoredReasons tree and a null one', async () => {
    const tree = (await unpack(await pack(fixtures.find((f) => f.name === 'multiContext')!.capture))).streams.navigation!.notRestoredReasons;
    expect(tree).not.toBeNull();
    expect(tree!.children![1]!.children![0]!.reasons![0]!.reason).toBe('broadcastchannel-message');
    const nullTree = (await unpack(await pack(richChrome))).streams.navigation!.notRestoredReasons;
    expect(nullTree).toBeNull();
  });
});

// FORMAT_VERSION 2 additions: capture-level metadata (a skippable section) and the customEvents stream
// (measured, namespaced, optionally-nested spans). Assert the distinctions the codec must not smear.
describe('capture metadata + custom events (FORMAT_VERSION 2)', () => {
  const customAndMeta = fixtures.find((f) => f.name === 'customAndMeta')!.capture;

  it('round-trips capture-level metadata (nested object, null and {} inside)', async () => {
    const back = await unpack(await pack(customAndMeta));
    expect(back.metadata).toEqual(customAndMeta.metadata);
  });

  it('omits the metadata key entirely when a capture has none (absent ≠ {})', async () => {
    const back = await unpack(await pack(richChrome));
    expect('metadata' in back).toBe(false);
  });

  it('derives nested depth and keeps measured (µs) durations for custom events', async () => {
    const back = await unpack(await pack(customAndMeta));
    const checkout = back.streams.customEvents!.tracks.find((t) => t.namespace === 'checkout')!;
    // depth:0 present stays distinct from depth absent (last event)
    expect(checkout.events.map((e) => e.depth)).toEqual([0, 1, 1, undefined]);
    const charge = checkout.events.find((e) => e.name === 'charge-card')!;
    expect(charge.duration).toBe(390.125); // measured sub-ms duration at full µs precision (not the 1ms slice grid)
    expect('details' in charge).toBe(true);
    expect(charge.details).toBeNull(); // details:null distinct from absent
    const bare = checkout.events.find((e) => e.name === 'no-detail-no-depth')!;
    expect('details' in bare).toBe(false);
    expect('depth' in bare).toBe(false);
  });

  it('keeps a present-but-empty track distinct from absent', async () => {
    const back = await unpack(await pack(customAndMeta));
    const empty = back.streams.customEvents!.tracks.find((t) => t.namespace === 'empty-ns')!;
    expect(empty.events).toEqual([]);
  });

  it('writes formatVersion 2 into the header', async () => {
    const bytes = await pack(customAndMeta);
    expect(bytes[5]).toBe(2);
    expect(customAndMeta.formatVersion).toBe(FORMAT_VERSION);
  });
});

describe('corpus exhaustiveness', () => {
  it('exercises every stream codec: each StreamId carries data in at least one fixture', () => {
    const withData = new Set<StreamId>();
    for (const { capture } of fixtures) {
      for (const id of STREAM_IDS) {
        if (capture.streams[id] !== undefined) withData.add(id);
      }
    }
    const missing = STREAM_IDS.filter((id) => !withData.has(id));
    expect(missing, `streams never round-tripped with data: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the decoded manifest TOTAL (every StreamId has an explicit status)', async () => {
    const back = await unpack(await pack(richChrome));
    expect(Object.keys(back.manifest.streams).sort()).toEqual([...STREAM_IDS].sort());
  });
});

describe('compactness', () => {
  // The contract claims smaller than *gzipped* JSON, not just raw JSON — interning + varints +
  // fixed-point µs timestamps must add value the generic gzip of a JSON blob can't. Assert it per
  // fixture so future wire bloat fails loudly rather than hiding behind a single broad check.
  for (const { name, capture } of fixtures) {
    it(`${name}: packs smaller than gzipped JSON`, async () => {
      const packed = await pack(capture);
      const gzippedJson = gzipSync(Buffer.from(JSON.stringify(capture)));
      expect(packed.length).toBeLessThan(gzippedJson.length);
    });
  }

  it('profileHeavy: the columnar slice codec stays under one packed byte per slice', async () => {
    // 2000 nested slices in pre-order. The generic per-struct shape (frameId+depth+start+duration +
    // presence) would be ~8 bytes/slice before gzip; the four contiguous columns must crush that.
    const packed = await pack(profileHeavy);
    const sliceCount = profileHeavy.streams.profile!.slices.length;
    expect(sliceCount).toBeGreaterThanOrEqual(2000);
    expect(packed.length).toBeLessThan(sliceCount); // < 1 byte/slice for the WHOLE capture
  });
});

// Codec v3 wire paths: the tick-scale prelude, R-value delta chains, columnar struct arrays, and the
// derived-rect encoding. Round-trip equality across the corpus is the main proof (wireStressV3 and
// coarseGrid live in the fixtures for exactly these paths); the checks here pin the wire-visible
// details a smearing bug could hide.
describe('codec v3 wire behaviors', () => {
  it('writes the measured tick scale into the body prelude (coarseGrid → exactly 100)', async () => {
    const coarse = fixtures.find((f) => f.name === 'coarseGrid')!.capture;
    expect((await bodyOf(coarse))[0]).toBe(100); // 12.3ms and 45.7ms pin gcd to exactly 100 (123 ⊥ 457)
    expect((await bodyOf(minimalEmpty))[0]).toBe(1); // µs-fine (fractional captureEnd) → no scaling
  });

  it('round-trips every rect path exactly: -0, floats, negative sizes, inconsistent fallback', async () => {
    const stress = fixtures.find((f) => f.name === 'wireStressV3')!.capture;
    const back = await unpack(await pack(stress));
    const shifts = back.streams.cls!.shifts;
    // Derived-int and derived-float rects (recomputed edges must be bit-exact).
    expect(shifts[0]!.sources![0]!.previousRect).toEqual({ x: 10, y: 20, width: 300, height: 40, top: 20, right: 310, bottom: 60, left: 10 });
    expect(shifts[0]!.sources![1]!.previousRect).toEqual({ x: 10.5, y: 20.25, width: 300.125, height: 40.75, top: 20.25, right: 310.625, bottom: 61, left: 10.5 });
    // -0 must keep its sign (Object.is, not ==): it rides the f64 path, never zigzag.
    const negZero = shifts[1]!.sources![0]!.currentRect!;
    expect(Object.is(negZero.x, -0)).toBe(true);
    expect(Object.is(negZero.left, -0)).toBe(true);
    // The hand-built inconsistent rect survives verbatim via the fallback.
    expect(shifts[1]!.sources![1]!.currentRect).toEqual({ x: 0, y: 0, width: 10, height: 10, top: 999, right: 1, bottom: 2, left: 3 });
  });

  // The exact wire layout, pinned. An INTENTIONAL wire change must update these goldens (and bump
  // CODEC_VERSION + FileFormat.md); an accidental byte drift fails here first. The uncompressed body
  // is asserted (not the gzip, whose bytes may vary across zlib builds).
  it('byte-golden: minimalEmpty packs to the exact v3 body', async () => {
    const body = await bodyOf(minimalEmpty);
    expect(Array.from(body)).toEqual(MINIMAL_EMPTY_BODY);
  });

  it('byte-golden: the columnar/rect/chain stress capture hashes to the pinned v3 body', async () => {
    const body = await bodyOf(fixtures.find((f) => f.name === 'wireStressV3')!.capture);
    expect(createHash('sha256').update(body).digest('hex')).toBe(WIRE_STRESS_BODY_SHA256);
  });
});

// Timeline timestamps are stored as fixed-point integer microseconds — a deliberate, documented
// precision reduction (browsers only expose 5µs at best). It is lossless for any ≤1µs-resolution
// value and idempotent thereafter; sub-µs float noise collapses onto the grid.
describe('timestamp precision (fixed-point microseconds)', () => {
  it('quantizes sub-microsecond noise onto the microsecond grid', async () => {
    const noisy = structuredClone(minimalEmpty);
    noisy.streams.paint = { firstContentfulPaint: { startTime: asRelMs(495.10000002384186) } };
    noisy.streams.longTasks = { tasks: [{ startTime: asRelMs(0), duration: asDurationMs(56.000000123) }] };
    const back = await unpack(await pack(noisy));
    expect(back.streams.paint!.firstContentfulPaint!.startTime).toBe(495.1);
    expect(back.streams.longTasks!.tasks[0]!.duration).toBe(56);
  });

  it('is exact (idempotent) for values already on the microsecond grid', async () => {
    const onGrid = structuredClone(minimalEmpty);
    onGrid.streams.paint = { firstContentfulPaint: { startTime: asRelMs(123.456) } }; // 3 decimals = µs
    const once = await unpack(await pack(onGrid));
    const twice = await unpack(await pack(once));
    expect(once.streams.paint!.firstContentfulPaint!.startTime).toBe(123.456);
    expect(twice).toEqual(once);
  });
});

// P2: the manifest's per-stream status and the actual stream payloads must not disagree silently,
// or "unknown != zero" is broken. The codec round-trips faithfully; this shared check is what tooling
// and tests use to catch an inconsistent capture.
describe('manifest/payload consistency', () => {
  for (const { name, capture } of fixtures) {
    it(`${name}: manifest status agrees with stream presence`, () => {
      expect(checkConsistency(capture)).toEqual([]);
    });
  }

  it('flags a stream marked present but carrying no data', () => {
    const broken = structuredClone(minimalEmpty);
    broken.manifest.streams.navigation.status = 'present'; // no navigation payload exists
    expect(checkConsistency(broken)).toContain('stream "navigation" is manifest-present but carries no data');
  });

  it('flags data attached to a non-present (e.g. dropped) stream', () => {
    const broken = structuredClone(richChrome);
    broken.manifest.streams.navigation.status = 'dropped'; // but richChrome has navigation data
    expect(checkConsistency(broken)).toContain(
      'stream "navigation" carries data but its manifest status is "dropped" (expected "present")',
    );
  });

  it('survives a round-trip with consistency intact', async () => {
    const back = await unpack(await pack(richChrome));
    expect(checkConsistency(back)).toEqual([]);
  });
});

// A small explicit check that the public type is what consumers import (compile-time coverage).
const _typecheck: (c: Capture) => Promise<Uint8Array> = pack;
void _typecheck;

// ── Byte-goldens (codec v3) ─────────────────────────────────────────────────────────────────────────
// Regenerate on an INTENTIONAL wire change: gunzip pack(fixture).subarray(6) — see bodyOf above.
// minimalEmpty, annotated: [tickScale=1][string table: 3 strings 'ms'/'timeOrigin'/'not-requested']
// [manifest: clock f64+chained rels+strs+presence, 15 self-describing records, config][no streams].
const MINIMAL_EMPTY_BODY: number[] = [
  1, 1, 29, 3, 2, 109, 115, 10, 116, 105, 109, 101, 79, 114, 105, 103, 105, 110, 13, 110, 111, 116,
  45, 114, 101, 113, 117, 101, 115, 116, 101, 100, 2, 91, 154, 33, 9, 223, 4, 241, 121, 66, 0, 0, 0,
  1, 0, 15, 0, 2, 1, 1, 0, 1, 2, 1, 1, 0, 2, 2, 1, 1, 0, 3, 2, 1, 1, 0, 4, 2, 1, 1, 0, 5, 2, 1, 1,
  0, 6, 2, 1, 1, 0, 7, 2, 1, 1, 0, 8, 2, 1, 1, 0, 9, 2, 1, 1, 0, 10, 2, 1, 1, 0, 11, 2, 1, 1, 0, 12,
  2, 1, 1, 0, 13, 2, 1, 1, 0, 14, 2, 1, 1, 0, 1, 0,
];
// wireStressV3 exercises columnar arrays (transposed presence), every rect path, negative chain
// deltas, and >2^32 varuints — 1192 body bytes, pinned by hash to keep this file readable.
const WIRE_STRESS_BODY_SHA256 = '11c6f68d6f32bc1182b3f84f0f1ec805876ea3a1de9168b5fa34288ce5b81621';
