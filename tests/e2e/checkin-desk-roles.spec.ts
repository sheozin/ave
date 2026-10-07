// tests/e2e/checkin-desk-roles.spec.ts
// The check-in desk for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, USER_ID, FIXED_NOW } from './checkin-mock';

const ANA = { id: 'a0000000-0000-4000-8000-000000000001', event_id: EVENT_ID, first_name: 'Ana', last_name: 'Probe', email: 'ana@cuedeck-test.io',
  company: 'Contoso Demo', ticket_type: 'attendee', qr_token: 'tok-ana', checked_in_at: '2026-10-18T08:30:00.000Z', badge_printed_at: null };
const BEN = { ...ANA, id: 'a0000000-0000-4000-8000-000000000002', first_name: 'Ben', email: 'ben@cuedeck-test.io', company: 'Fabrikam Demo', qr_token: 'tok-ben', checked_in_at: null };

type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[];
  heartbeat?: (args: Record<string, unknown>) => unknown; isOwner?: boolean; status?: string;
  alerts?: (args: Record<string, unknown>) => unknown; serverNow?: () => unknown; badgeDesign?: Record<string, unknown> };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN], heartbeat = () => 'Desk 1', isOwner = false, status = 'live', alerts = () => [], serverNow, badgeDesign }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', heartbeat);
  await rpc(page, 'checkin_recent_alerts', alerts);
  if (serverNow) await rpc(page, 'checkin_server_now', serverNow);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role, is_owner: isOwner, status })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status, ...(badgeDesign ? { badge_design: badgeDesign, registration_brand_color: '#0F766E' } : {}) }]);
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
  const reread = page.waitForResponse(r => r.url().includes('/rest/v1/leod_checkin_attendees')
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

test('a walk-in request that gets no answer says it may or may not have been added', async ({ page }) => {
  await open(page, { role: 'lead' });
  await page.route(/\/functions\/v1\/checkin-add-walk-in/, r => r.abort('failed'));
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('The server did not answer, so the walk-in may or may not have been added. Search for the name before adding it again.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#walkin')).toBeHidden();
});

// Fix round 1. The desk is used at live events: a roles module that fails
// to load must leave a working desk, not a loading screen.
test('the desk still opens and checks people in when the roles module fails to load', async ({ page }) => {
  let tries = 0;
  await page.route(/\/checkin-roles\.js(\?|$)/, r => { tries++; return r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }); });
  await open(page, { role: 'lead' });
  expect(tries).toBe(2);
  await expect(page.locator('#st-walkin')).toBeHidden();
  await expect(page.locator('#st-kiosk')).toBeHidden();
  await expect(page.locator('#st-notice')).toHaveText('Some desk controls did not load. Reload when the connection is steady.');
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict')).toContainText('Ben Probe is checked in');
  const sent = (await req).postDataJSON() as { items: { action: string; attendee_id: string }[] };
  expect(sent.items).toMatchObject([{ action: 'checkin', attendee_id: BEN.id }]);
});

test('the desk opens on the fallback when the roles module never answers', async ({ page }) => {
  test.setTimeout(40000);
  // Held forever: each try gives up on its own time limit.
  await page.route(/\/checkin-roles\.js(\?|$)/, () => {});
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'crew' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', [ANA, BEN]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#station')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#st-notice')).toHaveText('Some desk controls did not load. Reload when the connection is steady.');
});

test('the desk shows no notice when the roles module loads', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-notice')).toBeHidden();
});

test('a walk-in the server answered with an error it could not explain was not added', async ({ page }) => {
  await open(page, { role: 'lead' });
  await page.route(/\/functions\/v1\/checkin-add-walk-in/, r => r.request().method() === 'OPTIONS'
    ? r.fulfill({ status: 200, body: 'ok' })
    : r.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }));
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('The walk-in was not added. Try again.');
});

test('a walk-in answered after switching event stays out of the new event', async ({ page }) => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  await open(page, { role: 'lead' });
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'lead' }), myEventsRow({ role: 'lead', event_id: OTHER, name: 'Other Summit' })]);
  let release: () => void = () => {};
  const held = new Promise<void>(res => { release = res; });
  await page.route(/\/functions\/v1\/checkin-add-walk-in/, async r => {
    if (r.request().method() === 'OPTIONS') { await r.fulfill({ status: 200, body: 'ok' }); return; }
    await held;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, attendee: {
      id: 'a0000000-0000-4000-8000-000000000009', event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', email: null,
      company: null, ticket_type: 'attendee', qr_token: 'tok-walt', checked_in_at: null, badge_printed_at: null } }) });
  });
  const answered = page.waitForResponse(r => r.url().includes('/functions/v1/checkin-add-walk-in') && r.request().method() === 'POST');
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-save').click();
  await page.keyboard.press('Escape');
  await page.locator('#st-switch').click();
  await page.locator('.ck-ev', { hasText: 'Other Summit' }).click();
  await expect(page.locator('#station')).toBeVisible();
  await expect(page.locator('#st-event')).toHaveText('Other Summit');
  release();
  await answered;
  // The button resets in the same turn that would have added the row.
  await expect(page.locator('#wi-save')).toHaveText('Add to the list');
  const names = await page.evaluate(() => (window as unknown as { S: { roster: { first_name: string }[] } }).S.roster.map(a => a.first_name));
  expect(names).not.toContain('Walt');
  await expect(page.locator('#party')).not.toContainText('Walt Walkin');
});

test('a forbidden undo refreshes an open search list', async ({ page }) => {
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
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-undo').click();
  await expect(page.locator('#verdict')).toContainText('Ask a desk lead to undo this check-in.');
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.pill-in')).toBeVisible();
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-undo')).toHaveText('Undo check-in');
});

test('a viewer with no event in the link is pointed to the dashboard', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'viewer' })]);
  await page.goto('/cuedeck-checkin.html');
  await expect(page.locator('#pk-list')).toHaveText('Your role on these events is Viewer. Open the dashboard from your events page.');
  await expect(page.locator('#pk-list a')).toHaveAttribute('href', '/checkin');
});

test('someone with no events at all still reads that they have none', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', []);
  await page.goto('/cuedeck-checkin.html');
  await expect(page.locator('#pk-list')).toHaveText('You have no check-in events yet.');
});

test('closing the walk-in form puts the cursor back in the scan field', async ({ page }) => {
  await open(page, { role: 'lead' });
  await page.locator('#st-walkin').click();
  await expect(page.locator('#wi-first')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scan')).toBeFocused({ timeout: 1000 });
  // Read in the same turn as the close: the desk must hand focus back
  // itself, not wait for the browser or the 5-second backstop.
  await page.locator('#st-walkin').click();
  await expect(page.locator('#wi-first')).toBeFocused();
  const focused = await page.evaluate(() => { document.getElementById('wi-close')!.click(); return document.activeElement && document.activeElement.id; });
  expect(focused).toBe('scan');
});

test('the desk reports in with a stable desk id and shows its label', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'crew', heartbeat: (args) => { beats.push(args); return 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  await expect(page.locator('#st-desk')).toHaveAttribute('aria-label', 'Rename this desk, currently Desk 1');
  const deskId = await page.evaluate(() => localStorage.getItem('ck_desk_id'));
  expect(deskId).toMatch(/^[0-9a-f-]{36}$/);
  expect(beats[0]).toEqual({ p_event_id: EVENT_ID, p_desk_id: deskId, p_label: null, p_pending_count: 0 });

  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  expect((await req).postDataJSON().desk_id).toBe(deskId);
});

test('renaming the desk sends the new label', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'lead', heartbeat: (args) => { beats.push(args); return (args.p_label as string) || 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  await page.locator('#st-desk').click();
  await expect(page.locator('#desk-rename')).toBeVisible();
  await expect(page.getByLabel('Desk name', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Desk name', { exact: true })).toHaveValue('Desk 1');
  await page.getByLabel('Desk name', { exact: true }).fill('VIP desk');
  await page.getByRole('button', { name: 'Save desk name' }).click();
  await expect(page.locator('#st-desk')).toHaveText('VIP desk · Rename');
  await expect(page.locator('#desk-rename')).toBeHidden();
  await expect(page.locator('#scan')).toBeFocused();
  expect(beats.some(b => b.p_label === 'VIP desk')).toBe(true);
});

test('a viewer never sends a heartbeat', async ({ page }) => {
  let beats = 0;
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'viewer' })]);
  await rpc(page, 'checkin_desk_heartbeat', () => { beats++; return 'Desk 1'; });
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
  expect(beats).toBe(0);
});

// Beyond the plan (Task 14 controller context).
test('a failing heartbeat never stops a check-in, and the next tick retries', async ({ page }) => {
  let beats = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', () => { beats++; return { message: 'boom' }; }, 500);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'crew' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', [ANA, BEN]);
  await fn(page, 'checkin-record-scans', (b) => ({ body: { ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }));
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#station')).toBeVisible();
  await expect.poll(() => beats).toBe(1);
  await expect(page.locator('#st-desk')).toHaveText('This desk · Rename');
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict')).toContainText('Ben Probe is checked in');
  await page.clock.runFor(16000);   // the flush timer
  await req;
  const after = beats;              // the settled flush reports in too
  await page.clock.runFor(30000);
  await expect.poll(() => beats).toBeGreaterThan(after);
});

test('switching event stops the old desk heartbeat and starts one for the new event', async ({ page }) => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const beats: Record<string, unknown>[] = [];
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', (a) => { beats.push(a); return a.p_event_id === OTHER ? 'Desk 4' : 'Desk 1'; });
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'lead' }), myEventsRow({ role: 'lead', event_id: OTHER, name: 'Other Summit' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', [ANA, BEN]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  await page.locator('#st-switch').click();
  await expect(page.locator('#picker')).toBeVisible();
  const n = beats.length;
  await page.clock.runFor(65000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.clock.runFor(1000);
  await page.waitForTimeout(500);
  expect(beats.length).toBe(n);   // nothing sent from the picker, not even on reconnect
  await page.locator('.ck-ev', { hasText: 'Other Summit' }).click();
  await expect(page.locator('#st-desk')).toHaveText('Desk 4 · Rename');
  await page.clock.runFor(65000);
  await expect.poll(() => beats.length).toBeGreaterThanOrEqual(n + 3);
  expect(beats.slice(n).every(b => b.p_event_id === OTHER)).toBe(true);
});

test('a desk whose storage is blocked keeps one in-memory desk id', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) { if (k === 'ck_desk_id') throw new Error('SecurityError'); return get.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (k === 'ck_desk_id') throw new Error('QuotaExceededError'); return set.call(this, k, v); };
  });
  await open(page, { role: 'crew', heartbeat: (a) => { beats.push(a); return 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  const deskId = (await req).postDataJSON().desk_id;
  expect(deskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await expect.poll(() => beats.length).toBeGreaterThanOrEqual(2);
  expect(beats.every(b => b.p_desk_id === deskId)).toBe(true);
});

test('a desk label is shown as text, and a rename is cleaned, trimmed and capped at 40', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'lead', heartbeat: (a) => { beats.push(a); return (a.p_label as string) || '<b>Desk</b> 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('<b>Desk</b> 1 · Rename');
  await expect(page.locator('#st-desk b')).toHaveCount(0);
  await page.locator('#st-desk').click();
  // 39 characters once cleaned, then two astral letters: the cap counts
  // characters, so the 40th is the whole first one, never half of it.
  await page.getByLabel('Desk name', { exact: true }).fill('   Main \u202E  entrance\tdesk ' + 'x'.repeat(20) + '\u{1D538}\u{1D539}  ');
  await page.getByRole('button', { name: 'Save desk name' }).click();
  const want = 'Main entrance desk ' + 'x'.repeat(20);
  expect(Array.from(want)).toHaveLength(39);
  await expect(page.locator('#st-desk')).toHaveText(want + '\u{1D538} · Rename');
  expect(beats.at(-1)!.p_label).toBe(want + '\u{1D538}');
});

test('a kiosk never sends a desk heartbeat', async ({ page }) => {
  let beats = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', () => { beats++; return 'Desk 1'; });
  await page.goto('/cuedeck-checkin.html?mode=kiosk');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.clock.runFor(65000);
  await page.waitForTimeout(500);
  expect(beats).toBe(0);
});

// Task 14 fix round 1.
test('Escape cancels a rename and hands focus back to the scan field', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'crew', heartbeat: (a) => { beats.push(a); return (a.p_label as string) || 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  await page.locator('#st-desk').click();
  await page.getByLabel('Desk name', { exact: true }).fill('Not this');
  await page.keyboard.press('Escape');
  await expect(page.locator('#desk-rename')).toBeHidden();
  await expect(page.locator('#scan')).toBeFocused();
  await page.locator('#st-desk').click();
  await expect(page.getByLabel('Desk name', { exact: true })).toHaveValue('Desk 1');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#desk-rename')).toBeHidden();
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  expect(beats.some(b => b.p_label)).toBe(false);
});

test('a badge scanned into the rename field does not become the desk name', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'lead', heartbeat: (a) => { beats.push(a); return (a.p_label as string) || 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  await page.locator('#st-desk').click();
  await page.getByLabel('Desk name', { exact: true }).fill('');
  await page.keyboard.type('tok-ben');   // a wedge scanner: keystrokes, then Enter
  await page.keyboard.press('Enter');
  await expect(page.locator('#dr-err')).toHaveText('That looks like a badge code, not a desk name.');
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  // The last value scanned at the desk counts too, even one not on the list.
  await page.keyboard.press('Escape');
  await page.locator('#scan').fill('ZZ-UNKNOWN-42');
  await page.locator('#scan').press('Enter');
  await page.locator('#st-desk').click();
  await page.getByLabel('Desk name', { exact: true }).fill('');
  await page.keyboard.type('ZZ-UNKNOWN-42');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dr-err')).toHaveText('That looks like a badge code, not a desk name.');
  expect(beats.some(b => b.p_label)).toBe(false);
});

test('a heartbeat answered after a rename does not put the old label back', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1 · Rename');
  let release: () => void = () => {};
  const held = new Promise<void>(res => { release = res; });
  let sawHeld = false;
  await page.route(/\/rest\/v1\/rpc\/checkin_desk_heartbeat/, async r => {
    const a = r.request().postDataJSON();
    if (!a.p_label && !sawHeld) { sawHeld = true; await held; }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a.p_label || 'Desk 1') });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));   // a beat, held
  await expect.poll(() => sawHeld).toBe(true);
  await page.locator('#st-desk').click();
  await page.getByLabel('Desk name', { exact: true }).fill('VIP desk');
  await page.getByRole('button', { name: 'Save desk name' }).click();
  await expect(page.locator('#st-desk')).toHaveText('VIP desk · Rename');
  const late = page.waitForResponse(r => r.url().includes('checkin_desk_heartbeat'));
  release();
  await late;
  await page.waitForTimeout(200);
  await expect(page.locator('#st-desk')).toHaveText('VIP desk · Rename');
});

test('a check-in queued offline is flushed with the desk id on reconnect', async ({ page, context }) => {
  await open(page, { role: 'crew' });
  const deskId = await page.evaluate(() => localStorage.getItem('ck_desk_id'));
  await context.setOffline(true);
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict')).toContainText('Ben Probe is checked in');
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await context.setOffline(false);
  const body = (await req).postDataJSON();
  expect(body.desk_id).toBe(deskId);
  expect(body.items).toMatchObject([{ action: 'checkin', attendee_id: BEN.id }]);
});

test('the test banner offers no Go live to an organizer', async ({ page }) => {
  await open(page, { role: 'organizer', status: 'test' });
  await expect(page.locator('#st-test')).toBeVisible();
  await expect(page.locator('#st-test a', { hasText: 'Go live' })).toHaveCount(0);
});

test('the owner sees Go live on the test banner', async ({ page }) => {
  await open(page, { role: 'owner', isOwner: true, status: 'test' });
  await expect(page.locator('#st-test')).toBeVisible();
  await expect(page.locator('#st-test a', { hasText: 'Go live' })).toBeVisible();
});

// ── Arrival alerts on the desk (event-day spec, feature 5) ──
const DESK_ALERTS = [
  { id: 'x2', created_at: '2026-10-18T08:59:00Z', name: 'Ewa Sample', company: 'Contoso Demo', ticket_type: 'Speaker', desk_label: 'Desk 2', still_in: true },
  { id: 'x1', created_at: '2026-10-18T08:40:00Z', name: 'Jan <i>Undone</i>', company: null, ticket_type: 'VIP', desk_label: null, still_in: false },
];

test('a desk lead sees arrival alerts and the scan field keeps focus', async ({ page }) => {
  await open(page, { role: 'lead', alerts: () => DESK_ALERTS });
  const items = page.locator('#st-alert-list li');
  await expect(page.locator('#st-alerts')).toBeVisible();
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText('10:59 Ewa Sample (Speaker, Contoso Demo) just checked in at Desk 2');
  await expect(items.nth(1)).toHaveText('Undone10:40 Jan <i>Undone</i> (VIP) checked in, since undone');
  await expect(items.nth(1)).toHaveClass(/undone/);
  // The first load is history, not news: nothing is highlighted.
  await expect(page.locator('#st-alert-list li.fresh')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('scan');
});

test('desk staff never see alerts and never ask for them', async ({ page }) => {
  let asked = 0;
  await open(page, { role: 'crew', alerts: () => { asked++; return DESK_ALERTS; } });
  await expect(page.locator('#st-alerts')).toBeHidden();
  await page.waitForTimeout(300);
  expect(asked).toBe(0);
});

test('a lead with no alerts sees no empty box', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-alerts')).toBeHidden();
});

// ── Clock (desk stamps use the server's clock) ──
test('a desk whose clock is 10 minutes slow stamps check-ins with the server time and says so', async ({ page }) => {
  let sent: { scanned_at?: string }[] = [];
  // FIXED_NOW is the device clock; the server is 10 minutes ahead of it.
  const serverIso = new Date(FIXED_NOW.getTime() + 10 * 60000).toISOString();
  await open(page, { role: 'lead', serverNow: () => serverIso });
  await fn(page, 'checkin-record-scans', (b) => { sent = b.items as { scanned_at?: string }[];
    return { body: { ok: true, errors: [], results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }; });
  await expect(page.locator('#st-clock')).toHaveText("This device's clock is 10 minutes slow. Check-in times use the server's clock instead.");
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const stamped = Date.parse(sent[0].scanned_at as string);
  expect(Math.abs(stamped - Date.parse(serverIso))).toBeLessThan(5000);
});

test('without a clock reply the desk keeps the device clock and shows no notice', async ({ page }) => {
  await open(page, { role: 'crew' });
  await expect(page.locator('#station')).toBeVisible();
  await expect(page.locator('#st-clock')).toBeHidden();
});

// ── Pairing a door scanner (scanner Build A) ──
const SP_DOOR = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const SP_ROOM = 'aaaaaaaa-0000-4000-8000-0000000000d2';

test('a lead pairs a door scanner to a scan point and sees scanners in the device list', async ({ page }) => {
  let minted: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await table(page, 'leod_checkin_scan_points', [{ id: SP_DOOR, name: 'Main door', kind: 'entrance' }, { id: SP_ROOM, name: 'Hall B', kind: 'interior' }]);
  await table(page, 'leod_checkin_devices', [
    { id: 'dev-1', label: 'Lobby tablet', kind: 'kiosk', last_seen_at: null, created_at: '2026-10-18T07:00:00Z', revoked_at: null },
    { id: 'dev-2', label: 'Door phone', kind: 'scanner', last_seen_at: null, created_at: '2026-10-18T07:30:00Z', revoked_at: null },
  ]);
  await fn(page, 'checkin-kiosk-pair', (b) => { minted = b; return { body: { ok: true, code: 'ABCD-EFGH', expires_at: new Date(FIXED_NOW.getTime() + 600000).toISOString(), device_kind: 'scanner' } }; });
  await page.locator('#st-kiosk').click();
  await expect(page.locator('#ks-dev-list')).toContainText('Scanner, paired');
  await expect(page.locator('#ks-dev-list')).toContainText('Kiosk, paired');
  await page.locator('.ks-kind', { hasText: 'Door scanner phone' }).click();
  await expect(page.locator('#ks-title')).toHaveText('Set up a door scanner');
  await expect(page.locator('#ks-point option')).toHaveText(['Main door (door)', 'Hall B (session room)']);
  await page.locator('#ks-point').selectOption(SP_ROOM);
  await page.locator('#ks-label').fill('Hall B phone');
  await page.locator('#ks-mint').click();
  await expect(page.locator('#ks-title')).toHaveText('Enter this code on the phone');
  expect(minted).toEqual({ action: 'mint', event_id: EVENT_ID, label: 'Hall B phone', device_kind: 'scanner', scan_point_id: SP_ROOM });
  await expect(page.locator('.ks-url')).toHaveText(/\/checkin\/scan$/);
});

test('a scanning refusal from the server is shown as written', async ({ page }) => {
  await open(page, { role: 'lead' });
  await table(page, 'leod_checkin_scan_points', [{ id: SP_DOOR, name: 'Main door', kind: 'entrance' }]);
  await table(page, 'leod_checkin_devices', []);
  await fn(page, 'checkin-kiosk-pair', () => ({ status: 403, body: { error: 'Door scanning is switched off for this event. Ask the organizer to turn it on in Setup, or check people in at the desk.' } }));
  await page.locator('#st-kiosk').click();
  await page.locator('.ks-kind', { hasText: 'Door scanner phone' }).click();
  await page.locator('#ks-label').fill('Door phone');
  await page.locator('#ks-mint').click();
  await expect(page.locator('#ks-err')).toHaveText(/^Door scanning is switched off for this event/);
});

test('with no scan points the scanner form says where to add them', async ({ page }) => {
  await open(page, { role: 'lead' });
  await table(page, 'leod_checkin_scan_points', []);
  await table(page, 'leod_checkin_devices', []);
  await page.locator('#st-kiosk').click();
  await page.locator('.ks-kind', { hasText: 'Door scanner phone' }).click();
  await expect(page.locator('#ks-point option')).toHaveText(['No doors or rooms yet: add them in Setup, Kiosk & scanners']);
  await page.locator('#ks-label').fill('Door phone');
  await page.locator('#ks-mint').click();
  await expect(page.locator('#ks-err')).toContainText('Choose the door or room');
});


test('the desk prints the badge design of the event: stock size, ticket colour and QR', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __prints: string[] }).__prints = []; window.print = () => {
    (window as unknown as { __prints: string[] }).__prints.push(document.getElementById('badge-sheet')!.innerHTML); }; });
  await open(page, { role: 'crew', roster: [ANA, { ...BEN, ticket_type: 'VIP' }],
    badgeDesign: { w: 148, h: 105, band: true, logo: false, name: 'split', company: true, ticket: true, qr: true, align: 'center', colors: { VIP: '#C9A227' } } });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: string[] }).__prints.length)).toBe(1);
  const html = await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints[0]);
  expect(html).toContain('width: 148mm; height: 105mm');
  expect(html).toMatch(/background:\s*(#C9A227|rgb\(201, 162, 39\))/);
  expect(html).toContain('<svg');
  expect(html).toContain('>Ben<');
  expect(await page.locator('#badge-page').textContent()).toBe('@page { size: 148mm 105mm; margin: 0; }');
});
