/**
 * The stream registry: the canonical set of stream ids and how raw browser PerformanceObserver
 * entry types map onto them. `capture` uses this to route entries to streams; any consumer uses
 * it to enumerate streams. Keep this in lockstep with the per-stream model types in `streams/`
 * and with STREAM_SCHEMA_VERSIONS in `version.ts`.
 */

export const STREAM_IDS = [
  'navigation',
  'resources',
  'paint',
  'lcp',
  'cls',
  'interactions',
  'longTasks',
  'loaf',
  'elementTiming',
  'userTiming',
  'visibility',
  'environment',
  'profile',
  'errors',
] as const;

export type StreamId = (typeof STREAM_IDS)[number];

/**
 * Why a stream is present or, if not, why not. The core of "robust to missing data": a reader
 * distinguishes `unsupported` (browser lacks the API) from `not-requested` (config excluded it)
 * from `dropped` (overhead/sampling budget) from `policy-blocked` (e.g. missing Document-Policy).
 * `present` carries data; the rest carry a reason — absence is recorded, never silent.
 */
export const STREAM_STATUSES = ['present', 'unsupported', 'not-requested', 'dropped', 'policy-blocked'] as const;
export type StreamStatus = (typeof STREAM_STATUSES)[number];

/**
 * Raw `PerformanceEntry.entryType` -> StreamId. Only observer-sourced streams appear here;
 * `environment` (navigator), `profile` (Profiler API), and `errors` (window events) are not
 * PerformanceObserver entry types. Several entry types fold into one stream: `first-input` + `event`
 * -> interactions; `mark` + `measure` -> userTiming. `navigation` is a specialization of `resource`
 * but is modeled as its own stream (there is exactly one per document).
 */
export const ENTRY_TYPE_TO_STREAM: Readonly<Record<string, StreamId>> = {
  navigation: 'navigation',
  resource: 'resources',
  paint: 'paint',
  'largest-contentful-paint': 'lcp',
  'layout-shift': 'cls',
  'first-input': 'interactions',
  event: 'interactions',
  longtask: 'longTasks',
  'long-animation-frame': 'loaf',
  element: 'elementTiming',
  mark: 'userTiming',
  measure: 'userTiming',
  'visibility-state': 'visibility',
};
