import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,  // LEOD UI tests share state — run sequentially
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
  // Run: preview_start LEOD Console first, then npm run test:e2e
});
