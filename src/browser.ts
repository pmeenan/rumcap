/**
 * Browser-entry integration — the "plug the browser straight in" surface. Pure, tree-shakeable
 * normalizers from raw Web Performance API output onto the rumcap model, plus `entrySink()` (a
 * ready-made `PerformanceObserver` callback that feeds an `Encoder`) and `environmentSnapshot()`.
 *
 * WHY THIS LIVES IN THE LIBRARY: the model is spec-canonical and sentinel-free, but real browser
 * output is neither — it reports "didn't happen" as `0`/`''`/`-1` and still ships experimental field
 * spellings. Mapping one onto the other is knowledge about the FORMAT, not about any one capture
 * pipeline, and hand-rolled copies get it subtly wrong (a kept `-1` would even make `pack` throw on
 * its non-negative varuint). So the mapping is written once, here, grounded against the real Chrome
 * captures under `samples/` and covered by the corpus tests.
 *
 * Inputs are accepted STRUCTURALLY — a live `PerformanceEntry` or its `toJSON()` form (so stored raw
 * entries can be replayed in Node) — and every field read is runtime-guarded: garbage in a field
 * degrades to "absent", never to a crash inside a user's page. Live-only attribution (LCP `element`,
 * layout-shift `sources[].node`, interaction `target`) is read when present and skipped otherwise.
 *
 * On-page cost: this module is imported by nothing else in the library (the `Encoder` dependency is
 * type-only), so consumers who feed pre-normalized models tree-shake all of it away.
 *
 * Sentinel policy (the rules the model documents, applied in one place):
 *   - PHASE timestamps where the platform uses 0 for "did not occur / withheld" (resource/navigation
 *     phases, LCP + element-timing renderTime/loadTime, paint + LoAF milestones) -> absent.
 *   - DURATIONS keep 0 — a measured zero is real (blockingDuration, server-timing duration, ...).
 *   - STRINGS where the spec's default/'none' is `''` (sourceURL, invoker, container*, nextHopProtocol,
 *     LCP id/url, ...) -> absent. The one deliberate exception: `deliveryType`, whose `''` is a
 *     spec-defined vocabulary value ("no special delivery") the model keeps.
 *   - COUNTS/SIZES keep 0 (transferSize 0 is a real cached/opaque answer; responseStatus 0 is the
 *     spec's documented opaque-response value and the model keeps it).
 */

import { asRelMs, asDurationMs, type RelMs, type DurationMs } from './time.js';
import { ENTRY_TYPE_TO_STREAM } from './registry.js';
import type { Encoder } from './encoder.js';
import type { JsonValue } from './json.js';
import type {
  ResourceTimingEntry,
  ServerTimingEntry,
  NavigationTimingEntry,
  NotRestoredReasons,
  NavigationConfidence,
  PaintTime,
  PaintStream,
  LcpEntry,
  LcpStream,
  LayoutShiftEntry,
  LayoutShiftSource,
  Rect,
  ElementTimingEntry,
  ElementRef,
  InteractionEntry,
  LongTaskEntry,
  LongTaskAttribution,
  LoafEntry,
  LoafScript,
  MarkEntry,
  MeasureEntry,
  VisibilityStateEntry,
  ErrorEntry,
  EnvironmentStream,
  UserAgentData,
  UserAgentBrand,
  NetworkInformation,
} from './streams/index.js';

// ── Guarded field readers (total: garbage degrades to absent, never throws) ─────────────────────────

/** A raw entry: a live PerformanceEntry or its toJSON() form. Fields are read guarded, never trusted. */
export type RawEntry = object;

type Raw = Record<string, unknown>;
const raw = (e: object): Raw => e as Raw;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** A 0-means-absent platform timestamp: keep only finite values > 0. */
const phase = (v: unknown): RelMs | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? asRelMs(n) : undefined;
};
const dur = (v: unknown): DurationMs | undefined => {
  const n = num(v);
  return n !== undefined ? asDurationMs(n) : undefined;
};
/** Non-empty string ('' is the spec default / "none" sentinel for most string fields). */
const nes = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const rel = (v: unknown): RelMs => asRelMs(num(v) ?? 0);
const relDur = (v: unknown): DurationMs => asDurationMs(num(v) ?? 0);

/** Copy `keys` through the 0-means-absent phase mapping. `keys` are checked against the model type. */
function copyPhases<T>(out: T, e: Raw, keys: readonly (keyof T & string)[]): void {
  for (const k of keys) {
    const v = phase(e[k]);
    if (v !== undefined) (out as Raw)[k] = v;
  }
}

/** Copy non-empty string `keys` verbatim ('' -> absent). */
function copyStrings<T>(out: T, e: Raw, keys: readonly (keyof T & string)[]): void {
  for (const k of keys) {
    const v = nes(e[k]);
    if (v !== undefined) (out as Raw)[k] = v;
  }
}

/** Copy finite-number `keys` verbatim (0 is a real value for sizes/counts). */
function copyNumbers<T>(out: T, e: Raw, keys: readonly (keyof T & string)[]): void {
  for (const k of keys) {
    const v = num(e[k]);
    if (v !== undefined) (out as Raw)[k] = v;
  }
}

// ── Element → structural selector (PII posture: never element text) ─────────────────────────────────

/** The structural subset of Element the selector walk reads — live DOM in a page; absent in replay. */
interface ElementLike {
  nodeType?: number;
  localName?: string;
  id?: string;
  classList?: ArrayLike<string>;
  parentElement?: ElementLike | null;
  children?: ArrayLike<ElementLike>;
}

/**
 * A short, structural CSS path for a live element — tag / #id / first classes / :nth-of-type, at most
 * five levels, stopping at the first #id. Deliberately NEVER element text content, so the default
 * attribution posture matches the `structural-only` redaction vocabulary in the capture config.
 */
export function structuralSelector(el: unknown): string | undefined {
  let n = el as ElementLike | null | undefined;
  if (n === null || typeof n !== 'object' || n.nodeType !== 1) return undefined;
  const parts: string[] = [];
  while (n && n.nodeType === 1 && typeof n.localName === 'string' && parts.length < 5) {
    let s = n.localName;
    if (typeof n.id === 'string' && n.id !== '') {
      parts.unshift(`${s}#${n.id}`);
      break;
    }
    const classes = n.classList;
    if (classes && classes.length > 0) s += '.' + Array.from(classes).slice(0, 2).join('.');
    const parent = n.parentElement;
    if (parent && parent.children) {
      const siblings = Array.from(parent.children).filter((c) => c.localName === n?.localName);
      if (siblings.length > 1) s += `:nth-of-type(${siblings.indexOf(n) + 1})`;
    }
    parts.unshift(s);
    n = n.parentElement;
  }
  return parts.length > 0 ? parts.join(' > ') : undefined;
}

const elementRef = (node: unknown): ElementRef | undefined => {
  // A pre-computed selector STRING is accepted as-is: replayed stored entries and consumers with
  // their own selector/redaction policy hold one instead of a live node.
  if (typeof node === 'string') return node !== '' ? { selector: node } : undefined;
  const selector = structuralSelector(node);
  return selector !== undefined ? { selector } : undefined;
};

// ── Per-entry normalizers (raw browser shape → model shape) ─────────────────────────────────────────

// Field lists are `satisfies`-checked against the model so a schema rename breaks THESE at compile
// time instead of silently dropping the field at pack time (the descriptor codec encodes model keys).
const RESOURCE_PHASES = [
  'workerStart',
  'workerRouterEvaluationStart',
  'workerCacheLookupStart',
  'redirectStart',
  'redirectEnd',
  'fetchStart',
  'domainLookupStart',
  'domainLookupEnd',
  'connectStart',
  'secureConnectionStart',
  'connectEnd',
  'requestStart',
  'firstInterimResponseStart',
  'finalResponseHeadersStart',
  'responseStart',
  'responseEnd',
] as const satisfies readonly (keyof ResourceTimingEntry)[];

const NAVIGATION_PHASES = [
  'unloadEventStart',
  'unloadEventEnd',
  'domInteractive',
  'domContentLoadedEventStart',
  'domContentLoadedEventEnd',
  'domComplete',
  'loadEventStart',
  'loadEventEnd',
  'activationStart',
  'criticalCHRestart',
] as const satisfies readonly (keyof NavigationTimingEntry)[];

/** PerformanceResourceTiming → the model entry. Covers every field the model knows. */
export function normalizeResource(entry: RawEntry): ResourceTimingEntry {
  const e = raw(entry);
  const r: ResourceTimingEntry = {
    name: str(e.name) ?? '',
    startTime: rel(e.startTime),
    duration: relDur(e.duration),
    initiatorType: str(e.initiatorType) ?? '',
  };
  // deliveryType keeps '' — a spec vocabulary value ("no special delivery"), not an absence sentinel.
  const delivery = str(e.deliveryType);
  if (delivery !== undefined) r.deliveryType = delivery;
  copyStrings(r, e, ['nextHopProtocol', 'renderBlockingStatus', 'contentType', 'contentEncoding']);
  copyPhases(r, e, RESOURCE_PHASES);
  // ServiceWorker static-routing sources: the model uses the W3C spec names; Chrome (≤149 corpus)
  // still emits the experimental `workerMatched/FinalSourceType` spelling — accept either, '' → absent.
  const matched = nes(e.workerMatchedRouterSource) ?? nes(e.workerMatchedSourceType);
  if (matched !== undefined) r.workerMatchedRouterSource = matched;
  const final = nes(e.workerFinalRouterSource) ?? nes(e.workerFinalSourceType);
  if (final !== undefined) r.workerFinalRouterSource = final;
  // Sizes keep 0 (a real cached/opaque answer); responseStatus keeps 0 (the spec's opaque value).
  copyNumbers(r, e, ['transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStatus']);
  if (Array.isArray(e.serverTiming)) {
    // Kept even when [] — "collected, none sent" stays distinct from "not collected" (absent).
    r.serverTiming = e.serverTiming.map((s): ServerTimingEntry => {
      const st = raw(s as object);
      const out: ServerTimingEntry = { name: str(st.name) ?? '' };
      const d = dur(st.duration); // duration 0 is a real measured value
      if (d !== undefined) out.duration = d;
      const desc = nes(st.description);
      if (desc !== undefined) out.description = desc;
      return out;
    });
  }
  return r;
}

function normalizeNotRestoredReasons(v: unknown): NotRestoredReasons | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const n = raw(v);
  const out: NotRestoredReasons = {};
  copyStrings(out, n, ['url', 'src', 'id', 'name']);
  if (Array.isArray(n.reasons)) {
    out.reasons = n.reasons.flatMap((entry) => {
      const reason = nes(raw(entry as object).reason);
      return reason !== undefined ? [{ reason }] : [];
    });
  }
  if (Array.isArray(n.children)) {
    out.children = n.children.flatMap((c) => {
      const child = normalizeNotRestoredReasons(c);
      return child !== undefined ? [child] : [];
    });
  }
  return out;
}

/** PerformanceNavigationTiming → the model entry (resource phases + document milestones). */
export function normalizeNavigation(entry: RawEntry): NavigationTimingEntry {
  const e = raw(entry);
  const base = normalizeResource(entry);
  const type = str(e.type);
  const nav: NavigationTimingEntry = {
    ...base,
    initiatorType: base.initiatorType !== '' ? base.initiatorType : 'navigation',
    type: type === 'reload' || type === 'back_forward' || type === 'prerender' ? type : 'navigate',
    redirectCount: num(e.redirectCount) ?? 0,
  };
  copyPhases(nav, e, NAVIGATION_PHASES);
  // `null` is the spec's real answer ("nothing blocked bfcache" / not a history navigation) and the
  // model keeps it distinct from absent ("not read") — so a present null is preserved, not dropped.
  if (e.notRestoredReasons === null) nav.notRestoredReasons = null;
  else {
    const reasons = normalizeNotRestoredReasons(e.notRestoredReasons);
    if (reasons !== undefined) nav.notRestoredReasons = reasons;
  }
  if (e.confidence !== null && typeof e.confidence === 'object') {
    const c = raw(e.confidence);
    const conf: NavigationConfidence = {};
    const value = str(c.value);
    if (value === 'low' || value === 'high') conf.value = value;
    const rate = num(c.randomizedTriggerRate);
    if (rate !== undefined) conf.randomizedTriggerRate = rate;
    // Chrome 149 serializes confidence as {} (corpus) — an empty object carries nothing; drop it.
    if (conf.value !== undefined || conf.randomizedTriggerRate !== undefined) nav.confidence = conf;
  }
  return nav;
}

/** A `paint` entry → the model milestone (which slot it fills comes from `entry.name`; see entrySink). */
export function normalizePaint(entry: RawEntry): PaintTime {
  const e = raw(entry);
  const p: PaintTime = { startTime: rel(e.startTime) };
  copyPhases(p, e, ['paintTime', 'presentationTime']);
  return p;
}

/** A `largest-contentful-paint` entry → one LCP candidate. */
export function normalizeLcp(entry: RawEntry): LcpEntry {
  const e = raw(entry);
  const lcp: LcpEntry = { startTime: rel(e.startTime), size: num(e.size) ?? 0 };
  // renderTime is 0 without Timing-Allow-Origin; loadTime is 0 for text LCP — sentinels, not paints.
  copyPhases(lcp, e, ['renderTime', 'loadTime', 'paintTime', 'presentationTime']);
  copyStrings(lcp, e, ['id', 'url']); // '' = "element has no id / not an image" → absent
  const element = elementRef(e.element);
  if (element !== undefined) lcp.element = element;
  return lcp;
}

function normalizeRect(v: unknown): Rect | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  // Live DOMRectReadOnly serializes via toJSON(); a replayed capture already holds the plain form.
  const source = raw(v);
  const r = raw(typeof source.toJSON === 'function' ? (source.toJSON as () => object)() : (v as object));
  return {
    x: num(r.x) ?? 0,
    y: num(r.y) ?? 0,
    width: num(r.width) ?? 0,
    height: num(r.height) ?? 0,
    top: num(r.top) ?? 0,
    right: num(r.right) ?? 0,
    bottom: num(r.bottom) ?? 0,
    left: num(r.left) ?? 0,
  };
}

/** A `layout-shift` entry → the model shift (sources' nodes become structural selectors). */
export function normalizeLayoutShift(entry: RawEntry): LayoutShiftEntry {
  const e = raw(entry);
  const shift: LayoutShiftEntry = {
    startTime: rel(e.startTime),
    value: num(e.value) ?? 0,
    hadRecentInput: e.hadRecentInput === true,
  };
  const lastInput = phase(e.lastInputTime); // 0 = "no recent input" — a sentinel, not t=0
  if (lastInput !== undefined) shift.lastInputTime = lastInput;
  if (Array.isArray(e.sources)) {
    shift.sources = e.sources.map((s): LayoutShiftSource => {
      const source = raw((s ?? {}) as object);
      const out: LayoutShiftSource = {};
      const node = elementRef(source.node);
      if (node !== undefined) out.node = node;
      const prev = normalizeRect(source.previousRect);
      if (prev !== undefined) out.previousRect = prev;
      const cur = normalizeRect(source.currentRect);
      if (cur !== undefined) out.currentRect = cur;
      return out;
    });
  }
  return shift;
}

/** An `event` / `first-input` entry → the model interaction (`target` becomes a selector). */
export function normalizeInteraction(entry: RawEntry): InteractionEntry {
  const e = raw(entry);
  const it: InteractionEntry = {
    name: str(e.name) ?? '',
    startTime: rel(e.startTime),
    duration: relDur(e.duration),
  };
  copyPhases(it, e, ['processingStart', 'processingEnd']);
  // interactionId 0 is Event Timing's "not an interaction" sentinel → absent (nonzero ids group taps).
  const interactionId = num(e.interactionId);
  if (interactionId !== undefined && interactionId !== 0) it.interactionId = interactionId;
  if (typeof e.cancelable === 'boolean') it.cancelable = e.cancelable;
  if (str(e.entryType) === 'first-input') it.firstInput = true;
  const target = elementRef(e.target);
  if (target !== undefined) it.target = target;
  return it;
}

/** A `longtask` entry → the model task (attribution '' defaults → absent). */
export function normalizeLongTask(entry: RawEntry): LongTaskEntry {
  const e = raw(entry);
  const task: LongTaskEntry = { startTime: rel(e.startTime), duration: relDur(e.duration) };
  if (Array.isArray(e.attribution)) {
    task.attribution = e.attribution.map((a): LongTaskAttribution => {
      const out: LongTaskAttribution = {};
      copyStrings(out, raw((a ?? {}) as object), ['name', 'containerType', 'containerName', 'containerId', 'containerSrc']);
      return out;
    });
  }
  return task;
}

const LOAF_PHASES = [
  'renderStart',
  'styleAndLayoutStart',
  'firstUIEventTimestamp',
  'paintTime',
  'presentationTime',
] as const satisfies readonly (keyof LoafEntry)[];

/** A `long-animation-frame` entry → the model frame (scripts included). */
export function normalizeLoaf(entry: RawEntry): LoafEntry {
  const e = raw(entry);
  const frame: LoafEntry = { startTime: rel(e.startTime), duration: relDur(e.duration) };
  // The milestone timestamps report 0 when the phase didn't occur (pervasive in the corpus) → absent;
  // blockingDuration is a DURATION — 0 is a real measured value and is kept.
  copyPhases(frame, e, LOAF_PHASES);
  const blocking = dur(e.blockingDuration);
  if (blocking !== undefined) frame.blockingDuration = blocking;
  if (Array.isArray(e.scripts)) {
    frame.scripts = e.scripts.map((s): LoafScript => {
      const sc = raw((s ?? {}) as object);
      const out: LoafScript = { startTime: rel(sc.startTime), duration: relDur(sc.duration) };
      copyStrings(out, sc, ['invokerType', 'invoker', 'sourceURL', 'sourceFunctionName', 'windowAttribution']);
      const execution = phase(sc.executionStart);
      if (execution !== undefined) out.executionStart = execution;
      const forced = dur(sc.forcedStyleAndLayoutDuration); // durations: 0 kept
      if (forced !== undefined) out.forcedStyleAndLayoutDuration = forced;
      const pause = dur(sc.pauseDuration);
      if (pause !== undefined) out.pauseDuration = pause;
      // The LoAF spec defines sourceCharPosition -1 as "could not be determined" — a sentinel the
      // model wants absent (and the codec's non-negative varuint would rightly throw on). The corpus
      // only exhibits real values (0 = script start is real and kept), so this guard is spec-grounded.
      const charPos = num(sc.sourceCharPosition);
      if (charPos !== undefined && charPos >= 0) out.sourceCharPosition = charPos;
      return out;
    });
  }
  return frame;
}

/** An `element` (Element Timing) entry → the model entry. */
export function normalizeElementTiming(entry: RawEntry): ElementTimingEntry {
  const e = raw(entry);
  const el: ElementTimingEntry = { startTime: rel(e.startTime) };
  copyStrings(el, e, ['identifier', 'url']); // url '' = text element → absent
  copyPhases(el, e, ['renderTime', 'loadTime']); // same 0-sentinel rule as LCP
  // naturalWidth/Height are 0 for text elements (no intrinsic size) — a sentinel, not a measurement.
  const w = num(e.naturalWidth);
  if (w !== undefined && w > 0) el.naturalWidth = w;
  const h = num(e.naturalHeight);
  if (h !== undefined && h > 0) el.naturalHeight = h;
  const element = elementRef(e.element);
  if (element !== undefined) el.element = element;
  return el;
}

/** Read a live `detail` (marks/measures): `null` is the platform default for "none" → absent. */
const detailOf = (e: Raw): JsonValue | undefined =>
  e.detail === null || e.detail === undefined ? undefined : (e.detail as JsonValue);

/** A `mark` entry → the model mark (live `detail` kept; it does not survive toJSON()). */
export function normalizeMark(entry: RawEntry): MarkEntry {
  const e = raw(entry);
  const mark: MarkEntry = { name: str(e.name) ?? '', startTime: rel(e.startTime) };
  const detail = detailOf(e);
  if (detail !== undefined) mark.detail = detail;
  return mark;
}

/** A `measure` entry → the model measure. */
export function normalizeMeasure(entry: RawEntry): MeasureEntry {
  const e = raw(entry);
  const measure: MeasureEntry = { name: str(e.name) ?? '', startTime: rel(e.startTime), duration: relDur(e.duration) };
  const detail = detailOf(e);
  if (detail !== undefined) measure.detail = detail;
  return measure;
}

/** A `visibility-state` entry → the model transition. */
export function normalizeVisibility(entry: RawEntry): VisibilityStateEntry {
  const e = raw(entry);
  return { state: str(e.name) === 'hidden' ? 'hidden' : 'visible', startTime: rel(e.startTime) };
}

// ── Error events (window `error` / `unhandledrejection` — not PerformanceObserver sources) ──────────

/**
 * A window `error` event → the model entry. `startTime` defaults to `performance.now()` at call time
 * (within the dispatch task of the throw) — deliberately NOT `event.timeStamp`, whose clock base has
 * varied across engines; a slightly-late unambiguous time beats a precisely-wrong one.
 * `message`/`stack` are PII-bearing — the redaction pass, not this mapper, is where policy applies.
 */
export function normalizeErrorEvent(event: object, startTime?: RelMs): ErrorEntry {
  const e = raw(event);
  const entry: ErrorEntry = { startTime: startTime ?? asRelMs(performance.now()), kind: 'error' };
  const message = nes(e.message);
  if (message !== undefined) entry.message = message;
  // The browser event calls it `filename`; the model field is `source`. (The descriptor-driven codec
  // encodes only model keys, so an unrenamed `filename` would be silently dropped at pack time.)
  const source = nes(e.filename);
  if (source !== undefined) entry.source = source;
  // lineno/colno are 0 when unknown (cross-origin scripts) — a sentinel, not line 0.
  const lineno = num(e.lineno);
  if (lineno !== undefined && lineno > 0) entry.lineno = lineno;
  const colno = num(e.colno);
  if (colno !== undefined && colno > 0) entry.colno = colno;
  if (e.error !== null && typeof e.error === 'object') {
    const err = raw(e.error);
    const name = nes(err.name);
    if (name !== undefined) entry.name = name;
    const stack = nes(err.stack);
    if (stack !== undefined) entry.stack = stack;
  }
  return entry;
}

/** A window `unhandledrejection` event → the model entry (reason coerced defensively). */
export function normalizeRejection(event: object, startTime?: RelMs): ErrorEntry {
  const reason: unknown = raw(event).reason;
  const entry: ErrorEntry = { startTime: startTime ?? asRelMs(performance.now()), kind: 'unhandledrejection' };
  if (reason !== null && typeof reason === 'object') {
    const r = raw(reason);
    const name = nes(r.name);
    if (name !== undefined) entry.name = name;
    const message = nes(r.message);
    if (message !== undefined) entry.message = message;
    const stack = nes(r.stack);
    if (stack !== undefined) entry.stack = stack;
  }
  if (entry.message === undefined) {
    try {
      entry.message = String(reason);
    } catch {
      /* a hostile toString must not break the page — leave message absent */
    }
  }
  return entry;
}

// ── Environment snapshot ─────────────────────────────────────────────────────────────────────────────

/** The window/navigator surface the snapshot reads, typed structurally so this compiles (and safely
 *  no-ops) under the WebWorker lib and in Node — where the page-only globals simply don't exist. */
interface GlobalsLike {
  navigator?: {
    userAgent?: string;
    userAgentData?: { brands?: unknown; mobile?: unknown; platform?: unknown };
    deviceMemory?: number;
    hardwareConcurrency?: number;
    connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean };
  };
  innerWidth?: number;
  innerHeight?: number;
  screen?: { width?: number; height?: number };
  devicePixelRatio?: number;
  Profiler?: unknown;
}

/**
 * Snapshot the environment/device context from the live globals (UA, UA-CH low-entropy, device memory,
 * connection, viewport/screen geometry, self-profiler availability). Reads only what exists — under
 * Node or a worker the missing fields are simply absent. High-entropy UA-CH needs an async permission
 * prompt-able call, so it is deliberately left to the caller.
 */
export function environmentSnapshot(): EnvironmentStream {
  const g = globalThis as GlobalsLike;
  const env: EnvironmentStream = {};
  const nav = g.navigator;
  if (nav !== undefined) {
    const ua = nes(nav.userAgent);
    if (ua !== undefined) env.userAgent = ua;
    const uad = nav.userAgentData;
    if (uad !== null && typeof uad === 'object') {
      const data: UserAgentData = { mobile: uad.mobile === true };
      if (Array.isArray(uad.brands)) {
        data.brands = uad.brands.flatMap((b): UserAgentBrand[] => {
          const brand = raw((b ?? {}) as object);
          const name = str(brand.brand);
          const version = str(brand.version);
          return name !== undefined && version !== undefined ? [{ brand: name, version }] : [];
        });
      }
      const platform = str(uad.platform);
      if (platform !== undefined) data.platform = platform;
      env.userAgentData = data;
    }
    const memory = num(nav.deviceMemory);
    if (memory !== undefined) env.deviceMemory = memory;
    const cores = num(nav.hardwareConcurrency);
    if (cores !== undefined) env.hardwareConcurrency = cores;
    const conn = nav.connection;
    if (conn !== null && typeof conn === 'object') {
      const connection: NetworkInformation = {};
      const effectiveType = nes(conn.effectiveType);
      if (effectiveType !== undefined) connection.effectiveType = effectiveType;
      const rtt = num(conn.rtt);
      if (rtt !== undefined) connection.rtt = rtt;
      const downlink = num(conn.downlink);
      if (downlink !== undefined) connection.downlink = downlink;
      if (typeof conn.saveData === 'boolean') connection.saveData = conn.saveData;
      env.connection = connection;
    }
  }
  const vw = num(g.innerWidth);
  if (vw !== undefined) env.viewportWidth = vw;
  const vh = num(g.innerHeight);
  if (vh !== undefined) env.viewportHeight = vh;
  const screen = g.screen;
  if (screen !== null && typeof screen === 'object') {
    const sw = num(screen.width);
    if (sw !== undefined) env.screenWidth = sw;
    const sh = num(screen.height);
    if (sh !== undefined) env.screenHeight = sh;
  }
  const dpr = num(g.devicePixelRatio);
  if (dpr !== undefined) env.devicePixelRatio = dpr;
  // Constructor presence only — actually constructing a Profiler starts sampling, and its absence vs.
  // a missing Document-Policy header can't be told apart without trying. Callers that probe by
  // construction can overwrite this (and markStream('profile', 'policy-blocked')) with what they learn.
  env.selfProfiler = typeof g.Profiler === 'function' ? 'available' : 'unsupported';
  return env;
}

// ── entrySink: a PerformanceObserver callback that feeds an Encoder ──────────────────────────────────

/** What the sink accepts: an observer's entry list, an array/iterable of entries, or one entry. */
export type EntrySinkInput = { getEntries(): unknown } | Iterable<unknown> | RawEntry;

/**
 * Build the one feed function that connects `PerformanceObserver` output to an `Encoder` — usable
 * directly as the observer callback:
 *
 * ```ts
 * const sink = entrySink(enc);
 * for (const type of ['navigation', 'resource', 'paint', 'largest-contentful-paint', 'layout-shift',
 *                     'event', 'first-input', 'longtask', 'long-animation-frame', 'element',
 *                     'mark', 'measure', 'visibility-state']) {
 *   try { new PerformanceObserver(sink).observe({ type, buffered: true,
 *     ...(type === 'event' ? { durationThreshold: 16 } : {}) }); } catch { /* unsupported *\/ }
 * }
 * ```
 *
 * It routes by `entryType`, normalizes (this module's mappers), and handles the stateful quirks a
 * per-entry mapping can't: paint milestones and LCP candidates accumulate into their singleton streams;
 * the double-delivered first interaction (`event` + its threshold-exempt `first-input` copy) is merged
 * onto one recorded entry; a re-delivered `navigation` singleton replaces the provisional one (a
 * buffered document-start observer sees it twice — the last, complete entry wins); an observer's
 * `droppedEntriesCount` (buffer overflow before `observe()`) is recorded as a manifest loss note.
 * Unknown entry types are ignored. After the encoder is finished, entries are dropped silently — a
 * late observer delivery must not throw inside the page.
 */
export function entrySink(enc: Encoder): (entries: EntrySinkInput, observer?: unknown, options?: unknown) => void {
  const paint: PaintStream = {};
  const lcp: LcpStream = {};
  // The first user interaction arrives TWICE by spec: once as an `event` entry and once as a
  // threshold-exempt `first-input` COPY of it. ONLY that pair may merge — the corpus shows distinct
  // events legitimately sharing startTime+name (a `pointerenter` dispatches per ancestor element,
  // all stamped with the same event time), so a general key-dedup would eat real entries. We keep
  // the first recorded interaction per key (to flag if its first-input copy arrives later) and a
  // one-shot pending key (to consume the `event` twin if the first-input arrived first).
  const firstPerKey = new Map<string, InteractionEntry>();
  let pendingFirstInputTwin: string | undefined;

  const handle = (entryLike: unknown): void => {
    if (entryLike === null || typeof entryLike !== 'object') return;
    const e = raw(entryLike);
    switch (str(e.entryType)) {
      case 'navigation':
        enc.setNavigation(normalizeNavigation(entryLike)); // set replaces: the complete entry wins
        break;
      case 'resource':
        enc.addResource(normalizeResource(entryLike));
        break;
      case 'paint': {
        const milestone = normalizePaint(entryLike);
        if (str(e.name) === 'first-paint') paint.firstPaint = milestone;
        else if (str(e.name) === 'first-contentful-paint') paint.firstContentfulPaint = milestone;
        else break; // an unknown paint milestone has no model slot — ignore
        enc.setPaint(paint);
        break;
      }
      case 'largest-contentful-paint': {
        const candidate = normalizeLcp(entryLike);
        (lcp.candidates ??= []).push(candidate);
        lcp.final = candidate; // the latest candidate is the current LCP
        enc.setLcp(lcp);
        break;
      }
      case 'layout-shift':
        enc.addLayoutShift(normalizeLayoutShift(entryLike));
        break;
      case 'event':
      case 'first-input': {
        const key = `${num(e.startTime) ?? 0}|${str(e.name) ?? ''}`;
        if (str(e.entryType) === 'first-input') {
          const twin = firstPerKey.get(key);
          if (twin !== undefined) {
            twin.firstInput = true; // its `event` twin was already recorded — flag, don't duplicate
            break;
          }
          pendingFirstInputTwin = key; // the copy came first; consume the `event` twin when it lands
        } else if (pendingFirstInputTwin === key) {
          pendingFirstInputTwin = undefined;
          break; // this IS the already-recorded first-input's twin — skip the duplicate
        }
        const interaction = normalizeInteraction(entryLike);
        if (!firstPerKey.has(key)) firstPerKey.set(key, interaction);
        enc.addInteraction(interaction);
        break;
      }
      case 'longtask':
        enc.addLongTask(normalizeLongTask(entryLike));
        break;
      case 'long-animation-frame':
        enc.addLoaf(normalizeLoaf(entryLike));
        break;
      case 'element':
        enc.addElementTiming(normalizeElementTiming(entryLike));
        break;
      case 'mark':
        enc.mark(normalizeMark(entryLike));
        break;
      case 'measure':
        enc.measure(normalizeMeasure(entryLike));
        break;
      case 'visibility-state':
        enc.addVisibility(normalizeVisibility(entryLike));
        break;
      default:
        break; // an entry type this build predates — ignore, never throw
    }
  };

  return (entries, _observer?, options?) => {
    if (enc.finished) return; // late delivery after finish() — drop, never throw in the page
    const list =
      typeof (entries as { getEntries?: unknown }).getEntries === 'function'
        ? ((entries as { getEntries(): unknown }).getEntries() as unknown)
        : entries;
    const items: unknown[] = Array.isArray(list)
      ? list
      : typeof (list as Iterable<unknown>)[Symbol.iterator] === 'function' && typeof list !== 'string'
        ? Array.from(list as Iterable<unknown>)
        : [list];
    // The spec delivers droppedEntriesCount once, on the observer's first callback: entries lost to a
    // full buffer before observe(). Record it as manifest loss on the stream these entries feed.
    if (options !== null && typeof options === 'object') {
      const dropped = num(raw(options).droppedEntriesCount);
      const first = items[0];
      if (dropped !== undefined && dropped > 0 && first !== null && typeof first === 'object') {
        const stream = ENTRY_TYPE_TO_STREAM[str(raw(first).entryType) ?? ''];
        if (stream !== undefined) {
          enc.markStream(stream, 'present', {
            loss: [{ kind: 'buffer-overflow', droppedCount: dropped }],
          });
        }
      }
    }
    for (const item of items) handle(item);
  };
}
