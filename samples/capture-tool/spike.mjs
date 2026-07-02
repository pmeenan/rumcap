/*
 * The capture spike shared by the sample drivers (drive.mjs — public pages; drive-local.mjs — the
 * local fixture). Runs in the page at document-start. MUST be fully self-contained (puppeteer
 * serializes the function into the page), so no imports/closures over module state.
 *
 * Spike v3 extends the recorded live attribution (`__attribution`) with:
 *   - structured element attributes (`{tag, id, classes≤8, name}`) for the LCP element, layout-shift
 *     source nodes, event/first-input targets, and element-timing elements — grounding the model's
 *     structured `ElementRef`;
 *   - the element-timing `intersectionRect` read live (an entry's toJSON() serializes it as `{}`);
 *   - live `detail` for mark/measure entries (toJSON drops it), captured only when non-null;
 *   - live reads of the nested platform objects an entry-level toJSON() serializes as `{}` (their
 *     getters live on the prototype): `serverTiming` metrics, longtask `attribution`, and the
 *     navigation `notRestoredReasons` tree (each has its own working toJSON()).
 * The console variant for other browsers is capture-spike.js — keep the attribution logic in step.
 */
export function installSpike() {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_e) { /* ignore */ }
  // Keep our synthetic test clicks from navigating away — they still produce trusted Event Timing.
  addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (a) e.preventDefault();
  }, true);

  // ── JS Self-Profiling (Chromium-only) ──────────────────────────────────────────────────────────
  // Needs `Document-Policy: js-profiling` (injected via CDP by drive.mjs; served directly by
  // drive-local.mjs). Construct as early as possible (document-start) so the profile spans load.
  // VERIFIED on Chrome 149: sampleInterval is FLOORED at 10ms and quantized to multiples of 10 — a
  // requested 2 is delivered as 10. We record BOTH requested and actual so the clamp lives in the data
  // and is never assumed. maxBufferSize is a sample count (30000 @ 10ms ≈ 5 min, so it won't overflow
  // a normal page capture); `samplebufferfull` is wired anyway so truncation would be recorded, not lost.
  const PROFILER_REQ_INTERVAL_MS = 2;
  const PROFILER_MAX_BUFFER = 30000;
  let __profiler = null;
  let __profilerStatus = 'unsupported';
  let __profilerActualIntervalMs = null;
  let __profilerBufferFull = false;
  try {
    if (typeof Profiler === 'function') {
      __profiler = new Profiler({ sampleInterval: PROFILER_REQ_INTERVAL_MS, maxBufferSize: PROFILER_MAX_BUFFER });
      __profilerActualIntervalMs = __profiler.sampleInterval; // the UA's clamped/quantized value
      __profilerStatus = 'started';
      try { __profiler.addEventListener('samplebufferfull', () => { __profilerBufferFull = true; }); } catch (_e) { /* ignore */ }
    } else {
      __profilerStatus = 'no-constructor'; // API absent, or Document-Policy not applied to this response
    }
  } catch (e) {
    __profilerStatus = 'construct-threw: ' + (e && e.name) + ': ' + (e && e.message);
  }

  const STREAM_TYPES = ['navigation', 'resource', 'paint', 'largest-contentful-paint',
    'layout-shift', 'first-input', 'event', 'longtask', 'long-animation-frame',
    'element', 'mark', 'measure', 'visibility-state'];
  // Cap high-volume streams; the drop count itself grounds the manifest's loss/truncation concept.
  const CAP = { resource: 500, event: 300, 'layout-shift': 400, 'long-animation-frame': 200, longtask: 300 };

  const supported = (PerformanceObserver.supportedEntryTypes || []).slice();
  const streams = {};
  const observers = [];

  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let s = n.localName;
      if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
      if (n.classList && n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
      const parent = n.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.localName === n.localName);
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  // Structural attributes only (authored identity: tag/id/classes/name) — never element text.
  const elementAttrs = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const a = { tag: el.localName };
    if (el.id) a.id = el.id;
    if (el.classList && el.classList.length) a.classes = [...el.classList].slice(0, 8);
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) a.name = nm;
    return a;
  };

  // The live attribution toJSON() drops — the "must be captured live" set from the architecture.
  const attribution = (e) => {
    const a = {};
    if (e.entryType === 'largest-contentful-paint') {
      a.element = selectorFor(e.element); a.url = e.url || null;
      a.loadTime = e.loadTime; a.renderTime = e.renderTime; a.size = e.size;
      const attrs = elementAttrs(e.element);
      if (attrs) a.elementAttrs = attrs;
    } else if (e.entryType === 'layout-shift') {
      a.value = e.value; a.hadRecentInput = e.hadRecentInput;
      a.sources = (e.sources || []).map((s) => ({
        node: selectorFor(s.node),
        attrs: elementAttrs(s.node),
        previousRect: s.previousRect && s.previousRect.toJSON && s.previousRect.toJSON(),
        currentRect: s.currentRect && s.currentRect.toJSON && s.currentRect.toJSON(),
      }));
    } else if (e.entryType === 'event' || e.entryType === 'first-input') {
      a.name = e.name; a.target = selectorFor(e.target); a.interactionId = e.interactionId;
      a.processingStart = e.processingStart; a.processingEnd = e.processingEnd;
      const attrs = elementAttrs(e.target);
      if (attrs) a.targetAttrs = attrs;
    } else if (e.entryType === 'long-animation-frame') {
      a.scripts = (e.scripts || []).map((s) => (s.toJSON ? s.toJSON() : { ...s }));
    } else if (e.entryType === 'element') {
      a.element = selectorFor(e.element); a.identifier = e.identifier; a.url = e.url || null;
      const attrs = elementAttrs(e.element);
      if (attrs) a.elementAttrs = attrs;
      // Belt-and-braces: also read the intersection rect live, in case toJSON omits it.
      if (e.intersectionRect && e.intersectionRect.toJSON) a.intersectionRect = e.intersectionRect.toJSON();
    } else if (e.entryType === 'mark' || e.entryType === 'measure') {
      // Live `detail` (toJSON drops it). null is the platform default for "none" — skip it.
      if (e.detail !== null && e.detail !== undefined) a.detail = e.detail;
    } else if (e.entryType === 'longtask') {
      // TaskAttributionTiming serializes as {} through the parent's toJSON — read each live.
      a.attribution = [...(e.attribution || [])].map((t) => (t.toJSON ? t.toJSON() : Object.assign({}, t)));
    }
    if (e.entryType === 'navigation' || e.entryType === 'resource') {
      // PerformanceServerTiming also serializes as {} through the parent's toJSON.
      if (e.serverTiming && e.serverTiming.length) {
        a.serverTiming = [...e.serverTiming].map((s) => (s.toJSON ? s.toJSON() : Object.assign({}, s)));
      }
      if (e.entryType === 'navigation' && e.notRestoredReasons !== undefined) {
        // NotRestoredReasons has its own toJSON() (the parent's serializes it as {}); null is the
        // spec's real "restorable / not a history nav" answer and is kept.
        const nrr = e.notRestoredReasons;
        a.notRestoredReasons = nrr && nrr.toJSON ? nrr.toJSON() : nrr;
      }
    }
    return a;
  };

  const record = (list) => {
    for (const e of list.getEntries()) {
      const t = e.entryType;
      const s = (streams[t] || (streams[t] = { status: 'present', entries: [], dropped: 0 }));
      const cap = CAP[t];
      if (cap && s.entries.length >= cap) { s.dropped++; s.loss = 'capped at ' + cap; continue; }
      const row = e.toJSON ? e.toJSON() : Object.assign({}, e);
      const attr = attribution(e);
      if (Object.keys(attr).length) row.__attribution = attr;
      s.entries.push(row);
    }
  };

  for (const type of STREAM_TYPES) {
    if (!supported.includes(type)) { streams[type] = { status: 'unsupported', entries: [] }; continue; }
    try {
      const po = new PerformanceObserver(record);
      const opts = { type, buffered: true };
      if (type === 'event') opts.durationThreshold = 16; // capture short interactions too
      po.observe(opts);
      observers.push(po);
      if (!streams[type]) streams[type] = { status: 'present', entries: [], dropped: 0 };
    } catch (err) {
      streams[type] = { status: 'observe-threw', error: String(err), entries: [] };
    }
  }

  window.__rumFinalize = async () => {
    // Stop the profiler FIRST so its trace covers the whole session up to finalize. stop() is async
    // (it flushes the sampling buffer and resolves with the ProfilerTrace); puppeteer awaits the
    // promise this function returns. The trace is the raw, interned JS Self-Profiling shape —
    // resources[]/frames[]/stacks[]/samples[] — left UNTRANSFORMED here (no slice synthesis): the
    // corpus is ground truth; deriving timed slices is the codec/analysis layer's job.
    let profile;
    if (__profiler) {
      try {
        const trace = await __profiler.stop();
        profile = {
          status: 'present',
          requestedSampleIntervalMs: PROFILER_REQ_INTERVAL_MS,
          actualSampleIntervalMs: __profilerActualIntervalMs,
          maxBufferSize: PROFILER_MAX_BUFFER,
          sampleBufferFull: __profilerBufferFull,
          resources: trace.resources,
          frames: trace.frames,
          stacks: trace.stacks,
          samples: trace.samples,
          counts: {
            resources: trace.resources.length, frames: trace.frames.length,
            stacks: trace.stacks.length, samples: trace.samples.length,
          },
        };
      } catch (e) {
        profile = {
          status: 'stop-threw', error: String(e),
          requestedSampleIntervalMs: PROFILER_REQ_INTERVAL_MS, actualSampleIntervalMs: __profilerActualIntervalMs,
        };
      }
    } else {
      profile = { status: __profilerStatus, requestedSampleIntervalMs: PROFILER_REQ_INTERVAL_MS };
    }

    // Flush buffered-but-undelivered records via takeRecords() — record() needs a getEntries()-like
    // list, not the observer itself (the old `record(po)` silently threw and dropped the tail).
    for (const po of observers) {
      try {
        const pending = po.takeRecords();
        if (pending && pending.length) record({ getEntries: () => pending });
      } catch (_e) { /* ignore */ }
      try { po.disconnect(); } catch (_e) { /* ignore */ }
    }
    const txt = (document.body && document.body.innerText) || '';
    const nav = navigator;
    return {
      spikeVersion: 3, // 3: structured element attrs + element-timing intersectionRect + live mark/measure detail
      url: location.href,
      title: document.title,
      bodyTextLength: txt.length, // length only — never store page text (PII)
      looksBlocked: /are you a robot|enable javascript|access denied|before you continue|verify you are human|unusual traffic/i.test(txt.slice(0, 4000)),
      clock: {
        timeOrigin: performance.timeOrigin,
        now: performance.now(),
        timestampUnit: 'ms', // DOMHighResTimeStamp: ms, double, relative to timeOrigin
        timestampBase: 'timeOrigin',
      },
      supportedEntryTypes: supported,
      environment: {
        userAgent: nav.userAgent,
        userAgentData: nav.userAgentData
          ? { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform }
          : null,
        deviceMemory: nav.deviceMemory != null ? nav.deviceMemory : null,
        hardwareConcurrency: nav.hardwareConcurrency != null ? nav.hardwareConcurrency : null,
        connection: nav.connection
          ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData }
          : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio,
        // Reflect the ACTUAL outcome: the driver injects/serves the Document-Policy, so when the
        // profiler truly started this is 'available' (matching the populated profile stream) — not the
        // bare-feature-detect 'needs-document-policy' a page without the header would report.
        selfProfiler: __profilerStatus === 'started' ? 'available'
          : (typeof window.Profiler !== 'undefined' ? 'needs-document-policy' : 'unsupported'),
      },
      streams,
      profile,
    };
  };
}
