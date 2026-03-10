// tests/e2e/session-management.spec.ts
// E2E tests for session creation, editing, and the empty-state UI.
//
// Structural tests (no live DB): empty state, session modal structure,
//   sidebar scrollability, Add Session button visibility.
// Live DB tests: skipped when TEST_EMAIL / TEST_PASSWORD unset.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e
// For live-DB tests: TEST_EMAIL=... TEST_PASSWORD=... npm run test:e2e

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';

/** Allow clicks through the loading overlay without real auth. */
async function bypassOverlay(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.pointerEvents = 'none';
  });
}

/** Inject a fake director session state and trigger the empty sessions render.
 *
 * S is a top-level `const` in the page's script — NOT a window property — so
 * we access it via eval() which runs in the page's script scope. */
async function injectEmptyDirectorState(page: Page) {
  await page.evaluate(() => {
    // eval() runs in the page's script scope and can read/write the const S
    // and call functions like renderSessions() that close over it.
    // eslint-disable-next-line no-eval
    ;(0, eval)(`
      S.userRole = 'director';
      S.role     = 'director';
      S.sessions = [];
      S.viewMode = 'list';
      S.event    = S.event || { id: 'test-event-id', name: 'Test Event' };
      S.filters  = S.filters || {};
      renderSessions();
    `);
  });
}

// ── SESSION MODAL STRUCTURE (no auth) ──────────────────────────────────────

test.describe('Session modal: structure', () => {

  test('SM01 session modal is present in the DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#sess-modal')).toBeAttached();
  });

  test('SM02 session modal has title input', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#smv-title')).toBeAttached();
    await expect(page.locator('#smv-title')).toHaveAttribute('required', '');
  });

  test('SM03 session modal has planned start and end time inputs', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#smv-start')).toHaveAttribute('type', 'time');
    await expect(page.locator('#smv-end')).toHaveAttribute('type', 'time');
  });

  test('SM04 session modal has type selector with standard options', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const sel = page.locator('#smv-type');
    await expect(sel).toBeAttached();
    for (const opt of ['Keynote', 'Panel', 'Break', 'Workshop', 'Other']) {
      await expect(sel.locator(`option:has-text("${opt}")`)).toBeAttached();
    }
  });

  test('SM05 session modal has room and speaker fields', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#smv-room')).toBeAttached();
    await expect(page.locator('#smv-spk')).toBeAttached();
    await expect(page.locator('#smv-co')).toBeAttached();
  });

  test('SM06 session modal has notes textarea', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const notes = page.locator('#smv-notes');
    await expect(notes).toBeAttached();
    await expect(notes).toHaveAttribute('rows', '3');
  });

  test('SM07 session modal has Save and Cancel buttons', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // Modal actions — use onclick attribute to target specifically
    await expect(page.locator('#sess-modal button.primary')).toBeAttached();
    await expect(page.locator('#sess-modal button[onclick="closeSessModal()"]')).toBeAttached();
  });

  test('SM08 session modal has delete button (hidden by default)', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const del = page.locator('#smv-del');
    await expect(del).toBeAttached();
    // Delete is hidden in add mode — only visible in edit mode
    await expect(del).toHaveCSS('display', 'none');
  });

  test('SM09 openSessModal function is defined globally', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const defined = await page.evaluate(() => typeof (window as any).openSessModal === 'function');
    expect(defined).toBe(true);
  });

  test('SM10 openSessModal opens the modal', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.evaluate(() => (window as any).openSessModal('add'));
    await expect(page.locator('#sess-modal')).toBeVisible();
  });

  test('SM11 closeSessModal hides the modal', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.evaluate(() => (window as any).openSessModal('add'));
    await expect(page.locator('#sess-modal')).toBeVisible();
    await page.evaluate(() => (window as any).closeSessModal());
    await expect(page.locator('#sess-modal')).toBeHidden();
  });

  test('SM12 modal title says "New Session" in add mode', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await page.evaluate(() => (window as any).openSessModal('add'));
    await expect(page.locator('#sess-modal-title')).toHaveText('New Session');
  });

});

// ── EMPTY STATE UI ─────────────────────────────────────────────────────────

test.describe('Session list: empty state', () => {

  test('ES01 empty state renders for director with Add Session button', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await injectEmptyDirectorState(page);
    // Director sees "+ Add Session"
    const addBtn = page.locator('#sessions-list button:has-text("Add Session")');
    await expect(addBtn).toBeVisible({ timeout: 3000 });
  });

  test('ES02 empty state does NOT show raw SQL snippet', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await injectEmptyDirectorState(page);
    const sqlText = await page.locator('#sessions-list pre').count();
    expect(sqlText).toBe(0); // SQL <pre> block must be gone
  });

  test('ES03 empty state shows user-friendly message', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await injectEmptyDirectorState(page);
    await expect(page.locator('#empty h2')).toHaveText('No sessions yet');
  });

  test('ES04 Add Session button in empty state opens modal', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await injectEmptyDirectorState(page);
    const addBtn = page.locator('#sessions-list button:has-text("Add Session")');
    await addBtn.click();
    await expect(page.locator('#sess-modal')).toBeVisible();
  });

  test('ES05 Import CSV button is visible in empty state for director', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);
    await injectEmptyDirectorState(page);
    await expect(page.locator('#sessions-list button:has-text("Import CSV")')).toBeVisible({ timeout: 3000 });
  });

});

// ── SIDEBAR SCROLL ─────────────────────────────────────────────────────────

test.describe('Right sidebar: scrollability', () => {

  test('SB01 sidebar has overflow-y set to auto (not hidden)', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const overflowY = await page.locator('#sidebar').evaluate(
      el => window.getComputedStyle(el).overflowY
    );
    expect(overflowY).toBe('auto');
  });

  test('SB02 sidebar is present and uses flex column layout', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeAttached();
    const display = await sidebar.evaluate(el => window.getComputedStyle(el).display);
    expect(display).toBe('flex');
  });

});

// ── LIVE DB: session creation (skipped when no credentials) ────────────────

const TEST_EMAIL    = process.env.TEST_EMAIL    || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const HAS_LIVE_CREDS = TEST_EMAIL && TEST_PASSWORD;

test.describe('Live: create and delete session', () => {
  test.skip(!HAS_LIVE_CREDS, 'Set TEST_EMAIL and TEST_PASSWORD to run live DB tests');

  test('L01 director can sign in and reach session list', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.fill('#lf-email',    TEST_EMAIL);
    await page.fill('#lf-password', TEST_PASSWORD);
    await page.click('#login-form button[type="submit"]');
    // Wait for loading overlay to disappear
    await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 10000 });
    // Director role bar should be visible
    await expect(page.locator('.rbtn[data-role="director"]')).toBeVisible({ timeout: 5000 });
  });

  test('L02 director can open Add Session modal from sessions view', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.fill('#lf-email',    TEST_EMAIL);
    await page.fill('#lf-password', TEST_PASSWORD);
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 10000 });
    // Open via button click (either empty state or list footer)
    await page.evaluate(() => (window as any).openSessModal('add'));
    await expect(page.locator('#sess-modal')).toBeVisible();
    await expect(page.locator('#sess-modal-title')).toHaveText('New Session');
  });

  test('L03 session modal saves correctly and appears in list', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.fill('#lf-email',    TEST_EMAIL);
    await page.fill('#lf-password', TEST_PASSWORD);
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 10000 });

    await page.evaluate(() => (window as any).openSessModal('add'));
    await page.fill('#smv-title', 'Automated Test Session');
    await page.fill('#smv-start', '10:00');
    await page.fill('#smv-end',   '10:30');
    await page.click('#sess-modal button.primary');

    // Modal should close and new session should appear
    await expect(page.locator('#sess-modal')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#sessions-list')).toContainText('Automated Test Session', { timeout: 5000 });
  });

});
