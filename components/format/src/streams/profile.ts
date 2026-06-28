import type { RelMs, DurationMs } from '../time.js';

/**
 * JS Self-Profiling output (Chromium-only; requires the `Document-Policy: js-profiling` response
 * header, injected by the extension in v0).
 *
 * PROVISIONAL — modeled from the W3C JS Self-Profiling spec shape, NOT yet validated against a real
 * capture: the sample corpus has no profiler stream (the header isn't set on third-party pages).
 * Per the project's "verify the platform; never invent a shape" guardrail, confirm these fields
 * against real `Profiler.stop()` output before relying on them. Frames are left UNSYMBOLICATED
 * here; `symbolication` resolves them later. The format is interned: stacks and samples reference
 * frames/stacks by index, which is also why it transcodes cheaply to Perfetto's sampled callstacks.
 */
export interface ProfileStream {
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
