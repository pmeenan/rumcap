// Size measurement over the real sample corpus — the source of the README's size table. For each raw
// capture under ../json it rebuilds the FULL capture the way a live consumer would (entrySink over
// every stream's entries with the live attribution grafted back, plus the raw profiler trace folded to
// slices), packs it, and compares three honest baselines:
//
//   raw.gz    the browser's own toJSON() dump, gzipped — the "what the page handed us" baseline
//             (per-sample profiler stacks included; NOT information-identical to the .rcap, which
//             deliberately folds samples → slices and strips 0/''/-1 sentinels)
//   json.gz   the SAME normalized Capture model as gzipped JSON — information-identical to the .rcap,
//             so this delta is purely the codec (interning, varints, µs fixed-point, columnar slices)
//   .rcap     pack()'s output (gzip included)
//
// Run after `npm run build` at the repo root:  node sizes.mjs
//
// The mapping logic mirrors test/browser.test.ts (`liveView`); keep the two in step.

import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Encoder, entrySink, asRelMs, asEpochMs } from '../../dist/index.js';

const jsonDir = new URL('../json/', import.meta.url);

// Reconstruct the live view of a raw entry: the parts an entry-level toJSON drops or empties (LoAF
// scripts, serverTiming, longtask attribution, notRestoredReasons, the element-timing
// intersectionRect, mark/measure detail) plus the node-valued attributions the spike pre-resolved to
// selector strings + structured attrs — graft them back before normalizing.
// This mirrors test/browser.test.ts (`liveView`); keep the two in step.
function liveView(type, entry) {
  const attr = entry.__attribution;
  if (attr === undefined) return entry;
  const out = { ...entry };
  const ref = (selector, attrs) =>
    typeof selector === 'string' || (attrs !== null && typeof attrs === 'object')
      ? { ...(typeof selector === 'string' ? { selector } : {}), ...(attrs ?? {}) }
      : undefined;
  if (type === 'largest-contentful-paint' || type === 'element') {
    const element = ref(attr.element, attr.elementAttrs);
    if (element !== undefined) out.element = element;
    if (type === 'element' && attr.intersectionRect !== undefined) out.intersectionRect = attr.intersectionRect;
  }
  if (type === 'layout-shift' && Array.isArray(attr.sources)) {
    out.sources = attr.sources.map((s) => ({ node: ref(s.node, s.attrs), previousRect: s.previousRect, currentRect: s.currentRect }));
  }
  if (type === 'event' || type === 'first-input') {
    const target = ref(attr.target, attr.targetAttrs);
    if (target !== undefined) out.target = target;
  }
  if (type === 'long-animation-frame' && Array.isArray(attr.scripts)) out.scripts = attr.scripts;
  if (type === 'longtask' && Array.isArray(attr.attribution)) out.attribution = attr.attribution;
  if ((type === 'navigation' || type === 'resource') && Array.isArray(attr.serverTiming)) out.serverTiming = attr.serverTiming;
  if (type === 'navigation' && attr.notRestoredReasons !== undefined) out.notRestoredReasons = attr.notRestoredReasons;
  if ((type === 'mark' || type === 'measure') && attr.detail !== undefined) out.detail = attr.detail;
  return out;
}

const kb = (n) => (n / 1024).toFixed(1).padStart(7) + ' KB';
const pct = (n, of) => ((100 * n) / of).toFixed(0).padStart(3) + '%';

const rows = [];
for (const file of readdirSync(jsonDir).filter((f) => f.endsWith('.json')).sort()) {
  const rawBytes = readFileSync(new URL(file, jsonDir));
  const sample = JSON.parse(rawBytes.toString('utf8'));

  const enc = new Encoder({
    timeOrigin: asEpochMs(sample.clock.timeOrigin),
    captureStart: asRelMs(0),
    now: () => asRelMs(sample.clock.now),
  });
  enc.setEnvironment(sample.environment);
  const sink = entrySink(enc);
  const counts = { entries: 0 };
  for (const [type, stream] of Object.entries(sample.streams)) {
    const entries = (stream.entries ?? []).map((e) => liveView(type, e));
    counts.entries += entries.length;
    sink(entries);
  }
  const p = sample.profile;
  let samples = 0;
  if (p?.status === 'present' && p.samples !== undefined) {
    samples = p.samples.length;
    enc.addProfilerChunk(
      { frames: p.frames ?? [], resources: p.resources ?? [], stacks: p.stacks ?? [], samples: p.samples },
      p.actualSampleIntervalMs,
    );
  }

  const model = enc.toCapture();
  const rcapBytes = await enc.finish(); // the packed .rcap
  const modelJsonGz = gzipSync(JSON.stringify(model));
  const rawGz = gzipSync(rawBytes);

  rows.push({
    file: file.replace(/^chrome-|\.json$/g, ''),
    entries: counts.entries,
    samples,
    slices: model.streams.profile?.slices.length ?? 0,
    raw: rawBytes.length,
    rawGz: rawGz.length,
    jsonGz: modelJsonGz.length,
    rcap: rcapBytes.length,
  });
}

console.log(
  'capture'.padEnd(24),
  'entries'.padStart(7),
  'samples'.padStart(8),
  'slices'.padStart(6),
  '      raw json',
  '     raw.gz',
  '    json.gz',
  '      .rcap',
  ' vs json.gz',
);
for (const r of rows) {
  console.log(
    r.file.padEnd(24),
    String(r.entries).padStart(7),
    String(r.samples).padStart(8),
    String(r.slices).padStart(6),
    kb(r.raw),
    kb(r.rawGz),
    kb(r.jsonGz),
    kb(r.rcap),
    pct(r.rcap, r.jsonGz).padStart(10),
  );
}
