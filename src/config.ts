import type { StreamId } from './registry.js';
import type { DurationMs } from './time.js';

/**
 * The declarative capture-config: what the consumer's capture code should ATTEMPT. It travels in the
 * manifest so a reader can tell "not collected" from "not requested" — wherever the consumer sources
 * it from (hard-coded, remote, experiment-targeted), it must stay serializable and stable.
 */
export interface CaptureConfig {
  version: number;
  /** Per-stream enable/sampling. A stream absent from the map uses the implementation default. */
  streams?: Partial<Record<StreamId, StreamConfig>>;
  profiler?: ProfilerConfig;
  budgets?: Budgets;
  sampling?: SamplingConfig;
  redaction?: RedactionConfig;
}

export interface StreamConfig {
  enabled?: boolean;
  /** 0..1 fraction of eligible sessions for which this stream is collected. */
  sampleRate?: number;
}

export interface ProfilerConfig {
  enabled?: boolean;
  sampleIntervalMs?: DurationMs;
  maxBufferSize?: number;
  /** Always sample, randomly sample sessions, or arm only on an "interesting" trigger. */
  trigger?: 'always' | 'sampled' | 'interesting';
}

/**
 * Hard ceilings. Exceeding one degrades the offending stream to `dropped` (with a LossNote in the
 * manifest) rather than distorting the page — the budget protects the user, never the dataset.
 */
export interface Budgets {
  maxBytes?: number;
  maxMainThreadMs?: number;
  maxResourceEntries?: number;
}

export interface SamplingConfig {
  /** 0..1 fraction of sessions captured at all. */
  sessionSampleRate?: number;
}

/**
 * How PII-bearing values are reduced at pack time. This governs HOW MUCH of a *collected* value is
 * retained — independent of WHETHER a stream is collected (that is `streams[].enabled`). `'keep'`
 * means no redaction (retain the full value); it never means "collect nothing". Policy lives in
 * config so it travels with the capture.
 */
export interface RedactionConfig {
  urls?: 'keep' | 'path-only' | 'origin-only' | 'drop-query';
  selectors?: 'keep' | 'structural-only';
}
