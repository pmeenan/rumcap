# rumcap — AI Agent Guidance

`rumcap` is a small, dependency-free library for the **`.rcap`** capture format — a compact,
self-describing binary format for real-user web-performance captures. It ships a streaming **encoder**
and a separate, tree-shakeable **decoder**. Package, GitHub repo (`pmeenan/rumcap`), and format are all
named `rumcap`; the ONLY place the short name survives is the `.rcap` file extension. This file is
long-term project memory — keep it current.

The scope is deliberately narrow: **the format — encode and decode — plus the normalization from raw
browser-API output onto the model (`src/browser.ts`: `entrySink` + the per-entry normalizers), and
nothing else.** Normalization is format knowledge (sentinel stripping, spec-name mapping, dedup) and is
stated once, in the library; capture *policy* — which observers to run, profiler lifecycle, sampling,
transport, when to save — is brought by the consumer (the demos under `examples/` show how); viewing is
delegated to [waterfall-tools](https://github.com/pmeenan/waterfall-tools). Earlier drafts scoped a
broad multi-component pipeline (capture, transport, server, aggregate, transcode, viewer); that breadth
was cut. Don't reintroduce it.

## Workflow (mandatory)

- **Start:** read [`docs/Architecture.md`](docs/Architecture.md), and — for anything touching the API or
  wire — [`docs/API.md`](docs/API.md) and [`docs/FileFormat.md`](docs/FileFormat.md). `docs/Plan.md`
  holds the roadmap/history.
- **End:** update the docs you invalidated — `README.md`, `docs/API.md`, `docs/FileFormat.md`,
  `docs/Architecture.md`, `docs/Plan.md`, and any touched `examples/*/README.md`. Update this
  `AGENTS.md` when conventions change.
- **Hygiene:** delete throw-away diagnostic scripts, `.log` files, and scratch outputs before
  concluding (use the session scratchpad, not the repo, for temporaries).
- **Contracts:** any change to the schema or the public API MUST be reflected in `docs/API.md` /
  `docs/FileFormat.md`, and the version bumped (`FORMAT_VERSION` for the schema/model, `CODEC_VERSION`
  for the wire encoding; see `src/version.ts` and `src/codec/constants.ts`). A stale contract is a bug.

## Guardrails

This project is built largely with AI assistance; these keep that on the rails.

- **Verify the platform; don't trust memory.** Browser performance APIs and their exact entry fields,
  browser support, the JS Self-Profiling output shape, and MV3 injection rules all change and are easy
  to misremember. Confirm against the spec / MDN / caniuse **and** real browser output before relying on
  a shape. Unsure how an API behaves? Capture a real sample and look.
- **Ground in real captures.** The golden corpus (`test/fixtures.ts`, grounded in the real Chrome
  captures under `samples/`) is the source of truth. When you need to know what a stream really looks
  like, add a real captured sample and build against it — don't fabricate data, guess a shape, or
  hard-code values you "expect." Label stubs/mocks as such; never present them as real or ship them.
- **The contract models the spec, not one browser's output.** The schema carries the **spec-canonical,
  normalized** shape of an API — not whatever a single browser's `toJSON()` emits today. When real
  output diverges from the spec in name, shape, or vocabulary (e.g. Chrome's experimental
  `workerMatched*SourceType` vs. the spec's `workerMatched*RouterSource`), the model uses the **spec**
  form, a capture integration normalizes the browser quirk onto it, and the raw corpus keeps the
  browser's actual output. A field you can't ground in a real capture (the sample is `null`/`{}`/absent)
  must be **verified against the actual spec/IDL text — cite it in a comment — and marked `PROVISIONAL`,
  or left out**; never shape it from memory. Keep the schema-vs-corpus field-coverage test so a *missing
  or renamed* field fails loudly — but know it can't catch a *wrong shape*, so the spec-citation
  discipline is what protects correctness there.
- **Verify before claiming it works.** "Packed / round-tripped / captured" means you ran it: produced
  bytes, unpacked them back to an equal model, or drove the demo in a real (or headless/stubbed) browser
  and looked. Report what you actually observed — partial/failing/skipped is fine to say; a confident
  "done" you didn't run is not.
- **Smallest change that does the job.** Don't add speculative abstraction or widen scope past the task
  (and don't rebuild the descoped pipeline). New abstraction earns its place only when a second real
  caller needs it.
- **Some decisions aren't yours.** Anything affecting the **wire format**, the on-page byte/CPU budget,
  privacy, the file magic/extension, or a license nuance is a human call — propose and flag, don't
  silently pick. For reversible in-task choices, take a sensible default and say so.
- **Never exfiltrate capture data.** Captures come from real, possibly-authenticated pages. In
  development, don't send them to any external service — no hosted-viewer "share"/permalink, no pasting
  captures into web tools, no third-party uploads. Keep processing local; redact fixtures.
- **Match what exists before adding.** Follow the established pattern (the descriptor-driven codec, the
  branded time types, the presence-bitmap optionals) before introducing a new dependency or abstraction.

## Definition of done

Before concluding a change:

- Lint clean (warnings = errors); tests and the golden corpus — including the degraded captures — pass.
- Touched on-page (encode) code? Re-check that `rumcap/encode` still tree-shakes free of the decoder
  (esbuild-bundle it; assert no `DecompressionStream`/decode strings) and note the bundle size.
- Changed the schema or the wire? `FORMAT_VERSION`/`CODEC_VERSION` bumped, `docs/API.md` +
  `docs/FileFormat.md` updated, a golden fixture added.
- Docs you invalidated are updated (`README.md`, `docs/`, `examples/*/README.md`, this file).
- No scratch scripts, `.log` files, or stray output left in the repo.

## Repository layout

Single package at the repo root:

- `src/` — the library. `codec/` is the binary encode/decode (split into shared `constants`/
  `descriptors` + `field-encoder`/`encode-walker`/`pack` on the encode side and their decode mirrors;
  `sniff.ts` reads the cleartext header); `streams/` the per-stream models; `encoder.ts` the streaming
  `Encoder`; `browser.ts` the raw-browser-output → model normalizers + `entrySink` +
  `environmentSnapshot` (its dependency on the `Encoder` is type-only so it tree-shakes away — keep it
  that way); `profile-slices.ts` the samples→slices fold. `encode.ts`/`decode.ts`/`index.ts` are the
  public barrels behind the `.`, `./encode`, `./decode` exports; the constants/types both halves share
  are stated once in `contract.ts`, which both barrels re-export.
- `test/` — the golden-corpus round-trip suite (`fixtures.ts` + the `*.test.ts`); `browser.test.ts`
  replays every raw capture under `samples/json` through `entrySink` — the normalizers' grounding (keep
  its `liveView` graft in step with `samples/capture-tool/sizes.mjs`).
- `samples/` — the real Chrome captures the schema is grounded in (raw browser shapes + reproduction
  tooling, incl. `sizes.mjs`, which regenerates the README's size table); **not** the golden corpus.
- `examples/` — the demos (`capture`, `extension`) — reference consumers, not shipped product.
- `docs/` — `API.md` (usage + samples), `FileFormat.md` (wire spec), `Architecture.md`, `Plan.md`.
- `LICENSE` — Apache-2.0.

## Licensing (keep the project clean)

The distinction that matters is **product vs. tooling**, and the test is the *obligation a license
imposes on us*, not its name on a fixed list.

- The project ships under **Apache-2.0**.
- **Product code** — anything that can reach a real user's page or is distributed as part of a released
  artifact (the `rumcap/encode` path and any runtime that bundles it, e.g. the injected demo capture) —
  must be **permissive**: no copyleft or source-disclosure obligation on our combined/distributed work.
  Permissive is allowed as a *category*, not a closed list — MIT, BSD-2/3-Clause, Apache-2.0, ISC, 0BSD,
  Unlicense, Zlib, BlueOak-1.0.0, and equivalent OSI/FSF-recognized permissive terms all qualify.
  **Copyleft (GPL/LGPL/AGPL) and weak/file-level copyleft (MPL, EPL, CDDL) must never reach product
  code.** (The library itself is zero-runtime-dependency, so in practice this governs what a consumer
  may bundle with the encoder.)
- **Tooling** — dev/build/test/lint dependencies and capture-reproduction scripts that are **not** part
  of the resulting product and are never redistributed in it (TypeScript, Vitest, ESLint, esbuild,
  puppeteer-core) — may additionally use **weak/file-level copyleft (MPL-2.0, EPL, CDDL)**, *provided the
  license cannot leak into the product*. **Strong/network copyleft (GPL/LGPL/AGPL) in tooling is a human
  call** — default to avoiding it.
- When a license is unclear, or a *product* dependency is anything other than clearly permissive, **do
  not add it — ask first.** Prefer vendoring a small, clearly-licensed implementation over a heavy
  dependency.

## Core conventions

- **The library IS the contract.** The compact, versioned, self-describing format is what every consumer
  reads or writes; `docs/API.md` and `docs/FileFormat.md` are the contract surfaces. Schema/wire changes
  are versioned and documented there.
- **Encode and decode are physically split.** `rumcap/encode` must never import decode code (no
  `unpack`, no `DecompressionStream`) — shared *data* (descriptor tables, section-tag constants) lives
  in shared modules both sides read, which is also what keeps encode/decode from drifting. Keep it that
  way; the golden-corpus round-trip is the backstop.
- **Robust to missing data.** Every stream is optional. Never assume a stream is present; distinguish
  "absent" from "zero," and record *why* a stream is missing (`unsupported` / `not-requested` /
  `dropped` / `policy-blocked`) via the TOTAL manifest.
- **Missing is better than wrong.** Never synthesize, interpolate, or proportionally distribute data you
  didn't measure — omit it and mark it absent. This includes precision: measured durations keep full µs;
  sample-*inferred* profile-slice durations are deliberately coarsened to 1ms rather than faked.
- **Tiny on the page (hard rule).** The `rumcap/encode` path can reach a user's page, so it must stay as
  small and fast as possible: zero runtime dependencies, tree-shakeable, shipping only what's used.
- **Tooling/consumers may favor clarity.** The decoder (tooling-only), tests, and the demos are less
  size-critical and may prioritize correctness/readability — provided nothing ships into or slows a real
  user's page.
- **Privacy.** Assume URLs, stack frames, and timing can carry PII. Redaction/sanitization is a
  pre-`pack` pass (not part of the codec); the config that would govern it travels in the manifest.
- **Viewing is external.** `rumcap` emits `.rcap`; it does not render. The supported viewer is
  [waterfall-tools](https://github.com/pmeenan/waterfall-tools) (Perfetto/DevTools embedding), added
  there separately. Don't build a bespoke renderer here.
- **Browser-first.** The browser is the primary runtime and the source of truth for API semantics. Where
  code also runs under Node, Node provides the browser-shaped Web Platform globals (`performance`,
  `CompressionStream`, `TextEncoder`, streams). Target latest stable Chrome, Firefox, Safari (plus Node);
  ESM only; no transpilation or browser-support polyfills (current evergreen browsers).
- **Established tooling.** Single npm package (no workspaces). **TypeScript** strict with
  `module`/`moduleResolution: NodeNext`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess` — so relative imports carry explicit `.js` extensions and type-only
  imports/exports use `import type` / `export type`. **ESLint** flat config is the gate
  (`eslint . --max-warnings 0`; `examples/**` are linted with browser/webextension globals); **vitest**
  runs tests; builds use `tsc -b`, and tests are type-checked in the gate via a `noEmit` tsconfig
  (vitest strips types, so it alone would miss type errors). Timestamps are branded `RelMs` / `EpochMs`
  / `DurationMs` so epoch-vs-relative is a compile error. Web Platform globals are typed via the
  **`WebWorker`** lib — present in browsers *and* Node — **not** `DOM`, which would wrongly expose
  `document`/`window` to code that must also run under Node (see `tsconfig.json`).
- **The demo extension is a harness, not a measurement source.** It may inject scripts, set the
  `Document-Policy: js-profiling` header, and save captures. Do not use extension-only APIs
  (`webRequest`, DevTools Protocol, network interception) to collect performance data; measurement comes
  100% from in-page browser APIs.

## Data & performance

- **Explicit time units and base.** Every timestamp carries a known unit and base (epoch vs. monotonic).
  Normalizing streams onto one `timeOrigin`-anchored clock is the encoder/consumer's responsibility.
  Never discriminate epoch-vs-relative (or seconds-vs-ms) with magic thresholds like `> 1e12`; they
  break for small epochs and silently shatter the timeline. (A hard-won lesson from waterfall-tools.)
- **Zero cost when idle.** Debug/telemetry and any optional instrumentation must branch out to ~zero
  cost when disabled — especially on-page code. Default everything diagnostic to off.
- **No unload serialization cliff.** Don't make `pagehide`/`visibilitychange`→hidden do heavy packing,
  interning, or compression. The `SliceBuilder` fold is incremental for exactly this reason; the
  per-section encode seam exists for a future incremental driver. Record truncation/loss when budgets
  are hit.
- **Stream large data; avoid O(n²).** Captures can be large. Prefer Web Streams over buffering; index
  large collections by `Map`; detect the format/version by magic bytes, not file extension.
- **WASM-ready.** Keep the heavy codec paths structured so a WASM implementation could slot in behind
  the same API (the structural encode is synchronous and per-section).

## Code quality

- **Lint is a gate, not advice.** Warnings are errors. All first-party code stays under lint coverage —
  when you add a file or directory, make sure it's matched. **Fix the underlying issue; don't silence the
  rule** — scoped, commented disables only when a rule is genuinely inapplicable. Prefix
  intentionally-unused identifiers with `_`.
- **Tests round-trip and degrade.** Every change keeps the golden corpus passing, including the
  partial/degraded captures (Safari-subset, no-profiler, buffer-overflowed) and the metadata +
  custom-events fixture. Validate `pack → unpack` deep-equality; the corpus is deterministic, so no
  scrubbing is needed for the same-object round-trip.
- **CI gates merges** on lint + build + tests once it exists (none is configured yet — run the gates
  locally before concluding).
- **Comment the *why*, not the *what*.** Dense binary/codec/clock/encoding logic must carry
  train-of-thought comments explaining why an order or bound matters; bundlers strip them, so there is no
  shipping cost. Don't narrate what readable code already shows.

## Dependencies & security

- Keep the (deliberately few, dev-only) dependencies current; run `npm audit` on maintenance passes and
  note non-trivial updates here. The library itself has **zero runtime dependencies**.
- **Accepted tooling-license exceptions (dev-only, never shipped):** `lightningcss` (MPL-2.0, via
  Vitest) and `minimatch` (BlueOak-1.0.0, via ESLint) — both build/test only, never reaching product
  code. Re-audit on dependency bumps. (`globals`, `esbuild`, `typescript`, `vitest`, `typescript-eslint`
  are permissive.)

## Reference & viewer

[waterfall-tools](https://github.com/pmeenan/waterfall-tools) (sibling repo, also Apache-2.0) is both
the **supported viewer** for `.rcap` (added there separately) and a useful **implementation reference**
for Perfetto embedding (postMessage to `ui.perfetto.dev`) and protobuf wire handling. `rumcap` does not
import or depend on it.
