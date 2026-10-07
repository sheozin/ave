// tests/e2e/console-header.spec.ts
// Spec 2 and 2.4: one 52 px header, top chrome at most 100 px, keyboard
// event switcher, system pill naming what failed, crew, View as for
// directors only, account menu with Tools, banner that collapses to a chip.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

test('header: one 52 px bar, no diagnostics strip or role bar, top chrome at most 100 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#diag-bar')).toHaveCount(0);
  await expect(page.locator('#role-bar')).toHaveCount(0);
  expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(52);
  const banner = (await page.locator('#bc-banner').boundingBox())?.height ?? 0;
  const fb = (await page.locator('#filter-bar').boundingBox())!;
  // Top chrome in stage 3 = header + filter row, banner excluded (spec: at most 100 px).
  expect(fb.y + fb.height - banner).toBeLessThanOrEqual(100);
  expect(await page.locator('#header').evaluate(el => /\p{Extended_Pictographic}/u.test(el.textContent || ''))).toBe(false);
  await ctx.close();
});

test('header: the event switcher is a keyboard button with date and time zone', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#ev-switch')).toHaveJSProperty('tagName', 'BUTTON');
  await expect(page.locator('#event-name')).toHaveText('GTR North Africa 2026');
  await expect(page.locator('#event-sub')).toHaveText('Tue 6 Oct · Cairo UTC+3');
  await page.locator('#ev-switch').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ev-pill-dd')).toHaveClass(/open/);
  await expect(page.locator('#ev-switch')).toHaveAttribute('aria-expanded', 'true');
  await ctx.close();
});

test('header: the system pill says All systems, names a failing check, and its popover holds the diagnostics', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#conn-lbl')).toHaveText('All systems');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-ok/);
  await page.locator('#conn-pill').click();
  await expect(page.locator('#sys-pop')).toBeVisible();
  await expect(page.locator('#dl-db')).toBeVisible();
  await expect(page.locator('#ck-off')).toBeVisible();
  await evalPage(page, `S.rtStatus = 'error'; refreshDiag();`);
  await expect(page.locator('#conn-lbl')).toHaveText('Realtime not working');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-err/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sys-pop')).toBeHidden();
  await ctx.close();
});

test('header: crew pill counts roles online and lists the same people', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#crew-count')).toHaveText('Crew 3/5');
  await page.locator('#crew-pill').click();
  await expect(page.locator('#crew-list')).toContainText('Ahmed Fawzy');
  // The list shows exactly the roles the count counts (PRESENCE_ROLES); signage is in neither.
  await expect(page.locator('#crew-list li')).toHaveCount(3);
  await expect(page.locator('#crew-list')).not.toContainText('Bassem Lotfy');
  await ctx.close();
});

test('header: a director switches role from View as', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#viewas-btn')).toBeVisible();
  await page.locator('#viewas-btn').click();
  await page.locator('.rbtn[data-role="signage"]').click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  await expect(page.locator('#viewas-lbl')).toHaveText(/signage/i);
  await ctx.close();
});

test('header: a stage operator sees their role, not the View as menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await expect(page.locator('#viewas-btn')).toBeHidden();
  await expect(page.locator('#role-lock')).toBeVisible();
  await expect(page.locator('#role-lock')).toHaveText(/stage/i);
  await ctx.close();
});

test('header: AI tools live in the account menu under Tools, never next to show controls', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#sidebar .sb-action-btn')).toHaveCount(0);
  const outside = await page.locator('[onclick*="CueDeckIncidentAdvisor.trigger"]').evaluateAll(els => els.filter(e => !e.closest('#profile-panel')).length);
  expect(outside).toBe(0);
  await page.locator('#user-chip').click();
  await expect(page.locator('#ai-agents-wrap')).toBeVisible();
  await expect(page.locator('#ai-agents-wrap button')).toHaveCount(3);
  for (const id of ['#checkin-btn', '#users-btn', '#lang-switcher', '#auto-start-btn']) await expect(page.locator(id)).toBeVisible();
  await ctx.close();
});

test('header: the broadcast banner is 28 px and collapses to a header chip once read', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(Math.round((await page.locator('#bc-banner').boundingBox())!.height)).toBe(28);
  await expect(page.locator('#bc-banner')).toContainText('11:32');
  await page.locator('#bc-banner .bc-dismiss').click();
  await expect(page.locator('#bc-banner')).toBeHidden();
  await expect(page.locator('#bc-chip')).toBeVisible();
  await page.locator('#bc-chip').click();
  await expect(page.locator('#bc-banner')).toBeVisible();
  await ctx.close();
});

test('header: a critical broadcast needs a second press through the shared arm; info sends on the first', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const writes: string[] = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/leod_broadcast') && r.method() !== 'GET') writes.push(r.method()); });
  const send = page.locator('#bc-send');
  await page.locator('#bc-input').fill('Evacuate Hall B');
  await page.locator('#bc-pri').selectOption('critical');
  await send.click();
  await expect(send).toHaveClass(/confirm-pending/);
  await expect(send).toHaveText('Press again to send');
  await expect(page.locator('#sr-announcer')).toHaveText('Press again to send');   // announced like End and Cancel
  expect(writes).toEqual([]);
  await page.clock.runFor(1500);                                                  // survives the 1 s re-render
  await expect(send).toHaveClass(/confirm-pending/);
  await send.click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(send).toHaveText('Send');
  // An arm that is not confirmed lapses after 3 s and sends nothing.
  await page.locator('#bc-input').fill('Evacuate Hall C');
  await send.click();
  await page.clock.runFor(3500);
  await expect(send).not.toHaveClass(/confirm-pending/);
  await expect(send).toHaveText('Send');
  expect(writes.length).toBe(1);
  await page.locator('#bc-input').fill('Doors open');
  await page.locator('#bc-pri').selectOption('info');
  await page.locator('#bc-input').press('Enter');
  await expect.poll(() => writes.length).toBe(2);
  await ctx.close();
});

test('header: the clock is 26 px bold and tabular, as in the approved demo (spec 9)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const st = await page.locator('#hdr-clock').evaluate(el => { const c = getComputedStyle(el); return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight), num: c.fontVariantNumeric }; });
  expect(st.size).toBeGreaterThanOrEqual(26);
  expect(st.weight).toBeGreaterThanOrEqual(700);
  expect(st.num).toContain('tabular-nums');
  await ctx.close();
});
