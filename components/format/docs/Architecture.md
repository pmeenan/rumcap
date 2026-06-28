# format — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## File shape (draft)

```
[ magic + version ]
[ manifest        ]   clock metadata, streams present/absent (+ reason), versions, loss,
                      provenance, capture-config used
[ string table    ]   interned URLs, names, frame strings (privacy-redacted at pack time)
[ stream blocks   ]   one block per present stream, each independently decodable
[ overhead block  ]   capture's self-measured cost
```

Each stream block is length-prefixed and independently skippable, so an unknown or newer stream never breaks an older reader.

## Manifest

The manifest is the heart of "robust to missing data." It records the capture clock before any stream data:

- `timeOrigin`: the page's `performance.timeOrigin`
- `captureStart` / `captureEnd`: monotonic offsets from `timeOrigin`
- `timestampUnit`: the unit used on the wire (e.g. microseconds)
- `timestampBase`: the base for each encoded timestamp (`timeOrigin` unless a stream explicitly says otherwise)
- `precision` / `provenance`: enough detail to know how the browser produced the timestamps
- `contexts`: optional per-frame/worker clock mappings if a capture spans multiple execution contexts
- `epochOffset`: optional metadata for correlating with external systems; never used for event ordering because system clock adjustments can move `Date.now()`

For every stream the project defines, the manifest records:

- `status`: `present | unsupported | not-requested | dropped | policy-blocked`
- `schemaVersion`
- `loss`: optional note (e.g. resource buffer overflow at T, N dropped; profiler sample budget hit; size budget forced truncation)
- `provenance`: producing API/browser, for cross-source reconciliation

It also embeds the **capture-config** that produced the sample, so a reader knows what *should* have been attempted.

## Compactness

- **String interning** via a shared table — URLs, resource names, and (post-symbolication) frame names repeat heavily.
- **Delta-encoded timestamps** against the timeline origin and within streams.
- **Optional fields** truly optional on the wire — absence costs ~nothing and stays distinguishable from zero.
- An outer compression pass (algorithm TBD) over the interned payload.

## Codec

Pack/unpack must round-trip the in-memory model exactly (validated against the golden corpus). The codec substrate is an open decision: a small hand-rolled varint writer (cf. waterfall-tools' hand-rolled reader, used as *reference only*) vs. a permissively-licensed library. Whatever we pick must satisfy the project's Apache-2-or-looser rule.

The API should allow incremental construction and off-main-thread use. Capture/transport paths must not rely on a large synchronous pack/compress step during `pagehide` or `visibilitychange`.

**Status (2026-06-28):** the in-memory model, manifest, and capture-config are implemented and type-checked in [`../src`](../src) (`@rum-profiler/format`), grounded against the real captures in [`../samples`](../samples). Pack/unpack is **not yet built** — it is the next Phase 0 step, where the codec substrate, magic bytes, interning, delta-encoding, and compression get decided against this concrete model.

## Versioning

Top-level format version plus per-stream `schemaVersion`. Readers skip unknown streams/fields; migrations are documented here. Adding a browser signal = adding a stream schema, not breaking the file.

## Golden corpus

`format` owns a corpus of captures used by every downstream component's tests — crucially including **partial** captures (Safari-subset, no-profiler, no-resource-timing, buffer-overflowed) so degradation paths are exercised everywhere.

## Open questions

- Codec substrate + license check.
- Magic bytes / extension.
- Compression choice and ordering vs. interning.
- How redaction policy is expressed (per-field rules at pack time).
- Streaming pack/unpack API shape and worker handoff model.
