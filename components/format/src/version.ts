import type { StreamId } from './registry.js';

/**
 * Versioning. A single integer top-level format version plus per-stream schema versions. Readers
 * skip unknown streams/fields, so bumping one stream's schema never breaks an older reader, and
 * adding a browser signal is "add a stream", not "break the file".
 *
 * Pre-1.0 the wire format is a DRAFT: it may change without migration shims while we iterate on
 * the schema against real captures. The first frozen version will document migrations here.
 */
export const FORMAT_VERSION = 1;

/**
 * Per-stream schema versions. Typed as a total Record<StreamId, number> so that adding a StreamId
 * without versioning it is a compile error — the registry and the schema can't silently drift.
 */
export const STREAM_SCHEMA_VERSIONS: Record<StreamId, number> = {
  navigation: 1,
  resources: 1,
  paint: 1,
  lcp: 1,
  cls: 1,
  interactions: 1,
  longTasks: 1,
  loaf: 1,
  elementTiming: 1,
  userTiming: 1,
  visibility: 1,
  environment: 1,
  profile: 1,
  errors: 1,
};
