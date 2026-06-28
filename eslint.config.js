import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dist = build output; samples = reference data + browser/puppeteer reproduction tooling
    // (different globals, not shipped first-party code). node_modules is ignored by default.
    ignores: ['**/dist/**', 'components/format/samples/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Prefix intentionally-unused identifiers with _ (matches AGENTS.md convention).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
