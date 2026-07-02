/**
 * The streaming `Encoder` — the library's headline surface. A caller brings their OWN capture code
 * (PerformanceObservers, the JS Self-Profiler, app instrumentation), constructs one Encoder, streams
 * events into it as they observe them, and calls `finish()` to get the packed `.rcap` bytes. Custom
 * events are authored with a stack-based context (`timeline().begin/end` or scoped `span()`) that
 * derives nesting depth from the call stack and duration from the begin→end delta.
 *
 * This lives on the ENCODE side (re-exported from `rumcap/encode` and `rumcap`, never `rumcap/decode`),
 * so it inherits the "tiny on the page" discipline: it accumulates the plain `Capture` model and folds
 * the profiler incrementally via the existing `SliceBuilder`, then delegates to `pack()`. Interning and
 * compression happen once, in `pack`, at `finish()` — the per-section seam for a future incremental
 * on-page driver already exists in the codec, but is not wired here yet.
 *
 * Note: `Encoder` is the public streaming class; the codec's low-level byte encoder is `FieldEncoder`.
 */

import { pack } from './codec/pack.js';
import { SliceBuilder } from './profile-slices.js';
import { FORMAT_VERSION, STREAM_SCHEMA_VERSIONS } from './version.js';
import { STREAM_IDS, type StreamId, type StreamStatus } from './registry.js';
import { asRelMs, asDurationMs, type RelMs, type DurationMs, type EpochMs } from './time.js';
import type { JsonValue } from './json.js';
import type { Capture, OverheadReport } from './capture.js';
import type { CaptureConfig } from './config.js';
import type { ClockMeta, Manifest, StreamManifestEntry, Provenance, LossNote } from './manifest.js';
import type {
  Streams,
  NavigationTimingEntry,
  ResourceTimingEntry,
  PaintStream,
  LcpStream,
  ElementTimingEntry,
  LayoutShiftEntry,
  InteractionEntry,
  LongTaskEntry,
  LoafEntry,
  MarkEntry,
  MeasureEntry,
  VisibilityStateEntry,
  ErrorEntry,
  EnvironmentStream,
  CustomEvent,
  CustomEventTrack,
} from './streams/index.js';
import type { ProfilerTrace } from './streams/profile.js';

/** Construction options for {@link Encoder}. */
export interface EncoderInit {
  /** Capture-config that SHOULD have been attempted (also travels in the manifest). Defaults to `{ version: 1 }`. */
  config?: CaptureConfig;
  /** The page's `performance.timeOrigin` (epoch anchor). Defaults to `performance.timeOrigin`. */
  timeOrigin?: EpochMs;
  /** Monotonic offset of capture start from `timeOrigin`. Defaults to 0. */
  captureStart?: RelMs;
  /** Reported timer precision/coarsening in ms, if known. */
  precision?: number;
  /** The actual (clamped) profiler sample interval, so the slice fold's floor/gap work from chunk 1. */
  sampleIntervalMs?: DurationMs;
  /** Capture-level metadata (arbitrary JSON). May also be set later via `setMetadata`/`putMetadata`.
   *  Copied shallowly on construction — later `putMetadata` calls never mutate the object you pass. */
  metadata?: Record<string, JsonValue>;
  /** Clock function returning the current page-relative time (RelMs). Defaults to `performance.now()`.
   *  Inject a deterministic clock in tests. */
  now?: () => RelMs;
}

/** Merge begin- and end-time details: shallow-merge two plain objects (end wins), else end ?? begin. */
function mergeDetails(a: JsonValue | undefined, b: JsonValue | undefined): JsonValue | undefined {
  if (b === undefined) return a;
  if (a === undefined) return b;
  const objA = typeof a === 'object' && a !== null && !Array.isArray(a);
  const objB = typeof b === 'object' && b !== null && !Array.isArray(b);
  if (objA && objB) return { ...(a as Record<string, JsonValue>), ...(b as Record<string, JsonValue>) };
  return b;
}

/**
 * A handle to an open span. Hold it and call `.end()` when the work completes; nesting depth was
 * fixed at `begin()` time from the stack. Handle-based (not strictly LIFO), so overlapping/async spans
 * still close correctly — though strictly-nested usage is what yields clean 0/1/2… depths.
 */
export class Span {
  #ended = false;
  constructor(
    private readonly track: Timeline,
    /** @internal */ readonly _name: string,
    /** @internal */ readonly _start: RelMs,
    /** @internal */ readonly _depth: number,
    /** @internal */ readonly _details: JsonValue | undefined,
  ) {}

  /** Close the span: records duration = now − start and emits the event. Optional end-time details are
   *  merged over the begin-time details. Double-`end()` is a no-op. */
  end(details?: JsonValue): void {
    if (this.#ended) return;
    this.#ended = true;
    this.track._close(this, details);
  }
}

/**
 * One namespaced timeline (track). `begin`/`end`/`span` push and pop an internal stack so `depth` comes
 * from the call structure, not the caller. Obtain one via `encoder.timeline(namespace)` — repeated calls
 * for the same namespace return the same Timeline, so an app's spans stay on one track.
 *
 * A Timeline is a feed path like any Encoder method: once the Encoder has finished, `begin`/`span`/
 * `instant`/`event` throw — a held handle can never silently mutate a finalized capture.
 */
export class Timeline {
  readonly #open: Span[] = [];
  readonly #events: CustomEvent[] = [];

  constructor(
    readonly namespace: string,
    private readonly now: () => RelMs,
    private readonly bump: (t: number) => void,
    private readonly assertOpen: () => void,
  ) {}

  /** Open a span at the current time; `depth` = the current open-span count. Returns a handle. */
  begin(name: string, details?: JsonValue): Span {
    this.assertOpen();
    const span = new Span(this, name, this.now(), this.#open.length, details);
    this.#open.push(span);
    return span;
  }

  /** Scoped span: begin, run `fn` (awaiting if it returns a promise), end in `finally`; returns fn's
   *  result. The ergonomic for "a stack of function calls building on an event context". */
  span<T>(name: string, fn: () => T): T;
  span<T>(name: string, details: JsonValue, fn: () => T): T;
  span<T>(name: string, detailsOrFn: JsonValue | (() => T), maybeFn?: () => T): T {
    const fn = (maybeFn ?? detailsOrFn) as () => T;
    const details = maybeFn ? (detailsOrFn as JsonValue) : undefined;
    const span = this.begin(name, details);
    let result: T;
    try {
      result = fn();
    } catch (e) {
      span.end();
      throw e;
    }
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (v) => {
          span.end();
          return v;
        },
        (e: unknown) => {
          span.end();
          throw e;
        },
      ) as unknown as T;
    }
    span.end();
    return result;
  }

  /** A zero-duration event (a marker) at the current time and nesting depth. */
  instant(name: string, details?: JsonValue): void {
    this.assertOpen();
    this.#emit(name, this.now(), asDurationMs(0), this.#open.length, details);
  }

  /** Low-level escape hatch: append a pre-measured event verbatim (start/duration/depth/details as given). */
  event(ev: CustomEvent): void {
    this.assertOpen();
    const copy: CustomEvent = { name: ev.name, start: ev.start, duration: ev.duration };
    if (ev.depth !== undefined) copy.depth = ev.depth;
    if (ev.details !== undefined) copy.details = ev.details;
    this.#events.push(copy);
    this.bump((ev.start as number) + (ev.duration as number));
  }

  /** @internal — called by `Span.end`. (Post-finish calls can't reach here: `_finalize` force-ends every
   *  open span, so a held Span's `end()` is a documented double-end no-op by then.) */
  _close(span: Span, endDetails?: JsonValue): void {
    const i = this.#open.indexOf(span);
    if (i >= 0) this.#open.splice(i, 1);
    const end = this.now();
    this.#emit(span._name, span._start, asDurationMs(end - (span._start as number)), span._depth, mergeDetails(span._details, endDetails));
  }

  /** @internal — end any still-open spans (at the current time) and return the finished track. */
  _finalize(): CustomEventTrack {
    for (const span of [...this.#open]) span.end();
    // Pre-order (start asc, then depth asc) so a viewer renders parents before children.
    this.#events.sort((a, b) => (a.start as number) - (b.start as number) || (a.depth ?? 0) - (b.depth ?? 0));
    return { namespace: this.namespace, events: this.#events };
  }

  #emit(name: string, start: RelMs, duration: DurationMs, depth: number, details: JsonValue | undefined): void {
    const ev: CustomEvent = { name, start, duration };
    if (depth > 0) ev.depth = depth; // depth 0 (root/flat) is the default → omit it
    if (details !== undefined) ev.details = details;
    this.#events.push(ev);
    this.bump((start as number) + (duration as number));
  }
}

/**
 * Stream a capture in, then `finish()` for the packed bytes. All feed methods return `this` for
 * chaining. Untouched streams are marked `not-requested`; a fed stream is `present`; use `markStream`
 * to record why one is absent (`unsupported`/`dropped`/`policy-blocked`).
 */
export class Encoder {
  // Typed as the model's `Streams` (not a `Partial<Record<StreamId, unknown>>` + casts) so a stream-model
  // field rename is a compile error HERE, not a runtime pack failure — the same total-record discipline
  // as STREAM_SCHEMA_VERSIONS/STREAM_T.
  readonly #streams: Streams = {};
  readonly #status = new Map<StreamId, StreamManifestEntry>();
  readonly #timelines = new Map<string, Timeline>();
  readonly #now: () => RelMs;
  readonly #timeOrigin: EpochMs;
  readonly #captureStart: RelMs;
  readonly #precision: number | undefined;
  readonly #config: CaptureConfig;
  readonly #sampleIntervalMs: DurationMs | undefined;
  #metadata: Record<string, JsonValue> | undefined;
  #overhead: OverheadReport | undefined;
  #slices: SliceBuilder | undefined;
  #maxTime: number;
  #finalized = false;

  constructor(init: EncoderInit = {}) {
    this.#now = init.now ?? (() => performance.now() as RelMs);
    this.#timeOrigin = init.timeOrigin ?? (performance.timeOrigin as EpochMs);
    this.#captureStart = init.captureStart ?? asRelMs(0);
    this.#precision = init.precision;
    this.#config = init.config ?? { version: 1 };
    this.#sampleIntervalMs = init.sampleIntervalMs;
    // Shallow copy: the caller's object stays theirs. Without it, putMetadata would write into (and a
    // shared init object would leak between) caller-owned objects, all the way into the packed bytes.
    this.#metadata = init.metadata === undefined ? undefined : { ...init.metadata };
    this.#maxTime = this.#captureStart as number;
  }

  // ── singleton streams (set replaces) ────────────────────────────────────────────────────────────
  setNavigation(nav: NavigationTimingEntry): this {
    this.#assertOpen();
    this.#streams.navigation = nav;
    this.#bump((nav.startTime as number) + (nav.duration as number));
    return this;
  }
  setPaint(paint: PaintStream): this {
    this.#assertOpen();
    this.#streams.paint = paint;
    return this;
  }
  setLcp(lcp: LcpStream): this {
    this.#assertOpen();
    this.#streams.lcp = lcp;
    return this;
  }
  setEnvironment(env: EnvironmentStream): this {
    this.#assertOpen();
    this.#streams.environment = env;
    return this;
  }

  // ── append streams (add pushes into the stream's array) ──────────────────────────────────────────
  addResource(r: ResourceTimingEntry): this {
    this.#assertOpen();
    (this.#streams.resources ??= []).push(r);
    this.#bump((r.startTime as number) + (r.duration as number));
    return this;
  }
  addLayoutShift(s: LayoutShiftEntry): this {
    this.#assertOpen();
    (this.#streams.cls ??= { shifts: [] }).shifts.push(s);
    this.#bump(s.startTime as number);
    return this;
  }
  addInteraction(e: InteractionEntry): this {
    this.#assertOpen();
    (this.#streams.interactions ??= { events: [] }).events.push(e);
    this.#bump((e.startTime as number) + (e.duration as number));
    return this;
  }
  addLongTask(t: LongTaskEntry): this {
    this.#assertOpen();
    (this.#streams.longTasks ??= { tasks: [] }).tasks.push(t);
    this.#bump((t.startTime as number) + (t.duration as number));
    return this;
  }
  addLoaf(f: LoafEntry): this {
    this.#assertOpen();
    (this.#streams.loaf ??= { frames: [] }).frames.push(f);
    this.#bump((f.startTime as number) + (f.duration as number));
    return this;
  }
  addElementTiming(e: ElementTimingEntry): this {
    this.#assertOpen();
    (this.#streams.elementTiming ??= { elements: [] }).elements.push(e);
    this.#bump(e.startTime as number);
    return this;
  }
  addVisibility(s: VisibilityStateEntry): this {
    this.#assertOpen();
    (this.#streams.visibility ??= { states: [] }).states.push(s);
    this.#bump(s.startTime as number);
    return this;
  }
  addError(e: ErrorEntry): this {
    this.#assertOpen();
    (this.#streams.errors ??= { errors: [] }).errors.push(e);
    this.#bump(e.startTime as number);
    return this;
  }
  mark(m: MarkEntry): this {
    this.#assertOpen();
    (this.#streams.userTiming ??= { marks: [], measures: [] }).marks.push(m);
    this.#bump(m.startTime as number);
    return this;
  }
  measure(m: MeasureEntry): this {
    this.#assertOpen();
    (this.#streams.userTiming ??= { marks: [], measures: [] }).measures.push(m);
    this.#bump((m.startTime as number) + (m.duration as number));
    return this;
  }

  // ── profiler (incremental fold, reuses SliceBuilder) ─────────────────────────────────────────────
  /** Feed one raw `Profiler.stop()` chunk; folded into the accumulating call-tree immediately. */
  addProfilerChunk(trace: ProfilerTrace): this {
    this.#assertOpen();
    if (this.#slices === undefined) {
      this.#slices = new SliceBuilder(
        this.#sampleIntervalMs !== undefined ? { sampleIntervalMs: this.#sampleIntervalMs as number } : {},
      );
    }
    this.#slices.addChunk(trace);
    return this;
  }

  // ── custom events (stack-based) ──────────────────────────────────────────────────────────────────
  /** Get (or create) the timeline for `namespace`. Spans opened on it derive depth + duration. */
  timeline(namespace: string): Timeline {
    this.#assertOpen();
    let tl = this.#timelines.get(namespace);
    if (tl === undefined) {
      tl = new Timeline(
        namespace,
        this.#now,
        (t) => this.#bump(t),
        () => this.#assertOpen(),
      );
      this.#timelines.set(namespace, tl);
    }
    return tl;
  }

  // ── metadata / overhead / manifest control ───────────────────────────────────────────────────────
  /** Replace the capture-level metadata. Copied shallowly — the caller's object is never mutated. */
  setMetadata(meta: Record<string, JsonValue>): this {
    this.#assertOpen();
    this.#metadata = { ...meta };
    return this;
  }
  putMetadata(key: string, value: JsonValue): this {
    this.#assertOpen();
    (this.#metadata ??= {})[key] = value;
    return this;
  }
  setOverhead(o: OverheadReport): this {
    this.#assertOpen();
    this.#overhead = o;
    return this;
  }
  /** Record an explicit per-stream manifest status — e.g. why a stream is absent
   *  (`unsupported`/`not-requested`/`dropped`/`policy-blocked`), or present-with-provenance/loss. */
  markStream(id: StreamId, status: StreamStatus, extra?: { loss?: LossNote[]; provenance?: Provenance }): this {
    this.#assertOpen();
    const entry: StreamManifestEntry = { status, schemaVersion: STREAM_SCHEMA_VERSIONS[id] };
    if (extra?.loss !== undefined) entry.loss = extra.loss;
    if (extra?.provenance !== undefined) entry.provenance = extra.provenance;
    this.#status.set(id, entry);
    return this;
  }

  // ── finish ───────────────────────────────────────────────────────────────────────────────────────
  /** The assembled in-memory model (also what `finish()` packs). Finalizes the profiler fold + open
   *  spans on first call; idempotent thereafter. */
  toCapture(): Capture {
    this.#finalize();
    const capture: Capture = {
      formatVersion: FORMAT_VERSION,
      manifest: this.#buildManifest(),
      streams: this.#streams,
    };
    if (this.#overhead !== undefined) capture.overhead = this.#overhead;
    if (this.#metadata !== undefined) capture.metadata = this.#metadata;
    return capture;
  }

  /** Fold the profiler tail, assemble the TOTAL manifest, and pack. Async only because gzip is. */
  async finish(): Promise<Uint8Array> {
    return pack(this.toCapture());
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────
  #assertOpen(): void {
    if (this.#finalized) throw new Error('Encoder already finished — no more events can be fed');
  }

  #finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#slices !== undefined) this.#streams.profile = this.#slices.finish();
    const tracks: CustomEventTrack[] = [];
    for (const tl of this.#timelines.values()) tracks.push(tl._finalize());
    if (tracks.length > 0) this.#streams.customEvents = { tracks };
    this.#bump(this.#now() as number); // capture end = latest of (observed times, now-at-finish)
  }

  #bump(t: number): void {
    if (t > this.#maxTime) this.#maxTime = t;
  }

  #buildManifest(): Manifest {
    const streams = {} as Record<StreamId, StreamManifestEntry>;
    for (const id of STREAM_IDS) {
      const explicit = this.#status.get(id);
      if (explicit !== undefined) streams[id] = explicit;
      else if (this.#streams[id] !== undefined) streams[id] = { status: 'present', schemaVersion: STREAM_SCHEMA_VERSIONS[id] };
      else streams[id] = { status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS[id] };
    }
    const clock: ClockMeta = {
      timeOrigin: this.#timeOrigin,
      captureStart: this.#captureStart,
      captureEnd: asRelMs(this.#maxTime),
      unit: 'ms',
      base: 'timeOrigin',
    };
    if (this.#precision !== undefined) clock.precision = this.#precision;
    return { clock, streams, config: this.#config };
  }
}
