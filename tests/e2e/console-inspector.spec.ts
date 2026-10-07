// tests/e2e/console-inspector.spec.ts
// Spec 2.3: inspector defaults to the most urgent session and follows the
// selection; fixed control slots; two-press End that survives re-renders and
// is announced; time row; organised sections (5.2b); log with filters always visible.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, afterBootReread, ID, PANEL_ID } from './console-boot-mock';

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

// 5.2b (2), owner-approved mock 7 Oct: the organised inspector replaces the More disclosure.
// Sections in a fixed order, each with a .lbl, only the actions the status allows.
const secLabels = (page: import('@playwright/test').Page) =>
  page.locator('#ctx-wrap .insp-sec > .lbl').allTextContents();

test('inspector: READY shows Next step with Call speaker and Go live now, one Mark arrived, no More', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  await expect(insp(page).locator('.insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  expect(await secLabels(page)).toEqual(['Next step', 'Timing', 'Screens', 'Session']);
  await expect(insp(page).locator('.insp-next > .btn')).toHaveText(['Call speaker', 'Go live now']);
  await expect(insp(page).locator('.insp-next .end-slot, .insp-next .act-gap')).toHaveCount(0);   // no empty End slot or divider
  await expect(insp(page).locator('.who-state')).toHaveText('Not arrived');
  await expect(insp(page).locator('button', { hasText: /Mark arrived|Mark not arrived/ })).toHaveCount(1);
  await expect(insp(page).locator('[data-fk="insp-arrive"]')).toHaveText('Mark arrived');
  await expect(insp(page).locator('#insp-more, details, summary')).toHaveCount(0);
  await expect(insp(page).getByText('More', { exact: true })).toHaveCount(0);
  expect(await evalPage(page, `'inspMoreOpen' in S`)).toBe(false);
  // Session: edit, move and back to planned; Cancel on its own line at the end edge
  for (const label of ['Edit', 'Move up', 'Move down', 'Back to planned']) {
    await expect(insp(page).locator('.insp-session').getByRole('button', { name: label, exact: true })).toHaveCount(1);   // arrows by aria-label
  }
  await ctx.close();
});

test('inspector: LIVE shows Control with Hold and End, Timing with -1/+1 and Push following', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(await secLabels(page)).toEqual(['Control', 'Timing', 'Screens', 'Session']);
  const control = insp(page).locator('.insp-sec', { has: page.locator('.insp-primary') });
  await expect(control.locator('.lbl')).toHaveText('Control');
  await expect(control.locator('.insp-primary .hold')).toHaveText('Hold');
  await expect(control.locator('.insp-primary .btn.danger')).toHaveText('End…');
  const timing = insp(page).locator('.insp-time');
  await expect(timing).toContainText('This session');
  await expect(timing.locator('button')).toHaveText(['−1 min', '+1 min', '+5', '+10', '+15']);
  await expect(timing).toContainText('Push following');
  await expect(insp(page).locator('.insp-monitor .btn')).toHaveText(['Stage monitor', 'Stage timer']);
  await expect(insp(page).locator('.insp-session .btn', { hasText: 'Restart' })).toHaveCount(1);
  await expect(insp(page).locator('.who-state')).toHaveText('Arrived');
  await ctx.close();
});

test('inspector: Cancel session sits alone at the end edge and needs two presses', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const calls: string[] = [];
  page.on('request', r => { if (r.url().includes('/functions/v1/')) calls.push(new URL(r.url()).pathname.split('/').pop()!); });
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  const cancel = insp(page).locator('.insp-cancel .btn.danger');
  await expect(cancel).toHaveText('Cancel session');
  const geo = await insp(page).locator('.insp-session').evaluate(el => {
    const c = el.querySelector('.insp-cancel .btn')!.getBoundingClientRect();
    const others = [...el.querySelectorAll('.btn')].filter(b => !b.closest('.insp-cancel')).map(b => b.getBoundingClientRect());
    return { right: c.right, top: c.top, rowRight: el.getBoundingClientRect().right, othersBottom: Math.max(...others.map(r => r.bottom)) };
  });
  expect(Math.abs(geo.right - geo.rowRight)).toBeLessThanOrEqual(1);
  expect(geo.top).toBeGreaterThan(geo.othersBottom + 4);              // its own line, with space above
  await cancel.click();
  await expect(insp(page).locator('.insp-cancel .btn.danger')).toHaveClass(/confirm-pending/);
  await expect(insp(page).locator('.insp-cancel .btn.danger')).toHaveText('Press again to cancel');
  await page.clock.runFor(1100);
  expect(calls.filter(c => c === 'cancel-session')).toEqual([]);
  await expect(insp(page).locator('.insp-cancel .btn.danger')).toHaveClass(/confirm-pending/);
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/cancel-session'));
  await insp(page).locator('.insp-cancel .btn.danger').click();
  await sent;
  await ctx.close();
});

for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  test(`inspector: ${locale}: every section label is translated`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { locale });
    const keys = ['control', 'next', 'timing', 'screens', 'session'];
    const vals = await evalPage(page, `${JSON.stringify(keys)}.map(k => t('cc.insp.sec.' + k))`) as string[];
    vals.forEach((v, i) => expect(v, keys[i]).not.toBe('cc.insp.sec.' + keys[i]));
    expect(await secLabels(page)).toEqual([vals[0], vals[2], vals[3], vals[4]]);
    await page.locator(`#card-${ID(5)} .sc-title`).click();
    expect(await secLabels(page)).toEqual([vals[1], vals[2], vals[3], vals[4]]);
    const goNow = await evalPage(page, `t('cc.insp.goLiveNow')`) as string;
    expect(goNow).not.toBe('cc.insp.goLiveNow');
    await expect(insp(page).locator('.insp-next > .btn').nth(1)).toHaveText(goNow);
    await ctx.close();
  });
}

test('inspector: within LIVE, Hold and End never move when arrival toggles', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const pos = async () => {
    const out: number[] = [];
    for (const sel of ['.insp-primary .hold', '.insp-primary .btn.danger']) {
      const b = (await insp(page).locator(sel).boundingBox())!;
      out.push(Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10);
    }
    return out;
  };
  const before = await pos();
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').speaker_arrived = false; renderSessions();`);
  await expect(insp(page).locator('.who-state')).toHaveText('Not arrived');
  expect(await pos()).toEqual(before);
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').speaker_arrived = true; renderSessions();`);
  expect(await pos()).toEqual(before);
  await ctx.close();
});

test('inspector: at 1280x720 Control and Next step are visible without scrolling, and a re-render keeps the scroll', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 } });
  const visible = (sel: string) => page.evaluate(q => {
    const w = document.getElementById('ctx-wrap')!; const r = w.getBoundingClientRect();
    const b = w.querySelector(q)!.getBoundingClientRect();
    return w.scrollTop === 0 && b.top >= r.top && b.bottom <= r.bottom;
  }, sel);
  expect(await visible('.insp-primary')).toBe(true);
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(200);
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  expect(await visible('.insp-next')).toBe(true);
  // The inspector never jumps: a scrolled inspector keeps its place through the 1 s re-render.
  const top = await page.locator('#ctx-wrap').evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
  await page.clock.runFor(2100);
  expect(await page.locator('#ctx-wrap').evaluate(el => el.scrollTop)).toBe(top);
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

// 5.2b (3), owner 7 Oct: the event log can be minimised to one row, per viewer.
test('log: open by default; minimised it is one 40 to 44 px row and the inspector gets the height', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const toggle = page.locator('#log-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('data-fk', 'log-toggle');
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(240);
  const inspBefore = (await page.locator('#ctx-wrap').boundingBox())!.height;
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const h = (await page.locator('#log-panel').boundingBox())!.height;
  expect(h).toBeGreaterThanOrEqual(40);
  expect(h).toBeLessThanOrEqual(44);
  await expect(page.locator('#log-feed')).toBeHidden();
  await expect(page.locator('#log-panel .log-filters')).toBeHidden();
  await expect(page.locator('#log-title')).toHaveText('Event log');
  await expect(page.locator('#log-latest')).toContainText('realtime channel connected');
  expect(await evalPage(page, `localStorage.getItem('cd.logMin')`)).toBe('1');
  expect((await page.locator('#ctx-wrap').boundingBox())!.height).toBeGreaterThan(inspBefore);
  // a click on the row reopens it
  await page.locator('#log-latest').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#log-feed')).toBeVisible();
  expect(await evalPage(page, `localStorage.getItem('cd.logMin')`)).toBe('0');
  await ctx.close();
});

test('log: a new entry while minimised updates the latest line and counts what is new', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#log-toggle').click();
  await expect(page.locator('#log-new')).toBeHidden();
  await evalPage(page, `pushLog('BROADCAST', 'Doors open in five minutes', null)`);
  await expect(page.locator('#log-new')).toHaveText('1 new');
  await expect(page.locator('#log-latest')).toContainText('Doors open in five minutes');
  await expect(page.locator('#log-latest .lg-kind')).toHaveText('Broadcast');
  await evalPage(page, `pushLog('DELAY', '+5 min', null); pushLog('ERROR', 'Signage push failed', null)`);
  await expect(page.locator('#log-new')).toHaveText('3 new');
  await expect(page.locator('#log-latest')).toContainText('Signage push failed');
  // reopening clears the count
  await page.locator('#log-toggle').click();
  await page.locator('#log-toggle').click();
  await expect(page.locator('#log-new')).toBeHidden();
  await ctx.close();
});

test('log: the minimised state survives a reload, and a new count is translated', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { locale: 'de' });
  await page.locator('#log-toggle').click();
  await page.reload();
  await expect(page.locator('#log-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#log-feed')).toBeHidden();
  await expect(page.locator('#log-toggle')).toHaveAttribute('aria-label', await evalPage(page, `t('cc.log.expand')`) as string);
  await evalPage(page, `pushLog('BROADCAST', 'x', null)`);
  await expect(page.locator('#log-new')).toHaveText(await evalPage(page, `tf('cc.log.new', { n: 1 })`) as string);
  expect(await evalPage(page, `t('cc.log.new')`)).not.toBe('cc.log.new');
  await ctx.close();
});

test('log: blocked storage leaves the log open', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); S.logMin = readLogMin(); applyLogMin();`);
  await expect(page.locator('#log-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#log-toggle').click();   // a write that throws still toggles for this page
  await expect(page.locator('#log-toggle')).toHaveAttribute('aria-expanded', 'false');
  await ctx.close();
});

test('log: on a phone the Log tab shows the full log even when minimised on desktop', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 390, height: 844 }, touch: true });
  await evalPage(page, `S.logMin = true; applyLogMin(); setPhoneTab('log')`);
  await expect(page.locator('#log-feed')).toBeVisible();
  await expect(page.locator('#log-toggle')).toBeHidden();
  await ctx.close();
});

// 5.2b fix round 1 (1): the inspector's arrival toggle changes its label in place, so it
// takes the press guard, and a write in flight for that session takes no second press.
test('inspector: a double-click on Mark arrived writes once, with true, and stays arrived', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const writes: unknown[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/leod_sessions')) writes.push(r.postDataJSON()); });
  await afterBootReread(page);    // the boot re-read would otherwise restore the fixture's arrival
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  await insp(page).locator('[data-fk="insp-arrive"]').dblclick();
  await page.clock.runFor(1100);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([{ speaker_arrived: true }]);
  await expect(insp(page).locator('.who-state')).toHaveText('Arrived');
  expect(await evalPage(page, `S.sessions.find(x => x.id === '${ID(5)}').speaker_arrived`)).toBe(true);
  await ctx.close();
});

test('inspector: a press while the arrival write is in flight is ignored; a failure restores the value from before the press', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  const out = await evalPage(page, `(async () => {
    const real = sb.from.bind(sb);
    let release; const gate = new Promise(r => { release = r; });
    let n = 0;
    sb.from = (tb) => tb !== 'leod_sessions' ? real(tb) : { update: () => ({ eq: async () => { n++; await gate; return { error: { message: 'offline' } }; } }) };
    const a = markArrived('${ID(5)}', true);
    const b = markArrived('${ID(5)}', false);   // overlapping press: ignored
    release(); await a; await b;
    sb.from = real;
    return [n, S.sessions.find(x => x.id === '${ID(5)}').speaker_arrived];
  })()`);
  expect(out).toEqual([1, false]);
  await ctx.close();
});

// 5.2b fix round 1 (3): an error is visible in the one-line log.
test('log: minimised, an error shows in the error colour and turns the new badge red', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#log-toggle').click();
  const errColour = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--st-live-fg').trim());
  const rgb = await page.evaluate(c => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; }, errColour);
  await evalPage(page, `pushLog('BROADCAST', 'Doors open', null)`);
  await expect(page.locator('#log-new')).not.toHaveClass(/is-err/);
  expect(await page.locator('#log-latest .lg-kind').evaluate(el => getComputedStyle(el).color)).not.toBe(rgb);
  await evalPage(page, `pushLog('ERROR', 'Signage push failed', null)`);
  expect(await page.locator('#log-latest .lg-kind').evaluate(el => getComputedStyle(el).color)).toBe(rgb);
  // the open log uses the same token for an error kind
  await expect(page.locator('#log-new')).toHaveClass(/is-err/);
  await evalPage(page, `pushLog('DELAY', '+5 min', null)`);
  await expect(page.locator('#log-new')).toHaveText('3 new');
  await expect(page.locator('#log-new')).toHaveClass(/is-err/);                 // an error arrived since minimising
  expect(await page.locator('#log-latest .lg-kind').evaluate(el => getComputedStyle(el).color)).not.toBe(rgb);
  await page.locator('#log-toggle').click();
  expect(await page.locator('#log-feed .lg-error .lg-kind').first().evaluate(el => getComputedStyle(el).color)).toBe(rgb);
  await page.locator('#log-toggle').click();
  await evalPage(page, `pushLog('DELAY', '+5 min', null)`);
  await expect(page.locator('#log-new')).not.toHaveClass(/is-err/);             // reset on reopening
  await ctx.close();
});

// 5.2b fix round 1 (4), owner: the Session row fits one line at the real rail widths in every
// language (Move up and Move down are icon-only with a translated name); Cancel stays apart.
for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    test(`inspector: ${locale} ${viewport.width}: the Session row is one line for READY, LIVE and ENDED`, async ({ browser }) => {
      const { ctx, page } = await openConsole(browser, { locale, viewport });
      for (const id of [ID(5), PANEL_ID, ID(1)]) {
        await evalPage(page, `selectSession('${id}')`);
        const row = await insp(page).locator('.insp-session').evaluate(el => {
          const btns = [...el.querySelectorAll('.insp-sbtns .btn')] as HTMLElement[];
          const c = el.querySelector('.insp-cancel .btn') as HTMLElement | null;
          return {
            n: btns.length, tops: [...new Set(btns.map(b => b.offsetTop))],
            clipped: btns.filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent),
            minW: Math.min(...btns.map(b => b.getBoundingClientRect().width)),
            // the end edge: right in ltr, left in rtl (Arabic)
            cancel: c ? { top: c.getBoundingClientRect().top, end: getComputedStyle(el).direction === 'rtl' ? c.getBoundingClientRect().left : c.getBoundingClientRect().right } : null,
            rowBottom: Math.max(...btns.map(b => b.getBoundingClientRect().bottom)),
            end: getComputedStyle(el).direction === 'rtl' ? el.getBoundingClientRect().left : el.getBoundingClientRect().right,
          };
        });
        expect(row.n, id).toBeGreaterThanOrEqual(4);
        expect(row.tops, `${id} wraps`).toHaveLength(1);
        expect(row.clipped, id).toEqual([]);
        expect(row.minW).toBeGreaterThanOrEqual(32);
        if (row.cancel) {
          expect(row.cancel.top).toBeGreaterThan(row.rowBottom);
          expect(Math.abs(row.cancel.end - row.end)).toBeLessThanOrEqual(1);
        }
      }
      for (const [fk, key] of [['insp-up', 'cc.list.moveUp'], ['insp-down', 'cc.list.moveDown']]) {
        const name = await evalPage(page, `t('${key}')`) as string;
        await expect(insp(page).locator(`[data-fk="${fk}"]`)).toHaveAttribute('aria-label', name);
        await expect(insp(page).locator(`[data-fk="${fk}"]`)).toHaveAttribute('title', name);
        await expect(insp(page).locator(`[data-fk="${fk}"] svg use`)).toHaveAttribute('href', fk === 'insp-up' ? '#i-arrow-up' : '#i-arrow-down');
      }
      await ctx.close();
    });
  }
}
