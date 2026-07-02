# `rumcap` API

`rumcap` encodes and decodes the compact, self-describing `.rcap` capture format. You own the capture
*policy* (which observers to run, the profiler lifecycle, when to save); `rumcap` owns the model, the
normalization from raw browser output onto it, and the packing. The wire spec is
[FileFormat.md](FileFormat.md).

## Entry points

Three, so a page ships only what it uses:

| Import | Contains | Use when |
|---|---|---|
| `rumcap/encode` | the streaming `Encoder`, `entrySink` + the normalizers, `pack`, `SliceBuilder`, constants + all types | producing captures on a page |
| `rumcap/decode` | `unpack`, `sniff`, `checkConsistency`, constants + all types | reading captures in tooling/servers |
| `rumcap` | the union of both | convenience / when size doesn't matter |

**Tree-shaking:** `rumcap/encode` imports **no decode code** — no `unpack`, no `DecompressionStream`.
It's a physical split (separate modules + subpath exports), so the decoder can't reach a user's page
even without a bundler. The core encode surface (pack + `Encoder` + `SliceBuilder`) bundles to
**~6.7 KB gzip**; the browser-entry integration (`entrySink` + normalizers + `environmentSnapshot`) is
itself tree-shakeable and adds **~3.2 KB** only if imported (the quickstart import set —
`Encoder` + `entrySink` + `environmentSnapshot` — lands at ~9.3 KB). Measured with esbuild
`--bundle --minify` + gzip -9; rolldown agrees within ~1%.

```bash
npm install rumcap
```

## Capturing straight from the browser APIs

`entrySink(encoder)` returns one function that is a valid `PerformanceObserver` callback for **every**
entry type the format models. It routes by `entryType`, normalizes raw entries onto the spec-canonical
model, and handles the stateful platform quirks internally:

```ts
import { Encoder, entrySink, environmentSnapshot } from 'rumcap/encode';

const enc = new Encoder({ metadata: { release: '2026.7.1', experiment: 'checkout-v3' } });
enc.setEnvironment(environmentSnapshot()); // UA/UA-CH, device, connection, viewport — one call

const sink = entrySink(enc);
for (const type of ['navigation', 'resource', 'paint', 'largest-contentful-paint', 'layout-shift',
                    'event', 'first-input', 'longtask', 'long-animation-frame', 'element',
                    'mark', 'measure', 'visibility-state']) {
  try {
    new PerformanceObserver(sink).observe({
      type, buffered: true,
      // Event Timing's default 104ms threshold drops nearly every ordinary fast interaction;
      // 16 is the spec floor.
      ...(type === 'event' ? { durationThreshold: 16 } : {}),
    });
  } catch { /* legacy engine — see markStream below to record why a stream is absent */ }
}

const bytes = await enc.finish(); // Uint8Array — the packed .rcap
navigator.sendBeacon('/rum', bytes);
```

What the sink does that a hand-rolled mapping tends to get wrong (all grounded in the real captures
under [`samples/`](../samples)):

- **Sentinels become absence.** The platform reports "didn't happen / withheld" as `0` (resource and
  navigation phases, LCP `renderTime` without `Timing-Allow-Origin`, the LoAF milestones), `''` (most
  string fields), or `-1` (LoAF `sourceCharPosition`) — the model stores those fields as *absent*, so
  "didn't occur" can never be confused with "at t=0". Real zeros (durations, sizes, `responseStatus 0`
  for opaque responses) are kept.
- **The first interaction isn't double-counted.** `first-input` is a threshold-exempt *copy* of one
  `event` entry; the sink merges exactly that pair (and only it — distinct events legitimately share
  a timestamp+name, e.g. `pointerenter` dispatching per ancestor).
- **Singletons accumulate.** Paint milestones fill `firstPaint`/`firstContentfulPaint`; each LCP entry
  becomes a candidate with the latest as `final`; a re-delivered `navigation` (buffered observers see a
  provisional copy) is replaced by the complete one.
- **Spec names win.** Chrome's experimental `workerMatched/FinalSourceType` spellings land on the spec's
  `workerMatched/FinalRouterSource` fields.
- **Loss is recorded.** An observer's `droppedEntriesCount` (ring buffer overflowed before `observe()`)
  becomes a manifest loss note — never a silent gap.
- **Late deliveries are safe.** After `finish()`, the sink drops entries silently instead of throwing
  inside the page (`encoder.finished` exposes the same check for your own handlers).
- **Live attribution → structural selectors.** LCP elements, layout-shift sources, and interaction
  targets are captured as short structural CSS paths (`main#content > div.card > img:nth-of-type(2)`)
  via `structuralSelector` — never element text. A pre-computed selector string is also accepted.

Every stream is optional, and *why* it's absent is data. When you know, say so:

```ts
enc.markStream('profile', 'policy-blocked'); // or 'unsupported' / 'dropped' / 'not-requested'
```

### Errors and environment

Errors aren't PerformanceObserver sources; hook the window events and pass them through the mappers
(which fix the `filename`→`source` rename and drop the 0/`''` sentinels):

```ts
import { normalizeErrorEvent, normalizeRejection } from 'rumcap/encode';

addEventListener('error', (ev) => { if (!enc.finished) enc.addError(normalizeErrorEvent(ev)); });
addEventListener('unhandledrejection', (ev) => { if (!enc.finished) enc.addError(normalizeRejection(ev)); });
```

`environmentSnapshot()` reads only globals that exist (safe under workers/Node) and records
self-profiler availability; high-entropy UA-CH is left to the caller (it can prompt).

### The JS Self-Profiler

Fold raw `Profiler.stop()` chunks in as you collect them — the slices accumulate incrementally, so the
unload path stays cheap. Pass the profiler's **actual** (clamped) interval alongside the trace; Chrome
floors a requested 2ms to 10ms:

```ts
const profiler = new Profiler({ sampleInterval: 10, maxBufferSize: 30000 });
// …at idle checkpoints and at the end:
enc.addProfilerChunk(await profiler.stop(), profiler.sampleInterval);
```

The profiler needs the `Document-Policy: js-profiling` response header (Chromium-only today). When it's
unavailable, record why instead of leaving a silent gap: `enc.markStream('profile', 'policy-blocked')`.

### Custom events — stack-based timelines

Instrument your own code with named, timed, namespaced spans. Open a `Timeline` per namespace; `depth`
comes from the call stack and `duration` from the begin→end delta — you don't compute either.

```ts
const app = enc.timeline('checkout'); // one track per namespace (cached)

// Handle-based begin/end (tolerates async / overlap):
const span = app.begin('place-order', { items: 3 });
//   … await work …
span.end({ ok: true }); // details merged over the begin-time details

// Scoped — begin/run/end in one call (awaits if the callback is async), returns the result:
const total = app.span('sum', () => items.reduce((a, b) => a + b.price, 0));
app.span('render', { route: '/cart' }, async () => { await paint(); });

// A zero-duration marker at the current depth:
app.instant('cache-miss', { key });

// Escape hatch: append a pre-measured event verbatim.
app.event({ name: 'gc', start: asRelMs(t0), duration: asDurationMs(t1 - t0), depth: 0 });
```

Nested spans produce nested slices (a viewer renders `place-order` ⊃ its children). Custom-event
durations are **measured**, so they keep full microsecond precision (unlike inferred profile slices).

## Feeding pre-normalized data

Already have model-shaped data (your own pipeline, `web-vitals` hooks, a replay)? Every stream has a
typed feed method — the sink is sugar over exactly these:

- singletons (set replaces): `setNavigation`, `setPaint`, `setLcp`, `setEnvironment`
- append streams: `addResource`, `addLayoutShift`, `addInteraction`, `addLongTask`, `addLoaf`,
  `addElementTiming`, `addVisibility`, `addError`, `mark`, `measure`
- profiler: `addProfilerChunk`; custom spans: `timeline(ns)`

All feed methods return `this` for chaining. Untouched streams are recorded `not-requested`; a fed
stream becomes `present`. Timestamps in the model are branded (`RelMs`/`DurationMs`/`EpochMs`) so
epoch-vs-relative mix-ups are compile errors — wrap raw numbers with `asRelMs`/`asDurationMs` at your
boundary (the normalizers do this for you on the browser path).

The per-entry normalizers are also exported standalone (`normalizeResource`, `normalizeNavigation`,
`normalizeLcp`, `normalizeLayoutShift`, `normalizeInteraction`, `normalizeLongTask`, `normalizeLoaf`,
`normalizeElementTiming`, `normalizeMark`, `normalizeMeasure`, `normalizeVisibility`) — each accepts a
live `PerformanceEntry` **or** its `toJSON()` form, with every field read runtime-guarded, so they also
work for replaying stored raw entries in Node.

### Metadata, overhead, and finishing

```ts
enc.setMetadata({ page: 'product' });               // replace the metadata (copied shallowly)
enc.putMetadata('variant', 'B');                    // merge one key — never mutates YOUR object
enc.setOverhead({ mainThreadMs: asDurationMs(4.2) }); // your self-measured capture cost

const model = enc.toCapture();                 // the assembled in-memory Capture (for tests/tooling)
const bytes = await enc.finish();              // pack → Uint8Array; cached, so double-save paths
                                               // (pagehide + visibilitychange both firing) are free
enc.finished;                                  // true once finalized — further feeds would throw
```

Metadata, `detail`, and custom-event `details` values are normalized at pack time with
**`JSON.stringify` semantics** — `toJSON()` honored (a `Date` becomes its ISO string), `undefined`
properties dropped, non-finite numbers → `null` — so a stray `undefined` in a page's `detail` can never
crash a capture. See [FileFormat.md](FileFormat.md) for the exact rules.

`finish()` (and `toCapture()`) finalize the profiler fold and any still-open spans, then assemble the
TOTAL manifest. After finishing, feed *methods* throw — including on held `Timeline` handles — while the
*sink* drops silently (an observer can deliver after save; that must not throw inside the page).

## Reading captures

```ts
import { unpack, sniff, checkConsistency } from 'rumcap/decode';

sniff(bytes);                        // { codecVersion, formatVersion, readable } | null — magic +
                                     // versions from the cleartext header, no decompression
const capture = await unpack(bytes); // Uint8Array | ArrayBuffer → Capture

// Lossless to 1µs on timeline values and exact otherwise, with two documented normalizations
// (lone surrogates → U+FFFD; JSON values → JSON.stringify semantics — see FileFormat.md):
// unpack(pack(c)) deep-equals c for any capture already in that normal form (everything the
// Encoder/normalizers produce).
```

If you already have a `Capture` model, `pack(capture)` (from `rumcap/encode`) skips the `Encoder`.

`unpack` reads files from **newer writers** too, pulling what it knows (unknown sections/streams and
newer-schema payloads are skipped; the manifest always survives) and rejects only an unknown
`CODEC_VERSION` or a corrupt body — see [FileFormat.md](FileFormat.md) "Reading across versions".

`checkConsistency(capture)` returns human-readable problems if the manifest and payloads disagree (a
stream marked `present` with no data, or data on a non-present stream — and, distinctly, a present
stream whose payload this build *skipped* because it was written with a newer schema). It's for
tests/ingest tooling — not the hot pack path; the codec round-trips faithfully without judging.

## Types

The model types are exported from every entry (`Capture`, `Manifest`, `Streams`, the per-stream entry
types, `CustomEvent`, `JsonValue`, the branded `RelMs`/`DurationMs`/`EpochMs`, …). Construct branded
times with `asRelMs`/`asDurationMs`/`asEpochMs`.

See the runnable [`examples/capture`](../examples/capture) (a page capturing itself — observer wiring,
profiler checkpoints, save-on-hide) and [`examples/extension`](../examples/extension) (a Chrome MV3
harness that injects it into any page).
