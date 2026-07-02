/**
 * Browser-entry integration tests, grounded in the REAL Chrome-149 captures under `samples/json`
 * (project guardrail: never shape a browser mapping from memory). Part A replays each raw capture —
 * every stream's `toJSON()` entries plus the raw profiler trace — through `entrySink`/`addProfilerChunk`
 * into an `Encoder`, packs it, and checks the output is consistent, stable under re-packing, and free
 * of the raw sentinels the model normalizes away. Part B unit-tests the quirks the corpus cannot
 * exhibit (spec-spelled SW router fields, error events, droppedEntriesCount, post-finish delivery).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  Encoder,
  entrySink,
  normalizeResource,
  normalizeNavigation,
  normalizeErrorEvent,
  normalizeRejection,
  normalizeMark,
  structuralSelector,
  pack,
  unpack,
  sniff,
  checkConsistency,
  asRelMs,
  asEpochMs,
  CODEC_VERSION,
  FORMAT_VERSION,
  type Capture,
  type EnvironmentStream,
  type ProfilerTrace,
} from 'rumcap';

// ── Part A: replay the raw sample corpus through the sink ───────────────────────────────────────────

interface RawSample {
  clock: { timeOrigin: number; now: number };
  environment: EnvironmentStream;
  streams: Record<string, { status: string; entries?: Record<string, unknown>[] }>;
  profile?: {
    status: string;
    actualSampleIntervalMs?: number;
    frames?: ProfilerTrace['frames'];
    resources?: string[];
    stacks?: ProfilerTrace['stacks'];
    samples?: ProfilerTrace['samples'];
  };
}

const samplesDir = new URL('../samples/json/', import.meta.url);
const sampleFiles = readdirSync(samplesDir).filter((f) => f.endsWith('.json'));

/**
 * Reconstruct the LIVE view of a raw sample entry. The spike stores each entry's `toJSON()` plus, under
 * `__attribution`, the live-only parts toJSON drops or empties: LoAF `scripts` serialize as `{}`, and
 * LCP `element` / shift `sources[].node` / interaction `target` are live nodes the spike pre-resolved
 * to structural selector strings. Grafting them back is what a real observer callback would have seen
 * (with selectors in place of nodes — which the normalizers accept directly).
 */
function liveView(type: string, entry: Record<string, unknown>): Record<string, unknown> {
  const attr = entry.__attribution as Record<string, unknown> | undefined;
  if (attr === undefined) return entry;
  const out = { ...entry };
  if (type === 'largest-contentful-paint' && attr.element !== undefined) out.element = attr.element;
  if (type === 'layout-shift' && Array.isArray(attr.sources)) out.sources = attr.sources;
  if ((type === 'event' || type === 'first-input') && attr.target !== undefined) out.target = attr.target;
  if (type === 'long-animation-frame' && Array.isArray(attr.scripts)) out.scripts = attr.scripts;
  return out;
}

function replay(sample: RawSample): { enc: Encoder; fed: Set<string> } {
  const enc = new Encoder({
    timeOrigin: asEpochMs(sample.clock.timeOrigin),
    captureStart: asRelMs(0),
    now: () => asRelMs(sample.clock.now),
  });
  enc.setEnvironment(sample.environment);
  const sink = entrySink(enc);
  const fed = new Set<string>();
  for (const [type, stream] of Object.entries(sample.streams)) {
    const entries = (stream.entries ?? []).map((e) => liveView(type, e));
    if (entries.length === 0) continue;
    // Exercise both input shapes the sink accepts: an entry-list-like for the first stream, plain
    // arrays for the rest (a live PerformanceObserver hands the sink the former).
    if (fed.size === 0) sink({ getEntries: () => entries });
    else sink(entries);
    fed.add(type);
  }
  const p = sample.profile;
  if (p?.status === 'present' && p.samples !== undefined) {
    enc.addProfilerChunk(
      { frames: p.frames ?? [], resources: p.resources ?? [], stacks: p.stacks ?? [], samples: p.samples },
      p.actualSampleIntervalMs,
    );
    fed.add('profile');
  }
  return { enc, fed };
}

describe('sample-corpus replay through entrySink', () => {
  it('found the raw sample corpus', () => {
    expect(sampleFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of sampleFiles) {
    it(`packs ${file} consistently and re-pack-stably`, async () => {
      const sample = JSON.parse(readFileSync(new URL(file, samplesDir), 'utf8')) as RawSample;
      const { enc, fed } = replay(sample);

      const bytes = await enc.finish();
      const decoded = await unpack(bytes);

      // Manifest and payloads must agree end-to-end through the sink.
      expect(checkConsistency(decoded)).toEqual([]);

      // Re-packing the decoded capture must be a fixed point (µs-quantized normal form).
      const again = await unpack(await pack(decoded));
      expect(again).toEqual(decoded);

      // The cleartext header identifies the file without decompressing.
      expect(sniff(bytes)).toEqual({ codecVersion: CODEC_VERSION, formatVersion: FORMAT_VERSION, readable: true });

      // Every stream that had raw entries landed as present.
      if (fed.has('resource')) {
        expect(decoded.manifest.streams.resources.status).toBe('present');
        expect(decoded.streams.resources!.length).toBe(sample.streams.resource!.entries!.length);
      }
      if (fed.has('navigation')) expect(decoded.manifest.streams.navigation.status).toBe('present');
      if (fed.has('profile')) {
        expect(decoded.manifest.streams.profile.status).toBe('present');
        expect(decoded.streams.profile!.sampleIntervalMs).toBe(sample.profile!.actualSampleIntervalMs);
        // A near-idle page (Google Finance here) can legitimately yield ZERO slices — every non-idle
        // run fell below the ~1-interval floor. The invariant is that nothing vanished silently:
        // either slices survived or the pruned samples are counted.
        const profile = decoded.streams.profile!;
        expect(profile.slices.length > 0 || profile.droppedSamples > 0).toBe(true);
      }

      // The model must carry NONE of the raw 0/''/-1 sentinels the normalizers exist to strip.
      for (const r of decoded.streams.resources ?? []) {
        for (const key of ['workerStart', 'redirectStart', 'redirectEnd', 'secureConnectionStart'] as const) {
          const v = r[key];
          if (v !== undefined) expect(v).toBeGreaterThan(0);
        }
        expect(r.nextHopProtocol).not.toBe('');
        // The Chrome-experimental workerMatched/FinalSourceType spellings must not leak through.
        expect('workerMatchedSourceType' in r).toBe(false);
        expect('workerFinalSourceType' in r).toBe(false);
      }
      for (const frame of decoded.streams.loaf?.frames ?? []) {
        for (const script of frame.scripts ?? []) {
          if (script.sourceCharPosition !== undefined) expect(script.sourceCharPosition).toBeGreaterThanOrEqual(0);
          expect(script.sourceURL).not.toBe('');
        }
      }
      for (const it2 of decoded.streams.interactions?.events ?? []) {
        if (it2.interactionId !== undefined) expect(it2.interactionId).not.toBe(0);
      }
    });
  }

  it('merges the double-delivered first interaction and keeps the complete navigation (CNN)', async () => {
    const sample = JSON.parse(readFileSync(new URL('chrome-www-cnn-com.json', samplesDir), 'utf8')) as RawSample;
    const { enc } = replay(sample);
    const decoded = await unpack(await enc.finish());

    // Two raw navigation deliveries (provisional duration:0, then complete) → the complete one wins.
    const rawNavs = sample.streams.navigation!.entries!;
    expect(rawNavs.length).toBeGreaterThan(1);
    const lastNav = rawNavs[rawNavs.length - 1]!;
    expect(decoded.streams.navigation!.duration).toBeCloseTo(lastNav.duration as number, 3);
    expect(decoded.streams.navigation!.duration).toBeGreaterThan(0);

    // first-input + its `event` twin (same startTime|name) collapse onto ONE entry, flagged firstInput.
    const rawEvents = sample.streams.event!.entries!;
    const rawFirst = sample.streams['first-input']!.entries!;
    const keys = new Set(rawEvents.map((e) => `${e.startTime as number}|${e.name as string}`));
    const overlap = rawFirst.filter((e) => keys.has(`${e.startTime as number}|${e.name as string}`)).length;
    const events = decoded.streams.interactions!.events;
    expect(events.length).toBe(rawEvents.length + rawFirst.length - overlap);
    expect(events.filter((e) => e.firstInput === true).length).toBe(rawFirst.length);

    // LCP: every raw candidate retained, the last one is final.
    const rawLcp = sample.streams['largest-contentful-paint']!.entries!;
    expect(decoded.streams.lcp!.candidates!.length).toBe(rawLcp.length);
    expect(decoded.streams.lcp!.final!.startTime).toBeCloseTo(
      rawLcp[rawLcp.length - 1]!.startTime as number,
      3,
    );
    // Chrome reports url:'' on this text-LCP candidate — the '' sentinel must not survive.
    expect(decoded.streams.lcp!.final!.url).not.toBe('');

    // Live attribution flowed: the CNN LCP is the h1#maincontent headline, the first-input carries a
    // structural target selector, and the grafted LoAF scripts carry their source attribution.
    expect(decoded.streams.lcp!.final!.element).toEqual({ selector: 'h1#maincontent' });
    const firstInput = decoded.streams.interactions!.events.find((e) => e.firstInput === true)!;
    expect(firstInput.target!.selector).toContain('body');
    const scripts = decoded.streams.loaf!.frames.flatMap((f) => f.scripts ?? []);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((s) => s.sourceURL !== undefined)).toBe(true);
    expect(scripts.some((s) => s.invokerType !== undefined)).toBe(true);

    // Paint milestones landed in their named slots with the Chrome paint/presentation extras.
    expect(decoded.streams.paint!.firstContentfulPaint).toBeDefined();
    expect(decoded.streams.paint!.firstContentfulPaint!.paintTime).toBeGreaterThan(0);
  });
});

// ── Part B: quirks the corpus cannot exhibit ────────────────────────────────────────────────────────

describe('normalizers (unit)', () => {
  it('maps SW static-routing fields onto the spec names from either spelling', () => {
    const spec = normalizeResource({ workerMatchedRouterSource: 'cache', workerFinalRouterSource: 'network' });
    expect(spec.workerMatchedRouterSource).toBe('cache');
    expect(spec.workerFinalRouterSource).toBe('network');
    const chrome = normalizeResource({ workerMatchedSourceType: 'cache', workerFinalSourceType: 'fetch-event' });
    expect(chrome.workerMatchedRouterSource).toBe('cache');
    expect(chrome.workerFinalRouterSource).toBe('fetch-event');
    expect(normalizeResource({ workerMatchedSourceType: '' }).workerMatchedRouterSource).toBeUndefined();
  });

  it('keeps serverTiming [] (collected, none sent) distinct from absent (not collected)', () => {
    expect(normalizeResource({ serverTiming: [] }).serverTiming).toEqual([]);
    expect(normalizeResource({}).serverTiming).toBeUndefined();
    expect(
      normalizeResource({ serverTiming: [{ name: 'db', duration: 0, description: '' }] }).serverTiming,
    ).toEqual([{ name: 'db', duration: 0 }]); // duration 0 kept (measured); description '' dropped
  });

  it('preserves notRestoredReasons null and normalizes the reason tree', () => {
    expect(normalizeNavigation({ notRestoredReasons: null }).notRestoredReasons).toBeNull();
    expect(normalizeNavigation({}).notRestoredReasons).toBeUndefined();
    const nav = normalizeNavigation({
      notRestoredReasons: {
        url: 'https://a.example/',
        reasons: [{ reason: 'unload-listener' }],
        children: [{ src: 'frame.html', reasons: [] }],
      },
    });
    expect(nav.notRestoredReasons).toEqual({
      url: 'https://a.example/',
      reasons: [{ reason: 'unload-listener' }],
      children: [{ src: 'frame.html', reasons: [] }],
    });
    // Chrome 149 serializes confidence as {} — carries nothing, must be dropped.
    expect(normalizeNavigation({ confidence: {} }).confidence).toBeUndefined();
    expect(normalizeNavigation({ confidence: { value: 'high' } }).confidence).toEqual({ value: 'high' });
  });

  it('renames error-event fields onto the model and drops unknown-position sentinels', () => {
    const entry = normalizeErrorEvent(
      { message: 'boom', filename: 'https://a.example/app.js', lineno: 0, colno: 7, error: { name: 'TypeError', stack: 'TypeError: boom\n  at x' } },
      asRelMs(1234),
    );
    expect(entry).toEqual({
      startTime: 1234,
      kind: 'error',
      message: 'boom',
      source: 'https://a.example/app.js', // event says `filename`; the model key is `source`
      colno: 7, // lineno 0 = unknown → dropped
      name: 'TypeError',
      stack: 'TypeError: boom\n  at x',
    });
  });

  it('coerces rejection reasons defensively', () => {
    expect(normalizeRejection({ reason: 'nope' }, asRelMs(1))).toEqual({
      startTime: 1,
      kind: 'unhandledrejection',
      message: 'nope',
    });
    const err = normalizeRejection({ reason: { name: 'AbortError', message: 'aborted', stack: 's' } }, asRelMs(2));
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('aborted');
    const hostile = normalizeRejection(
      { reason: { toString: () => { throw new Error('gotcha'); } } },
      asRelMs(3),
    );
    expect(hostile.kind).toBe('unhandledrejection'); // hostile toString must not throw out of the mapper
    expect(hostile.message).toBeUndefined();
  });

  it('drops the spec sentinel sourceCharPosition -1 and keeps a real 0 [synthetic; spec-grounded]', async () => {
    // The corpus only exhibits real positions (0 = script start), so the -1 branch is exercised
    // synthetically here; the LoAF spec defines -1 as "could not be determined". A kept -1 would
    // make pack() throw (non-negative varuint) — proven by packing the normalized entry below.
    const { normalizeLoaf } = await import('rumcap');
    const frame = normalizeLoaf({
      startTime: 1,
      duration: 60,
      scripts: [
        { startTime: 2, duration: 50, sourceCharPosition: -1, sourceURL: 'https://a.example/x.js' },
        { startTime: 3, duration: 5, sourceCharPosition: 0 },
      ],
    });
    expect(frame.scripts![0]!.sourceCharPosition).toBeUndefined();
    expect(frame.scripts![1]!.sourceCharPosition).toBe(0);
    const enc = new Encoder({ timeOrigin: asEpochMs(1), now: () => asRelMs(0) });
    enc.addLoaf(frame);
    await expect(enc.finish()).resolves.toBeInstanceOf(Uint8Array); // the stripped -1 can't crash pack
  });

  it('drops the platform-default null mark detail but keeps real details', () => {
    expect(normalizeMark({ name: 'm', startTime: 1, detail: null }).detail).toBeUndefined();
    expect(normalizeMark({ name: 'm', startTime: 1, detail: { a: 1 } }).detail).toEqual({ a: 1 });
  });

  it('builds structural selectors and never element text', () => {
    const grandparent = { nodeType: 1, localName: 'main', id: 'content', parentElement: null } as Record<string, unknown>;
    const parent = { nodeType: 1, localName: 'div', id: '', classList: ['card', 'hero', 'extra'], parentElement: grandparent } as Record<string, unknown>;
    const el = { nodeType: 1, localName: 'img', id: '', classList: [], parentElement: parent, textContent: 'SECRET' } as Record<string, unknown>;
    (grandparent as { children?: unknown }).children = [parent];
    (parent as { children?: unknown }).children = [{ nodeType: 1, localName: 'img' }, el];
    // nth-of-type disambiguates among same-tag siblings; classes capped at two; the walk stops at #id.
    expect(structuralSelector(el)).toBe('main#content > div.card.hero > img:nth-of-type(2)');
    expect(structuralSelector(el)).not.toContain('SECRET');
    expect(structuralSelector(null)).toBeUndefined();
    expect(structuralSelector({ nodeType: 3 })).toBeUndefined(); // a text node is never a selector
  });
});

describe('entrySink (unit)', () => {
  const baseInit = { timeOrigin: asEpochMs(1), captureStart: asRelMs(0), now: () => asRelMs(0) };

  it('records droppedEntriesCount as a manifest loss note on the entry stream', async () => {
    const enc = new Encoder(baseInit);
    const sink = entrySink(enc);
    sink(
      [{ entryType: 'resource', name: 'https://a.example/x.js', startTime: 1, duration: 2, initiatorType: 'script' }],
      undefined,
      { droppedEntriesCount: 5 },
    );
    const capture: Capture = await unpack(await enc.finish());
    expect(capture.manifest.streams.resources.status).toBe('present');
    expect(capture.manifest.streams.resources.loss).toEqual([{ kind: 'buffer-overflow', droppedCount: 5 }]);
    expect(checkConsistency(capture)).toEqual([]);
  });

  it('ignores unknown entry types and drops deliveries after finish() without throwing', async () => {
    const enc = new Encoder(baseInit);
    const sink = entrySink(enc);
    sink({ entryType: 'soft-navigation', startTime: 1 }); // a type this build predates → ignored
    await enc.finish();
    expect(() =>
      sink([{ entryType: 'resource', name: 'late', startTime: 9, duration: 1, initiatorType: 'fetch' }]),
    ).not.toThrow(); // a lingering observer delivery must never throw inside the page
  });

  it('merges ONLY the first-input twin — distinct events sharing startTime+name all survive', () => {
    // Grounded in the CNN capture: `pointerenter` dispatches once per ancestor element, all stamped
    // with the same event time — same startTime+name, genuinely distinct entries.
    const enc = new Encoder(baseInit);
    const sink = entrySink(enc);
    const enter = { entryType: 'event', name: 'pointerenter', startTime: 100, duration: 16, interactionId: 0 };
    sink([
      { entryType: 'first-input', name: 'pointerdown', startTime: 300, duration: 24 },
      enter,
      { ...enter },
      { ...enter },
      { entryType: 'event', name: 'pointerdown', startTime: 300, duration: 24 }, // the first-input's twin
    ]);
    const events = enc.toCapture().streams.interactions!.events;
    expect(events.length).toBe(4); // 3 pointerenters + 1 merged pointerdown
    expect(events.filter((e) => e.name === 'pointerenter').length).toBe(3);
    expect(events.filter((e) => e.firstInput === true).length).toBe(1);
  });

  it('accumulates paint milestones into their singleton slots', () => {
    const enc = new Encoder(baseInit);
    const sink = entrySink(enc);
    sink([
      { entryType: 'paint', name: 'first-paint', startTime: 100, paintTime: 90 },
      { entryType: 'paint', name: 'first-contentful-paint', startTime: 120, presentationTime: 125 },
    ]);
    const paint = enc.toCapture().streams.paint!;
    expect(paint.firstPaint).toEqual({ startTime: 100, paintTime: 90 });
    expect(paint.firstContentfulPaint).toEqual({ startTime: 120, presentationTime: 125 });
  });
});

describe('sniff (unit)', () => {
  it('rejects non-`.rcap` and truncated input without throwing', () => {
    expect(sniff(new Uint8Array([]))).toBeNull();
    expect(sniff(new TextEncoder().encode('{"json":true}'))).toBeNull();
    expect(sniff(new Uint8Array([0xf5, 0x52, 0x55, 0x4d]))).toBeNull(); // magic only, versions missing
  });
});
