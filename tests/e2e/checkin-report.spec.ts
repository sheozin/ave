// tests/e2e/checkin-report.spec.ts
// /checkin/report (event-day spec, feature 6), Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, myEventsRow, EVENT_ID, FIXED_NOW } from './checkin-mock';

const REPORT = (over: Record<string, unknown> = {}) => ({
  registered: 120, checked_in: 87, walk_ins: 6, walk_ins_in: 5,
  first_arrival_at: '2026-10-18T06:52:00Z', last_arrival_at: '2026-10-18T13:10:00Z',
  status: 'live', role: 'organizer', generated_at: '2026-10-21T00:15:00Z',
  event: { name: 'Probe <b>Summit</b>', date: '2026-10-18', timezone: 'Europe/Warsaw', venue: 'Hall A' },
  by_ticket: [{ ticket_type: 'VIP', registered: 20, checked_in: 12, no_shows: 8 }, { ticket_type: 'attendee', registered: 100, checked_in: 75, no_shows: 25 }],
  peak: { t: 1792310400, n: 31 },
  offline: { late_checkins: 4, longest_delay_s: 330, desks: 1 },
  desks: [{ label: 'Front <i>desk</i>', checkins: 60, busiest_15: 22 }, { label: null, checkins: 27, busiest_15: 9 }],
  companies: [{ company: 'Fabrikam Demo', expected: 5, arrived: 1 }],
  ...over,
});
const URL_ = '/cuedeck-checkin-report.html?event=' + EVENT_ID;

async function open(page, role: string, report: unknown, status = 200) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role, status: 'live' })]);
  await rpc(page, 'checkin_event_report', report, status);
  await page.goto(URL_);
}

test('an organizer sees totals, ticket types, desks, offline line and companies', async ({ page }) => {
  await open(page, 'organizer', REPORT());
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#ev-name')).toHaveText('Probe <b>Summit</b>');
  await expect(page.locator('#t-in')).toHaveText('87 of 120');
  await expect(page.locator('#t-turn')).toHaveText('73% turnout');
  await expect(page.locator('#t-no')).toHaveText('33');
  await expect(page.locator('#t-walk')).toHaveText('6');
  await expect(page.locator('#t-peak')).toHaveText('31');
  await expect(page.locator('#t-peak-s')).toHaveText('10:00 to 10:15');
  await expect(page.locator('#span')).toHaveText('First arrival to last: 08:52 to 15:10 (6 h 18 min).');
  await expect(page.locator('#tt-body tr')).toHaveCount(2);
  await expect(page.locator('#tt-body tr').nth(0)).toContainText('60%');
  await expect(page.locator('#desk-body tr').nth(0).locator('td').first()).toHaveText('Front <i>desk</i>');
  await expect(page.locator('#desk-body tr').nth(1).locator('td').first()).toHaveText('Desk 2');
  await expect(page.locator('#offline')).toHaveText('4 check-ins were made offline on 1 desk and synced later. The longest delay was 5 min.');
  await expect(page.locator('#co-card')).toBeVisible();
  await expect(page.locator('#co-body tr').first()).toContainText('1 of 5');
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#dash-link')).toHaveAttribute('href', '/checkin/dashboard?event=' + EVENT_ID);
});

test('a viewer report has no companies card', async ({ page }) => {
  const r = REPORT({ role: 'viewer', desks: [{ label: null, checkins: 60, busiest_15: 22 }] });
  delete (r as Record<string, unknown>).companies;
  await open(page, 'viewer', r);
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#co-card')).toBeHidden();
  await expect(page.locator('#desk-body tr').first().locator('td').first()).toHaveText('Desk 1');
});

test('a desk lead is told the report is not for their role and never asks for it', async ({ page }) => {
  let asked = 0;
  await open(page, 'lead', () => { asked++; return REPORT(); });
  await expect(page.locator('#page-err')).toHaveText('Could not open this report: The report is for the event owner, organizers and viewers.');
  expect(asked).toBe(0);
});

test('test mode shows the banner; nobody checked in reads plainly', async ({ page }) => {
  await open(page, 'organizer', REPORT({ status: 'test', checked_in: 0, peak: null, first_arrival_at: null, last_arrival_at: null, desks: [], offline: { late_checkins: 0, longest_delay_s: 0, desks: 0 } }));
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#span')).toHaveText('Nobody checked in.');
  await expect(page.locator('#t-peak-s')).toHaveText('No arrivals');
  await expect(page.locator('#desk-empty')).toBeVisible();
  await expect(page.locator('#offline')).toHaveText('Every check-in reached the server within a minute.');
});

test('a server refusal shows its message', async ({ page }) => {
  await open(page, 'organizer', { message: 'Only the owner, organizers and viewers see the event report' }, 403);
  await expect(page.locator('#page-err')).toContainText('Only the owner, organizers and viewers see the event report');
});

test('signed out, the report sends you to sign in and back', async ({ page }) => {
  await page.goto(URL_);
  await expect(page).toHaveURL('/checkin?next=' + encodeURIComponent('/checkin/report?event=' + EVENT_ID));
});

test('the dashboard links organizers to the report, not desk staff', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'organizer' })]);
  await rpc(page, 'checkin_event_stats', { role: 'organizer', status: 'live', generated_at: '2026-10-18T09:00:00Z', registered: 1, checked_in: 0, walk_ins: 0, by_source: { import: 1, kiosk: 0, walk_in: 0 }, qr: { sent: 0, not_sent: 1, no_email: 0 }, by_ticket: [], arrivals: [], last_25_min: Array(25).fill(0), ops: null });
  await rpc(page, 'checkin_company_board', []);
  await rpc(page, 'checkin_recent_alerts', []);
  await page.goto('/cuedeck-checkin-dashboard.html?event=' + EVENT_ID);
  await expect(page.locator('#report-link')).toBeVisible();
  await expect(page.locator('#report-link')).toHaveAttribute('href', '/checkin/report?event=' + EVENT_ID);
});

test('an unknown timezone falls back to UTC instead of half a page', async ({ page }) => {
  await open(page, 'organizer', REPORT({ event: { name: 'Probe Summit', date: '2026-10-18', timezone: 'Not/AZone', venue: null } }));
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#t-peak-s')).toHaveText('08:00 to 08:15');
  await expect(page.locator('#meta')).toContainText('UTC');
  await expect(page.locator('#page-err')).toBeEmpty();
});
