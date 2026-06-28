# rum-profiler — Plan

> Project-wide, phased build plan. Component-level detail lives in each `components/<name>/`. Architecture context: [Architecture.md](Architecture.md).

## Phasing overview

| Phase | Theme | Components | Outcome |
|---|---|---|---|
| **0** | Foundations | format, capture (MVP) | A packed capture exists and round-trips |
| **1** | Local loop (v0) | extension, transcode, viewer, analysis, symbolication | Capture any site → save → view in Perfetto, with derived metrics |
| **2** | Field collection | transport, server, (dynamic config) | Beacon real captures to a reference server with dynamic capture config |
| **3** | Aggregate | aggregate | Live dashboards over collected data |

The **Phase 1 milestone is the first shippable product**: a Chrome extension that captures deep performance data on any production page, saves it, and opens it in Perfetto — with no backend.

---

## Phase 0 — Foundations

**Goal:** lock the data model and prove it round-trips.

- `format`: define the stream schemas, the manifest (present/absent + reason, loss, provenance), versioning rules, and the binary codec (pack/unpack). Optimize for size (interning, delta encoding) and keep the pack path compatible with incremental/off-main-thread serialization so unload is not where heavy work happens.
- `format`: define the **capture-config** schema (also the future dynamic-config schema).
- `format`: build a **golden corpus**, including deliberately *partial* captures (Safari-subset, no-profiler, no-resource-timing, buffer-overflowed) so degradation is tested, not hoped for.
- `capture` (MVP): place the cheap, widely-available raw streams (navigation/resource/paint, LCP/CLS/Event Timing entries with live attribution, long tasks/LoAF) on one clock and emit the in-memory model the format packs. Derived CWV metrics live in `analysis`. Include a tiny app-signal API for explicit SPA/router boundary marks rather than depending solely on experimental soft-navigation heuristics.

**Progress (2026-06-28):** npm + TypeScript workspace scaffolded (vitest, ESLint flat config, `tsc -b` project refs). `format` in-memory model, manifest, and capture-config drafted and grounded in a real Chrome-149 capture corpus ([`components/format/samples`](../components/format/samples)); lint/build/tests green. **Next:** binary codec + golden-corpus round-trip, then `capture` MVP.

**Exit criteria:** capture → pack → unpack → equality on the golden corpus, including partial captures; format spec drafted and versioned.

## Phase 1 — Local loop (v0)

**Goal:** the server-less product loop.

- `extension`: act as a harness: inject the capture library and the Document Policy needed for JS self-profiling into live pages; collect the page-produced capture on lifecycle; save `.rumcap` files. Set the `Document-Policy: js-profiling` response header the API requires, and confirm current (Chromium-only) browser support before relying on it. Do not use extension-only APIs such as `webRequest` as measurement sources. Surface a default capture-config.
- `capture`: add the expensive/conditional streams — JS self-profiling — under the overhead budget and config gating.
- `transcode`: `.rumcap` → Perfetto protobuf. Start with slices/tracks (timeline), then add **sampled callstacks** (flamegraph) and **counter tracks**. This is the main net-new engineering — includes a varint encoder + TracePacket builder, validated by loading/parsing generated protobuf traces with Perfetto tooling.
- `viewer`: embed `ui.perfetto.dev`; load a `.rumcap`, transcode in-browser, hand the buffer to Perfetto. Local-only.
- `analysis`: derive CWV + attribution + emergent metrics (idle/schedulable windows) from the timeline; expose as queries.
- `symbolication`: resolve profiler frames through source maps; prettify minified code.

**Exit criteria:** install extension → visit any site → save a capture → open it in the viewer and see the correlated timeline + flamegraph + derived metrics.

## Phase 2 — Field collection

**Goal:** collect at scale, reliably, with server-driven targeting.

- `transport`: reliable beaconing (sendBeacon / fetch keepalive), page-lifecycle integration, batching, retry, compression. Design around browser keepalive/sendBeacon queued-body limits (64 KiB in current specs/docs) with incremental delivery and size-gated degradation instead of waiting until unload with an oversized payload.
- `server`: reference ingest endpoint; decode/validate; store; basic processing. Server-side symbolication pipeline.
- Dynamic capture-config: the server delivers a capture-config (Phase 0 schema) to target "interesting" sessions/events; a thin config-client in `capture` consumes it.

**Exit criteria:** a deployed reference server receiving, validating, and storing real captures driven by remote config.

## Phase 3 — Aggregate

**Goal:** make the collected corpus answerable in aggregate.

- `aggregate`: live dashboards and aggregate queries over many captures, preserving the "unknown vs. zero" and provenance semantics so cross-browser coverage differences don't distort stats.

**Exit criteria:** aggregate views (distributions, attribution rollups) over a real dataset.

---

## Cross-cutting tracks (every phase)

- **Privacy:** redaction policies, consent gating, cross-origin symbol limits.
- **Overhead:** capture CPU/byte budget + self-measurement, validated continuously.
- **Browser support matrix:** kept current; drives degradation and provenance.
- **Docs:** keep `docs/` and each component's docs in step with the code (see [AGENTS.md](../AGENTS.md)).

## Open decisions

- **Monorepo tooling:** ✅ Resolved — **npm workspaces** (TypeScript, ESLint flat config, vitest; `tsc -b` project refs). A `package.json` is added per component as it gains code.
- **Language:** ✅ Resolved — **TypeScript** (strict, NodeNext, `verbatimModuleSyntax`) across the shared schema.
- **Layout:** ✅ Resolved — `components/<name>/` grouping (current).
- **Test runner:** ✅ Resolved — **vitest** (matches the sibling project).
- **Canonical file extension / magic bytes** for the packed format.
- **License nuance:** ✅ Resolved — policy is **product vs. tooling** (see [AGENTS.md](../AGENTS.md)): product code is permissive-only (allowed as a category, not a fixed list); non-shipping dev/build tooling may use weak/file-level copyleft that can't leak (e.g. MPL-2.0 `lightningcss` via Vite/Vitest). Strong copyleft (GPL/AGPL/LGPL) remains a human call.
- **Soft navigations:** how aggressively to support the (still-experimental) SPA boundary signal in v0.
- **JS self-profiling overhead tuning:** the enabling header is fixed (`Document-Policy: js-profiling`); the open question is the overhead budget — `sampleInterval` / `maxBufferSize` and when to enable profiling (always-sampled vs. triggered) — tuned against measured cost and current (Chromium-only) support.
- **Multi-context capture:** whether/when to capture same-origin iframes, dedicated workers, shared workers, or service workers. If included, define explicit clock-alignment handshakes and degradation rules before adding those streams.
