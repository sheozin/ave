// tests/e2e/checkin-home-roles.spec.ts
// Event cards on /checkin for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, FIXED_NOW } from './checkin-mock';

const ROWS = [
  myEventsRow({ event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Viewer event', role: 'viewer' }),
  myEventsRow({ event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Lead event', role: 'lead' }),
  myEventsRow({ event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Owned event', role: 'organizer', is_owner: true, status: 'test', test_used: 3 }),
  myEventsRow({ event_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Viewer test event', role: 'viewer', status: 'test', attendees: 30, arrived: 2 }),
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await table(page, 'leod_users', [{ role: 'checkin_staff', name: 'Probe Person' }]);
  await rpc(page, 'checkin_account_is_comp', false);
  await rpc(page, 'checkin_my_events', ROWS);
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-home.html');
});

const card = (page, name: string) => page.locator('.ev', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });

test('a viewer card shows counts and one dashboard button', async ({ page }) => {
  const c = card(page, 'Viewer event');
  await expect(c.locator('.role-l')).toHaveText('Viewer');
  await expect(c.locator('.stats')).toContainText('45');
  await expect(c.locator('.acts a')).toHaveText(['View dashboard']);
  await expect(c.locator('.acts a')).toHaveAttribute('href', '/checkin/dashboard?event=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('a viewer card in test mode still shows counts, never a desk button', async ({ page }) => {
  const c = card(page, 'Viewer test event');
  await expect(c.locator('.stats')).toContainText('30');
  await expect(c.locator('.acts a')).toHaveText(['View dashboard']);
});

test('a desk lead card opens the desk, desk staff and the dashboard', async ({ page }) => {
  const c = card(page, 'Lead event');
  await expect(c.locator('.role-l')).toHaveText('Desk lead');
  await expect(c.locator('.acts a')).toHaveText(['Open desk', 'Desk staff', 'Dashboard']);
});

test('the owner card says Owner and keeps setup', async ({ page }) => {
  const c = card(page, 'Owned event');
  await expect(c.locator('.role-l')).toHaveText('Owner');
  await expect(c.locator('.acts a')).toHaveText(['Continue setup', 'Try the desk', 'Dashboard']);
});
