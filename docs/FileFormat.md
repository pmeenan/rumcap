# The `.rcap` file format

The authoritative wire specification for a packed capture. The schema is the TypeScript contract in
[`src/`](../src); this document describes how that model is laid out on the wire. When they disagree,
the code wins and this doc is the bug — a stale contract must be fixed (see [AGENTS.md](../AGENTS.md)).

- **Magic:** `F5 52 55 4D` (`\xF5RUM`). `0xF5` is an always-invalid UTF-8 lead byte, so a capture is
  unmistakably binary and sniffable by these four bytes alone.
- **Canonical extension:** `.rcap`. (The npm package is `rumcap`; the format keeps the shorter `rcap`
  identity and the `RUM` heritage in the magic.)
- **Two version numbers:** `CODEC_VERSION` (the wire encoding) is independent of `FORMAT_VERSION` (the
  schema/model). A wire-layout change bumps the codec version; a schema change bumps the format version.

## Overall layout

```
[ magic: F5 52 55 4D ]          cleartext, 4 bytes — identify + sniff without decompressing
[ codecVersion: varuint ]       currently 2   (v2: self-describing manifest stream records)
[ formatVersion: varuint ]      currently 2   (Capture.formatVersion)
[ gzip( body ) ]                everything below is gzipped as one stream
```

The magic and both versions live **outside** the gzip, so a reader can identify a file and version-check
it before spending anything on decompression. The **codec version is the hard gate** (it versions the
framing rules themselves — an unknown value means the sections can't even be walked); the **format
version does not gate reads** — see [Reading across versions](#reading-across-versions). `body` is a
sequence of length-prefixed, tagged sections:

```
body = section*
section = [ tag: u8 ][ byteLength: varuint ][ payload ]
```

| tag | section | notes |
|----|----------|-------|
| 1 | `STRING_TABLE` | interned strings — emitted **first** so ids resolve before any section that uses them |
| 2 | `MANIFEST` | clock + the TOTAL per-stream status records + the embedded capture-config; precedes all `STREAM` sections |
| 3 | `STREAM` | `[ streamIndex: u8 ][ stream payload ]` — one section per **present** stream |
| 4 | `OVERHEAD` | the capture's self-measured cost (optional) |
| 5 | `METADATA` | capture-level arbitrary JSON (optional; added in `FORMAT_VERSION` 2) |

Every section is length-bounded, so an **unknown** tag or a newer stream index is skipped, never fatal.
Malformed structure stays loud: a **duplicate** known section (a second string table, manifest, overhead,
or metadata, or a repeated stream index), a stream section before the manifest, or a section that
misparses is corruption and is rejected — tolerance is only ever for *unknown*, well-framed content.
Absent optional sections (overhead, metadata) and absent streams cost zero bytes.

## Primitive encodings

- **`varuint`** — unsigned LEB128. Used for counts, sizes, ids, indices, string refs. Computed with
  `%`/`Math.floor` (not 32-bit shifts) so values past 2³² survive.
- **`zigzag` varint** — signed LEB128 via zigzag. Used for the fixed-point µs timeline ticks.
- **`f64`** — 8-byte IEEE-754 double, little-endian. Used for wall-clock `EpochMs` and true floats
  (rects, ratios, CLS value) that can be fractional or negative and aren't on the µs grid.
- **string** — a `varuint` id into the string table (interning; see below).
- **bool** — one byte, `0`/`1`.
- **presence bitmap** — for a struct's optional fields, one bit each (LSB-first, byte-packed), written
  before the present optionals. An absent optional costs one bit and stays distinct from zero/empty/null.
- **`JsonValue`** — a 1-byte tag (`null`/`false`/`true`/`number`/`string`/`array`/`object`) then the
  shape; keys/strings interned; numbers as `f64`. `null` stays distinct from an absent field. Used for
  User Timing `detail`, custom-event `details`, and capture `metadata`. Input is normalized with
  **`JSON.stringify` semantics** (so encoding is total — no page value can crash `pack`): `toJSON()` is
  honored (a `Date` becomes its ISO string), `undefined`/function/symbol object properties are dropped,
  those values become `null` in array slots, non-finite numbers become `null`, and — the one deviation
  from `JSON.stringify`, which throws — `bigint` becomes `null`. Values already in the JSON model
  round-trip exactly. On decode, object keys are rebuilt as **own properties** (exactly like
  `JSON.parse`), so a `"__proto__"` key round-trips as data and can never swap a decoded object's
  prototype.

### Timestamp precision (fixed-point microseconds)

Timeline values (`RelMs` / `DurationMs`) are stored as **integer-microsecond zigzag varints**, not
`f64`. Browsers coarsen `DOMHighResTimeStamp` to 100µs by default and 5µs at best (cross-origin
isolated), so 1µs captures all real precision; the extra `f64` digits are float noise. This is ~2–4
bytes vs 8, makes delta encoding trivial, and `round(ms·1000)/1000` recovers the canonical double
exactly for any ≤1µs value (re-packing is idempotent). Wall-clock `EpochMs` and true floats stay `f64`.

**The one exception:** inferred **profile-slice durations** are stored on a **1ms** grid, because a
sampling profiler can only place a duration to ±1 sample interval (~10ms) — microseconds there would be
false precision. Measured durations elsewhere (resources, LoAF, **custom events**) keep full µs.

## String table

URLs, resource names, selectors, custom-event names/namespaces, and the format's many small enum
literals repeat heavily. Each distinct string is stored **once** and referenced by a `varuint` id — the
single biggest size lever. Ids are assigned in first-seen order during encode, so the table can only be
finalized after every section has interned its strings; that is why it is serialized last but placed
**first** in the body. The empty string is a normal, distinct value; "absent" is carried by presence
bits, never by the table.

```
STRING_TABLE = [ count: varuint ] ( [ byteLength: varuint ][ utf8 bytes ] )*
```

Strings are stored as **well-formed UTF-8**: a lone surrogate in a source string (legal in DOMStrings —
e.g. a mark name truncated mid-emoji) is replaced with U+FFFD, the same USVString normalization the
platform applies to URLs and `fetch`. This is the one way a decoded string may differ from its input;
`.rcap` string bytes are therefore always valid UTF-8 for any downstream tool.

## Manifest

The heart of "robust to missing data." It is written before any stream payload:

- **clock** — `timeOrigin` (`EpochMs`, correlation metadata only), `captureStart`/`captureEnd` (`RelMs`
  offsets), `unit` (`'ms'`), `base` (`'timeOrigin'`), optional `precision` (reported coarsening), and
  optional per-context clock mappings (iframe/worker) with their own `timeOrigin` + offset-to-page.
- **per-stream status** — the record list is **TOTAL** for the writer: exactly one record per stream id
  the writer knows, so a reader can always tell *not collected* from *collected, found nothing*. Each
  record is a **self-describing frame** behind a leading count:

  ```
  records = [ count: varuint ] record*
  record  = [ streamIndex: u8 ][ status: string ][ schemaVersion: varuint ][ tailLen: varuint ][ tail ]
  tail    = the record detail struct: optional `loss` notes + optional `provenance`
  ```

  The frame fields (`streamIndex`, `status` — `present | unsupported | not-requested | dropped |
  policy-blocked` — and `schemaVersion`) use frozen primitive encodings, so **any** reader, older or
  newer, always recovers which streams a writer knew, their status, and their schema version; the
  length-prefixed tail is skippable when a reader doesn't understand its layout. This framing is what
  makes cross-version reading sound (below).
- **capture-config** — the declarative config that *should* have been attempted (also the shape a future
  dynamic-config delivery would use).

## Stream payloads

Each present stream is one `STREAM` section, `[ streamIndex ][ payload ]`, where `streamIndex` is the
stream's position in the registry (`src/registry.ts`). Payloads are **descriptor-driven**: each struct
is a compact table of `[requiredCount, key, type, …]` and one generic walker encodes/decodes by
interpreting it (`src/codec/descriptors.ts` + the two walkers). Required fields are written
unconditionally; optionals ride a presence bitmap.

A few shapes a flat table can't express use small special-handler tags in the descriptor table (so the
stream table stays total — every stream id has a descriptor):

- **`navigation`** — a resource block followed by a navigation-extras block, one object (it
  specializes `resource`); `notRestoredReasons` within it is a recursive, null-discriminated tree.
- **config `streams` / overhead `byStream`** — sparse `Record<streamIndex, value>` maps.
- **`profile` slices** — columnar (below).

### `profile` — columnar slices

The profiler is the hot, high-volume stream, but the wire stores the derived nested **call-tree**
(`{ frameId, depth, start, duration }`), not raw samples — the on-page `SliceBuilder` folds
`Profiler.stop()` chunks into slices incrementally. The slices are stored as four contiguous columns so
gzip models each separately:

1. **frameId** — index into the interned `frames` table (raw varint).
2. **depth** — zigzag delta from the previous slice (pre-order depths move ±1, so deltas are tiny).
3. **start** — first absolute µs tick, then non-negative µs deltas (pre-order ⇒ non-decreasing).
4. **duration** — **1ms units** (durations are sample-inferred; see the precision note above).

Nesting is implicit from depth + pre-order, so no parent id is stored and the per-sample form's interned
`stacks` table is gone entirely. An aggregate `droppedSamples` count records sub-interval runs the fold
pruned (single samples, duplicate-timestamp clusters, microsecond recursion bursts) — never silently
lost. Frames are left **unsymbolicated** on the wire.

### `customEvents` — namespaced measured spans (FORMAT_VERSION 2)

App/library-instrumented events: named, timed, detail-carrying spans grouped into user-named
**namespaces** (timelines). Because namespaces are open-ended, they are DATA inside one fixed stream —
not stream ids. The stream is `tracks: { namespace, events: { name, start, duration, depth?, details? } }[]`,
encoded through the generic walker (no special handler): `namespace`/`name` interned; `start`/`duration`
as µs `RelMs`/`DurationMs` — **full µs precision, because these durations are measured** (do not confuse
with inferred profile-slice durations); `depth` (optional varuint, 0/absent = top-level) expresses
nesting explicitly; `details` is a `JsonValue`.

## Versioning & compatibility

- **`CODEC_VERSION`** (wire framing) and **`FORMAT_VERSION`** (schema/model) are independent; per-stream
  `schemaVersion` lives in each manifest record's frame. Pre-1.0 the format is a **draft**: it may
  change without migration shims while the schema is validated against real captures.
- **codec v2 (current)** made the manifest stream records self-describing (count + per-record frame +
  length-prefixed tail) so cross-version reading is sound. **format v2 (current)** added the `METADATA`
  section and the `customEvents` stream.

### Reading across versions

A reader **rejects** a file whose `codecVersion` it doesn't know (the framing itself would be
unparseable) and otherwise reads **any** `formatVersion`, pulling what it knows:

- an unknown **section tag** is skipped by its length prefix;
- an unknown **stream index** — a stream section or manifest record for a stream this reader predates —
  is skipped whole (the manifest record's frame is still parseable, but the reader's model has no id to
  hang it on);
- a known stream whose manifest `schemaVersion` is **newer** than the reader's
  (`STREAM_SCHEMA_VERSIONS`) has its payload skipped; the manifest record survives, so the consumer can
  see the stream was present and why its data is absent (`checkConsistency` reports exactly this);
- a manifest record's **tail** from a newer format is decoded best-effort: it counts only if the
  reader's layout consumes it exactly, otherwise the frame fields stand alone. For same-or-older files
  the tail must parse exactly — anything else is corruption;
- a known stream the (older) writer had **no record for** is filled as `unsupported`/`schemaVersion 0`
  on decode: that writer could not have captured it, and the in-memory manifest stays total;
- a `status` string this reader doesn't know decodes as-is (strings are self-describing);
  `checkConsistency` flags it rather than guessing.

The contract this buys: **adding a stream, a status, a section, or a manifest-record tail field never
breaks an existing reader** — older readers keep reading newer files, minus only the parts they
predate. Changing an existing stream's *payload layout* bumps that stream's `schemaVersion` (older
readers skip that stream); changing the framing itself bumps `CODEC_VERSION` (older readers reject with
a clear error).

The first frozen version will document migrations here. See also [Architecture.md](Architecture.md) and
the codec source under [`src/codec/`](../src/codec).
