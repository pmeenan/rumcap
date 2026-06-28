import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ENTRY_TYPE_TO_STREAM,
  STREAM_IDS,
  STREAM_STATUSES,
  FORMAT_VERSION,
  STREAM_SCHEMA_VERSIONS,
  asEpochMs,
  asRelMs,
  type Capture,
  type StreamId,
  type StreamManifestEntry,
} from '@rum-profiler/format';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'json');
// Ignore underscore-prefixed meta files (e.g. the _summary.json the capture tool may write).
const sampleFiles = readdirSync(samplesDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

interface RawEntry {
  entryType?: string;
  [key: string]: unknown;
}
interface RawStream {
  status?: string;
  entries?: RawEntry[];
}
interface RawSample {
  streams: Record<string, RawStream>;
}

const loadSample = (f: string): RawSample => JSON.parse(readFileSync(join(samplesDir, f), 'utf8')) as RawSample;

/** Union of raw top-level keys for one entryType across all sample files. */
const unionKeys = (entryType: string): Set<string> => {
  const keys = new Set<string>();
  for (const f of sampleFiles) {
    const stream = loadSample(f).streams[entryType];
    for (const entry of stream?.entries ?? []) for (const k of Object.keys(entry)) keys.add(k);
  }
  return keys;
};

describe('format version + registry', () => {
  it('exposes a positive integer format version', () => {
    expect(Number.isInteger(FORMAT_VERSION)).toBe(true);
    expect(FORMAT_VERSION).toBeGreaterThan(0);
  });

  it('versions every StreamId (registry and schema cannot drift)', () => {
    for (const id of STREAM_IDS) {
      expect(STREAM_SCHEMA_VERSIONS[id]).toBeGreaterThan(0);
    }
  });

  it('maps every entryType to a known StreamId', () => {
    for (const id of Object.values(ENTRY_TYPE_TO_STREAM)) {
      expect(STREAM_IDS).toContain(id);
    }
  });
});

describe('schema covers the grounded corpus', () => {
  it('found sample captures to check against', () => {
    expect(sampleFiles.length).toBeGreaterThan(0);
  });

  for (const f of sampleFiles) {
    it(`${f}: every observed entryType is registered`, () => {
      const cap = loadSample(f);
      const observed = new Set<string>();
      for (const stream of Object.values(cap.streams)) {
        for (const entry of stream.entries ?? []) {
          if (entry.entryType) observed.add(entry.entryType);
        }
      }
      for (const entryType of observed) {
        expect(ENTRY_TYPE_TO_STREAM[entryType], `entryType "${entryType}" is unmapped`).toBeDefined();
      }
    });
  }
});

// Field-level drift guard. If a future capture surfaces a raw entry field we don't account for,
// these fail — forcing a schema decision rather than silently dropping data. "Accounted for" =
// modeled, renamed, or deliberately dropped. Lists mirror the per-stream models in streams/*.ts.
const RESOURCE_FIELDS = [
  'name', 'startTime', 'duration', 'initiatorType', 'deliveryType', 'nextHopProtocol',
  'renderBlockingStatus', 'contentType', 'contentEncoding',
  'workerStart', 'workerRouterEvaluationStart', 'workerCacheLookupStart',
  // legacy Chrome spelling still in the corpus; the model normalizes these to workerMatched/FinalRouterSource
  'workerMatchedSourceType', 'workerFinalSourceType',
  'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd',
  'connectStart', 'secureConnectionStart', 'connectEnd', 'requestStart',
  'firstInterimResponseStart', 'finalResponseHeadersStart', 'responseStart', 'responseEnd',
  'transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStatus', 'serverTiming',
];
const NAVIGATION_EXTRA_FIELDS = [
  'type', 'redirectCount', 'unloadEventStart', 'unloadEventEnd', 'domInteractive',
  'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete',
  'loadEventStart', 'loadEventEnd', 'activationStart', 'criticalCHRestart',
  'notRestoredReasons', 'confidence',
];
// entryType is the stream discriminator; __attribution is the live-DOM data the spike adds.
const COMMON_DROPPED = ['entryType', '__attribution'];

// raw entryType -> the raw top-level keys we account for (excluding COMMON_DROPPED). `name` and
// `duration` appear on many entry types as discriminator/always-zero and are folded in where kept.
const ACCOUNTED: Record<string, readonly string[]> = {
  resource: RESOURCE_FIELDS,
  navigation: [...RESOURCE_FIELDS, ...NAVIGATION_EXTRA_FIELDS],
  paint: ['name', 'startTime', 'duration', 'paintTime', 'presentationTime'],
  'largest-contentful-paint': [
    'name', 'startTime', 'duration', 'paintTime', 'presentationTime',
    'size', 'renderTime', 'loadTime', 'id', 'url',
  ],
  'layout-shift': ['name', 'startTime', 'duration', 'value', 'hadRecentInput', 'lastInputTime', 'sources'],
  'first-input': ['name', 'startTime', 'duration', 'interactionId', 'processingStart', 'processingEnd', 'cancelable'],
  event: ['name', 'startTime', 'duration', 'interactionId', 'processingStart', 'processingEnd', 'cancelable'],
  longtask: ['name', 'startTime', 'duration', 'attribution'],
  'long-animation-frame': [
    'name', 'startTime', 'duration', 'renderStart', 'styleAndLayoutStart', 'firstUIEventTimestamp',
    'blockingDuration', 'paintTime', 'presentationTime', 'scripts',
  ],
  mark: ['name', 'startTime', 'duration'],
  measure: ['name', 'startTime', 'duration'],
  'visibility-state': ['name', 'startTime', 'duration'],
};

describe('field coverage vs the corpus (drift guard)', () => {
  for (const [entryType, accounted] of Object.entries(ACCOUNTED)) {
    it(`${entryType}: every captured field is modeled or explicitly dropped`, () => {
      const allowed = new Set([...accounted, ...COMMON_DROPPED]);
      const unknown = [...unionKeys(entryType)].filter((k) => !allowed.has(k));
      expect(unknown, `unaccounted ${entryType} fields: ${unknown.join(', ')}`).toEqual([]);
    });
  }

  it('long-animation-frame scripts: every nested script field is modeled', () => {
    const allowed = new Set([
      'startTime', 'duration', 'invokerType', 'invoker', 'executionStart',
      'forcedStyleAndLayoutDuration', 'pauseDuration', 'sourceURL', 'sourceFunctionName',
      'sourceCharPosition', 'windowAttribution', 'name', 'entryType',
    ]);
    const keys = new Set<string>();
    for (const f of sampleFiles) {
      for (const frame of loadSample(f).streams['long-animation-frame']?.entries ?? []) {
        for (const script of (frame.scripts as RawEntry[] | undefined) ?? []) {
          for (const k of Object.keys(script)) keys.add(k);
        }
      }
    }
    const unknown = [...keys].filter((k) => !allowed.has(k));
    expect(unknown, `unaccounted LoAF script fields: ${unknown.join(', ')}`).toEqual([]);
  });
});

describe('the model is constructible', () => {
  it('a degraded capture type-checks with a TOTAL manifest and round-trips JSON', () => {
    // Manifest.streams is total: an explicit status for every stream, then a few overridden.
    // fromEntries types as { [k: string]: V }; the cast asserts exhaustive StreamId coverage.
    const streams: Record<StreamId, StreamManifestEntry> = Object.fromEntries(
      STREAM_IDS.map((id): [StreamId, StreamManifestEntry] => [
        id,
        { status: 'not-requested', schemaVersion: STREAM_SCHEMA_VERSIONS[id] },
      ]),
    ) as Record<StreamId, StreamManifestEntry>;
    streams.navigation = { status: 'present', schemaVersion: STREAM_SCHEMA_VERSIONS.navigation };
    streams.profile = { status: 'policy-blocked', schemaVersion: STREAM_SCHEMA_VERSIONS.profile };
    streams.environment = { status: 'unsupported', schemaVersion: STREAM_SCHEMA_VERSIONS.environment };

    const cap: Capture = {
      formatVersion: FORMAT_VERSION,
      manifest: {
        clock: {
          timeOrigin: asEpochMs(1782678998476),
          captureStart: asRelMs(0),
          captureEnd: asRelMs(1000),
          unit: 'ms',
          base: 'timeOrigin',
        },
        streams,
        config: { version: 1 },
      },
      streams: {},
    };

    // Every stream has an explicit, known status — no silent omissions.
    expect(Object.keys(cap.manifest.streams).sort()).toEqual([...STREAM_IDS].sort());
    for (const entry of Object.values(cap.manifest.streams)) {
      expect(STREAM_STATUSES).toContain(entry.status);
    }

    const roundTripped = JSON.parse(JSON.stringify(cap)) as Capture;
    expect(roundTripped.formatVersion).toBe(FORMAT_VERSION);
    expect(roundTripped.manifest.streams.profile.status).toBe('policy-blocked');
  });
});
