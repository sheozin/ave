#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CONSOLE_URL = 'http://127.0.0.1:7230/cuedeck-console.html';

function loadCreds() {
  const envPath = resolve(ROOT, '.env');
  let email, password;
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const [k, ...v] = line.split('=');
      if (k.trim() === 'CUEDECK_EMAIL') email = v.join('=').trim();
      if (k.trim() === 'CUEDECK_PASSWORD') password = v.join('=').trim();
    }
  }
  return { email, password };
}

// First: cleanup using auth state
if (existsSync(resolve(ROOT, 'youtube-branding/.auth-state.json'))) {
  const cleanBrowser = await chromium.launch({ headless: true });
  const cleanCtx = await cleanBrowser.newContext({ storageState: resolve(ROOT, 'youtube-branding/.auth-state.json'), viewport: { width: 1920, height: 1080 } });
  const cleanPage = await cleanCtx.newPage();
  await cleanPage.goto(CONSOLE_URL);
  await cleanPage.waitForFunction(() => typeof S !== 'undefined' && !!S?.user?.id, { timeout: 20000 }).catch(() => {});
  await cleanPage.waitForTimeout(1000);
  const cleanResult = await cleanPage.evaluate(async () => {
    const { data: events } = await sb.from('leod_events').select('id');
    if (!events || !events.length) return { deleted: 0 };
    let deleted = 0;
    for (const ev of events) {
      await sb.from('leod_sessions').delete().eq('event_id', ev.id);
      const { error } = await sb.from('leod_events').delete().eq('id', ev.id);
      if (!error) deleted++;
    }
    return { deleted };
  });
  console.log('Cleanup result:', cleanResult);
  await cleanBrowser.close();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();

// Capture ALL console messages
page.on('console', msg => {
  console.log(`[PAGE ${msg.type().toUpperCase()}]`, msg.text());
});

// Capture unhandled exceptions / rejections
page.on('pageerror', err => {
  console.log('[PAGE EXCEPTION]', err.message, err.stack?.split('\n').slice(0,3).join(' | '));
});

await page.goto(CONSOLE_URL);
await page.waitForTimeout(2000);

const loginVisible = await page.locator('#login-form').isVisible().catch(() => false);
console.log('Login form visible:', loginVisible);

if (loginVisible) {
  const { email, password } = loadCreds();
  console.log('Logging in as:', email);
  await page.locator('#lf-email').fill(email);
  await page.locator('#lf-password').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
  await page.waitForFunction(() => typeof S !== 'undefined' && !!S?.user?.id, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// Suppress everything except wizard
await page.evaluate(() => {
  window.initChecklist = () => {};
  window.showRoleTips  = () => {};
  window.showTipAt     = () => {};
  window._tipQueue     = [];
  document.querySelectorAll('#welcome-modal,#checklist-wrap,#ob-tip').forEach(e => e.style.display = 'none');
  window._origShowSetupWizard = window.showSetupWizard;
  window.showSetupWizard = () => {};
});

const stateAfterLogin = await page.evaluate(() => ({
  userId: typeof S !== 'undefined' ? S?.user?.id?.substring(0,8) : null,
  userRole: typeof S !== 'undefined' ? S?.userRole : null,
  eventsCount: typeof S !== 'undefined' ? S?.events?.length : null,
  planLimits: typeof S !== 'undefined' ? JSON.stringify(S?.planLimits) : null,
  sbType: typeof sb,
  sbHasFrom: typeof sb?.from,
}));
console.log('State after login:', JSON.stringify(stateAfterLogin, null, 2));

// Now trigger wizard manually
await page.evaluate(() => {
  if (typeof window._origShowSetupWizard === 'function') {
    window.showSetupWizard = window._origShowSetupWizard;
    showSetupWizard();
  }
});
await page.waitForTimeout(1000);

const wizVisible = await page.locator('#wizard-modal').isVisible().catch(() => false);
console.log('Wizard visible:', wizVisible);

// Fill wizard step 0
const nameInput = page.locator('#wiz-ev-name');
if (await nameInput.isVisible().catch(() => false)) {
  await nameInput.fill('Debug Test Event');
  await page.waitForTimeout(300);
} else {
  console.log('WARNING: wiz-ev-name not visible!');
}

const wizNameValue = await page.evaluate(() => document.getElementById('wiz-ev-name')?.value);
console.log('wizard name value:', wizNameValue);

// Monkey-patch wizNext to intercept the insert call and trace exactly what happens
await page.evaluate(() => {
  const origWizNext = window.wizNext;
  window.wizNext = async function() {
    console.log('[WIZNEXT] called, _wizStep =', _wizStep);
    const name = document.getElementById('wiz-ev-name')?.value?.trim();
    console.log('[WIZNEXT] name value =', JSON.stringify(name));
    const date = document.getElementById('wiz-ev-date')?.value;
    console.log('[WIZNEXT] date value =', JSON.stringify(date));
    const tz = document.getElementById('wiz-ev-tz')?.value;
    console.log('[WIZNEXT] tz value =', JSON.stringify(tz));
    console.log('[WIZNEXT] S.user.id =', S?.user?.id?.substring(0,8));
    console.log('[WIZNEXT] sb type =', typeof sb, 'sb.from type =', typeof sb?.from);

    // Test the insert directly
    try {
      console.log('[WIZNEXT] attempting insert...');
      const result = await sb.from('leod_events').insert({
        name: name || 'Fallback Test Event',
        date: date || '2026-04-15',
        timezone: tz || 'Europe/London',
        event_start: '09:00:00',
        event_end: '18:00:00',
        active: true,
        created_by: S.user?.id
      }).select().single();
      console.log('[WIZNEXT] insert result:', JSON.stringify({ data: result.data ? { id: result.data.id, name: result.data.name } : null, error: result.error ? { message: result.error.message, code: result.error.code, details: result.error.details, hint: result.error.hint } : null }));
    } catch (e) {
      console.log('[WIZNEXT] insert THREW:', e.message, e.stack?.split('\n').slice(0,2).join(' | '));
    }

    return origWizNext.apply(this, arguments);
  };
  console.log('[PATCH] wizNext patched');
});

// Click Next
const nextBtn = page.locator('#wiz-next');
await nextBtn.click();
console.log('Clicked wizard Next');

// Wait for all async to complete
await page.waitForTimeout(5000);

const finalState = await page.evaluate(() => ({
  wizStep: typeof _wizStep !== 'undefined' ? _wizStep : 'undef',
  wizErrorMsg: document.getElementById('wiz-error')?.textContent,
  wizErrorDisplay: document.getElementById('wiz-error')?.style?.display,
  wizDisplay: document.getElementById('wizard-modal')?.style?.display,
  eventsCount: typeof S !== 'undefined' ? S?.events?.length : 'undef',
  addBtnExists: !!document.querySelector('button[onclick="openSessModal(\'add\')"]'),
}));
console.log('Final state:', JSON.stringify(finalState, null, 2));

await browser.close();
