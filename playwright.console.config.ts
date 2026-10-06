// Console specs for the command center redesign (2026-10-06) plus the
// existing console suites. System Chrome, Supabase blocked at DNS level so
// nothing reaches the real project; every spec mocks what it needs.
// Run: python3 -m http.server 7291 --bind 127.0.0.1 --directory <checkout> &
//      CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(console-[\w-]+|session-[\w-]+|auth-flows|ai-agents)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    headless: true,
    channel: 'chrome',
    launchOptions: { args: ['--host-resolver-rules=MAP *.supabase.co 127.0.0.1:9'] },
  },
});
