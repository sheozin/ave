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
    // A registration-page guest: answers are guest-typed, so they go through the same neutralising.
    { id: 'a3', first_name: 'Web', last_name: 'Guest', email: 'w@x.pl', company: null, ticket_type: null, checked_in_at: null, badge_printed_at: null, qr_email_sent_at: null, is_test: false, source: 'web', created_at: '2026-10-01T00:00:00Z',
      custom_fields: { diet: { label: 'Dietary needs', value: '=SUM(A1)' } } },
  ];
  await open(page, { role: 'organizer' }, 'attendees', STAFF, () => table(page, 'leod_checkin_attendees', att));
  await expect(page.locator('#att-export')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#att-export').click()]);
  const text = readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\r\n');
  expect(lines[0]).toBe('First name;Last name;Email;Company;Ticket;Source;Checked in at;Badge printed at;Dietary needs');
  expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"")";Nowak;a@x.pl;\'+48 Co;;Imported;;;');
  expect(lines[2]).toBe("'=cmd;Evil;;;;Kiosk;;;");
  expect(lines[3]).toBe("Web;Guest;w@x.pl;;;Registration page;;;'=SUM(A1)");
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

// ── Door and session scanners in Setup (scanner Build A) ──
test('an organizer turns door scanning on and adds a door; session scanning says it is not included', async ({ page }) => {
  let setArgs: Record<string, unknown> = {};
  const inserted: Record<string, unknown>[] = [];
  await open(page, { role: 'organizer' }, 'kiosk', STAFF, async () => {
    await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test', multi_point_scanning: false, entrance_scanning: false, session_scanning: false }]);
    await table(page, 'leod_checkin_scan_points', [{ id: 'sp1', name: 'Main door', kind: 'entrance', sort_order: 1 }]);
    await rpc(page, 'checkin_scan_point_counts', [{ name: 'Main door', kind: 'entrance', scans: 9, people: 7 }]);
    await rpc(page, 'checkin_set_scanning', (a) => { setArgs = a; return { entrance_scanning: true, session_scanning: false, multi_point_scanning: false }; });
    await page.route(/\/rest\/v1\/leod_checkin_scan_points/, async (r) => {
      if (r.request().method() === 'POST') { inserted.push(r.request().postDataJSON()); return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'sp2' }]) }); }
      return r.fallback();
    });
  });
  await expect(page.locator('#sc-body tr')).toHaveCount(1);
  await expect(page.locator('#sc-body tr').first()).toContainText('7');
  await expect(page.locator('#sc-sess')).toBeDisabled();
  await expect(page.locator('#sc-sess-p')).toContainText('Not included for this event');
  await expect(page.locator('#sc-kind option[value="interior"]')).toBeDisabled();
  await page.locator('#sc-door').evaluate((el: HTMLInputElement) => el.click());
  await expect.poll(() => setArgs.p_entrance).toBe(true);
  expect(setArgs.p_session).toBeNull();
  await page.locator('#sc-name').fill('Side  door');
  await page.locator('#sc-add-btn').click();
  await expect.poll(() => inserted.length).toBe(1);
  const row = (Array.isArray(inserted[0]) ? inserted[0][0] : inserted[0]) as Record<string, unknown>;
  expect(row.name).toBe('Side door');
  expect(row.kind).toBe('entrance');
  expect(String(row.code)).toMatch(/^SIDEDOOR-[A-Z0-9]{4}$/);
});


// ── Registration page step (migration 100) ──────────────────────────
test('an organizer turns the registration page on, adds questions and gets a link', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await open(page, { role: 'organizer' }, 'register', STAFF, async () => {
    await rpc(page, 'checkin_set_registration', (a) => {
      sent.push(a);
      return { enabled: a.p_enabled, code: 'ABCDEFGH23', capacity: a.p_capacity, closes_at: a.p_closes_at, questions: a.p_questions };
    });
  });
  await expect(page.locator('#p-register')).toBeVisible();
  await expect(page.locator('#rg-linkbox')).toBeHidden();
  // A question with no text is refused before anything is sent.
  await page.locator('#rg-addq').click();
  await page.locator('#rg-save').click();
  await expect(page.locator('#rg-err')).toHaveText('Every question needs some text, or remove it.');
  expect(sent).toHaveLength(0);
  await page.locator('#rg-qs input').first().fill('Which track?');
  await page.locator('#rg-qs select').first().selectOption('choice');
  await page.locator('#rg-qs input[aria-label=Options]').fill('Tech, Business , ');
  await page.locator('#rg-qs input[type=checkbox]').check();
  await page.locator('#rg-cap').fill('150');
  await page.locator('#rg-on').evaluate((el: HTMLInputElement) => el.click());  // the input sits under the .sw switch
  await expect(page.locator('#rg-ok')).toHaveText('Saved.');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ p_event_id: EVENT_ID, p_enabled: true, p_capacity: 150, p_closes_at: null });
  expect(sent[0].p_questions).toEqual([{ id: expect.stringMatching(/^q[0-9a-f]{7}$/), label: 'Which track?', type: 'choice', required: true, options: ['Tech', 'Business'] }]);
  await expect(page.locator('#rg-link')).toHaveValue(/\/r\/ABCDEFGH23$/);
  await expect(page.locator('#rg-test')).toBeVisible();
  await expect(page.locator('.st[data-step=register]')).toHaveClass(/done/);
});

test('replacing the registration link takes two clicks and no native dialog', async ({ page }) => {
  let calls = 0;
  page.on('dialog', d => { throw new Error('native dialog: ' + d.message()); });
  await open(page, { role: 'organizer' }, 'register', STAFF, async () => {
    await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'live', registration_enabled: true,
      registration_code: 'ABCDEFGH23', registration_capacity: null, registration_closes_at: null, registration_questions: [] }]);
    await rpc(page, 'checkin_new_registration_code', () => { calls++; return 'ZZZZZZZZ22'; });
  });
  await expect(page.locator('#rg-link')).toHaveValue(/\/r\/ABCDEFGH23$/);
  await expect(page.locator('#rg-test')).toBeHidden();
  await page.locator('#rg-new').click();
  await expect(page.locator('#rg-new')).toHaveText('Click again to replace it');
  expect(calls).toBe(0);
  await page.locator('#rg-new').click();
  await expect(page.locator('#rg-link')).toHaveValue(/\/r\/ZZZZZZZZ22$/);
  expect(calls).toBe(1);
});

test('a failed registration save shows the server message and leaves the switch as it was', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'register', STAFF, async () => {
    await page.route(/\/rest\/v1\/rpc\/checkin_set_registration/, r => r.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ code: '22023', message: 'At most 5 questions' }) }));
  });
  await page.locator('#rg-on').evaluate((el: HTMLInputElement) => el.click());  // the input sits under the .sw switch
  await expect(page.locator('#rg-err')).toHaveText('At most 5 questions');
  await expect(page.locator('#rg-on')).not.toBeChecked();
});

test('page design: an uploaded cover is re-encoded and saved with the details', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  await open(page, { role: 'organizer' }, 'register', STAFF, async () => {
    await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test', registration_enabled: true,
      registration_code: 'ABCDEFGH23', registration_questions: [], registration_show_programme: false }]);
    await page.route(/\/storage\/v1\/object\/checkin-public\//, async r => {
      // supabase-js sends multipart: the part's own Content-Type is in the body.
      const body = (r.request().postDataBuffer() ?? Buffer.alloc(0)).toString('latin1');
      uploads.push(new URL(r.request().url()).pathname + ' ' + (/Content-Type: image\/jpeg/i.test(body) ? 'image/jpeg' : 'other'));
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'x' }) });
    });
    await rpc(page, 'checkin_set_registration_page', (a) => { sent.push(a); return {
      host_name: a.p_host_name, description: a.p_description, address: a.p_address, brand_color: a.p_brand_color,
      cover_path: a.p_cover_path, logo_path: a.p_logo_path, show_programme: a.p_show_programme }; });
  });
  await page.locator('#rg-host').fill('Northwind Events');
  await page.locator('#rg-desc').fill('A day of talks.');
  await page.locator('#rg-addr').fill('Main St 1');
  await page.locator('#rg-color').fill('blue');
  await page.locator('#rg-save-design').click();
  await expect(page.locator('#rg-design-err')).toHaveText('Brand colour must look like #1F4ED8.');
  expect(sent).toHaveLength(0);
  await page.locator('#rg-color').fill('#0F766E');
  // A 2x2 PNG; the page redraws it as JPEG before upload.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNAMDAFGbBPzUPg4gAAAAAElFTkSuQmCC', 'base64');
  await page.locator('#rg-cover-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#rg-design-state')).toHaveText('Uploaded. Save design to publish it.');
  expect(uploads[0]).toMatch(new RegExp('/checkin-public/' + EVENT_ID + '/cover-[0-9a-f]{16}\\.jpg image/jpeg'));
  await page.locator('#rg-prog').evaluate((el: HTMLInputElement) => el.click());
  await page.locator('#rg-save-design').click();
  await expect(page.locator('#rg-design-ok')).toHaveText('Saved. Your page shows the new design now.');
  expect(sent[0]).toMatchObject({ p_event_id: EVENT_ID, p_host_name: 'Northwind Events', p_description: 'A day of talks.', p_address: 'Main St 1',
    p_brand_color: '#0F766E', p_logo_path: null, p_show_programme: true });
  expect(String(sent[0].p_cover_path)).toMatch(new RegExp('^' + EVENT_ID + '/cover-[0-9a-f]{16}\\.jpg$'));
});

test('page design: a non-image file is refused before upload', async ({ page }) => {
  let uploaded = false;
  await open(page, { role: 'organizer' }, 'register', STAFF, async () => {
    await page.route(/\/storage\/v1\/object\/checkin-public\//, r => { uploaded = true; return r.fulfill({ status: 200, body: '{}' }); });
  });
  await page.locator('#rg-logo-file').setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
  await expect(page.locator('#rg-design-err')).toHaveText('Use a JPEG, PNG or WebP image.');
  expect(uploaded).toBe(false);
});
