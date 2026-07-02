# Capture demo

A **reference consumer** of the `rumcap` library — not shipped product. It shows how a page can capture
its own Web Performance data with its own `PerformanceObserver`s + the JS Self-Profiler and stream it
into the `rumcap` `Encoder`, then pack a `.rcap` file. All measurement comes from standard in-page
browser APIs; `rumcap` only aggregates and packs.

## What it demonstrates

- Constructing an `Encoder` with capture-level **metadata** + `environmentSnapshot()`.
- **One `entrySink` as the callback for every `PerformanceObserver`** — normalization onto the model
  (sentinel stripping, first-input dedup, LCP/paint accumulation, structural selectors for live
  attribution) happens inside the library, so what remains here is only the capture *policy*: which
  entry types to observe, and marking a stream `unsupported` when a browser can't deliver it.
- The **incremental profiler fold**: `Profiler.stop()` at periodic checkpoints →
  `addProfilerChunk(trace, actualInterval)` (folded to slices immediately), so the unload path stays
  cheap — and `policy-blocked` recorded when the Document-Policy header is missing.
- Window `error`/`unhandledrejection` events fed through `normalizeErrorEvent`/`normalizeRejection`.
- A custom **`demo-app` timeline** authored with the stack-based API (`timeline().span()` / `begin`/`end`
  / `instant`) — depth comes from the call stack, duration from the begin→end delta.
- `encoder.finish()` → a downloaded `.rcap` (also auto-saved on `visibilitychange`→hidden), with
  observer queues flushed through the sink first so the tail of the session isn't dropped.

## Run it

```bash
# from the repo root
npm run build                 # build the library into dist/
npx serve .                   # or: python3 -m http.server
# open http://localhost:<port>/examples/capture/
```

The page's import map resolves `rumcap/encode` to `../../dist/encode.js`, so native ESM loads the built
library directly — no bundler needed for the demo. Interact with the page, then **Save capture** (or
switch tabs). Open the `.rcap` in a supporting viewer
([waterfall-tools](https://github.com/pmeenan/waterfall-tools)).

## The JS Self-Profiler

Self-profiling requires the `Document-Policy: js-profiling` response header, which a normal page can't
set for itself. On a page you don't control, use the [extension demo](../extension/) to inject it; when
the header is absent the demo records `profile: policy-blocked` (absence is data, never silence). The
header/API are Chromium-only today — verify current support before relying on them.

> A production integration would live behind its own overhead budget and redaction pass (redaction is
> a pre-`pack` step, not part of the codec).
