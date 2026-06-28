/*
 * rum-profiler — format sample capture driver.
 * Drives system Chrome (headed under xvfb) across a set of real public pages,
 * injects the observer spike at document-start, does light trusted interactions
 * to elicit Event Timing / INP / LoAF, and writes one JSON capture per site to
 * ../json/ (regenerating components/format/samples). Public pages only; no upload.
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

// Runs in the page at document-start. Must be fully self-contained (puppeteer serializes it).
function installSpike() {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_e) {}
  // Keep our synthetic test clicks from navigating away — they still produce trusted Event Timing.
  addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (a) e.preventDefault();
  }, true);

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
      streams[type] || (streams[type] = { status: 'present', entries: [], dropped: 0 });
    } catch (err) {
      streams[type] = { status: 'observe-threw', error: String(err), entries: [] };
    }
  }

  window.__rumFinalize = () => {
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
      spikeVersion: 1,
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
        selfProfiler: typeof window.Profiler !== 'undefined' ? 'needs-document-policy' : 'unsupported',
      },
      streams,
    };
  };
}

async function capture(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installSpike);

  let navStatus = 'ok';
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { navStatus = 'goto: ' + e.message; }

  await sleep(3500); // let LCP candidates / late resources settle
  try {
    await page.mouse.move(500, 360);
    await page.mouse.click(70, 220, { delay: 40 });   // trusted click -> Event Timing / INP
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(400);
    await page.mouse.click(540, 420, { delay: 40 });
    await page.evaluate(() => window.scrollBy(0, 900));
  } catch (_e) {}
  await sleep(1500);

  let data;
  try { data = await page.evaluate(() => (window.__rumFinalize ? window.__rumFinalize() : { error: 'no-finalize' })); }
  catch (e) { data = { error: 'evaluate-failed: ' + e.message }; }
  data.finalUrl = page.url();
  data.navStatus = navStatus;
  await page.close();
  return data;
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: false, // headed under xvfb — most real-browser-like
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en', '--window-size=1366,768', '--disable-dev-shm-usage'],
});

const summary = [];
for (const url of URLS) {
  const host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-');
  try {
    const data = await capture(browser, url);
    const file = join(OUT, 'chrome-' + host + '.json');
    writeFileSync(file, JSON.stringify(data, null, 2));
    const counts = Object.fromEntries(Object.entries(data.streams || {}).map(([k, v]) =>
      [k, v.status === 'present' ? (v.entries.length + (v.dropped ? '+' + v.dropped + 'drop' : '')) : v.status]));
    summary.push({ url, finalUrl: data.finalUrl, title: data.title, navStatus: data.navStatus, looksBlocked: data.looksBlocked, file, counts });
    console.log('\n✓ ' + url);
    console.log('  -> ' + file);
    console.log('  title=' + JSON.stringify(data.title) + ' blocked=' + data.looksBlocked + ' nav=' + data.navStatus);
    console.log('  streams: ' + JSON.stringify(counts));
  } catch (e) {
    console.log('\n✗ ' + url + '\n  ERROR ' + e.message);
    summary.push({ url, error: e.message });
  }
}
await browser.close();
// Keep _summary.json out of OUT (../json) so the schema test only ever sees capture files there.
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '_summary.json'), JSON.stringify(summary, null, 2));
console.log('\n=== DONE — corpus in ' + OUT + ' ===');
