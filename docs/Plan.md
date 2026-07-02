# rumcap — Plan

> Status and roadmap. Design context: [Architecture.md](Architecture.md); the contract surfaces are
> [API.md](API.md) and [FileFormat.md](FileFormat.md).

## Where things stand

The project pivoted from a broad multi-component pipeline (`rum-profiler`) to a single, focused library
for the `.rcap` format (`rumcap`). Done and green (lint + typecheck + the golden-corpus round-trip,
including the degraded captures):

- **The format model** — schema, TOTAL manifest, capture-config, branded time types, grounded in real
  Chrome-149 captures under [`samples/`](../samples).
- **The binary codec** — descriptor-driven `pack`/`unpack`, compact (interning, varints, fixed-point-µs
  timestamps, presence bitmaps, columnar profile slices, gzip); smaller than gzipped JSON on the corpus,
  lossless to 1µs.
- **Cross-version reading + hardening (codec v2)** — self-describing manifest stream records (count +
  frame + length-prefixed tail) so readers pull what they know from newer files; duplicate/mis-ordered
  sections rejected loudly; JsonValue normalized with `JSON.stringify` semantics (no crash on
  `undefined`, `__proto__`-safe own-property decode); the U+FFFD lone-surrogate carve-out documented;
  Encoder post-finish guards + metadata copy semantics. Grew out of the pre-commit review of the pivot.
- **The encode/decode split** — `rumcap`, `rumcap/encode`, `rumcap/decode` subpath exports over a
  physical module split; `rumcap/encode` verified free of the decoder (no `DecompressionStream`).
- **The streaming `Encoder`** — feed methods per stream, stack-based custom-event timelines, the
  incremental profiler fold, `finish()` → bytes.
- **`FORMAT_VERSION` 2** — capture-level `metadata` (a skippable section) and the `customEvents` stream.
- **Browser-entry integration** (`src/browser.ts`, 2026-07-01) — `entrySink` (a ready-made
  `PerformanceObserver` callback) + per-type normalizers + `environmentSnapshot` + error-event mappers,
  so raw browser output plugs straight into the `Encoder`; sentinel stripping (`0`/`''`/`-1`),
  first-input twin dedup (only the twin — the corpus shows distinct events legitimately sharing
  startTime+name), spec-name mapping, and droppedEntriesCount→loss all live in the library now instead
  of every consumer. Grounded by replaying all 8 real sample captures in `test/browser.test.ts`;
  tree-shakes away (~2.6 KB gzip when used; core stays ~6.4 KB). Ergonomics fixed in the same pass:
  `addProfilerChunk(trace, sampleIntervalMs?)` (no more mutating the browser's trace), cached
  `finish()`, `encoder.finished`, decode-side `sniff()`.
- **Real size numbers** ([`samples/capture-tool/sizes.mjs`](../samples/capture-tool/sizes.mjs)) — full
  captures incl. the 10ms profile: CNN 6.9 KB, Google Finance 10.8 KB, v0.app 10.7 KB (from a 1 MB raw
  dump), Etsy 18.8 KB; 23–48% under gzipped JSON of the identical model. In the README.
- **Demos** — [`examples/capture`](../examples/capture) (a page capturing itself — rewritten on
  `entrySink`, verified end-to-end in headless Chrome) and [`examples/extension`](../examples/extension)
  (a Chrome MV3 harness).

## Next

- **`.rcap` support in waterfall-tools** — the supported viewer transcodes `.rcap` → Perfetto. Done
  there, separately; `rumcap` just needs to keep the format stable and documented.
- **Redaction pass** — a pre-`pack` transform over the `Capture` (URL/stack-frame policies), governed by
  the config that already travels in the manifest. Designed-for, not yet built.
- **Incremental byte-output** — the codec's per-section encode is already the seam; a driver that
  flushes stream bytes as they settle and only writes the small string table at unload (true "no unload
  cliff" streaming output, and/or a `ReadableStream` result from `finish()`) is a possible follow-up.
- **Wider corpus** — Safari/Firefox captures (real degraded variants) and a page with opaque
  third-party JS to exercise profiler-frame redaction.
- **Freeze the format** — once validated against more real captures, leave `FORMAT_VERSION` draft and
  document migrations in [FileFormat.md](FileFormat.md).

## Resolved decisions

- **Naming** — npm `rcap` was taken → everything is **`rumcap`**: the package, the GitHub repo
  (**`pmeenan/rumcap`** — decided 2026-07-01; the local remote points there; create the repo before the
  first push — the old `rum-profiler` remote is retired), and the format itself. The ONLY surviving use
  of the short name is the `.rcap` file extension. The `\xF5RUM` magic is unchanged (changing it would
  be a `CODEC_VERSION` break that invalidates the corpus).
- **Layout** — single package at the repo root (`src`/`test`/`samples`/`examples`/`docs`), not npm
  workspaces.
- **Tooling** — TypeScript (strict, NodeNext, `verbatimModuleSyntax`), ESLint flat config (gate), vitest,
  `tsc -b`; esbuild (via `npx`) for the demo bundle + the tree-shake check.
- **Magic / extension** — `F5 52 55 4D` (`\xF5RUM`) + `.rcap`; wire `CODEC_VERSION` separate from schema
  `FORMAT_VERSION`.
- **Timestamps** — fixed-point 1µs (zigzag varint) for measured timeline values; the **one exception** is
  inferred profile-slice durations at 1ms. **Custom-event durations are measured → full µs** (not the
  slice exception).
- **Custom events** — one fixed `customEvents` stream containing user-named namespaced tracks (namespaces
  are data, not stream ids); nesting via an explicit optional `depth` derived from the authoring stack;
  encoded through the generic descriptor walker (no special handler) until real captures show volume that
  would justify a columnar one.
- **Normalization is the library's; capture policy is the consumer's.** Raw-browser-shape → model mapping
  (sentinels, spellings, dedup) lives in `src/browser.ts` — it is knowledge about the format and was
  proven too subtle to leave to every consumer (the demo's own hand-rolled version had a real dedup bug
  the corpus replay caught). Observer wiring, profiler lifecycle, sampling, and transport stay out of
  the library.
- **Profiler representation** — nested timed slices (call-tree), folded from raw samples on-page by
  `SliceBuilder`; a responsiveness view, not CPU-time accounting. (Full rationale retained in git
  history / the code comments.)

## History (superseded)

Earlier drafts scoped a 10-component pipeline — `capture`, `format`, `transcode`, `viewer`, `analysis`,
`symbolication`, `transport`, `server`, `aggregate`, `extension` — across four phases (foundations →
local loop → field collection → aggregate). Only `format` was ever built. The pivot narrowed the
project to the format library: `format` became the whole package, `capture`/`extension` became demos,
viewing moved to waterfall-tools, and the rest was cut. The old component design docs live in git
history if ever needed.
