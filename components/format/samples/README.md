# format — capture samples

Real `Performance` API captures from production web pages, used to **ground the `format` schema in actual browser output** instead of memory (project guardrail: *"verify the platform; don't trust memory; ground in real captures"*). These are the seed of the golden corpus.

> ⚠️ These are **raw browser shapes** — each entry's `toJSON()` plus the live-DOM attribution `toJSON()` drops — **not** the canonical, packed/redacted golden corpus. The golden corpus (packed `.rumcap` + expected unpacked model) is defined once the codec exists; these samples drive its design.

## Layout

```
samples/
  json/                        four real captures, one JSON per site
    chrome-www-cnn-com.json
    chrome-www-google-com.json
    chrome-v0-app.json
    chrome-www-etsy-com.json
  capture-tool/                how they were produced (to regenerate / extend)
    drive.mjs                  headless Chrome driver (puppeteer-core)
    capture-spike.js           zero-dep console version (any browser: Safari/Firefox/Chrome)
    inspect.mjs                prints the per-stream field inventory
    package.json
```

## When

Captured **2026-06-28**, Google **Chrome 149.0.7827.200** (Linux x86_64).

## How

`drive.mjs` launches the **system Chrome headed under `xvfb`** (1366×768) via `puppeteer-core`, and for each URL:

1. Injects the capture spike at **document-start** (`evaluateOnNewDocument`) — one `PerformanceObserver({ buffered: true })` per entry type, each in its own try/catch so an unsupported type is recorded as `unsupported` rather than silently missing.
2. Navigates (`domcontentloaded`), waits ~3.5s for LCP / late resources, then performs **light trusted interactions** (a click, two `Tab`s, scrolls, a second click) to elicit Event Timing / INP / LoAF.
3. Reads the assembled object back and writes `json/chrome-<host>.json`.

A clean (non-`Headless`) UA plus `--disable-blink-features=AutomationControlled` were enough to pass the bot/consent walls on CNN, Google, and Etsy from a datacenter IP — all four returned real content, none blocked.

### The four samples

| File | Page | Why chosen |
|---|---|---|
| `chrome-www-cnn-com.json` | CNN live-news article | Heavy editorial + ads, live updates, many resources |
| `chrome-www-google-com.json` | Google Finance (beta) | Google app stack (Angular/Closure-style), many User Timing marks |
| `chrome-v0-app.json` | v0 by Vercel | Next.js / React; clean LCP element attribution + LoAF scripts |
| `chrome-www-etsy-com.json` | Etsy curated staff-picks | Marketplace, image-heavy, highest interaction count |

## What each file contains

- `clock` — `timeOrigin` (epoch ms), `now`, and timestamp unit/base (`ms`, `timeOrigin`).
- `environment` — UA, UA-CH (`userAgentData`), `deviceMemory`, `hardwareConcurrency`, `connection`, viewport/screen geometry, self-profiler availability.
- `supportedEntryTypes` — `PerformanceObserver.supportedEntryTypes` for this browser.
- `streams` — keyed by entry type; each `{ status, entries[], dropped?, loss? }`. Entries are the raw `toJSON()`; live-DOM attribution (LCP element, CLS `sources`, INP/`event` target, LoAF `scripts`) is added under `__attribution`. High-volume streams (`resource`, `event`, …) are **capped** with a `dropped` count + `loss` note — itself a prototype of the manifest's truncation semantics.

`capture-tool/inspect.mjs` prints the union of keys per stream across all four files (the field inventory the schema is built from).

## Known artifacts & caveats

Read these before treating any value as canonical:

- **Duplicate `navigation` entry (and sometimes `paint`/LCP).** A buffered observer registered at document-start fires twice for these singletons — once provisional (`duration:0, transferSize:300`), once complete. The **last/complete** entry is authoritative; the provisional one is a capture artifact, not real data. The production `capture` library will read final state at finalize instead.
- **Headless / datacenter capture.** `userAgentData.brands` is `[]` and `platform` is `''` (real Chrome populates these; high-entropy UA-CH needs async `getHighEntropyValues()`). `connection`, `deviceMemory`, `hardwareConcurrency`, and the `viewport*`/`screen*`/`devicePixelRatio` values (1366×768, DPR 1) describe the **capture host / headless window**, not a real user.
- **`serverTiming` is empty** everywhere — these sites send none, or cross-origin resources lack `Timing-Allow-Origin`. The field is schema-relevant but unsampled here.
- **`element` timing absent** — none of these pages set `elementtiming` attributes.
- **JS self-profiling not enabled** — no `Document-Policy: js-profiling` header, so `environment.selfProfiler = "needs-document-policy"`. That's a Phase 1 stream.
- **`soft-navigation` not in `supportedEntryTypes`** on Chrome 149 — SPA boundaries must come from the explicit app-mark API, not native soft-nav.
- **Chrome only.** Safari and Firefox captures — different `supportedEntryTypes`, narrower attribution, the real **degraded** variants — are still TODO (use `capture-spike.js`, below).

## Privacy

Only **public, unauthenticated** pages are captured. The spike records **structural CSS-path selectors** (tag / id / class / `nth-of-type`) — never element text content — and resource entries carry public asset URLs. No cookies, request/response headers, storage, or auth state are read (the Performance API exposes none). **Do not add captures from authenticated or logged-in sessions.**

## Regenerating / updating

Headless Chrome (Linux) — regenerates all four `json/` files in place:

```bash
cd components/format/samples/capture-tool
npm install                         # puppeteer-core; drives the system Chrome
xvfb-run -a --server-args="-screen 0 1366x768x24" node drive.mjs
node inspect.mjs                    # print the field inventory
```

Edit the site list or interactions at the top of `drive.mjs`. It writes the captures to `../json/`, and a `_summary.json` index next to the tool (kept out of `json/` so the schema test only sees captures).

Other browsers (Safari, Firefox, real desktop Chrome) — no Node required:

1. Open the page, then paste `capture-tool/capture-spike.js` into the DevTools console.
2. Interact with the page, then switch tabs (or wait 8s); it auto-downloads `rumspike-<host>-<t>.json`.
3. Move the file into `json/`, renamed by browser (e.g. `safari-<host>.json`).
