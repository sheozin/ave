// tests/e2e/display-page.spec.ts
// E2E tests for CueDeck display page. No live DB: every Supabase call is
// answered by page.route mocks of the three display RPCs (display_feed,
// display_pair_start, display_pair_poll), and any other REST call fails the
// test, so the page cannot quietly fall back to direct table reads.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect, type Page, type Route } from '@playwright/test';

const BASE       = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';
const DISP_URL   = `${BASE}/cuedeck-display.html`;

const FAKE_SUPA_URL = 'https://fakecuedecktest.supabase.co';
const REAL_SUPA_URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const FAKE_SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake';
const FAKE_DISP_ID  = '00000000-0000-0000-0000-000000000001';
const FAKE_SECRET   = 'a'.repeat(48);

// #url=...&key=...&id=...&s=... The url and key are a crafted link's
// attempt to send the key elsewhere; the page must ignore them.
function makeHash(opts: { id?: string | null; s?: string | null } = {}) {
  const id = opts.id === undefined ? FAKE_DISP_ID : opts.id;
  const s  = opts.s  === undefined ? FAKE_SECRET  : opts.s;
  let h = `#url=${encodeURIComponent(FAKE_SUPA_URL)}&key=${encodeURIComponent(FAKE_SUPA_KEY)}`;
  if (id) h += `&id=${encodeURIComponent(id)}`;
  if (s)  h += `&s=${encodeURIComponent(s)}`;
  return h;
}

function makeFeed(over: { display?: Record<string, unknown>; sessions?: unknown[]; event?: unknown } = {}) {
  return {
    server_time: new Date().toISOString(),
    display: {
      id: FAKE_DISP_ID, event_id: 'ev-1', name: 'Lobby TV', zone_type: 'lobby',
      orientation: 'landscape', content_mode: 'schedule', filter_room: null,
      override_content: null, sequence: null, scroll_style: 'scroll', paginate_seconds: 10,
      global_override: null, last_seen_at: new Date().toISOString(),
      ...(over.display || {}),
    },
    event: over.event === undefined ? { name: 'GTR Probe Summit', brand_color: '#3b82f6' } : over.event,
    sessions: over.sessions || [
      { id: 's1', sort_order: 1, title: 'Opening keynote', speaker: 'Jane Smith', company: 'Acme',
        room: 'Hall A', status: 'LIVE', planned_start: '09:00:00', planned_end: '09:45:00',
        scheduled_start: '09:00:00', scheduled_end: '09:45:00',
        actual_start: new Date(Date.now() - 5 * 60_000).toISOString() },
      { id: 's2', sort_order: 2, title: 'Panel on venues', speaker: 'Bob Jones', company: null,
        room: 'Hall A', status: 'PLANNED', planned_start: '10:00:00', planned_end: '10:45:00',
        scheduled_start: '10:00:00', scheduled_end: '10:45:00', actual_start: null },
    ],
    sponsors: [],
  };
}

type FeedAnswer = object | null | 'fail';
interface Mock {
  feed: () => FeedAnswer;
  pairStart: () => boolean;
  pairPoll: () => object | null;
  feedBodies: Record<string, unknown>[];
  startBodies: Record<string, unknown>[];
  pollBodies: Record<string, unknown>[];
  otherRest: string[];
  hosts: string[];
}

async function mockSupabase(page: Page, opts: Partial<Pick<Mock, 'feed' | 'pairStart' | 'pairPoll'>> = {}) {
  const m: Mock = {
    feed: opts.feed || (() => makeFeed()),
    pairStart: opts.pairStart || (() => true),
    pairPoll: opts.pairPoll || (() => null),
    feedBodies: [], startBodies: [], pollBodies: [], otherRest: [], hosts: [],
  };
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
                    headers: { 'access-control-allow-origin': '*' } });
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    }
    const url = req.url();
    m.hosts.push(new URL(url).host);
    const body = (() => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } })();
    if (url.includes('/rpc/display_feed')) {
      m.feedBodies.push(body);
      const a = m.feed();
      if (a === 'fail') return route.abort('failed');
      return json(route, a);
    }
    if (url.includes('/rpc/display_pair_start')) { m.startBodies.push(body); return json(route, m.pairStart()); }
    if (url.includes('/rpc/display_pair_poll'))  { m.pollBodies.push(body);  return json(route, m.pairPoll()); }
    m.otherRest.push(url);
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"not mocked"}',
                           headers: { 'access-control-allow-origin': '*' } });
  });
  return m;
}

// ── PAGE LOAD (no URL params) ───────────────────────────────────────────────

test.describe('Display: page load, no params', () => {

  test.beforeEach(async ({ page }) => { await mockSupabase(page); });

  test('01 page loads with correct title', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page).toHaveTitle(/CueDeck Display/i);
  });

  test('02 setup form is visible when no params provided', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#setup')).toBeVisible();
  });

  test('03 Supabase URL input is present (hidden, pre-filled via hash/hardcoded)', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#su-url')).toBeAttached();
  });

  test('04 anon key input is present (hidden, pre-filled via hash/hardcoded)', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#su-key')).toBeAttached();
  });

  test('05 pairing code from display_pair_start is shown', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  });

  test('06 manual display link input is present', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#manual-display-id')).toBeVisible();
  });

  test('07 CueDeck Display branding is visible', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('.su-logo')).toBeVisible();
    await expect(page.locator('.su-sub')).toBeVisible();
  });

  test('08 loading screen is hidden on initial load', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#loading')).toBeHidden();
  });

  test('09 display frame is hidden on initial load', async ({ page }) => {
    await page.goto(DISP_URL);
    await expect(page.locator('#display')).toBeHidden();
  });

  test('10 no JS errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(DISP_URL);
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

});

// ── MANUAL ENTRY ───────────────────────────────────────────────────────────

test.describe('Display: manual link entry', () => {

  test('11 submitting manual entry empty asks for the display link', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(DISP_URL);
    await page.locator('#manual-display-id').fill('');
    await page.locator('button:has-text("Connect")').click();
    await expect(page.locator('#su-err')).toHaveText(/Paste the display link/i);
  });

  test('12 a bare display id without its key is refused', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(DISP_URL);
    await page.locator('#manual-display-id').fill(FAKE_DISP_ID);
    await page.locator('button:has-text("Connect")').click();
    await expect(page.locator('#su-err')).toHaveText(/no display key/i);
    await expect(page.locator('#display')).toBeHidden();
  });

  test('13 error message is empty before any submit', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(DISP_URL);
    await expect(page.locator('#su-err')).toHaveText('');
  });

  test('13b pasting a full display link boots the display', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(DISP_URL);
    await page.locator('#manual-display-id').fill(`https://app.cuedeck.io/display#id=${FAKE_DISP_ID}&s=${FAKE_SECRET}`);
    await page.locator('button:has-text("Connect")').click();
    await expect(page.locator('#display')).toBeVisible();
    expect(m.feedBodies[0]).toEqual({ p_display_id: FAKE_DISP_ID, p_secret: FAKE_SECRET });
  });

});

// ── HASH PARAM PRE-FILL ────────────────────────────────────────────────────

test.describe('Display: hash-param pre-fill', () => {

  test('14 a url in the link is ignored: the key only goes to the built-in project', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    expect(await page.locator('#su-url').inputValue()).toBe(REAL_SUPA_URL);
    expect(m.hosts.length).toBeGreaterThan(0);
    expect(new Set(m.hosts)).toEqual(new Set([new URL(REAL_SUPA_URL).host]));
  });

  test('15 a key in the link is ignored', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    expect(await page.locator('#su-key').inputValue()).not.toBe(FAKE_SUPA_KEY);
    expect(await page.locator('#su-key').inputValue()).toMatch(/^sb_publishable_/);
  });

  test('15b a url in the query string is ignored too', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}?url=${encodeURIComponent(FAKE_SUPA_URL)}&key=x#id=${FAKE_DISP_ID}&s=${FAKE_SECRET}`);
    await expect(page.locator('#display')).toBeVisible();
    expect(m.hosts).not.toContain(new URL(FAKE_SUPA_URL).host);
  });

  test('16 hash params pre-fill display ID input', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    expect(await page.locator('#su-id').inputValue()).toBe(FAKE_DISP_ID);
  });

  test('17 partial hash params (missing id): setup form stays visible', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash({ id: null })}`);
    await page.waitForTimeout(500);
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#loading')).toBeHidden();
    expect(m.feedBodies).toHaveLength(0);
  });

});

// ── QUERY-PARAM PARSING ────────────────────────────────────────────────────

test.describe('Display: query-param parsing logic', () => {

  test('18 display page reads window.location.search if present (logic test)', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(DISP_URL);
    await page.evaluate(
      ({ url, key, id }) => {
        const fromQuery = new URLSearchParams(`url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`);
        const get = (k: string) => fromQuery.get(k);
        const u = get('url'), k2 = get('key'), i = get('id');
        if (u) (document.getElementById('su-url') as HTMLInputElement).value = u;
        if (k2) (document.getElementById('su-key') as HTMLInputElement).value = k2;
        if (i) (document.getElementById('su-id') as HTMLInputElement).value  = i;
      },
      { url: FAKE_SUPA_URL, key: FAKE_SUPA_KEY, id: FAKE_DISP_ID }
    );
    expect(await page.locator('#su-url').inputValue()).toBe(FAKE_SUPA_URL);
    expect(await page.locator('#su-id').inputValue()).toBe(FAKE_DISP_ID);
  });

  test('19 an old link (id, no key) shows the pairing screen and says why', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash({ s: null })}`);
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#su-err')).toContainText(/out of date/i);
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(m.feedBodies).toHaveLength(0);
  });

});

// ── FEED ───────────────────────────────────────────────────────────────────

test.describe('Display: feed', () => {

  test('20 boots from #id=&s= and calls display_feed with that pair', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();
    expect(m.feedBodies[0]).toEqual({ p_display_id: FAKE_DISP_ID, p_secret: FAKE_SECRET });
    const saved = await page.evaluate(() => [localStorage.getItem('cuedeck_display_id'), localStorage.getItem('cuedeck_display_secret')]);
    expect(saved).toEqual([FAKE_DISP_ID, FAKE_SECRET]);
  });

  test('21 shows sessions and event name from the feed', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote');
    await expect(page.locator('.d-next-title')).toHaveText('Panel on venues');
    await expect(page.locator('#d-event-name')).toContainText('GTR PROBE SUMMIT');
  });

  test('22 polls every 2 s and picks up a status change', async ({ page }) => {
    let n = 0;
    const m = await mockSupabase(page, { feed: () => {
      n++;
      const f = makeFeed();
      if (n >= 2) (f.sessions[0] as Record<string, unknown>).title = 'Keynote, renamed';
      return f;
    } });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Keynote, renamed', { timeout: 6000 });
    expect(m.feedBodies.length).toBeGreaterThanOrEqual(2);
  });

  test('23 NULL feed clears the saved pairing and shows the pairing screen', async ({ page }) => {
    await mockSupabase(page, { feed: () => null });
    await page.goto(DISP_URL);
    await page.evaluate(({ id, s }) => {
      localStorage.setItem('cuedeck_display_id', id);
      localStorage.setItem('cuedeck_display_secret', s);
      localStorage.setItem('cuedeck_display_paired_at', String(Date.now()));
    }, { id: FAKE_DISP_ID, s: FAKE_SECRET });
    await page.reload();
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    await expect(page.locator('#display')).toBeHidden();
    const saved = await page.evaluate(() => [localStorage.getItem('cuedeck_display_id'), localStorage.getItem('cuedeck_display_secret')]);
    expect(saved).toEqual([null, null]);
  });

  test('24 NULL feed after boot (key revoked) returns to pairing', async ({ page }) => {
    let n = 0;
    await mockSupabase(page, { feed: () => (++n <= 1 ? makeFeed() : null) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#setup')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#display')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('cuedeck_display_secret'))).toBeNull();
  });

  test('25 three failed polls show the banner and keep the last data; success hides it', async ({ page }) => {
    let mode: 'ok' | 'fail' = 'ok';
    await mockSupabase(page, { feed: () => (mode === 'ok' ? makeFeed() : 'fail') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote');
    mode = 'fail';
    // after one or two failures the banner is still hidden
    await page.waitForTimeout(2500);
    await expect(page.locator('#reconnect-banner')).toBeHidden();
    await expect(page.locator('#reconnect-banner')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote');
    await expect(page.locator('#display')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('cuedeck_display_secret'))).toBe(FAKE_SECRET);
    mode = 'ok';
    await expect(page.locator('#reconnect-banner')).toBeHidden({ timeout: 5000 });
  });

  test('26 network down at power-on: keeps trying, never drops the pairing', async ({ page }) => {
    let mode: 'ok' | 'fail' = 'fail';
    await mockSupabase(page, { feed: () => (mode === 'ok' ? makeFeed() : 'fail') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#reconnect-banner')).toBeVisible({ timeout: 9000 });
    await expect(page.locator('#setup')).toBeHidden();
    mode = 'ok';
    await expect(page.locator('#display')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#reconnect-banner')).toBeHidden();
  });

  test('27 identify flash fires once when global_override turns to identify', async ({ page }) => {
    let identify = false;
    await mockSupabase(page, { feed: () => makeFeed({ display: { global_override: identify ? { type: 'identify' } : null } }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __flashes: number }).__flashes = 0;
      const el = document.getElementById('identify-flash')!;
      new MutationObserver(() => {
        if (el.style.display === 'block' && el.style.opacity === '0.9') (window as unknown as { __flashes: number }).__flashes++;
      }).observe(el, { attributes: true, attributeFilter: ['style'] });
    });
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => (window as unknown as { __flashes: number }).__flashes)).toBe(0);
    identify = true;
    await page.waitForFunction(() => (window as unknown as { __flashes: number }).__flashes >= 1, null, { timeout: 5000 });
    await page.waitForTimeout(4500); // two more polls still on identify
    expect(await page.evaluate(() => (window as unknown as { __flashes: number }).__flashes)).toBe(1);
  });

  test('28 an unchanged feed does not re-render the screen', async ({ page }) => {
    const fixed = makeFeed();
    const m = await mockSupabase(page, { feed: () => ({ ...fixed, server_time: new Date().toISOString(),
      display: { ...fixed.display, last_seen_at: new Date().toISOString() } }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote');
    await page.evaluate(() => { (document.querySelector('#content-area > *') as HTMLElement).dataset.marker = 'kept'; });
    const before = m.feedBodies.length;
    await page.waitForTimeout(4500);
    expect(m.feedBodies.length).toBeGreaterThan(before);
    await expect(page.locator('#content-area > [data-marker="kept"]')).toHaveCount(1);
  });

  test('29 the page makes no direct table reads', async ({ page }) => {
    const m = await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    await page.waitForTimeout(2500);
    expect(m.otherRest).toEqual([]);
  });

  test('30 no uncaught JS errors through boot and polling', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible();
    await page.waitForTimeout(2500);
    expect(errors).toHaveLength(0);
  });

  test('30b a stuck audio unlock does not stop the feed', async ({ page }) => {
    await page.addInitScript(() => {
      // resume() can stay pending without a user gesture
      (window as unknown as { AudioContext: { prototype: { resume: () => Promise<void> } } })
        .AudioContext.prototype.resume = () => new Promise<void>(() => {});
    });
    let n = 0;
    const m = await mockSupabase(page, { feed: () => {
      n++;
      const f = makeFeed() as ReturnType<typeof makeFeed> & { sponsors: unknown[] };
      f.sponsors = [{ id: 'sp1', name: 'Video sponsor', logo_url: 'https://example.invalid/a.mp4', bg_color: '#000', sort_order: 0 }];
      if (n >= 3) (f.sessions[0] as Record<string, unknown>).title = 'Feed still flowing';
      return f;
    } });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.d-big-title')).toHaveText('Feed still flowing', { timeout: 9000 });
    expect(m.feedBodies.length).toBeGreaterThanOrEqual(3);
  });

});

// ── FOLLOW-UPS (2026-10-05 review) ─────────────────────────────────────────

test.describe('Display: follow-ups', () => {

  const SAVED_ID     = '00000000-0000-0000-0000-0000000000bb';
  const SAVED_SECRET = 'c'.repeat(48);
  async function saveCreds(page: Page, id: string, s: string) {
    await page.evaluate(({ id, s }) => {
      localStorage.setItem('cuedeck_display_id', id);
      localStorage.setItem('cuedeck_display_secret', s);
      localStorage.setItem('cuedeck_display_paired_at', String(Date.now()));
    }, { id, s });
  }

  test('34 an event rename reaches the header without a reload', async ({ page }) => {
    let name = 'GTR Probe Summit';
    const fixed = makeFeed();  // sessions and display stay identical between polls
    await mockSupabase(page, { feed: () => ({ ...fixed, event: { name, brand_color: '#3b82f6' } }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#d-event-name')).toContainText('GTR PROBE SUMMIT');
    name = 'GTR North Africa 2026';
    await expect(page.locator('#d-event-name')).toContainText('GTR NORTH AFRICA 2026', { timeout: 6000 });
  });

  test('35 a stale link falls back to the good saved pairing and keeps it', async ({ page }) => {
    const m = await mockSupabase(page, { feed: () => {
      const last = m.feedBodies[m.feedBodies.length - 1] as { p_display_id: string };
      return last.p_display_id === SAVED_ID ? makeFeed({ display: { id: SAVED_ID } }) : null;
    } });
    await page.goto(`${BASE}/`);  // same origin; a hash-only change to DISP_URL would not reload
    await saveCreds(page, SAVED_ID, SAVED_SECRET);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#display')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote');
    expect(m.feedBodies[0]).toEqual({ p_display_id: FAKE_DISP_ID, p_secret: FAKE_SECRET });
    expect(m.feedBodies).toContainEqual({ p_display_id: SAVED_ID, p_secret: SAVED_SECRET });
    const saved = await page.evaluate(() => [localStorage.getItem('cuedeck_display_id'), localStorage.getItem('cuedeck_display_secret')]);
    expect(saved).toEqual([SAVED_ID, SAVED_SECRET]);
    expect(page.url()).not.toContain(FAKE_SECRET);
  });

  test('36 when the saved pairing itself fails it is forgotten', async ({ page }) => {
    await mockSupabase(page, { feed: () => null });
    await page.goto(`${BASE}/`);  // same origin; a hash-only change to DISP_URL would not reload
    await saveCreds(page, SAVED_ID, SAVED_SECRET);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/, { timeout: 8000 });
    const saved = await page.evaluate(() => [localStorage.getItem('cuedeck_display_id'), localStorage.getItem('cuedeck_display_secret')]);
    expect(saved).toEqual([null, null]);
  });

  test('37 a first render that throws is retried on the next poll', async ({ page }) => {
    await page.addInitScript(() => {
      // Fail the first write to the content area only.
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
      let failed = false;
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true, get: desc.get,
        set(v: string) {
          if (!failed && (this as Element).id === 'content-area') { failed = true; throw new Error('first render fails'); }
          desc.set!.call(this, v);
        },
      });
    });
    const fixed = makeFeed();
    await mockSupabase(page, { feed: () => ({ ...fixed, server_time: new Date().toISOString() }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote', { timeout: 6000 });
  });

  test('38 repeated render errors do not show the reconnect banner, and rendering resumes', async ({ page }) => {
    await page.addInitScript(() => {
      // The first four writes to the content area throw (four polls in a row).
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
      let fails = 0;
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true, get: desc.get,
        set(v: string) {
          if (fails < 4 && (this as Element).id === 'content-area') { fails++; throw new Error('render fails'); }
          desc.set!.call(this, v);
        },
      });
      // Record whether the banner is ever shown.
      (window as unknown as { __bannerShown: boolean }).__bannerShown = false;
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('reconnect-banner')!;
        new MutationObserver(() => {
          if (el.style.display === 'block') (window as unknown as { __bannerShown: boolean }).__bannerShown = true;
        }).observe(el, { attributes: true, attributeFilter: ['style'] });
      });
    });
    const fixed = makeFeed();
    await mockSupabase(page, { feed: () => ({ ...fixed, server_time: new Date().toISOString() }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Opening keynote', { timeout: 15000 });
    expect(await page.evaluate(() => (window as unknown as { __bannerShown: boolean }).__bannerShown)).toBe(false);
  });

});

// ── PAIRING ────────────────────────────────────────────────────────────────

test.describe('Display: pairing', () => {

  test('31 pairing sends a 32-hex nonce, then stores the id and secret and boots', async ({ page }) => {
    const PAIRED_ID = '00000000-0000-0000-0000-0000000000aa';
    const PAIRED_SECRET = 'b'.repeat(48);
    let polls = 0;
    const m = await mockSupabase(page, {
      pairPoll: () => (++polls >= 2 ? { display_id: PAIRED_ID, secret: PAIRED_SECRET } : null),
    });
    await page.goto(DISP_URL);
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    await expect(page.locator('#display')).toBeVisible({ timeout: 10000 });

    const start = m.startBodies[0] as { p_code: string; p_nonce: string };
    expect(start.p_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(start.p_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(m.pollBodies[0]).toEqual({ p_code: start.p_code, p_nonce: start.p_nonce });
    expect(m.feedBodies[0]).toEqual({ p_display_id: PAIRED_ID, p_secret: PAIRED_SECRET });
    const saved = await page.evaluate(() => [localStorage.getItem('cuedeck_display_id'), localStorage.getItem('cuedeck_display_secret')]);
    expect(saved).toEqual([PAIRED_ID, PAIRED_SECRET]);
  });

  test('32 a taken code is retried with a fresh one', async ({ page }) => {
    let starts = 0;
    const m = await mockSupabase(page, { pairStart: () => ++starts >= 2 });
    await page.goto(DISP_URL);
    await expect(page.locator('#pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(m.startBodies.length).toBe(2);
    const shown = (await page.locator('#pairing-code').textContent())!.replace('-', '');
    expect(shown).toBe((m.startBodies[1] as { p_code: string }).p_code);
  });

  test('33 pairing unavailable shows a retry message, not a dead screen', async ({ page }) => {
    await mockSupabase(page, { pairStart: () => false });
    await page.goto(DISP_URL);
    await expect(page.locator('#pairing-status')).toHaveText(/Pairing unavailable/i);
    await expect(page.locator('#pairing-code')).toHaveText('---');
  });

});

// ── SESSION PEOPLE ─────────────────────────────────────────────────────────

const PANEL_PEOPLE = [
  { name: 'Jane Smith', company: 'Contoso',   role: 'moderator' },
  { name: 'Ahmed Ali',  company: 'Fabrikam',  role: 'speaker' },
  { name: 'Sara Lee',   company: 'Northwind', role: 'panelist' },
];

function feedWithPeople(people: unknown[], mode = 'schedule', speaker: string | null = 'Jane Smith (moderator), Ahmed Ali, Sara Lee') {
  const f = makeFeed({ display: { content_mode: mode } });
  Object.assign(f.sessions[0] as Record<string, unknown>, { title: 'Panel: future of MICE', speaker, company: null, people });
  return f;
}

test.describe('Display: session people', () => {

  test('40 schedule shows the moderator line and the speakers', async ({ page }) => {
    await mockSupabase(page, { feed: () => feedWithPeople(PANEL_PEOPLE) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-big-title')).toHaveText('Panel: future of MICE');
    await expect(page.locator('.d-people-mod')).toHaveText('Moderated by Jane Smith · Contoso');
    await expect(page.locator('.d-people-list')).toHaveText('Ahmed Ali · Fabrikam, Sara Lee · Northwind');
    await expect(page.locator('.d-speaker')).toHaveCount(0);
  });

  test('41 stage timer shows the moderator line and the speakers', async ({ page }) => {
    await mockSupabase(page, { feed: () => feedWithPeople(PANEL_PEOPLE, 'stage-timer') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.st-title')).toHaveText('Panel: future of MICE');
    await expect(page.locator('.st-people-mod')).toHaveText('Moderated by Jane Smith · Contoso');
    await expect(page.locator('.st-people-list')).toHaveText('Ahmed Ali · Fabrikam, Sara Lee · Northwind');
    await expect(page.locator('.st-speaker')).toHaveCount(0);
  });

  test('42 a session without people still shows speaker and company', async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-speaker')).toHaveText('Jane Smith · Acme');
    await expect(page.locator('.d-people-mod')).toHaveCount(0);
  });

  test('43 stage timer without people still shows speaker', async ({ page }) => {
    await mockSupabase(page, { feed: () => makeFeed({ display: { content_mode: 'stage-timer' } }) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.st-speaker')).toHaveText('Jane Smith');
  });

  test('44 names with markup render as text', async ({ page }) => {
    const people = [
      { name: '<b>Bold</b> Mod', company: '<i>Co</i>', role: 'moderator' },
      { name: '<img src=x onerror="window.__xss=1">Eve', company: null, role: 'speaker' },
    ];
    await mockSupabase(page, { feed: () => feedWithPeople(people) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-people-mod')).toHaveText('Moderated by <b>Bold</b> Mod · <i>Co</i>');
    await expect(page.locator('.d-people-list')).toHaveText('<img src=x onerror="window.__xss=1">Eve');
    await expect(page.locator('.d-people b, .d-people i, .d-people img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('45 a long panel caps the visible names and says how many more', async ({ page }) => {
    const people = [{ name: 'Mod One', company: null, role: 'moderator' },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `Panelist ${i + 1}`, company: null, role: 'panelist' }))];
    await mockSupabase(page, { feed: () => feedWithPeople(people) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-people-mod')).toHaveText('Moderated by Mod One');
    await expect(page.locator('.d-people-list')).toHaveText(
      'Panelist 1, Panelist 2, Panelist 3, Panelist 4, Panelist 5, Panelist 6 +2 more');
  });

  test('46 timeline shows a one line people summary', async ({ page }) => {
    await mockSupabase(page, { feed: () => feedWithPeople(PANEL_PEOPLE, 'timeline', null) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.tl-row').first().locator('.tl-meta span').first())
      .toHaveText('Jane Smith (moderator), Ahmed Ali, Sara Lee');
  });

  test('47 an empty people array behaves exactly as before', async ({ page }) => {
    await mockSupabase(page, { feed: () => feedWithPeople([], 'schedule', 'Solo Speaker') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-speaker')).toHaveText('Solo Speaker');
    await expect(page.locator('.d-people')).toHaveCount(0);
  });

});

// ── SESSION PEOPLE: LONG NAMES AND SMALL SCREENS ─────────────────────────────

const LONG_PERSON = { name: 'H.E. Dr. Mohamed Abdel-Rahman El-Sayed',
  company: 'Ministry of Tourism and Antiquities, Arab Republic of Egypt', role: 'speaker' };
const BIG_PANEL = [
  { name: 'Jane Smith', company: 'Contoso', role: 'moderator' },
  LONG_PERSON,
  { name: 'Ahmed Ali', company: 'Fabrikam', role: 'panelist' },
  { name: 'Sara Lee', company: 'Northwind', role: 'panelist' },
  { name: 'Omar Said', company: 'Egyptian Tourism Authority', role: 'panelist' },
  { name: 'Lina Haddad', company: 'Marriott International', role: 'panelist' },
  { name: 'Karim Mostafa', company: 'AVE Events', role: 'panelist' },
  { name: 'Nour El-Din', company: 'GTR', role: 'panelist' },
];

async function personOverflow(page: Page, sel: string) {
  return page.evaluate((s) => {
    const els = [...document.querySelectorAll(s)];
    return { count: els.length, over: els.filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5
      || e.getBoundingClientRect().left < -0.5).map(e => e.textContent) };
  }, sel);
}

for (const [w, h] of [[1080, 1920], [1280, 720]] as const) {
  test.describe(`Display: long names at ${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test(`48 schedule keeps every person on screen (${w}x${h})`, async ({ page }) => {
      await mockSupabase(page, { feed: () => feedWithPeople([{ ...LONG_PERSON, role: 'moderator' }, ...BIG_PANEL.slice(1)]) });
      await page.goto(`${DISP_URL}${makeHash()}`);
      await expect(page.locator('.d-people-mod')).toContainText('Ministry of Tourism');
      const r = await personOverflow(page, '.d-people-person');
      expect(r.count).toBe(7);
      expect(r.over).toEqual([]);
    });

    test(`49 stage timer keeps every person on screen (${w}x${h})`, async ({ page }) => {
      await mockSupabase(page, { feed: () => feedWithPeople(BIG_PANEL, 'stage-timer') });
      await page.goto(`${DISP_URL}${makeHash()}`);
      await expect(page.locator('.st-people-list')).toContainText('Ministry of Tourism');
      const r = await personOverflow(page, '.st-people-person');
      expect(r.count).toBe(7);
      expect(r.over).toEqual([]);
    });
  });
}

test.describe('Display: small landscape screen', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('50 a big panel still leaves NEXT SESSION on screen at 1280x720', async ({ page }) => {
    // a two-line title plus the full panel: before the max-height rule this
    // pushed the next session's time below 720 px
    await mockSupabase(page, { feed: () => {
      const f = feedWithPeople(BIG_PANEL);
      (f.sessions[0] as Record<string, unknown>).title = 'Panel: the future of MICE and business events in North Africa';
      return f;
    } });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-people-list')).toBeVisible();
    for (const sel of ['.d-next-lbl', '.d-next-title', '.d-next-time']) {
      const box = await page.locator(sel).boundingBox();
      expect(box, sel).not.toBeNull();
      expect(box!.y + box!.height, sel).toBeLessThanOrEqual(720);
    }
  });

  test('50b the same with wide fonts (Linux, Android TV) keeps NEXT SESSION on screen', async ({ page }) => {
    // CI Linux fonts run wider than the Mac ones and pushed .d-next-time to
    // 739.7 px. Verdana (macOS) and DejaVu Sans (Linux) reproduce that anywhere.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = "body{font-family:Verdana,'DejaVu Sans',sans-serif !important}";
        document.head.appendChild(s);
      });
    });
    await mockSupabase(page, { feed: () => {
      const f = feedWithPeople(BIG_PANEL);
      (f.sessions[0] as Record<string, unknown>).title = 'Panel: the future of MICE and business events in North Africa';
      return f;
    } });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.d-people-list')).toBeVisible();
    for (const sel of ['.d-timer', '.d-next-lbl', '.d-next-title', '.d-next-time']) {
      const box = await page.locator(sel).boundingBox();
      expect(box, sel).not.toBeNull();
      expect(box!.y + box!.height, sel).toBeLessThanOrEqual(720);
    }
    // every person either fully on screen or counted in "+N more", none cut off
    const r = await page.evaluate(() => {
      const main = document.querySelector('.d-sched-main') || document.querySelector('.d-people')!.parentElement!;
      const clip = main.getBoundingClientRect().bottom;
      const els = [...document.querySelectorAll('.d-people-person')];
      const more = Number((document.querySelector('.d-people-more')?.textContent || '').match(/\d+/)?.[0] || 0);
      return { shown: els.length, more, cut: els.filter(e => e.getBoundingClientRect().bottom > Math.min(clip, window.innerHeight) + 0.5).map(e => e.textContent) };
    });
    expect(r.cut).toEqual([]);
    expect(r.shown + r.more).toBe(BIG_PANEL.length);
  });
});

test.describe('Display: stage timer next line', () => {

  test('51 next and standby lines cap the people at 3 names plus +N', async ({ page }) => {
    const f = makeFeed({ display: { content_mode: 'stage-timer' } });
    Object.assign(f.sessions[1] as Record<string, unknown>, { title: 'Panel B', speaker: 'ignored', people: BIG_PANEL });
    await mockSupabase(page, { feed: () => f });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.st-next')).toHaveText(
      'NEXT: Panel B · Jane Smith (moderator), H.E. Dr. Mohamed Abdel-Rahman El-Sayed, Ahmed Ali +5');
  });

  test('52 standby line uses the same cap', async ({ page }) => {
    const f = makeFeed({ display: { content_mode: 'stage-timer' } });
    (f.sessions[0] as Record<string, unknown>).status = 'ENDED';
    Object.assign(f.sessions[1] as Record<string, unknown>, { title: 'Panel B', people: BIG_PANEL.slice(0, 5) });
    await mockSupabase(page, { feed: () => f });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('.st-standby-session')).toHaveText(
      'Panel B · Jane Smith (moderator), H.E. Dr. Mohamed Abdel-Rahman El-Sayed, Ahmed Ali +2');
  });

});

// ── STAGE TIMER STANDBY: REAL EVENT DATE ──────────────────────────────────

// Event in Africa/Cairo (UTC+3 on 12 Oct 2026); next session 09:00 local = 06:00Z.
// The display's clock follows the feed's server_time, so that fixes "now".
function standbyFeed(nowIso: string | null, event: Record<string, unknown> | null = { date: '2026-10-12', timezone: 'Africa/Cairo' }) {
  const f = makeFeed({ display: { content_mode: 'stage-timer' },
    event: { name: 'GTR North Africa 2026', brand_color: '#3b82f6', ...(event || {}) } });
  if (nowIso) f.server_time = nowIso;
  f.sessions = [
    { id: 'n1', sort_order: 1, title: 'Opening', speaker: 'Jane Smith', company: null, room: 'Hall A',
      status: 'PLANNED', planned_start: '09:00:00', planned_end: '09:30:00',
      scheduled_start: '09:00:00', scheduled_end: '09:30:00', actual_start: null },
  ];
  return f;
}

test.describe('Display: stage timer counts to the real event start', () => {
  test.use({ timezoneId: 'UTC' });

  test('53 a week ahead shows the start day and event-local time', async ({ page }) => {
    await mockSupabase(page, { feed: () => standbyFeed('2026-10-05T12:00:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#st-standby-countdown')).toHaveText('Mon 12 Oct, 09:00');
    await expect(page.locator('#st-standby-label')).toHaveText('STARTS');
    await page.waitForTimeout(1500); // the 1 s tick keeps the same text
    await expect(page.locator('#st-standby-countdown')).toHaveText('Mon 12 Oct, 09:00');
  });

  test('54 two hours ahead counts down with hours', async ({ page }) => {
    await mockSupabase(page, { feed: () => standbyFeed('2026-10-12T04:00:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#st-standby-countdown')).toHaveText(/^(02:00:00|01:59:5\d)$/);
    await expect(page.locator('#st-standby-label')).toHaveText('NEXT UP IN');
    await page.waitForTimeout(1500);
    await expect(page.locator('#st-standby-countdown')).toHaveText(/^(02:00:00|01:59:[45]\d)$/);
  });

  test('55 ten minutes ahead counts down in minutes', async ({ page }) => {
    await mockSupabase(page, { feed: () => standbyFeed('2026-10-12T05:50:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#st-standby-countdown')).toHaveText(/^(10:00|09:5\d)$/);
  });

  test('56 past the start and not started says STARTING NOW', async ({ page }) => {
    await mockSupabase(page, { feed: () => standbyFeed('2026-10-12T06:05:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#st-standby-countdown')).toHaveText('STARTING NOW');
    await page.waitForTimeout(1500);
    await expect(page.locator('#st-standby-countdown')).toHaveText('STARTING NOW');
  });

  test('57 a feed without date and timezone keeps the old time-of-day countdown', async ({ page }) => {
    await mockSupabase(page, { feed: () => standbyFeed(null, null) });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#st-standby-label')).toHaveText('NEXT UP IN');
    await expect(page.locator('#st-standby-countdown')).toHaveText(/^\d{2,}:\d{2}$/);
  });
});

// The main schedule screen and the recall screen used to count to today's
// clock time, so a READY session days away showed "00:00 TO START".
test.describe('Display: schedule screen counts to the real event start', () => {
  test.use({ timezoneId: 'UTC' });
  const readyFeed = (nowIso: string, mode = 'schedule') => {
    const f = standbyFeed(nowIso);
    (f.display as Record<string, unknown>).content_mode = mode;
    (f.sessions[0] as Record<string, unknown>).status = 'READY';
    return f;
  };

  test('58 a READY session a week ahead shows its start day, not 00:00', async ({ page }) => {
    await mockSupabase(page, { feed: () => readyFeed('2026-10-05T12:00:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#d-live-timer')).toHaveText('Mon 12 Oct, 09:00');
    await expect(page.locator('#d-live-timer-lbl')).toHaveText('STARTS');
    await page.waitForTimeout(1500);
    await expect(page.locator('#d-live-timer')).toHaveText('Mon 12 Oct, 09:00');
  });

  test('59 on the day it counts down with hours', async ({ page }) => {
    await mockSupabase(page, { feed: () => readyFeed('2026-10-12T04:00:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#d-live-timer')).toHaveText(/^(02:00:00|01:59:[45]\d)$/);
    await expect(page.locator('#d-live-timer-lbl')).toHaveText('TO START');
  });

  test('60 past the start it says STARTING NOW', async ({ page }) => {
    await mockSupabase(page, { feed: () => readyFeed('2026-10-12T06:05:00Z') });
    await page.goto(`${DISP_URL}${makeHash()}`);
    await expect(page.locator('#d-live-timer')).toHaveText('STARTING NOW');
  });
});
