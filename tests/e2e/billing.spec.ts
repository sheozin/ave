// tests/e2e/billing.spec.ts
// E2E tests for CueDeck billing & subscription integration.
//
// Structural tests (no live DB): verify HTML elements, JS constants,
// edge function files, and migration exist.
//
// Run: npm run test:e2e

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'http://127.0.0.1:7230';
const ROOT = path.resolve(__dirname, '../..');

async function bypassOverlay(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.pointerEvents = 'none';
  });
}

// ── HTML STRUCTURE ──────────────────────────────────────────────────

test.describe('Billing: HTML structure', () => {

  test('01 trial-expired-screen exists in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#trial-expired-screen')).toBeAttached();
  });

  test('02 trial-expired-screen has plan cards', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const plans = page.locator('#te-plans .te-plan');
    await expect(plans).toHaveCount(3); // Per-Event, Starter, Pro
  });

  test('03 plan-badge exists in header', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#plan-badge')).toBeAttached();
  });

  test('04 billing button exists in header', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#billing-btn')).toBeAttached();
  });

  test('05 billing modal exists in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await expect(page.locator('#billing-modal')).toBeAttached();
  });

  test('06 billing modal has plan cards', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const plans = page.locator('#bm-plans .te-plan');
    await expect(plans).toHaveCount(3);
  });

  test('07 Stripe JS CDN is loaded', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const scripts = await page.locator('script[src*="js.stripe.com"]').count();
    expect(scripts).toBeGreaterThanOrEqual(1);
  });
});

// ── JAVASCRIPT CONSTANTS & FUNCTIONS ────────────────────────────────

test.describe('Billing: JS integration', () => {

  test('08 PLAN_LIMITS constant exists with all plans', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cuedeck-console.html'), 'utf8');
    expect(src).toContain('PLAN_LIMITS');
    expect(src).toContain("trial:");
    expect(src).toContain("perevent:");
    expect(src).toContain("starter:");
    expect(src).toContain("pro:");
    expect(src).toContain("enterprise:");
  });

  test('09 loadSubscription function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() => typeof (window as any).loadSubscription === 'function');
    expect(exists).toBe(true);
  });

  test('10 startCheckout function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() => typeof (window as any).startCheckout === 'function');
    expect(exists).toBe(true);
  });

  test('11 openCustomerPortal function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() => typeof (window as any).openCustomerPortal === 'function');
    expect(exists).toBe(true);
  });

  test('12 openBillingModal function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() => typeof (window as any).openBillingModal === 'function');
    expect(exists).toBe(true);
  });

  test('13 S state object has subscription fields', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cuedeck-console.html'), 'utf8');
    expect(src).toContain('subscription:');
    expect(src).toContain('planLimits:');
    expect(src).toContain('stripePrices:');
  });

  test('14 PLAN_LIMITS has correct feature gates', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cuedeck-console.html'), 'utf8');
    // Trial: full features, 1 event
    expect(src).toMatch(/trial:\s*\{[^}]*events:\s*1/);
    expect(src).toMatch(/trial:\s*\{[^}]*ai:\s*true/);
    // Starter: no AI
    expect(src).toMatch(/starter:\s*\{[^}]*ai:\s*false/);
    expect(src).toMatch(/starter:\s*\{[^}]*operators:\s*5/);
    // Pro: unlimited events + AI
    expect(src).toMatch(/pro:\s*\{[^}]*events:\s*999/);
    expect(src).toMatch(/pro:\s*\{[^}]*ai:\s*true/);
    expect(src).toMatch(/pro:\s*\{[^}]*operators:\s*20/);
  });
});

// ── EDGE FUNCTION FILES ─────────────────────────────────────────────

test.describe('Billing: Edge function files', () => {

  test('15 create-checkout-session/index.ts exists', () => {
    const p = path.join(ROOT, 'supabase/functions/create-checkout-session/index.ts');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('16 stripe-webhook/index.ts exists', () => {
    const p = path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('17 customer-portal/index.ts exists', () => {
    const p = path.join(ROOT, 'supabase/functions/customer-portal/index.ts');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('18 _shared/stripe.ts exists', () => {
    const p = path.join(ROOT, 'supabase/functions/_shared/stripe.ts');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('19 create-checkout-session imports stripe helper', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/functions/create-checkout-session/index.ts'), 'utf8');
    expect(src).toContain("from '../_shared/stripe.ts'");
    expect(src).toContain("from '../_shared/client.ts'");
    expect(src).toContain("from '../_shared/cors.ts'");
  });

  test('20 stripe-webhook uses signature verification', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
    expect(src).toContain('constructEventAsync');
    expect(src).toContain('STRIPE_WEBHOOK_SECRET');
  });

  test('21 stripe-webhook handles all required event types', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
    expect(src).toContain('checkout.session.completed');
    expect(src).toContain('customer.subscription.created');
    expect(src).toContain('customer.subscription.updated');
    expect(src).toContain('customer.subscription.deleted');
    expect(src).toContain('invoice.payment_failed');
    expect(src).toContain('invoice.payment_succeeded');
  });

  test('22 customer-portal imports stripe and cors', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/functions/customer-portal/index.ts'), 'utf8');
    expect(src).toContain("from '../_shared/stripe.ts'");
    expect(src).toContain('billingPortal');
  });
});

// ── MIGRATION FILE ──────────────────────────────────────────────────

test.describe('Billing: Migration', () => {

  test('23 011_subscriptions.sql exists', () => {
    const p = path.join(ROOT, 'supabase/migrations/011_subscriptions.sql');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('24 migration creates leod_subscriptions table', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/migrations/011_subscriptions.sql'), 'utf8');
    expect(src).toContain('CREATE TABLE IF NOT EXISTS leod_subscriptions');
    expect(src).toContain('director_id');
    expect(src).toContain('stripe_customer_id');
    expect(src).toContain('stripe_subscription_id');
    expect(src).toContain('trial_ends_at');
    expect(src).toContain('events_purchased');
    expect(src).toContain('events_used');
  });

  test('25 migration creates RPC get_subscription_for_user', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/migrations/011_subscriptions.sql'), 'utf8');
    expect(src).toContain('CREATE OR REPLACE FUNCTION get_subscription_for_user');
    expect(src).toContain('SECURITY DEFINER');
  });

  test('26 migration enables RLS', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'supabase/migrations/011_subscriptions.sql'), 'utf8');
    expect(src).toContain('ENABLE ROW LEVEL SECURITY');
    expect(src).toContain('directors_read_own_sub');
    expect(src).toContain('directors_insert_own_trial');
  });
});

// ── DEPLOY SCRIPT ───────────────────────────────────────────────────

test.describe('Billing: Deploy script', () => {

  test('27 deploy script includes new functions', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'scripts/deploy-functions.sh'), 'utf8');
    expect(src).toContain('create-checkout-session');
    expect(src).toContain('stripe-webhook');
    expect(src).toContain('customer-portal');
  });
});
