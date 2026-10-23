// Session limits (2026-10-23): a sign-in that ends without the person asking
// lands on the sign-in form with the reason; their own Sign out does not.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

test('an expired sign-in lands on the sign-in form and says why', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', sessionOnce: true });
  try {
    // Supabase ending the session looks like this to the page: SIGNED_OUT
    // that did not come from the person's own Sign out.
    await evalPage(page, `sb.auth.signOut({ scope: 'local' }); 0`);
    await expect(page.locator('#lf-email')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#lf-error')).toContainText('For your security you were signed out');
    await expect(page.locator('#lf-error')).toContainText('12 hours without use, and 7 days after you signed in');
  } finally { await ctx.close(); }
});

test('the person\'s own Sign out shows no expiry message', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', sessionOnce: true });
  try {
    await evalPage(page, `doLogout(); 0`);
    await expect(page.locator('#lf-email')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#lf-error')).toHaveText('');
  } finally { await ctx.close(); }
});
