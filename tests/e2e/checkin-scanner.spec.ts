// tests/e2e/checkin-scanner.spec.ts
// The door scanner page (scanner Build A), Supabase functions mocked.
// The camera cannot run headless, so codes go through the type-a-code box,
// which takes the same path as a decoded QR.
import { test, expect } from '@playwright/test';
import { fn, EVENT_ID } from './checkin-mock';

const KEY = 'k'.repeat(64);
const TOK = 'tok0123456789abcdef0123456789abcd';
const OTHER = 'zzz0123456789abcdef0123456789abcd';
const URL_ = '/cuedeck-scanner.html';
const CONFIG = (over: Record<string, unknown> = {}) => ({
  event: { name: 'Probe Summit', date: '2026-10-18', timezone: 'Europe/Warsaw' }, status: 'live',
  scan_point: { name: 'Main door', kind: 'entrance' }, allowed: true, reason: null,
  server_now: new Date().toISOString(), ...over,
});

async function paired(page, opts: { config?: unknown; configStatus?: number; tokens?: string[] } = {}) {
  await page.addInitScript(([k, ev]) => {
    localStorage.setItem('cuedeck.scanner.v1', JSON.stringify({ device_key: k, event_id: ev, label: 'Door phone' }));
  }, [KEY, EVENT_ID]);
  await fn(page, 'checkin-scanner', (b) => b.action === 'config'
    ? { status: opts.configStatus ?? 200, body: opts.config ?? CONFIG() }
    : { body: { tokens: opts.tokens ?? [TOK], generated_at: new Date().toISOString() } });
}

test('an unpaired phone pairs with a code, then shows where it scans', async ({ page }) => {
  let claim: Record<string, unknown> = {};
  await fn(page, 'checkin-kiosk-pair', (b) => { claim = b; return { body: { ok: true, event_id: EVENT_ID, device_id: 'd1', label: 'Door phone', device_key: KEY, device_kind: 'scanner', scan_point: { name: 'Main door', kind: 'entrance' } } }; });
  await fn(page, 'checkin-scanner', (b) => b.action === 'config' ? { body: CONFIG() } : { body: { tokens: [TOK, OTHER] } });
  await page.goto(URL_);
  await expect(page.locator('#pair')).toBeVisible();
  await page.locator('#pair-code').fill('abcd-efgh');
  await page.locator('#pair-btn').click();
  await expect(page.locator('#scan')).toBeVisible();
  expect(claim).toEqual({ action: 'claim', code: 'ABCDEFGH', device_kind: 'scanner' });
  await expect(page.locator('#pt-name')).toHaveText('Main door');
  await expect(page.locator('#ev-name')).toHaveText('Probe Summit');
  await expect(page.locator('#net')).toContainText('2 codes on this phone');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cuedeck.scanner.v1') || '{}'));
  expect(stored).toEqual({ device_key: KEY, event_id: EVENT_ID, label: 'Door phone' });
});

test('a bad pairing code says so and pairs nothing', async ({ page }) => {
  await fn(page, 'checkin-kiosk-pair', () => ({ status: 400, body: { error: 'Invalid or expired pairing code' } }));
  await page.goto(URL_);
  await page.locator('#pair-code').fill('ABCD-EFGH');
  await page.locator('#pair-btn').click();
  await expect(page.locator('#pair-err')).toHaveText('Invalid or expired pairing code');
  expect(await page.evaluate(() => localStorage.getItem('cuedeck.scanner.v1'))).toBeNull();
});

test('a code on the list checks in and shows the name the server sent', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await paired(page);
  await fn(page, 'checkin-record-scans', (b) => {
    sent = b;
    const cid = (b.items as { client_id: string }[])[0].client_id;
    return { body: { ok: true, errors: [], results: { [cid]: 'ok' }, who: { [cid]: { first_name: 'Ewa', ticket_type: 'VIP' } } } };
  });
  await page.goto(URL_);
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#man-code').fill('  ' + TOK + '  ');
  await page.locator('#man-btn').click();
  await expect(page.locator('#v-title')).toHaveText('Checked in');
  await expect(page.locator('#v-text')).toHaveText('Ewa · VIP');
  expect(sent.device_key).toBe(KEY);
  const item = (sent.items as Record<string, unknown>[])[0];
  expect(item.qr_token).toBe(TOK);
  expect(item.action).toBe('checkin');
  expect(item).not.toHaveProperty('attendee_id');
  await expect(page.locator('#net')).not.toContainText('waiting');
});

test('a code not on the list is a red stop, still recorded', async ({ page }) => {
  let calls = 0;
  await paired(page);
  await fn(page, 'checkin-record-scans', (b) => { calls++; const cid = (b.items as { client_id: string }[])[0].client_id; return { body: { ok: true, errors: [], results: { [cid]: 'unknown_token' } } }; });
  await page.goto(URL_);
  await page.locator('#man-code').fill(OTHER);
  await page.locator('#man-btn').click();
  await expect(page.locator('#v-title')).toHaveText('Not on the list');
  await expect(page.locator('#verdict')).toHaveClass(/stop/);
  expect(calls).toBe(1);
});

test('scanning switched off: the reason shows and nothing is scanned', async ({ page }) => {
  let calls = 0;
  await paired(page, { config: CONFIG({ allowed: false, reason: 'Door scanning is switched off for this event. Ask the organizer to turn it on in Setup, or check people in at the desk.' }) });
  await fn(page, 'checkin-record-scans', () => { calls++; return { body: {} }; });
  await page.goto(URL_);
  await expect(page.locator('#blocked')).toHaveText(/^Door scanning is switched off/);
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#man-code').fill(TOK);
  await page.locator('#man-btn').click();
  expect(calls).toBe(0);
});

test('a revoked phone forgets its key and every code it held', async ({ page }) => {
  await paired(page, { configStatus: 401, config: { error: 'Unauthorized device' } });
  await page.addInitScript((t) => localStorage.setItem('cuedeck.scanner.tokens.v1', JSON.stringify({ event_id: 'x', tokens: [t] })), TOK);
  await page.goto(URL_);
  await expect(page.locator('#pair')).toBeVisible();
  await expect(page.locator('#pair-err')).toContainText('unpaired from the desk');
  const left = await page.evaluate(() => ['cuedeck.scanner.v1', 'cuedeck.scanner.tokens.v1', 'cuedeck.scanner.outbox.v1'].map(k => localStorage.getItem(k)));
  expect(left).toEqual([null, null, null]);
});

test('offline: a listed code is queued, then sent when the connection is back', async ({ page, context }) => {
  const sentItems: unknown[] = [];
  await paired(page);
  await fn(page, 'checkin-record-scans', (b) => {
    const items = b.items as { client_id: string }[];
    sentItems.push(...items);
    return { body: { ok: true, errors: [], results: Object.fromEntries(items.map(i => [i.client_id, 'ok'])) } };
  });
  await page.goto(URL_);
  await expect(page.locator('#net')).toContainText('1 codes on this phone');
  await context.setOffline(true);
  await page.locator('#man-code').fill(TOK);
  await page.locator('#man-btn').click();
  await expect(page.locator('#v-title')).toHaveText('On the list');
  await expect(page.locator('#net')).toContainText('1 waiting to send');
  expect(sentItems).toHaveLength(0);
  await context.setOffline(false);
  await expect.poll(() => sentItems.length, { timeout: 15000 }).toBe(1);
  await expect(page.locator('#net')).not.toContainText('waiting');
});
