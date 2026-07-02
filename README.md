# rumcap

A small, dependency-free library for the **`.rcap`** capture format — a compact, self-describing binary
format for real-user web-performance captures. It ships a streaming **encoder** and a separate,
tree-shakeable **decoder** (published on npm as **`rumcap`**; the format and repo keep the shorter
`rcap` name).

You bring your own capture code — `PerformanceObserver`s, the JS Self-Profiler, your app's own
instrumentation — and stream events into a `rumcap` encoder, which aggregates and packs them into a
small `.rcap` file. `rumcap` owns the **format and the packing**; presentation is delegated to a viewer.

```ts
import { Encoder, asRelMs } from 'rumcap/encode';

const enc = new Encoder({ metadata: { release: '2026.7.1' } });

// feed browser entries as your own observers see them…
enc.setNavigation(nav).addResource(res).mark({ name: 'hydrated', startTime: asRelMs(performance.now()) });

// …instrument your own code with stack-based, namespaced spans (depth from the call stack,
// duration from begin→end)…
enc.timeline('checkout').span('place-order', { items: 3 }, () => submit());

// …and get the packed .rcap bytes.
const bytes = await enc.finish();
```

See **[docs/API.md](docs/API.md)** for the full API and **[docs/FileFormat.md](docs/FileFormat.md)** for
the wire specification.

## Why

Most RUM libraries own capture *and* storage *and* presentation, in one bundle. `rumcap` unbundles the
middle: a tiny, versioned, self-describing container that any capture code can write and any tool can
read. That means:

- **Bring your own capture.** Use `web-vitals`, a framework's hooks, your own observers — whatever
  produces the events. `rumcap` just aggregates and packs them.
- **Instrument your own code.** The `customEvents` stream gives libraries and app code a generic,
  profiler-like way to record named, timed, detail-carrying spans, namespaced onto separate timelines.
- **Attach capture-level metadata.** Arbitrary JSON (release, experiment, page type, …) travels with
  the capture.
- **Tiny on the page.** Zero runtime dependencies; the encoder tree-shakes free of the decoder. The
  full encode surface (pack + streaming `Encoder` + profiler fold) is ~6.6 KB gzip.

## Two independent halves

```ts
import { pack, Encoder } from 'rumcap/encode';   // producing captures on a page — no decoder shipped
import { unpack } from 'rumcap/decode';          // reading captures in tooling
import { pack, unpack } from 'rumcap';           // both, for convenience
```

The split is physical (separate modules + subpath exports), so an encode-only import can't pull in the
decoder or `DecompressionStream` even without a bundler.

## Format highlights

- **Self-describing & robust to missing data.** Every stream is optional; the manifest records what's
  present and, for anything absent, **why** (`unsupported` / `not-requested` / `dropped` /
  `policy-blocked`) plus loss/truncation and provenance. *Unknown is never confused with zero.*
- **Compact.** String interning, LEB128 varints, fixed-point-µs timestamps, presence-bitmap optionals,
  columnar profile slices, and an outer gzip — smaller than gzipped JSON on the golden corpus.
- **Versioned.** A wire `CODEC_VERSION` and a schema `FORMAT_VERSION` (both currently **2**), with
  skippable sections/streams and self-describing manifest records so a reader pulls what it knows from a
  newer file — adding a stream never breaks an older reader (see
  [docs/FileFormat.md](docs/FileFormat.md) "Reading across versions").
- **Honest precision.** Measured timings keep full 1µs precision; sample-*inferred* profile-slice
  durations are deliberately coarsened to 1ms rather than fake microseconds.

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

- **Out of scope:** capturing (bring your own — the demos show how), transporting/beaconing, server
  ingest, aggregate dashboards, and rendering. Earlier drafts scoped these as sibling components; that
  breadth was cut. Viewing lives in waterfall-tools.
- **In scope:** the schema, the binary codec, the streaming encoder that aggregates your events, and the
  golden corpus that keeps it honest.

## Development

```bash
npm install
npm run build      # tsc -b → dist/
npm test           # typecheck + vitest (round-trips the golden corpus, incl. degraded captures)
npm run lint       # eslint (warnings = errors)
```

Layout: [`src/`](src) is the library, [`test/`](test) the golden-corpus round-trip suite, [`samples/`](samples)
the real Chrome captures the schema is grounded in, [`examples/`](examples) the demos, [`docs/`](docs)
the API + format specs + architecture. Contributor guidance is in [AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE). Product code (anything that can reach a user's page) uses only permissive
dependencies; dev/build tooling that never ships may use weak-copyleft licenses that can't leak — see
[AGENTS.md](AGENTS.md).
