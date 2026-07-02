# rumcap — Architecture

> The library's design. The wire spec is [FileFormat.md](FileFormat.md); the usage/API is
> [API.md](API.md). This document is the "why and how it fits together."

## 1. Goal

Own one thing well: a compact, self-describing binary container (`.rcap`) for real-user
web-performance captures, with an **encoder** that aggregates events streamed in from any capture code
and a separate **decoder** for tooling. Capturing is the consumer's job; viewing is
[waterfall-tools](https://github.com/pmeenan/waterfall-tools). Everything else the earlier drafts
imagined (transport, server, aggregate, a bespoke renderer) is out of scope.

## 2. Principles

1. **Self-describing & robust to missing data.** Every stream is optional; the manifest records what's
   present and, for anything absent, *why*. Unknown is never confused with zero.
2. **One correlated timeline.** All signals sit on a single `performance.timeOrigin`-anchored clock;
   ordering uses monotonic offsets, never epoch/`Date.now()` thresholds.
3. **Honest precision.** Measured timings keep full 1µs precision; a value that was only *inferred*
   (profile-slice durations) is stored coarser rather than faked. Never synthesize data you didn't
   measure.
4. **Tiny on the page.** The encode path is zero-dependency and tree-shakes free of the decoder.
5. **Privacy-aware.** URLs and stack frames can carry PII; redaction is a pre-`pack` pass, designed for
   but separate from the codec.
6. **Open, versioned format.** A wire `CODEC_VERSION` and a schema `FORMAT_VERSION`, with skippable
   sections/streams so the format survives browser-API churn and third-party adoption.

## 3. The data model

A `Capture` (`src/capture.ts`) is: a **manifest**, a set of optional **streams** on one clock,
optional self-measured **overhead**, and optional capture-level **metadata** (arbitrary JSON).

**Streams** (all optional, `src/streams/`): navigation, resources, paint, LCP, CLS, interactions
(Event Timing/INP), long tasks, LoAF, element timing, user timing, visibility, environment, the JS
**profile** (stored as derived nested slices, not raw samples), errors, and **customEvents** —
app/library-instrumented named, timed, namespaced spans.

**Manifest** (`src/manifest.ts`): the clock metadata, then a **TOTAL** per-stream status record
(`present | unsupported | not-requested | dropped | policy-blocked` + schemaVersion + loss +
provenance), then the embedded capture-config. Totality is the whole point — a reader can always tell
*not collected* from *collected, found nothing*.

## 4. Data flow

```
   your capture code                          rumcap                          tooling / viewer
  (PerformanceObserver,   ──►  entrySink/normalizers (raw entry →   ──►  .rcap  ──►  unpack → Capture
   JS Self-Profiler,           model) → Encoder (aggregate,                          waterfall-tools
   app instrumentation)        fold samples→slices)                                 (transcode → Perfetto)
                                     │
                                     ▼
                               pack(Capture) → gzipped .rcap bytes
```

- The **canonical artifact** is the `.rcap` file (magic `F5 52 55 4D`).
- **Viewing** transcodes `.rcap` → Perfetto in waterfall-tools; `rumcap` keeps its own compact format
  for wire size, redaction control, and ownership of the schema. That work lives in waterfall-tools, not
  here.

## 5. Components (within the single package)

- **`format` model** (`src/{capture,manifest,config,registry,version,json,time}.ts`, `src/streams/`) —
  the TypeScript contract. Timestamps are branded (`RelMs`/`DurationMs`/`EpochMs`) so an epoch-vs-relative
  mix-up is a compile error.
- **codec** (`src/codec/`) — descriptor-driven encode/decode, **physically split** so `rumcap/encode`
  carries no decoder. Shared *data* (the `Desc` tables, section-tag constants) lives in modules both
  sides import, which is what makes encode/decode unable to drift; the stream table is total, so every
  stream id has a descriptor by construction. A few shapes a flat table can't express (navigation's
  two-block payload, the recursive `notRestoredReasons` tree, sparse maps, derived-edge rects, columnar
  profile slices) are special-handler *tags* in those same tables. Size levers are measured, not
  assumed (codec v3): a probe pass finds the capture's real tick grid (its GCD) and every timestamp is
  a scaled per-scope delta; struct arrays go column-major at 8+ entries so gzip models each field's
  column separately. `sniff` reads the cleartext magic + versions without decompressing, for tooling
  that routes files. See [FileFormat.md](FileFormat.md).
- **`Encoder`** (`src/encoder.ts`) — the streaming "rumcap instance": feed methods per stream, stack-based
  custom-event timelines (depth from the call stack, duration from begin→end), the incremental profiler
  fold, then `finish()` → bytes (cached — double-save paths re-use them). Accumulates the `Capture`
  model and delegates to `pack`.
- **browser integration** (`src/browser.ts`) — the normalization from RAW Web Performance API output
  (live entries or their `toJSON()` forms) onto the spec-canonical model, plus `entrySink` (a ready-made
  `PerformanceObserver` callback holding the stateful quirks: paint/LCP accumulation, first-input twin
  dedup, droppedEntriesCount → loss notes) and `environmentSnapshot`. This is where platform sentinels
  (`0`/`''`/`-1`) become *absence* and browser spellings land on spec names — stated once, grounded in
  the sample corpus, instead of re-implemented per consumer. Deliberately independent of the `Encoder`
  (type-only dependency) so it tree-shakes away for consumers that feed pre-normalized models. Capture
  *policy* — which observers, profiler lifecycle, when to save — remains the consumer's (see the demos).
- **`SliceBuilder`** (`src/profile-slices.ts`) — the samples→slices fold. A sampling profiler can only
  observe that a frame was on-stack across a run of samples; the builder coalesces each contiguous run
  spanning ≥ ~1 interval into one slice and drops shorter transients to a `droppedSamples` count. It's
  incremental (fold `Profiler.stop()` chunks at checkpoints) so the unload path stays cheap.

## 6. Cross-cutting concerns

- **Time base.** One `timeOrigin`-anchored clock; per-context (iframe/worker) mappings are modeled but
  unused until multi-context capture exists. Epoch values are metadata; monotonic offsets drive order.
- **Loss & truncation.** Buffer-full, sample-budget, and size-budget losses are recorded in the
  manifest, never silently dropped.
- **Overhead.** A capture can self-measure and record its own CPU/byte cost in-band (`OverheadReport`).
- **Redaction.** A pre-`pack` pass over the `Capture` (URL/stack-frame policies); the codec round-trips
  faithfully without judging, and `checkConsistency` (tooling) flags manifest/payload disagreements.
- **WASM-readiness.** The structural encode is synchronous and per-section — the seam a WASM codec or an
  incremental on-page driver would slot into behind the same API.

## 7. Reference & viewer

[waterfall-tools](https://github.com/pmeenan/waterfall-tools) is the supported viewer and an
implementation reference for Perfetto embedding. `rumcap` stays independent of it.
