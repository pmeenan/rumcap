/**
 * The encode entry point: `pack(Capture) -> bytes`, plus the file's cleartext header, the body
 * section framing, and the gzip wrapper. This is the encode HALF — it imports nothing decode-only
 * (no `DecompressionStream`, no `unpack`), which is what lets `rumcap/encode` tree-shake to an
 * encode-only bundle even without a bundler. `unpack` is the mirror in `unpack.ts`.
 *
 * Wire layout:
 *   [ magic: F5 52 55 4D ]            cleartext — \xF5 is never a valid UTF-8 lead byte, so the file
 *   [ codecVersion: varuint ]         is unambiguously binary and sniffable by these bytes alone
 *   [ formatVersion: varuint ]        (the schema/model version carried by Capture.formatVersion)
 *   [ gzip( body ) ]                  everything below is gzipped as one stream
 *       body = [ tickScale: varuint ]  the capture-wide µs-tick divisor (see probeScale), then
 *              a sequence of length-prefixed, tagged sections:
 *         [ tag: u8 ][ byteLength: varuint ][ payload ]
 *
 * `pack` is async only because gzip (`CompressionStream`) is; the structural encode itself is
 * synchronous and per-section — the seam a future on-page driver uses to prepare stream bytes
 * incrementally and flush only the (cheap) string table at pagehide, and the boundary a WASM codec
 * would slot into. Redaction is NOT applied here; it is a separate pre-pack pass over the Capture.
 */

import type { Capture } from '../capture.js';
import type { Streams } from '../streams/index.js';
import { STREAM_IDS } from '../registry.js';
import { FieldEncoder, GcdProbe, Writer, StringTable, encodeJson } from './field-encoder.js';
import { STREAM_INDEX } from './descriptors.js';
import { encodeManifest, encodeOverhead, encodeStream } from './encode-walker.js';
import {
  MAGIC,
  CODEC_VERSION,
  SECTION_STRING_TABLE,
  SECTION_MANIFEST,
  SECTION_STREAM,
  SECTION_OVERHEAD,
  SECTION_METADATA,
} from './constants.js';

/** A pending body section: [tag, payload]. */
type Section = [number, Uint8Array];

function writeSection(w: Writer, tag: number, payload: Uint8Array): void {
  w.u8(tag);
  w.varuint(payload.length);
  w.bytes(payload);
}

/**
 * Emit one STREAM section per present stream, driven by the descriptor table. Only present streams
 * produce a section — an absent stream costs nothing; its status lives in the manifest. (`Streams`
 * keys ARE the StreamIds, so iterating STREAM_IDS covers them exactly.)
 */
function encodeStreamSections(strings: StringTable, scale: number, s: Streams, out: Section[]): void {
  for (const id of STREAM_IDS) {
    const data = s[id];
    if (data === undefined) continue;
    const e = new FieldEncoder(strings);
    e.scale = scale;
    e.u8(STREAM_INDEX[id]);
    encodeStream(e, id, data);
    out.push([SECTION_STREAM, e.w.finish()]);
  }
}

/**
 * Pass 1 of the two-pass encode: run the normal walk with the byte-less `GcdProbe` to learn the
 * capture-wide tick grid (the GCD of every µs tick the real pass will write). Real Chrome captures sit
 * on 1/5/100µs grids depending on isolation state — and the grid VARIES per capture, which is why the
 * scale is measured, never assumed (AGENTS: no magic thresholds). Sharing the walker with the real
 * pass is what guarantees no tick can be missed (a missed one would break the exact-division rule).
 */
function probeScale(capture: Capture): number {
  const probe = new GcdProbe(new StringTable());
  encodeManifest(probe, capture.manifest);
  for (const id of STREAM_IDS) {
    const data = capture.streams[id];
    if (data !== undefined) encodeStream(probe, id, data);
  }
  if (capture.overhead !== undefined) encodeOverhead(probe, capture.overhead);
  if (capture.metadata !== undefined) encodeJson(probe, capture.metadata);
  return Math.max(1, probe.gcd); // all-zero ticks (or none) → no scaling
}

// ── gzip wrapper (CompressionStream is a Web API present in browsers and Node 18+) ─────────────────

/**
 * Run `input` through a compression transform. `Response` drains the readable (it's the platform's
 * own collect-a-stream primitive — present wherever CompressionStream is, and cheaper in bundle bytes
 * than a hand-rolled reader loop); the write side runs concurrently so the transform never stalls on
 * backpressure. `Promise.all` attaches a handler to both sides, so a failure on either rejects `pump`
 * without leaving an unhandled rejection. This helper is deliberately duplicated in `unpack.ts` rather
 * than shared, so the encode bundle never imports `DecompressionStream`.
 */
async function pump(
  input: Uint8Array,
  ts: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  // Our buffers are always ArrayBuffer-backed (we never allocate SharedArrayBuffer); the generic
  // `Uint8Array<ArrayBufferLike>` default can't prove that to the BufferSource bound, so assert it.
  const writePromise = writer.write(input as unknown as BufferSource).then(() => writer.close());
  const [buf] = await Promise.all([new Response(ts.readable).arrayBuffer(), writePromise]);
  return new Uint8Array(buf);
}

const gzip = (bytes: Uint8Array): Promise<Uint8Array> => pump(bytes, new CompressionStream('gzip'));

// ── Public API ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Pack a capture into the compact, gzipped `.rcap` byte stream. Lossless to 1µs on timeline values
 * (`RelMs`/`DurationMs` are quantized to the microsecond grid — below the browser's ≤5µs real
 * resolution) and exact on every other field, with two documented normalizations (see FileFormat.md):
 *   - strings are stored as well-formed UTF-8, so a lone surrogate becomes U+FFFD (`StringTable`);
 *   - JsonValue payloads (detail/details/metadata) are normalized with JSON.stringify semantics
 *     (`encodeJson`) — toJSON honored, undefined/function/symbol properties dropped, non-finite
 *     numbers → null.
 * `unpack(pack(c))` deep-equals `c` for any capture whose timestamps are already at ≤1µs resolution
 * and whose strings/JSON are already in that normal form (everything a browser produces).
 */
export async function pack(capture: Capture): Promise<Uint8Array> {
  const scale = probeScale(capture);
  const strings = new StringTable();
  const sections: Section[] = [];

  const manifestEnc = new FieldEncoder(strings);
  manifestEnc.scale = scale;
  encodeManifest(manifestEnc, capture.manifest);
  sections.push([SECTION_MANIFEST, manifestEnc.w.finish()]);

  encodeStreamSections(strings, scale, capture.streams, sections);

  if (capture.overhead !== undefined) {
    const overheadEnc = new FieldEncoder(strings);
    overheadEnc.scale = scale;
    encodeOverhead(overheadEnc, capture.overhead);
    sections.push([SECTION_OVERHEAD, overheadEnc.w.finish()]);
  }

  if (capture.metadata !== undefined) {
    // Capture-level metadata: a `Record<string, JsonValue>`, which IS a JsonValue object on the wire —
    // encode it with the same JsonValue codec as User Timing `detail`. A skippable section (tag 5), so
    // absent metadata costs nothing and an older reader skips it by its length prefix.
    const metaEnc = new FieldEncoder(strings);
    encodeJson(metaEnc, capture.metadata);
    sections.push([SECTION_METADATA, metaEnc.w.finish()]);
  }

  // The table is complete only now that every section has interned its strings; serialize it and place
  // it first so the reader resolves ids before any section that references them.
  const tableW = new Writer();
  strings.encode(tableW);

  const body = new Writer();
  body.varuint(scale); // v3 body prelude: the capture-wide µs-tick scale every R/D value was divided by
  writeSection(body, SECTION_STRING_TABLE, tableW.finish());
  for (const [tag, bytes] of sections) writeSection(body, tag, bytes);

  const compressed = await gzip(body.finish());

  const out = new Writer();
  out.bytes(MAGIC as Uint8Array);
  out.varuint(CODEC_VERSION);
  out.varuint(capture.formatVersion);
  out.bytes(compressed);
  return out.finish();
}
