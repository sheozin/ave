// tests/e2e/console-phone.spec.ts
// Spec 2.7 (stage 5): at 767 px and below a phone shows its room's Now card
// first (big countdown, Hold and End at 48 px), then Next with its action,
// a short Later list, and bottom tabs Now, Schedule, Log, Send; a room picker
// sits in the 48 px header. Release gate (7 Oct): countdown at least 30 px
// bold, Hold and End at least 48 px, every touch target at least 44 px.
// Owner rulings: End is a two-press confirm, Hold and End never move when End
// arms (all 4 languages), the stage 4 press guard applies, directors keep the
// role switch in the menu.
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, rtPush, afterBootReread, ID, PANEL_ID, iso, demoSessions, overrunSessions, roomlessSessions } from './console-boot-mock';

const PHONE = { viewport: { width: 390, height: 844 }, touch: true } as const;
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
const MS = '#phone-now .ph-lane[data-room="Main Stage"]';
const HB = '#phone-now .ph-lane[data-room="Hall B"]';
function efLog(page: Page) {
  const calls: string[] = [];
  page.on('request', r => { const m = r.url().match(/\/functions\/v1\/([\w-]+)/); if (m) calls.push(m[1]); });
  return calls;
}
const settle = (page: Page) => page.waitForTimeout(250);

test('phone: 48 px header with clock, status dot, room picker and menu; nothing overlaps or scrolls sideways', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(48);
  for (const id of ['#hdr-clock', '#conn-dot', '#room-pick', '#hamburger-btn']) await expect(page.locator(id)).toBeVisible();
  for (const id of ['#ev-switch', '#crew-pill', '#viewas-wrap', '#help-btn', '#user-chip', '#sidebar-toggle']) await expect(page.locator(id)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // every header control inside the header row
  for (const id of ['#hdr-clock', '#conn-pill', '#room-pick', '#hamburger-btn']) {
    const b = await box(page, id);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  await ctx.close();
});

test('phone: the Now card for the chosen room has a big bold countdown and two 48 px buttons, Hold before End', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await page.locator('#room-pick').selectOption('Main Stage');
  await expect(page.locator('#phone-now .ph-lane')).toHaveCount(1);
  const card = page.locator('#phone-now .ph-now-card');
  await expect(card.locator('.ph-card-head')).toContainText('Now · Main Stage');
  await expect(card.locator('.ph-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  const big = card.locator('.ph-big');
  await expect(big).toHaveText('19:15');
  expect(parseFloat(await big.evaluate(el => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(30);
  expect(await big.evaluate(el => getComputedStyle(el).fontWeight)).toBe('700');
  expect(await card.locator('.ph-title').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(17);
  await expect(card.locator('.prog')).toBeVisible();
  await expect(card).toContainText('Dina Farouk (moderator) +3');
  await expect(card).toContainText('Moderator opens with audience poll');
  const btns = card.locator('.ph-actions .btn');
  await expect(btns).toHaveCount(2);
  await expect(btns.nth(0)).toHaveText(/Hold/);
  await expect(btns.nth(1)).toHaveText(/End/);
  for (const b of await btns.all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(48);
  const next = page.locator('#phone-now .ph-next-card');
  await expect(next).toContainText('Duty Free Pricing After the Currency Float');
  await expect(next).toContainText('12:05 (+5) · in 25 min');
  const call = next.locator('.btn:not(.ph-arrive):not(.ph-push)');
  await expect(call).toHaveText('Call speaker');
  expect(Math.round((await call.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#phone-now .ph-row').first()).toContainText('Digital Pre-Order');
  expect(Math.round((await page.locator('#phone-now .ph-row').first().boundingBox())!.height)).toBeGreaterThanOrEqual(48);
  // the final minute shows tenths here too
  await evalPage(page, `S.sessions.find(x => x.status === 'LIVE').actual_start = new Date(correctedNow() - (30 * 60_000 - 30_000)).toISOString(); renderSessions();`);
  await page.clock.runFor(400);
  await expect(big).toHaveText(/^0:(29|30)\.\d$/);
  await ctx.close();
});

test('phone: OVERRUN shows Hold before End and counts up', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, sessions: overrunSessions() });
  const card = page.locator(`${MS} .ph-now-card`);
  await expect(card).toHaveClass(/is-over/);
  await expect(card.locator('.ph-big')).toHaveText(/^\+/);
  const btns = card.locator('.ph-actions .btn');
  await expect(btns.nth(0)).toHaveText(/Hold/);
  await expect(btns.nth(1)).toHaveText(/End/);
  await ctx.close();
});

test('phone: the room picker is not rebuilt by the 1 s re-render', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await evalPage(page, `window.__opt = document.querySelector('#room-pick option')`);
  expect(await evalPage(page, `window.__opt !== null`)).toBe(true);
  await page.clock.runFor(2000);                       // two ticks with a LIVE session, each calling renderPhoneNow
  expect(await evalPage(page, `document.querySelector('#room-pick option') === window.__opt`)).toBe(true);
  await ctx.close();
});

test('phone: a stage operator without a room sees one room, and the picker names that room', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await expect(page.locator('#phone-now .ph-lane')).toHaveCount(1);
  const room = await page.locator('#phone-now .ph-lane').getAttribute('data-room');
  expect(await page.locator('#room-pick').inputValue()).toBe(room);
  await page.locator('#room-pick').selectOption('Hall B');
  await expect(page.locator(`${HB} .ph-now-card`)).toContainText('Workshop: Fragrance');
  await ctx.close();
});

test('phone: an event without rooms shows its sessions and offers no room to pick', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage', sessions: roomlessSessions() });
  await expect(page.locator('#phone-now .ph-now-card')).toHaveCount(1);
  await expect(page.locator('#phone-now .ph-now-card')).toContainText('No room');
  await expect(page.locator('#room-pick option')).toHaveCount(0);
  await expect(page.locator('#room-pick')).toBeHidden();
  await ctx.close();
});

test('phone: directors get one Now and Next block per room, and keep the role switch in the menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  await expect(page.locator('#phone-now .ph-lane')).toHaveCount(2);
  await expect(page.locator('#room-pick')).toHaveValue('');
  await page.locator('#hamburger-btn').click();
  await expect(page.locator('#mm-roles')).toBeVisible();
  await expect(page.locator('#mm-roles [data-role="stage"]')).toBeVisible();
  await ctx.close();
});

test('phone: bottom tabs switch between Now, Schedule, Log and Send', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const tab = (name: string) => page.locator(`#phone-tabs [data-tab="${name}"]`);
  await expect(tab('now')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#phone-now')).toBeVisible();
  await tab('schedule').click();
  await expect(tab('schedule')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#sessions-list')).toBeVisible();
  await expect(page.locator('#phone-now')).toBeHidden();
  await tab('log').click();
  await expect(page.locator('#log-feed')).toBeVisible();
  await expect(page.locator('#sessions-list')).toBeHidden();
  await tab('send').click();
  await expect(page.locator('#bc-input')).toBeVisible();
  const tb = await box(page, '#phone-tabs');
  expect(Math.round(tb.height)).toBe(56);
  expect(Math.round(tb.y + tb.height)).toBe(844);
  expect(Math.round((await tab('send').boundingBox())!.height)).toBeGreaterThanOrEqual(48);
  // the composer sheet sits above the tab bar
  const bar = await box(page, '#bc-bar');
  expect(bar.y + bar.height).toBeLessThanOrEqual(tb.y + 0.5);
  await tab('now').click();
  await expect(page.locator('#bc-input')).toBeHidden();
  await ctx.close();
});

test('phone: the broadcast banner is one line and expands on tap', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const banner = page.locator('#bc-banner');
  const msg = banner.locator('.bc-msg');
  const lineH = await msg.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) || 18);
  expect((await msg.boundingBox())!.height).toBeLessThanOrEqual(lineH + 1);
  expect(Math.round((await banner.boundingBox())!.height)).toBeLessThanOrEqual(44);
  await msg.click();
  await expect(banner).toHaveClass(/expanded/);
  expect((await msg.boundingBox())!.height).toBeGreaterThan(lineH + 1);
  await banner.locator('.bc-dismiss').click();
  await expect(banner).toBeHidden();
  await ctx.close();
});

test('phone: End arms on the first press, stays armed and solid red across the tick, and acts on the second', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const end = page.locator(`${MS} .ph-actions .btn.danger`);
  await end.click();
  await page.clock.runFor(1100);
  await expect(end).toHaveClass(/confirm-pending/);
  await expect(end).toHaveText('Press again to end');
  expect(await end.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/end-session'));
  await end.click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: PANEL_ID });
  await ctx.close();
});

for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  test(`phone (${locale}): arming End moves neither Hold nor End, on LIVE and on OVERRUN, and the label fits`, async ({ browser }) => {
    for (const sessions of [undefined, overrunSessions()]) {
      const { ctx, page } = await openConsole(browser, { ...PHONE, locale, sessions });
      const hold = `${MS} .ph-actions .btn:not(.danger)`, end = `${MS} .ph-actions .btn.danger`;
      const h0 = await box(page, hold), e0 = await box(page, end);
      expect(Math.round(h0.height)).toBeGreaterThanOrEqual(48);
      await page.locator(end).click();
      await page.clock.runFor(1100);
      await expect(page.locator(end)).toHaveClass(/confirm-pending/);
      const h1 = await box(page, hold), e1 = await box(page, end);
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(near(h1[k], h0[k])).toBe(true);
        expect(near(e1[k], e0[k])).toBe(true);
      }
      expect(await page.locator(end).evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await ctx.close();
    }
  });
}

test('phone: double-tapping Resume sends one go-live and no hold-stage (press guard)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const calls = efLog(page);
  const lead = page.locator(`${HB} .ph-actions .btn`).first();
  await expect(lead).toHaveText(/Resume/);
  await lead.dblclick();
  await settle(page);
  expect(calls.filter(c => c === 'go-live')).toHaveLength(1);
  expect(calls).not.toContain('hold-stage');
  await ctx.close();
});

test('phone: On stage turning into Hold by realtime ignores a press 200 ms later, takes one 700 ms later', async ({ browser }) => {
  const callingHallB = () => demoSessions().map(x => x.id === ID(2) ? { ...x, status: 'ENDED', actual_end: iso(-1) } : x);
  const { ctx, page } = await openConsole(browser, { ...PHONE, sessions: callingHallB() });
  const calls = efLog(page);
  const lead = page.locator(`${HB} .ph-now-card .ph-actions .btn`).first();
  await expect(lead).toHaveText(/On stage/);
  await afterBootReread(page);
  const s4 = callingHallB().find(x => x.id === ID(4))!;
  await rtPush(page, 'leod_sessions', 'UPDATE', { ...s4, status: 'LIVE', version: 5, actual_start: iso(0), state_changed_at: iso(0) }, { id: ID(4) });
  await expect(lead).toHaveText(/Hold/);
  await page.clock.runFor(200);
  await lead.click();
  await settle(page);
  expect(calls).toEqual([]);
  await page.clock.runFor(700);
  await lead.click();
  await settle(page);
  expect(calls).toEqual(['hold-stage']);
  await ctx.close();
});

test('phone: a press on Hold that spans the 1 s tick still lands', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const sel = `${MS} .ph-actions .btn:not(.danger)`;
  const node = await page.locator(sel).elementHandle();
  const b = await box(page, sel);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.clock.runFor(1200);
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/hold-stage'), { timeout: 5000 });
  await page.mouse.up();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: PANEL_ID });
  await ctx.close();
});

test('phone: the stage monitor and stage timer are reachable from the Now tab', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await expect(page.locator('#phone-now [data-fk="ph-timer"]')).toBeVisible();
  await page.locator('#phone-now [data-fk="ph-monitor"]').click();
  await expect(page.locator('#stage-monitor')).toBeVisible();
  await ctx.close();
});

// Every visible control a thumb can reach, on every tab, is at least 44 px both ways.
const TARGETS = 'button, select, input:not([type="checkbox"]), a[href], summary, [onclick]';
async function smallTargets(page: Page, scope: string) {
  return page.evaluate(([sc, sel]) => [...document.querySelectorAll(sc)].flatMap(root => [root, ...root.querySelectorAll(sel)])
    .filter(el => el.matches(sel)).filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight; })
    .filter(el => { const r = el.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; })
    .map(el => `${el.tagName}#${el.id}.${String(el.className).slice(0, 40)} "${(el.textContent || '').trim().slice(0, 24)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`), [scope, TARGETS] as const);
}
for (const role of ['director', 'stage'] as const) {
  test(`phone (${role}): every touch target is at least 44 px on every tab`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { ...PHONE, role });
    expect(await smallTargets(page, '#header, #phone-now, #phone-tabs')).toEqual([]);
    await page.locator('#bc-banner .bc-msg').click();
    expect(await smallTargets(page, '#bc-banner')).toEqual([]);
    await page.locator('#hamburger-btn').click();
    expect(await smallTargets(page, '#mobile-menu')).toEqual([]);
    await page.locator('#hamburger-btn').click();
    await page.locator('#phone-tabs [data-tab="schedule"]').click();
    await page.locator('#filter-toggle-btn').click();
    expect(await smallTargets(page, '#main-col')).toEqual([]);
    await page.locator('#phone-tabs [data-tab="log"]').click();
    expect(await smallTargets(page, '#sidebar')).toEqual([]);
    await page.locator('#phone-tabs [data-tab="send"]').click();
    expect(await smallTargets(page, '#bc-bar')).toEqual([]);
    await ctx.close();
  });
}

test('phone (ar): right to left, nothing scrolls sideways and the header fits', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, locale: 'ar' });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const id of ['#hdr-clock', '#conn-pill', '#room-pick', '#hamburger-btn']) {
    const b = await box(page, id);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  await expect(page.locator('#phone-tabs [data-tab="now"]')).toHaveText('الآن');
  await ctx.close();
});

test('desktop: the phone layout stays out of the way at 1440', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const id of ['#phone-now', '#phone-tabs', '#room-pick']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('#band')).toBeVisible();
  await expect(page.locator('#bc-input')).toBeVisible();
  await ctx.close();
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────
// Main Stage overruns by 7:45 (started 37 min before T0, 30 min planned), so the
// knock-on rounds up to +10, as in the band.
const overrun7 = () => overrunSessions().map(x => x.id === PANEL_ID ? { ...x, actual_start: iso(-37) } : x);
for (const role of ['director', 'stage'] as const) {
  test(`phone (${role}): an overrun puts Push following +10 on the Next card, and a tap applies it once to the following session`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { ...PHONE, role, sessions: overrun7() });
    await page.locator('#room-pick').selectOption('Main Stage');
    const push = page.locator(`${MS} .ph-next-card .ph-push`);
    await expect(push).toHaveText('Push following +10');
    expect(Math.round((await push.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    await expect(page.locator(`${MS} .ph-next-card`)).toContainText('12:05 now 12:15, at risk');
    const bodies: any[] = [];
    page.on('request', r => { if (r.url().includes('/functions/v1/apply-delay')) bodies.push(JSON.parse(r.postData() || '{}')); });
    await push.dblclick();
    await settle(page);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ session_id: ID(5), minutes: 10 });
    await ctx.close();
  });
}

test('phone: a role that cannot delay sees no Push following', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'av', sessions: overrun7() });
  await page.locator('#room-pick').selectOption('Main Stage');
  await expect(page.locator(`${MS} .ph-next-card`)).toBeVisible();
  await expect(page.locator('#phone-now .ph-push')).toHaveCount(0);
  await ctx.close();
});

const arrivalWrites = (page: Page) => {
  const w: any[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/leod_sessions')) w.push({ url: r.url(), body: JSON.parse(r.postData() || '{}') }); });
  return w;
};
const soonNext = `const s = S.sessions.find(x => x.id === '${ID(5)}'); s.scheduled_start = '11:48:00'; s.speaker_arrived = false; renderSessions();`;

test('phone: Mark arrived on the Next card writes once for that session and clears the Not arrived chip', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await page.locator('#room-pick').selectOption('Main Stage');
  await evalPage(page, soonNext);
  const next = page.locator(`${MS} .ph-next-card`);
  await expect(next.locator('.warnchip')).toHaveText(/Not arrived/i);
  const writes = arrivalWrites(page);
  const btn = next.locator('.ph-arrive');
  await expect(btn).toHaveText('Mark arrived');
  expect(Math.round((await btn.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await btn.click();
  await settle(page);
  expect(writes).toHaveLength(1);
  expect(writes[0].url).toContain(`id=eq.${ID(5)}`);
  expect(writes[0].body).toEqual({ speaker_arrived: true });
  await expect(next.locator('.warnchip')).toHaveCount(0);
  await expect(btn).toHaveText('Arrived');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await ctx.close();
});

test('phone: the Now card has the arrival toggle, and a failed write reverts it with a toast', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const btn = page.locator(`${MS} .ph-now-card .ph-arrive`);
  await expect(btn).toHaveText('Arrived');                      // the panel's speaker has arrived
  const hold0 = await box(page, `${MS} .ph-actions .btn:not(.danger)`);
  await page.route(/\/rest\/v1\/leod_sessions/, r => r.request().method() === 'PATCH'
    ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'permission denied', code: '42501' }) })
    : r.fallback());
  await btn.click();
  await expect(page.locator('#toast-container')).toContainText('permission denied');
  await expect(btn).toHaveText('Arrived');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').speaker_arrived`)).toBe(true);
  const hold1 = await box(page, `${MS} .ph-actions .btn:not(.danger)`);
  expect(near(hold1.y, hold0.y)).toBe(true);
  await ctx.close();
});

test('phone: roles without arrival rights get no toggle', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'av' });
  await expect(page.locator('#phone-now .ph-now-card').first()).toBeVisible();
  await expect(page.locator('#phone-now .ph-arrive')).toHaveCount(0);
  await ctx.close();
});

test('phone: with All rooms a roomless next session shows once, in the No room lane', async ({ browser }) => {
  // #6 loses its room: getNextSession would offer it to Main Stage as well as to No room.
  const sessions = demoSessions().map(x => x.id === ID(5) ? { ...x, status: 'ENDED', actual_end: iso(-1) } : x.id === ID(6) ? { ...x, room: null } : x);
  const { ctx, page } = await openConsole(browser, { ...PHONE, sessions });
  await expect(page.locator('#phone-now .ph-next-card', { hasText: 'Digital Pre-Order' })).toHaveCount(1);
  await expect(page.locator('#phone-now .ph-lane[data-room=""] .ph-next-card')).toContainText('Digital Pre-Order');
  const fks = await page.locator('#phone-now [data-fk]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.fk));
  expect(new Set(fks).size).toBe(fks.length);
  await ctx.close();
});

test('phone: the fold counts the chosen room, or the whole event for All rooms', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  await expect(page.locator('#phone-now .ph-fold')).toHaveText('1 completed · 1 cancelled');   // #1 Main Stage, #8 Hall B
  await page.locator('#room-pick').selectOption('Main Stage');
  await expect(page.locator('#phone-now .ph-fold')).toHaveText('1 completed');
  await page.locator('#room-pick').selectOption('Hall B');
  await expect(page.locator('#phone-now .ph-fold')).toHaveText('1 cancelled');
  await ctx.close();
});
