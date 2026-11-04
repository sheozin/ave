// tests/e2e/checkin-client-report.spec.ts: the client report page at
// /cr/<token> (migration 158). The /cr/ rewrite is Vercel's; here the
// document request is served the same file.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';

const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
const TOKEN = '0123456789abcdef0123456789abcdef';
const HTML = readFileSync('cuedeck-checkin-client-report.html', 'utf8');
const R = {
  event: { name: 'Med Summit', date: '2026-11-03', venue: 'Hall A', timezone: 'Europe/Warsaw' },
  registered: 200, checked_in: 150, walk_ins: 3, first_arrival_at: '2026-11-03T07:31:00Z', last_arrival_at: '2026-11-03T12:02:00Z',
  peak: { t: Date.parse('2026-11-03T07:45:00Z') / 1000, n: 41 },
  by_ticket: [{ ticket_type: 'Delegate', registered: 180, checked_in: 132, no_shows: 48 }],
  host: 'AVE Events', brand_color: '#7A1F3D', logo_path: null, white_label: false,
};

async function open(page: Page, path: string, body: unknown, status = 200) {
  const calls: unknown[] = [];
  await page.route(/\/cr\/[^/]*$/, (r) => r.request().resourceType() === 'document'
    ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML }) : r.continue());
  await page.route(SB + '/rest/v1/rpc/checkin_client_report_view', (r) => {
    calls.push(r.request().postDataJSON());
    return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(path);
  return calls;
}

test('shows the numbers, by ticket type, and saves as PDF by printing', async ({ page }) => {
  const calls = await open(page, '/cr/' + TOKEN, R);
  await expect(page.locator('h1')).toHaveText('Med Summit');
  await expect(page.locator('.tile').first()).toContainText('150');
  await expect(page.locator('.tile').first()).toContainText('of 200 checked in (75%)');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Delegate');
  await expect(page.locator('footer')).toContainText('Shared by AVE Events');
  expect(calls).toEqual([{ p_token: TOKEN }]);
  await page.evaluate(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed++; }; });
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.bar')).toBeHidden();
});

test('not sent yet, expired or unknown: a clear message', async ({ page }) => {
  await open(page, '/cr/' + TOKEN, null);
  await expect(page.locator('.msg h1')).toHaveText('This report is not available');
});

test('a malformed link never asks the server', async ({ page }) => {
  const calls = await open(page, '/cr/nope', R);
  await expect(page.locator('.msg h1')).toHaveText('This report is not available');
  expect(calls).toEqual([]);
});

test('fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/cr/' + TOKEN, R);
  await expect(page.locator('h1')).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
