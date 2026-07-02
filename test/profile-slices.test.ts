import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  samplesToSlices,
  SliceBuilder,
  pack,
  unpack,
  FORMAT_VERSION,
  STREAM_IDS,
  STREAM_SCHEMA_VERSIONS,
  asEpochMs,
  asRelMs,
  asDurationMs,
  type Capture,
  type StreamId,
  type StreamManifestEntry,
  type ProfilerTrace,
  type SliceProfile,
} from 'rumcap';

const rel = asRelMs;
const dur = asDurationMs;

// The diagram's call tree: A is on-stack throughout; B (with child C) runs first, then D. Four frames,
// four stacks (root→leaf via parentId), one sample every 10ms.
const FRAMES = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
const STACKS = [
  { frameId: 0 }, // 0: A
  { frameId: 1, parentId: 0 }, // 1: A → B
  { frameId: 2, parentId: 1 }, // 2: A → B → C
  { frameId: 3, parentId: 0 }, // 3: A → D
];
const trace = (stackIds: ReadonlyArray<number | undefined>): ProfilerTrace => ({
  sampleIntervalMs: dur(10),
  resources: [],
  frames: FRAMES.map((f) => ({ ...f })),
  stacks: STACKS.map((s) => ({ ...s })),
  samples: stackIds.map((stackId, i) =>
    stackId === undefined ? { timestamp: rel(i * 10) } : { timestamp: rel(i * 10), stackId },
  ),
});

describe('samplesToSlices — worked examples', () => {
  it('coalesces contiguous runs; a 3-sample D is kept as a sibling of B under A', () => {
    // t: 0 [A,B] · 10/20/30 [A,B,C] · 40 [A,B] · 50/60/70 [A,D]
    const out = samplesToSlices(trace([1, 2, 2, 2, 1, 3, 3, 3]));
    expect(out.slices).toEqual([
      { frameId: 0, depth: 0, start: 0, duration: 70 }, // A spans the whole window
      { frameId: 1, depth: 1, start: 0, duration: 40 }, // B (under A), 0..40
      { frameId: 2, depth: 2, start: 10, duration: 20 }, // C (under B), 10..30
      { frameId: 3, depth: 1, start: 50, duration: 20 }, // D (under A) — sibling of B, 50..70
    ]);
    expect(out.frames).toEqual([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]);
    expect(out.droppedSamples).toBe(0);
  });

  it('drops a single-sample run, tallies it, and compacts its now-unused frame', () => {
    // Same, but D appears once (t=50). Its run spans 1 sample → pruned; A keeps its true 50ms duration
    // (the pruned 10ms is NOT misattributed to A's self-time — that is what droppedSamples records).
    const out = samplesToSlices(trace([1, 2, 2, 2, 1, 3]));
    expect(out.slices).toEqual([
      { frameId: 0, depth: 0, start: 0, duration: 50 },
      { frameId: 1, depth: 1, start: 0, duration: 40 },
      { frameId: 2, depth: 2, start: 10, duration: 20 },
    ]);
    expect(out.frames).toEqual([{ name: 'A' }, { name: 'B' }, { name: 'C' }]); // D compacted out
    expect(out.droppedSamples).toBe(1);
  });

  it('drops a multi-sample child run shorter than one interval (a microsecond burst)', () => {
    // A is on-stack 0..30ms (kept). B is a child caught in a 4ms burst at 12..16 — below the 10ms
    // floor, so it's dropped even though it spans 3 samples; A keeps its full 30ms.
    const t: ProfilerTrace = {
      sampleIntervalMs: dur(10),
      resources: [],
      frames: [{ name: 'A' }, { name: 'B' }],
      stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }],
      samples: [
        { timestamp: rel(0), stackId: 0 },
        { timestamp: rel(10), stackId: 0 },
        { timestamp: rel(12), stackId: 1 }, // B burst (sub-interval)
        { timestamp: rel(14), stackId: 1 },
        { timestamp: rel(16), stackId: 1 },
        { timestamp: rel(20), stackId: 0 },
        { timestamp: rel(30), stackId: 0 },
      ],
    };
    const out = samplesToSlices(t);
    expect(out.slices).toEqual([{ frameId: 0, depth: 0, start: 0, duration: 30 }]);
    expect(out.frames).toEqual([{ name: 'A' }]); // B compacted out
    expect(out.droppedSamples).toBe(3); // the three B-leaf samples
  });

  it('drops a duplicate-timestamp cluster (zero span) and counts it in droppedSamples', () => {
    // Deep-recursion unwinds on cross-origin-isolated pages emit several samples at one instant. Three
    // samples of A all at t=100 span zero time → nothing kept, all three tallied as dropped.
    const t: ProfilerTrace = {
      sampleIntervalMs: dur(10), resources: [], frames: [{ name: 'A' }], stacks: [{ frameId: 0 }],
      samples: [
        { timestamp: rel(100), stackId: 0 },
        { timestamp: rel(100), stackId: 0 },
        { timestamp: rel(100), stackId: 0 },
      ],
    };
    const out = samplesToSlices(t);
    expect(out.slices).toEqual([]);
    expect(out.frames).toEqual([]);
    expect(out.droppedSamples).toBe(3);
  });

  it('keeps a run with an interior duplicate timestamp if it still spans the floor', () => {
    // A at 100, 100 (dup), 110 → spans 10ms ≥ floor, so the duplicate does not stop it being kept.
    const t: ProfilerTrace = {
      sampleIntervalMs: dur(10), resources: [], frames: [{ name: 'A' }], stacks: [{ frameId: 0 }],
      samples: [
        { timestamp: rel(100), stackId: 0 },
        { timestamp: rel(100), stackId: 0 },
        { timestamp: rel(110), stackId: 0 },
      ],
    };
    expect(samplesToSlices(t).slices).toEqual([{ frameId: 0, depth: 0, start: 100, duration: 10 }]);
  });

  it('an idle sample breaks a run into two slices (the thread yielded)', () => {
    // A runs, yields (idle), runs again → two separate A slices, not one bridged 40ms slice.
    const out = samplesToSlices(trace([0, 0, undefined, 0, 0]));
    expect(out.slices).toEqual([
      { frameId: 0, depth: 0, start: 0, duration: 10 },
      { frameId: 0, depth: 0, start: 30, duration: 10 },
    ]);
    expect(out.droppedSamples).toBe(0);
  });
});

describe('SliceBuilder — incremental folding (the capture→wire seam)', () => {
  it('stitches a run that continues across a stop()/restart boundary (separate per-chunk tables)', () => {
    // Two independent Profiler.stop() batches, each with its OWN interned tables, same function A→B
    // running across the gap. The builder must intern across chunks and bridge the open run.
    const chunkTables = {
      resources: [],
      frames: [{ name: 'A' }, { name: 'B' }],
      stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }],
    };
    const chunk1: ProfilerTrace = { ...chunkTables, samples: [{ timestamp: rel(0), stackId: 1 }, { timestamp: rel(10), stackId: 1 }] };
    const chunk2: ProfilerTrace = { ...chunkTables, samples: [{ timestamp: rel(20), stackId: 1 }, { timestamp: rel(30), stackId: 1 }] };
    const b = new SliceBuilder({ sampleIntervalMs: 10 });
    b.addChunk(chunk1);
    b.addChunk(chunk2);
    const out = b.finish();
    expect(out.slices).toEqual([
      { frameId: 0, depth: 0, start: 0, duration: 30 }, // A bridged across the boundary, 0..30
      { frameId: 1, depth: 1, start: 0, duration: 30 }, // B bridged too
    ]);
    expect(out.frames).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(out.sampleIntervalMs).toBe(10);
  });

  it('does NOT bridge a stack across a large stop()/restart gap (unobserved time)', () => {
    // Same stack A in two chunks, but ~1s of unobserved time between them (a delayed stop()/restart, a
    // backgrounded page). We never saw the thread during the gap, so A must become two separate slices
    // — not one 1010ms slice that over-claims the unobserved time.
    const tbl = { resources: [], frames: [{ name: 'A' }], stacks: [{ frameId: 0 }] };
    const c1: ProfilerTrace = { ...tbl, samples: [{ timestamp: rel(0), stackId: 0 }, { timestamp: rel(10), stackId: 0 }] };
    const c2: ProfilerTrace = { ...tbl, samples: [{ timestamp: rel(1000), stackId: 0 }, { timestamp: rel(1010), stackId: 0 }] };
    const b = new SliceBuilder({ sampleIntervalMs: 10 });
    b.addChunk(c1);
    b.addChunk(c2);
    expect(b.finish().slices).toEqual([
      { frameId: 0, depth: 0, start: 0, duration: 10 },
      { frameId: 0, depth: 0, start: 1000, duration: 10 },
    ]);
  });

  it('folding in chunks equals folding the whole trace at once', () => {
    const whole = trace([1, 2, 2, 2, 1, 3, 3, 3]);
    const a: ProfilerTrace = { ...whole, samples: whole.samples.slice(0, 4) };
    const b: ProfilerTrace = { ...whole, samples: whole.samples.slice(4) };
    expect(samplesToSlices([a, b])).toEqual(samplesToSlices(whole));
  });
});

// ── Real corpus: prove the capture→wire path end-to-end on actual Chrome captures (normal + 6×) ───────
const samplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'json');
const sampleFiles = readdirSync(samplesDir).filter((f) => f.startsWith('chrome-') && f.endsWith('.json'));

interface RawProfile {
  status?: string;
  actualSampleIntervalMs?: number;
  frames?: unknown;
  resources?: unknown;
  stacks?: unknown;
  samples?: unknown;
}
const loadTrace = (f: string): { trace: ProfilerTrace; interval: number } | null => {
  const p = (JSON.parse(readFileSync(join(samplesDir, f), 'utf8')) as { profile?: RawProfile }).profile;
  if (!p || p.status !== 'present') return null;
  return {
    trace: { frames: p.frames, resources: p.resources, stacks: p.stacks, samples: p.samples } as unknown as ProfilerTrace,
    interval: p.actualSampleIntervalMs ?? 10,
  };
};

/** Structural invariants the wire model and its decoder rely on. */
function assertWellFormed(sp: SliceProfile, interval: number): void {
  const refFrames = new Set<number>();
  let prevStart = -Infinity;
  const stackDepthOk: number[] = []; // running depth stack for the pre-order tree reconstruction
  for (const s of sp.slices) {
    expect(s.frameId).toBeGreaterThanOrEqual(0);
    expect(s.frameId).toBeLessThan(sp.frames.length);
    expect(s.duration).toBeGreaterThanOrEqual(interval * 0.8 - 1e-9); // floor: every kept slice spans ≥ ~1 interval (0.8×, jitter-tolerant)
    expect(s.start).toBeGreaterThanOrEqual(prevStart); // pre-order ⇒ non-decreasing start
    prevStart = s.start as number;
    expect(s.depth).toBeLessThanOrEqual(stackDepthOk.length); // no depth gap → parent exists
    stackDepthOk.length = s.depth;
    stackDepthOk.push(s.frameId);
    refFrames.add(s.frameId);
  }
  // Tables are compacted: every frame (and every resource) is referenced.
  expect(refFrames.size).toBe(sp.frames.length);
  const refResources = new Set<number>();
  for (const fr of sp.frames) if (fr.resourceId !== undefined) refResources.add(fr.resourceId);
  expect(refResources.size).toBe(sp.resources.length);
  expect(Number.isInteger(sp.droppedSamples)).toBe(true);
  expect(sp.droppedSamples).toBeGreaterThanOrEqual(0);
}

function wrap(profile: SliceProfile): Capture {
  const streams = {} as Record<StreamId, StreamManifestEntry>;
  for (const id of STREAM_IDS) streams[id] = { status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS[id] };
  streams.profile = { status: 'present', schemaVersion: STREAM_SCHEMA_VERSIONS.profile };
  return {
    formatVersion: FORMAT_VERSION,
    manifest: {
      clock: { timeOrigin: asEpochMs(1700000000000), captureStart: rel(0), captureEnd: rel(300000), unit: 'ms', base: 'timeOrigin' },
      streams,
      config: { version: 1 },
    },
    streams: { profile },
  };
}

describe('samplesToSlices — real Chrome corpus (normal + 6× throttled)', () => {
  it('found corpus captures with a profile stream', () => {
    expect(sampleFiles.length).toBeGreaterThan(0);
    expect(sampleFiles.some((f) => loadTrace(f) !== null)).toBe(true);
  });

  for (const f of sampleFiles) {
    const loaded = loadTrace(f);
    if (loaded === null) continue;
    const { trace: t, interval } = loaded;

    it(`${f}: transforms to a well-formed slice profile`, () => {
      const sp = samplesToSlices(t, { sampleIntervalMs: interval });
      assertWellFormed(sp, interval);
      expect(sp.sampleIntervalMs).toBe(interval);
    });

    it(`${f}: round-trips through the codec (capture → .rcap → back)`, async () => {
      const sp = samplesToSlices(t, { sampleIntervalMs: interval });
      const back = await unpack(await pack(wrap(sp)));
      expect(back.streams.profile).toEqual(sp);
    });

    it(`${f}: incremental fold (two chunks) equals one-shot`, () => {
      const half = Math.floor(t.samples.length / 2);
      const a: ProfilerTrace = { ...t, samples: t.samples.slice(0, half) };
      const b: ProfilerTrace = { ...t, samples: t.samples.slice(half) };
      expect(samplesToSlices([a, b], { sampleIntervalMs: interval })).toEqual(
        samplesToSlices(t, { sampleIntervalMs: interval }),
      );
    });
  }
});
