import type { RelMs, DurationMs } from '../time.js';
import type { JsonValue } from '../json.js';

/**
 * Custom event categories — a generic, profiler-like structure for a site or library to instrument
 * its OWN code: named, timed events with attached details, grouped into named timelines ("namespaces")
 * so an app and the libraries it uses can keep their spans on separate tracks. This is NOT sourced
 * from a browser PerformanceObserver; it is fed explicitly through the streaming `Encoder`
 * (`enc.timeline(namespace).begin/end/span(...)`), which derives `depth` from the call stack and
 * `duration` from the begin→end delta.
 *
 * Because namespaces are open-ended and user-chosen, they live in DATA (interned strings), never as
 * StreamIds — so this is ONE fixed stream (`customEvents`) that contains many namespaced tracks.
 *
 * CRITICAL — precision: unlike profile slices (whose durations are sample-INFERRED and stored on a 1ms
 * grid), custom-event `start`/`duration` are MEASURED from real begin/end times, so they keep full
 * 1µs precision through the normal `R`/`D` codec path. Do not "optimize" them onto the slice grid.
 */
export interface CustomEvent {
  /** Event name, interned. Repeats (e.g. a hot "render") are stored once. */
  name: string;
  /** Start on the page timeline (measured). */
  start: RelMs;
  /** Measured duration (end − start); 0 is a real value (an instantaneous event). */
  duration: DurationMs;
  /** Nesting depth within its track (0 = top level). Derived from the authoring stack; omitted on a
   *  flat track. Nesting is expressed by this explicit depth, never inferred from time containment. */
  depth?: number;
  /** Arbitrary JSON attached to the event (same lossless codec as User Timing `detail`). */
  details?: JsonValue;
}

/** One user-named timeline. `namespace` (e.g. `'react'`, `'router'`, `'my-app'`) is app/library-chosen. */
export interface CustomEventTrack {
  namespace: string;
  events: CustomEvent[];
}

export interface CustomEventsStream {
  tracks: CustomEventTrack[];
}
