// tests/e2e/checkin-home-report.spec.ts
// /checkin: the Report button on ended events, and the ?next= return path
// the report email relies on (event-day spec, feature 6). Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, FIXED_NOW } from './checkin-mock';

const ENDED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
// FIXED_NOW is 2026-10-18; an event on 2026-10-10 closed its window on the 13th.
const ROWS = [
  myEventsRow({ event_id: ENDED, name: 'Ended event', role: 'organizer', date: '2026-10-10' }),
  myEventsRow({ event_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Ended viewer event', role: 'viewer', date: '2026-10-10' }),
  myEventsRow({ event_id: '99999999-9999-4999-8999-999999999999', name: 'Ended lead event', role: 'lead', date: '2026-10-10' }),
];

async function open(page, query = '') {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await table(page, 'leod_users', [{ role: 'director', name: 'Probe Person' }]);
  await rpc(page, 'checkin_account_is_comp', false);
  await rpc(page, 'checkin_my_events', ROWS);
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-home.html' + query);
}
const card = (page, name: string) => page.locator('.ev', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });

test('ended events offer the report to organizers and viewers, not leads', async ({ page }) => {
  await open(page);
  await expect(card(page, 'Ended event').locator('.acts a', { hasText: 'Report' })).toHaveAttribute('href', '/checkin/report?event=' + ENDED);
  await expect(card(page, 'Ended viewer event').locator('.acts a', { hasText: 'Report' })).toHaveCount(1);
  await expect(card(page, 'Ended lead event').locator('.acts a', { hasText: 'Report' })).toHaveCount(0);
});

test('a signed-in visit with a valid next goes straight to it', async ({ page }) => {
  await open(page, '?next=' + encodeURIComponent('/checkin/report?event=' + ENDED));
  await expect(page).toHaveURL('/checkin/report?event=' + ENDED);
});

test('next never leaves the check-in pages', async ({ page }) => {
  for (const bad of ['https://evil.example/', '//evil.example/x', '/checkin/report?event=' + ENDED + '&x=https://evil.example', '/api/cron/health-check']) {
    await open(page, '?next=' + encodeURIComponent(bad));
    await expect(page.locator('h3', { hasText: 'Ended event' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/cuedeck-checkin-home.html');
  }
});
