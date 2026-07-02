# Extension demo (Chrome MV3)

A **minimal harness** that turns any page into a capture source, on top of the [capture
demo](../capture/). It is a demo, not shipped product. Over a page capturing itself, the extension adds
exactly two things:

1. **`Document-Policy: js-profiling` response header** — added to top-level/sub-frame responses via a
   `declarativeNetRequest` rule ([rules.json](rules.json)), so the JS Self-Profiler is available on
   pages you don't control. (A page can't set this header for itself.)
2. **Early injection** — a `document_start`, **main-world** content script ([injected.js](injected.js),
   built from [injected-entry.js](injected-entry.js)) runs the capture demo before the page executes, so
   early navigation/paint/resource entries aren't missed.

The measurement is still 100% in-page Web Performance APIs. **The extension is a harness** — it never
sources performance data from `webRequest`, the DevTools protocol, or any other extension-only surface.

## Build

Content scripts aren't ES modules, so the demo (which `import`s `rumcap/encode`) is bundled into one
classic IIFE with [esbuild](https://esbuild.github.io/):

```bash
# from the repo root
npm run build          # build the library into dist/ first
npx esbuild examples/extension/injected-entry.js --bundle --format=iife \
  --alias:rumcap/encode=./dist/encode.js --outfile=examples/extension/injected.js
```

`injected.js` is a generated artifact (git-ignored). Rebuild it after changing the library or the
capture demo.

## Load & use

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this
   `examples/extension/` folder.
2. Visit any page. The capture starts at `document_start`; when you navigate away or switch tabs, a
   `.rcap` downloads (the capture demo's own save-on-hide).
3. Open the `.rcap` in a supporting viewer
   ([waterfall-tools](https://github.com/pmeenan/waterfall-tools)).

> **Scope.** As written it matches `<all_urls>` and saves on every page-hide — fine for a demo, noisy
> for daily browsing. Narrow `content_scripts[].matches` (and the `rules.json` condition) to the sites
> you actually want to profile.

## Caveats

- **JS Self-Profiling is Chromium-only today** and the enabling policy token has been in flux
  (`js-profiling` is what current Chrome accepts; the WICG draft also introduces `js-profiling-mode` —
  [spec](https://wicg.github.io/js-self-profiling/)). Verify the accepted token against your target
  browser before relying on the header; when the profiler is unavailable the capture records
  `profile: policy-blocked` (absence is data).
- **In-page download** (blob URL + `<a download>`) can be blocked by a strict page CSP. A more robust
  variant relays the bytes from the main-world script to a background service worker and saves via
  `chrome.downloads` — left out here to keep the demo small.
- **Privacy.** The extension sees real, possibly-authenticated pages. Redaction of URLs/stack frames is
  a pre-`pack` pass (not part of the codec) and is out of scope for this demo — don't collect from
  sensitive sessions with it as-is.
