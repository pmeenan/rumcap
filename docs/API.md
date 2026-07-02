# `rumcap` API

`rumcap` encodes and decodes the compact, self-describing `.rcap` capture format. You bring your own
capture code (PerformanceObservers, the JS Self-Profiler, app instrumentation); `rumcap` aggregates and
packs it. The wire spec is [FileFormat.md](FileFormat.md).

## Entry points

Three, so a page ships only what it uses:

| Import | Contains | Use when |
|---|---|---|
| `rumcap/encode` | `pack`, the streaming `Encoder`, `SliceBuilder`, constants + all types | producing captures on a page |
| `rumcap/decode` | `unpack`, `checkConsistency`, constants + all types | reading captures in tooling/servers |
| `rumcap` | the union of both | convenience / when size doesn't matter |

**Tree-shaking:** `rumcap/encode` imports **no decode code** — no `unpack`, no `DecompressionStream`.
It's a physical split (separate modules + subpath exports), so the decoder can't reach a user's page
even without a bundler. Importing `rumcap/encode` (pack + `Encoder` + `SliceBuilder`) bundles to ~6.6 KB
gzip.

```bash
npm install rumcap
```

## Streaming capture — the `Encoder`

Construct an `Encoder`, stream events in as your own observers fire, then `finish()` for the packed
bytes.

```ts
import { Encoder, asRelMs, asDurationMs } from 'rumcap/encode';

const enc = new Encoder({
  metadata: { release: '2026.7.1', experiment: 'checkout-v3' }, // arbitrary capture-level JSON (copied shallowly)
  sampleIntervalMs: asDurationMs(10), // the profiler's clamped interval, for the slice fold
});

// Feed browser entries as you observe them. Normalize each PerformanceEntry to the model shape
// (see examples/capture for a worked example). Every method returns `this` for chaining.
// Timestamps are branded (RelMs/DurationMs) so epoch-vs-relative mix-ups are compile errors —
// wrap raw numbers with asRelMs/asDurationMs at the capture boundary.
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) enc.addResource(normalizeResource(e));
}).observe({ type: 'resource', buffered: true });

// …and the singletons / other streams:
enc.setNavigation(nav).setLcp(lcp).mark({ name: 'hydrated', startTime: asRelMs(performance.now()) });

const bytes = await enc.finish(); // Uint8Array — the packed .rcap
```

Feed methods mirror the streams: `setNavigation`, `setPaint`, `setLcp`, `setEnvironment`;
`addResource`, `addLayoutShift`, `addInteraction`, `addLongTask`, `addLoaf`, `addElementTiming`,
`addVisibility`, `addError`; `mark`, `measure`. Untouched streams are recorded `not-requested`; a fed
stream becomes `present`.

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

### The JS Self-Profiler

Fold raw `Profiler.stop()` chunks in as you collect them — the slices accumulate incrementally, so the
unload path stays cheap.

```ts
const profiler = new Profiler({ sampleInterval: 10, maxBufferSize: 30000 });
// …at idle checkpoints and at the end:
const trace = await profiler.stop();
trace.sampleIntervalMs = asDurationMs(profiler.sampleInterval);
enc.addProfilerChunk(trace); // folded to slices immediately (SliceBuilder)
```

The profiler needs the `Document-Policy: js-profiling` response header (Chromium-only today). When it's
unavailable, record why instead of leaving a silent gap:

```ts
enc.markStream('profile', 'policy-blocked'); // or 'unsupported' / 'dropped' / 'not-requested'
```

### Metadata, overhead, and finishing

```ts
enc.setMetadata({ page: 'product' });               // replace the metadata (copied shallowly)
enc.putMetadata('variant', 'B');                    // merge one key — never mutates YOUR object
enc.setOverhead({ mainThreadMs: asDurationMs(4.2) }); // your self-measured capture cost

const model = enc.toCapture();                 // the assembled in-memory Capture (for tests/tooling)
const bytes = await enc.finish();              // pack it → Uint8Array (idempotent; safe to call once)
```

Metadata, `detail`, and custom-event `details` values are normalized at pack time with
**`JSON.stringify` semantics** — `toJSON()` honored (a `Date` becomes its ISO string), `undefined`
properties dropped, non-finite numbers → `null` — so a stray `undefined` in a page's `detail` can never
crash a capture. See [FileFormat.md](FileFormat.md) for the exact rules.

`finish()` (and `toCapture()`) finalize the profiler fold and any still-open spans, then assemble the
TOTAL manifest. After finishing, further feed calls throw — including on held `Timeline` handles.

## One-shot codec

If you already have a `Capture` model, skip the `Encoder`:

```ts
import { pack } from 'rumcap/encode';
import { unpack, checkConsistency } from 'rumcap/decode';

const bytes = await pack(capture);   // Capture → Uint8Array (gzipped .rcap)
const back = await unpack(bytes);    // Uint8Array | ArrayBuffer → Capture

// Lossless to 1µs on timeline values and exact otherwise, with two documented normalizations
// (lone surrogates → U+FFFD; JSON values → JSON.stringify semantics — see FileFormat.md):
// unpack(pack(c)) deep-equals c for any capture already in that normal form (everything a
// browser produces).
```

`unpack` reads files from **newer writers** too, pulling what it knows (unknown sections/streams and
newer-schema payloads are skipped; the manifest always survives) and rejects only an unknown
`CODEC_VERSION` or a corrupt body — see [FileFormat.md](FileFormat.md) "Reading across versions".

`checkConsistency(capture)` returns human-readable problems if the manifest and payloads disagree (a
stream marked `present` with no data, or data on a non-present stream — and, distinctly, a present
stream whose payload this build *skipped* because it was written with a newer schema). It's for
tests/ingest tooling — not the hot pack path; the codec round-trips faithfully without judging.

```ts
const issues = checkConsistency(back); // string[] — empty means manifest + payloads agree
```

## Types

The model types are exported from every entry (`Capture`, `Manifest`, `Streams`, the per-stream entry
types, `CustomEvent`, `JsonValue`, the branded `RelMs`/`DurationMs`/`EpochMs`, …). Timestamps are
branded so an epoch-vs-relative mix-up is a compile error; construct them with `asRelMs`/`asDurationMs`/
`asEpochMs`.

See the runnable [`examples/capture`](../examples/capture) (a page capturing itself) and
[`examples/extension`](../examples/extension) (a Chrome MV3 harness that injects it into any page).
