export type * from './resourcelike.js';
export type * from './rendering.js';
export type * from './interactivity.js';
export type * from './appsignals.js';
export type * from './environment.js';
export type * from './profile.js';
export type * from './customevents.js';

import type { NavigationTimingEntry, ResourceTimingEntry } from './resourcelike.js';
import type { PaintStream, LcpStream, ClsStream, ElementTimingStream } from './rendering.js';
import type { InteractionsStream, LongTasksStream, LoafStream } from './interactivity.js';
import type { UserTimingStream, VisibilityStream, ErrorsStream } from './appsignals.js';
import type { EnvironmentStream } from './environment.js';
import type { SliceProfile } from './profile.js';
import type { CustomEventsStream } from './customevents.js';

/**
 * The container of all (optional) streams. Every field is optional: absence is normal, and the
 * manifest records WHY each absent stream is missing. Never infer zero from absence.
 *
 * Field names here are the StreamIds in `registry.ts`; the two must stay in step.
 */
export interface Streams {
  navigation?: NavigationTimingEntry;
  resources?: ResourceTimingEntry[];
  paint?: PaintStream;
  lcp?: LcpStream;
  cls?: ClsStream;
  interactions?: InteractionsStream;
  longTasks?: LongTasksStream;
  loaf?: LoafStream;
  elementTiming?: ElementTimingStream;
  userTiming?: UserTimingStream;
  visibility?: VisibilityStream;
  environment?: EnvironmentStream;
  /** The wire model is the derived nested-slice form (see `profile-slices.ts`), not raw samples. */
  profile?: SliceProfile;
  errors?: ErrorsStream;
  /** App/library-instrumented named, timed, namespaced events (fed via the streaming Encoder). */
  customEvents?: CustomEventsStream;
}
