// The shared contract surface — the constants, brands, and types common to BOTH `rumcap/encode` and
// `rumcap/decode`, stated ONCE so the two public entries cannot drift. Everything re-exported here is
// pure shared data or types (the same modules both codec halves already read); the type-only exports
// are erased at build time, so pulling this into `rumcap/encode` drags in no decode code and vice versa.

// ── Runtime constants (shared data) ─────────────────────────────────────────────────────────────────
export { MAGIC, CODEC_VERSION, FILE_EXTENSION } from './codec/constants.js';
export { FORMAT_VERSION, STREAM_SCHEMA_VERSIONS } from './version.js';
export { STREAM_IDS, STREAM_STATUSES, ENTRY_TYPE_TO_STREAM } from './registry.js';
export { asRelMs, asDurationMs, asEpochMs } from './time.js';

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────
export type { SliceBuilderOptions } from './profile-slices.js';
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
