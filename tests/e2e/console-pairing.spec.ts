// tests/e2e/console-pairing.spec.ts
// Console side of display pairing and key reset (083). No live DB and no
// sign-in: the page functions are called directly and every Supabase request
// is answered by a mock. An unmocked Supabase request fails the test.
import { test, expect, type Page, type Route } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const NEW_DISP = '00000000-0000-4000-8000-0000000000d1';

interface Mock {
  linkAnswer: unknown;
  rotateAnswer: unknown;
  calls: string[];             // "METHOD path?query"
  bodies: Record<string, unknown>;
  unmocked: string[];
}

async function mockSupabase(page: Page, over: Partial<Pick<Mock, 'linkAnswer' | 'rotateAnswer'>> = {}) {
  const m: Mock = { linkAnswer: 'linked', rotateAnswer: true, calls: [], bodies: {}, unmocked: [], ...over };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const reply = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, headers: cors, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  // Native dialogs are not allowed in the console; any one fails the test.
  page.on('dialog', d => { m.unmocked.push('dialog ' + d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });
  page.on('websocket', ws => { if (/supabase\.co/.test(ws.url())) m.unmocked.push('ws ' + ws.url()); });
  await page.route(u => /(^|\.)supabase\.co$/.test(u.hostname), async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const u = new URL(req.url());
    const key = `${req.method()} ${u.pathname.replace('/rest/v1/', '')}${u.search}`;
    m.calls.push(key);
    try { m.bodies[u.pathname.split('/').pop()!] = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
    const path = u.pathname;
    if (path.endsWith('/rpc/display_pair_link'))     return reply(route, 200, m.linkAnswer);
    if (path.endsWith('/rpc/display_rotate_secret')) return reply(route, 200, m.rotateAnswer);
    if (path.endsWith('/leod_signage_displays')) {
      if (req.method() === 'POST')   return reply(route, 201, { id: NEW_DISP, event_id: EVENT_ID, name: 'Paired Display ABC' });
      if (req.method() === 'DELETE') return reply(route, 204);
      if (req.method() === 'PATCH')  return reply(route, 204);
      if (req.method() === 'GET')    return reply(route, 200, []);
    }
    m.unmocked.push(key);
    return reply(route, 403, { message: 'not mocked' });
  });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(`S.event = { id: '${EVENT_ID}', name: 'Probe event' }; S.userRole = 'director';`);
  return m;
}

const toastText = (page: Page) => page.locator('#toast-container .toast-msg').last();

test.describe('Console: pair a display by code', () => {

  test('links through display_pair_link and never touches the pairing table', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.evaluate(`pairDisplayByCode('abc-234')`);
    await expect(toastText(page)).toContainText(/paired/i);
    expect(m.bodies['display_pair_link']).toEqual({ p_code: 'ABC234', p_display_id: NEW_DISP });
    expect(m.calls.filter(c => c.includes('leod_signage_pairing'))).toEqual([]);
    expect(m.calls.some(c => c.startsWith('DELETE'))).toBe(false);
    expect(m.unmocked).toEqual([]);
  });

  for (const [answer, message] of [
    ['not_found', /invalid pairing code/i],
    ['expired',   /expired/i],
    ['used',      /already used/i],
    ['forbidden', /cannot pair/i],
  ] as const) {
    test(`'${answer}' deletes the display it just created and says why`, async ({ page }) => {
      const m = await mockSupabase(page, { linkAnswer: answer });
      await page.evaluate(`pairDisplayByCode('ABC234')`);
      await expect(toastText(page)).toContainText(message);
      expect(m.calls).toContain(`DELETE leod_signage_displays?id=eq.${NEW_DISP}`);
      expect(m.calls.filter(c => c.includes('leod_signage_pairing'))).toEqual([]);
      expect(m.unmocked).toEqual([]);
    });
  }

  test('pairing onto an existing display links that display and creates nothing', async ({ page }) => {
    const m = await mockSupabase(page);
    const LECTERN = '00000000-0000-4000-8000-0000000000d9';
    await page.evaluate(`S.displays = [{ id: '${LECTERN}', name: 'Lectern 43in', event_id: '${EVENT_ID}' }]`);
    await page.evaluate(`pairDisplayByCode('abc-234', '${LECTERN}')`);
    await expect(toastText(page)).toContainText('Screen linked to Lectern 43in');
    expect(m.bodies['display_pair_link']).toEqual({ p_code: 'ABC234', p_display_id: LECTERN });
    expect(m.calls.some(c => c.startsWith('POST leod_signage_displays'))).toBe(false);
    expect(m.calls.some(c => c.startsWith('DELETE'))).toBe(false);
    expect(m.unmocked).toEqual([]);
  });

  test('a refused code on an existing display deletes nothing and says why', async ({ page }) => {
    const m = await mockSupabase(page, { linkAnswer: 'expired' });
    const LECTERN = '00000000-0000-4000-8000-0000000000d9';
    await page.evaluate(`S.displays = [{ id: '${LECTERN}', name: 'Lectern 43in', event_id: '${EVENT_ID}' }]`);
    await page.evaluate(`pairDisplayByCode('abc-234', '${LECTERN}')`);
    await expect(toastText(page)).toBeVisible();
    await expect(toastText(page)).not.toContainText('Screen linked');
    expect(m.calls.some(c => c.startsWith('DELETE') || c.startsWith('POST leod_signage_displays'))).toBe(false);
  });

  test('the pairing box offers New display and every existing display', async ({ page }) => {
    await mockSupabase(page);
    await page.evaluate(`S.displays = [{ id: 'd1', name: 'Lectern 43in', event_id: '${EVENT_ID}' }, { id: 'd2', name: '<b>Lobby</b>', event_id: '${EVENT_ID}' }]; renderSignagePanel();`);
    const opts = page.locator('#sp-pair-target option');
    await expect(opts).toHaveText(['New display', 'Lectern 43in', '<b>Lobby</b>']);
  });

  test('if the cleanup delete fails, the operator is told to delete the display', async ({ page }) => {
    const m = await mockSupabase(page, { linkAnswer: 'expired' });
    await page.route(u => u.pathname.endsWith('/leod_signage_displays'), r =>
      r.request().method() === 'DELETE'
        ? r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"message":"boom"}' })
        : r.fallback());
    await page.evaluate(`pairDisplayByCode('ABC234')`);
    await expect(page.locator('#toast-container .toast-msg', { hasText: 'The unpaired display could not be removed; delete it from the list.' })).toHaveCount(1);
    await expect(toastText(page)).toContainText(/expired/i);
    expect(m.unmocked).toEqual([]);
  });

  test('a failed link call also removes the new display', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.route('**/rpc/display_pair_link', r => r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json', body: '{"message":"boom"}' }));
    await page.evaluate(`pairDisplayByCode('ABC234')`);
    await expect(toastText(page)).toContainText(/could not link/i);
    expect(m.calls).toContain(`DELETE leod_signage_displays?id=eq.${NEW_DISP}`);
  });

});

test.describe('Console: reset a display key', () => {

  const DISP = { id: NEW_DISP, event_id: EVENT_ID, name: 'Lobby TV', zone_type: 'lobby', orientation: 'landscape',
                 content_mode: 'schedule', display_secret: 'ab'.repeat(24) };
  const showCard = (page: Page) =>
    page.evaluate(`S.displays = [${JSON.stringify(DISP)}]; renderSignagePanel();`);
  // The panel lives behind the sign-in screen; click the button through the DOM.
  const clickReset = (page: Page) =>
    page.evaluate(() => (document.querySelector('.sp-card-mgmt button[onclick^="resetDisplayKey"]') as HTMLButtonElement).click());
  const resetBtn = (page: Page) => page.locator('.sp-card-mgmt button[onclick^="resetDisplayKey"]');

  test('each display card has a Reset key button', async ({ page }) => {
    const m = await mockSupabase(page);
    await showCard(page);
    await expect(resetBtn(page)).toHaveCount(1);
    await expect(resetBtn(page)).toHaveText('Reset key');
    expect(m.unmocked).toEqual([]);
  });

  test('the first click arms the button, the second calls display_rotate_secret and reloads', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const m = await mockSupabase(page);
    await showCard(page);
    await clickReset(page);
    await expect(resetBtn(page)).toHaveText('Click again to reset key');
    await expect(resetBtn(page)).toHaveClass(/confirm-pending/);
    expect(m.calls.filter(c => c.includes('display_rotate_secret'))).toEqual([]);
    await clickReset(page);
    await expect(toastText(page)).toContainText(/key reset/i);
    expect(m.bodies['display_rotate_secret']).toEqual({ p_display_id: NEW_DISP });
    // the toast comes before the reload, so wait for it
    await expect.poll(() => m.calls.filter(c => c.startsWith('GET leod_signage_displays')).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(m.unmocked).toEqual([]);
  });

  test('one click does nothing and disarms after 3 s', async ({ page }) => {
    const m = await mockSupabase(page);
    await showCard(page);
    await clickReset(page);
    await expect(resetBtn(page)).toHaveClass(/confirm-pending/);
    await expect(resetBtn(page)).toHaveText('Reset key', { timeout: 4500 });
    await expect(resetBtn(page)).not.toHaveClass(/confirm-pending/);
    // a click after disarming arms again rather than resetting
    await clickReset(page);
    await expect(resetBtn(page)).toHaveText('Click again to reset key');
    expect(m.calls.filter(c => c.includes('display_rotate_secret'))).toEqual([]);
    expect(m.unmocked).toEqual([]);
  });

  test('a refused reset says so', async ({ page }) => {
    const m = await mockSupabase(page, { rotateAnswer: false });
    await showCard(page);
    await clickReset(page);
    await clickReset(page);
    await expect(toastText(page)).toContainText(/could not reset/i);
    expect(m.unmocked).toEqual([]);
  });

});

test.describe('Console: push to all screens', () => {
  test('a Video Loop display is left out of a push to all screens', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.evaluate(`S.displays = [
      { id: 'lobby-1', name: 'Lobby', event_id: '${EVENT_ID}', content_mode: 'schedule' },
      { id: 'lect-1', name: 'Lectern', event_id: '${EVENT_ID}', content_mode: 'video' }]`);
    await page.evaluate(`sendGlobalOverride('sponsors')`);
    const patches = m.calls.filter(c => c.startsWith('PATCH leod_signage_displays'));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain('id=eq.lobby-1');
  });
});


test.describe('Console: video screens in step', () => {
  test('the panel says which in-step screens line up and which do not', async ({ page }) => {
    await mockSupabase(page);
    await page.evaluate(`
      _videoDur.set('https://x.test/a.mp4', 46.48); _videoDur.set('https://x.test/b.mp4', 46.48); _videoDur.set('https://x.test/c.mp4', 445.18);
      S.displays = [
        { id: 'a', name: 'Agenda Day 1', event_id: '${EVENT_ID}', content_mode: 'video', video_url: 'https://x.test/a.mp4', video_sync: true },
        { id: 'b', name: 'Agenda Day 2', event_id: '${EVENT_ID}', content_mode: 'video', video_url: 'https://x.test/b.mp4', video_sync: true },
        { id: 'c', name: 'Rolling Logos', event_id: '${EVENT_ID}', content_mode: 'video', video_url: 'https://x.test/c.mp4', video_sync: true }];
      renderSignagePanel();`);
    const html = await page.evaluate(`document.getElementById('sessions-list').textContent`) as string;
    expect(html).toContain('Agenda Day 1 and Agenda Day 2 roll together (0:46). Rolling Logos (7:25) has a different length');
    expect(html).toContain('Loop 0:46 · in step');
  });

  test('no note when every in-step screen has the same length, or a screen loops on its own', async ({ page }) => {
    await mockSupabase(page);
    await page.evaluate(`
      _videoDur.set('https://x.test/a.mp4', 46.48); _videoDur.set('https://x.test/c.mp4', 445.18);
      S.displays = [
        { id: 'a', name: 'Agenda Day 1', event_id: '${EVENT_ID}', content_mode: 'video', video_url: 'https://x.test/a.mp4', video_sync: true },
        { id: 'c', name: 'Rolling Logos', event_id: '${EVENT_ID}', content_mode: 'video', video_url: 'https://x.test/c.mp4', video_sync: false }];
      renderSignagePanel();`);
    const html = await page.evaluate(`document.getElementById('sessions-list').textContent`) as string;
    expect(html).not.toContain('roll together');
    expect(html).toContain('Loop 7:25 · own loop');
  });
});
