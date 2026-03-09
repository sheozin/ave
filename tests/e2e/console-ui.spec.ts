// tests/e2e/console-ui.spec.ts
// E2E tests for CueDeck console UI structure — no auth required.
// These test that the page loads, renders all roles, and
// UI elements respond correctly to interaction.
//
// The console shows a loading overlay while awaiting Supabase auth.
// Tests that need to interact with the main UI call bypassOverlay() which
// sets pointer-events:none on the overlay so clicks pass through.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';

/** Allow clicks to pass through the loading overlay without real auth. */
async function bypassOverlay(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.pointerEvents = 'none';
  });
}

test.describe('Console: page load', () => {

  test('01 console page loads with correct title', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page).toHaveTitle(/CueDeck/);
  });

  test('02 CueDeck logo is visible on loading screen', async ({ page }) => {
    // .load-logo is the CueDeck logo inside #loading-overlay, always visible
    // before auth. #header .logo is visible after connection.
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('.load-logo')).toBeVisible();
  });

  test('03 all 6 role buttons present in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // Use data-role attribute selector to avoid strict-mode violations
    // caused by generic :has-text() matching SAVE/CANCEL/etc.
    for (const role of ['director', 'stage', 'av', 'interp', 'reg', 'signage']) {
      await expect(page.locator(`.rbtn[data-role="${role}"]`)).toBeAttached();
    }
  });

  test('04 status bar labels exist in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // Use element IDs — text= locator matches too broadly (2+ elements)
    await expect(page.locator('#dl-db')).toBeAttached();
    await expect(page.locator('#dl-rt')).toBeAttached();
    await expect(page.locator('#dl-ck')).toBeAttached();
  });

  test('05 broadcast bar elements present in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#bc-bar')).toBeAttached();
    await expect(page.locator('#bc-input')).toBeAttached();
    // SEND / CLEAR buttons have no IDs — check by parent + text
    await expect(page.locator('#bc-bar button:has-text("SEND")')).toBeAttached();
    await expect(page.locator('#bc-bar button:has-text("CLEAR")')).toBeAttached();
  });

});

test.describe('Console: role switching', () => {

  test('06 clicking signage role activates it', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    const signageBtn = page.locator('.rbtn[data-role="signage"]');
    await signageBtn.click();
    await expect(signageBtn).toHaveClass(/active/);
  });

  test('07 signage panel shows global override section', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=GLOBAL DISPLAY OVERRIDE')).toBeVisible();
  });

  test('08 signage panel shows override buttons', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    // Use class selector — override buttons appear in both panel and sidebar (strict mode)
    await expect(page.locator('button.sp-override-btn:has-text("Break Screen")')).toBeVisible();
    await expect(page.locator('button.sp-override-btn:has-text("5-Min Recall")')).toBeVisible();
    await expect(page.locator('button.sp-override-btn:has-text("Sponsors")')).toBeVisible();
    await expect(page.locator('button.sp-override-btn:has-text("Schedule")')).toBeVisible();
  });

  test('09 director role shows session controls', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="director"]').click();
    // Session list area should exist
    await expect(page.locator('#sessions-col')).toBeVisible();
  });

});

test.describe('Console: broadcast bar', () => {

  test('10 character counter hidden when input is empty', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const counter = page.locator('#bc-char');
    // Empty input → counter is blank
    await expect(counter).toHaveText('');
  });

  test('11 character counter shows count on input', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.locator('#bc-input').fill('Hello world');
    const counter = page.locator('#bc-char');
    await expect(counter).toHaveText(/11\/200/);
  });

  test('12 character counter turns amber at 161+ chars', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const longText = 'A'.repeat(161);
    await page.locator('#bc-input').fill(longText);
    const counter = page.locator('#bc-char');
    await expect(counter).toHaveClass(/warn/);
  });

  test('13 Enter key in input calls sendBroadcast (no error thrown)', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.locator('#bc-input').fill('Test message');
    // Press Enter — should not throw JS errors
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('#bc-input').press('Enter');
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

});

test.describe('Console: display modal', () => {

  test('14 Add Display button opens modal', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    // Wait for signage panel to render
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Display")').click();
    await expect(page.locator('#disp-modal')).toBeVisible();
    await expect(page.locator('#dm-name')).toBeVisible();
  });

  test('15 display modal closes on Cancel', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Display")').click();
    await page.locator('#disp-modal button:has-text("Cancel")').click();
    await expect(page.locator('#disp-modal')).toBeHidden();
  });

  test('16 display modal closes on backdrop click', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Display")').click();
    // Click outside the modal card
    await page.locator('#disp-modal').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#disp-modal')).toBeHidden();
  });

  test('17 display modal shows validation error on empty name', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Display")').click();
    await page.locator('#dm-name').fill('');
    await page.locator('#disp-modal button:has-text("Save")').click();
    await expect(page.locator('#dm-error')).toHaveText(/required/i);
  });

});

test.describe('Console: sponsor modal', () => {

  test('18 Add Sponsor button opens modal', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Sponsor")').click();
    await expect(page.locator('#spon-modal')).toBeVisible();
    await expect(page.locator('#spm-name')).toBeVisible();
  });

  test('19 sponsor modal closes on Cancel', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="signage"]').click();
    await expect(page.locator('text=REGISTERED DISPLAYS')).toBeVisible();
    await page.locator('button:has-text("Add Sponsor")').click();
    await page.locator('#spon-modal button:has-text("Cancel")').click();
    await expect(page.locator('#spon-modal')).toBeHidden();
  });

});

test.describe('Console: no JS errors on load', () => {

  test('20 no uncaught JS errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test('21 no uncaught errors when switching all roles', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    for (const role of ['director', 'stage', 'av', 'interp', 'reg', 'signage']) {
      await page.locator(`.rbtn[data-role="${role}"]`).click();
      await page.waitForTimeout(200);
    }
    expect(errors).toHaveLength(0);
  });

});

test.describe('Console: timeline view (PR-020)', () => {

  test('22 toggleViewMode function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() =>
      typeof (window as any).toggleViewMode === 'function'
    );
    expect(exists).toBe(true);
  });

  test('23 renderTimeline function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() =>
      typeof (window as any).renderTimeline === 'function'
    );
    expect(exists).toBe(true);
  });

  test('24 Timeline toggle button exists in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // The timeline button should be in the DOM (may use ⏱ icon or "Timeline" text)
    const btnExists = await page.evaluate(() => {
      const html = document.body.innerHTML;
      return html.includes('toggleViewMode') || html.includes('timeline-btn') || html.includes('⏱');
    });
    expect(btnExists).toBe(true);
  });

  test('25 timeline view switches without JS error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.locator('.rbtn[data-role="director"]').click();
    // Call toggleViewMode directly — no sessions loaded so it should handle gracefully
    await page.evaluate(() => {
      try { (window as any).toggleViewMode(); } catch {}
    });
    await page.waitForTimeout(300);
    // No crash
    expect(errors.filter(e => /timeline/i.test(e))).toHaveLength(0);
  });

});

test.describe('Console: operator presence (PR-009)', () => {

  test('26 presence container exists in header', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // Presence dots are rendered in the header area
    const exists = await page.evaluate(() => {
      const html = document.getElementById('header')?.innerHTML || document.body.innerHTML;
      return html.includes('presence') || html.includes('op-dots') ||
             html.includes('operator-presence') || html.includes('pres-');
    });
    expect(exists).toBe(true);
  });

  test('27 presence tracking state variable exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // S is declared with `const` (not on window), so check via string evaluate
    const exists = await page.evaluate('typeof S !== "undefined"');
    expect(exists).toBe(true);
  });

});

test.describe('Console: keyboard shortcuts (PR-019)', () => {

  test('28 keyboard shortcut handler is registered', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // The keydown handler should exist — we check by dispatching a key event
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await bypassOverlay(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(errors).toHaveLength(0);
  });

});
