// tests/e2e/checkin-dashboard.spec.ts
// /checkin/dashboard with Supabase mocked (tests/e2e/checkin-mock.ts).
// Needs the static server: python3 -m http.server 7230 --bind 127.0.0.1
// Chart.js loads from jsdelivr, so this needs network access.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, myEventsRow, EVENT_ID, FIXED_NOW } from './checkin-mock';

const T0 = 1792310400; // 10:00 Warsaw on 2026-10-18
const STATS = (over: Record<string, unknown> = {}) => ({
  role: 'organizer', status: 'live', generated_at: '2026-10-18T09:00:00Z',
  registered: 120, checked_in: 45, walk_ins: 6,
  by_source: { import: 114, kiosk: 4, walk_in: 2 }, qr: { sent: 100, not_sent: 15, no_email: 5 },
  by_ticket: [{ ticket_type: 'attendee', registered: 100, checked_in: 40 }, { ticket_type: 'VIP', registered: 20, checked_in: 5 }],
  arrivals: [{ t: T0, n: 10 }, { t: T0 + 900, n: 25 }, { t: T0 + 1800, n: 10 }],
  last_25_min: [...Array(10).fill(0), ...Array(15).fill(2)], ops: null, ...over,
});
const URL_ = '/cuedeck-checkin-dashboard.html?event=' + EVENT_ID;

async function open(page, role: string, statsOver: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}, url = URL_) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role, ...rowOver })]);
  await rpc(page, 'checkin_event_stats', STATS({ role, ...statsOver }));
  await page.goto(url);
}

test('organizer sees five tiles and five charts', async ({ page }) => {
  await open(page, 'organizer');
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#t-reg')).toHaveText('120');
  await expect(page.locator('#t-in')).toHaveText('45');
  await expect(page.locator('#t-turn')).toHaveText('38% turnout');
  await expect(page.locator('#t-exp-l')).toHaveText('Still expected');
  await expect(page.locator('#t-exp')).toHaveText('75');
  await expect(page.locator('#t-walk')).toHaveText('6');
  await expect(page.locator('#t-peak')).toHaveText('25');
  await expect(page.locator('#t-peak-s')).toHaveText('10:15 to 10:30');
  await expect(page.locator('#rate')).toHaveText('Arriving now: 2 per minute over the last 15 minutes.');
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(5);
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#setup-link')).toBeVisible();
  await expect(page.locator('#desk-link')).toBeVisible();
});

test('test mode shows the amber banner', async ({ page }) => {
  await open(page, 'organizer', { status: 'test' }, { status: 'test' });
  await expect(page.locator('#banner')).toBeVisible();
});

test('after the window closes, still expected becomes no-shows', async ({ page }) => {
  await open(page, 'organizer', {}, { date: '2026-10-01' });
  await expect(page.locator('#t-exp-l')).toHaveText('No-shows');
  await expect(page.locator('#t-exp-s')).toHaveText('did not arrive');
});

test('below 10 check-ins the rate line waits', async ({ page }) => {
  await open(page, 'crew', { checked_in: 4 });
  await expect(page.locator('#rate')).toHaveText('Pace appears after the first 10 check-ins.');
  await expect(page.locator('#setup-link')).toBeHidden();
  await expect(page.locator('#desk-link')).toBeVisible();
});

test('an empty list reads No guests yet, never NaN', async ({ page }) => {
  await open(page, 'organizer', { registered: 0, checked_in: 0, walk_ins: 0, arrivals: [], by_ticket: [],
    by_source: { import: 0, kiosk: 0, walk_in: 0 }, qr: { sent: 0, not_sent: 0, no_email: 0 } });
  await expect(page.locator('#t-turn')).toHaveText('No guests yet');
  await expect(page.locator('#t-peak-s')).toHaveText('No arrivals yet');
  await expect(page.locator('body')).not.toContainText('NaN');
});

test('a viewer only ever gets the client view, numbers only', async ({ page }) => {
  await open(page, 'viewer');
  await expect(page.locator('#client')).toBeVisible();
  await expect(page.locator('#full')).toBeHidden();
  await expect(page.locator('#cl-name')).toHaveText('Probe Summit');
  await expect(page.locator('#cl-in')).toHaveText('45');
  await expect(page.locator('#cl-reg')).toHaveText('120');
  await expect(page.locator('#cl-turn')).toHaveText('38%');
  await expect(page.locator('#cl-foot')).toHaveText('Busiest 15 minutes: 25 arrived from 10:15. Arriving now: 2 per minute.');
  await expect(page.locator('a:visible')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(1);
});

test('anyone can open the client view with view=client', async ({ page }) => {
  await open(page, 'organizer', {}, {}, URL_ + '&view=client');
  await expect(page.locator('#client')).toBeVisible();
  await expect(page.locator('#full')).toBeHidden();
});

test('an event not in my list shows a plain error', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', []);
  await page.goto(URL_);
  await expect(page.locator('#page-err')).toHaveText('Could not open this dashboard: This event is not in your check-in events.');
});

test('refreshes every 30 seconds', async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow()]);
  await rpc(page, 'checkin_event_stats', () => { calls++; return STATS({ checked_in: 45 + calls }); });
  await page.goto(URL_);
  await expect(page.locator('#t-in')).toHaveText('46');
  await page.clock.runFor(30000);
  await expect(page.locator('#t-in')).toHaveText('47');
});

test('window close follows the server time, not the device clock', async ({ page }) => {
  // Device clock is inside the window; the server says it is a week later.
  await open(page, 'organizer', { generated_at: '2026-10-24T09:00:00Z' });
  await expect(page.locator('#t-exp-l')).toHaveText('No-shows');
  await expect(page.locator('#updated')).toHaveText('Updated 11:00. Refreshes every 30 seconds.');
});

test('a device clock past the window does not close it while the server says open', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-30T09:00:00Z'));
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow()]);
  await rpc(page, 'checkin_event_stats', STATS());
  await page.goto(URL_);
  // #updated is written after the tiles, and the markup already says Still expected.
  await expect(page.locator('#updated')).toHaveText('Updated 11:00. Refreshes every 30 seconds.');
  await expect(page.locator('#t-exp-l')).toHaveText('Still expected');
  await expect(page.locator('#t-exp-s')).toHaveText('not here yet');
});

// ops as checkin_event_stats sends it (migration 072): desks, speeds and
// gaps are tied by k, a per-response key; there is no desk id.
const OPS = {
  desks: [
    { k: 1, label: 'Desk 1', operator: 'Ewa Sample', last_seen_at: '2026-10-18T08:59:40Z', seconds_since_seen: 20, pending_count: 0 },
    { k: 2, label: 'Desk 2', operator: 'Jan Probe', last_seen_at: '2026-10-18T08:55:00Z', seconds_since_seen: 300, pending_count: 3 },
  ],
  kiosks: [{ label: 'Lobby kiosk', last_seen_at: null, seconds_since_seen: null }],
  speeds: [{ k: 1, label: 'Desk 1', busiest_15: 90, active_minutes: 30, first_at: '2026-10-18T07:00:00Z', last_at: '2026-10-18T08:59:00Z' }],
  gaps: [{ k: 2, label: 'Desk 2', start_at: '2026-10-18T08:02:00Z', end_at: '2026-10-18T08:09:00Z', synced_ok: 23 }],
};

test('a desk lead sees desk health, offline gaps and staffing advice', async ({ page }) => {
  await open(page, 'lead', { ops: OPS, last_25_min: Array(25).fill(12) });
  await expect(page.locator('#ops')).toBeVisible();
  await expect(page.locator('#desk-body tr')).toHaveCount(3);
  await expect(page.locator('#desk-body tr').nth(0)).toHaveText('Desk 1Ewa SampleOnline');
  await expect(page.locator('#desk-body tr').nth(1)).toHaveText('Desk 2Jan ProbeOffline since 10:55');
  await expect(page.locator('#desk-body tr').nth(2)).toHaveText('Lobby kioskKioskNot connected yet');
  await expect(page.locator('#gaps li')).toHaveText(['Desk 2 offline 10:02 to 10:09, 23 check-ins synced late, 3 still on the device.']);
  await expect(page.locator('#gaps-empty')).toBeHidden();
  await expect(page.locator('#desk-empty')).toBeHidden();
  await expect(page.locator('#pace .msg.warn')).toHaveText('Arrivals (12/min) are faster than your desk clears (6/min). Open another desk.');
});

test('the desk panel waits for 10 check-ins', async ({ page }) => {
  await open(page, 'organizer', { ops: { ...OPS, gaps: [] }, checked_in: 5 });
  await expect(page.locator('#rate')).toHaveText('Pace appears after the first 10 check-ins.');
  await expect(page.locator('#pace')).toHaveText('');
  await expect(page.locator('#ops')).not.toContainText('Pace appears');
  await expect(page.locator('#gaps-empty')).toBeVisible();
});

test('no desk yet reads a plain line, not an empty table', async ({ page }) => {
  await open(page, 'owner', { ops: { desks: [], kiosks: [], speeds: [], gaps: [] } }, { is_owner: true });
  await expect(page.locator('#ops')).toBeVisible();
  await expect(page.locator('#desk-body tr')).toHaveCount(0);
  await expect(page.locator('#desk-empty')).toBeVisible();
});

test('desk staff never see the desk panel', async ({ page }) => {
  await open(page, 'crew', { ops: null });
  await expect(page.locator('#t-in')).toHaveText('45');
  await expect(page.locator('#ops')).toBeHidden();
});

test('desk staff do not get the panel even if a response carried ops', async ({ page }) => {
  await open(page, 'crew', { ops: OPS });
  await expect(page.locator('#t-in')).toHaveText('45');
  await expect(page.locator('#ops')).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Ewa Sample');
});

// Task 9 follow-ups.
test('a failed refresh after a good one keeps the last numbers and says so', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'lead' })]);
  await rpc(page, 'checkin_event_stats', STATS({ role: 'lead', ops: OPS }));
  await page.goto(URL_);
  await expect(page.locator('#updated')).toHaveText('Updated 11:00. Refreshes every 30 seconds.');
  await expect(page.locator('#gaps li')).toHaveCount(1);
  // Later routes win in Playwright: from now on the stats call fails.
  await rpc(page, 'checkin_event_stats', { message: 'connection reset' }, 500);
  await page.clock.runFor(30000);
  await expect(page.locator('#err')).toHaveText('Could not refresh the numbers (showing the last update): connection reset');
  await expect(page.locator('#t-reg')).toHaveText('120');
  await expect(page.locator('#t-in')).toHaveText('45');
  await expect(page.locator('#t-turn')).toHaveText('38% turnout');
  await expect(page.locator('#updated')).toHaveText('Updated 11:00. Refreshes every 30 seconds.');
  await expect(page.locator('#desk-body tr')).toHaveCount(3);
  await expect(page.locator('#gaps li')).toHaveCount(1);
  expect(await page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(5);
  await expect(page.locator('body')).not.toContainText('NaN');
});

test('a hidden tab skips the 30-second refresh and catches up when shown', async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow()]);
  await rpc(page, 'checkin_event_stats', () => { calls++; return STATS({ checked_in: 45 + calls }); });
  await page.goto(URL_);
  await expect(page.locator('#t-in')).toHaveText('46');
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await page.clock.runFor(90000);
  // Give any request the ticks started time to land before counting.
  await page.waitForTimeout(1000);
  expect(calls).toBe(1);
  await expect(page.locator('#t-in')).toHaveText('46');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#t-in')).toHaveText('47');
});

test('signing out in another tab stops the refresh and leaves the dashboard', async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await page.route('**/checkin', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p id="home">home</p>' }));
  await rpc(page, 'checkin_my_events', [myEventsRow()]);
  await rpc(page, 'checkin_event_stats', () => { calls++; return STATS(); });
  await page.goto(URL_);
  await expect(page.locator('#t-in')).toHaveText('45');
  // supabase-js tells its other tabs about a sign-out over this channel.
  await page.evaluate(() => new BroadcastChannel('sb-sawekpguemzvuvvulfbc-auth-token').postMessage({ event: 'SIGNED_OUT', session: null }));
  await page.waitForURL('**/checkin');
  await expect(page.locator('#home')).toBeVisible();
  expect(calls).toBe(1);
});

test('the client view shows the test pill in test mode', async ({ page }) => {
  await open(page, 'organizer', { status: 'test' }, { status: 'test' }, URL_ + '&view=client');
  await expect(page.locator('#cl-test')).toBeVisible();
  await expect(page.locator('#cl-test')).toHaveText('Test mode');
});

test('the client view chart is readable across a room', async ({ page }) => {
  await open(page, 'viewer');
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(1);
  const sizes = await page.evaluate(() => {
    const c = Object.values((window as any).Chart.instances)[0] as any;
    return { legend: c.options.plugins.legend.labels.font.size, x: c.options.scales.x.ticks.font.size,
             y: c.options.scales.y.ticks.font.size, y2: c.options.scales.y2.ticks.font.size };
  });
  expect(sizes.legend).toBeGreaterThanOrEqual(18);
  expect(sizes.x).toBeGreaterThanOrEqual(16);
  expect(sizes.y).toBeGreaterThanOrEqual(16);
  expect(sizes.y2).toBeGreaterThanOrEqual(16);
});

// ── Company board and arrival alerts (event-day spec, features 4 and 5) ──
const BOARD = [
  { company: 'Acme', expected: 3, arrived: 1, last_arrival_at: '2026-10-18T08:05:00Z' },
  { company: 'Zeta <b>Corp</b>', expected: 2, arrived: 0, last_arrival_at: null },
  { company: 'Solo', expected: 1, arrived: 1, last_arrival_at: '2026-10-18T08:10:00Z' },
];
const ALERTS = [
  { id: 'a2', created_at: '2026-10-18T08:07:00Z', name: 'Ewa Sample', company: 'Contoso Demo', ticket_type: 'Speaker', desk_label: 'Desk 2', still_in: true },
  { id: 'a1', created_at: '2026-10-18T08:01:00Z', name: 'Jan Undone', company: null, ticket_type: 'VIP', desk_label: null, still_in: false },
];

// Routes registered later win, and signedIn() installs a catch-all 404,
// so these mocks go in after it (open() above has no hook for extras).
async function openWith(page, role: string, board: unknown, alerts: unknown, boardStatus = 200) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role })]);
  await rpc(page, 'checkin_event_stats', STATS({ role }));
  await rpc(page, 'checkin_company_board', board, boardStatus);
  await rpc(page, 'checkin_recent_alerts', alerts);
  await page.goto(URL_);
}

test('an organizer sees the company board, sorted by the server, with both filters', async ({ page }) => {
  await openWith(page, 'organizer', BOARD, []);
  await expect(page.locator('#board')).toBeVisible();
  const rows = page.locator('#cb-body tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Acme');
  await expect(rows.nth(0)).toContainText('1 of 3');
  await expect(rows.nth(0)).toContainText('10:05');
  // Company names are text, never markup.
  await expect(rows.nth(1).locator('td').first()).toHaveText('Zeta <b>Corp</b>');
  await expect(rows.nth(1)).toContainText('None yet');
  await page.locator('[data-cb="missing"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Zeta');
  await page.locator('[data-cb="partly"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Acme');
});

test('an organizer sees arrival alerts, undone ones marked', async ({ page }) => {
  await openWith(page, 'organizer', [], ALERTS);
  const items = page.locator('#alert-list li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText('10:07 Ewa Sample (Speaker, Contoso Demo) just checked in at Desk 2');
  await expect(items.nth(1)).toHaveText('10:01 Jan Undone (VIP) checked in, since undone');
  await expect(page.locator('#cb-empty')).toHaveText('No guest on the list has a company.');
});

test('no alerts yet tells an organizer where to choose ticket types', async ({ page }) => {
  await openWith(page, 'organizer', [], []);
  await expect(page.locator('#alert-empty')).toHaveText('No alerts yet. Choose the ticket types to watch in Setup, Event details.');
});

test('desk staff get neither the board nor alerts, and never ask', async ({ page }) => {
  let asked = 0;
  await openWith(page, 'crew', () => { asked++; return BOARD; }, () => { asked++; return ALERTS; });
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#t-reg')).toHaveText('120');
  await expect(page.locator('#board')).toBeHidden();
  await expect(page.locator('#alerts')).toBeHidden();
  expect(asked).toBe(0);
});

test('a lead sees the board and the alerts', async ({ page }) => {
  await openWith(page, 'lead', BOARD, ALERTS);
  await expect(page.locator('#board')).toBeVisible();
  await expect(page.locator('#alert-list li')).toHaveCount(2);
  await expect(page.locator('#alert-empty')).toBeHidden();
});

test('a failed board call says so instead of an empty table', async ({ page }) => {
  await openWith(page, 'organizer', { message: 'boom' }, [], 500);
  await expect(page.locator('#cb-empty')).toContainText('Could not refresh companies');
});
