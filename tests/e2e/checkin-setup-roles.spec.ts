// tests/e2e/checkin-setup-roles.spec.ts
// /checkin/setup for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, FIXED_NOW } from './checkin-mock';

const STAFF = [
  { user_id: 'o0000000-0000-4000-8000-000000000001', role: 'organizer', name: 'Olga Owner', email: 'olga@cuedeck-test.io', is_owner: true },
  { user_id: 'o0000000-0000-4000-8000-000000000002', role: 'organizer', name: 'Oscar Org', email: 'oscar@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000003', role: 'lead', name: 'Lena Lead', email: 'lena@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000004', role: 'crew', name: 'Cris Crew', email: 'cris@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000005', role: 'viewer', name: 'Vic Viewer', email: 'vic@cuedeck-test.io', is_owner: false },
];

async function open(page, row: Record<string, unknown>, step = '', staff = STAFF, extra?: () => Promise<void>) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ status: 'test', ...row })]);
  await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test', self_registration: false, kiosk_self_print: false, auto_send_qr_email: false }]);
  await table(page, 'leod_checkin_attendees', []);
  await fn(page, 'checkin-invite-staff', () => ({ body: { ok: true, staff } }));
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  if (extra) await extra();
  await page.goto('/cuedeck-checkin-setup.html?event=' + EVENT_ID + (step ? '&step=' + step : ''));
}

test('a desk lead sees the Desk staff step only and invites desk staff only', async ({ page }) => {
  await open(page, { role: 'lead' }, 'golive');
  await expect(page.locator('#p-staff')).toBeVisible();
  await expect(page.locator('#p-golive')).toBeHidden();
  await expect(page.locator('.st:visible')).toHaveCount(1);
  await expect(page.locator('#inv-role option')).toHaveText(['Desk staff']);
  await expect(page.locator('#role-help li')).toHaveCount(1);
  await expect(page.locator('#staff-body button')).toHaveCount(1);
  await expect(page.locator('#staff-body tr', { hasText: 'Cris Crew' }).locator('button')).toHaveText('Remove');
  await expect(page.locator('#banner')).toBeHidden();
});

test('an organizer invites any role and sees role labels', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'staff');
  await expect(page.locator('#inv-role option')).toHaveText(['Organizer', 'Desk lead', 'Desk staff', 'Viewer']);
  await expect(page.locator('#inv-role')).toHaveValue('crew');
  await expect(page.locator('#staff-body tr').nth(0)).toContainText('Owner');
  await expect(page.locator('#staff-body tr').nth(2)).toContainText('Desk lead');
  await expect(page.locator('#staff-body button')).toHaveCount(4);
});

test('an organizer who is not the owner is told who can go live', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'golive');
  await expect(page.locator('#gl-owner-t')).toHaveText('Only the event owner, Olga Owner, can go live.');
  await expect(page.locator('#gl-pay')).toBeHidden();
  await expect(page.locator('#gl-comp-btn')).toBeHidden();
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner-go')).toBeHidden();
});

test('an organizer edits details; the owner tools stay hidden', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'details');
  await expect(page.locator('#p-details')).toBeVisible();
  await expect(page.locator('#d-name')).toBeEnabled();
  await expect(page.locator('#owner-tools')).toBeHidden();
});

test('the owner gets transfer and delete, and the transfer warns about complimentary status', async ({ page }) => {
  const staff = STAFF.map(s => ({ ...s, is_comp: s.name === 'Oscar Org' }));
  await open(page, { role: 'organizer', is_owner: true }, 'details', staff);
  await expect(page.locator('#owner-tools')).toBeVisible();
  await expect(page.locator('#ot-target option')).toHaveText(['Oscar Org']);
  let message = '';
  page.once('dialog', d => { message = d.message(); d.dismiss(); });
  await page.locator('#ot-transfer').click();
  await expect.poll(() => message).toBe('Make Oscar Org the owner of Probe Summit? You will stay on as an organizer. Only they can transfer it back. This event will become complimentary, because their account is.');
  await expect(page.locator('#ot-del-row')).toBeVisible();
});

test('desk staff are sent to the desk', async ({ page }) => {
  await open(page, { role: 'crew' });
  await page.waitForURL(/\/checkin\/desk\?event=/);
});

test('viewers are sent to the dashboard', async ({ page }) => {
  await open(page, { role: 'viewer' });
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
});

// ── beyond the brief: details RPC, owner tools results, export ──────────

test('an organizer saves details through the RPC, and a cleared venue is sent as empty', async ({ page }) => {
  let args: Record<string, unknown> | null = null;
  await open(page, { role: 'organizer' }, 'details', STAFF, () =>
    rpc(page, 'checkin_update_event_details', (a) => { args = a; return null; }));
  await page.locator('#d-venue').fill('');
  await page.locator('#d-save').click();
  await expect(page.locator('#d-ok')).toHaveText(' Saved');
  expect(args).toMatchObject({ p_event_id: EVENT_ID, p_name: 'Probe Summit', p_venue: '', p_date: '2026-10-18', p_timezone: 'Europe/Warsaw', p_event_start: '09:00', p_event_end: '18:00' });
});

test('a refused details save shows the server message', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'details', STAFF, () =>
    rpc(page, 'checkin_update_event_details', { code: '22023', message: 'The event must end at a different time than it starts', details: null, hint: null }, 400));
  await page.locator('#d-end').fill('09:00');
  await page.locator('#d-save').click();
  await expect(page.locator('#d-err')).toHaveText('The event must end at a different time than it starts');
});

test('an organizer cannot edit a console event, which only its owner can', async ({ page }) => {
  await open(page, { role: 'organizer', created_via: 'console' }, 'details');
  await expect(page.locator('#d-name')).toBeDisabled();
  await expect(page.locator('#det-note')).toHaveText('Only the event owner can edit a console event.');
});

test('a transfer says what changed, including complimentary status', async ({ page }) => {
  const staff = STAFF.map(s => ({ ...s, is_comp: s.name === 'Oscar Org' }));
  const sent: Record<string, unknown>[] = [];
  await open(page, { role: 'organizer', is_owner: true }, 'details', staff, () =>
    fn(page, 'checkin-invite-staff', (b) => {
      sent.push(b);
      if (b.action === 'transfer_owner') return { body: { ok: true, owner_id: STAFF[1].user_id, previous_owner_role: 'organizer', was_comp: false, is_comp: true, comp_changed: true } };
      return { body: { ok: true, staff } };
    }));
  page.once('dialog', d => d.accept());
  await page.locator('#ot-transfer').click();
  await expect(page.locator('#ot-ok')).toHaveText('Oscar Org is now the owner of Probe Summit, and you are an organizer. The event is now complimentary.');
  expect(sent.find(b => b.action === 'transfer_owner')).toMatchObject({ event_id: EVENT_ID, user_id: STAFF[1].user_id });
});

test('a refused delete shows the server message', async ({ page }) => {
  await open(page, { role: 'organizer', is_owner: true }, 'details', STAFF, () =>
    fn(page, 'checkin-invite-staff', (b) => b.action === 'archive_event'
      ? { status: 409, body: { error: 'A payment is in progress for this event. Try again in an hour.', code: 'checkout_open' } }
      : { body: { ok: true, staff: STAFF } }));
  page.once('dialog', d => d.accept());
  await page.locator('#ot-delete').click();
  await expect(page.locator('#ot-err')).toHaveText('A payment is in progress for this event. Try again in an hour.');
});

test('the owner sees no delete on a live event and no owner-only note', async ({ page }) => {
  await open(page, { role: 'organizer', is_owner: true }, 'golive', STAFF, () =>
    table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'live', self_registration: false, kiosk_self_print: false, auto_send_qr_email: false }]));
  await expect(page.locator('#gl-done')).toBeVisible();
  await expect(page.locator('#gl-owner')).toBeHidden();
  await expect(page.locator('#gl-owner-t')).toHaveText('Only the event owner, Olga Owner, can go live.');
  await page.locator('.st[data-step="details"]').click();
  await expect(page.locator('#ot-del-row')).toBeHidden();
});

test('the export neutralises formulas and strips control characters', async ({ page }) => {
  const att = [
    { id: 'a1', first_name: '=HYPERLINK("http://x")', last_name: 'Nowak', email: 'a@x.pl', company: '+48 Co', ticket_type: null, checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
    { id: 'a2', first_name: '\u202E=cmd', last_name: 'Ev\u0007il', email: null, company: null, ticket_type: null, checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'kiosk', created_at: '2026-10-01T00:00:00Z' },
  ];
  await open(page, { role: 'organizer' }, 'attendees', STAFF, () => table(page, 'leod_checkin_attendees', att));
  await expect(page.locator('#att-export')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#att-export').click()]);
  const text = readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\r\n');
  expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"")";Nowak;a@x.pl;\'+48 Co;;;');
  expect(lines[2]).toBe("'=cmd;Evil;;;;;");
});

test('an organizer on a complimentary event is told whose account includes check-in', async ({ page }) => {
  await open(page, { role: 'organizer', is_comp: true }, 'golive');
  await expect(page.locator('#gl-sub')).toHaveText("Check-in is included with Olga Owner's account.");
  await expect(page.locator('#gl-comp-btn')).toBeHidden();
});

test('an organizer on a live complimentary event reads the owner name in both places', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'organizer', is_comp: true, status: 'live' })]);
  await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'live', self_registration: false, kiosk_self_print: false, auto_send_qr_email: false }]);
  await table(page, 'leod_checkin_attendees', []);
  await fn(page, 'checkin-invite-staff', () => ({ body: { ok: true, staff: STAFF } }));
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-setup.html?event=' + EVENT_ID + '&step=golive');
  await expect(page.locator('#gl-sub')).toHaveText("Probe Summit is live. Check-in is included with Olga Owner's account.");
  await expect(page.locator('#gl-comp-t')).toHaveText("Check-in is included with Olga Owner's account.");
});

test('the owner of a complimentary event keeps the account copy', async ({ page }) => {
  await open(page, { role: 'organizer', is_owner: true, is_comp: true }, 'golive');
  await expect(page.locator('#gl-sub')).toHaveText('Check-in is included with your account.');
  await expect(page.locator('#gl-comp-t')).toHaveText('Check-in is included with your account.');
  await expect(page.locator('#gl-comp-btn')).toBeVisible();
});

// ── Arrival alert ticket types (event-day spec, feature 5) ──
const GUESTS = [
  { id: 'g1', first_name: 'A', last_name: 'One', email: null, company: null, ticket_type: 'VIP', checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
  { id: 'g2', first_name: 'B', last_name: 'Two', email: null, company: null, ticket_type: ' vip ', checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
  { id: 'g4', first_name: 'D', last_name: 'Four', email: null, company: null, ticket_type: 'VIP  Gold', checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
  { id: 'g5', first_name: 'E', last_name: 'Five', email: null, company: null, ticket_type: 'vip gold', checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
  { id: 'g3', first_name: 'C', last_name: 'Three', email: null, company: null, ticket_type: 'attendee', checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'import', created_at: '2026-10-01T00:00:00Z' },
];

test('an organizer picks alert ticket types from the guest list and saves them', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await open(page, { role: 'organizer' }, 'details', STAFF, async () => {
    await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test', alert_ticket_types: ['Speaker'] }]);
    await table(page, 'leod_checkin_attendees', GUESTS);
    await rpc(page, 'checkin_set_alert_ticket_types', (a) => { sent = a; return ['VIP', 'Speaker']; });
  });
  const opts = page.locator('#al-types label');
  await expect(page.locator('#al-row')).toBeVisible();
  // VIP and ' vip ' are one type; Speaker is saved but no longer on the list, and stays.
  await expect(opts).toHaveText(['VIP', 'VIP Gold', 'attendee', 'Speaker']);
  await expect(opts.nth(3).locator('input')).toBeChecked();
  await opts.nth(0).click();
  // Not wired to the attendee filter chips.
  await expect(page.locator('.chip[data-f="all"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#al-save').click();
  await expect(page.locator('#al-ok')).toHaveText(' Saved');
  expect(sent.p_types).toEqual(['VIP', 'Speaker']);
  expect(sent.p_event_id).toBe(EVENT_ID);
});

test('with no ticket types on the list, alerts say what to do', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'details');
  await expect(page.locator('#al-none')).toBeVisible();
  await expect(page.locator('#al-save')).toBeDisabled();
});

test('a failed alert save shows the server message', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'details', STAFF, async () => {
    await table(page, 'leod_checkin_attendees', GUESTS);
    await rpc(page, 'checkin_set_alert_ticket_types', { message: 'Only the event owner or an organizer can choose alert ticket types' }, 403);
  });
  await page.locator('#al-types label').first().click();
  await page.locator('#al-save').click();
  await expect(page.locator('#al-err')).toHaveText('Only the event owner or an organizer can choose alert ticket types');
});

