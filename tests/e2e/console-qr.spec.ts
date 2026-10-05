// tests/e2e/console-qr.spec.ts
// The display link carries the display's key, so the QR code must be drawn
// in the browser and never sent to a QR web service (api.qrserver.com was
// used until 2026-10-05). No auth needed: showQR is a page function.
import { test, expect } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';
const LINK = 'https://app.cuedeck.io/display#id=00000000-0000-4000-8000-000000000001&s=' + 'ab'.repeat(24);

test('the display QR is drawn locally and the link never leaves the page', async ({ page }) => {
  const leaked: string[] = [];
  page.on('request', r => { if (r.url().includes('ab'.repeat(24)) || /qrserver|chart\.googleapis/.test(r.url())) leaked.push(r.url()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate((u) => (window as any).showQR(u, 'Lobby TV'), LINK);
  const img = page.locator('#qr-img');
  await expect(img).toHaveAttribute('src', /^data:image\//);
  await expect(page.locator('#qr-display-name')).toHaveText('Lobby TV');
  expect(leaked).toEqual([]);
});

test('if the QR library cannot load, the modal closes and nothing is sent elsewhere', async ({ page }) => {
  const leaked: string[] = [];
  page.on('request', r => { if (/qrserver|chart\.googleapis/.test(r.url())) leaked.push(r.url()); });
  await page.route('**/qrcode-generator/**', r => r.abort());
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate((u) => (window as any).showQR(u, 'Lobby TV'), LINK);
  await expect(page.locator('#qr-modal')).toBeHidden();
  await expect(page.locator('#qr-img')).not.toHaveAttribute('src', /qrserver/);
  expect(leaked).toEqual([]);
});
