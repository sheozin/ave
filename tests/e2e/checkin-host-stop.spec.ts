// tests/e2e/checkin-host-stop.spec.ts: the stop link in host emails (migration 154).
import { test, expect } from '@playwright/test';

const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
const TOKEN = 'a'.repeat(48);

test('opening the link stops nothing; the button does', async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route(SB + '/rest/v1/rpc/checkin_host_stop', async (r) => {
    const a = r.request().postDataJSON(); calls.push(a);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ event: 'Spring Forum', stopped: !!a.p_confirm }) });
  });
  await page.goto('/cuedeck-checkin-host-stop.html?t=' + TOKEN);
  await expect(page.locator('#hs-title')).toHaveText('Stop arrival emails?');
  await expect(page.locator('#hs-text')).toHaveText('You get an email when your guests check in at Spring Forum. Stop them for this event?');
  expect(calls).toEqual([{ p_token: TOKEN, p_confirm: false }]);
  await page.locator('#hs-go').click();
  await expect(page.locator('#hs-title')).toHaveText('Emails stopped');
  await expect(page.locator('#hs-text')).toHaveText('You will not get more arrival emails for Spring Forum.');
  await expect(page.locator('#hs-go')).toBeHidden();
  expect(calls[1]).toEqual({ p_token: TOKEN, p_confirm: true });
});

test('an unknown link says it does not work', async ({ page }) => {
  await page.route(SB + '/rest/v1/rpc/checkin_host_stop', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  await page.goto('/cuedeck-checkin-host-stop.html?t=nope');
  await expect(page.locator('#hs-title')).toHaveText('This link does not work');
  await expect(page.locator('#hs-go')).toBeHidden();
});
