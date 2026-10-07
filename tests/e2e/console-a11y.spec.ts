// tests/e2e/console-a11y.spec.ts
// Spec section 5 plus the review-focus cases: skip link, tab order, names on
// icon buttons, toggle state, target sizes, reduced motion, Arabic layout,
// and that no visible control text is written in capitals.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, overrunSessions, manySessions, ID } from './console-boot-mock';

test('a11y: the skip link is the first stop and leads to the band', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('band');
  await ctx.close();
});

test('a11y: the band keeps focus through its 1 s re-render', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.clock.runFor(3_000);                          // three ticks, each redraws the band
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('band');
  await ctx.close();
});

test('a11y: with no band, the skip link lands on the list', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: [] });
  expect(await page.locator('#band').isHidden()).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('sessions-list');
  await ctx.close();
});

test('a11y: a long list still opens on the first open session and Tab still starts at the skip link', async ({ browser }) => {
  // The opening scroll used scrollIntoView, which also moved Chrome's Tab
  // starting point into the list, so the first Tab skipped the skip link.
  const { ctx, page } = await openConsole(browser, { sessions: manySessions(), viewport: { width: 1280, height: 600 } });
  const vis = await page.evaluate(() => {
    const box = document.getElementById('sessions-col')!.getBoundingClientRect();
    const card = document.querySelector('#sessions-list .sc:not(.status-ENDED):not(.status-CANCELLED)')!.getBoundingClientRect();
    return card.top >= box.top - 1 && card.bottom <= box.bottom + 1;
  });
  expect(vis).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await ctx.close();
});

test('a11y: tab order runs header, band, filters, list, inspector, broadcast', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const seen: string[] = [];
  for (let i = 0; i < 160 && seen[seen.length - 1] !== 'broadcast'; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return '';
      return el.closest('#header') ? 'header' : el.closest('#band') ? 'band' : el.closest('#filter-bar') ? 'filters'
        : el.closest('#sessions-list') ? 'list' : el.closest('#sidebar') ? 'inspector' : el.closest('#bc-bar') ? 'broadcast' : '';
    });
    if (r && seen[seen.length - 1] !== r) seen.push(r);
  }
  expect(seen).toEqual(['header', 'band', 'filters', 'list', 'inspector', 'broadcast']);
  await ctx.close();
});

test('a11y: every visible icon-only control has a name, and toggles expose their state', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, 'toggleEditMode()');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], a[href], select, input')]
    .filter(el => (el as HTMLElement).offsetParent !== null)
    .filter(el => !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('aria-labelledby') && !(el as HTMLInputElement).placeholder)
    .map(el => el.outerHTML.slice(0, 90)));
  expect(unnamed).toEqual([]);
  for (const sel of ['.fvp-btn', '.log-chip', '#edit-mode-btn']) {
    for (const el of await page.locator(sel).all()) expect(await el.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
  }
  expect(await page.locator('#auto-start-btn').getAttribute('aria-checked')).toMatch(/^(true|false)$/);
  await ctx.close();
});

test('a11y: interactive targets are at least 24 px on desktop', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input:not([type="hidden"]), [role="button"]')]
    .filter(el => (el as HTMLElement).offsetParent !== null)
    .map(el => [el, el.getBoundingClientRect()] as const)
    .filter(([, r]) => r.width > 0 && Math.min(r.width, r.height) < 24)
    .map(([el, r]) => `${el.outerHTML.slice(0, 70)} ${Math.round(r.width)}x${Math.round(r.height)}`));
  expect(small).toEqual([]);
  await ctx.close();
});

test('a11y: reduced motion stops every animation', async ({ browser }) => {
  // Control run: the same state without the preference does animate (CALLING ring,
  // OVERRUN lane, connection lost), so a zero below means the rule worked.
  for (const [pref, check] of [['no-preference', (n: number) => expect(n).toBeGreaterThan(0)], ['reduce', (n: number) => expect(n).toBe(0)]] as const) {
    const { ctx, page } = await openConsole(browser, { sessions: overrunSessions(), reducedMotion: pref });
    await evalPage(page, `S.rtStatus = 'error'; refreshDiag(); renderSessions();`);
    check(await page.evaluate(() => document.getAnimations().length));
    await ctx.close();
  }
});

test('layout: Arabic mirrors the band and keeps End last in reading order', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { locale: 'ar' });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  const lane = page.locator('#band .lane[data-room="Main Stage"] .lane-now');
  const hold = (await lane.locator('.lane-lead').boundingBox())!;
  const end = (await lane.locator('.btn.danger').boundingBox())!;
  expect(end.x).toBeLessThan(hold.x);                       // inline-end is the left edge in RTL
  const title = (await lane.locator('.lane-title').boundingBox())!;
  const ctrl = (await lane.locator('.lane-ctrl').boundingBox())!;
  expect(ctrl.x + ctrl.width).toBeLessThanOrEqual(title.x + 1); // no overlap
  const sw = (await page.locator('#ev-switch').boundingBox())!;
  const clock = (await page.locator('#hdr-clock').boundingBox())!;
  expect(sw.x + sw.width <= clock.x || clock.x + clock.width <= sw.x).toBe(true);
  await ctx.close();
});

test('copy: no visible button, menu item, title or label is written in capitals', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const ACR = /^(AV|CSV|PDF|QR|ID|AI|EN|AR|PL|DE|OK|UTC|VAT|URL|AVE|TV|PIN|SMS|PLANNED|READY|CALLING|LIVE|OVERRUN|HOLD|ENDED|CANCELLED)$/;
  const collect = () => page.evaluate((acr) => {
    const re = new RegExp(acr);
    return [...document.querySelectorAll('button, [role="menuitem"], .ev-modal-title, .lf-title, h2, .lbl, label, .sp-section-title')]
      .filter(el => (el as HTMLElement).offsetParent !== null && !el.closest('.badge'))
      // Copy only: the event name is the customer's data, and a <select> inside a
      // label would read its option codes (EN, AR, ...) run together.
      .map(el => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll('#event-name, select').forEach(n => n.remove()); return (c.textContent || '').trim(); })
      .filter(txt => txt.split(/[\s/·:,.()…+–\-!?]+/).some(w => /^[A-Z]{2,}$/.test(w) && !re.test(w)));
  }, ACR.source);
  const found = new Set<string>(await collect());
  await page.locator('#user-chip').click();
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `closeProfilePanel(); toggleHelpMenu();`);
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `closeHelpMenu(); setRole('signage');`);
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `setRole('director'); openSessModal('add');`);
  (await collect()).forEach(x => found.add(x));
  expect([...found]).toEqual([]);
  await ctx.close();
});

test('layout: the armed broadcast Clear label fits in every language and stays under the pointer', async ({ browser }) => {
  for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { ctx, page } = await openConsole(browser, { locale, viewport });
      if (viewport.width < 600) await evalPage(page, `setPhoneTab('send')`);
      // The second press must land where the first one did. (Send may shift: it
      // sits before Clear and did so with the old "CONFIRM CLEAR" label too.)
      const clear = page.locator('#bc-clear');
      const b = (await clear.boundingBox())!;
      await clear.click();
      await expect(clear).toHaveText(await page.evaluate(() => (0, eval)(`t('confirm.confirmClear')`)));
      const a = (await clear.boundingBox())!;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      expect(cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height, `${locale} ${viewport.width}`).toBe(true);
      const fit = await page.evaluate(() => {
        const b = document.getElementById('bc-clear')!, bar = document.getElementById('bc-bar')!.getBoundingClientRect(), r = b.getBoundingClientRect();
        return { text: b.scrollWidth <= b.clientWidth + 1, inBar: r.left >= bar.left - 1 && r.right <= bar.right + 1, page: document.documentElement.scrollWidth <= innerWidth };
      });
      expect(fit, `${locale} ${viewport.width}`).toEqual({ text: true, inBar: true, page: true });
      await ctx.close();
    }
  }
});
