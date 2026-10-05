// tests/e2e/console-pairing.spec.ts
// Console side of display pairing and key reset (083). No live DB and no
// sign-in: the page functions are called directly and every Supabase request
// is answered by a mock. An unmocked Supabase request fails the test.
import { test, expect, type Page, type Route } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';
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

  test('each display card has a Reset key button', async ({ page }) => {
    await mockSupabase(page);
    await page.evaluate(`S.displays = [${JSON.stringify(DISP)}]; renderSignagePanel();`);
    await expect(page.locator('.sp-card-mgmt button', { hasText: 'Reset key' })).toHaveCount(1);
  });

  test('confirming calls display_rotate_secret and reloads the displays', async ({ page }) => {
    const m = await mockSupabase(page);
    let asked = '';
    page.on('dialog', d => { asked = d.message(); d.accept(); });
    await page.evaluate(`S.displays = [${JSON.stringify(DISP)}]; resetDisplayKey('${NEW_DISP}')`);
    await expect(toastText(page)).toContainText(/key reset/i);
    expect(asked).toBe("Reset this display's key? The screen will need to be paired again.");
    expect(m.bodies['display_rotate_secret']).toEqual({ p_display_id: NEW_DISP });
    expect(m.calls.filter(c => c.startsWith('GET leod_signage_displays')).length).toBeGreaterThan(0);
    expect(m.unmocked).toEqual([]);
  });

  test('cancelling does nothing', async ({ page }) => {
    const m = await mockSupabase(page);
    page.on('dialog', d => d.dismiss());
    await page.evaluate(`S.displays = [${JSON.stringify(DISP)}]; resetDisplayKey('${NEW_DISP}')`);
    await page.waitForTimeout(300);
    expect(m.calls.filter(c => c.includes('display_rotate_secret'))).toEqual([]);
  });

  test('a refused reset says so', async ({ page }) => {
    await mockSupabase(page, { rotateAnswer: false });
    page.on('dialog', d => d.accept());
    await page.evaluate(`S.displays = [${JSON.stringify(DISP)}]; resetDisplayKey('${NEW_DISP}')`);
    await expect(toastText(page)).toContainText(/could not reset/i);
  });

});
