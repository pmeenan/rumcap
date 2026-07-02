/**
 * Golden corpus: Capture-shaped fixtures the codec round-trips. These are the canonical in-memory
 * model (post-`capture` normalization) — NOT raw browser `toJSON()` output (that lives, unpacked, in
 * `samples/json`, and mapping raw -> Capture is `capture`'s job, not the codec's). Field shapes and
 * many concrete values are grounded in the real Chrome-149 captures under `samples/` (v0.app for
 * navigation/resource/LCP/LoAF/interaction shapes; cnn.com for the layout-shift sources + rects).
 *
 * The set deliberately spans the degraded variants the Phase-0 exit criterion names — Safari-subset
 * (streams `unsupported`), no-profiler (`policy-blocked`), buffer-overflowed (a `LossNote` +
 * truncation) — plus edge cases the codec must not smear: absent-vs-empty arrays, '' -vs- absent
 * strings, `detail: null` -vs- no detail, a populated `notRestoredReasons` tree -vs- `null`, and a
 * multi-context clock. Values invented to exercise a provisional/un-grounded path (the profiler
 * stream, the bfcache reason tree, high-entropy UA-CH) are labelled as synthetic where they appear.
 */

import {
  asRelMs,
  asDurationMs,
  asEpochMs,
  STREAM_IDS,
  STREAM_SCHEMA_VERSIONS,
  FORMAT_VERSION,
  type Capture,
  type Manifest,
  type StreamId,
  type StreamManifestEntry,
  type StreamStatus,
  type CaptureConfig,
  type ClockMeta,
  type ProfileFrame,
  type ProfileSlice,
} from 'rumcap';

const rel = asRelMs;
const dur = asDurationMs;
const epo = asEpochMs;

/** Build the TOTAL per-stream manifest: every StreamId gets `defaultStatus`, then apply overrides. */
function streamManifest(
  defaultStatus: StreamStatus,
  overrides: Partial<Record<StreamId, StreamManifestEntry>> = {},
): Record<StreamId, StreamManifestEntry> {
  const out = {} as Record<StreamId, StreamManifestEntry>;
  for (const id of STREAM_IDS) {
    out[id] = overrides[id] ?? { status: defaultStatus, schemaVersion: STREAM_SCHEMA_VERSIONS[id] };
  }
  return out;
}

const present = (id: StreamId, extra?: Omit<StreamManifestEntry, 'status' | 'schemaVersion'>): StreamManifestEntry => ({
  status: 'present',
  schemaVersion: STREAM_SCHEMA_VERSIONS[id],
  ...extra,
});

const baseClock: ClockMeta = {
  timeOrigin: epo(1782684971154.1), // fractional epoch ms — real performance.timeOrigin from v0.app
  captureStart: rel(0),
  captureEnd: rel(6121.9),
  unit: 'ms',
  base: 'timeOrigin',
};

const defaultConfig: CaptureConfig = { version: 1 };

// ── 1. richChrome — broad capture, grounded in the v0.app sample ─────────────────────────────────

const richChrome: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: { ...baseClock, precision: 0.1 },
    streams: streamManifest('not-requested', {
      navigation: present('navigation', { provenance: { api: 'PerformanceNavigationTiming', browser: 'Chrome', engine: 'Blink' } }),
      resources: present('resources'),
      paint: present('paint'),
      lcp: present('lcp'),
      cls: present('cls'),
      interactions: present('interactions'),
      longTasks: present('longTasks'),
      loaf: present('loaf'),
      userTiming: present('userTiming'),
      visibility: present('visibility'),
      environment: present('environment'),
      errors: present('errors'),
      elementTiming: present('elementTiming'),
      profile: { status: 'policy-blocked', schemaVersion: STREAM_SCHEMA_VERSIONS.profile },
    }),
    config: {
      version: 1,
      streams: {
        resources: { enabled: true, sampleRate: 1 },
        profile: { enabled: false },
      },
      profiler: { enabled: false, sampleIntervalMs: dur(10), maxBufferSize: 10000, trigger: 'sampled' },
      budgets: { maxBytes: 200000, maxMainThreadMs: 50, maxResourceEntries: 300 },
      sampling: { sessionSampleRate: 0.1 },
      redaction: { urls: 'keep', selectors: 'structural-only' },
    },
  },
  streams: {
    navigation: {
      name: 'https://v0.app/',
      startTime: rel(0),
      duration: dur(711.3),
      initiatorType: 'navigation',
      deliveryType: '', // '' is a real value ("no special delivery"), distinct from absent
      nextHopProtocol: 'h2',
      renderBlockingStatus: 'non-blocking',
      contentType: 'text/html',
      contentEncoding: 'br',
      // 0-valued phases that did not occur (worker/redirect/unload) are normalized to absent by capture
      fetchStart: rel(0.5),
      domainLookupStart: rel(0.9),
      domainLookupEnd: rel(18.9),
      connectStart: rel(18.9),
      secureConnectionStart: rel(33.7),
      connectEnd: rel(51.8),
      requestStart: rel(52.2),
      firstInterimResponseStart: rel(64.5),
      finalResponseHeadersStart: rel(164.4),
      responseStart: rel(64.5),
      responseEnd: rel(580.4),
      transferSize: 77875,
      encodedBodySize: 77575,
      decodedBodySize: 1055186,
      responseStatus: 200,
      serverTiming: [], // empty (site sends none) — must round-trip as [] not absent
      type: 'navigate',
      redirectCount: 0,
      domInteractive: rel(594.2),
      domContentLoadedEventStart: rel(594.2),
      domContentLoadedEventEnd: rel(594.2),
      domComplete: rel(710.9),
      loadEventStart: rel(711.3),
      loadEventEnd: rel(711.3),
      notRestoredReasons: null, // page was restorable (provisional field; corpus shows null)
      confidence: {}, // Chrome 149 serialized confidence as {} — empty but present
    },
    resources: [
      {
        name: 'https://v0.app/chat-static/_next/static/media/Geist_Variable-s.p.2glxvv8dkzvo5.woff2?dpl=dpl_5hFPyo9PS1ZQGbtFVNABm5U4iHM5',
        startTime: rel(170.5),
        duration: dur(26.8),
        initiatorType: 'link',
        deliveryType: '',
        nextHopProtocol: 'h2',
        renderBlockingStatus: 'non-blocking',
        contentType: '',
        contentEncoding: '',
        fetchStart: rel(170.5),
        requestStart: rel(171.5),
        responseStart: rel(190.2),
        finalResponseHeadersStart: rel(190.2),
        responseEnd: rel(197.3),
        transferSize: 57100,
        encodedBodySize: 56800,
        decodedBodySize: 56800,
        responseStatus: 200,
        serverTiming: [],
      },
      {
        // a resource carrying real Server-Timing (synthetic values) to exercise that nested array
        name: 'https://v0.app/api/data',
        startTime: rel(220.1),
        duration: dur(85.4),
        initiatorType: 'fetch',
        nextHopProtocol: 'h3',
        responseStatus: 200,
        transferSize: 1200,
        encodedBodySize: 900,
        decodedBodySize: 3400,
        serverTiming: [
          { name: 'cache', duration: dur(0), description: 'HIT' },
          { name: 'db', duration: dur(42.5) },
          { name: 'edge' },
        ],
      },
      {
        // a cross-origin opaque resource: minimal fields, responseStatus 0
        name: 'https://cdn.example.com/pixel.gif',
        startTime: rel(305.7),
        duration: dur(12.1),
        initiatorType: 'img',
        responseStatus: 0,
      },
    ],
    paint: {
      firstPaint: { startTime: rel(484.6), paintTime: rel(484.6), presentationTime: rel(495.1) },
      firstContentfulPaint: { startTime: rel(495.1), paintTime: rel(495.1), presentationTime: rel(516) },
    },
    lcp: {
      final: {
        startTime: rel(952),
        size: 65796,
        renderTime: rel(952),
        loadTime: rel(916.8),
        paintTime: rel(918.7),
        presentationTime: rel(952),
        id: '',
        url: 'https://v0.app/chat-static/_next/image?url=hero.png&w=640&q=75',
        element: {
          selector:
            'div.flex-1 > div.grid.grid-cols-1 > div.relative:nth-of-type(2) > div.shadow-base:nth-of-type(1) > img.object-cover.object-top',
        },
      },
      candidates: [
        {
          startTime: rel(516),
          size: 1200,
          renderTime: rel(516),
          element: { selector: 'h1.text-center.text-v0-gray-1000' },
        },
      ],
    },
    cls: {
      // grounded in the cnn.com layout-shift entry (value + sources + rects, incl. negatives below)
      shifts: [
        {
          startTime: rel(555.2),
          value: 0.003991352151434851,
          hadRecentInput: false,
          lastInputTime: rel(0),
          sources: [
            {
              node: { selector: 'div.layout__content-wrapper > section.layout-live-story-amplify__top > div.live-story-lede:nth-of-type(2)' },
              previousRect: { x: 174.5, y: 668.40625, width: 660, height: 99.59375, top: 668.40625, right: 834.5, bottom: 768, left: 174.5 },
              currentRect: { x: 174.5, y: 709.8125, width: 660, height: 58.1875, top: 709.8125, right: 834.5, bottom: 768, left: 174.5 },
            },
          ],
        },
        {
          // a shift with a source positioned off-screen (negative x/left) to exercise signed rect coords
          startTime: rel(1820.4),
          value: 0.0008,
          hadRecentInput: true,
          sources: [{ previousRect: { x: -32.5, y: -10, width: 100, height: 40, top: -10, right: 67.5, bottom: 30, left: -32.5 } }],
        },
      ],
    },
    interactions: {
      events: [
        {
          name: 'pointerdown',
          startTime: rel(4116.7),
          duration: dur(16),
          processingStart: rel(4117.9),
          processingEnd: rel(4118.2),
          interactionId: 6451,
          cancelable: true,
          firstInput: true,
          target: { selector: 'main.z-0.flex > div:nth-of-type(1) > h1.text-center.text-v0-gray-1000' },
        },
        {
          name: 'pointerover',
          startTime: rel(172.9),
          duration: dur(344),
          processingStart: rel(484.5),
          processingEnd: rel(484.5),
          interactionId: 0, // 0 == not part of an interaction (distinct from absent)
          cancelable: true,
          target: { selector: 'main.z-0.flex > div:nth-of-type(1) > h1.text-center.text-v0-gray-1000' },
        },
      ],
    },
    longTasks: {
      tasks: [
        { startTime: rel(753.6), duration: dur(56), attribution: [{}] }, // toJSON drops container detail -> empty
        { startTime: rel(2100.2), duration: dur(72), attribution: [{ name: 'self', containerType: 'window', containerSrc: 'https://v0.app/' }] },
      ],
    },
    loaf: {
      frames: [
        {
          startTime: rel(172.7),
          duration: dur(322.4),
          renderStart: rel(484.6),
          styleAndLayoutStart: rel(485.2),
          blockingDuration: dur(0),
          paintTime: rel(495.1),
          presentationTime: rel(516),
          scripts: [
            {
              startTime: rel(449.9),
              duration: dur(8.2),
              invokerType: 'classic-script',
              invoker: 'https://v0.app/',
              executionStart: rel(450.2),
              forcedStyleAndLayoutDuration: dur(7.6),
              pauseDuration: dur(0),
              sourceURL: 'https://v0.app/',
              sourceFunctionName: '',
              sourceCharPosition: 0,
              windowAttribution: 'self',
            },
          ],
        },
        { startTime: rel(3000.1), duration: dur(51) }, // a frame with no scripts/paint (absent optionals)
      ],
    },
    userTiming: {
      marks: [
        { name: 'FidesInitializing', startTime: rel(1445.5) },
        { name: 'app-route-change', startTime: rel(4200.1), detail: { route: '/chat', soft: true } }, // synthetic detail
      ],
      measures: [
        { name: 'content visible', startTime: rel(0), duration: dur(485.1) },
        { name: 'hydration', startTime: rel(516), duration: dur(180.5), detail: null }, // detail null != absent
      ],
    },
    visibility: {
      states: [
        { state: 'visible', startTime: rel(0) },
        { state: 'hidden', startTime: rel(6000.2) },
      ],
    },
    environment: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      userAgentData: {
        // high-entropy values are synthetic (the headless corpus has brands:[] / platform:'')
        brands: [
          { brand: 'Chromium', version: '149' },
          { brand: 'Not?A_Brand', version: '24' },
        ],
        mobile: false,
        platform: 'Linux',
        platformVersion: '6.17.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        fullVersionList: [{ brand: 'Chromium', version: '149.0.7827.200' }],
        formFactors: ['Desktop'],
      },
      deviceMemory: 32,
      hardwareConcurrency: 12,
      connection: { effectiveType: '4g', rtt: 0, downlink: 10, saveData: false },
      viewportWidth: 1366,
      viewportHeight: 768,
      screenWidth: 1366,
      screenHeight: 768,
      devicePixelRatio: 1,
      selfProfiler: 'needs-document-policy',
    },
    errors: { errors: [] }, // present but empty (no errors fired) — distinct from not-collected
    // Element Timing (opt-in via the `elementtiming` attribute) — synthetic; the corpus pages set none.
    elementTiming: {
      elements: [
        { startTime: rel(516), identifier: 'hero-image', url: 'https://v0.app/hero.png', renderTime: rel(516), loadTime: rel(480.2), naturalWidth: 1280, naturalHeight: 640, element: { selector: 'img.hero' } },
      ],
    },
  },
  overhead: {
    mainThreadMs: dur(12.3),
    approxBytes: 45000,
    byStream: {
      resources: { mainThreadMs: dur(4.1), approxBytes: 30000 },
      loaf: { approxBytes: 8000 },
    },
    truncated: false,
  },
};

// ── 2. safariSubset — degraded: APIs Safari lacks are `unsupported`, no data for them ───────────────

const safariSubset: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: { ...baseClock, timeOrigin: epo(1782684900000) },
    streams: streamManifest('unsupported', {
      navigation: present('navigation', { provenance: { browser: 'Safari', engine: 'WebKit' } }),
      resources: present('resources', { provenance: { browser: 'Safari', engine: 'WebKit' } }),
      paint: present('paint'),
      lcp: present('lcp'),
      cls: present('cls'),
      interactions: present('interactions'),
      visibility: present('visibility'),
      environment: present('environment'),
      // longTasks, loaf, elementTiming, userTiming(supported but) ... left unsupported/ not-requested:
      userTiming: { status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS.userTiming },
      profile: { status: 'unsupported', schemaVersion: STREAM_SCHEMA_VERSIONS.profile },
      errors: { status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS.errors },
    }),
    config: defaultConfig,
  },
  streams: {
    navigation: {
      name: 'https://example.com/',
      startTime: rel(0),
      duration: dur(420.5),
      initiatorType: 'navigation',
      responseStart: rel(120.2),
      responseEnd: rel(300.8),
      type: 'navigate',
      redirectCount: 0,
      domContentLoadedEventStart: rel(310),
      loadEventEnd: rel(420.5),
      // Safari omits many Chrome-only fields (renderBlockingStatus, deliveryType, worker*, confidence)
    },
    resources: [
      {
        name: 'https://example.com/app.js',
        startTime: rel(130.1),
        duration: dur(55.2),
        initiatorType: 'script',
        responseStatus: 200,
        transferSize: 24000,
      },
    ],
    paint: { firstContentfulPaint: { startTime: rel(260.3) } }, // Safari: FCP without paint/presentation split
    lcp: { final: { startTime: rel(300.1), size: 12000, element: { selector: 'img.hero' } } },
    cls: { shifts: [] }, // present, none observed
    interactions: {
      events: [{ name: 'pointerdown', startTime: rel(2000.1), duration: dur(48), interactionId: 12, firstInput: true }],
    },
    visibility: { states: [{ state: 'visible', startTime: rel(0) }] },
    environment: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      deviceMemory: 8,
      hardwareConcurrency: 8,
      viewportWidth: 1440,
      viewportHeight: 900,
      devicePixelRatio: 2,
      selfProfiler: 'unsupported', // Safari has no JS Self-Profiling API
    },
  },
};

// ── 3. bufferOverflowed — resource buffer overflowed; loss recorded, capture truncated ──────────────

const bufferOverflowed: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: baseClock,
    streams: streamManifest('not-requested', {
      navigation: present('navigation'),
      resources: present('resources', {
        loss: [
          { kind: 'buffer-overflow', at: rel(2300.5), droppedCount: 312, note: 'resource timing buffer full' },
          { kind: 'size-budget', droppedCount: 40 },
        ],
      }),
      // a stream the budget forced off entirely → `dropped` status, no data, loss recorded
      longTasks: { status: 'dropped', schemaVersion: STREAM_SCHEMA_VERSIONS.longTasks, loss: [{ kind: 'size-budget', note: 'main-thread budget exhausted' }] },
      environment: present('environment'),
    }),
    config: { version: 1, budgets: { maxResourceEntries: 150 } },
  },
  streams: {
    navigation: { name: 'https://shop.example/', startTime: rel(0), duration: dur(1200.5), initiatorType: 'navigation', type: 'navigate', redirectCount: 1, redirectStart: rel(2.1), redirectEnd: rel(40.3) },
    resources: [
      { name: 'https://shop.example/a.css', startTime: rel(50.1), duration: dur(30), initiatorType: 'link', responseStatus: 200 },
      { name: 'https://shop.example/b.js', startTime: rel(60.2), duration: dur(45), initiatorType: 'script', responseStatus: 200 },
    ],
    environment: { selfProfiler: 'needs-document-policy', hardwareConcurrency: 4 },
  },
  overhead: { truncated: true, mainThreadMs: dur(48.9), byStream: { resources: { mainThreadMs: dur(40) } } },
};

// ── 4. profilePresent — the JS self-profiling stream populated (PROVISIONAL shape, synthetic data) ──

const profilePresent: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: baseClock,
    streams: streamManifest('not-requested', {
      navigation: present('navigation'),
      environment: present('environment'),
      profile: present('profile', { provenance: { api: 'JS Self-Profiling', browser: 'Chrome', engine: 'Blink' } }),
    }),
    config: { version: 1, profiler: { enabled: true, sampleIntervalMs: dur(10), trigger: 'always' } },
  },
  streams: {
    navigation: { name: 'https://app.example/', startTime: rel(0), duration: dur(900), initiatorType: 'navigation', type: 'navigate', redirectCount: 0 },
    environment: { selfProfiler: 'available' },
    // Nested timed-slice wire model. Pre-order (start asc, then depth asc); a slice's parent is the
    // nearest preceding slice of depth-1. One single-sample transient was pruned -> droppedSamples.
    profile: {
      sampleIntervalMs: dur(10),
      resources: ['https://app.example/bundle.js'],
      frames: [
        { name: 'main', resourceId: 0, line: 12, column: 4 },
        { name: 'render', resourceId: 0, line: 88, column: 2 },
        { name: '' }, // anonymous frame, no resource — exercises absent optionals
      ],
      slices: [
        { frameId: 0, depth: 0, start: rel(100), duration: dur(20) }, // main, 100..120
        { frameId: 1, depth: 1, start: rel(100), duration: dur(10) }, // render nested under main, 100..110
        { frameId: 2, depth: 2, start: rel(100), duration: dur(10) }, // anon nested under render
      ],
      droppedSamples: 1,
    },
  },
};

// ── 5. multiContext — multi-context clock, populated notRestoredReasons tree, populated confidence ──

const multiContext: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: {
      ...baseClock,
      precision: 0.005,
      contexts: [
        { id: 'frame-1', kind: 'iframe', timeOrigin: epo(1782684971200.5), offsetToPage: dur(46.4) },
        { id: 'worker-1', kind: 'dedicated-worker', timeOrigin: epo(1782684971100), offsetToPage: dur(-54.1) }, // negative offset
      ],
    },
    streams: streamManifest('not-requested', { navigation: present('navigation') }),
    config: defaultConfig,
  },
  streams: {
    navigation: {
      name: 'https://bf.example/',
      startTime: rel(0),
      duration: dur(0), // a bfcache-style restore can report duration 0
      initiatorType: 'navigation',
      type: 'back_forward',
      redirectCount: 0,
      // Populated bfcache reason tree — PROVISIONAL spec shape, synthetic (corpus only shows null).
      notRestoredReasons: {
        url: 'https://bf.example/',
        reasons: [{ reason: 'masked' }],
        children: [
          { src: 'https://ads.example/iframe.html', id: 'ad-frame', name: 'ad', reasons: [{ reason: 'unload-listener' }, { reason: 'response-cache-control-no-store' }] },
          { children: [{ reasons: [{ reason: 'broadcastchannel-message' }] }] }, // nested-only child
        ],
      },
      confidence: { value: 'high', randomizedTriggerRate: 0.001 },
    },
  },
};

// ── 6. jsonDetailHeavy — User Timing `detail` across the whole JsonValue space ──────────────────────

const jsonDetailHeavy: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: baseClock,
    streams: streamManifest('not-requested', { userTiming: present('userTiming') }),
    config: defaultConfig,
  },
  streams: {
    userTiming: {
      marks: [
        { name: 'string-detail', startTime: rel(1), detail: 'a plain string' },
        { name: 'int-detail', startTime: rel(2), detail: 42 },
        { name: 'float-detail', startTime: rel(3), detail: -3.14159 },
        { name: 'bool-true', startTime: rel(4), detail: true },
        { name: 'bool-false', startTime: rel(5), detail: false },
        { name: 'null-detail', startTime: rel(6), detail: null },
        { name: 'no-detail', startTime: rel(7) }, // absent detail (must stay distinct from null-detail)
        { name: 'empty-array', startTime: rel(8), detail: [] },
        { name: 'empty-object', startTime: rel(9), detail: {} },
        {
          name: 'nested',
          startTime: rel(10),
          detail: {
            route: '/checkout',
            step: 3,
            flags: [true, false, null],
            meta: { a: [1, 2, { deep: 'value' }], b: '', c: 0 },
            items: [
              { id: 'sku-1', qty: 2 },
              { id: 'sku-2', qty: 0 },
            ],
          },
        },
      ],
      measures: [{ name: 'span', startTime: rel(1), duration: dur(9), detail: ['mixed', 1, true, null, { k: 'v' }] }],
    },
  },
};

// ── 7. minimalEmpty — nothing collected; only the manifest exists (degenerate path) ─────────────────

const minimalEmpty: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: { ...baseClock, captureStart: rel(0), captureEnd: rel(0) },
    streams: streamManifest('not-requested'),
    config: { version: 1 },
  },
  streams: {}, // no stream sections at all
};

// ── 8. profileHeavy — the JS self-profiling stream at volume, to exercise the columnar slice codec ──
// Deterministic (no RNG, so the test is reproducible): 500 roots × 4 nested slices = 2000 slices, in
// pre-order, ~40ms apart with 5µs jitter on the start column (so the µs-delta path is exercised), kept
// on the µs grid. This is the shape that makes the generic per-struct layout blow up and columnar shine.
function makeProfileHeavy(): Capture {
  const ROOTS = 500;
  const frames: ProfileFrame[] = [
    { name: '(program)' },
    { name: 'requestAnimationFrame', resourceId: 0, line: 11, column: 3 },
    { name: 'render', resourceId: 0, line: 88, column: 7 },
    { name: 'reconcile', resourceId: 0, line: 140, column: 12 },
    { name: 'commit', resourceId: 1, line: 22, column: 1 },
    { name: 'layout', resourceId: 1, line: 60, column: 5 },
  ];
  const q = (ms: number): number => Math.round(ms * 1000) / 1000; // keep timeline values on the µs grid
  const slices: ProfileSlice[] = [];
  for (let i = 0; i < ROOTS; i++) {
    const base = q(250 + i * 40 + (i % 5) * 0.005); // ~40ms apart, ±5µs jitter to exercise start deltas
    const mid = q(base + 20);
    // Pre-order: root, then its first child + that child's grandchild, then the second child (sibling).
    slices.push({ frameId: 0, depth: 0, start: rel(base), duration: dur(40) });
    slices.push({ frameId: 1 + (i % 5), depth: 1, start: rel(base), duration: dur(20) });
    slices.push({ frameId: 1 + ((i * 3) % 5), depth: 2, start: rel(base), duration: dur(10) });
    slices.push({ frameId: 1 + ((i + 2) % 5), depth: 1, start: rel(mid), duration: dur(20) });
  }
  return {
    formatVersion: FORMAT_VERSION,
    manifest: {
      clock: baseClock,
      streams: streamManifest('not-requested', {
        profile: present('profile', { provenance: { api: 'JS Self-Profiling', browser: 'Chrome', engine: 'Blink' } }),
      }),
      config: { version: 1, profiler: { enabled: true, sampleIntervalMs: dur(10), trigger: 'always' } },
    },
    streams: {
      profile: {
        sampleIntervalMs: dur(10),
        resources: ['https://app.example/main.js', 'https://app.example/vendor.js'],
        frames,
        slices,
        droppedSamples: 173,
      },
    },
  };
}
const profileHeavy = makeProfileHeavy();

// ── 9. customAndMeta — capture-level metadata + the customEvents stream (FORMAT_VERSION 2) ───────────
// Exercises: metadata (nested object, `null` and `{}` inside), multiple namespaces, a FLAT track and a
// NESTED track (explicit depth incl. depth:0 present vs absent), details present / null / absent, a
// measured duration:0, sub-ms measured durations (µs precision must survive, unlike inferred slices),
// a duplicate event name (interning), and a present-but-empty track (`[]` vs absent).
const customAndMeta: Capture = {
  formatVersion: FORMAT_VERSION,
  manifest: {
    clock: baseClock,
    streams: streamManifest('not-requested', {
      customEvents: present('customEvents', { provenance: { api: 'app-instrumentation' } }),
    }),
    config: defaultConfig,
  },
  metadata: {
    buildId: 'a1b2c3',
    experiment: 'checkout-v3',
    ab: true,
    rolloutPct: 12.5,
    tags: ['beta', 'us-east'],
    nested: { region: 'iad', shard: 4 },
    nullish: null, // null inside metadata — distinct from an absent key
    empty: {}, // empty object inside metadata
  },
  streams: {
    customEvents: {
      tracks: [
        // A FLAT track: no depth on any event.
        {
          namespace: 'router',
          events: [
            { name: 'route-change', start: rel(100), duration: dur(12.345) }, // sub-ms measured → µs kept
            { name: 'route-change', start: rel(2000), duration: dur(0), details: { to: '/cart' } }, // dup name (interning); duration 0 is real
          ],
        },
        // A NESTED track: explicit depth from the authoring stack.
        {
          namespace: 'checkout',
          events: [
            { name: 'checkout', start: rel(3000), duration: dur(450.5), depth: 0, details: { items: 3 } },
            { name: 'validate-cart', start: rel(3005), duration: dur(20.25), depth: 1 },
            { name: 'charge-card', start: rel(3030), duration: dur(390.125), depth: 1, details: null }, // details:null != absent
            { name: 'no-detail-no-depth', start: rel(3500), duration: dur(1) }, // both optionals absent
          ],
        },
        // A present-but-EMPTY track (must round-trip as [] not absent).
        { namespace: 'empty-ns', events: [] },
      ],
    },
  },
};

export interface NamedFixture {
  name: string;
  capture: Capture;
}

/** The golden corpus the round-trip test iterates over. */
export const fixtures: NamedFixture[] = [
  { name: 'richChrome', capture: richChrome },
  { name: 'safariSubset', capture: safariSubset },
  { name: 'bufferOverflowed', capture: bufferOverflowed },
  { name: 'profilePresent', capture: profilePresent },
  { name: 'multiContext', capture: multiContext },
  { name: 'jsonDetailHeavy', capture: jsonDetailHeavy },
  { name: 'minimalEmpty', capture: minimalEmpty },
  { name: 'profileHeavy', capture: profileHeavy },
  { name: 'customAndMeta', capture: customAndMeta },
];

/** Convenience: fixtures used by tests that want maximum stream/field coverage or the sample hot path. */
export { richChrome, minimalEmpty, profileHeavy };

// A compile-time nudge that the corpus stays exhaustive: every StreamId should appear `present` in at
// least one fixture so the codec path for it is exercised. (Checked at runtime in the test, too.)
export const ALL_STREAM_IDS: readonly StreamId[] = STREAM_IDS;

// Re-exported so the test can assert the manifest stays TOTAL without re-importing internals.
export type { Manifest };
