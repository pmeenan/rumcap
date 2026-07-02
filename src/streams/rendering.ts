import type { RelMs } from '../time.js';

/** A reference to a live DOM element, captured as a structural CSS path (redaction-friendly). */
export interface ElementRef {
  /** CSS-path selector (tag/id/class/nth-of-type). Never element text content. */
  selector?: string;
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

/** Element Timing (opt-in via the `elementtiming` attribute). Live element attribution. */
export interface ElementTimingEntry {
  startTime: RelMs;
  identifier?: string;
  url?: string;
  renderTime?: RelMs;
  loadTime?: RelMs;
  naturalWidth?: number;
  naturalHeight?: number;
  element?: ElementRef;
}

export interface ElementTimingStream {
  elements: ElementTimingEntry[];
}
