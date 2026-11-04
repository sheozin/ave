// tests/e2e/checkin-certificate.spec.ts: the certificate page at /c/<token>
// (migration 156). The /c/ rewrite is Vercel's; here the document request
// is served the same file.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';

const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
const TOKEN = '0123456789abcdef0123456789abcdef';
const HTML = readFileSync('cuedeck-checkin-certificate.html', 'utf8');
const CERT = {
  guest: 'Ola Nowak', company: 'Acme', event: 'Med Summit', venue: 'Hall A', date: '2026-11-03', timezone: 'Europe/Warsaw',
  checked_in_at: '2026-11-03T08:12:00Z', host: 'AVE Events', brand_color: '#7A1F3D', logo_path: null, white_label: false,
  code: '0123-4567', rooms: [{ name: 'Plenary', first_at: '2026-11-03T09:00:00Z' }],
};

async function open(page: Page, path: string, body: unknown, status = 200) {
  const calls: unknown[] = [];
  await page.route(/\/c\/[^/]*$/, (r) => r.request().resourceType() === 'document'
    ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML }) : r.continue());
  await page.route(SB + '/rest/v1/rpc/checkin_certificate', (r) => {
    calls.push(r.request().postDataJSON());
    return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(path);
  return calls;
}

test('shows the guest, the event and the check-in, and saves as PDF by printing', async ({ page }) => {
  const calls = await open(page, '/c/' + TOKEN, CERT);
  await expect(page.locator('.name')).toHaveText('Ola Nowak');
  await expect(page.locator('.what')).toHaveText('attended Med Summit at Hall A on 3 November 2026. Checked in at 09:12.');
  await expect(page.locator('.rooms')).toHaveText('Also attended: Plenary.');
  await expect(page.locator('.code')).toHaveText('Code 0123-4567');
  await expect(page.locator('.foot')).toContainText('AVE Events');
  expect(calls).toEqual([{ p_token: TOKEN }]);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  expect(accent).toBe('#7A1F3D');
  await page.evaluate(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed++; }; });
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  // Printed, the button bar goes and the certificate fills one A4 page.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.bar')).toBeHidden();
});

test('Arabic reads right to left', async ({ page }) => {
  await open(page, '/c/' + TOKEN + '?l=ar', CERT);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.kind')).toHaveText('شهادة حضور');
  await expect(page.getByRole('button', { name: 'حفظ بصيغة PDF' })).toBeVisible();
});

test('no certificate: a clear message, nothing invented', async ({ page }) => {
  await open(page, '/c/' + TOKEN, null);
  await expect(page.locator('.msg h1')).toHaveText('This certificate is not available');
  await expect(page.locator('.cert')).toHaveCount(0);
});

test('a malformed link never asks the server', async ({ page }) => {
  const calls = await open(page, '/c/not-a-token', CERT);
  await expect(page.locator('.msg h1')).toHaveText('This certificate is not available');
  expect(calls).toEqual([]);
});

test('a server error says to reload, not that there is no certificate', async ({ page }) => {
  await open(page, '/c/' + TOKEN, { message: 'boom' }, 500);
  await expect(page.locator('.msg h1')).toHaveText('Could not load the certificate');
});

test('fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/c/' + TOKEN, CERT);
  await expect(page.locator('.name')).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
