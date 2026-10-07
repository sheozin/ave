// tests/e2e/console-toast.spec.ts
// Toasts leave the screen after their delay, with or without reduced motion.
// Under reduced motion no exit animation runs, so removal cannot wait for
// animationend: before this fix every toast stayed on screen for good.
// Without the preference the toast must play its exit animation first, so an
// instant removal fails the first case too.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

// Read in one evaluate straight after the timer fires: the 150 ms exit
// animation runs on the real clock, the page clock is frozen.
const toastState = (page: import('@playwright/test').Page) => page.evaluate(() =>
  [...document.querySelectorAll('#toast-container .toast')].map(t => t.className));

test('a toast plays its exit animation after its delay, then leaves (no-preference)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { reducedMotion: 'no-preference' });
  await evalPage(page, `pushToast('Saved', 'info')`);
  await expect(page.locator('#toast-container .toast')).toHaveCount(1);
  await page.clock.runFor(1999);
  expect(await toastState(page)).toEqual([expect.not.stringContaining('toast-out')]);
  await page.clock.runFor(1);                     // the 2000 ms info delay
  expect(await toastState(page)).toEqual([expect.stringContaining('toast-out')]);
  await expect(page.locator('#toast-container .toast')).toHaveCount(0);
  await ctx.close();
});

test('a toast leaves at once after its delay (reduce)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { reducedMotion: 'reduce' });
  await evalPage(page, `pushToast('Saved', 'info')`);
  await expect(page.locator('#toast-container .toast')).toHaveCount(1);
  await page.clock.runFor(1999);
  expect(await toastState(page)).toHaveLength(1);
  await page.clock.runFor(1);
  expect(await toastState(page)).toEqual([]);
  await ctx.close();
});
