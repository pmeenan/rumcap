import type { StreamId } from './registry.js';

/**
 * Versioning. A single integer top-level format version plus per-stream schema versions. Readers
 * skip unknown streams/fields, so bumping one stream's schema never breaks an older reader, and
 * adding a browser signal is "add a stream", not "break the file".
 *
 * Pre-1.0 the wire format is a DRAFT: it may change without migration shims while we iterate on
 * the schema against real captures. The first frozen version will document migrations here.
 *
 * v2 (draft) added capture-level `metadata` (a skippable section) and the `customEvents` stream.
 * v3 (draft) added structured element attribution (ElementRef tag/id/classes/name), the long-task
 * container `name`, and the element-timing spec completion (`name`/`id`/`intersectionRect` + the
 * PaintTimingMixin pair) — bumping the lcp/cls/interactions/longTasks/elementTiming stream schemas.
 */
export const FORMAT_VERSION = 3;

/**
 * Per-stream schema versions. Typed as a total Record<StreamId, number> so that adding a StreamId
 * without versioning it is a compile error — the registry and the schema can't silently drift.
 */
export const STREAM_SCHEMA_VERSIONS: Record<StreamId, number> = {
  navigation: 1,
  resources: 1,
  paint: 1,
  // v2: ElementRef gained tag/id/classes/name (payload-layout change everywhere a ref is embedded).
  lcp: 2,
  cls: 2,
  interactions: 2,
  // v2: + entry-level `name` (the container vocabulary).
  longTasks: 2,
  loaf: 1,
  // v2: + name/id/paintTime/presentationTime/intersectionRect (spec completion) and the ElementRef change.
  elementTiming: 2,
  userTiming: 1,
  visibility: 1,
  environment: 1,
  profile: 1,
  errors: 1,
  customEvents: 1,
};
