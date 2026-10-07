// tests/e2e/console-timeline.spec.ts
// Spec 2.5: 40 px lanes, "HH:MM Title" labels, NOW -1 h to +3 h with Fit day,
// planned outline, overrun hatched, NOW in event-local time, click selects.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID, overrunSessions } from './console-boot-mock';

test('timeline: 40 px lanes and labels that read HH:MM Title', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  const svgH = await page.locator('#timeline-wrap svg.tl-svg').getAttribute('height');
  expect(Number(svgH)).toBe(24 + 2 * 40 + 20);
  // The label is fitted to its bar (Task 1.3: cut with an ellipsis, never past the bar),
  // so it reads "11:30 Panel..." and is a prefix of the full "HH:MM Title".
  const full = '11:30 Panel: Airport Retail in Cairo, Casablanca and Tunis';
  const label = (await page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-bar-label`).textContent()) || '';
  expect(label).toMatch(/^11:30 Panel/);
  expect(full.startsWith(label.replace(/…$/, ''))).toBe(true);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"]`)).toHaveAttribute('aria-label', full);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"] title`)).toContainText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await ctx.close();
});

test('timeline: opens at NOW -1 h to +3 h; Fit day shows the whole day', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator(`.tl-item[data-sid="${ID(1)}"]`)).toHaveCount(0);   // 09:30 keynote is outside 10:40 to 14:40
  const labels = await page.locator('.tl-time-label').allTextContents();
  expect(labels[0]).toBe('11:00');
  expect(labels[labels.length - 1]).toBe('14:30');
  await page.locator('#timeline-wrap button[aria-pressed]').click();
  await expect(page.locator(`.tl-item[data-sid="${ID(1)}"]`)).toHaveCount(1);
  await ctx.close();
});

test('timeline: planned time is an outline when it differs; overrun is hatched', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions() });
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-planned`)).toHaveCount(1);
  await expect(page.locator(`.tl-item[data-sid="${ID(6)}"] .tl-planned`)).toHaveCount(1);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-over`)).toHaveCount(1);
  expect(await page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-over`).getAttribute('fill')).toBe('url(#tl-hatch)');
  await ctx.close();
});

test('timeline: the NOW line is in event-local time (browser UTC, event Cairo)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  const xs = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll('.tl-time-label')].map(t => [t.textContent, Number(t.getAttribute('x'))]);
    const now = Number(document.querySelector('.tl-now-line')!.getAttribute('x1'));
    return { t1130: ticks.find(t => t[0] === '11:30')![1] as number, t1200: ticks.find(t => t[0] === '12:00')![1] as number, now };
  });
  expect(xs.now).toBeGreaterThan(xs.t1130);
  expect(xs.now).toBeLessThan(xs.t1200);
  await ctx.close();
});

test('timeline: clicking a bar selects it in the inspector and the band stays', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-bar`).click();
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  await expect(page.locator('#band')).toBeVisible();
  await expect(page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-bar`)).toHaveClass(/is-selected/);
  await ctx.close();
});

test('timeline: keyboard focus on a bar survives the 1 s re-render', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await page.locator(`.tl-item[data-sid="${ID(6)}"]`).focus();
  await page.clock.runFor(2500);
  expect(await page.evaluate(() => document.activeElement?.closest('.tl-item')?.getAttribute('data-sid'))).toBe(ID(6));
  await page.keyboard.press('Enter');
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Digital Pre-Order and Click & Collect at the Gate');
  await ctx.close();
});
