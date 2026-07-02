import type { Manifest } from './manifest.js';
import type { Streams } from './streams/index.js';
import type { StreamId } from './registry.js';
import type { DurationMs } from './time.js';
import type { JsonValue } from './json.js';

/** Capture's self-measured overhead, written into the capture so its cost is observable in-band. */
export interface OverheadReport {
  mainThreadMs?: DurationMs;
  approxBytes?: number;
  byStream?: Partial<Record<StreamId, { mainThreadMs?: DurationMs; approxBytes?: number }>>;
  /** True if any budget forced truncation during this capture. */
  truncated?: boolean;
}

/**
 * The in-memory capture model — what a producer (the consumer's capture code / the streaming Encoder)
 * assembles and the codec packs/unpacks. `manifest` describes presence/clock/config; `streams` holds
 * whatever was actually collected; `overhead` is the capture's self-measurement. This interface is the
 * contract every producer and consumer reads or writes; the binary codec round-trips this model exactly
 * in shape — every field preserved, lossless to 1µs on timeline values (`RelMs`/`DurationMs`) and exact
 * on everything else (see `pack` for the two documented string/JSON normalizations).
 */
export interface Capture {
  formatVersion: number;
  manifest: Manifest;
  streams: Streams;
  overhead?: OverheadReport;
  /**
   * Arbitrary caller-supplied capture-level metadata (build id, experiment, release, page type, …).
   * Stored as its own skippable section using the same lossless JSON codec as User Timing `detail`.
   * Absent by default — costs zero bytes when unset. Added in FORMAT_VERSION 2.
   */
  metadata?: Record<string, JsonValue>;
}
