/*
 * rumcap — LOCAL fixture capture driver.
 *
 * Serves ./fixture over 127.0.0.1 (nothing external) and drives system Chrome (headed under xvfb)
 * through it with the same spike as drive.mjs, producing two captures in ../json/:
 *
 *   chrome-local-fixture.json          — the fixture page: Element Timing (image-paint + text-paint,
 *                                        every spec field), structured element attributes, REAL
 *                                        Server-Timing values, main-page + same-origin-iframe long
 *                                        tasks, no-input + input-driven layout shifts, and live
 *                                        mark/measure `detail` (incl. a DevTools `detail.devtools`
 *                                        track entry).
 *   chrome-local-fixture-bfcache.json  — the same page re-entered via history back with bfcache
 *                                        blocked (unload listener), so its navigation entry carries
 *                                        type 'back_forward' and a POPULATED notRestoredReasons tree.
 *
 * Why a local page: these surfaces need page cooperation (`elementtiming` attributes, Server-Timing
 * headers, controlled shifts), which no public-corpus page provides. The BROWSER output is still
 * real Chrome — only the page content is ours. See ../README.md.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installSpike } from './spike.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'json');
const FIXTURE = join(HERE, 'fixture');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Deterministic SVG "images" ──────────────────────────────────────────────────────────────────────
// Generated (not committed) to keep the repo clean. Chrome excludes low-entropy images from LCP
// (< 0.05 bits/pixel), so the hero packs a few hundred varied rects: ~14KB over 600×300px ≈ 0.6bpp —
// safely a real LCP candidate. Seeded LCG keeps re-captures comparable.
function seededSvg(width, height, rects) {
  let s = 42;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  let body = `<rect width="${width}" height="${height}" fill="#204060"/>`;
  for (let i = 0; i < rects; i++) {
    const w = Math.round(4 + rnd() * (width / 5));
    const h = Math.round(4 + rnd() * (height / 5));
    body += `<rect x="${Math.round(rnd() * (width - w))}" y="${Math.round(rnd() * (height - h))}" width="${w}" height="${h}" ` +
      `fill="hsl(${Math.round(rnd() * 360)},${Math.round(30 + rnd() * 60)}%,${Math.round(25 + rnd() * 55)}%)" opacity="0.85"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

// ── The fixture server: real headers (Document-Policy, Server-Timing), small artificial delays so
//    resource entries have distinct request/response phases even on loopback. ──────────────────────
const ROUTES = {
  '/': {
    file: 'index.html', type: 'text/html; charset=utf-8', delayMs: 15,
    headers: {
      'Document-Policy': 'js-profiling',
      // A full Server-Timing spread: dur+desc, desc-only (duration defaults to 0 in the API),
      // dur-only, and an explicit dur=0 — grounding every ServerTimingEntry field combination.
      'Server-Timing': 'db;dur=53.2;desc="primary shard", cache;desc=hit, edge;dur=1.4, queue;dur=0',
    },
  },
  '/second.html': { file: 'second.html', type: 'text/html; charset=utf-8', headers: { 'Document-Policy': 'js-profiling' } },
  '/frame.html': { file: 'frame.html', type: 'text/html; charset=utf-8' },
  '/hero.svg': {
    body: () => seededSvg(600, 300, 320), type: 'image/svg+xml', delayMs: 80,
    headers: { 'Server-Timing': 'origin;dur=11.3;desc="edge-cache-miss"', 'Cache-Control': 'no-store' },
  },
  '/thumb.svg': { body: () => seededSvg(96, 96, 48), type: 'image/svg+xml', delayMs: 25 },
  '/api/data.json': {
    body: () => JSON.stringify({ ok: true, items: [1, 2, 3] }), type: 'application/json', delayMs: 40,
    headers: { 'Server-Timing': 'db;dur=12.5;desc="user lookup", cache;dur=0;desc=miss' },
  },
};

const server = createServer((req, res) => {
  const route = ROUTES[new URL(req.url, 'http://local').pathname];
  if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  const body = route.file !== undefined ? readFileSync(join(FIXTURE, route.file)) : route.body();
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': route.type, ...(route.headers ?? {}) });
    res.end(body);
  }, route.delayMs ?? 0);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Drive (same Chrome/args posture as drive.mjs; no CDP interception needed — the server itself
//    sets Document-Policy, and staying off CDP Fetch keeps bfcache behavior natural). ───────────────
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: false, // headed under xvfb — most real-browser-like
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en', '--window-size=1366,768', '--disable-dev-shm-usage'],
});

const summarize = (data) => Object.fromEntries(Object.entries(data.streams ?? {}).map(([k, v]) =>
  [k, v.status === 'present' ? v.entries.length : v.status]));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installSpike);

  // ── Capture 1: the fixture page ──
  await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
  await sleep(1600); // banner shift fires at 700ms; element/LCP paints settle
  await page.click('#go'); // trusted click → first-input + event entries + input-driven shift + LoAF
  await page.type('#email-field', 'perf', { delay: 30 }); // key events on a name-carrying input
  await page.keyboard.press('Tab');
  await sleep(1400); // let event/LoAF/longtask entries flush
  const fixture = await page.evaluate(() => window.__rumFinalize());
  writeFileSync(join(OUT, 'chrome-local-fixture.json'), JSON.stringify(fixture, null, 2));
  console.log('✓ chrome-local-fixture.json');
  console.log('  streams:', JSON.stringify(summarize(fixture)));
  console.log('  element entries:', JSON.stringify((fixture.streams.element?.entries ?? []).map((e) => e.identifier)));
  console.log('  longtask names:', JSON.stringify([...new Set((fixture.streams.longtask?.entries ?? []).map((e) => e.name))]));

  // ── Capture 2: history-back with bfcache blocked → populated notRestoredReasons ──
  await page.goto(base + '/second.html', { waitUntil: 'load', timeout: 30000 });
  await sleep(600);
  await page.goBack({ waitUntil: 'load', timeout: 30000 }); // unload listener blocks restore → full reload
  await sleep(1800);
  const back = await page.evaluate(() => window.__rumFinalize());
  writeFileSync(join(OUT, 'chrome-local-fixture-bfcache.json'), JSON.stringify(back, null, 2));
  const nav = back.streams.navigation?.entries?.at(-1);
  console.log('✓ chrome-local-fixture-bfcache.json');
  console.log('  nav type:', nav?.type, ' notRestoredReasons:', JSON.stringify(nav?.notRestoredReasons)?.slice(0, 300));
} finally {
  await browser.close();
  server.close();
}
console.log('=== DONE — fixtures in ' + OUT + ' ===');
