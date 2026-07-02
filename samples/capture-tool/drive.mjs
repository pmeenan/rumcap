/*
 * rumcap — format sample capture driver.
 * Drives system Chrome (headed under xvfb) across a set of real public pages,
 * injects the observer spike at document-start, does light trusted interactions
 * to elicit Event Timing / INP / LoAF, and writes one JSON capture per site to
 * ../json/ (regenerating samples). Public pages only; no upload.
 * See ../README.md for how/when these were captured and the known caveats.
 */
import puppeteer from 'puppeteer-core';
import { installSpike } from './spike.mjs';
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
