// tests/e2e/console-inspector.spec.ts
// Spec 2.3: inspector defaults to the most urgent session and follows the
// selection; fixed control slots; two-press End that survives re-renders and
// is announced; time row; More menu; log with filters always visible.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID } from './console-boot-mock';

const insp = (page: import('@playwright/test').Page) => page.locator('#ctx-wrap');

test('inspector: defaults to the most urgent session (LIVE before HOLD)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(insp(page).locator('.insp-big')).toHaveText('19:15');
  await expect(insp(page)).toContainText('Dina Farouk (moderator), Karim Benali, Leila Mansour, Omar Haddad');
  await ctx.close();
});

// Controller ruling (fix round 1): the inspector never leaves a session the operator
// selected while it exists in the event, so the control under the pointer never changes.
test('inspector: an overrun flip elsewhere never moves the selected session or its controls', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  await expect(insp(page).locator('.insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  const call = insp(page).locator('.insp-primary .btn', { hasText: 'Call speaker' });
  const before = await call.boundingBox();
  await evalPage(page, `onSessionChange({ eventType: 'UPDATE', new: { ...S.sessions.find(x => x.id === '${PANEL_ID}'), status: 'OVERRUN', version: 99 }, old: {} })`);
  await page.clock.runFor(1100);
  await expect(page.locator(`#card-${PANEL_ID}`)).toHaveClass(/status-OVERRUN/);
  await expect(insp(page).locator('.insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  expect(await call.boundingBox()).toEqual(before);
  // Attention without moving controls: a link in the header names the more urgent session.
  const link = insp(page).locator('.insp-urgent');
  await expect(link).toHaveText('Show #3 (overrun)');
  await link.click();
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await ctx.close();
});

test('inspector: a finished selection stays; a deleted selection falls back to the most urgent', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  await evalPage(page, `S.sessions.find(x => x.id === '${ID(5)}').status = 'CANCELLED'; renderSessions();`);
  await expect(insp(page).locator('.insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  await evalPage(page, `onSessionChange({ eventType: 'DELETE', new: {}, old: { id: '${ID(5)}' } })`);
  await page.clock.runFor(1100);   // the paused test clock: let the realtime render and one tick run
  expect(await evalPage(page, `S.sessions.some(x => x.id === '${ID(5)}')`)).toBe(false);   // a real supabase DELETE (new = {})
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await ctx.close();
});

test('inspector: with nothing selected it follows the most urgent session', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await evalPage(page, `S.sessions.find(x => x.id === '${ID(2)}').status = 'OVERRUN'; renderSessions();`);
  await expect(insp(page).locator('.insp-title')).toHaveText('Workshop: Fragrance & Beauty Category Planning');
  await expect(insp(page).locator('.insp-urgent')).toHaveCount(0);
  await ctx.close();
});

test('inspector: More closes when the operator selects another session', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await insp(page).locator('#insp-more summary').click();
  await expect(insp(page).locator('#insp-more')).toHaveAttribute('open', '');
  await page.locator(`#card-${ID(6)} .sc-title`).click();
  await expect(insp(page).locator('#insp-more')).not.toHaveAttribute('open', '');
  await ctx.close();
});

test('log: kinds match whole action names, not fragments of other words', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(await evalPage(page, `[logKind('DEFAULT'), logKind('FEEDBACK'), logKind('EF'), logKind('DB'), logKind('SESSION_STATUS_CHANGE'), logKind('BOOT')]`))
    .toEqual(['other', 'other', 'state', 'system', 'state', 'system']);
  await ctx.close();
});

test('inspector: Hold left of End, and both keep their place from LIVE to OVERRUN', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const pos = async () => ({
    hold: (await insp(page).locator('.insp-primary .hold').boundingBox())!.x,
    end: (await insp(page).locator('.insp-primary .btn.danger').boundingBox())!.x,
  });
  const live = await pos();
  expect(live.hold).toBeLessThan(live.end);
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').status = 'OVERRUN'; renderSessions();`);
  const overrun = await pos();
  expect(Math.abs(overrun.hold - live.hold)).toBeLessThan(1);
  expect(Math.abs(overrun.end - live.end)).toBeLessThan(1);
  await ctx.close();
});

test('inspector: armed End survives re-renders, is announced, and the second press ends', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const end = insp(page).locator('.insp-primary .btn.danger');
  await end.click();
  await expect(end).toHaveClass(/confirm-pending/);
  await expect(end).toHaveText('Press again to end');
  await expect(page.locator('#sr-announcer')).toHaveText('Press again to end');
  await page.clock.runFor(1500);                       // one and a half ticks of re-rendering
  await expect(insp(page).locator('.insp-primary .btn.danger')).toHaveClass(/confirm-pending/);
  await expect(page.locator(`#band .lane[data-room="Main Stage"] .btn.danger`)).toHaveText('Press again to end');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/end-session'));
  await insp(page).locator('.insp-primary .btn.danger').click();
  await sent;
  await ctx.close();
});

test('inspector: the time row separates this session from every later session', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = insp(page).locator('.insp-time');
  await expect(row).toContainText('This session');
  await expect(row).toContainText('Push following');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/apply-delay'));
  await row.locator('button', { hasText: '+10' }).click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: PANEL_ID, minutes: 10 });
  await ctx.close();
});

test('inspector: More holds restart, arrival, edit, move and a two-press cancel', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await insp(page).locator('#insp-more summary').click();
  for (const sel of ['[data-restart]', '[data-fk="more-arrive"]', '[data-fk="more-edit"]', '[data-fk="more-up"]', '[data-fk="more-down"]']) {
    await expect(insp(page).locator(sel)).toBeVisible();
  }
  await page.locator(`#card-${ID(6)} .sc-title`).click();
  await insp(page).locator('#insp-more summary').click();   // More closes on a new selection (fix round 1)
  const cancel = insp(page).locator('#insp-more .btn.danger');
  await cancel.click();
  await expect(insp(page).locator('#insp-more .btn.danger')).toHaveClass(/confirm-pending/);
  await ctx.close();
});

test('inspector: av sees Hold but never End', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'av' });
  await expect(insp(page).locator('.insp-primary .hold')).toBeVisible();
  await expect(insp(page).locator('.insp-primary .btn.danger')).toHaveCount(0);
  await expect(insp(page).locator('.insp-primary .end-slot')).toHaveCount(1);
  await expect(insp(page).locator('.insp-flags')).toHaveClass(/is-prominent/);
  await ctx.close();
});

test('log: filters, own times, newest first, at least 240 px at 1440x900', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(240);
  const first = page.locator('#log-feed .lg').first();
  await expect(first.locator('.lg-when')).not.toHaveText('');
  await page.locator('.log-chip[data-f="broadcast"]').click();
  await expect(page.locator('.log-chip[data-f="broadcast"]')).toHaveAttribute('aria-pressed', 'true');
  const kinds = await page.locator('#log-feed .lg').evaluateAll(els => [...new Set(els.map(e => e.className))]);
  expect(kinds).toEqual(['lg lg-broadcast']);
  await expect(page.locator('#log-feed')).toContainText('11:32');
  await ctx.close();
});

test('inspector: the final minute shows tenths and the wrap-up colour', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').actual_start = new Date(correctedNow() - (30 * 60_000 - 30_000)).toISOString(); renderSessions();`);
  await page.clock.runFor(400);
  await expect(insp(page).locator('.insp-big')).toHaveText(/^0:(29|30)\.\d$/);
  await expect(insp(page).locator('.insp-count')).toHaveClass(/warn-red/);
  await ctx.close();
});

test('layout: at 1280x720 the armed End label fits its slot in the band and the inspector', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 } });
  await insp(page).locator('.insp-primary .btn.danger').click();
  for (const sel of ['#band .lane[data-room="Main Stage"] .lane-now .btn.danger', '#ctx-wrap .insp-primary .btn.danger']) {
    const b = page.locator(sel);
    await expect(b, sel).toHaveText('Press again to end');
    expect(await b.evaluate(el => el.scrollWidth <= el.clientWidth), `${sel} text clipped`).toBe(true);
  }
  // The 320 px rail also fits a READY session's row (forward action, gap, empty End slot).
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  expect(await insp(page).locator('.insp-primary').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await ctx.close();
});

test('layout: 1280x720 fits the band, six rows and a 200 px log', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 } });
  expect((await page.locator('#sidebar').boundingBox())!.width).toBe(320);
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(200);
  const colBottom = await page.locator('#sessions-col').evaluate(el => el.getBoundingClientRect().bottom);
  const rows = await page.locator('#sessions-list .sc').evaluateAll((els, b) => els.filter(e => e.getBoundingClientRect().bottom <= (b as number)).length, colBottom);
  expect(rows).toBeGreaterThanOrEqual(6);
  for (const lane of await page.locator('#band .lane').all()) {
    const b = (await lane.boundingBox())!;
    expect(Math.round(b.height)).toBeLessThanOrEqual(45);
  }
  await ctx.close();
});

// Owner decision (7 Oct): End is a two-press confirm, and arming it never moves
// Hold or End in any language: each End slot is measured at runtime in the
// rendered font for the longest of its labels, the armed one included.
for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    test(`layout: ${locale} ${viewport.width}: arming End moves neither Hold nor End, and the armed label is whole`, async ({ browser }) => {
      const { ctx, page } = await openConsole(browser, { locale, viewport });
      const sels = {
        band: '#band .lane[data-room="Main Stage"] .lane-now',
        insp: '#ctx-wrap .insp-primary',
      };
      const boxes = async () => {
        const out: Record<string, number[]> = {};
        for (const [k, sel] of Object.entries(sels)) {
          for (const part of ['.hold', '.btn.danger']) {
            const b = (await page.locator(`${sel} ${part}`).boundingBox())!;
            out[`${k} ${part}`] = [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10);
          }
        }
        return out;
      };
      const before = await boxes();
      await page.locator(`${sels.insp} .btn.danger`).click();
      const armedLabel = await evalPage(page, `t('confirm.confirmEnd')`) as string;
      for (const sel of Object.values(sels)) {
        const b = page.locator(`${sel} .btn.danger`);
        await expect(b).toHaveClass(/confirm-pending/);
        await expect(b).toHaveText(armedLabel);
        expect(await b.evaluate(el => el.scrollWidth <= el.clientWidth), `${sel} armed label clipped`).toBe(true);
      }
      expect(await boxes()).toEqual(before);
      // Nothing in the inspector's rows runs past the rail.
      const over = await page.locator('#ctx-wrap .insp-row').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
      expect(over).toEqual([]);
      await ctx.close();
    });
  }
}

test('log: rows read as plain words, never raw JSON or the database action name', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const feed = page.locator('#log-feed');
  await expect(feed).not.toContainText('SESSION_STATUS_CHANGE');
  await expect(feed).not.toContainText('{');
  await expect(feed).not.toContainText('→');
  await expect(feed.locator('.lg', { hasText: '#2 Workshop' }).first()).toContainText('live to hold');
  await expect(feed.locator('.lg.lg-delay').first()).toContainText('+5 min');
  await ctx.close();
});
