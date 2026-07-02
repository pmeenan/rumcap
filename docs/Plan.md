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
- **Demos** — [`examples/capture`](../examples/capture) (a page capturing itself) and
  [`examples/extension`](../examples/extension) (a Chrome MV3 harness).

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

- **Package name** — npm `rcap` was taken → the package is **`rumcap`**; the format/repo keep the
  shorter `rcap` name, the `.rcap` extension, and the `\xF5RUM` magic (unchanged — changing the magic
  would be a `CODEC_VERSION` break that invalidates the corpus).
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
