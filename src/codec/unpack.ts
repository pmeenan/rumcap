/**
 * The decode entry point: `unpack(bytes) -> Capture`. The mirror of `pack.ts`. This is the decode
 * HALF — it (and everything it imports: the decode walker, `FieldDecoder`, `DecompressionStream`) runs
 * in tooling only and must never reach a user's page. `rumcap/decode` is its public entry.
 */

import type { Capture } from '../capture.js';
import type { OverheadReport } from '../capture.js';
import type { Manifest } from '../manifest.js';
import type { Streams } from '../streams/index.js';
import type { JsonValue } from '../json.js';
import { STREAM_IDS, type StreamId } from '../registry.js';
import { STREAM_SCHEMA_VERSIONS } from '../version.js';
import { Reader, FieldDecoder, decodeStringTable, decodeJson } from './field-decoder.js';
import { decodeManifest, decodeOverhead, decodeStream } from './decode-walker.js';
import {
  MAGIC,
  CODEC_VERSION,
  SECTION_STRING_TABLE,
  SECTION_MANIFEST,
  SECTION_STREAM,
  SECTION_OVERHEAD,
  SECTION_METADATA,
} from './constants.js';

/**
 * Decode one STREAM section into `streams`, applying the cross-version tolerance rules
 * (FileFormat.md "Reading across versions"):
 *   - an index this build doesn't know → skip (the section is length-bounded, so skipping is safe);
 *   - a stream written with a NEWER per-stream schema than this build reads → skip the payload; the
 *     manifest record (status + schemaVersion) survives and tells the consumer why the data is absent;
 *   - a duplicate section for the same stream → corruption, fail loudly (never silently last-wins).
 */
function decodeStreamInto(d: FieldDecoder, streams: Streams, manifest: Manifest): void {
  const idx = d.u8();
  const id = STREAM_IDS[idx];
  if (id === undefined) return;
  if (manifest.streams[id].schemaVersion > STREAM_SCHEMA_VERSIONS[id]) return;
  if (streams[id] !== undefined) throw new Error(`corrupt .rcap: duplicate section for stream "${id}"`);
  (streams as Record<StreamId, unknown>)[id] = decodeStream(d, id);
}

// ── gunzip wrapper ─────────────────────────────────────────────────────────────────────────────────

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
 * Run `input` through a decompression transform. (Duplicated from `pack.ts` on purpose — sharing it
 * would pull `CompressionStream` into the decode bundle and, worse, `DecompressionStream` into the
 * encode one.) On a decode error (invalid gzip) both sides reject; `Promise.all` attaches a handler to
 * each, so neither is left as an unhandled rejection Node would surface after the caller has handled it.
 */
async function pump(
  input: Uint8Array,
  ts: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  const readPromise = collect(ts.readable);
  const writePromise = (async () => {
    await writer.write(input as unknown as BufferSource);
    await writer.close();
  })();
  const [, out] = await Promise.all([writePromise, readPromise]);
  return out;
}

const gunzip = (bytes: Uint8Array): Promise<Uint8Array> => pump(bytes, new DecompressionStream('gzip'));

// ── Public API ─────────────────────────────────────────────────────────────────────────────────────

/** Unpack a `.rcap` byte stream back into the in-memory capture model. */
export async function unpack(input: Uint8Array | ArrayBuffer): Promise<Capture> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head = new Reader(bytes);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head.u8() !== MAGIC[i]) throw new Error('not a .rcap capture (bad magic bytes)');
  }
  // The codec version is the hard gate: it versions the framing rules themselves, so an unknown value
  // means we cannot even walk the sections. The FORMAT version deliberately does NOT gate: the framing
  // is designed so a reader pulls what it knows from a newer file (unknown sections/streams/manifest
  // records are skipped by length; newer-schema stream payloads are skipped via the manifest) — see
  // FileFormat.md "Reading across versions".
  const codecVersion = head.varuint();
  if (codecVersion !== CODEC_VERSION) {
    throw new Error(`unsupported .rcap codec version ${codecVersion} (this build reads ${CODEC_VERSION})`);
  }
  const formatVersion = head.varuint();

  const payload = await gunzip(bytes.subarray(head.pos));
  const r = new Reader(payload);

  let strings: readonly string[] | undefined;
  let manifest: Manifest | undefined;
  let overhead: OverheadReport | undefined;
  let metadata: Record<string, JsonValue> | undefined;
  const streams: Streams = {};

  while (!r.atEnd) {
    const tag = r.u8();
    const len = r.varuint();
    const sectionBytes = r.bytes(len);
    // Duplicate known sections are corruption, not tolerance: a second string table would silently
    // re-key every string id after it, and a last-wins manifest/overhead/metadata would mis-decode
    // quietly — the format's rule is "corruption fails loudly; only UNKNOWN tags are skipped".
    if (tag === SECTION_STRING_TABLE) {
      if (strings !== undefined) throw new Error('corrupt .rcap: duplicate string-table section');
      strings = decodeStringTable(new Reader(sectionBytes));
      continue;
    }
    if (strings === undefined) {
      throw new Error('corrupt .rcap: string table must precede other sections');
    }
    const d = new FieldDecoder(new Reader(sectionBytes), strings);
    switch (tag) {
      case SECTION_MANIFEST:
        if (manifest !== undefined) throw new Error('corrupt .rcap: duplicate manifest section');
        manifest = decodeManifest(d, formatVersion);
        break;
      case SECTION_STREAM:
        // The writer emits the manifest before any stream section; the per-stream tolerance rules
        // (skip newer-schema payloads) need it, so enforce that ordering on read too.
        if (manifest === undefined) throw new Error('corrupt .rcap: stream section precedes the manifest');
        decodeStreamInto(d, streams, manifest);
        break;
      case SECTION_OVERHEAD:
        if (overhead !== undefined) throw new Error('corrupt .rcap: duplicate overhead section');
        overhead = decodeOverhead(d);
        break;
      case SECTION_METADATA:
        // The metadata section is a single JsonValue object (a `Record<string, JsonValue>`).
        if (metadata !== undefined) throw new Error('corrupt .rcap: duplicate metadata section');
        metadata = decodeJson(d) as Record<string, JsonValue>;
        break;
      default:
        break; // unknown section already consumed via its length prefix (forward-compat)
    }
  }

  if (manifest === undefined) throw new Error('corrupt .rcap: missing manifest section');
  const capture: Capture = { formatVersion, manifest, streams };
  if (overhead !== undefined) capture.overhead = overhead;
  if (metadata !== undefined) capture.metadata = metadata;
  return capture;
}
