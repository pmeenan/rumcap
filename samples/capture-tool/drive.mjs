/*
 * rumcap — format sample capture driver.
 * Drives system Chrome (headed under xvfb) across a set of real public pages,
 * injects the observer spike at document-start, does light trusted interactions
 * to elicit Event Timing / INP / LoAF, and writes one JSON capture per site to
 * ../json/ (regenerating samples). Public pages only; no upload.
 * See ../README.md for how/when these were captured and the known caveats.
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Writes into the committed sample dir so re-running updates samples/json in place.
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URLS = [
  'https://www.cnn.com/2026/06/28/world/live-news/iran-war-strikes-trump',
  'https://www.google.com/finance/beta',
  'https://v0.app/',
  'https://www.etsy.com/r/curated/etsy-staff-picks?sections=1471830136820',
];

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Optional CPU throttling — the DevTools "Nx slowdown" (CDP Emulation.setCPUThrottlingRate). Set
// CPU_THROTTLE=6 to capture worst-case, heavily main-thread-bound profiles into a SEPARATE
// `chrome-<host>-cpuNx.json` corpus variant; the normal-speed corpus is left untouched. 0/1 = off.
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE) || 0;
const FILE_SUFFIX = CPU_THROTTLE > 1 ? `-cpu${CPU_THROTTLE}x` : '';

// Runs in the page at document-start. Must be fully self-contained (puppeteer serializes it).
function installSpike() {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_e) { /* ignore */ }
  // Keep our synthetic test clicks from navigating away — they still produce trusted Event Timing.
  addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (a) e.preventDefault();
  }, true);

  // ── JS Self-Profiling (Chromium-only) ──────────────────────────────────────────────────────────
  // Needs `Document-Policy: js-profiling`, which the driver injects on the document response via CDP
  // (see capture()). Construct as early as possible (document-start) so the profile spans load.
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

  // The live attribution toJSON() drops — the "must be captured live" set from the architecture.
  const attribution = (e) => {
    const a = {};
    if (e.entryType === 'largest-contentful-paint') {
      a.element = selectorFor(e.element); a.url = e.url || null;
      a.loadTime = e.loadTime; a.renderTime = e.renderTime; a.size = e.size;
    } else if (e.entryType === 'layout-shift') {
      a.value = e.value; a.hadRecentInput = e.hadRecentInput;
      a.sources = (e.sources || []).map((s) => ({
        node: selectorFor(s.node),
        previousRect: s.previousRect && s.previousRect.toJSON && s.previousRect.toJSON(),
        currentRect: s.currentRect && s.currentRect.toJSON && s.currentRect.toJSON(),
      }));
    } else if (e.entryType === 'event' || e.entryType === 'first-input') {
      a.name = e.name; a.target = selectorFor(e.target); a.interactionId = e.interactionId;
      a.processingStart = e.processingStart; a.processingEnd = e.processingEnd;
    } else if (e.entryType === 'long-animation-frame') {
      a.scripts = (e.scripts || []).map((s) => (s.toJSON ? s.toJSON() : { ...s }));
    } else if (e.entryType === 'element') {
      a.element = selectorFor(e.element); a.identifier = e.identifier; a.url = e.url || null;
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
      spikeVersion: 2, // 2: adds the `profile` stream (JS Self-Profiling) + async finalize
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
        // Reflect the ACTUAL outcome: the driver injects the Document-Policy, so when the profiler
        // truly started this is 'available' (matching the populated profile stream) — not the
        // bare-feature-detect 'needs-document-policy' a page without the header would report.
        selfProfiler: __profilerStatus === 'started' ? 'available'
          : (typeof window.Profiler !== 'undefined' ? 'needs-document-policy' : 'unsupported'),
      },
      streams,
      profile,
    };
  };
}

async function capture(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

  // Inject `Document-Policy: js-profiling` onto the document response so the in-page Profiler can
  // start. This is a HARNESS action (enabling a header the API requires) — NOT a measurement source:
  // the profile data still comes 100% from the in-page JS Self-Profiling API, honoring the project's
  // "extension/harness must not measure via privileged APIs" boundary. We pause only Document
  // responses (cheap) and continue everything unmodified on error so a request can never hang.
  const client = await page.target().createCDPSession();
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
  client.on('Fetch.requestPaused', async (e) => {
    try {
      const hdrs = (e.responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'document-policy');
      const existing = (e.responseHeaders || []).find((h) => h.name.toLowerCase() === 'document-policy');
      const value = existing && existing.value
        ? (/js-profiling/.test(existing.value) ? existing.value : existing.value + ', js-profiling')
        : 'js-profiling';
      hdrs.push({ name: 'Document-Policy', value });
      await client.send('Fetch.continueResponse', { requestId: e.requestId, responseCode: e.responseStatusCode ?? 200, responseHeaders: hdrs });
    } catch (_err) {
      try { await client.send('Fetch.continueResponse', { requestId: e.requestId }); } catch (_e2) { /* request already gone */ }
    }
  });

  // Worst-case CPU: DevTools-style throttle, applied before navigation so it covers load too. The JS
  // Self-Profiling sampler is wall-clock-based, so this doesn't change the ~10ms cadence — it keeps the
  // main thread busy/blocked far more, yielding longer contiguous runs (more, longer slices), exactly
  // the worst case the slice transform must handle.
  if (CPU_THROTTLE > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  // Throttled pages load/settle slower, so wait proportionally longer (normal runs are unchanged).
  const settle = CPU_THROTTLE > 1 ? 1.5 : 1;

  await page.evaluateOnNewDocument(installSpike);

  let navStatus = 'ok';
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { navStatus = 'goto: ' + e.message; }

  await sleep(3500 * settle); // let LCP candidates / late resources settle
  try {
    await page.mouse.move(500, 360);
    await page.mouse.click(70, 220, { delay: 40 });   // trusted click -> Event Timing / INP
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(400);
    await page.mouse.click(540, 420, { delay: 40 });
    await page.evaluate(() => window.scrollBy(0, 900));
    // Extra scroll-driven activity so the 10ms-floored profile is denser (more on-thread JS to sample).
    await sleep(600);
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(400);
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (_e) { /* ignore */ }
  await sleep(2000 * settle);

  let data;
  try { data = await page.evaluate(() => (window.__rumFinalize ? window.__rumFinalize() : { error: 'no-finalize' })); }
  catch (e) { data = { error: 'evaluate-failed: ' + e.message }; }
  data.finalUrl = page.url();
  data.navStatus = navStatus;
  data.cpuThrottleRate = CPU_THROTTLE > 1 ? CPU_THROTTLE : 1; // 1 = unthrottled
  await page.close();
  return data;
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: false, // headed under xvfb — most real-browser-like
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en', '--window-size=1366,768', '--disable-dev-shm-usage'],
});

if (CPU_THROTTLE > 1) console.log(`CPU throttle: ${CPU_THROTTLE}x  →  writing chrome-*${FILE_SUFFIX}.json (normal corpus untouched)`);

const summary = [];
for (const url of URLS) {
  const host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-');
  try {
    const data = await capture(browser, url);
    const file = join(OUT, 'chrome-' + host + FILE_SUFFIX + '.json');
    writeFileSync(file, JSON.stringify(data, null, 2));
    const counts = Object.fromEntries(Object.entries(data.streams || {}).map(([k, v]) =>
      [k, v.status === 'present' ? (v.entries.length + (v.dropped ? '+' + v.dropped + 'drop' : '')) : v.status]));
    const prof = data.profile && data.profile.status === 'present'
      ? `${data.profile.counts.samples} samples / ${data.profile.counts.frames} frames / ${data.profile.counts.stacks} stacks ` +
        `@ ${data.profile.actualSampleIntervalMs}ms (req ${data.profile.requestedSampleIntervalMs}ms)` +
        (data.profile.sampleBufferFull ? ' [BUFFER FULL]' : '')
      : `status=${data.profile ? data.profile.status : 'absent'}`;
    summary.push({ url, finalUrl: data.finalUrl, title: data.title, navStatus: data.navStatus, looksBlocked: data.looksBlocked, file, counts, profile: prof });
    console.log('\n✓ ' + url);
    console.log('  -> ' + file);
    console.log('  title=' + JSON.stringify(data.title) + ' blocked=' + data.looksBlocked + ' nav=' + data.navStatus);
    console.log('  streams: ' + JSON.stringify(counts));
    console.log('  profile: ' + prof);
  } catch (e) {
    console.log('\n✗ ' + url + '\n  ERROR ' + e.message);
    summary.push({ url, error: e.message });
  }
}
await browser.close();
// Keep _summary.json out of OUT (../json) so the schema test only ever sees capture files there.
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '_summary' + FILE_SUFFIX + '.json'), JSON.stringify(summary, null, 2));
console.log('\n=== DONE — corpus in ' + OUT + ' ===');
