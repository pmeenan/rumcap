import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dist = build output; samples/json = captured reference DATA; injected.js = a built bundle.
    // First-party CODE — including the samples/capture-tool reproduction scripts — stays under lint
    // (AGENTS.md: "all first-party code stays under lint coverage"). node_modules is ignored by default.
    ignores: ['**/dist/**', 'samples/json/**', 'samples/capture-tool/node_modules/**', 'examples/extension/injected.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Prefix intentionally-unused identifiers with _ (matches AGENTS.md convention).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Demos (examples/) are browser + Chrome-extension code, not shipped first-party library code, but
    // still worth linting — give them the browser/webextension globals rather than ignoring them.
    files: ['examples/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, Profiler: 'readonly' },
    },
  },
  {
    // Capture-reproduction tooling. drive.mjs is a Node puppeteer driver whose serialized callbacks
    // (page.evaluate / evaluateOnNewDocument) run IN THE PAGE, so it legitimately mixes node + browser
    // globals; inspect.mjs is plain Node; capture-spike.js is the injected page script.
    files: ['samples/capture-tool/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Profiler: 'readonly' } },
  },
  {
    files: ['samples/capture-tool/capture-spike.js'],
    languageOptions: { globals: { ...globals.browser, Profiler: 'readonly' } },
  },
);
