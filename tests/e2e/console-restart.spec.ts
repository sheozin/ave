// tests/e2e/console-restart.spec.ts
// The Restart button on a session card: shown only once a session has
// started, asks in the console's own modal, and on confirm calls
// restart-session with the session id and version. No auth: the director
// state is injected and every Edge Function call is intercepted.
import { test, expect, type Page } from '@playwright/test';

// CONSOLE_BASE points the spec at another server when 7230 serves a different checkout.
const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
const STARTED = '11111111-1111-4111-8111-111111111111';
const PLANNED = '22222222-2222-4222-8222-222222222222';
const ENDED = '33333333-3333-4333-8333-333333333333';

async function setup(page: Page, role = 'director') {
  const calls: { fn: string; body: any }[] = [];
  await page.route('**/functions/v1/**', async route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop()!;
    calls.push({ fn, body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'READY', version: 6 }) });
  });
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  });
  await page.evaluate(([role, a, b, c]) => {
    // S is a top-level const in the page script, reachable through indirect eval.
    (0, eval)(`
      S.userRole = ${JSON.stringify(role)};
      S.role     = ${JSON.stringify(role)};
      S.viewMode = 'list';
      S.event    = { id: 'ev-1', name: 'Test Event' };
      S.sessions = [
        { id: '${a}', event_id: 'ev-1', sort_order: 1, title: "Chair's opening remarks", status: 'READY', version: 5,
          actual_start: '2026-10-05T10:28:00Z', actual_end: null,
          scheduled_start: '10:30', scheduled_end: '10:45', planned_start: '10:30', planned_end: '10:45' },
        { id: '${b}', event_id: 'ev-1', sort_order: 2, title: 'Keynote', status: 'PLANNED', version: 1,
          actual_start: null, actual_end: null,
          scheduled_start: '11:00', scheduled_end: '11:30', planned_start: '11:00', planned_end: '11:30' },
        { id: '${c}', event_id: 'ev-1', sort_order: 3, title: 'Panel', status: 'ENDED', version: 9,
          actual_start: '2026-10-05T09:00:00Z', actual_end: '2026-10-05T09:40:00Z',
          scheduled_start: '09:00', scheduled_end: '09:40', planned_start: '09:00', planned_end: '09:40' },
      ];
      renderSessions();
    `);
  }, [role, STARTED, PLANNED, ENDED]);
  return calls;
}

const restartBtn = (page: Page, id: string) => page.locator(`#card-${id} [data-restart]`);

test('the Restart button shows on started sessions and not on a planned one', async ({ page }) => {
  await setup(page);
  await expect(restartBtn(page, STARTED)).toBeVisible();
  await expect(restartBtn(page, ENDED)).toBeVisible();
  await expect(restartBtn(page, PLANNED)).toHaveCount(0);
});

test('a role that cannot set READY gets no Restart button', async ({ page }) => {
  await setup(page, 'av');
  await expect(page.locator('[data-restart]')).toHaveCount(0);
});

test('confirm calls restart-session with the session id and version', async ({ page }) => {
  const calls = await setup(page);
  await restartBtn(page, STARTED).click();
  const modal = page.locator('#restart-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Restart this session?');
  await expect(modal).toContainText('It goes back to READY and its timer starts again from the full length when you go live.');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/restart-session'));
  await page.locator('#restart-modal-yes').click();
  await sent;
  await expect(modal).toBeHidden();
  const restart = calls.filter(c => c.fn === 'restart-session');
  expect(restart).toHaveLength(1);
  expect(restart[0].body).toMatchObject({ session_id: STARTED, version: 5, operator_role: 'director' });
  expect(typeof restart[0].body.command_id).toBe('string');
  // The card reflects the restart: no actual_start, so no Restart button.
  await expect(restartBtn(page, STARTED)).toHaveCount(0);
});

test('cancel closes the modal and calls nothing', async ({ page }) => {
  const calls = await setup(page);
  await restartBtn(page, ENDED).click();
  await expect(page.locator('#restart-modal')).toBeVisible();
  await page.locator('#restart-modal-no').click();
  await expect(page.locator('#restart-modal')).toBeHidden();
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.fn === 'restart-session')).toEqual([]);
});

test('Escape closes the modal and calls nothing', async ({ page }) => {
  const calls = await setup(page);
  await restartBtn(page, ENDED).click();
  await expect(page.locator('#restart-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#restart-modal')).toBeHidden();
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.fn === 'restart-session')).toEqual([]);
});
