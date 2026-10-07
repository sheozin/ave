// tests/e2e/console-band.spec.ts
// Spec 2.1: one lane per room with a LIVE, OVERRUN, HOLD or CALLING session
// or a next session; End always in the same slot; knock-on when a session
// runs over; more than three rooms collapse the idle ones to chips.
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, textContrast, ID, PANEL_ID, overrunSessions, noLiveSessions, fourRoomSessions, roomlessSessions, longTitleSessions, manySessions } from './console-boot-mock';

test('band: one lane per active room with now and next', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const lanes = page.locator('#band .lane');
  await expect(lanes).toHaveCount(2);
  await expect(lanes.nth(0).locator('.lane-room')).toHaveText('Main Stage');   // running order: #1 and #3 are on Main Stage, Hall B starts at #2
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-live/);
  await expect(ms.locator('.lane-title')).toHaveText('#3 Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(ms.locator('.lane-who')).toContainText('Dina Farouk (moderator) +3');
  await expect(ms.locator('.lane-big')).toHaveText('19:15');
  await expect(ms.locator('.lane-next')).toContainText('#5 Duty Free Pricing After the Currency Float');
  await expect(ms.locator('.lane-next')).toContainText('12:05 (+5) · in 25 min');
  await expect(ms.locator('.lane-next .lane-ctrl button')).toHaveText('Call speaker');
  const hb = page.locator('#band .lane[data-room="Hall B"]');
  await expect(hb).toHaveClass(/is-hold/);
  await expect(hb.locator('.lane-big')).toHaveText('9:45');
  await expect(hb.locator('.lane-now .lane-lead button')).toHaveText('Resume');
  await expect(hb.locator('.lane-next .lane-ctrl button')).toHaveText('On stage');
  await ctx.close();
});

test('band: Hold sits left of End and End is in the same place in every lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const ms = page.locator('#band .lane[data-room="Main Stage"] .lane-now .lane-ctrl');
  const kids = await ms.evaluate(el => [...el.children].map(c =>
    c.classList.contains('act-gap') ? 'gap' : c.classList.contains('lane-lead') ? 'lead' : c.classList.contains('danger') ? 'end' : c.className));
  expect(kids).toEqual(['lead', 'gap', 'end']);
  await expect(ms.locator('.lane-lead .hold')).toHaveText('Hold');
  const endX = async (room: string) => (await page.locator(`#band .lane[data-room="${room}"] .lane-now .btn.danger`).boundingBox())!.x;
  expect(Math.abs((await endX('Main Stage')) - (await endX('Hall B')))).toBeLessThan(1);
  const leadX = async (room: string) => (await page.locator(`#band .lane[data-room="${room}"] .lane-now .lane-lead`).boundingBox())!.x;
  expect(Math.abs((await leadX('Main Stage')) - (await leadX('Hall B')))).toBeLessThan(1);
  await ctx.close();
});

test('band: OVERRUN lane turns magenta, counts up, and the next row shows the knock-on and Push following', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions() });
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-over/);
  await expect(ms.locator('.lane-big')).toHaveText('+10:45');
  await expect(ms.locator('.lane-unit')).toHaveText('over');
  await expect(ms.locator('.lane-risk')).toHaveText('12:05 now 12:15, at risk');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/apply-delay'));
  await ms.locator('.lane-next button', { hasText: 'Push following +10' }).click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: ID(5), minutes: 10 });
  await ctx.close();
});

test('band: an idle room says idle and offers the next session action', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: noLiveSessions(), broadcast: null });
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-idle/);
  await expect(ms).toContainText('Main Stage idle · Next #5 Duty Free Pricing After the Currency Float · in 25 min');
  await expect(ms.locator('.lane-ctrl button')).toHaveText('Call speaker');
  await expect(page.locator('#band .lane[data-room="Hall B"]')).toHaveClass(/is-calling/);
  await ctx.close();
});

test('band: 4 rooms keep attention lanes full and collapse the idle one', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: fourRoomSessions() });
  await expect(page.locator('#band .lane')).toHaveCount(3);
  const chip = page.locator('#band .lane-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('Terrace');
  expect(Math.round((await chip.boundingBox())!.height)).toBe(28);
  const firstRow = await page.locator('#sessions-list .sc').first().boundingBox();
  expect(firstRow!.y + firstRow!.height).toBeLessThanOrEqual(900);
  await chip.click();
  await expect(page.locator('#band .lane')).toHaveCount(4);
  await ctx.close();
});

test('band: sessions without a room get one No room lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: roomlessSessions() });
  await expect(page.locator('#band .lane')).toHaveCount(1);
  await expect(page.locator('#band .lane-room')).toHaveText('No room');
  await expect(page.locator('#band .lane-title')).toHaveText(/^#3 /);
  await expect(page.locator('#band .lane-next')).toContainText('#4 ');
  await ctx.close();
});

test('band: a long title never pushes End out of the lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: longTitleSessions() });
  const lane = page.locator(`#band .lane[data-room="Main Stage"]`);
  const lb = (await lane.boundingBox())!;
  const eb = (await lane.locator('.lane-now .btn.danger').boundingBox())!;
  expect(eb.x + eb.width).toBeLessThanOrEqual(lb.x + lb.width);
  expect(await lane.locator('.lane-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await ctx.close();
});

test('band: Not arrived shows when the next speaker is due within 10 minutes', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `const s = S.sessions.find(x => x.id === '${ID(5)}'); s.scheduled_start = '11:48:00'; s.speaker_arrived = false; renderSessions();`);
  await expect(page.locator('#band .lane[data-room="Main Stage"] .warnchip')).toHaveText('Not arrived');
  await ctx.close();
});

test('band: stays visible in the timeline view and for stage operators puts their room first', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await expect(page.locator('#band .lane').first()).toHaveAttribute('data-room', 'Main Stage');   // running order
  await evalPage(page, `setMyRoom('Hall B')`);
  await expect(page.locator('#band .lane').first()).toHaveAttribute('data-room', 'Hall B');      // the operator's room first
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator('#band')).toBeVisible();
  await ctx.close();
});

test('band: "in N min" keeps counting when nothing is running', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: noLiveSessions(), broadcast: null });
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toContainText('in 25 min');
  // Move the synced clock a minute on and let only the 1 s tick render (no explicit
  // renderSessions; FROZEN_AT + 1 s stays clear of the 60 s clock resync).
  await evalPage(page, 'S.clockOffset = 60_000');
  await page.clock.runFor(1000);
  await expect(ms).toContainText('in 24 min');
  await ctx.close();
});

test('band: the final minute shows tenths and the wrap-up colour in the lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').actual_start = new Date(correctedNow() - (30 * 60_000 - 30_000)).toISOString(); renderSessions();`);
  await page.clock.runFor(400);
  const lane = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(lane.locator('.lane-big')).toHaveText(/^0:(29|30)\.\d$/);
  await expect(lane.locator('.lane-count')).toHaveClass(/warn-red/);
  await ctx.close();
});

test('layout: at 1440x900 both lanes and at least 8 list rows are on screen', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: manySessions() });
  const col = page.locator('#sessions-col');
  expect(await col.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);   // the list really is longer than the screen
  const colBottom = await col.evaluate(el => el.getBoundingClientRect().bottom);
  // List rows: session rows plus the folded "N completed" row (a 34 px row in spec 2.2).
  const rows = await page.locator('#sessions-list .sc, #sessions-list .sc-fold').evaluateAll((els, bottom) => els.filter(e => e.getBoundingClientRect().bottom <= (bottom as number)).length, colBottom);
  expect(rows).toBeGreaterThanOrEqual(8);
  for (const room of ['Main Stage', 'Hall B']) {
    const b = (await page.locator(`#band .lane[data-room="${room}"] .lane-next`).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(900);
  }
  await ctx.close();
});

// Release gate (spec 9): measured against the approved demo at 1440x900.
test('band: countdown is 28 px bold and the now title at least 15 px bold at 1440x900', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const room of ['Main Stage', 'Hall B']) {
    const lane = page.locator(`#band .lane[data-room="${room}"]`);
    const big = await lane.locator('.lane-big').evaluate(el => { const c = getComputedStyle(el); return [parseFloat(c.fontSize), +c.fontWeight]; });
    expect(big[0]).toBeGreaterThanOrEqual(28);
    expect(big[1]).toBeGreaterThanOrEqual(700);
    const title = await lane.locator('.lane-title').evaluate(el => { const c = getComputedStyle(el); return [parseFloat(c.fontSize), +c.fontWeight]; });
    expect(title[0]).toBeGreaterThanOrEqual(15);
    expect(title[1]).toBeGreaterThanOrEqual(700);
  }
  await ctx.close();
});

test('band: a Not arrived chip takes the place of the next status badge', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const next = page.locator('#band .lane[data-room="Main Stage"] .lane-next');
  await expect(next.locator('.badge')).toHaveText(/ready/i);
  await evalPage(page, `const s = S.sessions.find(x => x.id === '${ID(5)}'); s.scheduled_start = '11:48:00'; s.speaker_arrived = false; renderSessions();`);
  await expect(next.locator('.warnchip')).toBeVisible();
  await expect(next.locator('.badge')).toHaveCount(0);
  await ctx.close();
});

test('band: End arms on the first press, stays armed and solid red across the tick, and acts on the second', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const end = page.locator(`#band .lane[data-room="Main Stage"] .lane-now .btn.danger`);
  await end.click();
  await page.clock.runFor(1100);   // at least one 1 s re-render
  await expect(end).toHaveClass(/confirm-pending/);
  await end.hover();
  expect(await end.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/end-session'));
  await end.click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: PANEL_ID });
  await ctx.close();
});

test('layout: in Arabic at 1440x900 the rail is on screen beside the band, not slid away as a drawer', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { locale: 'ar' });
  const rail = (await page.locator('#sidebar').boundingBox())!;
  expect(rail.x).toBeGreaterThanOrEqual(0);
  expect(rail.width).toBeGreaterThan(300);
  const band = (await page.locator('#band').boundingBox())!;
  expect(rail.x + rail.width).toBeLessThanOrEqual(band.x + 1);   // RTL: the rail sits left of the main column
  await ctx.close();
});

test('layout: at 1280x720 the overrun next half keeps Push following and the next action inside the lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions(), viewport: { width: 1280, height: 720 } });
  const lane = page.locator('#band .lane[data-room="Main Stage"]');
  const lb = (await lane.boundingBox())!;
  for (const b of await lane.locator('.lane-next button').all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(lb.x + lb.width);
  }
  // and nothing in the next half overlaps: the title and risk line never covers a button
  const what = (await lane.locator('.lane-next-what').boundingBox())!;
  for (const b of await lane.locator('.lane-next button').all()) {
    const bb = (await b.boundingBox())!;
    const apart = what.x + what.width <= bb.x || bb.x + bb.width <= what.x || what.y + what.height <= bb.y || bb.y + bb.height <= what.y;
    expect(apart).toBe(true);
  }
  await ctx.close();
});


// ── Round 1: closing the gaps to the approved demo ──────────────────────────

test('band: rooms follow the running order (first session), with No room last', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: fourRoomSessions() });
  await expect(page.locator('#band .lane')).toHaveCount(3);
  expect(await page.locator('#band .lane').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.room))).toEqual(['Main Stage', 'Hall B', 'Hall C']);
  // #2 (Hall B, on hold) moves to no room: the No room lane still comes last although it runs earliest.
  await evalPage(page, `S.sessions.find(x => x.id === '${ID(2)}').room = null; renderSessions();`);
  const rooms = await page.locator('#band .lane').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.room));
  expect(rooms).toEqual(['Main Stage', 'Hall B', 'Hall C', '']);   // Hall B keeps #4 and #7; Terrace (idle) is a chip; No room last
  await ctx.close();
});

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  test(`band controls (${locale}): demo-sized Hold and End, aligned in every lane, armed End never clipped and solid red on LIVE and after the flip to OVERRUN`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { locale });
    const ms = '#band .lane[data-room="Main Stage"] .lane-now';
    const hb = '#band .lane[data-room="Hall B"] .lane-now';
    // At rest: compact (the demo: Hold about 75, End… 62), and the same slots in both lanes.
    const msEnd = await box(page, `${ms} .btn.danger`), hbEnd = await box(page, `${hb} .btn.danger`);
    if (locale === 'en') { expect(msEnd.width).toBeLessThanOrEqual(70); expect((await box(page, `${ms} .lane-lead`)).width).toBeLessThanOrEqual(90); }
    expect(Math.abs(msEnd.x - hbEnd.x)).toBeLessThan(1);
    expect(Math.abs(msEnd.width - hbEnd.width)).toBeLessThan(1);
    expect(Math.abs((await box(page, `${ms} .lane-lead`)).x - (await box(page, `${hb} .lane-lead`)).x)).toBeLessThan(1);
    for (const sel of [`${ms} .lane-lead .btn`, `${hb} .lane-lead .btn`, `${ms} .btn.danger`, `${hb} .btn.danger`])
      expect(await page.locator(sel).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Armed on LIVE: full label, solid red on hover, right edge where it was, Hold still left of it.
    const end = page.locator(`${ms} .btn.danger`);
    await end.click();
    await page.clock.runFor(1100);
    const check = async () => {
      await expect(end).toHaveClass(/confirm-pending/);
      expect(await end.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await end.textContent()).toBe(await evalPage(page, `t('confirm.confirmEnd')`));
      await end.hover();
      expect(await end.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      const e = await box(page, `${ms} .btn.danger`), h = await box(page, `${ms} .lane-lead`);
      const lane = await box(page, '#band .lane[data-room="Main Stage"]');
      if (locale === 'ar') {   // RTL: End sits at the inline end (left) and grows to the right
        expect(Math.abs(e.x - msEnd.x)).toBeLessThan(1);
        expect(e.x + e.width).toBeLessThan(h.x);
        expect(e.x).toBeGreaterThanOrEqual(lane.x);
      } else {
        expect(Math.abs((e.x + e.width) - (msEnd.x + msEnd.width))).toBeLessThan(1);
        expect(h.x + h.width).toBeLessThan(e.x);
        expect(e.x + e.width).toBeLessThanOrEqual(lane.x + lane.width);
      }
    };
    await check();
    // The talk reaches its end time while armed: OVERRUN keeps the same arm and the same slots.
    await evalPage(page, `onSessionChange({ eventType: 'UPDATE', new: { ...S.sessions.find(x => x.id === '${PANEL_ID}'), status: 'OVERRUN', version: 99 }, old: {} })`);
    await expect(page.locator('#band .lane[data-room="Main Stage"]')).toHaveClass(/is-over/);
    await check();
    await ctx.close();
  });
}

test('band: at 1440 the Main Stage now title fits untruncated, as in the demo', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const title = page.locator('#band .lane[data-room="Main Stage"] .lane-title');
  await expect(title).toHaveText('#3 Panel: Airport Retail in Cairo, Casablanca and Tunis');
  expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await ctx.close();
});

test('band: held count is light amber and overrun count light magenta, both readable on the lane wash', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(await page.locator('.lane.is-hold .lane-big').evaluate(el => getComputedStyle(el).color)).toBe('rgb(253, 186, 116)');
  expect(await textContrast(page, '.lane.is-hold .lane-big')).toBeGreaterThanOrEqual(4.5);
  await ctx.close();
  const o = await openConsole(browser, { sessions: overrunSessions() });
  expect(await o.page.locator('.lane.is-over .lane-big').evaluate(el => getComputedStyle(el).color)).toBe('rgb(245, 208, 254)');
  expect(await textContrast(o.page, '.lane.is-over .lane-big')).toBeGreaterThanOrEqual(4.5);
  await o.ctx.close();
});

test('band: now row at least 58 px and next row at least 40 px at 1440', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const room of ['Main Stage', 'Hall B']) {
    expect((await box(page, `#band .lane[data-room="${room}"] .lane-now`)).height).toBeGreaterThanOrEqual(58);
    expect((await box(page, `#band .lane[data-room="${room}"] .lane-next`)).height).toBeGreaterThanOrEqual(40);
  }
  await ctx.close();
});

test('layout: at 1280x720 the now title has at least 200 px, and in overrun the next half still shows its title and the risk', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 } });
  for (const room of ['Main Stage', 'Hall B'])
    expect((await box(page, `#band .lane[data-room="${room}"] .lane-title`)).width).toBeGreaterThanOrEqual(200);
  await ctx.close();
  const o = await openConsole(browser, { sessions: overrunSessions(), viewport: { width: 1280, height: 720 } });
  const next = o.page.locator('#band .lane[data-room="Main Stage"] .lane-next');
  const title = next.locator('.lane-next-title');
  expect(((await title.textContent()) || '').trim()).toMatch(/^#5 /);
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(40);
  const risk = next.locator('.lane-risk');
  await expect(risk).toHaveText('12:05 now 12:15, at risk');
  expect(await risk.evaluate(el => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
  const rb = (await risk.boundingBox())!, nb = (await next.boundingBox())!;
  expect(rb.x).toBeGreaterThanOrEqual(nb.x);
  expect(rb.x + rb.width).toBeLessThanOrEqual(nb.x + nb.width);
  await o.ctx.close();
});
