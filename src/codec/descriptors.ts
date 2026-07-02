/**
 * The descriptor tables — the SINGLE SHARED source both codec walkers read. Every struct in the model
 * is a compact data table (`Desc`); the encode walker (`encode-walker.ts`) interprets it to write and
 * the decode walker (`decode-walker.ts`) interprets it to read. Co-locating the *tables* here (not the
 * walkers) is what makes encode/decode drift impossible: there is exactly one definition of each
 * struct's field order/types, so the two sides cannot disagree even though they now live in separate
 * files. This is also why the on-page encode bundle stays small — a field name appears once in a table
 * rather than ~3× in explicit bitmap+guard+write code.
 *
 * A `Desc` is `[requiredCount, key, type, key, type, ...]`. The first `requiredCount` fields are written
 * unconditionally; the rest are optional and gated by a presence bitmap (an absent field costs one
 * bit). A field's `type` is one of:
 *   - a primitive code (number): S str · R relMs · D durMs · U varuint · F f64 · B bool · J json · SA str[]
 *   - a special-handler tag (string): the few shapes a flat table can't express (see the walkers)
 *   - a nested `Desc` (its `[0]` is a number) → a sub-struct
 *   - a one-element `[Desc]` (its `[0]` is an array) → an array of that sub-struct
 */

import { STREAM_IDS, type StreamId } from '../registry.js';

// StreamId -> its index in STREAM_IDS, for the compact stream-reference bytes (section headers, the
// per-stream config/overhead maps). Appending to STREAM_IDS keeps existing indices stable.
export const STREAM_INDEX: Record<StreamId, number> = Object.fromEntries(
  STREAM_IDS.map((id, i) => [id, i]),
) as Record<StreamId, number>;

// ── Field type codes (primitive writers) ───────────────────────────────────────────────────────────
export const S = 0; // interned string (incl. enum literals)
export const R = 1; // RelMs   — fixed-point µs
export const D = 2; // DurationMs — fixed-point µs
export const U = 3; // varuint — non-negative integer
export const F = 4; // f64     — EpochMs + true floats (rects, ratios, CLS value)
export const B = 5; // bool
export const J = 6; // JsonValue (User Timing detail, custom-event details)
export const SA = 7; // string[]

// Special-handler tags — the few shapes a flat table can't express (recursive tree, keyed maps,
// columnar delta, two-block concat). Strings so they're distinct from primitive codes (number) and
// descriptors (array).
export const NRR = 'n'; // navigation.notRestoredReasons: NotRestoredReasons | null (recursive, null-discriminated)
export const SMAP = 'm'; // CaptureConfig.streams: Partial<Record<StreamId, StreamConfig>>
export const OMAP = 'o'; // OverheadReport.byStream: Partial<Record<StreamId, {...}>>
export const PSLICES = 'q'; // SliceProfile.slices: columnar (frameId / depth / start-delta / duration)
export const NAV = 'v'; // navigation payload: RESOURCE block + NAV_EXTRA block, one object on both sides
export const RECTT = 'r'; // Rect: 4 stored values + spec-derived edges (see the walkers' rect handlers)

export type Desc = readonly unknown[];

/** NotRestoredReasons tree node — recursive, so it can't be a (TDZ-safe) self-referential descriptor;
 *  the walkers dispatch it to the NRR special handler. Its shape lives here so both halves share it. */
export interface NrrNode {
  url?: string;
  src?: string;
  id?: string;
  name?: string;
  reasons?: Array<{ reason: string }>;
  children?: NrrNode[];
}

/** An unknown type code/tag means a descriptor bug or a future tag this build can't handle — fail loud
 *  rather than fall through to a plausible-but-wrong (en/de)coder (the silent-corruption trap). */
export function bad(t: unknown): never {
  throw new Error('bad descriptor type ' + String(t));
}

// ── Descriptors (leaf → composite). Field order MUST match the wire output byte-for-byte. ───────────

const ELEMENT: Desc = [0, 'selector', S, 'tag', S, 'id', S, 'classes', SA, 'name', S];
// Rect is a special-handler tag (RECTT), not a flat Desc: all 8 model fields are required, but the
// wire stores only x/y/width/height when the edges match DOMRectReadOnly's definitions (top/left =
// min, bottom/right = max — https://drafts.fxtf.org/geometry/#dom-domrectreadonly-domrectreadonly-top)
// and rebuilds the rest with the same float ops, which is exact. See encRect/decRect.
const SERVER_TIMING: Desc = [1, 'name', S, 'duration', D, 'description', S];
const PAINT_TIME: Desc = [1, 'startTime', R, 'paintTime', R, 'presentationTime', R];
const LCP_ENTRY: Desc = [2, 'startTime', R, 'size', U, 'renderTime', R, 'loadTime', R, 'paintTime', R, 'presentationTime', R, 'id', S, 'url', S, 'element', ELEMENT];
const SHIFT_SOURCE: Desc = [0, 'node', ELEMENT, 'previousRect', RECTT, 'currentRect', RECTT];
const LAYOUT_SHIFT: Desc = [3, 'startTime', R, 'value', F, 'hadRecentInput', B, 'lastInputTime', R, 'sources', [SHIFT_SOURCE]];
const ELEMENT_TIMING: Desc = [1, 'startTime', R, 'name', S, 'identifier', S, 'id', S, 'url', S, 'renderTime', R, 'loadTime', R, 'paintTime', R, 'presentationTime', R, 'naturalWidth', U, 'naturalHeight', U, 'intersectionRect', RECTT, 'element', ELEMENT];
const INTERACTION: Desc = [3, 'name', S, 'startTime', R, 'duration', D, 'processingStart', R, 'processingEnd', R, 'interactionId', U, 'cancelable', B, 'firstInput', B, 'target', ELEMENT];
const LONGTASK_ATTR: Desc = [0, 'name', S, 'containerType', S, 'containerName', S, 'containerId', S, 'containerSrc', S];
const LONGTASK: Desc = [2, 'startTime', R, 'duration', D, 'name', S, 'attribution', [LONGTASK_ATTR]];
const LOAF_SCRIPT: Desc = [2, 'startTime', R, 'duration', D, 'invokerType', S, 'invoker', S, 'executionStart', R, 'forcedStyleAndLayoutDuration', D, 'pauseDuration', D, 'sourceURL', S, 'sourceFunctionName', S, 'sourceCharPosition', U, 'windowAttribution', S];
const LOAF_FRAME: Desc = [2, 'startTime', R, 'duration', D, 'renderStart', R, 'styleAndLayoutStart', R, 'firstUIEventTimestamp', R, 'blockingDuration', D, 'paintTime', R, 'presentationTime', R, 'scripts', [LOAF_SCRIPT]];
const MARK: Desc = [2, 'name', S, 'startTime', R, 'detail', J];
const MEASURE: Desc = [3, 'name', S, 'startTime', R, 'duration', D, 'detail', J];
const VIS_STATE: Desc = [2, 'state', S, 'startTime', R];
const ERROR_ENTRY: Desc = [2, 'startTime', R, 'kind', S, 'name', S, 'message', S, 'source', S, 'lineno', U, 'colno', U, 'stack', S];
const UA_BRAND: Desc = [2, 'brand', S, 'version', S];
const UA_DATA: Desc = [0, 'brands', [UA_BRAND], 'mobile', B, 'platform', S, 'platformVersion', S, 'architecture', S, 'bitness', S, 'model', S, 'fullVersionList', [UA_BRAND], 'formFactors', SA];
const CONNECTION: Desc = [0, 'effectiveType', S, 'rtt', U, 'downlink', F, 'saveData', B];
const PROFILE_FRAME: Desc = [1, 'name', S, 'resourceId', U, 'line', U, 'column', U];
const CONTEXT_CLOCK: Desc = [4, 'id', S, 'kind', S, 'timeOrigin', F, 'offsetToPage', D];
const LOSS_NOTE: Desc = [1, 'kind', S, 'at', R, 'droppedCount', U, 'note', S];
const PROVENANCE: Desc = [0, 'api', S, 'browser', S, 'engine', S];
// The detail TAIL of a manifest stream record. `status` and `schemaVersion` are NOT here: they live in
// the record's self-describing frame ([index][status][schemaVersion][byteLen][tail]) written by the
// walkers, so ANY reader — even one that can't parse this tail — always recovers which streams a writer
// knew, their status, and their schema version. See FileFormat.md "Reading across versions".
const STREAM_MANIFEST_REST: Desc = [0, 'loss', [LOSS_NOTE], 'provenance', PROVENANCE];
export const STREAM_CONFIG: Desc = [0, 'enabled', B, 'sampleRate', F];
const PROFILER_CONFIG: Desc = [0, 'enabled', B, 'sampleIntervalMs', D, 'maxBufferSize', U, 'trigger', S];
const BUDGETS: Desc = [0, 'maxBytes', U, 'maxMainThreadMs', F, 'maxResourceEntries', U];
const SAMPLING: Desc = [0, 'sessionSampleRate', F];
const REDACTION: Desc = [0, 'urls', S, 'selectors', S];
const CONFIDENCE: Desc = [0, 'value', S, 'randomizedTriggerRate', F];
export const OVERHEAD_ENTRY: Desc = [0, 'mainThreadMs', D, 'approxBytes', U];

// ResourceTiming: 4 required, then 28 optionals (exact order — the wire depends on it).
const RESOURCE: Desc = [
  4, 'name', S, 'startTime', R, 'duration', D, 'initiatorType', S,
  'deliveryType', S, 'nextHopProtocol', S, 'renderBlockingStatus', S, 'contentType', S, 'contentEncoding', S,
  'workerStart', R, 'workerRouterEvaluationStart', R, 'workerCacheLookupStart', R, 'workerMatchedRouterSource', S, 'workerFinalRouterSource', S,
  'redirectStart', R, 'redirectEnd', R, 'fetchStart', R, 'domainLookupStart', R, 'domainLookupEnd', R,
  'connectStart', R, 'secureConnectionStart', R, 'connectEnd', R, 'requestStart', R,
  'firstInterimResponseStart', R, 'finalResponseHeadersStart', R, 'responseStart', R, 'responseEnd', R,
  'transferSize', U, 'encodedBodySize', U, 'decodedBodySize', U, 'responseStatus', U, 'serverTiming', [SERVER_TIMING],
];
// Navigation EXTRA fields, written after the resource block (notRestoredReasons is null-discriminated).
const NAV_EXTRA: Desc = [
  2, 'type', S, 'redirectCount', U,
  'unloadEventStart', R, 'unloadEventEnd', R, 'domInteractive', R, 'domContentLoadedEventStart', R, 'domContentLoadedEventEnd', R,
  'domComplete', R, 'loadEventStart', R, 'loadEventEnd', R, 'activationStart', R, 'criticalCHRestart', R,
  'notRestoredReasons', NRR, 'confidence', CONFIDENCE,
];

// Navigation's two-block (resource + nav) framing is the NAV special-handler tag; the walkers need the
// two block descriptors to implement it.
export { RESOURCE, NAV_EXTRA };

// Custom events: measured spans, so `start`/`duration` use R/D (full 1µs precision) — NOT the columnar
// 1ms slice path (whose durations are sample-inferred). Fits the generic walker; no special handler.
const CUSTOM_EVENT: Desc = [3, 'name', S, 'start', R, 'duration', D, 'depth', U, 'details', J];
const CUSTOM_TRACK: Desc = [2, 'namespace', S, 'events', [CUSTOM_EVENT]];

export const CLOCK: Desc = [5, 'timeOrigin', F, 'captureStart', R, 'captureEnd', R, 'unit', S, 'base', S, 'precision', F, 'contexts', [CONTEXT_CLOCK]];
export const CONFIG: Desc = [1, 'version', U, 'streams', SMAP, 'profiler', PROFILER_CONFIG, 'budgets', BUDGETS, 'sampling', SAMPLING, 'redaction', REDACTION];
export const OVERHEAD: Desc = [0, 'mainThreadMs', D, 'approxBytes', U, 'byStream', OMAP, 'truncated', B];
export { STREAM_MANIFEST_REST };

// Per-stream payload types. Typed as a TOTAL Record (like STREAM_SCHEMA_VERSIONS) so adding a StreamId
// without a payload descriptor is a compile error, not a runtime TypeError at first pack/unpack.
export const STREAM_T: Record<StreamId, unknown> = {
  navigation: NAV,
  resources: [RESOURCE],
  paint: [0, 'firstPaint', PAINT_TIME, 'firstContentfulPaint', PAINT_TIME],
  lcp: [0, 'final', LCP_ENTRY, 'candidates', [LCP_ENTRY]],
  cls: [1, 'shifts', [LAYOUT_SHIFT]],
  interactions: [1, 'events', [INTERACTION]],
  longTasks: [1, 'tasks', [LONGTASK]],
  loaf: [1, 'frames', [LOAF_FRAME]],
  elementTiming: [1, 'elements', [ELEMENT_TIMING]],
  userTiming: [2, 'marks', [MARK], 'measures', [MEASURE]],
  visibility: [1, 'states', [VIS_STATE]],
  environment: [0, 'userAgent', S, 'userAgentData', UA_DATA, 'deviceMemory', F, 'hardwareConcurrency', U, 'connection', CONNECTION, 'viewportWidth', U, 'viewportHeight', U, 'screenWidth', U, 'screenHeight', U, 'devicePixelRatio', F, 'selfProfiler', S],
  profile: [4, 'frames', [PROFILE_FRAME], 'resources', SA, 'slices', PSLICES, 'droppedSamples', U, 'sampleIntervalMs', D],
  errors: [1, 'errors', [ERROR_ENTRY]],
  customEvents: [1, 'tracks', [CUSTOM_TRACK]],
};
