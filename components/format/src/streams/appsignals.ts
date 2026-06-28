import type { RelMs, DurationMs } from '../time.js';
import type { JsonValue } from '../json.js';

/**
 * User Timing. `detail` is arbitrary app-provided data and, like attribution, only exists LIVE
 * (PerformanceMark/Measure.detail is dropped by toJSON), so capture reads it eagerly when present.
 * It is typed as a bounded `JsonValue` so the codec can promise lossless pack/unpack: anything
 * non-JSON (functions, DOM nodes, cyclic refs) or over the size budget is dropped at pack time and
 * recorded as a LossNote, never silently mangled. This stream also carries explicit app/router
 * boundary marks — the framework-agnostic SPA signal we rely on while native soft-nav is experimental.
 */
export interface MarkEntry {
  name: string;
  startTime: RelMs;
  detail?: JsonValue;
}

export interface MeasureEntry {
  name: string;
  startTime: RelMs;
  duration: DurationMs;
  detail?: JsonValue;
}

export interface UserTimingStream {
  marks: MarkEntry[];
  measures: MeasureEntry[];
}

/** Page visibility transitions (`visibility-state` entries) — lifecycle context for the timeline. */
export interface VisibilityStateEntry {
  state: 'visible' | 'hidden';
  startTime: RelMs;
}

export interface VisibilityStream {
  states: VisibilityStateEntry[];
}

/**
 * JS errors and unhandled promise rejections. Not a PerformanceObserver source — capture hooks
 * window `error` / `unhandledrejection`. `message` and `stack` are PII-bearing -> redaction at
 * pack time. Timestamped on the page clock so errors line up with the rest of the timeline.
 */
export interface ErrorEntry {
  /** Offset on the page clock — named `startTime` for timeline consistency with the other streams. */
  startTime: RelMs;
  kind: 'error' | 'unhandledrejection';
  name?: string;
  message?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
}

export interface ErrorsStream {
  errors: ErrorEntry[];
}
