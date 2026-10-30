// tests/e2e/checkin-pair-printer.spec.ts
// /checkin/pair-printer: opened by the CueDeck Print Station app with the
// code it shows. Lists only events where the person may pair printers.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, fn, myEventsRow, FIXED_NOW } from './checkin-mock';

const E1 = 'aaaaaaaa-1111-4111-8111-111111111111', E2 = 'bbbbbbbb-2222-4222-8222-222222222222', E3 = 'cccccccc-3333-4333-8333-333333333333';

test('the app link fills the code; only events where you may pair are offered; pairing confirms', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [
    myEventsRow({ event_id: E1, name: 'Visa Next', date: '2026-11-03', is_owner: true, role: 'organizer' }),
    myEventsRow({ event_id: E2, name: 'Crew only', date: '2026-11-04', role: 'crew' }),
    myEventsRow({ event_id: E3, name: 'Led event', date: '2026-10-01', role: 'lead' }),
  ]);
  await fn(page, 'checkin-kiosk-pair', (b) => b.action === 'request_info'
    ? { body: { ok: true, same_network: true, requested_at: FIXED_NOW.toISOString(), printer: { model: 'brother-ql', name: 'Brother QL-820NWB', host: '192.168.1.130' } } }
    : (sent = b, { body: { ok: true, device_id: 'd1', label: b.label } }));
  await page.goto('/cuedeck-pair-printer.html?code=2ZCZPR4J&name=Brother%20QL-820NWB');
  await expect(page.locator('#pp-who')).toHaveText('Brother QL-820NWB at 192.168.1.130, asked just now');
  await expect(page.locator('#pp-warn')).toBeHidden();
  await expect(page.locator('#pp-code')).toHaveText('2ZCZ-PR4J');
  await expect(page.locator('#pp-event option')).toHaveText(['Led event · 2026-10-01', 'Visa Next · 2026-11-03']);
  await expect(page.locator('#pp-event')).toHaveValue(E1);   // the next upcoming event
  await expect(page.locator('#pp-name')).toHaveValue('Brother QL-820NWB');
  await page.fill('#pp-name', 'Desk printer');
  await page.click('#pp-go');
  await expect(page.locator('#pp-done')).toContainText('Paired. "Desk printer" prints badges for Visa Next');
  expect(sent).toEqual({ action: 'approve', event_id: E1, code: '2ZCZPR4J', label: 'Desk printer' });
});

test('a link without a code says where to pair instead', async ({ page }) => {
  await signedIn(page);
  await page.goto('/cuedeck-pair-printer.html');
  await expect(page.locator('#pp-err')).toContainText('This link has no pairing code');
  await expect(page.locator('#pp-form')).toBeHidden();
});

test('a code the server no longer has waiting is explained', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ event_id: E1, name: 'Visa Next', date: '2026-11-03', is_owner: true })]);
  await fn(page, 'checkin-kiosk-pair', () => ({ status: 404, body: { error: 'That code is not waiting to be paired. Check it on the print station.' } }));
  await page.goto('/cuedeck-pair-printer.html?code=2ZCZPR4J');
  await expect(page.locator('#pp-err')).toContainText('That code is not waiting to be paired');
  await expect(page.locator('#pp-form')).toBeHidden();
});

test('a link to a station on another network cannot pair in one click: the code must be typed off the station', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ event_id: E1, name: 'Visa Next', date: '2026-11-03', is_owner: true })]);
  await fn(page, 'checkin-kiosk-pair', (b) => b.action === 'request_info'
    ? { body: { ok: true, same_network: false, requested_at: new Date(FIXED_NOW.getTime() - 300000).toISOString(), printer: { model: 'zebra', name: 'Zebra' } } }
    : (sent.push(b), { body: { ok: true, device_id: 'd1', label: b.label } }));
  await page.goto('/cuedeck-pair-printer.html?code=2ZCZPR4J&name=Desk');
  await expect(page.locator('#pp-warn')).toContainText('requested from a different network');
  await expect(page.locator('#pp-warn')).toContainText('If someone sent you this link, do not pair it');
  await expect(page.locator('#pp-code')).toBeHidden();
  await expect(page.locator('#pp-who')).toHaveText('Zebra, asked 5 min ago');
  await page.click('#pp-go');
  await expect(page.locator('#pp-err')).toContainText('Type the 8-character code shown on the print station');
  expect(sent).toEqual([]);
  await page.fill('#pp-typed', 'wxyz-2345');
  await page.click('#pp-go');
  await expect(page.locator('#pp-done')).toContainText('Paired.');
  expect(sent).toEqual([{ action: 'approve', event_id: E1, code: 'WXYZ2345', label: 'Desk', code_typed: true }]);
});
