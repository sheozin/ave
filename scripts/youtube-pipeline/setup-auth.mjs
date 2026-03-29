#!/usr/bin/env node
/**
 * Logs into CueDeck and saves storageState for use by record-demo.mjs episodes 2+.
 * Run this once before recording any non-ep01 episode.
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const AUTH_STATE = resolve(ROOT, 'youtube-branding/.auth-state.json');
const CONSOLE_URL = 'http://127.0.0.1:7230/cuedeck-console.html';

function loadCredentials() {
  let email = process.env.CUEDECK_EMAIL;
  let password = process.env.CUEDECK_PASSWORD;
  if (!email || !password) {
    const envPath = resolve(ROOT, '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const [k, ...v] = line.split('=');
        if (k.trim() === 'CUEDECK_EMAIL') email = v.join('=').trim();
        if (k.trim() === 'CUEDECK_PASSWORD') password = v.join('=').trim();
      }
    }
  }
  return { email, password };
}

async function main() {
  const { email, password } = loadCredentials();
  if (!email || !password) {
    console.error('Missing CUEDECK_EMAIL / CUEDECK_PASSWORD in .env');
    process.exit(1);
  }

  console.log('Logging into CueDeck...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.goto(CONSOLE_URL);
  await page.waitForTimeout(2000);

  const loginVisible = await page.locator('#login-form').isVisible().catch(() => false);
  if (loginVisible) {
    await page.locator('#lf-email').fill(email);
    await page.locator('#lf-password').fill(password);
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log('  ✓ Logged in');
  } else {
    console.log('  ✓ Already authenticated');
  }

  await context.storageState({ path: AUTH_STATE });
  console.log(`  ✓ Auth state saved: ${AUTH_STATE}`);

  await browser.close();
  console.log('Done! You can now record any episode without logging in each time.');
}

main().catch(err => {
  console.error('Auth setup failed:', err.message);
  process.exit(1);
});
