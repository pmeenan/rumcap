# rumcap — capture samples

Real `Performance` API captures from production web pages, used to **ground the `rumcap` schema in actual browser output** instead of memory (project guardrail: *"verify the platform; don't trust memory; ground in real captures"*). These are the seed of the golden corpus.

> ⚠️ The `*.json` files are **raw browser shapes** — each entry's `toJSON()` plus the live-DOM attribution `toJSON()` drops — **not** the canonical golden corpus. The golden corpus (Capture-shaped fixtures the codec round-trips, incl. degraded variants) now lives in [`../test/fixtures.ts`](../test/fixtures.ts), grounded in these samples; the round-trip test is [`../test/codec.test.ts`](../test/codec.test.ts). Each `*.json` file also has a generated same-basename `*.rcap` pair under `rcap/`: the same raw sample replayed through `entrySink` and packed with the current codec, for external decoder reference tests.

## Layout

```
samples/
  json/                        ten raw real captures: eight public-page (site × speed) + two local-fixture
    chrome-www-cnn-com.json          normal-speed (unthrottled CPU)
    chrome-www-google-com.json
    chrome-v0-app.json
    chrome-www-etsy-com.json
    chrome-www-cnn-com-cpu6x.json    same pages at 6× CPU throttle (worst-case blocking)
    chrome-www-google-com-cpu6x.json
    chrome-v0-app-cpu6x.json
    chrome-www-etsy-com-cpu6x.json
    chrome-local-fixture.json        the local fixture page (surfaces needing page cooperation — below)
    chrome-local-fixture-bfcache.json  its back-navigation variant (populated notRestoredReasons)
  rcap/                        generated same-basename .rcap decoder reference files
    chrome-www-cnn-com.rcap          normalized + packed version of chrome-www-cnn-com.json
  capture-tool/                how they were produced (to regenerate / extend)
    drive.mjs                  headless Chrome driver (puppeteer-core); CPU_THROTTLE=N for the -cpuNx variant
    drive-local.mjs            local-fixture driver: serves ./fixture on 127.0.0.1 and captures it
    fixture/                   the fixture pages (index/frame/second.html)
    spike.mjs                  the in-page capture spike both drivers inject (document-start)
    capture-spike.js           zero-dep console version (any browser: Safari/Firefox/Chrome)
    inspect.mjs                prints the per-stream field inventory + profile summary
    sizes.mjs                  rebuilds each capture via the library's entrySink, prints the
                               raw / gzipped / .rcap size table (the README's numbers), and can
                               regenerate the rcap/*.rcap reference files
    package.json
```

## When

Public pages captured **2026-06-28**, Google **Chrome 149.0.7827.200** (Linux x86_64). **Re-captured 2026-06-29** to add the **JS Self-Profiling `profile` stream** (requested 2ms / 30000-sample buffer) — the driver now injects the required `Document-Policy: js-profiling` header, so every file carries a real profiler trace. The same date also added a **6× CPU-throttled variant** (`*-cpu6x.json`, via CDP `Emulation.setCPUThrottlingRate`) — a worst-case, heavily main-thread-bound set to design the profile-slicing transform against. Each capture records its `cpuThrottleRate` (1 = unthrottled, 6 = 6×).

The **local-fixture pair** was captured **2026-07-02**, Google **Chrome 150.0.7871.46**, with spike v3 (structured element attrs + live reads of the toJSON-emptied nested objects). It grounds the surfaces that need page cooperation and that no public page provides: Element Timing (`elementtiming` on an image AND a text block), structured element attributes (id/class/`name` on LCP element, shift sources, event targets), real **Server-Timing** values (dur+desc / desc-only / dur-only / dur=0), a same-origin-**iframe** long task (`same-origin-descendant` + populated `TaskAttributionTiming` containers), an input-driven layout shift (`hadRecentInput` + `lastInputTime`), live mark/measure `detail` (incl. a DevTools-extensibility `detail.devtools` track measure, the React-19 shape), and — in the `-bfcache` variant — a `back_forward` navigation with a **populated `notRestoredReasons` tree** (the fixture's `unload` listener blocks restore; Chrome reports the reason as `masked`) plus real `unloadEventStart/End` values.

## How

Both drivers inject the same spike ([`spike.mjs`](capture-tool/spike.mjs)) at document-start.
`drive-local.mjs` serves [`fixture/`](capture-tool/fixture) over `127.0.0.1` (nothing external; the
server itself sets `Document-Policy: js-profiling` and the Server-Timing headers, and adds small
response delays so loopback resources still have distinct fetch phases), drives the page (click a
named button, type into a named field), then hops to `second.html` and back for the bfcache variant.
The page content is synthetic; **the browser output is real Chrome** — only the page is ours, which is
the standard way to ground opt-in surfaces like `elementtiming`.

`drive.mjs` launches the **system Chrome headed under `xvfb`** (1366×768) via `puppeteer-core`, and for each URL:

1. **Injects `Document-Policy: js-profiling`** onto the document response via a CDP `Fetch` interceptor (only `Document` responses pause; everything else flows untouched). This is a **harness** action — enabling the header the API requires — not a measurement source; the profile data still comes 100% from the in-page JS Self-Profiling API.
2. Injects the capture spike at **document-start** (`evaluateOnNewDocument`) — one `PerformanceObserver({ buffered: true })` per entry type (each in its own try/catch so an unsupported type is recorded as `unsupported`), **and constructs `new Profiler({ sampleInterval: 2, maxBufferSize: 30000 })` as early as possible** so the profile spans load.
3. Navigates (`domcontentloaded`), waits ~3.5s for LCP / late resources, then performs **light trusted interactions** (clicks, `Tab`s, several scroll bursts) to elicit Event Timing / INP / LoAF and keep the main thread busy for a denser profile.
4. At finalize: `await profiler.stop()` (async — flushes the sample buffer), flushes the observers, then writes `json/chrome-<host>.json` — now including the `profile` stream.

A clean (non-`Headless`) UA plus `--disable-blink-features=AutomationControlled` were enough to pass the bot/consent walls on CNN, Google, and Etsy from a datacenter IP — all four returned real content, none blocked.

### The four samples

| File | Page | Why chosen |
|---|---|---|
| `chrome-www-cnn-com.json` | CNN live-news article | Heavy editorial + ads, live updates, many resources |
| `chrome-www-google-com.json` | Google Finance (beta) | Google app stack (Angular/Closure-style), many User Timing marks |
| `chrome-v0-app.json` | v0 by Vercel | Next.js / React; clean LCP element attribution + LoAF scripts |
| `chrome-www-etsy-com.json` | Etsy curated staff-picks | Marketplace, image-heavy, highest interaction count |

## What each raw JSON file contains

- `clock` — `timeOrigin` (epoch ms), `now`, and timestamp unit/base (`ms`, `timeOrigin`).
- `environment` — UA, UA-CH (`userAgentData`), `deviceMemory`, `hardwareConcurrency`, `connection`, viewport/screen geometry, self-profiler availability.
- `supportedEntryTypes` — `PerformanceObserver.supportedEntryTypes` for this browser.
- `streams` — keyed by entry type; each `{ status, entries[], dropped?, loss? }`. Entries are the raw `toJSON()`; everything only readable live is added under `__attribution`: node-valued attribution as a structural selector **plus structured attrs** (`{tag, id, classes≤8, name}` — spike v3) for the LCP element / CLS `sources` / INP+`event` target / element-timing element, LoAF `scripts`, `serverTiming`, longtask `attribution`, `notRestoredReasons`, the element-timing `intersectionRect`, and mark/measure `detail`. High-volume streams (`resource`, `event`, …) are **capped** with a `dropped` count + `loss` note — itself a prototype of the manifest's truncation semantics.
- `profile` — the JS Self-Profiling trace from `Profiler.stop()`: interned `resources[]` / `frames[]` (`{name, resourceId?, line?, column?}`) / `stacks[]` (`{frameId, parentId?}`) / `samples[]` (`{timestamp, stackId?}` — `stackId` absent = idle), plus capture metadata: `requestedSampleIntervalMs` vs `actualSampleIntervalMs` (records the clamp), `maxBufferSize`, `sampleBufferFull`, and `counts`. `status` is `present`, else a reason (`unsupported` / `no-constructor` / `construct-threw` / `stop-threw`). **Not** capped — it's the dense dataset; see the size caveat below.

## What each `.rcap` file contains

Each `rcap/*.rcap` file is the normalized `Capture` model produced from the same-basename raw JSON sample
by [`sizes.mjs`](capture-tool/sizes.mjs): raw entries replay through `entrySink`, live-only attribution
is grafted back the same way as [`../test/browser.test.ts`](../test/browser.test.ts), and the raw
profiler trace is folded into profile slices before packing. These files are committed decoder
fixtures; the browser replay test verifies every `*.rcap` byte-for-byte against a fresh pack of its
paired JSON sample.

`capture-tool/inspect.mjs` prints the union of keys per stream across all four files (the field inventory the schema is built from).

## Known artifacts & caveats

Read these before treating any value as canonical:

- **Duplicate `navigation` entry (and sometimes `paint`/LCP).** A buffered observer registered at document-start fires twice for these singletons — once provisional (`duration:0, transferSize:300`), once complete. The **last/complete** entry is authoritative; the provisional one is a capture artifact, not real data. (`entrySink` handles this: set-replace, last wins.)
- **Distinct `event` entries legitimately share `startTime`+`name`.** A `pointerenter` dispatches once per ancestor element entered, all stamped with the same event time — the CNN capture has 9 such entries for one pointer move. They are REAL, separate entries (different targets): do **not** dedup interactions by startTime+name. Only the `first-input` entry is a copy (of its one `event` twin) — that pair, and only that pair, merges. (An earlier demo dedup got this wrong; `test/browser.test.ts` locks the corrected behavior.)
- **Nested platform objects serialize EMPTY through the parent entry's `toJSON()`** — their getters live on the prototype. Exhibited across the corpus: LoAF `scripts` → `[{}, …]`, `serverTiming` → `[{}, …]`, longtask `attribution` → `[{}]`, element-timing `intersectionRect` → `{}`, layout-shift `sources` → `[{}, …]`, and (Chrome 150) even a **null** `notRestoredReasons` → `{}`. The real values were captured by reading the live objects (each nested interface's own `toJSON()` works) and live under `__attribution`. Replay tooling must graft them back (see `liveView` in `test/browser.test.ts` / `sizes.mjs`); the normalizers treat the empties as *absent*, never zeros. Also note: `sourceCharPosition` in this corpus is only ever a real value (0 = script start) — the spec's `-1` "could not be determined" sentinel is not exhibited here.
- **Headless / datacenter capture.** `userAgentData.brands` is `[]` and `platform` is `''` (real Chrome populates these; high-entropy UA-CH needs async `getHighEntropyValues()`). `connection`, `deviceMemory`, `hardwareConcurrency`, and the `viewport*`/`screen*`/`devicePixelRatio` values (1366×768, DPR 1) describe the **capture host / headless window**, not a real user.
- **`serverTiming` is empty on the public pages** — those sites send none, or cross-origin resources lack `Timing-Allow-Origin`. Real values (incl. the `dur`-defaulting-to-0 and absent-`desc` cases) are grounded by `chrome-local-fixture.json`.
- **`element` timing absent on the public pages** — none set `elementtiming` attributes. Both paint kinds with the full spec field set (element `id`, `intersectionRect`, `paintTime`/`presentationTime`, the text-paint `url`/`loadTime`/`natural*` sentinels) are grounded by `chrome-local-fixture.json`.
- **`first-input` `target` can be null even for an on-DOM element** (the local fixture's button pointerdown) while the same interaction's `event`-type twins carry the target — one more reason the sink merges the first-input pair rather than trusting either copy alone.
- **JS self-profiling — now enabled & grounded (Chrome 149).** The driver injects the `Document-Policy` header, so all four files carry a real `profile` stream and `environment.selfProfiler = "available"`. Verified platform facts (don't re-derive from memory):
  - **`sampleInterval` is floored at 10ms** and quantized to multiples of 10 — a requested **2ms is delivered as 10ms** (compare `requestedSampleIntervalMs` vs `actualSampleIntervalMs`). On-thread sampling resolution is ~10ms regardless of request; cadence is otherwise steady (±0.1ms). `maxBufferSize: 30000` (≈5 min @ 10ms) never overflowed.
  - **Mostly idle after load.** These pages are **38–99% idle** samples (`stackId` absent): v0.app is the busy outlier (~38% idle, stacks up to **256 deep**); CNN / Etsy / Google Finance are 91–99% idle in the capture window.
  - **Single-sample transients dominate.** ~66–96% of consecutive-stack runs are a single sample — the "code that just happened to be running when the sample fired" noise; only tens-to-hundreds of call-tree slices span ≥1 interval (the "slow" backbone). This grounds the now-implemented nested-slice wire representation (transform: [`../src/profile-slices.ts`](../src/profile-slices.ts); rationale in [`docs/Plan.md`](../docs/Plan.md)).
  - **The per-sample form is heavy on deep stacks.** v0.app's interned `stacks` table alone is ~9,200 entries, pushing that file to ~1MB — precisely the cost a slice model removes.
  - **Cross-origin frames** appear with names/URLs when the script is CORS-readable (Etsy's CDN frames are named); truly-**opaque** cross-origin redaction was **not** conclusively exercised here (the heavy JS on these pages is first-party or CORS) — capture a page with opaque third-party JS before relying on a redaction shape.
- **`soft-navigation` not in `supportedEntryTypes`** on Chrome 149 — SPA boundaries must come from the explicit app-mark API, not native soft-nav.
- **Chrome only.** Safari and Firefox captures — different `supportedEntryTypes`, narrower attribution, the real **degraded** variants — are still TODO (use `capture-spike.js`, below).

## Privacy

Only **public, unauthenticated** pages are captured. The spike records **structural CSS-path selectors** (tag / id / class / `nth-of-type`) — never element text content — and resource entries carry public asset URLs. The `profile` stream carries **function names, script URLs, and line/column** from the page's public JS (the same posture as resource URLs) — no values, arguments, or runtime state. No cookies, request/response headers, storage, or auth state are read (the Performance API exposes none). **Do not add captures from authenticated or logged-in sessions** — profiler frames from logged-in code paths could be sensitive.

## Regenerating / updating

Headless Chrome (Linux) — regenerates the `json/` files in place:

```bash
cd samples/capture-tool
npm install                         # puppeteer-core; drives the system Chrome
xvfb-run -a --server-args="-screen 0 1366x768x24" node drive.mjs                  # normal-speed corpus
CPU_THROTTLE=6 xvfb-run -a --server-args="-screen 0 1366x768x24" node drive.mjs   # 6× worst-case (-cpu6x.json)
xvfb-run -a --server-args="-screen 0 1366x768x24" node drive-local.mjs            # the local-fixture pair
node inspect.mjs                    # print the field inventory + profile summary
node sizes.mjs                      # rebuild each capture via entrySink → the README's size table
node sizes.mjs --write-rcap         # also regenerate ../rcap/*.rcap reference files
                                    # (requires `npm run build` at the repo root first)
```

`CPU_THROTTLE=N` (N>1) applies the DevTools `N×` CPU throttle and writes a separate `chrome-<host>-cpuNx.json` set, leaving the normal corpus untouched (0/1 = off). Edit the site list or interactions at the top of `drive.mjs`. It writes the captures to `../json/`, and a `_summary[-cpuNx].json` index next to the tool (kept out of `json/` so the schema test only sees captures).

Other browsers (Safari, Firefox, real desktop Chrome) — no Node required:

1. Open the page, then paste `capture-tool/capture-spike.js` into the DevTools console.
2. Interact with the page, then switch tabs (or wait 8s); it auto-downloads `rumspike-<host>-<t>.json`.
3. Move the file into `json/`, renamed by browser (e.g. `safari-<host>.json`).
