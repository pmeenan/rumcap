import type { RelMs, DurationMs } from '../time.js';

/**
 * PerformanceResourceTiming, normalized. NavigationTiming is a strict superset of this exact field
 * set — confirmed against real Chrome 149 captures (see samples/) — so the
 * navigation entry extends it rather than redefining the phase timeline.
 *
 * Phase timestamps are RelMs on the page clock. A value the browser reports as 0-meaning-absent
 * (no redirect, no TLS handshake, no service worker) is modeled as OPTIONAL and omitted when it
 * didn't happen — `capture` maps 0 -> undefined so "didn't occur" stays distinct from "at t=0".
 */
export interface ResourceTimingEntry {
  /** Resource URL. PII-bearing -> subject to the redaction policy at pack time. */
  name: string;
  startTime: RelMs;
  duration: DurationMs;

  initiatorType: string;
  /** '' | 'cache' | 'navigational-prefetch' — empty means "no special delivery". */
  deliveryType?: string;
  nextHopProtocol?: string;
  renderBlockingStatus?: 'blocking' | 'non-blocking';
  contentType?: string;
  contentEncoding?: string;

  // Connection / redirect / worker phase boundaries — each optional, omitted when the phase
  // did not occur. (secureConnectionStart is absent for plaintext; redirect* for no redirect.)
  workerStart?: RelMs;
  // ServiceWorker static-routing timing/source fields (Resource Timing L3). The model uses the W3C
  // spec names. Chrome shipped the experimental `workerMatched/FinalSourceType` first (what our
  // Chrome-149 corpus still contains) and is deprecating them in favor of the spec
  // `workerMatched/FinalRouterSource` (verified against the W3C spec + the Blink intent-to-ship).
  // `capture` normalizes whichever spelling a browser emits onto these canonical fields. Empty/0 in
  // the corpus (no SW routing) -> modeled optional, omitted when absent.
  workerRouterEvaluationStart?: RelMs;
  workerCacheLookupStart?: RelMs;
  workerMatchedRouterSource?: string;
  workerFinalRouterSource?: string;
  redirectStart?: RelMs;
  redirectEnd?: RelMs;
  fetchStart?: RelMs;
  domainLookupStart?: RelMs;
  domainLookupEnd?: RelMs;
  connectStart?: RelMs;
  secureConnectionStart?: RelMs;
  connectEnd?: RelMs;
  requestStart?: RelMs;
  /** Early Hints (HTTP 103) interim response start, when one occurred. */
  firstInterimResponseStart?: RelMs;
  finalResponseHeadersStart?: RelMs;
  responseStart?: RelMs;
  responseEnd?: RelMs;

  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  /** HTTP status (0 for opaque cross-origin). Cheap error attribution (401/404/5xx). */
  responseStatus?: number;

  serverTiming?: ServerTimingEntry[];
}

export interface ServerTimingEntry {
  name: string;
  duration?: DurationMs;
  description?: string;
}

/**
 * bfcache not-restored reasons (PerformanceNavigationTiming.notRestoredReasons). A tree of frames:
 * each node carries its own blocking `reasons` (an array of `{ reason }`) plus its `url`/`src`/`id`/
 * `name`, and recurses into `children`. Shape follows the W3C spec — an earlier draft here wrongly
 * flattened `reasons` to a single string and omitted `url`. Still PROVISIONAL: the corpus only
 * exhibits `null` (page restorable), so validate against a real bfcache-blocked capture.
 */
export interface NotRestoredReasons {
  url?: string;
  src?: string;
  id?: string;
  name?: string;
  reasons?: NotRestoredReasonDetails[];
  children?: NotRestoredReasons[];
}

export interface NotRestoredReasonDetails {
  reason: string;
}

/**
 * PerformanceNavigationTiming. Extends the resource phase timeline with document-lifecycle
 * milestones and navigation metadata. There is exactly ONE per document — a buffered observer can
 * deliver it twice (provisional `duration:0` then complete); `capture` keeps the final value
 * (see the buffered-observer note in the samples README).
 */
export interface NavigationTimingEntry extends ResourceTimingEntry {
  type: 'navigate' | 'reload' | 'back_forward' | 'prerender';
  redirectCount: number;

  unloadEventStart?: RelMs;
  unloadEventEnd?: RelMs;
  domInteractive?: RelMs;
  domContentLoadedEventStart?: RelMs;
  domContentLoadedEventEnd?: RelMs;
  domComplete?: RelMs;
  loadEventStart?: RelMs;
  loadEventEnd?: RelMs;

  /** Prerender activation offset; absent for normal navigations. */
  activationStart?: RelMs;
  /** Restart time if the navigation was re-issued for Critical-CH, when it occurred. */
  criticalCHRestart?: RelMs;
  /** bfcache not-restored reasons tree — see NotRestoredReasons (provisional; corpus shows null). */
  notRestoredReasons?: NotRestoredReasons | null;
  /** How representative this navigation's timing is — see NavigationConfidence (provisional). */
  confidence?: NavigationConfidence;
}

/**
 * Navigation confidence. PROVISIONAL — Chrome 149 `toJSON` serialized this as `{}` (no usable
 * fields) across the whole corpus, so the members below are the spec-proposed shape, unvalidated.
 * Confirm against a populated capture before relying on them.
 */
export interface NavigationConfidence {
  value?: 'low' | 'high';
  randomizedTriggerRate?: number;
}
