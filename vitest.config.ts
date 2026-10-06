import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Playwright suites: e2e, and the marketing screenshot script.
    exclude: ['tests/e2e/**', 'tests/screenshots/**'],
    reporters: ['verbose'],
  },
});
