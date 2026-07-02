# rumcap

One page view produces a dozen disconnected performance signals — Navigation Timing, Resource Timing
(with Server-Timing), paints/LCP, layout shifts, Event Timing/INP, long tasks, Long Animation Frames,
User Timing, errors, **a JS Self-Profiling CPU trace**, and your app's own instrumentation. `rumcap`
combines all of them into **one correlated timeline in one tiny file**: the **`.rcap`** capture format —
compact, self-describing, binary — with a streaming **encoder** for the page and a separate,
tree-shakeable **decoder** for tooling. (Package, repo, and format are all **`rumcap`**; only the
file extension keeps the short name, `.rcap`.)

The result reads like a field-collected DevTools trace: the network waterfall, the rendering milestones,
the interactions, *and* what the main thread was actually running — aligned on one clock, small enough
to beacon from real users.

```ts
import { Encoder, entrySink, environmentSnapshot } from 'rumcap/encode';

const enc = new Encoder({ metadata: { release: '2026.7.1' } });
enc.setEnvironment(environmentSnapshot());

// 1. The browser's timing APIs plug straight in — one sink is the observer callback for
//    every entry type, and normalization onto the model happens inside the library:
const sink = entrySink(enc);
for (const type of ['navigation', 'resource', 'paint', 'largest-contentful-paint', 'layout-shift',
                    'event', 'first-input', 'longtask', 'long-animation-frame', 'element',
                    'mark', 'measure']) {
  try { new PerformanceObserver(sink).observe({ type, buffered: true }); } catch { /* unsupported */ }
}

// 2. The JS self-profiler: feed raw Profiler.stop() chunks; they fold into a compact call
//    tree incrementally, so there is no serialization cliff at unload:
const profiler = new Profiler({ sampleInterval: 10, maxBufferSize: 30000 });
// …at idle checkpoints and at the end:
enc.addProfilerChunk(await profiler.stop(), profiler.sampleInterval);

// 3. Your own code: stack-based spans on named timelines (depth from the call stack,
//    duration from begin→end), with attached details:
enc.timeline('checkout').span('place-order', { items: 3 }, () => submit());

// 4. One compact, self-describing .rcap:
const bytes = await enc.finish();
navigator.sendBeacon('/rum', bytes); // or download it, store it, …
```

See **[docs/API.md](docs/API.md)** for the full API and **[docs/FileFormat.md](docs/FileFormat.md)** for
the wire specification.

## How small?

Real captures of real pages, measured over this repo's sample corpus (Chrome 149; each capture carries
navigation + resources + paints/LCP + layout shifts + interactions + long tasks + LoAF + user timing +
environment **+ a full-session 10ms CPU profile**; regenerate with
[`samples/capture-tool/sizes.mjs`](samples/capture-tool/sizes.mjs)):

| page | timeline entries | profiler samples | browser `toJSON()` dump | dump gzipped | **`.rcap`** |
|---|---:|---:|---:|---:|---:|
| CNN live-news article | 159 | 779 | 225 KB | 19 KB | **6.0 KB** |
| Google Finance | 274 | 864 | 339 KB | 26 KB | **8.8 KB** |
| v0.app (React, deep stacks) | 259 | 1,803 | 1,055 KB | 60 KB | **9.1 KB** |
| Etsy staff-picks | 421 | 879 | 519 KB | 37 KB | **16.3 KB** |

Two honest comparisons are folded together there: gzipped JSON of the **identical** normalized model
runs 10–25 KB on these pages — the `.rcap` binary codec (string interning, delta-chained fixed-point-µs
timestamps on a measured per-capture grid, columnar entry arrays, presence bitmaps, derived-edge rects)
beats it by 33–57%. The bigger win is upstream of the codec: the raw dump carries the profiler's
per-sample interned stacks (v0.app's alone is most of its megabyte), which `rumcap` folds on-page into
the nested call-tree slices a viewer actually renders.

On the page, the full encode surface (pack + streaming `Encoder` + profiler fold) is **~6.7 KB gzip**,
zero dependencies; the browser-entry integration (`entrySink` + the normalizers) is opt-in and adds
**~2.9 KB** only when imported.

## Why

Most RUM libraries own capture *and* storage *and* presentation, in one bundle. `rumcap` unbundles the
middle: a tiny, versioned, self-describing container that any capture code can write and any tool can
read. That means:

- **Plug in the browser directly.** `entrySink` accepts raw `PerformanceObserver` entries and maps them
  onto the spec-canonical model — including the quirks a hand-rolled mapping gets wrong (0-as-absent
  phase sentinels, the double-delivered `first-input`, Chrome's experimental field spellings, the `-1`
  positions that would corrupt a naive encoding). Element-pointing entries (LCP, layout shifts,
  interactions, element timing) keep structured attribution: a structural CSS path plus the element's
  tag/id/classes/`name` attribute — never element text.
- **Or bring your own capture.** Use `web-vitals`, a framework's hooks, your own observers — every
  stream also has a typed feed method (`addResource`, `setLcp`, …) for pre-normalized data.
- **First-class CPU profiling.** Raw [JS Self-Profiling](https://wicg.github.io/js-self-profiling/)
  chunks fold incrementally into compact nested slices — the "what was the main thread doing" layer that
  turns a waterfall into a trace.
- **Instrument your own code.** The `customEvents` stream gives libraries and app code a profiler-like
  way to record named, timed, detail-carrying spans, namespaced onto separate timelines.
- **Attach capture-level metadata.** Arbitrary JSON (release, experiment, page type, …) travels with
  the capture.

## Two independent halves

```ts
import { pack, Encoder } from 'rumcap/encode';   // producing captures on a page — no decoder shipped
import { unpack, sniff } from 'rumcap/decode';   // reading captures in tooling
import { pack, unpack } from 'rumcap';           // both, for convenience
```

The split is physical (separate modules + subpath exports), so an encode-only import can't pull in the
decoder or `DecompressionStream` even without a bundler.

## Format highlights

- **Self-describing & robust to missing data.** Every stream is optional; the manifest records what's
  present and, for anything absent, **why** (`unsupported` / `not-requested` / `dropped` /
  `policy-blocked`) plus loss/truncation and provenance. *Unknown is never confused with zero.*
- **Versioned.** A wire `CODEC_VERSION` and a schema `FORMAT_VERSION` (both currently **3**), with
  skippable sections/streams and self-describing manifest records so a reader pulls what it knows from a
  newer file — adding a stream never breaks an older reader (see
  [docs/FileFormat.md](docs/FileFormat.md) "Reading across versions").
- **Honest precision.** Measured timings keep full 1µs precision; sample-*inferred* profile-slice
  durations are deliberately coarsened to 1ms rather than fake microseconds.
- **Sniffable.** The magic bytes and both versions sit outside the gzip — `sniff(bytes)` identifies and
  version-checks a capture without decompressing it.

## Demos

Both under [`examples/`](examples) — reference consumers, not shipped product:

- **[examples/capture](examples/capture)** — a page that captures its own performance (observers + the
  JS Self-Profiler + a custom timeline) and downloads a `.rcap`.
- **[examples/extension](examples/extension)** — a minimal Chrome MV3 harness that injects the capture
  demo into any page and adds the `Document-Policy: js-profiling` header so the profiler works.

## Viewing

`rumcap` does not render captures. The supported viewer is
**[waterfall-tools](https://github.com/pmeenan/waterfall-tools)** (network-waterfall + Perfetto/DevTools
embedding); `.rcap` support is added there separately. `rumcap` stays focused on the format.

## Scope & non-goals

This project is deliberately narrow: **the `.rcap` format — encode and decode — and nothing else.**

- **In scope:** the schema, the binary codec, the streaming encoder that aggregates your events, the
  browser-entry normalizers that map raw Web Performance API output onto the schema, and the golden
  corpus that keeps it honest.
- **Out of scope:** capture *policy* (which observers to run, sampling, when to save — bring your own;
  the demos show how), transporting/beaconing, server ingest, aggregate dashboards, and rendering.
  Earlier drafts scoped these as sibling components; that breadth was cut. Viewing lives in
  waterfall-tools.

## Development

```bash
npm install
npm run build      # tsc -b → dist/
npm test           # typecheck + vitest (round-trips the golden corpus + replays the real sample captures)
npm run lint       # eslint (warnings = errors)
```

Layout: [`src/`](src) is the library, [`test/`](test) the golden-corpus round-trip suite, [`samples/`](samples)
the real Chrome captures the schema is grounded in, [`examples/`](examples) the demos, [`docs/`](docs)
the API + format specs + architecture. Contributor guidance is in [AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE). Product code (anything that can reach a user's page) uses only permissive
dependencies; dev/build tooling that never ships may use weak-copyleft licenses that can't leak — see
[AGENTS.md](AGENTS.md).
