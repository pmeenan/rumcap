/*
 * rumcap capture spike  —  THROWAWAY, NOT SHIPPED CODE.
 *
 * Purpose: ground the `format` schema in real browser output instead of memory.
 * Paste into a DevTools console (or inject) on a few public pages across
 * Chrome / Safari / Firefox. It records, per entry type:
 *   - whether the browser supports it      (seeds manifest status: present|unsupported)
 *   - the raw entry via toJSON()           (the wire-shape candidate)
 *   - the live attribution toJSON() drops  (LCP element, CLS sources, INP/event target)
 * and the clock + environment metadata. Output auto-downloads as JSON and is the
 * first golden-corpus seed. Degraded variants (Safari-subset, no-profiler) come for
 * free by running this on those browsers.
 *
 * Interact with the page (click/scroll/type) before it finalizes so INP/LCP/CLS settle.
 */
(() => {
  const STREAM_TYPES = [
    'navigation', 'resource', 'paint',
    'largest-contentful-paint', 'layout-shift',
    'first-input', 'event',
    'longtask', 'long-animation-frame',
    'element', 'mark', 'measure',
    'visibility-state',
  ];

  const supported = (PerformanceObserver.supportedEntryTypes || []).slice();
  const streams = {};            // type -> { status, entries: [] }
  const observers = [];

  // A short, structural CSS-path for an element — enough to identify it, no innerText (PII).
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
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  // toJSON() flattens the standard fields but DROPS the live DOM refs that can't be
  // recovered offline. This is exactly the "must be captured live" set from the architecture.
  const attribution = (e) => {
    const a = {};
    if (e.entryType === 'largest-contentful-paint') {
      a.element = selectorFor(e.element);
      a.url = e.url || null;
      a.loadTime = e.loadTime; a.renderTime = e.renderTime; a.size = e.size;
    } else if (e.entryType === 'layout-shift') {
      a.value = e.value; a.hadRecentInput = e.hadRecentInput;
      a.sources = (e.sources || []).map((s) => ({
        node: selectorFor(s.node),
        previousRect: s.previousRect && s.previousRect.toJSON?.(),
        currentRect: s.currentRect && s.currentRect.toJSON?.(),
      }));
    } else if (e.entryType === 'event' || e.entryType === 'first-input') {
      a.name = e.name; a.target = selectorFor(e.target);
      a.interactionId = e.interactionId;
      a.processingStart = e.processingStart; a.processingEnd = e.processingEnd;
    } else if (e.entryType === 'long-animation-frame') {
      // LoAF carries nested scripts[] with their own attribution — capture the shape.
      a.scripts = (e.scripts || []).map((s) => (s.toJSON ? s.toJSON() : { ...s }));
    } else if (e.entryType === 'element') {
      a.element = selectorFor(e.element); a.identifier = e.identifier; a.url = e.url || null;
    }
    return a;
  };

  const record = (list) => {
    for (const e of list.getEntries()) {
      const t = e.entryType;
      (streams[t] ||= { status: 'present', entries: [] });
      const row = e.toJSON ? e.toJSON() : { ...e };
      const attr = attribution(e);
      if (Object.keys(attr).length) row.__attribution = attr;
      streams[t].entries.push(row);
    }
  };

  for (const type of STREAM_TYPES) {
    if (!supported.includes(type)) { streams[type] = { status: 'unsupported', entries: [] }; continue; }
    try {
      const po = new PerformanceObserver(record);
      po.observe({ type, buffered: true });
      observers.push(po);
      streams[type] ||= { status: 'present', entries: [] };
    } catch (err) {
      // observe() can still throw even when listed (e.g. policy / partial support) — record why.
      streams[type] = { status: 'observe-threw', error: String(err), entries: [] };
    }
  }

  const env = () => ({
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData
      ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
      : null,
    deviceMemory: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    connection: navigator.connection
      ? { effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt, downlink: navigator.connection.downlink, saveData: navigator.connection.saveData }
      : null,
    // Viewport/screen geometry (CSS px) — for CLS normalization and above-the-fold checks.
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    // Self-profiling availability — Chromium-only + needs Document-Policy header; just probe presence.
    selfProfiler: typeof window.Profiler !== 'undefined' ? 'needs-document-policy' : 'unsupported',
  });

  const finalize = () => {
    // Flush buffered-but-undelivered records via takeRecords() — record() needs a getEntries()-like
    // list, not the observer itself (the old `record(po)` silently threw and dropped the tail).
    for (const po of observers) {
      try {
        const pending = po.takeRecords();
        if (pending && pending.length) record({ getEntries: () => pending });
      } catch { /* ignore */ }
      try { po.disconnect(); } catch { /* ignore */ }
    }
    const out = {
      spikeVersion: 1,
      url: location.href,
      capturedAt: new Date().toISOString(),
      clock: {
        timeOrigin: performance.timeOrigin,
        now: performance.now(),
        timestampUnit: 'ms',          // DOMHighResTimeStamp — ms, double, relative to timeOrigin
        timestampBase: 'timeOrigin',
      },
      supportedEntryTypes: supported,
      environment: env(),
      streams,
    };
    const json = JSON.stringify(out, null, 2);
    try {
      const host = location.hostname.replace(/[^a-z0-9]+/gi, '-');
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rumspike-${host}-${Math.round(performance.now())}.json`;
      a.click();
    } catch { /* ignore */ }
    window.__rumSpike = out;
    console.log('[rum-spike] done — window.__rumSpike, also downloaded. Streams:',
      Object.fromEntries(Object.entries(streams).map(([k, v]) => [k, `${v.status}/${v.entries.length}`])));
    return out;
  };

  // Finalize on first hide (mirrors the real unload path) OR after 8s, whichever first.
  const once = (fn) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };
  const fin = once(finalize);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') fin(); }, { once: true });
  setTimeout(fin, 8000);
  console.log('[rum-spike] observing… interact with the page, then switch tabs or wait 8s.');
})();
