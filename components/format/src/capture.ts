import type { Manifest } from './manifest.js';
import type { Streams } from './streams/index.js';
import type { StreamId } from './registry.js';
import type { DurationMs } from './time.js';

/** Capture's self-measured overhead, written into the capture so its cost is observable in-band. */
export interface OverheadReport {
  mainThreadMs?: DurationMs;
  approxBytes?: number;
  byStream?: Partial<Record<StreamId, { mainThreadMs?: DurationMs; approxBytes?: number }>>;
  /** True if any budget forced truncation during this capture. */
  truncated?: boolean;
}

/**
 * The in-memory capture model — what `capture` produces and `format` packs/unpacks losslessly.
 * `manifest` describes presence/clock/config; `streams` holds whatever was actually collected;
 * `overhead` is capture's self-measurement. This interface is the contract every other component
 * reads or writes; the binary codec (next) round-trips exactly this shape.
 */
export interface Capture {
  formatVersion: number;
  manifest: Manifest;
  streams: Streams;
  overhead?: OverheadReport;
}
