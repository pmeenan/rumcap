import { describe, it, expect } from 'vitest';
import {
  Encoder,
  unpack,
  samplesToSlices,
  asRelMs,
  asDurationMs,
  asEpochMs,
  type ProfilerTrace,
} from 'rumcap';

// A deterministic clock: the test moves `c.t` between begin/end so durations are exact and reproducible
// (no reliance on real `performance.now()`).
function makeClock(start = 0): { c: { t: number }; now: () => ReturnType<typeof asRelMs> } {
  const c = { t: start };
  return { c, now: () => asRelMs(c.t) };
}

// A tiny synthetic profiler trace: `main` on-stack across 3 samples (10ms interval), `work` nested for
// the first 2 → two slices (main 1000..1020, work 1000..1010); the trailing idle sample breaks the run.
const trace: ProfilerTrace = {
  sampleIntervalMs: asDurationMs(10),
  resources: ['https://app.example/bundle.js'],
  frames: [
    { name: 'main', resourceId: 0, line: 1, column: 1 },
    { name: 'work', resourceId: 0, line: 2, column: 1 },
  ],
  stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }],
  samples: [
    { timestamp: asRelMs(1000), stackId: 1 },
    { timestamp: asRelMs(1010), stackId: 1 },
    { timestamp: asRelMs(1020), stackId: 0 },
    { timestamp: asRelMs(1030) }, // idle
  ],
};

describe('streaming Encoder', () => {
  it('feeds a scripted stream, derives stack depth + measured durations, and round-trips', async () => {
    const { c, now } = makeClock();
    const enc = new Encoder({
      now,
      timeOrigin: asEpochMs(1_700_000_000_000),
      captureStart: asRelMs(0),
      sampleIntervalMs: asDurationMs(10),
      metadata: { build: 'x1' },
    });

    enc
      .setNavigation({ name: 'https://app.example/', startTime: asRelMs(0), duration: asDurationMs(100), initiatorType: 'navigation', type: 'navigate', redirectCount: 0 })
      .addResource({ name: 'https://app.example/app.js', startTime: asRelMs(10), duration: asDurationMs(20), initiatorType: 'script', responseStatus: 200 })
      .mark({ name: 'boot', startTime: asRelMs(5) })
      .putMetadata('n', 3)
      .markStream('environment', 'unsupported');

    // Stack-based custom events on the 'app' timeline: a nested pair (load ⊃ fetch).
    const app = enc.timeline('app');
    c.t = 200;
    const load = app.begin('load');
    c.t = 205;
    const fetchSpan = app.begin('fetch', { url: '/api' });
    c.t = 230;
    fetchSpan.end({ status: 200 }); // depth 1, duration 25, details merged
    c.t = 260;
    load.end(); // depth 0 (omitted), duration 60

    // A second timeline with an instant marker.
    c.t = 300;
    enc.timeline('render').instant('paint');

    enc.addProfilerChunk(trace);

    c.t = 2000; // now-at-finish → captureEnd
    const model = enc.toCapture();
    const back = await unpack(await enc.finish());

    // Codec round-trips the Encoder's output exactly.
    expect(back).toEqual(model);

    // Manifest: fed streams present; explicitly-marked one carries its reason; untouched are not-requested.
    expect(back.manifest.streams.navigation.status).toBe('present');
    expect(back.manifest.streams.customEvents.status).toBe('present');
    expect(back.manifest.streams.profile.status).toBe('present');
    expect(back.manifest.streams.environment.status).toBe('unsupported');
    expect(back.manifest.streams.lcp.status).toBe('not-requested');
    expect(back.manifest.clock.captureEnd).toBe(2000);
    expect(back.manifest.clock.timeOrigin).toBe(1_700_000_000_000);

    // Metadata (constructor + putMetadata merged).
    expect(back.metadata).toEqual({ build: 'x1', n: 3 });

    // Custom events: the 'app' track, pre-order sorted (load before fetch), depth derived from the stack.
    const appTrack = back.streams.customEvents!.tracks.find((t) => t.namespace === 'app')!;
    expect(appTrack.events).toEqual([
      { name: 'load', start: 200, duration: 60 }, // depth 0 omitted; no details
      { name: 'fetch', start: 205, duration: 25, depth: 1, details: { url: '/api', status: 200 } }, // begin+end details merged
    ]);
    const renderTrack = back.streams.customEvents!.tracks.find((t) => t.namespace === 'render')!;
    expect(renderTrack.events).toEqual([{ name: 'paint', start: 300, duration: 0 }]);

    // Profiler: the incremental fold equals the one-shot transform.
    expect(back.streams.profile).toEqual(samplesToSlices(trace, { sampleIntervalMs: 10 }));
  });

  it('scoped span() records begin→end duration and returns the callback result', () => {
    const { c, now } = makeClock();
    const enc = new Encoder({ now, timeOrigin: asEpochMs(1), captureStart: asRelMs(0) });
    c.t = 10;
    const result = enc.timeline('app').span('compute', () => {
      c.t = 25;
      return 42;
    });
    expect(result).toBe(42);
    const ev = enc.toCapture().streams.customEvents!.tracks[0]!.events[0]!;
    expect(ev).toEqual({ name: 'compute', start: 10, duration: 15 });
  });

  it('is idempotent on finish and rejects further events afterward', async () => {
    const enc = new Encoder({ now: () => asRelMs(0), timeOrigin: asEpochMs(1) });
    enc.mark({ name: 'a', startTime: asRelMs(1) });
    const a = await enc.finish();
    const b = await enc.finish();
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic, idempotent
    expect(() => enc.mark({ name: 'b', startTime: asRelMs(2) })).toThrow(/already finished/);
  });

  it('records the interval-adopting profiler path (no explicit sampleIntervalMs)', async () => {
    const enc = new Encoder({ now: () => asRelMs(0), timeOrigin: asEpochMs(1) });
    enc.addProfilerChunk(trace); // interval adopted from trace.sampleIntervalMs
    const back = await unpack(await enc.finish());
    expect(back.streams.profile).toEqual(samplesToSlices(trace));
  });
});
