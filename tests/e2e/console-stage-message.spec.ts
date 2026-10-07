// tests/e2e/console-stage-message.spec.ts
// Message to speaker (owner-approved mock, 7 Oct; brief task-msg section 3): a director or
// stage operator sends a short message (a preset or their own text, at most 60 characters)
// for the selected session through stage_message_send, and clears it through
// stage_message_clear. The inspector shows it under Screens; the stage monitor shows the
// yellow band for the session it displays; the phone opens a small sheet from the Now card.
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { openConsole, evalPage, rtPush, afterBootReread, ID, PANEL_ID, EVENT_ID, USER_ID, SB, iso, demoSessions } from './console-boot-mock';

const insp = (page: Page) => page.locator('#ctx-wrap');
const sec = (page: Page) => insp(page).locator('.insp-msg');
const PHONE = { viewport: { width: 390, height: 844 }, touch: true } as const;
const MSG_ID = 'f0000000-0000-4000-8000-000000000001';
const msgRow = (o: Record<string, unknown> = {}) => ({
  id: MSG_ID, event_id: EVENT_ID, session_id: PANEL_ID, text: 'Please wrap up', sent_by: 'op-1',
  sent_at: iso(-1), cleared_at: null, cleared_by: null, ...o,
});
const panelRow = (o: Record<string, unknown>) => ({ ...demoSessions().find(s => s.id === PANEL_ID)!, ...o });

type Rpc = { status: number; body: unknown };
// Both RPCs answered on the page (page routes win over the boot harness's context routes);
// every call's JSON body is recorded.
async function mockRpcs(page: Page, o: { send?: (b: any) => Rpc; clear?: (b: any) => Rpc } = {}) {
  const calls = { send: [] as any[], clear: [] as any[] };
  const reply = (r: import('@playwright/test').Route, x: Rpc) =>
    r.fulfill({ status: x.status, contentType: 'application/json', body: JSON.stringify(x.body), headers: { 'access-control-allow-origin': '*' } });
  await page.route(`${SB}/rest/v1/rpc/stage_message_send`, r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const b = r.request().postDataJSON(); calls.send.push(b);
    return reply(r, o.send ? o.send(b) : { status: 200, body: { id: 'f0000000-0000-4000-8000-0000000000' + String(calls.send.length).padStart(2, '0'), session_id: b.p_session_id, text: b.p_text, sent_at: iso(0) } });
  });
  await page.route(`${SB}/rest/v1/rpc/stage_message_clear`, r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const b = r.request().postDataJSON(); calls.clear.push(b);
    return reply(r, o.clear ? o.clear(b) : { status: 200, body: true });
  });
  return calls;
}
const pgErr = (code: string, message: string, status = 400): Rpc => ({ status, body: { code, message, details: null, hint: null } });

test('message: a director sees the section under Screens, a preset sends once with the right session and text, and the strip shows it', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const calls = await mockRpcs(page);
  await expect(sec(page)).toHaveCount(1);
  await expect(sec(page).locator('.lbl')).toHaveText('Message to speaker · Main Stage');
  // Order: Screens, then the message, then Session
  const labels = await insp(page).locator('.insp-sec > .lbl').allTextContents();
  expect(labels.indexOf('Message to speaker · Main Stage')).toBe(labels.indexOf('Screens') + 1);
  expect(labels.indexOf('Session')).toBe(labels.indexOf('Screens') + 2);
  await expect(sec(page).locator('.msg-preset')).toHaveText(['5 minutes left', 'Please wrap up', 'Take questions now', 'Speak closer to the mic', 'Stop now']);
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
  await sec(page).locator('.msg-preset', { hasText: 'Please wrap up' }).click();
  await expect(sec(page).locator('.msg-strip')).toHaveText(/On the stage timer now:\s*Please wrap up/);
  expect(calls.send).toEqual([{ p_event_id: EVENT_ID, p_session_id: PANEL_ID, p_text: 'Please wrap up' }]);
  await page.clock.runFor(1100);   // survives the 1 s re-render
  await expect(sec(page).locator('.msg-strip .msg-strip-text')).toHaveText('Please wrap up');
  await ctx.close();
});

test('message: a stage operator sees the section; av, interp and reg do not', async ({ browser }) => {
  for (const role of ['stage', 'av', 'interp', 'reg']) {
    const { ctx, page } = await openConsole(browser, { role });
    await expect(page.locator('#ctx-wrap .insp-msg'), role).toHaveCount(role === 'stage' ? 1 : 0);
    await expect(page.locator('.msg-preset'), role).toHaveCount(role === 'stage' ? 5 : 0);
    await ctx.close();
  }
});

test('message: own text is at most 60 characters with a counter, and a 61st character cannot be typed', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const calls = await mockRpcs(page);
  const input = sec(page).locator('input.msg-in');
  await expect(input).toHaveAttribute('maxlength', '60');
  await expect(sec(page).locator('.msg-count')).toHaveText('0/60');
  await expect(sec(page).locator('.msg-send')).toBeDisabled();
  const sixty = 'Your microphone is off, please switch it on and start again!';
  expect(sixty.length).toBe(60);
  await input.click();
  await page.keyboard.type(sixty + 'X');
  await expect(input).toHaveValue(sixty);
  await expect(sec(page).locator('.msg-count')).toHaveText('60/60');
  await sec(page).locator('.msg-send').click();
  await expect(sec(page).locator('.msg-strip-text')).toHaveText(sixty);
  expect(calls.send).toEqual([{ p_event_id: EVENT_ID, p_session_id: PANEL_ID, p_text: sixty }]);
  await expect(sec(page).locator('input.msg-in')).toHaveValue('');   // sent, so the draft is done
  await ctx.close();
});

test('message: typing survives the 1 s re-render with focus and caret kept, and Enter sends', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const calls = await mockRpcs(page);
  await sec(page).locator('input.msg-in').click();
  await page.keyboard.type('Mic chec');
  await page.clock.runFor(2100);
  await page.keyboard.type('k');
  await expect(sec(page).locator('input.msg-in')).toHaveValue('Mic check');
  await expect(sec(page).locator('input.msg-in')).toBeFocused();
  await sec(page).locator('input.msg-in').evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));   // caret to the start (Home differs by platform)
  await page.clock.runFor(1100);
  await page.keyboard.type('1 ');
  await expect(sec(page).locator('input.msg-in')).toHaveValue('1 Mic check');
  await page.keyboard.press('Enter');
  await expect(sec(page).locator('.msg-strip-text')).toHaveText('1 Mic check');
  expect(calls.send.map(b => b.p_text)).toEqual(['1 Mic check']);
  await ctx.close();
});

test('message: Escape in the input does not clear the filters', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `F.text = 'panel'; buildFilterBar(); renderSessions();`);
  await sec(page).locator('input.msg-in').click();
  await page.keyboard.type('Hi');
  await page.keyboard.press('Escape');
  expect(await evalPage(page, 'F.text')).toBe('panel');
  await ctx.close();
});

test('message: Clear calls stage_message_clear and the strip goes away', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { stageMessages: [msgRow()] });
  const calls = await mockRpcs(page);
  await expect(sec(page).locator('.msg-strip')).toHaveText(/On the stage timer now:\s*Please wrap up/);
  await sec(page).locator('.msg-clear').click();
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
  expect(calls.clear).toEqual([{ p_event_id: EVENT_ID, p_session_id: PANEL_ID }]);
  await ctx.close();
});

test('message: realtime INSERT from another operator shows the strip, an UPDATE with cleared_at hides it', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await afterBootReread(page);
  expect(await rtPush(page, 'leod_stage_messages', 'INSERT', msgRow({ text: 'Take questions now' }))).toBeGreaterThan(0);
  await expect(sec(page).locator('.msg-strip-text')).toHaveText('Take questions now');
  await rtPush(page, 'leod_stage_messages', 'UPDATE', msgRow({ text: 'Take questions now', cleared_at: iso(0), cleared_by: 'op-1' }));
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
  await ctx.close();
});

test('message: when the session ends by realtime the strip goes away', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { stageMessages: [msgRow()] });
  await afterBootReread(page);
  await page.locator(`#card-${PANEL_ID} .sc-title`).click();
  await expect(sec(page).locator('.msg-strip-text')).toHaveText('Please wrap up');
  await rtPush(page, 'leod_sessions', 'UPDATE', panelRow({ status: 'ENDED', version: 10, actual_end: iso(0), state_changed_at: iso(0) }));
  await expect.poll(() => evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').status`)).toBe('ENDED');
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(page.locator('.msg-strip')).toHaveCount(0);
  await expect(sec(page)).toHaveCount(0);   // an ended session takes no message
  // Restarted to READY later: the old message does not come back as queued
  await rtPush(page, 'leod_sessions', 'UPDATE', panelRow({ status: 'READY', version: 11, actual_start: null, actual_end: null }));
  await expect(sec(page)).toHaveCount(1);
  await expect(page.locator('.msg-strip')).toHaveCount(0);
  await ctx.close();
});

test('message: a queued message on a READY session shows as "Queued:"', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { stageMessages: [msgRow({ session_id: ID(5), text: '5 minutes left' })] });
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);   // the LIVE panel has none
  await page.locator(`#card-${ID(5)} .sc-title`).click();
  await expect(sec(page).locator('.lbl')).toHaveText('Message to speaker · Main Stage');
  await expect(sec(page).locator('.msg-strip')).toHaveText(/Queued:\s*5 minutes left/);
  await ctx.close();
});

test('message: the stage monitor shows the yellow band between its body and footer, for the session it shows only', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { stageMessages: [msgRow({ session_id: ID(2), text: 'Hall B message' })] });
  await insp(page).locator('[data-fk="insp-monitor"]').click();
  await expect(page.locator('#stage-monitor')).toBeVisible();
  await expect(page.locator('#sm-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(page.locator('#sm-message')).toBeHidden();   // Hall B's message is not the panel's
  await rtPush(page, 'leod_stage_messages', 'INSERT', msgRow());
  await expect(page.locator('#sm-message')).toBeVisible();
  await expect(page.locator('#sm-message-lbl')).toHaveText('Message from the director');
  await expect(page.locator('#sm-message-text')).toHaveText('Please wrap up');
  const body = (await page.locator('#sm-body').boundingBox())!;
  const band = (await page.locator('#sm-message').boundingBox())!;
  const foot = (await page.locator('#sm-footer').boundingBox())!;
  expect(band.y).toBeGreaterThanOrEqual(body.y + body.height - 0.5);
  expect(band.y + band.height).toBeLessThanOrEqual(foot.y + 0.5);
  expect(band.width).toBeGreaterThan(1400);
  // The countdown stays on screen above the band
  const timer = (await page.locator('#sm-timer').boundingBox())!;
  expect(timer.y + timer.height).toBeLessThanOrEqual(band.y);
  await rtPush(page, 'leod_stage_messages', 'UPDATE', msgRow({ cleared_at: iso(0) }));
  await expect(page.locator('#sm-message')).toBeHidden();
  await ctx.close();
});

test('message: at 1280x720 a 60-character message, the countdown and the footer all fit on the stage monitor', async ({ browser }) => {
  const sixty = 'Your microphone is off, please switch it on and start again!';
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 }, stageMessages: [msgRow({ text: sixty })] });
  await insp(page).locator('[data-fk="insp-monitor"]').click();
  await expect(page.locator('#sm-message-text')).toHaveText(sixty);
  const timer = (await page.locator('#sm-timer').boundingBox())!;
  const band = (await page.locator('#sm-message').boundingBox())!;
  const foot = (await page.locator('#sm-footer').boundingBox())!;
  expect(timer.y + timer.height).toBeLessThanOrEqual(band.y);
  expect(band.y + band.height).toBeLessThanOrEqual(foot.y + 0.5);
  expect(foot.y + foot.height).toBeLessThanOrEqual(720.5);
  const txt = await page.locator('#sm-message-text').evaluate(el => [el.scrollHeight, el.clientHeight]);
  expect(txt[0]).toBeLessThanOrEqual(txt[1] + 4);   // the whole text: a clipped third line would add a line height, not glyph overhang
  await ctx.close();
});

test('message: log rows read in plain words', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = (id: number, action: string) => ({ id, event_id: EVENT_ID, action, session_id: PANEL_ID, from_status: null, to_status: null,
    payload: { text: 'Please wrap up', session_id: PANEL_ID }, ts: iso(0) });
  await rtPush(page, 'leod_event_log', 'INSERT', row(2001, 'STAGE_MESSAGE'));
  await expect(page.locator('#log-feed .lg').first().locator('.lg-what')).toContainText('Message to speaker: Please wrap up');
  await rtPush(page, 'leod_event_log', 'INSERT', row(2002, 'STAGE_MESSAGE_CLEARED'));
  const first = page.locator('#log-feed .lg').first();
  await expect(first.locator('.lg-what')).toContainText('Message cleared: Please wrap up');
  await expect(first.locator('.lg-kind')).toHaveText('Message');
  for (const txt of await page.locator('#log-feed .lg').allTextContents()) {
    expect(txt).not.toContain('STAGE_MESSAGE');
    expect(txt).not.toContain('{');
  }
  await ctx.close();
});

test('message: refused sends show a translated toast and nothing is shown as sent', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  let code = '42501';
  await mockRpcs(page, { send: () => pgErr(code, 'not allowed', code === '42501' ? 403 : 400) });
  await sec(page).locator('.msg-preset').first().click();
  await expect(page.locator('#toast-container .toast-error')).toContainText('Not allowed');
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
  await page.locator('#toast-container').evaluate(el => el.replaceChildren());
  code = '55000';
  await page.clock.runFor(700);   // past the press guard
  await sec(page).locator('.msg-preset').nth(1).click();
  await expect(page.locator('#toast-container .toast-error')).toContainText('this session has ended');
  await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
  await ctx.close();
});

test('message: the other refusals map to their own words', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const words = await evalPage(page, `['22023','P0002'].map(c => stageMsgError({ code: c, message: 'x' }))`) as string[];
  expect(words[0]).toContain('1 to 60 characters');
  expect(words[1]).toContain('Session not found');
  await ctx.close();
});

test('message: phone: the Now card opens a sheet that sends', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE });
  const calls = await mockRpcs(page);
  const btn = page.locator('#phone-now .ph-lane[data-room="Main Stage"] .ph-now-card .ph-msg-btn');
  await expect(btn).toHaveText('Message to speaker');
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#msg-sheet')).toBeHidden();
  await btn.click();
  await expect(page.locator('#msg-sheet')).toBeVisible();
  await expect(page.locator('#msg-sheet .lbl').first()).toHaveText('Message to speaker · Main Stage');
  for (const b of await page.locator('#msg-sheet .msg-preset, #msg-sheet .msg-send, #msg-sheet input.msg-in').all())
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.clock.runFor(1100);   // the Now tab's re-render does not touch the sheet
  await page.locator('#msg-sheet .msg-preset', { hasText: 'Stop now' }).click();
  await expect(page.locator('#msg-sheet .msg-strip-text')).toHaveText('Stop now');
  expect(calls.send).toEqual([{ p_event_id: EVENT_ID, p_session_id: PANEL_ID, p_text: 'Stop now' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(page.locator('#msg-sheet')).toBeHidden();
  await ctx.close();
});

test('message: phone: av has no message button', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'av' });
  await expect(page.locator('.ph-msg-btn')).toHaveCount(0);
  await ctx.close();
});

for (const locale of ['en', 'ar', 'pl', 'de'] as const) {
  test(`message: ${locale}: every string is translated and has no em-dash`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { locale });
    const keys = ['cc.msg.title', 'cc.msg.titleRoom', 'cc.msg.p.fiveMin', 'cc.msg.p.wrapUp', 'cc.msg.p.questions', 'cc.msg.p.mic', 'cc.msg.p.stop',
      'cc.msg.placeholder', 'cc.msg.inputLabel', 'cc.msg.send', 'cc.msg.clear', 'cc.msg.onNow', 'cc.msg.queued', 'cc.msg.hint', 'cc.msg.hintRoom',
      'cc.msg.fromDirector', 'cc.msg.close', 'cc.msg.err.forbidden', 'cc.msg.err.ended', 'cc.msg.err.length', 'cc.msg.err.notFound',
      'cc.msg.err.failed', 'cc.msg.err.clearFailed', 'cc.msg.err.loadFailed', 'cc.log.k.message', 'cc.log.msgSent', 'cc.log.msgCleared'];
    const vals = await evalPage(page, `${JSON.stringify(keys)}.map(k => t(k))`) as string[];
    vals.forEach((v, i) => { expect(v, keys[i]).not.toBe(keys[i]); expect(v, keys[i]).not.toContain('—'); });
    // The section renders in the operator's language
    await expect(sec(page).locator('.msg-preset').first()).toHaveText(vals[2]);
    await ctx.close();
  });
}

test('message: Hold and End never move when the strip appears or goes, LIVE and HOLD', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await afterBootReread(page);
  for (const [sid, lead] of [[PANEL_ID, '.insp-primary .hold'], [ID(2), '.insp-primary .fwd-go']] as const) {
    await page.locator(`#card-${sid} .sc-title`).click();
    await page.clock.runFor(700);
    const boxes = async () => Promise.all([lead, '.insp-primary .btn.danger'].map(async s => (await insp(page).locator(s).boundingBox())!));
    const before = await boxes();
    await rtPush(page, 'leod_stage_messages', 'INSERT', msgRow({ id: 'f0000000-0000-4000-8000-0000000000a' + (sid === PANEL_ID ? '1' : '2'), session_id: sid }));
    await expect(sec(page).locator('.msg-strip')).toHaveCount(1);
    expect(await boxes()).toEqual(before);
    await rtPush(page, 'leod_stage_messages', 'UPDATE', msgRow({ id: 'f0000000-0000-4000-8000-0000000000a' + (sid === PANEL_ID ? '1' : '2'), session_id: sid, cleared_at: iso(0) }));
    await expect(sec(page).locator('.msg-strip')).toHaveCount(0);
    expect(await boxes()).toEqual(before);
  }
  await ctx.close();
});

// Review screenshots for the plan (not a baseline): MSG_SHOTS_DIR=<dir> runs it.
test('message: review screenshots', async ({ browser }) => {
  const dir = process.env.MSG_SHOTS_DIR;
  test.skip(!dir, 'MSG_SHOTS_DIR not set');
  fs.mkdirSync(dir!, { recursive: true });
  const { ctx, page } = await openConsole(browser, { stageMessages: [msgRow({ sent_by: USER_ID })] });
  // At 1440x900 the open log leaves the inspector short, so the section is reached by scrolling it
  await sec(page).evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: path.join(dir!, 'msg-console-1440.png'), animations: 'disabled', caret: 'hide' });
  await page.locator('#log-toggle').click();   // minimised log: the inspector takes the height
  await sec(page).evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: path.join(dir!, 'msg-console-1440-logmin.png'), animations: 'disabled', caret: 'hide' });
  await insp(page).locator('[data-fk="insp-monitor"]').click();
  await page.screenshot({ path: path.join(dir!, 'msg-monitor.png'), animations: 'disabled', caret: 'hide' });
  await ctx.close();
});
