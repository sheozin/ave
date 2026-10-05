// tests/e2e/checkin-desk-roles.spec.ts
// The check-in desk for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, USER_ID, FIXED_NOW } from './checkin-mock';

const ANA = { id: 'a0000000-0000-4000-8000-000000000001', event_id: EVENT_ID, first_name: 'Ana', last_name: 'Probe', email: 'ana@cuedeck-test.io',
  company: 'Contoso Demo', ticket_type: 'attendee', qr_token: 'tok-ana', checked_in_at: '2026-10-18T08:30:00.000Z', badge_printed_at: null };
const BEN = { ...ANA, id: 'a0000000-0000-4000-8000-000000000002', first_name: 'Ben', email: 'ben@cuedeck-test.io', company: 'Fabrikam Demo', qr_token: 'tok-ben', checked_in_at: null };

type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[] };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN] }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', roster);
  await fn(page, 'checkin-record-scans', (b) => ({ body: {
    ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string; action: string }[]).map(i => [i.client_id, scanResult(i)])),
  } }));
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#station')).toBeVisible();
}

async function search(page, text: string) {
  await page.locator('#scan').fill(text);
}

test('desk staff see no kiosk or walk-in button and cannot undo a colleague', async ({ page }) => {
  await open(page, { role: 'crew' });
  await expect(page.locator('#st-walkin')).toBeHidden();
  await expect(page.locator('#st-kiosk')).toBeHidden();
  await search(page, 'Ana');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' })).toBeVisible();
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveCount(0);
});

test('desk staff can undo their own check-in', async ({ page }) => {
  await open(page, { role: 'crew' });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict .ck-undo')).toHaveText('Undo check-in');
});

test('a desk lead adds walk-ins, pairs kiosks and undoes anyone', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-walkin')).toBeVisible();
  await expect(page.locator('#st-kiosk')).toBeVisible();
  await expect(page.locator('#st-dash')).toHaveAttribute('href', '/checkin/dashboard?event=' + EVENT_ID);
  await search(page, 'Ana');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveText('Undo check-in');
});

test('a walk-in is added and opened at the desk', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', (b) => { sent = b; return { body: { ok: true, attendee: {
    id: 'a0000000-0000-4000-8000-000000000009', event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', email: null,
    company: 'Northwind Demo', ticket_type: 'attendee', qr_token: 'tok-walt', checked_in_at: null, badge_printed_at: null } } }; });
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-company').fill('Northwind Demo');
  await page.locator('#wi-save').click();
  await expect(page.locator('#walkin')).toBeHidden();
  await expect(page.locator('#party')).toContainText('Walt Walkin');
  expect(sent).toMatchObject({ event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', company: 'Northwind Demo' });
});

test('a walk-in refused by the server shows its reason in the form', async ({ page }) => {
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => ({ status: 409, body: { error: 'Someone with this email is already on the list. Search for them instead.', code: 'already_registered' } }));
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Ana');
  await page.locator('#wi-last').fill('Probe');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('Someone with this email is already on the list. Search for them instead.');
});

test('an undo the server refuses as forbidden says who can do it', async ({ page }) => {
  // The server records the check-in, so the roster the desk re-reads after
  // the sync shows Ben checked in at the desk's own time; then it refuses the undo.
  const roster = [ANA, { ...BEN }];
  await open(page, { role: 'crew', roster, scanResult: (i) => {
    if (i.action === 'checkin') { roster[1].checked_in_at = FIXED_NOW.toISOString(); return 'ok'; }
    return 'forbidden';
  } });
  const synced = page.waitForResponse(r => r.url().includes('/functions/v1/checkin-record-scans'));
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await synced;
  await page.locator('#verdict .ck-undo').click();
  await expect(page.locator('#verdict')).toContainText('Ask a desk lead to undo this check-in.');
});

test('a viewer sent to the desk lands on the dashboard', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'viewer' })]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
});

test('outbox items carry the operator id', async ({ page }) => {
  await open(page, { role: 'crew' });
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await req;
  const items = await page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open('cuedeck-checkin', 1);
    open.onsuccess = () => { const q = open.result.transaction('outbox').objectStore('outbox').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); };
    open.onerror = () => reject(open.error);
  }));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ action: 'checkin', operator_id: USER_ID });
});

// Beyond the plan: the refusal must not leave the person looking undone,
// even when the roster re-read after the sync fails and the desk falls
// back to its own cache.
test('a forbidden undo puts the check-in back even when the roster re-read fails', async ({ page }) => {
  const roster = [ANA, { ...BEN }];
  await open(page, { role: 'crew', roster, scanResult: (i) => {
    if (i.action === 'checkin') { roster[1].checked_in_at = FIXED_NOW.toISOString(); return 'ok'; }
    return 'forbidden';
  } });
  // The check-in's sync ends in a roster re-read; wait for that one too.
  const reread = page.waitForResponse(r => r.url().includes('/rest/v1/leod_checkin_attendees') && r.request().timing().startTime > 0
    && roster[1].checked_in_at !== null);
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await reread;
  // From here on the roster read fails, so the reconcile uses the cache.
  await page.route(/\/rest\/v1\/leod_checkin_attendees/, r => r.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"down"}' }));
  const failedReread = page.waitForResponse(r => r.url().includes('/rest/v1/leod_checkin_attendees') && r.status() === 400);
  await page.locator('#verdict .ck-undo').click();
  await failedReread;
  await expect(page.locator('#verdict')).toContainText('Ask a desk lead to undo this check-in.');
  await expect(page.locator('#verdict')).toContainText('Still checked in: Ben Probe.');
  const ben = await page.evaluate(() => (window as unknown as { S: { roster: { first_name: string; checked_in_at: string | null }[] } })
    .S.roster.find(a => a.first_name === 'Ben')!.checked_in_at);
  expect(ben).toBe(FIXED_NOW.toISOString());
  await expect(page.locator('#party .tick.done')).toHaveCount(1);
});

test('desk staff keep Undo on their own check-in after a reload, and only on that one', async ({ page }) => {
  const roster = [ANA, { ...BEN }];
  await open(page, { role: 'crew', roster, scanResult: (i) => {
    if (i.action === 'checkin') roster[1].checked_in_at = FIXED_NOW.toISOString();
    return 'ok';
  } });
  const synced = page.waitForResponse(r => r.url().includes('/functions/v1/checkin-record-scans'));
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await synced;
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#station')).toBeVisible();
  await search(page, 'Probe');
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-undo')).toHaveText('Undo check-in');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveCount(0);
});

test('an organizer still sees every desk control and undoes anyone', async ({ page }) => {
  await open(page, { role: 'organizer' });
  await expect(page.locator('#st-walkin')).toBeVisible();
  await expect(page.locator('#st-kiosk')).toBeVisible();
  await search(page, 'Ana');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveText('Undo check-in');
});

test('walk-in names lose control and bidi characters before they are sent', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', (b) => { sent = b; return { status: 403, body: { error: 'Only an organizer or a desk lead can add a walk-in', code: 'forbidden' } }; });
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('‮Walt\u0007');
  await page.locator('#wi-last').fill('Walk⁦in');
  await page.locator('#wi-company').fill('North‎wind\u0000');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('Only an organizer or a desk lead can add a walk-in');
  expect(sent).toMatchObject({ first_name: 'Walt', last_name: 'Walkin', company: 'Northwind' });
});

test('a walk-in needs a connection', async ({ page, context }) => {
  let calls = 0;
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => { calls++; return { body: {} }; });
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await context.setOffline(true);
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('Adding a walk-in needs a connection. Try again when the desk is back online.');
  await context.setOffline(false);
  expect(calls).toBe(0);
});

test('a walk-in request that gets no answer says the walk-in was not added', async ({ page }) => {
  await open(page, { role: 'lead' });
  await page.route(/\/functions\/v1\/checkin-add-walk-in/, r => r.abort('failed'));
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('Could not reach the server, so the walk-in was not added. Check the connection and try again.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#walkin')).toBeHidden();
});
