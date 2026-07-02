import type { RelMs, DurationMs } from '../time.js';

/**
 * JS Self-Profiling (Chromium-only; requires the `Document-Policy: js-profiling` response header,
 * injected by the extension in v0 / by the capture-tool driver via CDP). TWO shapes live here:
 *
 *  1. `ProfilerTrace` — the RAW per-sample output of `Profiler.stop()` (interned frames/resources/
 *     stacks + per-sample `{timestamp, stackId}`). This is the CAPTURE-TIME / transform-INPUT model,
 *     and the shape of the API corpus under `samples/json`. It is NOT what the `.rcap` wire carries.
 *  2. `SliceProfile` — the WIRE model the codec stores: a nested timed-slice (call-tree) derived from
 *     the samples by `profile-slices.ts` (`SliceBuilder` / `samplesToSlices`).
 *
 * GROUNDED against real `Profiler.stop()` output — Chrome 149, all corpus pages carry a real trace
 * (see `samples/json/*`, normal + 6× CPU-throttled). VERIFIED platform facts (don't re-derive from
 * memory): `sampleInterval` is FLOORED at 10ms and quantized to multiples of 10 (a requested 2 → 10),
 * so on-thread resolution is ~10ms; idle samples (no `stackId`) are common (38–99% of samples) and
 * distinct from "absent stream"; stacks can be very deep (v0.app: avg 162, max 348 throttled), which
 * makes the interned `stacks` table the dominant cost — the reason the wire stores slices, not samples.
 * Under deep recursion the effective sample rate spikes into microsecond-spaced bursts (one frame per
 * ~5µs as a stack unwinds); on cross-origin-isolated pages (5µs timestamp grid) these tie into exact-
 * DUPLICATE timestamps — distinct moments quantized together, NOT same-instant captures.
 *
 * IMPLEMENTED (wire format — see `profile-slices.ts` + docs/Plan.md): the `.rcap` profile stream is a
 * nested timed-slice (call-tree) — each contiguous run that spans **at least ~1 sample interval** →
 * one slice; shorter runs (single samples, duplicate-timestamp clusters, the microsecond unwind
 * bursts) collapse to an aggregate `droppedSamples` count. The floor is 0.8× the interval — jitter-
 * tolerant, since CPU throttling drops the real cadence to ~8ms — not a knob. The fold runs on-page
 * incrementally at safe checkpoints (no unload cliff). Slice durations are
 * sample-INFERRED (±1 interval), NOT measured — never conflate them with measured LoAF/Event-Timing.
 * Frames are left UNSYMBOLICATED; `symbolication` resolves them later. (No FORMAT_VERSION bump yet.)
 */

// ── Raw per-sample trace: capture-time / transform INPUT (matches the W3C `ProfilerTrace` shape) ─────
export interface ProfilerTrace {
  /** The UA's ACTUAL (clamped) interval — Chrome floors this at 10ms. */
  sampleIntervalMs?: DurationMs;
  /** Interned tables — samples/stacks index into these. */
  frames: ProfileFrame[];
  resources: string[];
  stacks: ProfileStack[];
  samples: ProfileSample[];
}

export interface ProfileFrame {
  name: string;
  /** Index into `resources`. */
  resourceId?: number;
  line?: number;
  column?: number;
}

export interface ProfileStack {
  /** Index into `frames`. */
  frameId: number;
  /** Index into `stacks` (the caller); absent at the root of a stack. */
  parentId?: number;
}

export interface ProfileSample {
  timestamp: RelMs;
  /** Index into `stacks`; absent when the sample caught no JS on-stack (idle). */
  stackId?: number;
}

// ── Nested timed-slice: the WIRE model the codec stores ──────────────────────────────────────────────
export interface SliceProfile {
  /** The sample interval the slices were inferred at — records the inference granularity (±1). */
  sampleIntervalMs?: DurationMs;
  /** Interned tables — `slices` index into `frames`; frames index into `resources`. Compacted to only
   *  what surviving slices reference. */
  frames: ProfileFrame[];
  resources: string[];
  /** Pre-order (start asc, then depth asc). A slice's parent is the nearest preceding slice of
   *  `depth - 1` — so nesting is implicit and no parent id is stored. */
  slices: ProfileSlice[];
  /** Non-idle samples whose deepest frame's run fell below the ~1-interval floor (single samples,
   *  duplicate-timestamp clusters, microsecond bursts). Recorded (never silently lost) so a reader
   *  knows how much sub-interval transient time was cut. */
  droppedSamples: number;
}

export interface ProfileSlice {
  /** Index into `frames`. */
  frameId: number;
  /** Nesting depth (0 = root). Parent is the nearest preceding slice at `depth - 1`. */
  depth: number;
  /** Slice start on the page timeline (real observed sample time, µs-grid). */
  start: RelMs;
  /** Sample-INFERRED duration — NOT measured. Accurate only to ±1 interval, so stored on a **1ms
   *  grid** (the one timeline value the format keeps coarser than 1µs — sub-ms here would be noise). */
  duration: DurationMs;
}
