// Marketing screenshots for cuedeck.io (spec 2026-10-04-checkin-product-design, 4.3).
// Real app pages, fictional data from mocks, captured at 2x.
// Run: python3 -m http.server 7260 --bind 127.0.0.1 &
//      SHOT_DIR=/abs/out npx playwright test -c playwright.screens.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/screenshots', workers: 1, retries: 0, reporter: 'line',
  use: {
    baseURL: process.env.SHOT_BASE || 'http://127.0.0.1:7260', headless: true, channel: 'chrome',
    deviceScaleFactor: 2,
    launchOptions: { args: ['--host-resolver-rules=MAP *.supabase.co 127.0.0.1:9'] },
  },
});
