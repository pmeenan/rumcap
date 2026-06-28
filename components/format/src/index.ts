// Public surface of @rum-profiler/format. Runtime values first, then the type-only contract.

export { FORMAT_VERSION, STREAM_SCHEMA_VERSIONS } from './version.js';
export { STREAM_IDS, STREAM_STATUSES, ENTRY_TYPE_TO_STREAM } from './registry.js';
export { asRelMs, asDurationMs, asEpochMs } from './time.js';

export type { StreamId, StreamStatus } from './registry.js';
export type { RelMs, DurationMs, EpochMs } from './time.js';
export type {
  Manifest,
  ClockMeta,
  ContextClock,
  LossNote,
  Provenance,
  StreamManifestEntry,
} from './manifest.js';
export type {
  CaptureConfig,
  StreamConfig,
  ProfilerConfig,
  Budgets,
  SamplingConfig,
  RedactionConfig,
} from './config.js';
export type { Capture, OverheadReport } from './capture.js';
export type { JsonValue } from './json.js';
export type * from './streams/index.js';
