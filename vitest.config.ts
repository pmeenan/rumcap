import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['components/*/test/**/*.test.ts', 'components/*/src/**/*.test.ts'],
  },
});
