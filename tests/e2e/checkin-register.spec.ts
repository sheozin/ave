// tests/e2e/checkin-register.spec.ts
// The public registration page (/r/<code>), checkin-register mocked.
// Turnstile is replaced by a stub that hands back a token at once; the real
// widget is exercised live, not here.
import { test, expect, type Page } from '@playwright/test';
import { fn } from './checkin-mock';

const CODE = 'ABCDEFGH23';
const URL_ = '/cuedeck-register.html?code=' + CODE;
const CONFIG = (over: Record<string, unknown> = {}) => ({
  state: 'open', test: false, turnstile_site_key: 'site-key',
  event: { name: 'Northwind Summit 2026', date: '2026-10-18', venue: 'Harbour Hall', timezone: 'Europe/Warsaw' },
  questions: [
    { id: 'diet', label: 'Dietary needs', type: 'text', required: false, options: [] },
    { id: 'track', label: 'Track', type: 'choice', required: true, options: ['Tech', 'Business'] },
  ],
  ...over,
});

type Handler = (b: Record<string, unknown>) => { status?: number; body: unknown };
async function setup(page: Page, opts: { config?: unknown; configStatus?: number; register?: Handler; confirm?: Handler; preview?: Handler } = {}) {
  const sent: Record<string, unknown>[] = [];
  await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({
    contentType: 'application/javascript',
    // Like the real widget, a reset runs the check again and issues a new token.
    body: `window.turnstile = { render(el, o) { this.o = o; window.__tsAction = o.action; setTimeout(() => o.callback('ts-token'), 0); return 1; },
                                reset() { setTimeout(() => this.o.callback('ts-token'), 0); } };
           setTimeout(() => window.onTurnstileLoad && window.onTurnstileLoad(), 0);`,
  }));
  await fn(page, 'checkin-register', (b) => {
    if (b.action === 'config') return { status: opts.configStatus ?? 200, body: opts.config ?? CONFIG() };
    sent.push(b);
    if (b.action === 'decline') return { body: { status: 'declined' } };
    if (b.action === 'preview') return opts.preview ? opts.preview(b) : { body: { status: 'ok', first_name: 'Maya', last_name: 'Lindqvist', company: 'Contoso' } };
    if (b.action === 'confirm') return opts.confirm ? opts.confirm(b) : { body: { status: 'registered', first_name: 'Maya' } };
    return opts.register ? opts.register(b) : { body: { status: 'check_email' } };
  });
  page.on('dialog', d => { throw new Error('native dialog: ' + d.message()); });
  return sent;
}

async function fill(page: Page) {
  await page.fill('[name=first_name]', 'Maya');
  await page.fill('[name=last_name]', 'Lindqvist');
  await page.fill('[name=email]', 'maya@example.com');
  await page.fill('[name=company]', 'Contoso');
  await page.selectOption('[name="q:track"]', 'Tech');
  await page.check('[name=consent]');
}

test('renders the event and its questions, and registers', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_);
  await expect(page.locator('#ev-name')).toHaveText('Northwind Summit 2026');
  await expect(page.locator('#ev-meta')).toHaveText('Sunday 18 October 2026 · Harbour Hall');
  await expect(page.locator('#test-note')).toBeHidden();
  await expect(page.locator('[name="q:diet"]')).toBeVisible();
  await fill(page);
  await page.fill('[name="q:diet"]', 'Vegetarian');
  await page.click('#submit');
  await expect(page.locator('#done')).toBeVisible();   // #done-h holds this text while hidden too
  await expect(page.locator('#done-h')).toHaveText('Check your email');
  await expect(page.locator('#done-p')).toContainText('Nothing is registered until you confirm');
  expect(await page.evaluate(() => (window as unknown as { __tsAction: string }).__tsAction)).toBe('register');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    action: 'register', code: CODE, first_name: 'Maya', last_name: 'Lindqvist', email: 'maya@example.com',
    company: 'Contoso', consent: true, website: '', turnstile_token: 'ts-token',
    answers: { diet: 'Vegetarian', track: 'Tech' },
  });
});

test('checks the form before sending anything', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_);
  await page.fill('[name=first_name]', 'Maya');
  await page.fill('[name=email]', 'not-an-address');
  await page.click('#submit');
  await expect(page.locator('[data-f=last_name] .err')).toHaveText('Please enter your last name.');
  await expect(page.locator('[data-f=email] .err')).toHaveText('Please check your email address.');
  await expect(page.locator('[data-f="q:track"] .err')).toHaveText('Please answer this question.');
  await expect(page.locator('[data-f=consent]')).toHaveClass(/bad/);
  expect(sent).toHaveLength(0);
});

test('test mode says so, and the answer names no code (same for a new and a listed address)', async ({ page }) => {
  await setup(page, { config: CONFIG({ test: true }), register: () => ({ body: { status: 'ok', test: true } }) });
  await page.goto(URL_);
  await expect(page.locator('#test-note')).toBeVisible();
  await fill(page);
  await page.click('#submit');
  await expect(page.locator('#done-h')).toHaveText('Test registration recorded');
  await expect(page.locator('#done-p')).toContainText('Setup, under Attendees');
});

test('a token that is slow to arrive is waited for, not refused', async ({ page }) => {
  const sent = await setup(page);
  // Replace the stub: the token arrives 1.5 s after render.
  await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript',
    body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback('late-token'), 1500); return 1; }, reset() {} };
           setTimeout(() => window.onTurnstileLoad && window.onTurnstileLoad(), 0);` }));
  await page.goto(URL_);
  await fill(page);
  await page.click('#submit');
  await expect(page.locator('#done')).toBeVisible();   // #done-h holds this text while hidden too
  await expect(page.locator('#done-h')).toHaveText('Check your email');
  expect(sent[0].turnstile_token).toBe('late-token');
});

test('full, closed and unknown links say so', async ({ page }) => {
  await setup(page, { config: CONFIG({ state: 'full' }) });
  await page.goto(URL_);
  await expect(page.locator('#closed-h')).toHaveText('Registration is full');

  const p2 = await page.context().newPage();
  await setup(p2, { configStatus: 404, config: { error: 'not_found' } });
  await p2.goto(URL_);
  await expect(p2.locator('#closed-h')).toHaveText('This registration link is not active');

  const p3 = await page.context().newPage();
  await p3.goto('/cuedeck-register.html?code=bad');
  await expect(p3.locator('#closed-h')).toHaveText('This registration link is not active');
});

test('a server field error lands on the field; a full event at submit closes the form', async ({ page }) => {
  let n = 0;
  await setup(page, { register: () => (++n === 1
    ? { status: 400, body: { error: 'Invalid submission', fields: ['email_format'] } }
    : { body: { status: 'full' } }) });
  await page.goto(URL_);
  await fill(page);
  await page.click('#submit');
  await expect(page.locator('[data-f=email] .err')).toHaveText('Please check your email address.');
  await page.click('#submit');
  await expect(page.locator('#closed-h')).toHaveText('Registration is full');
});

test('inputs are 16px so iOS does not zoom, and the honeypot is off screen', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL_);
  await expect(page.locator('#ev-name')).toBeVisible();
  const sizes = await page.$$eval('input[type=text]:not([name=website]),input[type=email],select', els => els.map(e => parseFloat(getComputedStyle(e).fontSize)));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const hp = await page.locator('[name=website]').boundingBox();
  expect(hp!.x).toBeLessThan(-1000);
});


// ── the emailed link (double opt-in, migration 101) ──────────────────
const TOKEN = 'A'.repeat(40) + '_-z';

test('the emailed link asks for a button press, then registers and drops the token', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_ + '#t=' + TOKEN);
  await expect(page.locator('#confirm')).toBeVisible();
  await expect(page.locator('#cf-name')).toHaveText('Northwind Summit 2026');
  await expect(page.locator('#cf-who')).toHaveText('Maya Lindqvist, Contoso');
  expect(sent.filter(b => b.action === 'confirm')).toHaveLength(0);   // opening the link alone does nothing
  await page.click('#cf-btn');
  await expect(page.locator('#done-h')).toHaveText('You are registered, Maya');
  expect(sent.filter(b => b.action === 'confirm')).toEqual([expect.objectContaining({ action: 'confirm', code: CODE, token: TOKEN })]);
  expect(page.url()).not.toContain('t=');
});

test('an expired or used link says so', async ({ page }) => {
  await setup(page, { confirm: () => ({ body: { status: 'invalid' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-btn');
  await expect(page.locator('#closed-h')).toHaveText('This link has expired or was already used');
});

test('a full event at confirm time says so', async ({ page }) => {
  await setup(page, { confirm: () => ({ body: { status: 'full' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-btn');
  await expect(page.locator('#closed-h')).toHaveText('Registration is full');
});

test('a link whose request was replaced or expired is caught at preview', async ({ page }) => {
  await setup(page, { preview: () => ({ body: { status: 'invalid' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await expect(page.locator('#closed-h')).toHaveText('This link has expired or was already used');
  expect(page.url()).not.toContain('t=');
});

test('"This is not me" deletes the request without confirming it', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-no');
  await expect(page.locator('#closed-h')).toHaveText('Request deleted');
  expect(sent.filter(b => b.action === 'confirm')).toHaveLength(0);
  expect(sent.filter(b => b.action === 'decline')).toEqual([expect.objectContaining({ token: TOKEN })]);
  expect(page.url()).not.toContain('t=');
});
