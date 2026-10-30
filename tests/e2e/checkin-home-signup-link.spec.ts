// cuedeck.io's check-in page links to /checkin#signup. Signed out, that must
// open on Create account (signup_source 'checkin'), never on Sign in.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://challenges.cloudflare.com/**', r => r.abort());
});

test('#signup opens on Create account', async ({ page }) => {
  await page.goto('/cuedeck-checkin-home.html#signup');
  await expect(page.locator('#f-up')).toBeVisible();
  await expect(page.locator('#f-in')).toBeHidden();
});

test('without the hash it opens on Sign in', async ({ page }) => {
  await page.goto('/cuedeck-checkin-home.html');
  await expect(page.locator('#f-in')).toBeVisible();
  await expect(page.locator('#f-up')).toBeHidden();
});

// A /checkin sign-up queues its welcome on first sign-in; invited staff do not.
import { signedIn, rpc, table, USER_ID } from './checkin-mock';
for (const [meta, expected] of [[{ signup_source: 'checkin' }, 1], [{ checkin_staff: 'true' }, 0]] as const) {
  test(`first sign-in with ${JSON.stringify(meta)} calls handle_first_login ${expected} time(s)`, async ({ page }) => {
    await signedIn(page, USER_ID, 'probe@cuedeck-test.io', meta);
    await table(page, 'leod_users', [{ role: 'director', name: 'Probe Person' }]);
    await rpc(page, 'checkin_account_is_comp', false);
    await rpc(page, 'checkin_my_events', []);
    const calls: unknown[] = [];
    await rpc(page, 'handle_first_login', (a) => { calls.push(a); return { first_login: true, welcome_email_queued: true }; });
    await page.goto('/cuedeck-checkin-home.html');
    await expect(page.locator('#hello')).toContainText('Signed in as');
    await page.waitForTimeout(300);
    expect(calls).toEqual(expected ? [{ p_user_id: USER_ID }] : []);
  });
}
