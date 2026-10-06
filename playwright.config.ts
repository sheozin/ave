import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Screenshot baselines are recorded on macOS with system Chrome
  // (playwright.console.config.ts); CI's Linux Chromium cannot match them.
  testIgnore: /console-visual\.spec\.ts$/,
  fullyParallel: false,  // CueDeck UI tests share state — run sequentially
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:7230',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Do NOT start a web server — assumes preview server already running on 7230
  // Run: preview_start CueDeck Console first, then npm run test:e2e
});
