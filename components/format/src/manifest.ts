import type { EpochMs, RelMs, DurationMs } from './time.js';
import type { StreamId, StreamStatus } from './registry.js';
import type { CaptureConfig } from './config.js';

/**
 * Clock metadata — written before any stream so a reader can place every timestamp on one timeline.
 * `timeOrigin` is the page's epoch anchor (metadata); all stream timestamps are RelMs offsets from
 * it. Ordering uses the monotonic offsets only. `precision` records timer coarsening (e.g. when the
 * page is not cross-origin-isolated) so consumers don't over-trust resolution.
 */
export interface ClockMeta {
  timeOrigin: EpochMs;
  captureStart: RelMs;
  captureEnd: RelMs;
  unit: 'ms';
  base: 'timeOrigin';
  /** Reported timer precision/clamping in ms, when known. */
  precision?: number;
  /** Per-context (iframe/worker) clock mappings — empty until multi-context capture exists. */
  contexts?: ContextClock[];
}

/**
 * A non-page execution context (iframe/worker) with its own `timeOrigin`, mapped onto the page
 * clock through an explicit offset. Present only if a capture ever spans multiple contexts.
 */
export interface ContextClock {
  id: string;
  kind: 'iframe' | 'dedicated-worker' | 'shared-worker' | 'service-worker';
  timeOrigin: EpochMs;
  /** ms to add to this context's RelMs values to place them on the page timeline. */
  offsetToPage: DurationMs;
}

/** A loss/truncation note within a present stream — recorded, never silently dropped. */
export interface LossNote {
  kind: 'buffer-overflow' | 'sample-budget' | 'size-budget' | 'capped' | 'other';
  at?: RelMs;
  droppedCount?: number;
  note?: string;
}

/** Which API/browser produced a stream's values, for cross-source reconciliation. */
export interface Provenance {
  api?: string;
  browser?: string;
  engine?: string;
}

export interface StreamManifestEntry {
  status: StreamStatus;
  schemaVersion: number;
  loss?: LossNote[];
  provenance?: Provenance;
}

/**
 * The manifest: the heart of "robust to missing data". It declares the clock, the per-stream
 * status, and the capture-config that SHOULD have been attempted — so a reader can tell "not
 * collected" from "collected, found nothing".
 *
 * `streams` is TOTAL: every StreamId carries an explicit status (`unsupported` / `not-requested` /
 * `dropped` / `policy-blocked` / `present`). A missing key would be exactly the silent omission the
 * self-describing guarantee exists to prevent, so absence is never allowed to stand in for a reason.
 */
export interface Manifest {
  clock: ClockMeta;
  streams: Record<StreamId, StreamManifestEntry>;
  config: CaptureConfig;
}
