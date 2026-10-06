// tests/e2e/console-toast.spec.ts
// Toasts leave the screen after their delay, with or without reduced motion.
// Under reduced motion no exit animation runs, so removal cannot wait for
// animationend: before this fix every toast stayed on screen for good.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

for (const pref of ['no-preference', 'reduce'] as const) {
  test(`a toast is removed after its delay (${pref})`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { reducedMotion: pref });
    await evalPage(page, `pushToast('Saved', 'info')`);
    await expect(page.locator('#toast-container .toast')).toHaveCount(1);
    await page.clock.runFor(2000 + 1000); // info delay, plus room for the exit animation
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
    await ctx.close();
  });
}
