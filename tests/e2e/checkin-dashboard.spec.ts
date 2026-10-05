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
