// rumcap capture demo — a REFERENCE consumer of the `rumcap` library, not shipped product.
//
// It shows the intended shape of a capture: bring your own PerformanceObservers + the JS Self-Profiler,
// normalize each browser entry to the rumcap model, and stream it into an `Encoder`. Custom app spans
// are authored with the stack-based timeline API. On page-hide it calls `encoder.finish()` and downloads
// the packed `.rcap`. Everything here is browser code observing standard Web Performance APIs — the
// measurement comes 100% from the page, exactly as a real integration would.
//
// This file deliberately favors clarity over completeness: it maps the common fields of each stream to
// demonstrate the pattern, not every optional the format models.

import { Encoder, ENTRY_TYPE_TO_STREAM, FILE_EXTENSION } from 'rumcap/encode';

// A short, structural CSS-path for an element — enough to identify it, never its text content (PII).
function selectorFor(el) {
  if (!el || el.nodeType !== 1) return undefined;
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 5) {
    let s = n.localName;
    if (n.id) {
      s += '#' + n.id;
      parts.unshift(s);
      break;
    }
    if (n.classList && n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
    const parent = n.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.localName === n.localName);
      if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
    }
    parts.unshift(s);
    n = n.parentElement;
  }
  return parts.join(' > ');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// A timestamp where the platform uses 0 as its "did not occur / not available" sentinel (resource and
// navigation phases, LCP renderTime without Timing-Allow-Origin, LCP loadTime on text LCP, the LoAF
// render/style/UI-event/paint timestamps): drop the sentinel — the format distinguishes absent from a
// real 0-offset, and these are the former. Durations (0 is a real measured value) do NOT go through this.
const phase = (v) => (isNum(v) && v > 0 ? v : undefined);

// Copy a fixed set of keys from a raw entry when present (skips null/undefined; keeps real '' and 0).
function pick(target, src, keys, transform = (v) => v) {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) target[k] = transform(v);
  }
  return target;
}

// Copy timestamp keys through the `phase` sentinel mapping (0 → absent).
function pickPhases(target, src, keys) {
  for (const k of keys) {
    const v = phase(src[k]);
    if (v !== undefined) target[k] = v;
  }
  return target;
}

// PerformanceResourceTiming → ResourceTimingEntry (the shared model shape).
function normResource(e) {
  const r = { name: e.name, startTime: e.startTime, duration: e.duration, initiatorType: e.initiatorType };
  pick(r, e, ['deliveryType', 'nextHopProtocol', 'renderBlockingStatus', 'contentType', 'contentEncoding']);
  pickPhases(r, e, [
    'workerStart', 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd',
    'connectStart', 'secureConnectionStart', 'connectEnd', 'requestStart',
    'firstInterimResponseStart', 'finalResponseHeadersStart', 'responseStart', 'responseEnd',
  ]);
  pick(r, e, ['transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStatus']);
  if (Array.isArray(e.serverTiming)) {
    r.serverTiming = e.serverTiming.map((st) => pick({ name: st.name }, st, ['duration', 'description']));
  }
  return r;
}

// PerformanceNavigationTiming → NavigationTimingEntry (resource fields + navigation extras).
function normNavigation(e) {
  const nav = normResource(e);
  nav.initiatorType = e.initiatorType || 'navigation';
  nav.type = e.type;
  nav.redirectCount = e.redirectCount ?? 0;
  pickPhases(nav, e, [
    'unloadEventStart', 'unloadEventEnd', 'domInteractive', 'domContentLoadedEventStart',
    'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd', 'activationStart',
  ]);
  return nav;
}

function readEnvironment() {
  const env = {};
  if (navigator.userAgent) env.userAgent = navigator.userAgent;
  const ua = navigator.userAgentData;
  if (ua) {
    env.userAgentData = {
      brands: (ua.brands ?? []).map((b) => ({ brand: b.brand, version: b.version })),
      mobile: !!ua.mobile,
      platform: ua.platform ?? '',
    };
  }
  if (isNum(navigator.deviceMemory)) env.deviceMemory = navigator.deviceMemory;
  if (isNum(navigator.hardwareConcurrency)) env.hardwareConcurrency = navigator.hardwareConcurrency;
  const c = navigator.connection;
  if (c) env.connection = pick({}, c, ['effectiveType', 'rtt', 'downlink', 'saveData']);
  env.viewportWidth = innerWidth;
  env.viewportHeight = innerHeight;
  env.screenWidth = screen.width;
  env.screenHeight = screen.height;
  env.devicePixelRatio = devicePixelRatio;
  env.selfProfiler = typeof self.Profiler !== 'undefined' ? 'available' : 'unsupported';
  return env;
}

/**
 * Start a capture session. Returns `{ encoder, save, isSaved }` — `save()` finalizes and downloads the
 * `.rcap`. The session also auto-saves on the first `visibilitychange`→hidden (the real unload signal);
 * after that the encoder is finished and further feeds throw, so UI code should check `isSaved()`.
 */
export function startCapture({ metadata = {}, sampleIntervalMs = 10 } = {}) {
  const enc = new Encoder({
    metadata: { page: location.href, capturedAt: new Date().toISOString(), ...metadata },
    sampleIntervalMs,
    // (real code may probe timer coarsening and pass `precision`)
  });

  enc.setEnvironment(readEnvironment());

  // Accumulators for the two streams that are "set" (replaced) rather than "added" to.
  const paint = {};
  const lcp = {};
  const observers = []; // { po, handle } — kept together so save() can flush takeRecords() through handle

  // observe({type}) on an unsupported type does NOT throw — per the Performance Timeline spec it logs a
  // console warning and returns — so "unsupported" must be detected up front from supportedEntryTypes.
  // The try/catch below only guards legacy engines (no PerformanceObserver / no `type` member).
  const supportedTypes =
    (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
  const wanted = new Set(); // streams this demo attempts (via any entry type)
  const wired = new Set(); // streams with at least one live observer
  const observe = (type, handle, options = {}) => {
    const stream = ENTRY_TYPE_TO_STREAM[type];
    if (stream) wanted.add(stream);
    if (!supportedTypes.includes(type)) return;
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) handle(e);
      });
      po.observe({ type, buffered: true, ...options });
      observers.push({ po, handle });
      if (stream) wired.add(stream);
    } catch {
      /* legacy engine — the wanted/wired diff below records the absence */
    }
  };

  observe('navigation', (e) => enc.setNavigation(normNavigation(e)));
  observe('resource', (e) => enc.addResource(normResource(e)));
  observe('paint', (e) => {
    const p = { startTime: e.startTime };
    if (e.name === 'first-paint') paint.firstPaint = p;
    else if (e.name === 'first-contentful-paint') paint.firstContentfulPaint = p;
    enc.setPaint(paint);
  });
  observe('largest-contentful-paint', (e) => {
    const entry = pick({ startTime: e.startTime, size: e.size }, e, ['url']);
    // renderTime is 0 without Timing-Allow-Origin; loadTime is 0 for text LCP — sentinels, not paints.
    pickPhases(entry, e, ['renderTime', 'loadTime']);
    const sel = selectorFor(e.element);
    if (sel) entry.element = { selector: sel };
    (lcp.candidates ??= []).push(entry);
    lcp.final = entry; // the latest candidate is the current LCP
    enc.setLcp(lcp);
  });
  observe('layout-shift', (e) => {
    const shift = { startTime: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput };
    if (Array.isArray(e.sources)) {
      shift.sources = e.sources.map((s) => {
        const src = {};
        const sel = selectorFor(s.node);
        if (sel) src.node = { selector: sel };
        if (s.previousRect) src.previousRect = s.previousRect.toJSON?.() ?? s.previousRect;
        if (s.currentRect) src.currentRect = s.currentRect.toJSON?.() ?? s.currentRect;
        return src;
      });
    }
    enc.addLayoutShift(shift);
  });
  // The first user interaction arrives TWICE by spec: once as an `event` entry and once as a
  // threshold-exempt `first-input` copy of it. Merge the pair onto one recorded entry (keyed by
  // startTime+name, whichever copy is delivered first) instead of double-counting the interaction.
  const seenInteractions = new Map();
  const onInteraction = (e) => {
    const key = `${e.startTime}|${e.name}`;
    const existing = seenInteractions.get(key);
    if (existing) {
      if (e.entryType === 'first-input') existing.firstInput = true;
      return;
    }
    const it = { name: e.name, startTime: e.startTime, duration: e.duration };
    pick(it, e, ['processingStart', 'processingEnd', 'interactionId', 'cancelable']);
    if (e.entryType === 'first-input') it.firstInput = true;
    const sel = selectorFor(e.target);
    if (sel) it.target = { selector: sel };
    seenInteractions.set(key, it);
    enc.addInteraction(it);
  };
  // durationThreshold 16 (the spec floor): the default is 104ms, which silently drops nearly every
  // ordinary fast interaction — the repo's own sample captures show almost all event entries below it.
  observe('event', onInteraction, { durationThreshold: 16 });
  observe('first-input', onInteraction);
  observe('longtask', (e) => {
    const t = { startTime: e.startTime, duration: e.duration };
    if (Array.isArray(e.attribution)) t.attribution = e.attribution.map((a) => pick({}, a, ['name', 'containerType', 'containerName', 'containerId', 'containerSrc']));
    enc.addLongTask(t);
  });
  observe('long-animation-frame', (e) => {
    const f = { startTime: e.startTime, duration: e.duration };
    // renderStart/styleAndLayoutStart/firstUIEventTimestamp/paintTime/presentationTime report 0 when
    // that phase/event did not occur (pervasive in the real sample captures) — map 0 → absent.
    // blockingDuration is a DURATION: 0 is a real measured value and is kept.
    pickPhases(f, e, ['renderStart', 'styleAndLayoutStart', 'firstUIEventTimestamp', 'paintTime', 'presentationTime']);
    pick(f, e, ['blockingDuration']);
    if (Array.isArray(e.scripts)) {
      f.scripts = e.scripts.map((s) => {
        const script = pick({ startTime: s.startTime, duration: s.duration }, s, [
          'invokerType', 'invoker', 'executionStart', 'forcedStyleAndLayoutDuration', 'pauseDuration',
          'sourceURL', 'sourceFunctionName', 'windowAttribution',
        ]);
        // Chrome reports -1 for "unknown char position" (15+ occurrences per real sample capture); the
        // model wants the field absent — and the codec's non-negative varuint would rightly throw.
        if (isNum(s.sourceCharPosition) && s.sourceCharPosition >= 0) script.sourceCharPosition = s.sourceCharPosition;
        return script;
      });
    }
    enc.addLoaf(f);
  });
  observe('element', (e) => {
    const el = pick({ startTime: e.startTime }, e, ['identifier', 'url', 'naturalWidth', 'naturalHeight']);
    pickPhases(el, e, ['renderTime', 'loadTime']); // same 0-sentinel rule as LCP
    const sel = selectorFor(e.element);
    if (sel) el.element = { selector: sel };
    enc.addElementTiming(el);
  });
  observe('mark', (e) => enc.mark(pick({ name: e.name, startTime: e.startTime }, e, ['detail'])));
  observe('measure', (e) => enc.measure(pick({ name: e.name, startTime: e.startTime, duration: e.duration }, e, ['detail'])));
  observe('visibility-state', (e) => enc.addVisibility({ state: e.name, startTime: e.startTime }));

  // A stream every attempted entry type failed to wire is genuinely unavailable on this browser.
  // (Marked per stream, not per type: `event` and `first-input` both feed interactions, and one of the
  // pair being missing must not override a stream that IS receiving data.)
  for (const stream of wanted) {
    if (!wired.has(stream)) enc.markStream(stream, 'unsupported');
  }

  // Named handlers so save() can detach them — a finished encoder throws on further feeds, and a page
  // error after auto-save must not turn into an exception inside the error handler itself.
  const onWindowError = (ev) => {
    const entry = pick({ startTime: performance.now(), kind: 'error' }, ev, ['message', 'lineno', 'colno']);
    // The browser event calls it `filename`; the model field is `source` (the descriptor-driven codec
    // encodes only model keys, so an unrenamed `filename` would be silently dropped).
    if (typeof ev.filename === 'string' && ev.filename !== '') entry.source = ev.filename;
    enc.addError(entry);
  };
  const onRejection = (ev) => {
    enc.addError({ startTime: performance.now(), kind: 'unhandledrejection', message: String(ev.reason?.message ?? ev.reason ?? '') });
  };
  addEventListener('error', onWindowError);
  addEventListener('unhandledrejection', onRejection);

  let saved = false;

  // ── JS Self-Profiler: incremental fold (needs the `Document-Policy: js-profiling` response header) ──
  let profiler = null;
  const startProfiler = () => {
    if (typeof self.Profiler === 'undefined') {
      enc.markStream('profile', 'policy-blocked'); // header missing / API unavailable — record why
      return;
    }
    try {
      profiler = new self.Profiler({ sampleInterval: sampleIntervalMs, maxBufferSize: 30000 });
    } catch {
      enc.markStream('profile', 'policy-blocked');
    }
  };
  const checkpointProfiler = async () => {
    if (!profiler) return;
    const p = profiler;
    profiler = null;
    try {
      const trace = await p.stop(); // raw ProfilerTrace: { frames, resources, stacks, samples }
      trace.sampleIntervalMs = p.sampleInterval ?? sampleIntervalMs;
      enc.addProfilerChunk(trace); // folded to slices immediately (SliceBuilder), so unload stays cheap
    } catch {
      /* stop() can reject if already stopped */
    }
  };
  startProfiler();
  // Fold at idle-ish checkpoints during the session, then restart — demonstrates the incremental seam.
  // The chain lives in `pendingCheckpoint` so save() AWAITS an in-flight fold (keeping its chunk)
  // instead of skipping it, and the restart is gated on `saved` so no profiler is left running forever.
  let pendingCheckpoint = Promise.resolve();
  const interval = setInterval(() => {
    pendingCheckpoint = checkpointProfiler().then(() => {
      if (!saved) startProfiler();
    });
  }, 5000);

  // A custom app timeline: stack-based spans generate nested events (depth from the call stack). The
  // demo page drives it from real user actions (see index.html) — startCapture itself adds no
  // synthetic work, since the extension harness injects this file into every page you browse.
  enc.timeline('demo-app');

  async function save() {
    if (saved) return null;
    saved = true;
    clearInterval(interval);
    removeEventListener('visibilitychange', onHidden);
    removeEventListener('error', onWindowError);
    removeEventListener('unhandledrejection', onRejection);
    // Deliver-then-disconnect: entries can sit undelivered in an observer's queue (delivery is an async
    // task), and a bare disconnect() drops exactly the tail of the session — the interaction that ended
    // it. Flush each queue through the observer's own handler first.
    for (const { po, handle } of observers) {
      try {
        for (const e of po.takeRecords()) handle(e);
        po.disconnect();
      } catch {
        /* ignore */
      }
    }
    await pendingCheckpoint; // an in-flight 5s fold lands its chunk…
    await checkpointProfiler(); // …then the final profiler tail is folded, not dropped
    const bytes = await enc.finish();
    download(bytes, `capture-${location.hostname || 'page'}-${Math.round(performance.now())}${FILE_EXTENSION}`);
    return bytes;
  }

  // Save on the first hide (the real unload path).
  const onHidden = () => {
    if (document.visibilityState === 'hidden') void save();
  };
  addEventListener('visibilitychange', onHidden);

  return { encoder: enc, save, isSaved: () => saved };
}

function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
