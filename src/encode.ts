// `rumcap/encode` — the encode surface: pack a capture to `.rcap` bytes, plus the streaming Encoder,
// the profiler fold, and the shared constants/brands/types. Importing this entry pulls in NO decode
// code (no `unpack`, no `DecompressionStream`) — that is the point of the physical split, so the
// on-page encode path never ships the decoder. The decode side is `rumcap/decode`.

// ── Runtime (encode) ────────────────────────────────────────────────────────────────────────────────
export { pack } from './codec/pack.js';
// The canonical profiler transform: raw per-sample `Profiler.stop()` output → the nested-slice wire
// model. `SliceBuilder` folds incrementally (the capture→wire seam); `samplesToSlices` is one-shot.
export { SliceBuilder, samplesToSlices } from './profile-slices.js';
// The streaming Encoder ("rumcap instance"): feed events → stack-based custom-event timelines → finish().
export { Encoder, Timeline, Span } from './encoder.js';
export type { EncoderInit } from './encoder.js';
// Browser-entry integration: raw PerformanceObserver/error-event/navigator output → the model, plus
// `entrySink` (a ready-made observer callback feeding an Encoder). Pure and tree-shakeable — consumers
// that feed pre-normalized models ship none of it.
export {
  entrySink,
  environmentSnapshot,
  structuralSelector,
  normalizeResource,
  normalizeNavigation,
  normalizePaint,
  normalizeLcp,
  normalizeLayoutShift,
  normalizeInteraction,
  normalizeLongTask,
  normalizeLoaf,
  normalizeElementTiming,
  normalizeMark,
  normalizeMeasure,
  normalizeVisibility,
  normalizeErrorEvent,
  normalizeRejection,
} from './browser.js';
export type { RawEntry, EntrySinkInput } from './browser.js';

// ── The shared contract (constants + types; identical set on `rumcap/decode`) ──────────────────────
export * from './contract.js';
