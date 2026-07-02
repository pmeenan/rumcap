// Field-inventory pass over the captured corpus — grounds the format schema.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
const files = readdirSync(OUT).filter((f) => f.startsWith('chrome-') && f.endsWith('.json'));

const keysOf = (objs) => {
  const m = new Map();
  for (const o of objs) for (const k of Object.keys(o || {})) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n}/${objs.length})`);
};

// 1) Resolve navigation:2 — dump the navigation entries' identifying fields.
console.log('================ NAVIGATION entries (resolve the "2") ================');
for (const f of files) {
  const cap = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
  const navs = (cap.streams.navigation && cap.streams.navigation.entries) || [];
  console.log(`\n${f}: ${navs.length} navigation entr${navs.length === 1 ? 'y' : 'ies'}`);
  navs.forEach((n, i) => console.log(`  [${i}] type=${n.type} name=${JSON.stringify((n.name || '').slice(0, 60))} ` +
    `redirectCount=${n.redirectCount} startTime=${n.startTime} duration=${n.duration} ` +
    `transferSize=${n.transferSize} activationStart=${n.activationStart}`));
}

// 2) Per-stream union of keys across all sites (optionality = count/total).
console.log('\n\n================ PER-STREAM KEY INVENTORY (union across sites) ================');
const byType = {};
for (const f of files) {
  const cap = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
  for (const [t, s] of Object.entries(cap.streams)) {
    if (!s.entries || !s.entries.length) continue;
    (byType[t] ||= []).push(...s.entries);
  }
}
for (const [t, entries] of Object.entries(byType)) {
  console.log(`\n--- ${t}  (${entries.length} entries) ---`);
  console.log('  keys: ' + keysOf(entries).join(', '));
}

// 3) Nested shapes that matter for the schema.
console.log('\n\n================ NESTED SHAPES ================');
const sample = (t, pred) => { for (const e of (byType[t] || [])) if (pred(e)) return e; return null; };

const res = byType.resource || [];
const withST = res.find((r) => r.serverTiming && r.serverTiming.length);
console.log('\nresource.serverTiming keys: ' + (withST ? keysOf(withST.serverTiming).join(', ') : '(none present)'));
console.log('resource initiatorType values: ' + [...new Set(res.map((r) => r.initiatorType))].join(', '));
console.log('resource deliveryType values: ' + [...new Set(res.map((r) => r.deliveryType))].join(', '));
console.log('resource renderBlockingStatus values: ' + [...new Set(res.map((r) => r.renderBlockingStatus))].join(', '));
console.log('resource responseStatus values: ' + [...new Set(res.map((r) => r.responseStatus))].join(', '));

const loaf = sample('long-animation-frame', (e) => e.__attribution && e.__attribution.scripts && e.__attribution.scripts.length);
console.log('\nLoAF entry keys: ' + (byType['long-animation-frame'] ? keysOf(byType['long-animation-frame']).join(', ') : '(none)'));
console.log('LoAF script keys: ' + (loaf ? keysOf(loaf.__attribution.scripts).join(', ') : '(no scripts captured)'));
if (loaf) console.log('LoAF script[0]: ' + JSON.stringify(loaf.__attribution.scripts[0]));

const lcp = sample('largest-contentful-paint', (e) => e.__attribution);
console.log('\nLCP __attribution: ' + (lcp ? JSON.stringify(lcp.__attribution) : '(none)'));

const ls = sample('layout-shift', (e) => e.__attribution && e.__attribution.sources && e.__attribution.sources.length);
console.log('layout-shift sources[0]: ' + (ls ? JSON.stringify(ls.__attribution.sources[0]) : '(no sources)'));

const inp = sample('event', (e) => e.__attribution && e.__attribution.interactionId);
console.log('event(INP) __attribution: ' + (inp ? JSON.stringify(inp.__attribution) : '(none with interactionId)'));
const fi = sample('first-input', () => true);
console.log('first-input entry: ' + (fi ? JSON.stringify({ name: fi.name, duration: fi.duration, processingStart: fi.processingStart, attr: fi.__attribution }) : '(none)'));

// 4) Environment + clock as actually captured.
console.log('\n\n================ ENV + CLOCK (one site) ================');
const one = JSON.parse(readFileSync(join(OUT, files[0]), 'utf8'));
console.log('clock: ' + JSON.stringify(one.clock));
console.log('environment: ' + JSON.stringify(one.environment, null, 0));
console.log('supportedEntryTypes: ' + one.supportedEntryTypes.join(', '));

// 5) Which streams came back unsupported / empty anywhere (degradation grounding).
console.log('\n================ STATUS MATRIX ================');
for (const f of files) {
  const cap = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
  const blanks = Object.entries(cap.streams).filter(([, s]) => s.status !== 'present').map(([t, s]) => `${t}:${s.status}`);
  console.log(`${f}: ${blanks.length ? blanks.join(', ') : '(all present)'}`);
}

// 6) JS Self-Profiling stream — interval clamp, idle %, stack depth, frame-name/url population.
console.log('\n\n================ PROFILE (JS Self-Profiling) ================');
for (const f of files) {
  const cap = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
  const p = cap.profile;
  if (!p || p.status !== 'present') { console.log(`\n${f}: profile ${p ? p.status : 'absent'}`); continue; }
  const { frames, stacks, samples } = p;
  // resolve stackId -> depth (walk parentId, guard cycles)
  const depthOf = (sid) => { let d = 0, cur = sid; const seen = new Set(); while (cur !== undefined && !seen.has(cur)) { seen.add(cur); d++; cur = stacks[cur].parentId; } return d; };
  let idle = 0, maxDepth = 0, sumD = 0, n = 0;
  for (const s of samples) { if (s.stackId === undefined) { idle++; continue; } const d = depthOf(s.stackId); maxDepth = Math.max(maxDepth, d); sumD += d; n++; }
  const emptyName = frames.filter((fr) => !fr.name).length;
  const noResource = frames.filter((fr) => fr.resourceId === undefined).length;
  console.log(`\n${f}`);
  console.log(`  interval: requested ${p.requestedSampleIntervalMs}ms -> actual ${p.actualSampleIntervalMs}ms  bufferFull=${p.sampleBufferFull}`);
  console.log(`  samples=${samples.length} idle=${idle} (${(100 * idle / samples.length).toFixed(0)}%)  frames=${frames.length} stacks=${stacks.length}`);
  console.log(`  stack depth avg=${(sumD / Math.max(1, n)).toFixed(0)} max=${maxDepth}  frames: emptyName=${emptyName} noResourceId=${noResource}`);
}
