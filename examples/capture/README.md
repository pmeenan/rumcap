# Capture demo

A **reference consumer** of the `rumcap` library — not shipped product. It shows how a page can capture
its own Web Performance data with its own `PerformanceObserver`s + the JS Self-Profiler and stream it
into the `rumcap` `Encoder`, then pack a `.rcap` file. All measurement comes from standard in-page
browser APIs; `rumcap` only aggregates and packs.

## What it demonstrates

- Constructing an `Encoder` with capture-level **metadata**.
- Normalizing each browser entry to the shared model and streaming it in (`setNavigation`, `addResource`,
  `setLcp`, `addLayoutShift`, `addInteraction`, `addLongTask`, `addLoaf`, `mark`/`measure`,
  `addVisibility`, `addError`, `setEnvironment`).
- **Live attribution** that can't be recovered later (LCP element, CLS sources, INP target) captured as
  structural CSS-path selectors — never element text (PII).
- The **incremental profiler fold**: `Profiler.stop()` at periodic checkpoints → `addProfilerChunk()`
  (folded to slices immediately), so the unload path stays cheap.
- A custom **`demo-app` timeline** authored with the stack-based API (`timeline().span()` / `begin`/`end`
  / `instant`) — depth comes from the call stack, duration from the begin→end delta.
- `encoder.finish()` → a downloaded `.rcap` (also auto-saved on `visibilitychange`→hidden).

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

> This file favors clarity over completeness: it maps the common fields of each stream to show the
> pattern, not every optional the format models. A production integration would live behind its own
> overhead budget and redaction pass (redaction is a pre-`pack` step, not part of the codec).
