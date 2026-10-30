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

// After Create account: the email up front, no tabs, no leftover security
// check; Use a different email brings both back.
test('the inbox screen names the email and hides the tabs and the check', async ({ page }) => {
  await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({
    contentType: 'application/javascript',
    body: `window.turnstile = { render(el, o) { this.o = o; setTimeout(() => o.callback('ts-token'), 0); return 1; },
                                reset() { setTimeout(() => this.o.callback('ts-token'), 0); } };`,
  }));
  const signups: Record<string, unknown>[] = [];
  await page.route('https://sawekpguemzvuvvulfbc.supabase.co/auth/v1/signup**', r => {
    signups.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'u1', email: 'new@example.com', user_metadata: {} }) });
  });
  await page.goto('/cuedeck-checkin-home.html#signup');
  await page.fill('#up-name', 'Ana Kowalska');
  await page.fill('#up-email', 'new@example.com');
  await page.fill('#up-pass', 'a long enough password');
  await page.click('#up-btn');
  await expect(page.locator('#up-done')).toBeVisible();
  await expect(page.locator('#up-done-email')).toHaveText('new@example.com');
  await expect(page.locator('.tabs')).toBeHidden();
  await expect(page.locator('#captcha')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Open Gmail' })).toBeVisible();
  expect((signups[0].data as Record<string, unknown>).signup_source).toBe('checkin');
  await page.click('#up-again');
  await expect(page.locator('.tabs')).toBeVisible();
  await expect(page.locator('#f-up')).toBeVisible();
});
