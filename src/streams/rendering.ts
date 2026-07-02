import type { RelMs } from '../time.js';

/**
 * A reference to a live DOM element: a structural CSS path plus the element's structural attributes.
 * Everything here is AUTHORED identity (tag names, ids, class lists, `name` attributes) — never
 * element text content or user-entered values, so the default posture matches the `structural-only`
 * redaction vocabulary. All fields optional: a ref degrades to whatever was readable.
 */
export interface ElementRef {
  /** CSS-path selector (tag/id/class/nth-of-type). Never element text content. */
  selector?: string;
  /** Element localName (tag), e.g. 'img'. */
  tag?: string;
  /** The element's `id` content attribute ('' = none → absent). */
  id?: string;
  /** Class list, bounded to the first 8 classes (utility-class pages would otherwise bloat refs). */
  classes?: string[];
  /** The element's `name` content attribute (form fields, iframes), when present. */
  name?: string;
}

/** DOMRect snapshot — used for layout-shift source before/after rects. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A paint milestone. Chrome splits the instant into `paintTime` (raster) and `presentationTime`
 * (on-screen); both optional and kept when present. `startTime` is the reported entry time.
 */
export interface PaintTime {
  startTime: RelMs;
  paintTime?: RelMs;
  presentationTime?: RelMs;
}

export interface PaintStream {
  firstPaint?: PaintTime;
  firstContentfulPaint?: PaintTime;
}

/**
 * Largest Contentful Paint. `element` and `url` are LIVE attribution — the element identity can't
 * be recovered offline, so capture reads it eagerly. `renderTime` is absent for cross-origin
 * resources without Timing-Allow-Origin; `loadTime` then carries the usable timing.
 */
export interface LcpEntry {
  startTime: RelMs;
  size: number;
  renderTime?: RelMs;
  loadTime?: RelMs;
  paintTime?: RelMs;
  presentationTime?: RelMs;
  id?: string;
  url?: string;
  element?: ElementRef;
}

export interface LcpStream {
  /** The final (largest) candidate — what "LCP" means for metrics. */
  final?: LcpEntry;
  /** Earlier candidates in order, if retained; each supersedes the previous. */
  candidates?: LcpEntry[];
}

/** A single layout shift. `sources` (the nodes that moved) are live attribution. */
export interface LayoutShiftEntry {
  startTime: RelMs;
  value: number;
  hadRecentInput: boolean;
  lastInputTime?: RelMs;
  sources?: LayoutShiftSource[];
}

export interface LayoutShiftSource {
  node?: ElementRef;
  previousRect?: Rect;
  currentRect?: Rect;
}

/** Cumulative Layout Shift is derived in `analysis`; we keep the raw shifts (and their sources). */
export interface ClsStream {
  shifts: LayoutShiftEntry[];
}

/**
 * Element Timing (opt-in via the `elementtiming` attribute). Live element attribution.
 * Field set follows the spec IDL (https://w3c.github.io/element-timing/#sec-performance-element-timing
 * — including the entry `name`, the element `id`, `intersectionRect`, and the PaintTimingMixin pair),
 * grounded in the local fixture capture (see samples/) since public corpus pages set no
 * `elementtiming` attributes.
 */
export interface ElementTimingEntry {
  startTime: RelMs;
  /** The paint kind — 'image-paint' | 'text-paint' (spec-fixed vocabulary). */
  name?: string;
  /** The `elementtiming` content attribute value. */
  identifier?: string;
  /** The element's `id` content attribute ('' = none → absent; same rule as LCP `id`). */
  id?: string;
  url?: string;
  renderTime?: RelMs;
  loadTime?: RelMs;
  paintTime?: RelMs;
  presentationTime?: RelMs;
  naturalWidth?: number;
  naturalHeight?: number;
  /** The element's viewport-intersection rect at paint time (spec: intersection with the viewport). */
  intersectionRect?: Rect;
  element?: ElementRef;
}

export interface ElementTimingStream {
  elements: ElementTimingEntry[];
}
