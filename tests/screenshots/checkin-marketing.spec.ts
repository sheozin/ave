// tests/screenshots/checkin-marketing.spec.ts
// Screenshots of the real check-in pages for cuedeck.io/solutions/check-in
// (spec docs/superpowers/specs/2026-10-04-checkin-product-design.md, 4.3).
// The pages are the shipped HTML; Supabase is mocked with one fictional
// event whose companies all end in "Demo", so nothing can be mistaken for a
// customer's data. Output is PNG at 2x in SHOT_DIR; scripts convert to JPEG.
import { test, type Page } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, FIXED_NOW } from '../e2e/checkin-mock';

const OUT = process.env.SHOT_DIR || 'screenshots-out';
const NAME = 'Northwind Summit 2026';
const ROW = (over: Record<string, unknown> = {}) => myEventsRow({ name: NAME, venue: 'Harbour Hall', role: 'organizer', is_owner: true, attendees: 412, arrived: 184, ...over });

const g = (i: number, first: string, last: string, company: string | null, ticket: string, inAt: string | null = null) => ({
  id: `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, event_id: EVENT_ID, first_name: first, last_name: last,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@example.invalid`, company, ticket_type: ticket,
  qr_token: 'tok' + String(i).padStart(29, '0'), checked_in_at: inAt, badge_printed_at: null, qr_email_sent_at: '2026-10-15T10:00:00Z',
  is_test: false, source: 'import', created_at: '2026-10-10T10:00:00Z',
});
const T = (min: number) => new Date(FIXED_NOW.getTime() - min * 60000).toISOString();
const ROSTER = [
  g(1, 'Maya', 'Lindqvist', 'Contoso Demo', 'Delegate'),
  g(2, 'Tomas', 'Okafor', 'Contoso Demo', 'Delegate'),
  g(3, 'Priya', 'Raman', 'Contoso Demo', 'Speaker'),
  g(4, 'Lena', 'Hart', 'Fabrikam Demo', 'VIP', T(12)),
  g(5, 'Jonas', 'Weber', 'Fabrikam Demo', 'Delegate', T(9)),
  g(6, 'Amira', 'Haddad', 'Northwind Demo', 'Press', T(30)),
  g(7, 'Oskar', 'Nowak', 'Litware Demo', 'Delegate', T(4)),
  g(8, 'Elena', 'Ruiz', 'Litware Demo', 'Delegate'),
  g(9, 'Sam', 'Becker', null, 'Delegate', T(2)),
];

// height clips a tall page to the part worth showing.
async function shot(page: Page, name: string, height?: number) {
  await page.waitForTimeout(600);   // fonts, charts and the first animation frame
  const w = page.viewportSize()!.width;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: height ? { x: 0, y: 0, width: w, height } : undefined });
}

test('desk: one scan brings up a whole company', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', () => 'Front desk');
  await rpc(page, 'checkin_recent_alerts', []);
  await rpc(page, 'checkin_server_now', () => FIXED_NOW.toISOString());
  await rpc(page, 'checkin_my_events', [ROW({ status: 'live' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', ROSTER);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await page.locator('#station').waitFor();
  await page.locator('#scan').fill('Contoso');
  await page.locator('.ck-res-row', { hasText: 'Maya Lindqvist' }).locator('.ck-res-btn').click();
  await page.locator('#party').waitFor();
  await shot(page, 'checkin-desk-group-arrival');
});

test('dashboard: arrivals, desks, companies and VIP alerts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  const t0 = Math.floor(FIXED_NOW.getTime() / 1000 / 900) * 900 - 900 * 6;
  const arrivals = [8, 22, 41, 37, 29, 31, 16].map((n, i) => ({ t: t0 + i * 900, n }));
  await rpc(page, 'checkin_my_events', [ROW({ status: 'live' })]);
  await rpc(page, 'checkin_event_stats', {
    role: 'owner', status: 'live', generated_at: FIXED_NOW.toISOString(), registered: 412, checked_in: 184, walk_ins: 11,
    by_source: { import: 401, kiosk: 7, walk_in: 4 }, qr: { sent: 389, not_sent: 15, no_email: 8 },
    by_ticket: [{ ticket_type: 'Delegate', registered: 318, checked_in: 141 }, { ticket_type: 'Speaker', registered: 34, checked_in: 22 },
                { ticket_type: 'VIP', registered: 26, checked_in: 13 }, { ticket_type: 'Press', registered: 34, checked_in: 8 }],
    arrivals, last_25_min: [...Array(10).fill(1), ...Array(15).fill(2)],
    ops: {
      desks: [
        { k: 'd1', label: 'Front desk', operator: 'Desk lead', last_seen_at: T(0.2), seconds_since_seen: 12, pending_count: 0 },
        { k: 'd2', label: 'East entrance', operator: 'Volunteer 2', last_seen_at: T(0.5), seconds_since_seen: 30, pending_count: 3 },
      ],
      kiosks: [{ label: 'Lobby kiosk', last_seen_at: T(1), seconds_since_seen: 60 }],
      speeds: [{ k: 'd1', label: 'Front desk', busiest_15: 38, active_minutes: 54, first_at: T(80), last_at: T(1) },
               { k: 'd2', label: 'East entrance', busiest_15: 26, active_minutes: 41, first_at: T(70), last_at: T(2) }],
      gaps: [],
    },
  });
  await rpc(page, 'checkin_company_board', [
    { company: 'Contoso Demo', expected: 12, arrived: 4, last_arrival_at: T(6) },
    { company: 'Fabrikam Demo', expected: 9, arrived: 0, last_arrival_at: null },
    { company: 'Litware Demo', expected: 7, arrived: 5, last_arrival_at: T(3) },
    { company: 'Northwind Demo', expected: 5, arrived: 5, last_arrival_at: T(22) },
  ]);
  await rpc(page, 'checkin_recent_alerts', [
    { id: 'x1', created_at: T(2), name: 'Lena Hart', company: 'Fabrikam Demo', ticket_type: 'VIP', desk_label: 'Front desk', still_in: true },
    { id: 'x2', created_at: T(14), name: 'Priya Raman', company: 'Contoso Demo', ticket_type: 'Speaker', desk_label: 'East entrance', still_in: true },
  ]);
  await page.goto('/cuedeck-checkin-dashboard.html?event=' + EVENT_ID);
  await page.locator('#full').waitFor();
  await page.locator('#cb-body tr').first().waitFor();
  await shot(page, 'checkin-dashboard-live', 1250);
});

test('door scanner phone: checked in', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([ev]) => localStorage.setItem('cuedeck.scanner.v1', JSON.stringify({ device_key: 'k'.repeat(64), event_id: ev, label: 'Door phone 1' })), [EVENT_ID]);
  await fn(page, 'checkin-scanner', (b) => b.action === 'config'
    ? { body: { event: { name: NAME }, status: 'live', scan_point: { name: 'Main entrance', kind: 'entrance' }, allowed: true, server_now: new Date().toISOString() } }
    : { body: { tokens: ROSTER.map(r => r.qr_token) } });
  await fn(page, 'checkin-record-scans', (b) => {
    const cid = (b.items as { client_id: string }[])[0].client_id;
    return { body: { ok: true, errors: [], results: { [cid]: 'ok' }, who: { [cid]: { first_name: 'Maya', ticket_type: 'Delegate' } } } };
  });
  await page.goto('/cuedeck-scanner.html');
  await page.locator('#scan').waitFor();
  // The camera cannot run headless: show the frame, then check a code in.
  await page.evaluate(() => { document.getElementById('cam')!.hidden = false; document.getElementById('start')!.hidden = true; });
  await page.locator('#man-code').fill(ROSTER[0].qr_token);
  await page.locator('#man-btn').click();
  await page.waitForTimeout(900);
  await shot(page, 'checkin-door-scanner-phone');
});

test('setup: guest list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [ROW({ status: 'test', test_used: 3 })]);
  await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test' }]);
  await table(page, 'leod_checkin_attendees', ROSTER);
  await fn(page, 'checkin-invite-staff', () => ({ body: { ok: true, staff: [] } }));
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-setup.html?event=' + EVENT_ID + '&step=attendees');
  await page.locator('#p-attendees').waitFor();
  await shot(page, 'checkin-setup-guest-list');
});

test('post-event report', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [ROW({ status: 'live' })]);
  await rpc(page, 'checkin_event_report', {
    registered: 412, checked_in: 371, walk_ins: 11, walk_ins_in: 11,
    first_arrival_at: '2026-10-18T06:41:00Z', last_arrival_at: '2026-10-18T12:58:00Z',
    status: 'live', role: 'owner', generated_at: '2026-10-21T02:15:00Z',
    event: { name: NAME, date: '2026-10-18', timezone: 'Europe/Warsaw', venue: 'Harbour Hall' },
    by_ticket: [{ ticket_type: 'Delegate', registered: 318, checked_in: 288, no_shows: 30 }, { ticket_type: 'Press', registered: 34, checked_in: 24, no_shows: 10 },
                { ticket_type: 'Speaker', registered: 34, checked_in: 33, no_shows: 1 }, { ticket_type: 'VIP', registered: 26, checked_in: 26, no_shows: 0 }],
    peak: { t: Math.floor(Date.parse('2026-10-18T07:30:00Z') / 1000), n: 64 },
    offline: { late_checkins: 7, longest_delay_s: 260, desks: 1 },
    desks: [{ label: 'Front desk', checkins: 214, busiest_15: 38 }, { label: 'East entrance', checkins: 146, busiest_15: 26 }, { label: null, checkins: 11, busiest_15: 4 }],
    companies: [{ company: 'Fabrikam Demo', expected: 9, arrived: 6 }, { company: 'Contoso Demo', expected: 12, arrived: 10 }],
  });
  await page.goto('/cuedeck-checkin-report.html?event=' + EVENT_ID);
  await page.locator('#full').waitFor();
  await shot(page, 'checkin-post-event-report', 1080);
});

// Command Center and Stage Timer pages: the console with injected director
// state (as console-restart.spec) and the display with a mocked display_feed
// (as display-page.spec). Every network call is answered locally.
// Event-day wall clock (local time, as the browser shows it): 10:31, the
// 10:00 talk is 31 minutes in.
const SHOW_NOW = new Date(2026, 9, 18, 10, 31, 0);
const at = (h: number, m: number) => new Date(2026, 9, 18, h, m, 0).toISOString();
const SESSIONS = [
  { title: 'Registration and coffee', speaker: null, room: 'Foyer', status: 'ENDED', ps: '08:30', pe: '09:00', as: at(8, 30), ae: at(9, 0) },
  { title: 'Opening keynote', speaker: 'Maya Lindqvist', company: 'Contoso Demo', room: 'Main Hall', status: 'ENDED', ps: '09:00', pe: '09:45', as: at(9, 1), ae: at(9, 47) },
  { title: 'The future of hybrid events', speaker: 'Tomas Okafor', company: 'Fabrikam Demo', room: 'Main Hall', status: 'LIVE', ps: '10:00', pe: '10:45', as: at(10, 0), ae: null },
  { title: 'Panel: building crews that scale', speaker: 'Priya Raman', company: 'Litware Demo', room: 'Main Hall', status: 'READY', ps: '11:00', pe: '11:45', as: null, ae: null },
  { title: 'Workshop: running a show from one screen', speaker: 'Jonas Weber', company: 'Northwind Demo', room: 'Studio B', status: 'CALLING', ps: '11:00', pe: '12:00', as: null, ae: null },
  { title: 'Lunch', speaker: null, room: 'Foyer', status: 'PLANNED', ps: '12:00', pe: '13:00', as: null, ae: null },
  { title: 'Closing remarks', speaker: 'Lena Hart', company: 'Contoso Demo', room: 'Main Hall', status: 'PLANNED', ps: '16:30', pe: '16:45', as: null, ae: null },
].map((x, i) => ({ id: `5e551000-0000-4000-8000-00000000000${i}`, event_id: 'ev-1', sort_order: i + 1, version: 3,
  title: x.title, speaker: x.speaker, company: (x as { company?: string }).company ?? null, room: x.room, status: x.status,
  planned_start: x.ps, planned_end: x.pe, scheduled_start: x.ps, scheduled_end: x.pe, actual_start: x.as, actual_end: x.ae }));

test('console: director view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(SHOW_NOW);
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto('/cuedeck-console.html');
  await page.evaluate(() => { const el = document.getElementById('loading-overlay'); if (el) el.style.display = 'none'; });
  await page.evaluate(([sessions, name]) => {
    (0, eval)(`
      S.userRole = 'director'; S.role = 'director'; S.viewMode = 'list';
      S.event = { id: 'ev-1', name: ${JSON.stringify(name)} };
      S.sessions = ${JSON.stringify(sessions)};
      S.dbStatus = 'ok'; S.rtStatus = 'ok'; S.ckStatus = 'ok'; S.efStatus = 'ok'; S.clockSynced = Date.now() - 4000;
      S.clockOffset = 3; S.clockRtt = 41; S.clockTick = 1860;
      setConn('live'); refreshDiag(); renderSessions(); refreshClockUI();
    `);
  }, [SESSIONS, NAME] as const);
  await shot(page, 'console-director-view');
});

test('display: stage timer', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.setFixedTime(SHOW_NOW);
  const feed = {
    server_time: SHOW_NOW.toISOString(),
    display: { id: '00000000-0000-0000-0000-000000000001', event_id: 'ev-1', name: 'Main Hall confidence monitor', zone_type: 'stage',
      orientation: 'landscape', content_mode: 'stage-timer', filter_room: 'Main Hall', override_content: null, sequence: null,
      scroll_style: 'scroll', paginate_seconds: 10, global_override: null, last_seen_at: new Date().toISOString() },
    event: { name: NAME, brand_color: '#3b82f6' },
    sessions: SESSIONS, sponsors: [],
  };
  await page.route('**/rest/v1/**', r => r.request().url().includes('/rpc/display_feed')
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed), headers: { 'access-control-allow-origin': '*' } })
    : r.fulfill({ status: 200, contentType: 'application/json', body: 'null', headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/cuedeck-display.html#id=00000000-0000-0000-0000-000000000001&s=' + 'a'.repeat(48));
  await page.locator('.st-timer').waitFor();
  await shot(page, 'display-stage-timer');
});
