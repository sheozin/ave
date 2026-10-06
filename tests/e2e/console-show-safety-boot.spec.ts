// tests/e2e/console-show-safety-boot.spec.ts
// Show-safety fixes that need a signed-in boot (2026-10-06 audit): what stage
// and AV operators see by default, the event log staying visible in the
// director sidebar, and boot running once per sign-in. Uses the mocked boot
// harness: no real backend is reached.
import { test, expect } from '@playwright/test';
import { openConsole, ID, EVENT_ID } from './console-boot-harness';

for (const role of ['stage', 'av']) {
  test(`${role} operator sees held, overrun and upcoming sessions by default, not ended or cancelled`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { role });
    try {
      await expect(page.locator('#fb-status')).toHaveValue('ACTIVE');
      const shown = await page.locator('#sessions-list .sc').evaluateAll(els => els.map(e => e.id));
      for (const k of [2, 3, 4, 5, 6]) expect(shown).toContain(`card-${ID(k)}`); // HOLD, OVERRUN, CALLING, READY, PLANNED
      for (const k of [1, 7]) expect(shown).not.toContain(`card-${ID(k)}`);      // ENDED, CANCELLED
    } finally { await ctx.close(); }
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  test(`the director's event log is at least 200 px tall at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { viewport });
    try {
      const h = await page.locator('#log-panel').evaluate(e => e.getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(200);
      // Loaded rows keep their own time, shown in the event's zone (Cairo, UTC+3).
      const row = page.locator('#log-feed .le', { hasText: 'BROADCAST' }).first();
      await expect(row).toContainText('14:32:00');
      await expect(row).toContainText('Hall B on hold: projector signal lost');
    } finally { await ctx.close(); }
  });
}

test('two SIGNED_IN events after boot do not run boot again', async ({ browser }) => {
  const { ctx, page, errors } = await openConsole(browser);
  try {
    const boots = () => page.evaluate(() => (0, eval)('S').log.filter((e: any) => e.action === 'BOOT').length);
    expect(await boots()).toBe(1);
    await page.evaluate(async () => {
      const sbc = (0, eval)('sb');
      const { data } = await sbc.auth.getSession();
      await sbc.auth._notifyAllSubscribers('SIGNED_IN', data.session);
      await sbc.auth._notifyAllSubscribers('SIGNED_IN', data.session);
    });
    await page.waitForTimeout(2000);
    expect(await boots()).toBe(1);
    expect(errors.filter(e => /cannot add/.test(e))).toEqual([]);
  } finally { await ctx.close(); }
});

test('subscribing the signage channel twice replaces it instead of throwing', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  try {
    const res = await page.evaluate(async (ev) => {
      const w = window as any;
      const sbc = (0, eval)('sb');
      try {
        await w.subscribeDisplays(ev);
        await new Promise(r => setTimeout(r, 300));
        await w.subscribeDisplays(ev);
        await new Promise(r => setTimeout(r, 300));
      } catch (e: any) { return { threw: e.message, count: -1 }; }
      return { threw: '', count: sbc.getChannels().filter((c: any) => c.topic === 'realtime:leod-signage').length };
    }, EVENT_ID);
    expect(res).toEqual({ threw: '', count: 1 });
  } finally { await ctx.close(); }
});
