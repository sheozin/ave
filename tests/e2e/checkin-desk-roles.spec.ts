// tests/e2e/checkin-desk-roles.spec.ts
// The check-in desk for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, USER_ID, FIXED_NOW } from './checkin-mock';

const ANA = { id: 'a0000000-0000-4000-8000-000000000001', event_id: EVENT_ID, first_name: 'Ana', last_name: 'Probe', email: 'ana@cuedeck-test.io',
  company: 'Contoso Demo', ticket_type: 'attendee', qr_token: 'tok-ana', checked_in_at: '2026-10-18T08:30:00.000Z', badge_printed_at: null };
const BEN = { ...ANA, id: 'a0000000-0000-4000-8000-000000000002', first_name: 'Ben', email: 'ben@cuedeck-test.io', company: 'Fabrikam Demo', qr_token: 'tok-ben', checked_in_at: null };

type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[];
  heartbeat?: (args: Record<string, unknown>) => unknown; isOwner?: boolean; status?: string;
  alerts?: (args: Record<string, unknown>) => unknown; serverNow?: () => unknown; badgeDesign?: Record<string, unknown>; before?: () => Promise<void>; oldBadges?: Record<string, unknown>[] };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN], heartbeat = () => 'Desk 1', isOwner = false, status = 'live', alerts = () => [], serverNow, badgeDesign, before, oldBadges = [] }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', heartbeat);
  await rpc(page, 'checkin_recent_alerts', alerts);
  if (serverNow) await rpc(page, 'checkin_server_now', serverNow);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role, is_owner: isOwner, status })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status, ...(badgeDesign ? { badge_design: badgeDesign, registration_brand_color: '#0F766E' } : {}) }]);
  await table(page, 'leod_checkin_attendees', roster);
  await table(page, 'leod_checkin_old_badges', oldBadges);
  await fn(page, 'checkin-record-scans', (b) => ({ body: {
    ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string; action: string }[]).map(i => [i.client_id, scanResult(i)])),
  } }));
  if (before) await before();
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
    const open = indexedDB.open('cuedeck-checkin');
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

async function addWalt(page, email = '') {
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  if (email) await page.locator('#wi-email').fill(email);
  await page.locator('#wi-save').click();
}

test('offline, a walk-in is added, checked in, and sent when the connection is back', async ({ page, context }) => {
  const sent: Record<string, unknown>[] = [];
  const scans: { attendee_id: string; action: string }[] = [];
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', (b) => { sent.push(b); return { body: { ok: true, attendee: {
    id: b.client_id, event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', email: null, company: null,
    ticket_type: 'attendee', qr_token: b.qr_token, checked_in_at: null, badge_printed_at: null } } }; });
  await fn(page, 'checkin-record-scans', (b) => { scans.push(...(b.items as typeof scans)); return { body: { ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }; });
  await context.setOffline(true);
  await addWalt(page);
  await expect(page.locator('#walkin')).toBeHidden();
  await expect(page.locator('#party')).toContainText('Walt Walkin');
  await page.locator('#secondary').click();
  await expect(page.locator('#st-sync')).toHaveText('Offline · 2 waiting');
  expect(sent).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.locator('#st-sync')).toHaveText('All synced');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', queued: true });
  expect(String(sent[0].client_id)).toMatch(/^[0-9a-f-]{36}$/);
  expect(String(sent[0].qr_token)).toMatch(/^[0-9a-f]{32}$/);
  // The check-in went out after the walk-in, under the id the desk made.
  expect(scans).toEqual([expect.objectContaining({ attendee_id: sent[0].client_id, action: 'checkin' })]);
});

test('a walk-in request that gets no answer is kept on the desk and sent again with the same ids', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  let fail = true;
  await open(page, { role: 'lead' });
  await page.route(/\/functions\/v1\/checkin-add-walk-in/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: 'ok' });
    const b = r.request().postDataJSON();
    sent.push(b);
    if (fail) return r.abort('failed');
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, attendee: {
      id: b.client_id, event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', email: null, company: null,
      ticket_type: 'attendee', qr_token: b.qr_token, checked_in_at: null, badge_printed_at: null } }) });
  });
  await addWalt(page);
  await expect(page.locator('#walkin')).toBeHidden();
  await expect(page.locator('#party')).toContainText('Walt Walkin');
  await expect(page.locator('#st-sync')).toContainText('1 waiting');
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#st-sync')).toHaveText('All synced');
  expect(sent.length).toBeGreaterThanOrEqual(2);
  expect(sent.at(-1)).toMatchObject({ client_id: sent[0].client_id, qr_token: sent[0].qr_token, queued: true });
});

test('a walk-in whose email is already on the list is refused at the desk, even offline', async ({ page, context }) => {
  let calls = 0;
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => { calls++; return { body: {} }; });
  await context.setOffline(true);
  await addWalt(page, 'BEN@cuedeck-test.io');
  await expect(page.locator('#wi-err')).toHaveText('Someone with this email is already on the list. Search for them instead.');
  await context.setOffline(false);
  expect(calls).toBe(0);
});

test('an offline walk-in who had registered from another desk is merged onto that registration', async ({ page, context }) => {
  const CARL = { ...BEN, id: 'a0000000-0000-4000-8000-000000000003', first_name: 'Walt', last_name: 'Walkin', email: 'walt@cuedeck-test.io', qr_token: 'tok-carl' };
  const scans: { attendee_id: string }[] = [];
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => ({ body: { ok: true, merged: true, attendee: CARL } }));
  await fn(page, 'checkin-record-scans', (b) => { scans.push(...(b.items as typeof scans)); return { body: { ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }; });
  await context.setOffline(true);
  await addWalt(page, 'walt@cuedeck-test.io');
  await page.locator('#secondary').click();
  await context.setOffline(false);
  await expect(page.locator('#verdict')).toContainText('already registered');
  await expect(page.locator('#verdict')).toContainText('Reprint the badge');
  await expect.poll(() => scans.map(s => s.attendee_id)).toEqual([CARL.id]);
});

test('an offline walk-in the server refuses is taken off the desk with the reason', async ({ page, context }) => {
  const scans: unknown[] = [];
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => ({ status: 409, body: { error: 'This event was deleted.', code: 'archived' } }));
  await fn(page, 'checkin-record-scans', (b) => { scans.push(...(b.items as unknown[])); return { body: { ok: true, errors: [], results: {} } }; });
  await context.setOffline(true);
  await addWalt(page);
  await page.locator('#secondary').click();
  await context.setOffline(false);
  await expect(page.locator('#verdict')).toContainText('A walk-in was not added');
  await expect(page.locator('#verdict')).toContainText('Walt Walkin: This event was deleted.');
  await expect(page.locator('#st-sync')).toHaveText('All synced');
  await search(page, 'Walt');
  await expect(page.locator('.ck-res-row', { hasText: 'Walt Walkin' })).toHaveCount(0);
  expect(scans).toHaveLength(0);
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

test('the desk opens on the fallback when the roles module never answers', async ({ page, context }) => {
  test.setTimeout(40000);
  // Held forever: each try gives up on its own time limit. On the context,
  // so the retry is held too when the desk's service worker fetches it.
  await context.route(/\/checkin-roles\.js(\?|$)/, () => {});
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

test('the desk prints the visa-next-full template: a 76 x 62 mm page with the rendered label image', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __prints: string[] }).__prints = []; window.print = () => {
    const img = document.querySelector('#badge-sheet img') as HTMLImageElement | null;
    (window as unknown as { __prints: string[] }).__prints.push(img && img.complete && img.naturalWidth === 898 && img.naturalHeight === 696 ? img.alt : 'not ready'); }; });
  await open(page, { role: 'crew', roster: [ANA, { ...BEN, role_title: 'CTO' }], badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: string[] }).__prints.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints[0])).toContain('Ben');
  expect(await page.locator('#badge-page').textContent()).toBe('@page { size: 76mm 62mm; margin: 0; }');
});

// The print helper (print-helper/) on 127.0.0.1:7841, faked with routes.
async function withHelper(page, print: (b: { labels: string[] }) => { status: number; body: unknown }) {
  await page.addInitScript(() => { localStorage.setItem('ck_print_helper', '1'); (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => { (window as unknown as { __prints: number }).__prints++; }; });
  await page.route('http://127.0.0.1:7841/status', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true, version: '1.0.0', printer: '192.168.1.50', cut_mm: 76, status: { errors: [], media: { width_mm: 62, type: 'continuous', length_mm: 0 } }, error: null, warning: null }) }));
  await page.route('http://127.0.0.1:7841/print', r => { const o = print(r.request().postDataJSON()); return r.fulfill({ status: o.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o.body) }); });
}

test('with the print helper on, a template badge goes straight to the Brother, not the print dialog', async ({ page }) => {
  const jobs: { labels: string[] }[] = [];
  await withHelper(page, (b) => { jobs.push(b); return { status: 200, body: { ok: true, labels: 1, cut_mm: 76 } }; });
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await expect(page.locator('#ck-printer')).toContainText('Printing straight to the Brother at 192.168.1.50');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => jobs.length).toBe(1);
  expect(jobs[0].labels[0]).toMatch(/^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('a printer error from the helper is shown and the badge is not marked printed', async ({ page }) => {
  const stamps: unknown[] = [];
  await withHelper(page, () => ({ status: 502, body: { error: 'cannot reach the printer at 192.168.1.50 (ECONNREFUSED)' } }));
  await page.route(/\/rest\/v1\/leod_checkin_attendees\?.*id=in/, r => { if (r.request().method() === 'PATCH') stamps.push(r.request().postDataJSON()); return r.fallback(); });
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-printer')).toContainText('Badge not printed: cannot reach the printer');
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
  expect(stamps).toEqual([]);
});

test('without the helper switched on, the desk never contacts this computer and points to print stations', async ({ page }) => {
  let contacted = false;
  await page.route('http://127.0.0.1:7841/**', r => { contacted = true; return r.abort(); });
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await expect(page.locator('#ck-print-to')).toHaveValue('browser');
  await expect(page.locator('#ck-printer')).toContainText('pair a print station');
  expect(contacted).toBe(false);
});

test('with the print helper on, a Designer badge that fits the 62 mm roll goes to the Brother, cut at its length', async ({ page }) => {
  const jobs: { labels: string[]; cut_mm: number }[] = [];
  await withHelper(page, (b) => { jobs.push(b as { labels: string[]; cut_mm: number }); return { status: 200, body: { ok: true, labels: 1, cut_mm: 100 } }; });
  await open(page, { role: 'crew', badgeDesign: { w: 100, h: 62, qr: true, company: true, ticket: true, name: 'full', align: 'left', colors: {} } });
  await expect(page.locator('#ck-printer')).toContainText('Printing straight to the Brother');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => jobs.length).toBe(1);
  expect(jobs[0].cut_mm).toBe(100);
  const size = await page.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, jobs[0].labels[0]);
  expect(size).toEqual([1123, 696]);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('a badge wider than the roll says so and prints through the browser', async ({ page }) => {
  let posted = false;
  await withHelper(page, () => { posted = true; return { status: 200, body: { ok: true } }; });
  await open(page, { role: 'crew', badgeDesign: { w: 148, h: 105, company: true, ticket: true, name: 'full', align: 'center', colors: {} } });
  await expect(page.locator('#ck-printer')).toContainText('wider than the 62 mm label roll');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  expect(posted).toBe(false);
});

// Print stations (migration 142): any device sends the badge through CueDeck.
async function withStation(page, jobStatus: () => { status: string; error?: string | null }) {
  await page.addInitScript(() => { (window as unknown as { __prints: number }).__prints = 0; window.print = () => { (window as unknown as { __prints: number }).__prints++; }; });
  const queued: Record<string, unknown>[] = [];
  return { queued, setup: async () => {
    await rpc(page, 'checkin_print_stations', [{ id: 'aaaaaaaa-0000-4000-8000-0000000000d1', label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online: true }]);
    await rpc(page, 'checkin_queue_print', (a) => { queued.push(a); return ['bbbbbbbb-0000-4000-8000-0000000000f1']; });
    await table(page, 'leod_checkin_print_jobs', [{ id: 'bbbbbbbb-0000-4000-8000-0000000000f1', ...jobStatus() }]);
  } };
}

test('with one print station paired, the desk sends the badge to it and says when it printed', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: st.setup });
  await expect(page.locator('#ck-print-to')).toHaveValue('station:aaaaaaaa-0000-4000-8000-0000000000d1');
  await expect(page.locator('#ck-print-msg')).toContainText('Ready: badges go to Desk printer.');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Printed on Desk printer.', { timeout: 10000 });
  const q = st.queued[0] as { p_device_id: string; p_labels: { png: string; cut_mm: number }[] };
  expect(q.p_device_id).toBe('aaaaaaaa-0000-4000-8000-0000000000d1');
  expect(q.p_labels[0].cut_mm).toBe(76);
  expect(q.p_labels[0].png).toMatch(/^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('when CueDeck cannot be reached, the badge goes straight to the station over the venue network', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  const LAN = { host: '192.168.1.130', port: 7842, token: 'c'.repeat(32) };
  const lanCalls: { headers: Record<string, string>; body: { labels: string[]; cut_mm: number } }[] = [];
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: async () => {
    await st.setup();
    await rpc(page, 'checkin_print_stations', [{ id: 'aaaaaaaa-0000-4000-8000-0000000000d1', label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online: true, printer_info: { model: 'brother-ql', lan: LAN } }]);
  } });
  // The venue's internet is down: CueDeck never answers.
  await page.route(/\/rest\/v1\/rpc\/checkin_queue_print/, r => r.abort('failed'));
  await page.route('http://192.168.1.130:7842/print', r => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    lanCalls.push({ headers: r.request().headers(), body: r.request().postDataJSON() });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Printed on Desk printer over the venue network.', { timeout: 10000 });
  expect(lanCalls).toHaveLength(1);
  expect(lanCalls[0].headers['x-cuedeck-token']).toBe(LAN.token);
  expect(lanCalls[0].body.cut_mm).toBe(76);
  expect(lanCalls[0].body.labels[0]).toMatch(/^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
  // The station list is kept on the device for a reload with no internet.
  expect(await page.evaluate((id) => localStorage.getItem('ck-stations:' + id), EVENT_ID)).toContain('192.168.1.130');
});

test('a venue-network address that is not private is never contacted', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  let contacted = 0;
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: async () => {
    await st.setup();
    await rpc(page, 'checkin_print_stations', [{ id: 'aaaaaaaa-0000-4000-8000-0000000000d1', label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online: true, printer_info: { model: 'brother-ql', lan: { host: 'evil.example', port: 7842, token: 'c'.repeat(32) } } }]);
  } });
  await page.route(/\/rest\/v1\/rpc\/checkin_queue_print/, r => r.abort('failed'));
  await page.route(/evil\.example/, r => { contacted++; return r.abort('failed'); });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge not printed: CueDeck could not be reached', { timeout: 10000 });
  expect(contacted).toBe(0);
});

test('with no internet and no venue-network address, the station badge says it was not printed', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: st.setup });
  await page.route(/\/rest\/v1\/rpc\/checkin_queue_print/, r => r.abort('failed'));
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge not printed: CueDeck could not be reached', { timeout: 10000 });
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('a print the station could not make is shown, and the desk never falls back to the print dialog', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'failed', error: 'Cover open' }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: st.setup });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge not printed: Cover open', { timeout: 10000 });
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('choosing Print dialog is remembered on this device and prints through the browser', async ({ page }) => {
  const st = await withStation(page, () => ({ status: 'done' }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: st.setup });
  await page.selectOption('#ck-print-to', 'browser');
  expect(await page.evaluate((id) => localStorage.getItem('ck_print_to:' + id), EVENT_ID)).toBe('browser');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  expect(st.queued).toEqual([]);
});

test('a lead pairs a print station by typing the code it shows', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await table(page, 'leod_checkin_devices', []);
  await fn(page, 'checkin-kiosk-pair', (b) => { sent = b; return { body: { ok: true, device_id: 'dev-p', label: 'Desk printer', info: { model: 'brother-ql' } } }; });
  await page.locator('#st-kiosk').click();
  await page.locator('.ks-kind', { hasText: 'Print station' }).click();
  await expect(page.locator('#ks-title')).toHaveText('Set up a print station');
  await page.locator('#ks-scode').fill('abcd efgh');
  await page.locator('#ks-label').fill('Desk printer');
  await page.locator('#ks-approve').click();
  await expect(page.locator('#ks-body')).toContainText('Paired. "Desk printer" now prints badges for this event');
  expect(sent).toEqual({ action: 'approve', event_id: EVENT_ID, code: 'ABCDEFGH', label: 'Desk printer', code_typed: true });
});

test('the Terminal route is still one click away for a print station', async ({ page }) => {
  let minted: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await table(page, 'leod_checkin_devices', []);
  await fn(page, 'checkin-kiosk-pair', (b) => { minted = b; return { body: { ok: true, code: 'WXYZ-2345', expires_at: new Date(FIXED_NOW.getTime() + 600000).toISOString(), device_kind: 'printer' } }; });
  await page.locator('#st-kiosk').click();
  await page.locator('.ks-kind', { hasText: 'Print station' }).click();
  await page.getByRole('button', { name: /Setting it up from Terminal/ }).click();
  await page.locator('#ks-label').fill('Desk printer');
  await page.locator('#ks-mint').click();
  expect(minted).toEqual({ action: 'mint', event_id: EVENT_ID, label: 'Desk printer', device_kind: 'printer' });
  await expect(page.locator('.ks-url')).toHaveText(/install\.sh \| sh -s -- WXYZ-2345$/);
});

test('a Zebra station gets the badge at full size, not squeezed to the Brother roll', async ({ page }) => {
  const queued: { p_labels: { png: string; cut_mm: number }[] }[] = [];
  await page.addInitScript(() => { window.print = () => {}; });
  await open(page, { role: 'crew', badgeDesign: { w: 102, h: 76, company: true, ticket: true, name: 'full', align: 'center', colors: {} }, before: async () => {
    await rpc(page, 'checkin_print_stations', [{ id: 'aaaaaaaa-0000-4000-8000-0000000000d2', label: 'Zebra', online: true, printer_info: { model: 'zebra', dpi: 203, width_mm: 104 } }]);
    await rpc(page, 'checkin_queue_print', (a) => { queued.push(a as never); return ['bbbbbbbb-0000-4000-8000-0000000000f2']; });
    await table(page, 'leod_checkin_print_jobs', [{ id: 'bbbbbbbb-0000-4000-8000-0000000000f2', status: 'done' }]);
  } });
  await expect(page.locator('#ck-print-msg')).toContainText('Ready: badges go to Zebra.');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect.poll(() => queued.length).toBe(1);
  const size = await page.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, queued[0].p_labels[0].png);
  expect(size).toEqual([1205, 898]);   // 102 x 76 mm at 300 dpi
  expect(queued[0].p_labels[0].cut_mm).toBe(102);
});

// ── a desk that opens with no internet (checkin-sw.js) ─────────────────────
// The page is kept by the service worker; events, settings and the guest
// list come from this device's saved copies.
async function untilWorkerControls(page) {
  await page.waitForFunction(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller; });
}

test('a desk reloaded with no internet opens with its events and guest list', async ({ page, context }) => {
  await open(page, { role: 'crew' });
  await untilWorkerControls(page);
  await context.setOffline(true);
  await page.reload();
  // The ?event= link was used up on the first open: the saved event list.
  await page.locator('.ck-ev', { hasText: 'Probe Summit' }).click();
  await expect(page.locator('#station')).toBeVisible();
  await expect(page.locator('#st-sync')).toContainText('Offline');
  await search(page, 'Ben');
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' })).toBeVisible();
  await context.setOffline(false);
});

test('a venue router with no uplink: an expired sign-in still opens the desk from saved copies', async ({ page, context }) => {
  await open(page, { role: 'lead', badgeDesign: { w: 90, h: 55 } });
  await untilWorkerControls(page);
  // The access token has expired and CueDeck cannot be reached, while the
  // browser still reports a network (navigator.onLine stays true). A second
  // tab, because the first one re-stores a valid sign-in on every load.
  await page.evaluate(() => {
    const k = 'sb-sawekpguemzvuvvulfbc-auth-token';
    const s = JSON.parse(localStorage.getItem(k)!);
    s.expires_at = Math.floor(Date.now() / 1000) - 1800;   // renewal due half an hour ago
    localStorage.setItem(k, JSON.stringify(s));
  });
  await context.route(/supabase\.co\//, r => r.abort('internetdisconnected'));
  await page.close();
  const desk = await context.newPage();
  const started = Date.now();
  await desk.goto('/cuedeck-checkin.html');
  await desk.locator('.ck-ev', { hasText: 'Probe Summit' }).click();
  await expect(desk.locator('#station')).toBeVisible();
  // Saved copies, not each call waiting out its time limit.
  expect(Date.now() - started).toBeLessThan(12000);
  await expect(desk.locator('#signin')).toBeHidden();
  await search(desk, 'Ana');
  await expect(desk.locator('.ck-res-row', { hasText: 'Ana Probe' })).toBeVisible();
});

test('a refusal from CueDeck is not replaced by the saved event list', async ({ page }) => {
  await open(page, { role: 'crew' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await signedIn(page);
  await rpc(page, 'checkin_my_events', { code: '42501', message: 'permission denied' }, 403);
  await page.reload();
  await expect(page.locator('#pk-note')).toContainText('Could not load your events');
  await expect(page.locator('.ck-ev')).toHaveCount(0);
});

test('a desk opened with no uplink prints over the venue network without asking CueDeck first', async ({ page, context }) => {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  const LAN = { host: '192.168.1.130', port: 7842, token: 'c'.repeat(32) };
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: async () => {
    await st.setup();
    await rpc(page, 'checkin_print_stations', [{ id: 'aaaaaaaa-0000-4000-8000-0000000000d1', label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online: true, printer_info: { model: 'brother-ql', lan: LAN } }]);
  } });
  await untilWorkerControls(page);
  await page.evaluate(() => {
    const k = 'sb-sawekpguemzvuvvulfbc-auth-token';
    const s = JSON.parse(localStorage.getItem(k)!);
    s.expires_at = Math.floor(Date.now() / 1000) - 1800;   // renewal due half an hour ago
    localStorage.setItem(k, JSON.stringify(s));
  });
  let askedCueDeck = 0, lanCalls = 0;
  await context.route(/supabase\.co\//, r => { if (r.request().url().includes('checkin_queue_print')) askedCueDeck++; return r.abort('internetdisconnected'); });
  await context.route('http://192.168.1.130:7842/print', r => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    lanCalls++;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
  await page.close();
  const desk = await context.newPage();
  await desk.goto('/cuedeck-checkin.html');
  await desk.locator('.ck-ev', { hasText: 'Probe Summit' }).click();
  await expect(desk.locator('#station')).toBeVisible();
  await expect(desk.locator('#ck-print-to')).toHaveValue('station:aaaaaaaa-0000-4000-8000-0000000000d1');
  await search(desk, 'Ben');
  await desk.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await desk.locator('#primary').click();
  await expect(desk.locator('#ck-print-msg')).toContainText('Printed on Desk printer over the venue network.', { timeout: 4000 });
  expect(lanCalls).toBe(1);
  expect(askedCueDeck).toBe(0);
});

test('a sign-out with no internet is not undone by reopening the desk', async ({ page, context }) => {
  await open(page, { role: 'crew' });
  await untilWorkerControls(page);
  await context.setOffline(true);
  await page.locator('#st-switch').click();
  await page.locator('#pk-signout').click();
  await expect(page.locator('#signin')).toBeVisible();
  await page.close();
  const desk = await context.newPage();   // the first tab re-stores a sign-in on every load
  await desk.goto('/cuedeck-checkin.html');
  await expect(desk.locator('#signin')).toBeVisible();
  await expect(desk.locator('#picker')).toBeHidden();
  await context.setOffline(false);
});

test('a desk unused for over 12 hours does not open offline on its stored sign-in', async ({ page, context }) => {
  await open(page, { role: 'crew' });
  await untilWorkerControls(page);
  await page.evaluate(() => {
    const k = 'sb-sawekpguemzvuvvulfbc-auth-token';
    const s = JSON.parse(localStorage.getItem(k)!);
    s.expires_at = Math.floor(Date.now() / 1000) - 13 * 3600;
    localStorage.setItem(k, JSON.stringify(s));
  });
  await context.setOffline(true);
  await page.close();
  const desk = await context.newPage();
  await desk.goto('/cuedeck-checkin.html');
  await expect(desk.locator('#signin')).toBeVisible({ timeout: 10000 });
  await context.setOffline(false);
});

test('a desk tab from before an update holds the database: the new desk says so, then opens once it closes', async ({ page, context }) => {
  // The older desk: version 1 of the database, held open as that code did.
  const old = await context.newPage();
  await old.goto('/favicon.svg');
  await old.evaluate(() => new Promise<void>((ok, no) => {
    const r = indexedDB.open('cuedeck-checkin', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('roster', { keyPath: 'id' }); r.result.createObjectStore('outbox', { keyPath: 'client_id' }); };
    r.onsuccess = () => { (window as unknown as { held: IDBDatabase }).held = r.result; ok(); };
    r.onerror = () => no(r.error);
  }));
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', () => 'Desk 1');
  await rpc(page, 'checkin_recent_alerts', () => []);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'crew' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', [ANA, BEN]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#db-blocked')).toContainText('Close the other check-in tabs');
  await expect(page.locator('#station')).toBeHidden();
  await old.close();
  await expect(page.locator('#station')).toBeVisible();
  await expect(page.locator('#db-blocked')).toHaveCount(0);
  await search(page, 'Ben');
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' })).toBeVisible();
});

test('the desk gives up its database connection when a newer desk needs to upgrade it', async ({ page, context }) => {
  await open(page, { role: 'crew' });
  const next = await context.newPage();
  await next.goto('/favicon.svg');
  const upgraded = await next.evaluate(() => new Promise<string>((ok) => {
    const r = indexedDB.open('cuedeck-checkin', 3);
    r.onblocked = () => ok('blocked');
    r.onsuccess = () => { r.result.close(); ok('upgraded'); };
  }));
  expect(upgraded).toBe('upgraded');
});

test('a desk queued behind another tab\'s pending upgrade says so too', async ({ page, context }) => {
  const old = await context.newPage();
  await old.goto('/favicon.svg');
  await old.evaluate(() => new Promise<void>((ok) => {
    const r = indexedDB.open('cuedeck-checkin', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('roster', { keyPath: 'id' }); };
    r.onsuccess = () => { (window as unknown as { held: IDBDatabase }).held = r.result; ok(); };
  }));
  // A second new tab already waiting on the upgrade.
  const first = await context.newPage();
  await first.goto('/favicon.svg');
  await first.evaluate(() => { indexedDB.open('cuedeck-checkin', 2); });
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', () => 'Desk 1');
  await rpc(page, 'checkin_recent_alerts', () => []);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'crew' })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', [ANA, BEN]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#db-blocked')).toContainText('Close the other check-in tabs', { timeout: 8000 });
  // The waiting tab goes first: left to finish, its bare upgrade would make
  // a version 2 without the desk's stores, which no real desk does.
  await first.close();
  await old.close();
  await expect(page.locator('#station')).toBeVisible();
});

test('a slow sign-in check at start (a browser just restarted) does not put an online desk on saved copies', async ({ page }) => {
  test.setTimeout(45000);
  // supabase-js answering the first getSession after 7 s, past the desk's wait.
  // The UMD build assigns window.supabase first and createClient onto it after.
  await page.addInitScript(() => {
    let lib: Record<string, unknown> | undefined;
    Object.defineProperty(window, 'supabase', { configurable: true, get: () => lib, set: (v) => {
      let create: ((...a: unknown[]) => { auth: { getSession: () => Promise<unknown> } }) | undefined;
      const wrap = (...a: unknown[]) => {
        const c = create!(...a);
        const get = c.auth.getSession.bind(c.auth);
        const until = performance.now() + 7000;
        c.auth.getSession = async () => { const wait = until - performance.now(); if (wait > 0) { (window as unknown as { slowed: boolean }).slowed = true; await new Promise(r => setTimeout(r, wait)); } return get(); };
        return c;
      };
      if (typeof v.createClient === 'function') create = v.createClient;
      Object.defineProperty(v, 'createClient', { configurable: true, enumerable: true, get: () => (create ? wrap : undefined), set: (f) => { create = f; } });
      lib = v;
    } });
  });
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: st.setup }).catch(() => {});
  await expect(page.locator('#station')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => (window as unknown as { slowed: boolean }).slowed)).toBe(true);
  expect(await page.evaluate('noServer')).toBe(false);
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Printed on Desk printer.', { timeout: 10000 });
  expect(st.queued).toHaveLength(1);
});

test('on a router with no uplink, where requests hang, the desk reopens within seconds', async ({ page, context }) => {
  test.setTimeout(60000);
  await open(page, { role: 'crew' });
  await untilWorkerControls(page);
  // Nothing answers: page files and CueDeck both hang (navigator.onLine stays true).
  await context.route(/supabase\.co\//, () => {});
  await context.route(/127\.0\.0\.1:7231\/(?!favicon)/, () => {});
  await page.close();
  const desk = await context.newPage();
  const started = Date.now();
  desk.goto('/cuedeck-checkin.html').catch(() => {});
  await desk.locator('.ck-ev', { hasText: 'Probe Summit' }).click();
  await expect(desk.locator('#station')).toBeVisible({ timeout: 30000 });
  expect(Date.now() - started).toBeLessThan(10000);
  await search(desk, 'Ben');
  await expect(desk.locator('.ck-res-row', { hasText: 'Ben Probe' })).toBeVisible();
});

// ── import guests on the desk, also with no internet ───────────────────────
const CSV = [
  'First name;Last name;Email;Company',
  'Nina;New;nina@cuedeck-test.io;Contoso Demo',
  'Ana;Again;ANA@cuedeck-test.io;Contoso Demo',      // Ana is on the list already
  ';Nameless;x@cuedeck-test.io;',
  'Nina;Twice;nina@cuedeck-test.io;',
  'Olaf;Other;;Fabrikam Demo',
].join('\n');
async function importCsv(page, csv = CSV) {
  await page.locator('#st-import').click();
  await page.locator('#im-file').setInputFiles({ name: 'guests.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
}

test('desk staff and desk leads see no import button', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-import')).toBeHidden();
});

test('an organizer imports a guest list with no internet, checks a guest in, and it all syncs when back online', async ({ page, context }) => {
  const imports: Record<string, unknown>[] = [];
  const scans: { attendee_id: string; action: string }[] = [];
  await open(page, { role: 'organizer' });
  await fn(page, 'checkin-import-attendees', (b) => { imports.push(b); return { body: { ok: true, dry_run: false,
    results: (b.rows as { client_id: string }[]).map(r => ({ client_id: r.client_id, action: 'create', attendee_id: r.client_id })) } }; });
  await fn(page, 'checkin-record-scans', (b) => { scans.push(...(b.items as typeof scans)); return { body: { ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }; });
  await context.setOffline(true);
  await importCsv(page);
  await expect(page.locator('#im-sum')).toContainText('2 new guests to add.');
  await expect(page.locator('#im-sum')).toContainText('1 already on the list, left as they are.');
  await expect(page.locator('#im-sum')).toContainText('1 listed twice in the file, added once.');
  await expect(page.locator('#im-sum')).toContainText('1 without a first or last name, skipped.');
  await page.locator('#im-save').click();
  await expect(page.locator('#import')).toBeHidden();
  await expect(page.locator('#verdict')).toContainText('2 guests added');
  await search(page, 'Nina');
  await page.locator('.ck-res-row', { hasText: 'Nina New' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict')).toContainText('Nina New is checked in');
  await expect(page.locator('#st-sync')).toHaveText('Offline · 3 waiting');
  expect(imports).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.locator('#st-sync')).toHaveText('All synced');
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({ event_id: EVENT_ID, dry_run: false, queued: true });
  const rows = imports[0].rows as { first_name: string; client_id: string; qr_token: string; email?: string; company?: string }[];
  expect(rows.map(r => r.first_name)).toEqual(['Nina', 'Olaf']);
  expect(rows[0]).toMatchObject({ email: 'nina@cuedeck-test.io', company: 'Contoso Demo' });
  expect(rows[0].client_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[0].qr_token).toMatch(/^[0-9a-f]{32}$/);
  // The check-in went up after the guest existed, under the desk's id.
  expect(scans).toEqual([expect.objectContaining({ attendee_id: rows[0].client_id, action: 'checkin' })]);
});

test('an imported guest who registered meanwhile: the check-in moves onto that registration', async ({ page, context }) => {
  const scans: { attendee_id: string }[] = [];
  await open(page, { role: 'organizer' });
  await fn(page, 'checkin-import-attendees', (b) => ({ body: { ok: true, dry_run: false,
    results: (b.rows as { client_id: string }[]).map(r => ({ client_id: r.client_id, action: 'update', attendee_id: BEN.id })) } }));
  await fn(page, 'checkin-record-scans', (b) => { scans.push(...(b.items as typeof scans)); return { body: { ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string }[]).map(i => [i.client_id, 'ok'])) } }; });
  await context.setOffline(true);
  await importCsv(page, 'First name,Last name,Email\nBenny,Late,benny@cuedeck-test.io');
  await page.locator('#im-save').click();
  await expect(page.locator('#verdict')).toContainText('1 guest added');
  await search(page, 'Benny');
  await page.locator('.ck-res-row', { hasText: 'Benny Late' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await context.setOffline(false);
  await expect(page.locator('#st-sync')).toHaveText('All synced');
  expect(scans).toEqual([expect.objectContaining({ attendee_id: BEN.id })]);
  await expect(page.locator('#verdict')).toContainText('already registered');
});

test('an imported guest the server skips is taken off the desk and named', async ({ page, context }) => {
  await open(page, { role: 'organizer' });
  await fn(page, 'checkin-import-attendees', (b) => ({ body: { ok: true, dry_run: false,
    results: (b.rows as { client_id: string }[]).map(r => ({ client_id: r.client_id, action: 'skip', reason: 'Could not be added' })) } }));
  await context.setOffline(true);
  await importCsv(page, 'First name,Last name\nPia,Probe');
  await page.locator('#im-save').click();
  await context.setOffline(false);
  await expect(page.locator('#verdict')).toContainText('An imported guest was not added');
  await expect(page.locator('#verdict')).toContainText('Pia Probe: Could not be added');
  await search(page, 'Pia');
  await expect(page.locator('.ck-res-row', { hasText: 'Pia Probe' })).toHaveCount(0);
  await expect(page.locator('#st-sync')).toHaveText('All synced');
});

test('a file without name columns says what it needs', async ({ page }) => {
  await open(page, { role: 'organizer' });
  await importCsv(page, 'Name,Mail\nNina New,nina@cuedeck-test.io');
  await expect(page.locator('#im-err')).toContainText('needs a First name and a Last name column');
  await expect(page.locator('#im-save')).toBeDisabled();
});

test('imported guests survive a reload with no internet', async ({ page, context }) => {
  await open(page, { role: 'organizer' });
  await untilWorkerControls(page);
  await context.setOffline(true);
  await importCsv(page, 'First name,Last name\nRita,Reload');
  await page.locator('#im-save').click();
  await expect(page.locator('#verdict')).toContainText('1 guest added');
  await page.close();
  const desk = await context.newPage();
  await desk.goto('/cuedeck-checkin.html');
  await desk.locator('.ck-ev', { hasText: 'Probe Summit' }).click();
  await expect(desk.locator('#station')).toBeVisible();
  await search(desk, 'Rita');
  await expect(desk.locator('.ck-res-row', { hasText: 'Rita Reload' })).toBeVisible();
  await expect(desk.locator('#st-sync')).toHaveText('Offline · 1 waiting');
  await context.setOffline(false);
});

test('a large imported list goes up in batches of 500', async ({ page, context }) => {
  const sizes: number[] = [];
  await open(page, { role: 'organizer' });
  await fn(page, 'checkin-import-attendees', (b) => { const rows = b.rows as { client_id: string }[]; sizes.push(rows.length); return { body: { ok: true, dry_run: false,
    results: rows.map(r => ({ client_id: r.client_id, action: 'create', attendee_id: r.client_id })) } }; });
  await context.setOffline(true);
  const csv = ['First name,Last name,Email', ...Array.from({ length: 1200 }, (_, i) => `Guest${i},Bulk,g${i}@cuedeck-test.io`)].join('\n');
  await importCsv(page, csv);
  await expect(page.locator('#im-save')).toHaveText('Add 1200 guests');
  await page.locator('#im-save').click();
  await expect(page.locator('#verdict')).toContainText('1200 guests added');
  await context.setOffline(false);
  await expect(page.locator('#st-sync')).toHaveText('All synced', { timeout: 15000 });
  expect(sizes).toEqual([500, 500, 200]);
});

// ── station address typed in, for a venue with no internet at all ─────────
const ST_ID = 'aaaaaaaa-0000-4000-8000-0000000000d1';
async function stationWithLan(page, lan: Record<string, unknown> | null, online = true) {
  const st = await withStation(page, () => ({ status: 'done', error: null }));
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: async () => {
    await st.setup();
    await rpc(page, 'checkin_print_stations', [{ id: ST_ID, label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online, printer_info: { model: 'brother-ql', ...(lan ? { lan } : {}) } }]);
  } });
}
function lanStation(context, host: string, calls: { path: string; token?: string }[]) {
  return context.route(new RegExp('^http://' + host.replace(/\./g, '\\.') + ':7842/'), r => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    calls.push({ path: new URL(r.request().url()).pathname, token: r.request().headers()['x-cuedeck-token'] });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
}

test('with no internet at the venue, a typed station address is tested and badges print to it', async ({ page, context }) => {
  // The desk last saw the station at the office address.
  await stationWithLan(page, { host: '192.168.1.107', port: 7842, token: 'c'.repeat(32) });
  const calls: { path: string; token?: string }[] = [];
  await lanStation(context, '192.168.1.3', calls);
  await context.setOffline(true);
  await page.locator('#ck-st-addr-sum').click();
  await page.locator('#ck-st-addr-in').fill('Venue network: 192.168.1.3:7842');
  await page.locator('#ck-st-addr-save').click();
  await expect(page.locator('#ck-st-addr-note')).toContainText('Found Desk printer.');
  await expect(page.locator('#ck-st-addr-sum')).toHaveText('Station address on this network: 192.168.1.3:7842 (typed in)');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Printed on Desk printer over the venue network.', { timeout: 10000 });
  expect(calls.map(c => c.path)).toEqual(['/ping', '/print']);
  expect(calls.every(c => c.token === 'c'.repeat(32))).toBe(true);
  await context.setOffline(false);
});

test('a typed address that is not on a private network is refused and never contacted', async ({ page, context }) => {
  await stationWithLan(page, { host: '192.168.1.107', port: 7842, token: 'c'.repeat(32) });
  let contacted = 0;
  await context.route(/8\.8\.8\.8/, r => { contacted++; return r.abort('failed'); });
  await page.locator('#ck-st-addr-sum').click();
  for (const bad of ['8.8.8.8:7842', '192.168.1.300', 'printer.local', '192.168.1.3:80']) {
    await page.locator('#ck-st-addr-in').fill(bad);
    await page.locator('#ck-st-addr-save').click();
    await expect(page.locator('#ck-st-addr-note')).toHaveText('Type an address on this network, like 192.168.1.3:7842.');
  }
  expect(contacted).toBe(0);
  expect(await page.evaluate((id) => localStorage.getItem('ck-station-addr:' + id), ST_ID)).toBeNull();
});

test('a station the desk never saw on a venue network asks for one online visit first', async ({ page }) => {
  await stationWithLan(page, null);
  await page.locator('#ck-st-addr-sum').click();
  await expect(page.locator('#ck-st-addr-help')).toContainText('Open this desk once with the internet working');
  await expect(page.locator('#ck-st-addr-form')).toBeHidden();
});

test('an address CueDeck reports for an online station replaces a typed one', async ({ page }) => {
  await page.addInitScript((id) => { localStorage.setItem('ck-station-addr:' + id, JSON.stringify({ host: '192.168.1.3', port: 7842 })); }, ST_ID);
  await stationWithLan(page, { host: '10.0.0.5', port: 7842, token: 'c'.repeat(32) }, true);
  await expect(page.locator('#ck-st-addr-sum')).toHaveText('Station address on this network');
  expect(await page.evaluate((id) => localStorage.getItem('ck-station-addr:' + id), ST_ID)).toBeNull();
});

test('the guest list under the search shows everyone, filters by arrival, and opens a guest', async ({ page }) => {
  const CAL = { ...BEN, id: 'a0000000-0000-4000-8000-000000000003', first_name: 'Cal', last_name: 'Adams', email: 'cal@cuedeck-test.io', qr_token: 'tok-cal' };
  // The server's copy follows the check-in, so the re-read after the flush agrees.
  const roster = [ANA, { ...BEN }, CAL];
  const scanResult = (i: { action: string; attendee_id?: string }) => {
    const row = roster.find(r => r.id === i.attendee_id);
    if (row) row.checked_in_at = FIXED_NOW.toISOString();
    return 'ok';
  };
  await open(page, { role: 'crew', roster, scanResult });
  const list = page.locator('#guests');
  await expect(list).toBeVisible();
  await expect(list.locator('.ck-res-name')).toHaveText(['Cal Adams', 'Ana Probe', 'Ben Probe']);
  await expect(list.locator('.ck-chip[data-f="all"]')).toHaveText('All 3');
  await list.locator('.ck-chip[data-f="in"]').click();
  await expect(list.locator('.ck-res-name')).toHaveText(['Ana Probe']);
  await expect(page.locator('#scan')).toBeFocused();
  await list.locator('.ck-chip[data-f="out"]').click();
  await expect(list.locator('.ck-res-name')).toHaveText(['Cal Adams', 'Ben Probe']);
  await search(page, 'Ben');
  await expect(list).toBeHidden();
  await expect(page.locator('.ck-res-row', { hasText: 'Ben Probe' })).toHaveCount(1);
  await search(page, '');
  await list.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await expect(page.locator('#verdict')).toContainText('Ben Probe is on the list');
  await page.locator('#secondary').click();
  await expect(list.locator('.ck-res-name')).toHaveText(['Cal Adams']);
  await expect(list.locator('.ck-chip[data-f="in"]')).toHaveText('Arrived 2');
});

test('the guest list shows at most 200 rows and points to search for the rest', async ({ page }) => {
  const roster = Array.from({ length: 205 }, (_, i) => ({ ...BEN, id: 'b0000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    first_name: 'G' + i, last_name: 'Guest', email: 'g' + i + '@cuedeck-test.io', qr_token: 'tok-g' + i }));
  await open(page, { role: 'crew', roster });
  await expect(page.locator('#guests .ck-res-row')).toHaveCount(200);
  await expect(page.locator('#guests .ck-res-note')).toHaveText('Showing 200 of 205. Search above to find anyone else.');
});

// Printing without checking in: badges printed ahead of the doors, and a
// second copy for someone already here. Neither may send a check-in.
async function openCountingPrints(page, roster: Record<string, unknown>[]) {
  const sent: string[] = [];
  await page.addInitScript(() => { (window as unknown as { __prints: string[] }).__prints = []; window.print = () => {
    (window as unknown as { __prints: string[] }).__prints.push(document.getElementById('badge-sheet')!.textContent || ''); }; });
  await open(page, { role: 'crew', roster, scanResult: (i) => { sent.push(i.action); return 'ok'; } });
  return sent;
}
const prints = (page) => page.evaluate(() => (window as unknown as { __prints: string[] }).__prints);

test('print badge only prints the ticked guest and leaves them not checked in', async ({ page }) => {
  const sent = await openCountingPrints(page, [ANA, BEN]);
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await expect(page.locator('#printonly')).toHaveText('Print 1 badge only');
  await page.locator('#printonly').click();
  await expect.poll(() => prints(page)).toHaveLength(1);
  expect((await prints(page))[0]).toContain('Ben');
  await expect(page.locator('#verdict')).toContainText('Badge for Ben Probe sent to print');
  await expect(page.locator('#verdict')).toContainText('not checked in');
  await expect(page.locator('#party .prow', { hasText: 'Ben Probe' }).locator('.pill-un')).toHaveText('not here yet');
  await expect(page.locator('#printonly')).toBeDisabled();
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
});

test('an arrived guest gets a second badge from their row, with no new check-in', async ({ page }) => {
  const sent = await openCountingPrints(page, [ANA, BEN]);
  await search(page, 'Ana');
  await page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-res-btn').click();
  const row = page.locator('#party .prow', { hasText: 'Ana Probe' });
  await row.locator('.ck-reprint').click();
  await expect.poll(() => prints(page)).toHaveLength(1);
  expect((await prints(page))[0]).toContain('Ana');
  await expect(page.locator('#verdict')).toContainText('Badge for Ana Probe sent to print');
  await expect(row.locator('.pill-in')).toContainText('arrived');
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
});

test('print badge only is off until someone is ticked', async ({ page }) => {
  await openCountingPrints(page, [ANA, BEN]);
  await search(page, 'Ana');
  await page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-res-btn').click();
  await expect(page.locator('#printonly')).toBeDisabled();
  await expect(page.locator('#printonly')).toHaveText('Print badge only');
});

// A second badge replaces the first (migration 151): new code on the badge,
// the old code blocked here and at the door.
test('a second badge gets a new code, and the old code is then named as an old badge', async ({ page }) => {
  const calls: unknown[] = [];
  const printed = { ...ANA, badge_printed_at: '2026-10-18T08:30:05.000Z' };
  await openCountingPrints(page, [printed, BEN]);
  await rpc(page, 'checkin_reissue_badge', (args) => { calls.push(args); return 'newtoken0000000000000000000000ab'; });
  await search(page, 'Ana');
  await page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-res-btn').click();
  await page.locator('#party .prow', { hasText: 'Ana Probe' }).locator('.ck-reprint').click();
  await expect.poll(() => prints(page)).toHaveLength(1);
  expect(calls).toEqual([{ p_attendee_id: ANA.id }]);
  await expect(page.locator('#verdict')).toContainText('The old badge and the QR in their email no longer work.');
  expect(await page.evaluate((id) => (window as unknown as { S: { roster: { id: string; qr_token: string }[] } }).S.roster.find(a => a.id === id)!.qr_token, ANA.id))
    .toBe('newtoken0000000000000000000000ab');
  await page.locator('#scan').fill('tok-ana');
  await page.locator('#scan').press('Enter');
  await expect(page.locator('#verdict')).toContainText('Old badge for Ana Probe');
  await expect(page.locator('#party .prow', { hasText: 'Ana Probe' })).toBeVisible();
});

test('a first badge never asks for a new code', async ({ page }) => {
  let called = 0;
  await openCountingPrints(page, [ANA, BEN]);
  await rpc(page, 'checkin_reissue_badge', () => { called++; return 'x'; });
  await search(page, 'Ana');
  await page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-res-btn').click();
  await page.locator('#party .prow', { hasText: 'Ana Probe' }).locator('.ck-reprint').click();
  await expect.poll(() => prints(page)).toHaveLength(1);
  expect(called).toBe(0);
  await expect(page.locator('#verdict')).not.toContainText('no longer work');
});

test('when CueDeck refuses a new code, the badge still prints and the desk says the old one still works', async ({ page }) => {
  await openCountingPrints(page, [{ ...ANA, badge_printed_at: '2026-10-18T08:30:05.000Z' }, BEN]);
  await rpc(page, 'checkin_reissue_badge', { code: '42501', message: 'Only desk staff can print a new badge' }, 403);
  await search(page, 'Ana');
  await page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-res-btn').click();
  await page.locator('#party .prow', { hasText: 'Ana Probe' }).locator('.ck-reprint').click();
  await expect.poll(() => prints(page)).toHaveLength(1);
  await expect(page.locator('#verdict')).toContainText('the old badge still works for Ana Probe');
});

test('an old code from another desk is named as an old badge, even offline', async ({ page, context }) => {
  await open(page, { role: 'crew', oldBadges: [{ qr_token: 'tok-ana-old', attendee_id: ANA.id }] });
  await expect.poll(() => page.evaluate(() => (window as unknown as { S: { oldBadges: Map<string, string> } }).S.oldBadges.size)).toBe(1);
  await context.setOffline(true);
  await page.locator('#scan').fill('tok-ana-old');
  await page.locator('#scan').press('Enter');
  await expect(page.locator('#verdict')).toContainText('Old badge for Ana Probe');
});

test('a code another desk just issued is found by reading the list again', async ({ page }) => {
  const roster = [ANA, { ...BEN }];
  await open(page, { role: 'crew', roster });
  roster[1].qr_token = 'tok-ben-new';
  await page.locator('#scan').fill('tok-ben-new');
  await page.locator('#scan').press('Enter');
  await expect(page.locator('#verdict')).toContainText('Ben Probe is on the list');
});

// ── a print station that stops (feature 6: laptop closed, app quit) ───────
const JOB = 'bbbbbbbb-0000-4000-8000-0000000000f1';
async function stationThatCanStop(page, state: { online: boolean; job: string; queued: unknown[]; cancelled: unknown[] }) {
  await page.addInitScript(() => { (window as unknown as { __prints: number }).__prints = 0; window.print = () => { (window as unknown as { __prints: number }).__prints++; }; });
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 }, before: async () => {
    await rpc(page, 'checkin_print_stations', () => [{ id: ST_ID, label: 'Desk printer', last_seen_at: FIXED_NOW.toISOString(), online: state.online, waiting: 0, printer_info: { model: 'brother-ql' } }]);
    await rpc(page, 'checkin_queue_print', (a) => { state.queued.push(a); return [JOB]; });
    await rpc(page, 'checkin_cancel_print', (a) => { state.cancelled.push(a); state.job = 'failed'; return 1; });
    await page.route(/\/rest\/v1\/leod_checkin_print_jobs(\?|$)/, r => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: JOB, status: state.job, error: state.job === 'failed' ? 'Cancelled at the desk: the print station did not pick it up' : null }]) }));
  } });
}

test('a station that is not answering: the desk says so across the top, sends nothing, and keeps the badge on a list', async ({ page }) => {
  const state = { online: false, job: 'done', queued: [] as unknown[], cancelled: [] as unknown[] };
  await stationThatCanStop(page, state);
  await expect(page.locator('#ck-station-down')).toContainText('Desk printer is not answering, so badges are not printing');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge not printed: Desk printer is not answering');
  expect(state.queued).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
  await expect(page.locator('#ck-unprinted-t')).toHaveText('1 badge not printed: Ben Probe');
  await expect(page.locator('#ck-unprinted-go')).toBeDisabled();
  await expect(page.locator('#ck-unprinted-go')).toHaveText('Waiting for Desk printer');
  // The station is back: the banner goes, and the list prints in one tap.
  state.online = true;
  await page.evaluate(() => (window as unknown as { loadPrintStations: () => Promise<void>; renderPrinterChip: () => void }).loadPrintStations().then(() => (window as unknown as { renderPrinterChip: () => void }).renderPrinterChip()));
  await expect(page.locator('#ck-station-down')).toHaveCount(0);
  await expect(page.locator('#ck-unprinted-go')).toHaveText('Print it');
  await page.locator('#ck-unprinted-go').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Printed on Desk printer.', { timeout: 10000 });
  expect(state.queued).toHaveLength(1);
  await expect(page.locator('#ck-unprinted')).toHaveCount(0);
});

test('a badge the station never picks up is taken back after about 15 seconds and listed', async ({ page }) => {
  test.setTimeout(60000);
  const state = { online: true, job: 'queued', queued: [] as unknown[], cancelled: [] as unknown[] };
  await stationThatCanStop(page, state);
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Sent to Desk printer');
  await expect(page.locator('#ck-print-msg')).toContainText('Desk printer did not pick it up, so it was taken back', { timeout: 30000 });
  expect(state.cancelled).toEqual([{ p_event_id: EVENT_ID, p_job_ids: [JOB] }]);
  await expect(page.locator('#ck-unprinted-t')).toHaveText('1 badge not printed: Ben Probe');
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

// ── iPad: the print dialog is a PDF the size of the label ────────────────
async function asIPad(page, firstShare: 'ok' | 'needs-tap' = 'ok') {
  await page.addInitScript((first) => {
    const w = window as unknown as { __prints: number; __shares: string[]; __shareCalls: number };
    w.__prints = 0; w.__shares = []; w.__shareCalls = 0;
    window.print = () => { w.__prints++; };
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' });
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
    (navigator as unknown as { canShare: (d: { files: File[] }) => boolean }).canShare = (d) => !!(d && d.files && d.files.length);
    (navigator as unknown as { share: (d: { files: File[] }) => Promise<void> }).share = async (d) => {
      w.__shareCalls++;
      if (first === 'needs-tap' && w.__shareCalls === 1) throw new DOMException('needs a tap', 'NotAllowedError');
      const f = d.files[0];
      const b = new Uint8Array(await f.arrayBuffer());
      w.__shares.push(f.type + '|' + f.name + '|' + new TextDecoder('latin1').decode(b.slice(0, 900)));
    };
  }, firstShare);
}

test('on an iPad, Print dialog hands the share sheet a PDF the size of the label, not a page', async ({ page }) => {
  await asIPad(page);
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await expect(page.locator('#ck-print-msg')).toContainText('Badges open the iPad print sheet at the label size (62 x 76 mm)');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge sent to the print sheet.', { timeout: 10000 });
  const shares = await page.evaluate(() => (window as unknown as { __shares: string[] }).__shares);
  expect(shares).toHaveLength(1);
  const [type, name, head] = shares[0].split('|');
  expect(type).toBe('application/pdf');
  expect(name).toBe('badge.pdf');
  expect(head.startsWith('%PDF-1.4')).toBe(true);
  expect(head).toContain('/MediaBox [0 0 175.75 215.43]');   // 62 x 76 mm, standing as it leaves the roll
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
});

test('on an iPad, when the tap has expired the desk asks for one, and Not now keeps the badge on the list', async ({ page }) => {
  await asIPad(page, 'needs-tap');
  await open(page, { role: 'crew', badgeDesign: { template: 'visa-next-full', w: 76, h: 62 } });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-pdf-sheet')).toContainText('Badge ready for Ben Probe');
  await page.locator('#ck-pdf-go').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Badge sent to the print sheet.');
  await expect(page.locator('#ck-pdf-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls)).toBe(2);
});

test('a badge the station started but never confirmed is listed when the desk stops waiting', async ({ page }) => {
  test.setTimeout(90000);
  const state = { online: true, job: 'printing', queued: [] as unknown[], cancelled: [] as unknown[] };
  await stationThatCanStop(page, state);
  // A station that picked the badge up and then went to sleep: never 'done'.
  await page.route(/\/rpc\/checkin_cancel_print/, r => { state.cancelled.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: 'application/json', body: '0' }); });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#primary').click();
  await expect(page.locator('#ck-print-msg')).toContainText('Desk printer did not confirm this badge. Listed below as not printed', { timeout: 60000 });
  await expect(page.locator('#ck-unprinted-t')).toHaveText('1 badge not printed: Ben Probe');
  expect(state.cancelled).toHaveLength(1);
});
