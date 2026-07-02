/**
 * The `samples → slices` transform: turn raw JS Self-Profiling output (per-sample interned stacks)
 * into the nested timed-slice (call-tree) wire model the codec stores. This is the canonical view over
 * the profile model, so every consumer (transcode, analysis) slices identically.
 *
 * WHY slices: a sampling profiler can't measure durations; it can only observe that a frame was on the
 * stack across a run of consecutive samples. We coalesce each contiguous run into one slice and keep
 * only runs that span **at least ~1 sample interval** (`duration >= 0.8 × interval`; the 0.8 tolerates
 * cadence jitter, which CPU throttling pushes down to ~8ms — verified on the corpus).
 * Anything shorter is below the sampling resolution — a single sample, a duplicate-timestamp cluster,
 * or a microsecond-spaced burst (Chrome emits these as a deep recursion unwinds; on cross-origin-
 * isolated pages they even tie into identical 5µs-grid timestamps) — i.e. not a slow main-thread block.
 * This is a responsiveness view, not CPU-time accounting (see docs/Plan.md). The floor is the actual
 * sample interval, not a separate knob. Durations are sample-INFERRED (±1 interval), never measured.
 *
 * `SliceBuilder` is INCREMENTAL: feed it raw `Profiler.stop()` chunks via `addChunk()` and it folds
 * each into an accumulating call-tree — interning frames/resources across chunks and stitching a run
 * that continues across a checkpoint. That is the capture→wire seam: the on-page driver stops/restarts
 * the profiler at safe (idle) checkpoints and folds each batch, so the heavy work is spread across the
 * session and the unload path only flushes the small remainder (no unload serialization cliff). The
 * profiler delivers samples only in a batch at `stop()`, so chunking is the only way to be incremental.
 */

import { asRelMs, asDurationMs } from './time.js';
import type { ProfilerTrace, ProfileFrame, SliceProfile, ProfileSlice } from './streams/profile.js';

/** A slice under construction. We prune by ELAPSED TIME — keep a run only if it spans ≥ ~1 sample
 *  interval (`end - start >= 0.8 × interval`; jitter-tolerant), not by sample count. Chrome emits microsecond-spaced bursts
 *  (and, on cross-origin-isolated pages, exact-duplicate timestamps) during deep-recursion unwinds, so
 *  a count rule would keep sub-resolution noise; a time floor drops it. `selfCount` = samples where
 *  this was the leaf, used only to tally dropped samples — never stored. */
interface BuildSlice {
  frameId: number;
  depth: number;
  start: number;
  end: number;
  selfCount: number;
}

export interface SliceBuilderOptions {
  /** The actual (clamped) sample interval; stored on the result as the inference granularity. */
  sampleIntervalMs?: number;
}

const US_PER_MS = 1000; // quantize timeline values to the format's 1µs grid (lossless vs ≤5µs browser res)
const quantize = (ms: number): number => Math.round(ms * US_PER_MS) / US_PER_MS;

// A gap between consecutive samples wider than this many intervals means the sampler missed samples (a
// delayed stop()/restart, a backgrounded page); open slices are closed rather than bridged across it.
// 1.5× clears normal cadence jitter (observed ≤~1.2× interval) but trips on any likely-skipped sample.
const GAP_INTERVALS = 1.5;

// The duration floor is a FRACTION of the nominal interval, not the full interval. Under CPU throttling
// the real sampler cadence drops to ~8–9ms (corpus: 22–43% of 6×-throttled inter-sample deltas land in
// [8,10)ms), so a strict `span >= interval` prunes genuine ≥2-sample runs spanning ~1 *actual* interval.
// 0.8 recovers them — the [5,8)ms band is near-empty on the corpus, so it needn't go lower — while still
// dropping microsecond recursion-burst leaves (span ≪ 8ms) and zero-span duplicate-timestamp runs.
const FLOOR_INTERVALS = 0.8;

/**
 * Incremental folder from raw profiler trace chunks to one `SliceProfile`. Reusable across one capture
 * session: `addChunk()` per `Profiler.stop()`, then `finish()` once at the end.
 */
export class SliceBuilder {
  #intervalMs: number | undefined; // mutable: lazily adopted from the first chunk if not given upfront
  #gapThreshold: number; // a sample more than this past the previous one closes open slices
  #prevT: number | undefined; // last sample timestamp seen, across chunks — for the gap check
  // Global interned tables (across all chunks).
  readonly #resources: string[] = [];
  readonly #resourceIndex = new Map<string, number>();
  readonly #frames: ProfileFrame[] = [];
  readonly #frameIndex = new Map<string, number>();
  // Open slices by depth, persisted across chunks so a run that spans a checkpoint keeps growing.
  #open: BuildSlice[] = [];
  readonly #done: BuildSlice[] = [];

  constructor(opts: SliceBuilderOptions = {}) {
    this.#intervalMs = opts.sampleIntervalMs;
    // Without a known interval we can't tell a missed-sample gap from normal spacing, so disable the
    // guard (Infinity) — same graceful degradation as the duration floor when the interval is unknown.
    this.#gapThreshold = opts.sampleIntervalMs !== undefined ? opts.sampleIntervalMs * GAP_INTERVALS : Infinity;
  }

  /** Fold one raw `Profiler.stop()` trace into the accumulating call-tree. */
  addChunk(trace: ProfilerTrace): void {
    // Adopt the interval from the trace if the caller didn't supply it at construction — so the floor
    // and gap guard work even when the builder was created before the runtime interval was known.
    if (this.#intervalMs === undefined && trace.sampleIntervalMs !== undefined) {
      this.#intervalMs = trace.sampleIntervalMs;
      this.#gapThreshold = trace.sampleIntervalMs * GAP_INTERVALS;
    }
    // This chunk's tables are local; map them onto the global interned tables.
    const resMap = trace.resources.map((url) => this.#internResource(url));
    const frameMap = trace.frames.map((f) => this.#internFrame(f, resMap));
    // Resolve a chunk-local stackId to a global root→leaf frameId chain (memoized per chunk).
    const chainCache = new Map<number, number[]>();
    const chainOf = (stackId: number | undefined): number[] => {
      if (stackId === undefined) return EMPTY;
      const cached = chainCache.get(stackId);
      if (cached !== undefined) return cached;
      const chain: number[] = [];
      const seen = new Set<number>(); // guard against a malformed cyclic parent chain
      let cur = stackId;
      for (;;) {
        if (seen.has(cur)) break;
        seen.add(cur);
        const node = trace.stacks[cur];
        if (node === undefined) break; // out-of-range id in a malformed trace — stop, don't fabricate
        chain.push(frameMap[node.frameId] as number);
        if (node.parentId === undefined) break; // reached the root
        cur = node.parentId;
      }
      chain.reverse();
      chainCache.set(stackId, chain);
      return chain;
    };
    for (const sample of trace.samples) this.#advance(chainOf(sample.stackId), sample.timestamp as number);
  }

  /** Close all open slices, prune single-sample runs, compact the tables, and emit the wire model. */
  finish(): SliceProfile {
    for (let k = this.#open.length - 1; k >= 0; k--) this.#done.push(this.#open[k] as BuildSlice);
    this.#open = [];

    // Floor: keep only runs that span at least ~1 sample interval (0.8× nominal — jitter-tolerant; see
    // FLOOR_INTERVALS). Anything shorter is below the sampling resolution — a single sample, a
    // duplicate-timestamp cluster, or a microsecond burst (a deep recursion unwinding) — not a "slow"
    // main-thread block. The floor is derived from the interval, never a separate knob. If the interval
    // is unknown, fall back to dropping only zero-span runs (`> 0`) so nothing degenerate slips through.
    const floor = this.#intervalMs !== undefined ? this.#intervalMs * FLOOR_INTERVALS : 0;
    const kept: BuildSlice[] = [];
    let droppedSamples = 0;
    for (const s of this.#done) {
      const span = s.end - s.start;
      if (span > 0 && span >= floor) kept.push(s);
      else droppedSamples += s.selfCount; // sub-interval run → its leaf samples lose attribution
    }
    // Pre-order: start ascending, then depth ascending. For properly nested slices this is exactly a
    // pre-order DFS (a parent shares or precedes its children's start and has the smaller depth), so the
    // decoder rebuilds the tree from depth alone — no parent id on the wire.
    kept.sort((a, b) => a.start - b.start || a.depth - b.depth);

    // Compact frames/resources to only what surviving slices reference (pruning drops many).
    const frameRemap = new Map<number, number>();
    const resourceRemap = new Map<number, number>();
    const frames: ProfileFrame[] = [];
    const resources: string[] = [];
    const slices: ProfileSlice[] = kept.map((s) => ({
      frameId: this.#remapFrame(s.frameId, frameRemap, frames, resourceRemap, resources),
      depth: s.depth,
      start: asRelMs(quantize(s.start)), // start is a real observed sample time → keep µs precision
      duration: asDurationMs(Math.round(s.end - s.start)), // inferred ±1 interval → 1ms grid (matches the codec)
    }));

    const out: SliceProfile = { frames, resources, slices, droppedSamples };
    if (this.#intervalMs !== undefined) out.sampleIntervalMs = asDurationMs(this.#intervalMs);
    return out;
  }

  #internResource(url: string): number {
    let id = this.#resourceIndex.get(url);
    if (id === undefined) {
      id = this.#resources.length;
      this.#resourceIndex.set(url, id);
      this.#resources.push(url);
    }
    return id;
  }

  #internFrame(f: ProfileFrame, resMap: number[]): number {
    const globalRes = f.resourceId !== undefined ? (resMap[f.resourceId] as number) : undefined;
    // Identity = name + resolved resource + position. Resolving the resource to a global id makes the
    // key chunk-independent, so the same function from different chunks interns to one frame.
    const key = `${f.name} ${globalRes ?? -1} ${f.line ?? -1} ${f.column ?? -1}`;
    let id = this.#frameIndex.get(key);
    if (id === undefined) {
      id = this.#frames.length;
      const nf: ProfileFrame = { name: f.name };
      if (globalRes !== undefined) nf.resourceId = globalRes;
      if (f.line !== undefined) nf.line = f.line;
      if (f.column !== undefined) nf.column = f.column;
      this.#frameIndex.set(key, id);
      this.#frames.push(nf);
    }
    return id;
  }

  #remapFrame(
    globalId: number,
    frameRemap: Map<number, number>,
    frames: ProfileFrame[],
    resourceRemap: Map<number, number>,
    resources: string[],
  ): number {
    const existing = frameRemap.get(globalId);
    if (existing !== undefined) return existing;
    const f = this.#frames[globalId] as ProfileFrame;
    const nf: ProfileFrame = { name: f.name };
    if (f.resourceId !== undefined) {
      let rid = resourceRemap.get(f.resourceId);
      if (rid === undefined) {
        rid = resources.length;
        resourceRemap.set(f.resourceId, rid);
        resources.push(this.#resources[f.resourceId] as string);
      }
      nf.resourceId = rid;
    }
    if (f.line !== undefined) nf.line = f.line;
    if (f.column !== undefined) nf.column = f.column;
    const id = frames.length;
    frameRemap.set(globalId, id);
    frames.push(nf);
    return id;
  }

  /** Fold one sample (its global root→leaf chain; empty = idle) into the open-slice stack. */
  #advance(chain: number[], t: number): void {
    const open = this.#open;
    // A gap wider than ~1 interval means the sampler missed samples between this one and the last (a
    // delayed stop()/restart, a backgrounded page, ...). We have no evidence the open frames stayed on
    // the stack across that unobserved gap, so close them rather than synthesize one slice spanning it
    // — a stack that merely reappears later must start a fresh slice. (Idle samples already break runs
    // this way; this also catches gaps where not even an idle sample was recorded.) Tracking prevT per
    // sample — not per chunk — keeps the output identical whether samples arrive together or split
    // across stop()/restart boundaries.
    if (this.#prevT !== undefined && t - this.#prevT > this.#gapThreshold) {
      for (let k = open.length - 1; k >= 0; k--) this.#done.push(open[k] as BuildSlice);
      open.length = 0;
    }
    this.#prevT = t;
    // Common prefix with the currently-open stack — these slices continue.
    let d = 0;
    while (d < open.length && d < chain.length && (open[d] as BuildSlice).frameId === chain[d]) d++;
    // Everything below the divergence point ended at the previous sample — close it (deepest first).
    for (let k = open.length - 1; k >= d; k--) this.#done.push(open[k] as BuildSlice);
    open.length = d;
    // Open the newly-entered frames.
    for (let k = d; k < chain.length; k++) {
      open.push({ frameId: chain[k] as number, depth: k, start: t, end: t, selfCount: 0 });
    }
    // Every frame on the stack is present at t, so its run extends to t; the leaf is executing.
    for (let k = 0; k < open.length; k++) (open[k] as BuildSlice).end = t;
    if (open.length > 0) (open[open.length - 1] as BuildSlice).selfCount++;
  }
}

const EMPTY: number[] = [];

/** One-shot convenience: fold one trace (or an ordered list of chunks) into a `SliceProfile`. */
export function samplesToSlices(
  trace: ProfilerTrace | readonly ProfilerTrace[],
  opts: SliceBuilderOptions = {},
): SliceProfile {
  const chunks = Array.isArray(trace) ? trace : [trace as ProfilerTrace];
  const interval = opts.sampleIntervalMs ?? chunks[0]?.sampleIntervalMs;
  const builder = new SliceBuilder(interval !== undefined ? { sampleIntervalMs: interval } : {});
  for (const chunk of chunks) builder.addChunk(chunk);
  return builder.finish();
}
