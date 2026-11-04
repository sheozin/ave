// tests/e2e/checkin-wrapup.spec.ts
// After an event finishes (migration 160): the overview's "Get ready" list
// becomes "Wrap up", says when guest details will be deleted, and offers a
// copy of the event. Supabase mocked; time fixed at 18 Oct 2026, 11:00 Warsaw.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, USER_ID, FIXED_NOW, SB } from './checkin-mock';

const NEW_ID = '33333333-3333-4333-8333-333333333333';

async function open(page, date: string, ent: Record<string, unknown> = {}, role = 'organizer') {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ date, role, is_owner: role === 'owner' })]);
  await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'live', certificate_enabled: false,
    report_sent_at: '2026-10-13T00:10:00Z', purge_warned_at: null, data_purged_at: null, ...ent }]);
  await table(page, 'leod_checkin_attendees', []);
  await rpc(page, 'checkin_client_report_get', { recipients: ['client@example.test'], sent_at: '2026-10-13T06:00:00Z' });
  await fn(page, 'checkin-invite-staff', () => ({ body: { ok: true, staff: [] } }));
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-setup.html?event=' + EVENT_ID);
}

test('a finished event shows Wrap up with the deletion date', async ({ page }) => {
  // 10 Oct event: check-in closed at midnight starting 13 Oct, Warsaw.
  await open(page, '2026-10-10');
  await expect(page.locator('#ov-todo-h')).toHaveText('Wrap up');
  await expect(page.locator('#side-meta')).toContainText('Finished');
  const todo = page.locator('#ov-todo');
  await expect(todo).toContainText('Check-in closed');
  await expect(todo).toContainText('Closed 13 October 2026');
  await expect(todo).toContainText('Your post-event report');
  await expect(todo).toContainText('Report for your client');
  await expect(todo).toContainText('Sent ');
  await expect(todo).toContainText('Certificates of attendance');
  await expect(todo).toContainText('Before 10 January 2027');
  await expect(page.locator('#ov-keep')).toContainText('On 10 January 2027 we delete');
  await expect(page.locator('#ov-copy')).toBeVisible();
});

test('an event not yet finished keeps Get ready', async ({ page }) => {
  await open(page, '2026-10-18');
  await expect(page.locator('#ov-todo-h')).toHaveText('Get ready');
  await expect(page.locator('#ov-wrap')).toBeHidden();
  await expect(page.locator('#side-meta')).toContainText('Live');
});

test('an owner warned late gets 14 days from the warning', async ({ page }) => {
  // Warned 1 Jan 2027: deletion moves from 10 Jan to 15 Jan.
  await open(page, '2026-10-10', { purge_warned_at: '2027-01-01T09:00:00Z' });
  await expect(page.locator('#ov-keep')).toContainText('On 15 January 2027 we delete');
});

test('after deletion it says so and the guest list item is done', async ({ page }) => {
  await open(page, '2026-10-10', { data_purged_at: '2026-10-15T09:00:00Z' });
  await expect(page.locator('#ov-keep')).toContainText('were deleted 15 October 2026');
  await expect(page.locator('#ov-todo')).toContainText('Guest details have been deleted');
});

test('copy to a new event creates it, sets it up, copies, and opens it', async ({ page }) => {
  const calls: string[] = [];
  await open(page, '2026-10-10');
  let inserted: Record<string, unknown> | null = null, copied: Record<string, unknown> | null = null;
  await page.route(new RegExp('^' + SB.replace(/\./g, '\\.') + '/rest/v1/leod_events(\\?|$)'), async (r) => {
    if (r.request().method() !== 'POST') { await r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); return; }
    inserted = r.request().postDataJSON(); calls.push('insert');
    await r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: NEW_ID }) });
  });
  await fn(page, 'checkin-enable-event', (b) => { calls.push('enable:' + b.event_id); return { body: { ok: true } }; });
  await rpc(page, 'checkin_copy_event_setup', (a) => { copied = a; calls.push('copy'); return { ticket_types: 1, scan_points: 0 }; });
  await page.locator('#ov-copy').click();
  await expect(page.locator('#cp-name')).toHaveValue('Probe Summit');
  await expect(page.locator('#cp-date')).toHaveValue('2027-10-10');
  await page.locator('#cp-name').fill('Probe Summit 2027');
  await page.locator('#cp-save').click();
  await page.waitForURL(/event=33333333-3333-4333-8333-333333333333/);
  expect(calls).toEqual(['insert', 'enable:' + NEW_ID, 'copy']);
  expect(inserted).toMatchObject({ name: 'Probe Summit 2027', date: '2027-10-10', timezone: 'Europe/Warsaw', venue: 'Hall A',
    event_start: '09:00:00', event_end: '18:00:00', created_by: USER_ID, created_via: 'checkin', active: true });
  expect(copied).toEqual({ p_from: EVENT_ID, p_to: NEW_ID });
});

test('a refused copy shows the server message and a retry does not make a second event', async ({ page }) => {
  let inserts = 0, fail = true;
  await open(page, '2026-10-10');
  await page.route(new RegExp('^' + SB.replace(/\./g, '\\.') + '/rest/v1/leod_events(\\?|$)'), async (r) => {
    if (r.request().method() !== 'POST') { await r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); return; }
    inserts++;
    await r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: NEW_ID }) });
  });
  await fn(page, 'checkin-enable-event', () => ({ body: { ok: true } }));
  await rpc(page, 'checkin_copy_event_setup', () => fail ? { message: 'Copy into a new, empty event' } : {}, 400);
  await page.locator('#ov-copy').click();
  await page.locator('#cp-save').click();
  await expect(page.locator('#cp-err')).toContainText('Copy into a new, empty event');
  await page.locator('#cp-save').click();
  await expect(page.locator('#cp-err')).toContainText('Copy into a new, empty event');
  expect(inserts).toBe(1);
});
