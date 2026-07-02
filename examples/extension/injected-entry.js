// Main-world entry injected at document_start by the demo extension. It reuses the SAME capture demo
// as examples/capture/ — the only thing the extension adds over a page capturing itself is (1) the
// `Document-Policy: js-profiling` response header (via declarativeNetRequest, so the JS Self-Profiler
// is available on pages you don't control) and (2) getting the capture code onto the page early.
//
// The measurement is still 100% in-page browser APIs. The extension is a HARNESS — it does not (and
// must not) source performance data from webRequest, the DevTools protocol, or any extension-only API.
//
// Build to `injected.js` (a classic IIFE — content scripts aren't ES modules) with esbuild; see
// README.md. `startCapture` auto-saves the `.rcap` on the first visibilitychange→hidden.

import { startCapture } from '../capture/rumcap-capture.js';

startCapture({
  metadata: { source: 'rumcap-extension-demo', ua: navigator.userAgent },
  sampleIntervalMs: 10,
});
