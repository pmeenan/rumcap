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
 *       body = a sequence of length-prefixed, tagged sections:
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
import { FieldEncoder, Writer, StringTable, encodeJson } from './field-encoder.js';
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

interface Section {
  tag: number;
  bytes: Uint8Array;
}

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
function encodeStreamSections(strings: StringTable, s: Streams, out: Section[]): void {
  for (const id of STREAM_IDS) {
    const data = s[id];
    if (data === undefined) continue;
    const e = new FieldEncoder(strings);
    e.u8(STREAM_INDEX[id]);
    encodeStream(e, id, data);
    out.push({ tag: SECTION_STREAM, bytes: e.w.finish() });
  }
}

// ── gzip wrapper (CompressionStream is a Web API present in browsers and Node 18+) ─────────────────

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Run `input` through a compression transform. We drain the readable concurrently with writing so the
 * transform never stalls on backpressure, then close the writer to flush. (The writer/reader form
 * avoids `pipeThrough`'s strict chunk-type inference, which rejects `WritableStream<BufferSource>`.)
 * This helper is deliberately duplicated in `unpack.ts` rather than shared, so the encode bundle never
 * imports `DecompressionStream`.
 */
async function pump(
  input: Uint8Array,
  ts: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  const readPromise = collect(ts.readable);
  const writePromise = (async () => {
    // Our buffers are always ArrayBuffer-backed (we never allocate SharedArrayBuffer); the generic
    // `Uint8Array<ArrayBufferLike>` default can't prove that to the BufferSource bound, so assert it.
    await writer.write(input as unknown as BufferSource);
    await writer.close();
  })();
  const [, out] = await Promise.all([writePromise, readPromise]);
  return out;
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
  const strings = new StringTable();
  const sections: Section[] = [];

  const manifestEnc = new FieldEncoder(strings);
  encodeManifest(manifestEnc, capture.manifest);
  sections.push({ tag: SECTION_MANIFEST, bytes: manifestEnc.w.finish() });

  encodeStreamSections(strings, capture.streams, sections);

  if (capture.overhead !== undefined) {
    const overheadEnc = new FieldEncoder(strings);
    encodeOverhead(overheadEnc, capture.overhead);
    sections.push({ tag: SECTION_OVERHEAD, bytes: overheadEnc.w.finish() });
  }

  if (capture.metadata !== undefined) {
    // Capture-level metadata: a `Record<string, JsonValue>`, which IS a JsonValue object on the wire —
    // encode it with the same JsonValue codec as User Timing `detail`. A skippable section (tag 5), so
    // absent metadata costs nothing and an older reader skips it by its length prefix.
    const metaEnc = new FieldEncoder(strings);
    encodeJson(metaEnc, capture.metadata);
    sections.push({ tag: SECTION_METADATA, bytes: metaEnc.w.finish() });
  }

  // The table is complete only now that every section has interned its strings; serialize it and place
  // it first so the reader resolves ids before any section that references them.
  const tableW = new Writer();
  strings.encode(tableW);

  const body = new Writer();
  writeSection(body, SECTION_STRING_TABLE, tableW.finish());
  for (const s of sections) writeSection(body, s.tag, s.bytes);

  const compressed = await gzip(body.finish());

  const out = new Writer();
  out.bytes(MAGIC as Uint8Array);
  out.varuint(CODEC_VERSION);
  out.varuint(capture.formatVersion);
  out.bytes(compressed);
  return out.finish();
}
