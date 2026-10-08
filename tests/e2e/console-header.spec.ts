// tests/e2e/console-header.spec.ts
// Spec 2 and 2.4: one 52 px header, top chrome at most 100 px, keyboard
// event switcher, system pill naming what failed, crew, View as for
// directors only, account menu with Tools, banner that collapses to a chip.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, iso, EVENT_ID, USER_ID } from './console-boot-mock';

test('header: one 52 px bar, no diagnostics strip or role bar, top chrome at most 100 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#diag-bar')).toHaveCount(0);
  await expect(page.locator('#role-bar')).toHaveCount(0);
  expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(52);
  const banner = (await page.locator('#bc-banner').boundingBox())?.height ?? 0;
  // Top chrome in stage 4 = everything above the band, banner excluded (spec: at most 100 px).
  const bandTop = (await page.locator('#band').boundingBox())!.y;
  expect(bandTop - banner).toBeLessThanOrEqual(100);   // top chrome = everything above the band
  // Name each emoji and its context, so a failure says what and where (CI once failed with only "true").
  const emoji = await page.locator('#header').evaluate(el => {
    const txt = (el.textContent || '').replace(/\s+/g, ' ');
    return [...txt.matchAll(/\p{Extended_Pictographic}/gu)].map(m => `U+${m[0].codePointAt(0)!.toString(16)} in "${txt.slice(Math.max(0, m.index! - 30), m.index! + 10)}"`);
  });
  expect(emoji).toEqual([]);
  await ctx.close();
});

test('header: the event switcher is a keyboard button with date and time zone', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#ev-switch')).toHaveJSProperty('tagName', 'BUTTON');
  await expect(page.locator('#event-name')).toHaveText('GTR North Africa 2026');
  await expect(page.locator('#event-sub')).toHaveText('Tue 6 Oct · Cairo UTC+3');
  await page.locator('#ev-switch').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ev-pill-dd')).toHaveClass(/open/);
  await expect(page.locator('#ev-switch')).toHaveAttribute('aria-expanded', 'true');
  await ctx.close();
});

test('header: the system pill says All systems, names a failing check, and its popover holds the diagnostics', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#conn-lbl')).toHaveText('All systems');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-ok/);
  await page.locator('#conn-pill').click();
  await expect(page.locator('#sys-pop')).toBeVisible();
  await expect(page.locator('#dl-db')).toBeVisible();
  await expect(page.locator('#ck-off')).toBeVisible();
  await evalPage(page, `S.rtStatus = 'error'; refreshDiag();`);
  await expect(page.locator('#conn-lbl')).toHaveText('Realtime not working');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-err/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sys-pop')).toBeHidden();
  await ctx.close();
});

test('header: crew pill counts roles online and lists the same people', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#crew-count')).toHaveText('Crew 3/5');
  await page.locator('#crew-pill').click();
  await expect(page.locator('#crew-list')).toContainText('Ahmed Fawzy');
  // The list shows exactly the roles the count counts (PRESENCE_ROLES); signage is in neither.
  await expect(page.locator('#crew-list li')).toHaveCount(3);
  await expect(page.locator('#crew-list')).not.toContainText('Bassem Lotfy');
  await ctx.close();
});

test('header: a director switches role from View as', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#viewas-btn')).toBeVisible();
  await page.locator('#viewas-btn').click();
  await page.locator('.rbtn[data-role="signage"]').click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  await expect(page.locator('#viewas-lbl')).toHaveText(/signage/i);
  await ctx.close();
});

// 5.2b (1): a Displays pill left of View as, directors only; the count is displays online
// (heartbeat within 60 s, as the signage panel counts them), and a click opens the signage panel.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  test(`header: ${viewport.width}: a director sees Displays with the online count, and it opens the signage panel`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { viewport });
    const btn = page.locator('#displays-btn');
    await expect(btn).toBeVisible();
    await expect(page.locator('#displays-count')).toHaveText('2');
    await expect(btn).toHaveAttribute('aria-label', 'Displays, 2 online');
    // immediately left of View as, on the same one-row header
    const d = (await btn.boundingBox())!, v = (await page.locator('#viewas-btn').boundingBox())!;
    expect(d.x + d.width).toBeLessThanOrEqual(v.x);
    expect(Math.abs((d.y + d.height / 2) - (v.y + v.height / 2))).toBeLessThan(1);
    expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(52);
    expect(await page.locator('#header').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (viewport.width === 1280) await expect(page.locator('#displays-btn .displays-lbl')).toBeHidden();
    else await expect(page.locator('#displays-btn .displays-lbl')).toHaveText('Displays');
    const emoji = await btn.evaluate(el => /\p{Extended_Pictographic}/u.test(el.textContent || ''));
    expect(emoji).toBe(false);
    await expect(btn.locator('svg use')).toHaveAttribute('href', '#i-monitor');
    await btn.click();
    expect(await evalPage(page, 'S.role')).toBe('signage');
    await expect(page.locator('#sessions-list .sp-display-card')).toHaveCount(2);
    await expect(page.locator('#viewas-lbl')).toHaveText(/signage/i);
    await ctx.close();
  });
}

// 5.2b fix round 1 (2): in the signage view the pill shows it is the current view, and a
// second press takes a real director back to the director view.
test('header: Displays is pressed in the signage view, and a second press returns to director', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const btn = page.locator('#displays-btn');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveClass(/is-active/);
  await btn.click();
  expect(await evalPage(page, 'S.role')).toBe('director');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).not.toHaveClass(/is-active/);
  await expect(page.locator('#sessions-list .sp-display-card')).toHaveCount(0);
  // From another view as (stage), Displays still opens signage
  await evalPage(page, `setRole('stage')`);
  await btn.click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  // ... and a second press returns to the view it came from (stage), not to director
  await btn.click();
  expect(await evalPage(page, 'S.role')).toBe('stage');
  await ctx.close();
});

test('header: the Displays count follows the heartbeat', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `S.displays[0].last_seen_at = new Date(Date.now() - 120_000).toISOString(); renderSessions();`);
  await expect(page.locator('#displays-count')).toHaveText('1');
  await ctx.close();
});

test('header: a stage operator never sees Displays', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await expect(page.locator('#role-lock')).toBeVisible();
  await expect(page.locator('#displays-btn')).toBeHidden();
  await ctx.close();
});

test('header: on a phone the director menu has Displays, which opens the signage panel', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 390, height: 844 }, touch: true });
  await expect(page.locator('#displays-btn')).toBeHidden();
  await page.locator('#hamburger-btn').click();
  const item = page.locator('#mobile-menu #mm-displays');
  await expect(item).toBeVisible();
  await expect(item).toContainText('Displays');
  await expect(item).toContainText('2');
  expect(Math.round((await item.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await item.click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  await ctx.close();
});

test('header: on a phone a locked operator has no Displays item', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', viewport: { width: 390, height: 844 }, touch: true });
  await page.locator('#hamburger-btn').click();
  await expect(page.locator('#mobile-menu #mm-displays')).toBeHidden();
  await ctx.close();
});

test('header: a stage operator sees their role, not the View as menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await expect(page.locator('#viewas-btn')).toBeHidden();
  await expect(page.locator('#role-lock')).toBeVisible();
  await expect(page.locator('#role-lock')).toHaveText(/stage/i);
  await ctx.close();
});

test('header: AI tools live in the account menu under Tools, never next to show controls', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#sidebar .sb-action-btn')).toHaveCount(0);
  const outside = await page.locator('[onclick*="CueDeckIncidentAdvisor.trigger"]').evaluateAll(els => els.filter(e => !e.closest('#profile-panel')).length);
  expect(outside).toBe(0);
  await page.locator('#user-chip').click();
  await expect(page.locator('#ai-agents-wrap')).toBeVisible();
  await expect(page.locator('#ai-agents-wrap button')).toHaveCount(3);
  for (const id of ['#checkin-btn', '#users-btn', '#lang-switcher', '#auto-start-btn']) await expect(page.locator(id)).toBeVisible();
  await ctx.close();
});

test('header: the broadcast banner is 28 px and collapses to a header chip once read', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(Math.round((await page.locator('#bc-banner').boundingBox())!.height)).toBe(28);
  await expect(page.locator('#bc-banner')).toContainText('11:32');
  await page.locator('#bc-banner .bc-dismiss').click();
  await expect(page.locator('#bc-banner')).toBeHidden();
  await expect(page.locator('#bc-chip')).toBeVisible();
  await page.locator('#bc-chip').click();
  await expect(page.locator('#bc-banner')).toBeVisible();
  await ctx.close();
});

test('header: a critical broadcast needs a second press through the shared arm; info sends on the first', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const writes: string[] = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/leod_broadcast') && r.method() !== 'GET') writes.push(r.method()); });
  const send = page.locator('#bc-send');
  await page.locator('#bc-input').fill('Evacuate Hall B');
  await page.locator('#bc-pri').selectOption('critical');
  await send.click();
  await expect(send).toHaveClass(/confirm-pending/);
  await expect(send).toHaveText('Press again to send');
  await expect(page.locator('#sr-announcer')).toHaveText('Press again to send');   // announced like End and Cancel
  expect(writes).toEqual([]);
  await page.clock.runFor(1500);                                                  // survives the 1 s re-render
  await expect(send).toHaveClass(/confirm-pending/);
  await send.click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(send).toHaveText('Send');
  // An arm that is not confirmed lapses after 3 s and sends nothing.
  await page.locator('#bc-input').fill('Evacuate Hall C');
  await send.click();
  await page.clock.runFor(3500);
  await expect(send).not.toHaveClass(/confirm-pending/);
  await expect(send).toHaveText('Send');
  expect(writes.length).toBe(1);
  await page.locator('#bc-input').fill('Doors open');
  await page.locator('#bc-pri').selectOption('info');
  await page.locator('#bc-input').press('Enter');
  await expect.poll(() => writes.length).toBe(2);
  await ctx.close();
});

test('header: the clock is 26 px bold and tabular, as in the approved demo (spec 9)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const st = await page.locator('#hdr-clock').evaluate(el => { const c = getComputedStyle(el); return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight), num: c.fontVariantNumeric }; });
  expect(st.size).toBeGreaterThanOrEqual(26);
  expect(st.weight).toBeGreaterThanOrEqual(700);
  expect(st.num).toContain('tabular-nums');
  await ctx.close();
});

// ── Fix round 1 ──────────────────────────────────────────────────────────
test('header: on a phone a director switches role from the menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 390, height: 844 }, touch: true });
  await page.locator('#hamburger-btn').click();
  await page.locator('#mobile-menu .mm-role[data-role="stage"]').click();
  expect(await evalPage(page, 'S.role')).toBe('stage');
  await ctx.close();
});

test('header: on a phone a locked operator sees no role items', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', viewport: { width: 390, height: 844 }, touch: true });
  await page.locator('#hamburger-btn').click();
  await expect(page.locator('#mobile-menu')).toBeVisible();
  await expect(page.locator('#mobile-menu .mm-role')).toHaveCount(6);       // present in the markup ...
  await expect(page.locator('#mobile-menu .mm-role:visible')).toHaveCount(0); // ... never shown to a locked role
  await ctx.close();
});

const BC = (o: Record<string, unknown>) => ({ id: EVENT_ID, event_id: EVENT_ID, message: 'Hall B on hold: projector signal lost. Main Stage running on time.', priority: 'warn', sent_at: iso(-8), ...o });

test('header: the banner names the sender and the time', async ({ browser }) => {
  for (const [sentBy, expected] of [[USER_ID, 'Nour · 11:32'], ['p2', 'Ahmed · 11:32'], ['ffffffff-0000-4000-8000-000000000000', 'Operator · 11:32'], [null, '11:32']] as const) {
    const { ctx, page } = await openConsole(browser, { broadcast: BC({ sent_by: sentBy }) });
    await expect(page.locator('#bc-banner .bc-when')).toHaveText(expected);
    await ctx.close();
  }
});

test('header: a sent broadcast records who sent it', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const bodies: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/leod_broadcast') && r.method() === 'POST') bodies.push(JSON.parse(r.postData() || '{}')); });
  await page.locator('#bc-input').fill('Doors open');
  await page.locator('#bc-input').press('Enter');
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].sent_by).toBe(USER_ID);
  await ctx.close();
});

test('header: editing an armed critical broadcast drops the arm; the next press only re-arms', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const writes: string[] = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/leod_broadcast') && r.method() !== 'GET') writes.push(r.method()); });
  const send = page.locator('#bc-send');
  await page.locator('#bc-input').fill('Evacuate Hall B');
  await page.locator('#bc-pri').selectOption('critical');
  await send.click();
  await expect(send).toHaveClass(/confirm-pending/);
  await page.locator('#bc-input').fill('Evacuate Hall C');
  await expect(send).not.toHaveClass(/confirm-pending/);
  await expect(send).toHaveText('Send');
  await send.click();                                   // within 3 s of the first press
  await expect(send).toHaveClass(/confirm-pending/);    // re-armed, not sent
  expect(writes).toEqual([]);
  await page.locator('#bc-pri').selectOption('warn');   // a priority change drops it too
  await expect(send).not.toHaveClass(/confirm-pending/);
  expect(writes).toEqual([]);
  await ctx.close();
});

test('header: crew counts people once, even with two tabs open', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `S.presenceList = [
    { role: 'director', userId: 'u1', name: 'Nour Selim' }, { role: 'director', userId: 'u1', name: 'Nour Selim' },
    { role: 'stage', userId: 'u2', name: 'Ahmed Fawzy' }, { role: 'av', userId: 'u3', name: 'Mona Adel' }];
    S.presence = { director: 2, stage: 1, av: 1 }; refreshPresence();`);
  await expect(page.locator('#crew-count')).toHaveText('Crew 3/5');
  await expect(page.locator('#crew-list li')).toHaveCount(3);
  expect(await page.locator('#crew-list').evaluate(el => (el.textContent || '').split('Nour Selim').length - 1)).toBe(1);
  await ctx.close();
});

test('header: Escape closes a popover and gives focus back to its button', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#conn-pill').click();
  await expect(page.locator('#sys-pop')).toBeVisible();
  await page.locator('#sys-pop-title').click();          // focus leaves the pill
  await page.keyboard.press('Escape');
  await expect(page.locator('#sys-pop')).toBeHidden();
  await expect(page.locator('#conn-pill')).toBeFocused();
  await ctx.close();
});

test('header: Escape closes the broadcast Presets menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#bc-presets-menu > summary').click();
  await expect(page.locator('#bc-presets-menu')).toHaveJSProperty('open', true);
  await page.locator('#bc-bar .lbl').click();            // focus leaves the summary
  await page.keyboard.press('Escape');
  await expect(page.locator('#bc-presets-menu')).toHaveJSProperty('open', false);
  await expect(page.locator('#bc-presets-menu > summary')).toBeFocused();
  await ctx.close();
});

test('header: View as reads in sentence case', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#viewas-lbl')).toHaveText('View as director');
  await ctx.close();
});
