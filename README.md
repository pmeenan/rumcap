# rum-profiler

Open-source tooling for measuring, profiling, and analyzing web applications from the field — real-user data that goes **deep**, not just top-line.

Most RUM libraries (boomerang, web-vitals, commercial SDKs) report metrics. `rum-profiler` couples those same metrics with a correlated, per-session **profile** — long tasks, Long Animation Frames (LoAF), JS self-profiling, navigation/resource/server timing — woven onto a single timeline so you can answer *why*, not just *what*:

- What is blocking LCP?
- What is expensive about hydration?
- Where are the windows of idle network vs. idle CPU where work could be scheduled?

Broad metric coverage and deep profiling are **co-equal goals** — each informs the other, because both are just different queries over the same correlated timeline.

## Status

Early design / greenfield. See [docs/Architecture.md](docs/Architecture.md) and [docs/Plan.md](docs/Plan.md). Nothing here is stable yet.

## The v0 loop (local-first, no server)

1. A **capture** library reads whatever browser performance APIs are available and builds a correlated timeline.
2. A **format** library packs it into a compact, self-describing binary file.
3. A **Chrome extension** injects the capture library (and the Document Policy needed for JS self-profiling) into real production pages, then saves the packed capture to disk.
4. A **transcoder** converts a packed capture into the Perfetto trace format, and a thin **viewer** opens it in an embedded Perfetto UI for inspection.

That loop is useful on any site, with no backend. Server-side ingestion, dynamic capture config, and aggregate analysis come later.

The extension is only a harness. It injects the libraries, enables required headers, saves captures, and opens the viewer; the measurement data itself comes entirely from browser APIs observed by the injected `capture` library.

## Components

Each lives in its own folder under [`components/`](components/) with its own `README.md` and `docs/`. Project-wide design and planning live in the root [`docs/`](docs/).

| Component | Folder | Phase | Milestone | Purpose |
|---|---|---|---|---|
| Capture | [`components/capture`](components/capture) | 0/1 | v0 | Read browser perf APIs → correlated in-memory timeline |
| Format | [`components/format`](components/format) | 0 | v0 | Schema + compact, self-describing binary pack/unpack |
| Transcode | [`components/transcode`](components/transcode) | 1 | v0 | Packed capture → Perfetto protobuf (timeline, samples, counters) |
| Extension | [`components/extension`](components/extension) | 1 | v0 | Inject capture + Document Policy into live pages; save captures |
| Viewer | [`components/viewer`](components/viewer) | 1 | v0 | Embed Perfetto UI; load packed captures locally |
| Analysis | [`components/analysis`](components/analysis) | 1 | v0 | Derive metrics & attribution (CWV, LCP/INP/CLS, idle windows) |
| Symbolication | [`components/symbolication`](components/symbolication) | 1 | v0 | Source-map resolution & prettifying for profiler frames |
| Transport | [`components/transport`](components/transport) | 2 | field collection | Reliable beaconing of captures to a server |
| Server | [`components/server`](components/server) | 2 | field collection | Reference ingest/processing + dynamic capture-config delivery |
| Aggregate | [`components/aggregate`](components/aggregate) | 3 | aggregate | Live aggregate dashboards over collected captures |

## Design tenets

- **Deep + broad, co-equal.** Metrics and profile are one data model, queried two ways.
- **Robust to missing data.** Every capture stream is optional and independently degradable; the format records what is present, what is absent, and *why*.
- **Local-first.** The v0 product works entirely client-side via the extension — capture, save, view.
- **Tiny on the page.** The capture library is zero-dependency, tree-shakeable, and measures its own overhead.
- **Privacy-first.** URLs and stack frames can carry PII; redaction is part of capture and format design, not an afterthought.
- **Open, versioned format.** The compact wire format is specified and versioned so it can outlive any one browser API.
- **Independent components.** Each component stands alone with clear inputs/outputs.

## Related projects

[waterfall-tools](https://github.com/pmeenan/waterfall-tools) is a sibling project (network-waterfall viewing, multi-format trace ingestion, Perfetto/DevTools embedding). We use it as an **implementation reference only** — `rum-profiler` does not depend on it; the use cases are distinct and the components stay independent.

## License

[Apache-2.0](LICENSE). The rule is **product vs. tooling**: **product code** (anything shipped into a user's page) uses only permissive dependencies, while dev/build/test **tooling** that never ships may use weak-copyleft licenses that can't leak into the product — see [AGENTS.md](AGENTS.md).
