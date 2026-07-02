// rumcap capture demo — a REFERENCE consumer of the `rumcap` library, not shipped product.
//
// It shows the intended shape of a capture: wire your own PerformanceObservers straight into the
// library's `entrySink` (normalization onto the model — sentinel stripping, first-input dedup, LCP/paint
// accumulation — happens inside `rumcap`), run the JS Self-Profiler with incremental folding, author
// custom app spans with the stack-based timeline API, and `finish()` → download the packed `.rcap` on
// page-hide. What stays HERE is exactly the capture-session policy a consumer owns: which streams to
// observe, the profiler lifecycle, when to save, and where the bytes go.

import {
  Encoder,
  entrySink,
  environmentSnapshot,
  normalizeErrorEvent,
  normalizeRejection,
  ENTRY_TYPE_TO_STREAM,
  FILE_EXTENSION,
} from 'rumcap/encode';

// Every observer-sourced entry type the format models. `event` gets durationThreshold 16 (the spec
// floor): the default 104ms silently drops nearly every ordinary fast interaction — the repo's own
// sample captures show almost all event entries below it.
const OBSERVED_TYPES = [
  'navigation',
  'resource',
  'paint',
  'largest-contentful-paint',
  'layout-shift',
  'event',
  'first-input',
  'longtask',
  'long-animation-frame',
  'element',
  'mark',
  'measure',
  'visibility-state',
];

/**
 * Start a capture session. Returns `{ encoder, save, isSaved }` — `save()` finalizes and downloads the
 * `.rcap`. The session also auto-saves on the first `visibilitychange`→hidden (the real unload signal);
 * after that the encoder is finished and the sink drops late deliveries, so UI code should check
 * `isSaved()` before feeding more.
 */
export function startCapture({ metadata = {}, sampleIntervalMs = 10 } = {}) {
  const enc = new Encoder({
    metadata: { page: location.href, capturedAt: new Date().toISOString(), ...metadata },
    sampleIntervalMs,
    // (real code may probe timer coarsening and pass `precision`)
  });
  enc.setEnvironment(environmentSnapshot());

  // One sink is the observer callback for every entry type; it normalizes and routes internally.
  const sink = entrySink(enc);
  const observers = [];

  // observe({type}) on an unsupported type does NOT throw — per the Performance Timeline spec it logs a
  // console warning and returns — so "unsupported" must be detected up front from supportedEntryTypes.
  // The try/catch only guards legacy engines (no PerformanceObserver / no `type` member).
  const supportedTypes =
    (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
  const wanted = new Set(); // streams this demo attempts (via any entry type)
  const wired = new Set(); // streams with at least one live observer
  for (const type of OBSERVED_TYPES) {
    const stream = ENTRY_TYPE_TO_STREAM[type];
    if (stream) wanted.add(stream);
    if (!supportedTypes.includes(type)) continue;
    try {
      const po = new PerformanceObserver(sink);
      po.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
      observers.push(po);
      if (stream) wired.add(stream);
    } catch {
      /* legacy engine — the wanted/wired diff below records the absence */
    }
  }
  // A stream every attempted entry type failed to wire is genuinely unavailable on this browser.
  // (Per stream, not per type: `event` and `first-input` both feed interactions, and one of the pair
  // being missing must not override a stream that IS receiving data.)
  for (const stream of wanted) {
    if (!wired.has(stream)) enc.markStream(stream, 'unsupported');
  }

  // Errors aren't PerformanceObserver sources — hook the window events; the library maps the field
  // renames (event `filename` → model `source`) and sentinel drops.
  const onWindowError = (ev) => {
    if (!enc.finished) enc.addError(normalizeErrorEvent(ev));
  };
  const onRejection = (ev) => {
    if (!enc.finished) enc.addError(normalizeRejection(ev));
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
      // Pass the ACTUAL (clamped) interval alongside — Chrome floors a requested 2ms to 10ms.
      enc.addProfilerChunk(trace, p.sampleInterval ?? sampleIntervalMs); // folded to slices immediately
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
    // it. Flush each queue through the sink first (takeRecords returns a plain entry list).
    for (const po of observers) {
      try {
        sink(po.takeRecords());
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
