// tests/e2e/console-stage-review.spec.ts
// Stage 3 whole-stage review fixes: Escape keeps filters while closing a
// popover, move-based action colours in the drawer and sidebar, the delay chip
// in the timeline view, armed forward batch keeps its colour, language on the
// phone menu, RTL-aware live wash and action gap.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID } from './console-boot-mock';

const GREEN = 'rgb(52, 211, 153)';   // --st-ready
const bg = (page: import('@playwright/test').Page, sel: string) =>
  page.locator(sel).first().evaluate(el => getComputedStyle(el).backgroundColor);

test('review: Escape closes an open popover and keeps the filters; a second Escape clears them', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await evalPage(page, `F.room = 'Hall B'; buildFilterBar(); renderSessions();`);
  expect(await evalPage(page, 'F.status')).toBe('ACTIVE');
  await page.locator('#conn-pill').click();
  await expect(page.locator('#sys-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sys-pop')).toBeHidden();
  expect(await evalPage(page, '[F.status, F.room]')).toEqual(['ACTIVE', 'Hall B']);
  await page.keyboard.press('Escape');                                                               // nothing open: clears as before
  expect(await evalPage(page, '[F.status, F.room]')).toEqual(['', '']);
  await ctx.close();
});

test('review: backward moves are never green in the inspector', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // CALLING #4: "Back to ready" (CALLING to READY) is secondary; "On stage" stays green.
  // Stage 4: every control of the selected session sits in the inspector (5.2b: all sections shown).
  await evalPage(page, `S.selectedId = '${ID(4)}'; renderSessions();`);
  const drawer = '#ctx-wrap #ctx-actions';
  expect(await bg(page, `${drawer} button[onclick*="'READY'"]`)).not.toBe(GREEN);
  expect(await bg(page, `${drawer} button[onclick*="'LIVE'"]`)).toBe(GREEN);
  await ctx.close();

  // HOLD #2: "Back to ready" (HOLD to READY) is secondary; "Resume" stays green.
  const b = await openConsole(browser);
  await evalPage(b.page, `S.selectedId = '${ID(2)}'; renderSessions();`);
  const d2 = '#ctx-wrap #ctx-actions';
  expect(await bg(b.page, `${d2} button[onclick*="'READY'"]`)).not.toBe(GREEN);
  expect(await bg(b.page, `${d2} button[onclick*="'LIVE'"]`)).toBe(GREEN);
  await b.ctx.close();
});

test('review: the delay chip follows the delays in the timeline view', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator('#delay-strip')).toContainText('Running +5 min');
  await evalPage(page, `S.sessions.forEach(s => { s.cumulative_delay = 0; s.delay_minutes = 0; }); renderSessions();`);
  await expect(page.locator('#delay-strip')).toBeHidden();
  await evalPage(page, `S.sessions.find(s => s.id === '${ID(6)}').cumulative_delay = 10; renderSessions();`);
  await expect(page.locator('#delay-strip')).toContainText('Running +10 min');
  await ctx.close();
});

test('review: an armed batch SET READY keeps its green with an armed ring; END ALL arms solid red', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(6)}`).hover();
  await page.locator(`#card-${ID(6)} .batch-chk`).check();
  const ready = page.locator('#batch-bar [data-batch="READY"]');
  await ready.click();
  await expect(ready).toHaveText(/\?$/);                                                             // the confirm label
  expect(await bg(page, '#batch-bar [data-batch="READY"]')).toBe(GREEN);
  expect(await ready.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  const end = page.locator('#batch-bar [data-batch="ENDED"]');
  await end.click();
  await expect(end).toHaveClass(/confirm-pending/);
  await expect.poll(() => bg(page, '#batch-bar [data-batch="ENDED"]')).toBe('rgb(239, 68, 68)');   // after the .12s colour transition
  await ctx.close();
});

test('review: the phone menu offers the language choice', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 390, height: 844 }, touch: true });
  await page.locator('#hamburger-btn').click();
  const sel = page.locator('#mobile-menu #mm-lang');
  await expect(sel).toBeVisible();
  expect(await sel.inputValue()).toBe('en');
  expect(await sel.locator('option').allTextContents()).toEqual(['EN', 'AR', 'PL', 'DE']);
  await ctx.close();
});

test('review: in Arabic the live wash starts at the inline start and the action gap sits at the inline start', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { locale: 'ar' });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  expect(await page.locator(`#card-${PANEL_ID}`).evaluate(el => getComputedStyle(el).backgroundImage)).toContain('to left');
  // Stage 4: the drawer is gone; the band's gap carries the same rule, and the inspector puts End at the inline end.
  expect(await page.locator('#band .lane[data-room="Main Stage"] .lane-now .act-gap').evaluate(el => [getComputedStyle(el).marginRight, getComputedStyle(el).marginLeft])).toEqual(['12px', '0px']);
  const hold = (await page.locator('#ctx-wrap .insp-primary .hold').boundingBox())!, end = (await page.locator('#ctx-wrap .insp-primary .btn.danger').boundingBox())!;
  expect(end.x + end.width).toBeLessThan(hold.x);
  await ctx.close();
});
