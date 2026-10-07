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
  event: { name: 'Northwind Summit 2026', date: '2026-10-18', venue: 'Harbour Hall', timezone: 'Europe/Warsaw', start: '09:00', end: '17:30',
           start_utc: '2026-10-18T07:00:00.000Z', end_utc: '2026-10-18T15:30:00.000Z' },
  questions: [
    { id: 'diet', label: 'Dietary needs', type: 'text', required: false, options: [] },
    { id: 'track', label: 'Track', type: 'choice', required: true, options: ['Tech', 'Business'] },
  ],
  places_left: 84,
  page: { host_name: 'Northwind Events', description: 'A day of talks.\nSecond line.', address: 'Main St 1, Gdańsk', brand_color: '#0F766E',
          cover_url: null, logo_url: null, programme: [{ time: '09:00', title: 'Doors open', room: 'Foyer', speaker: null }] },
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
    if (b.action === 'confirm') return opts.confirm ? opts.confirm(b) : { body: { status: 'registered', first_name: 'Maya',
      ticket: { first_name: 'Maya', last_name: 'Lindqvist', ticket_type: 'Delegate', code: 'B4K2C7', qr_svg: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>') } } };
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
  // Two options render as buttons, not a dropdown.
  await page.locator('[data-f="q:track"] .choice', { hasText: 'Tech' }).click();
  await page.check('[name=consent]');
}

test('renders the event and its questions, and registers', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_);
  await expect(page.locator('#ev-name')).toHaveText('Northwind Summit 2026');
  await expect(page.locator('#ev-meta')).toHaveText('Sunday 18 October 2026');
  await expect(page.locator('#ev-time')).toHaveText('09:00 to 17:30, Warsaw time');
  await expect(page.locator('#host-name')).toHaveText('Northwind Events');
  await expect(page.locator('#left')).toHaveText('84 places left');
  await expect(page.locator('#maps')).toHaveAttribute('href', /query=Harbour%20Hall%2C%20Main%20St%201/);
  await expect(page.locator('#plist .prow')).toHaveCount(1);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#0F766E');
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
  await expect(page.locator('#shut-h')).toHaveText('Registration is full');
  await expect(page.locator('#ev-name')).toBeVisible();   // the event stays on screen

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
  await expect(page.locator('#shut-h')).toHaveText('Registration is full');
  await expect(page.locator('#ev-name')).toBeVisible();   // the event stays on screen
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
  await expect(page.locator('#ticket')).toBeVisible();
  await expect(page.locator('#tk-h')).toHaveText('You are registered, Maya');
  await expect(page.locator('#tk-guest')).toHaveText('Maya Lindqvist');
  await expect(page.locator('#tk-code')).toHaveText('B4K2C7');
  expect(sent.filter(b => b.action === 'confirm')).toEqual([expect.objectContaining({ action: 'confirm', code: CODE, token: TOKEN })]);
  expect(page.url()).not.toContain('t=');
});

test('an expired or used link says so', async ({ page }) => {
  await setup(page, { confirm: () => ({ body: { status: 'invalid' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-btn');
  await expect(page.locator('#shut-h')).toHaveText('This link has expired or was already used');
});

test('a full event at confirm time says so', async ({ page }) => {
  await setup(page, { confirm: () => ({ body: { status: 'full' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-btn');
  await expect(page.locator('#shut-h')).toHaveText('Registration is full');
  await expect(page.locator('#ev-name')).toBeVisible();   // the event stays on screen
});

test('a link whose request was replaced or expired is caught at preview', async ({ page }) => {
  await setup(page, { preview: () => ({ body: { status: 'invalid' } }) });
  await page.goto(URL_ + '#t=' + TOKEN);
  await expect(page.locator('#shut-h')).toHaveText('This link has expired or was already used');
  expect(page.url()).not.toContain('t=');
});

test('"This is not me" deletes the request without confirming it', async ({ page }) => {
  const sent = await setup(page);
  await page.goto(URL_ + '#t=' + TOKEN);
  await page.click('#cf-no');
  await expect(page.locator('#shut-h')).toHaveText('Request deleted');
  expect(sent.filter(b => b.action === 'confirm')).toHaveLength(0);
  expect(sent.filter(b => b.action === 'decline')).toEqual([expect.objectContaining({ token: TOKEN })]);
  expect(page.url()).not.toContain('t=');
});

test('Add to calendar offers Google, Apple (.ics) and Outlook', async ({ page }) => {
  await setup(page);
  await page.goto(URL_);
  await page.click('#cal-btn');
  await expect(page.locator('#cal-google')).toHaveAttribute('href', /calendar\.google\.com.*dates=20261018T070000Z%2F20261018T153000Z/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cal-ics')]);
  expect(dl.suggestedFilename()).toBe('northwind-summit-2026.ics');
});

test('an event with no times, venue or description hides those parts', async ({ page }) => {
  await setup(page, { config: CONFIG({ event: { name: 'Bare Event', date: null, venue: null, timezone: null, start: null, end: null, start_utc: null, end_utc: null },
    page: { host_name: null, description: null, address: null, brand_color: null, cover_url: null, logo_url: null, programme: [] }, places_left: null }) });
  await page.goto(URL_);
  await expect(page.locator('#ev-name')).toHaveText('Bare Event');
  await expect(page.locator('#cal-btn')).toBeHidden();
  await expect(page.locator('#fact-venue')).toBeHidden();
  await expect(page.locator('#about')).toBeHidden();
  await expect(page.locator('#prog')).toBeHidden();
  await expect(page.locator('#left')).toBeHidden();
  await expect(page.locator('#mark')).toHaveText('BE');
});

// ── waitlist and approval (migration 108) ───────────────────────────
test('a full event with a waitlist offers the waitlist, and confirming says so with the position', async ({ page }) => {
  const sent = await setup(page, { config: CONFIG({ state: 'waitlist', places_left: 0 }),
    confirm: () => ({ body: { status: 'waitlisted', first_name: 'Maya', position: 3 } }) });
  await page.goto(URL_);
  await expect(page.locator('#open h2')).toHaveText('Join the waitlist');
  await expect(page.locator('#submit')).toHaveText('Join the waitlist');
  await expect(page.locator('#flow-note')).toContainText('This event is full');
  await expect(page.locator('#left')).toBeHidden();
  await fill(page);
  await page.click('#submit');
  await expect(page.locator('#done')).toBeVisible();
  await expect(page.locator('#done-h')).toHaveText('Check your email');
  expect(sent.some(b => b.action === 'register')).toBe(true);
  const p2 = await page.context().newPage();
  await setup(p2, { config: CONFIG({ state: 'waitlist' }), confirm: () => ({ body: { status: 'waitlisted', first_name: 'Maya', position: 3 } }) });
  await p2.goto(URL_ + '#t=' + TOKEN);
  await p2.click('#cf-btn');
  await expect(p2.locator('#done-h')).toHaveText('You are on the waitlist, Maya');
  await expect(p2.locator('#done-p')).toContainText('You are number 3 on the waitlist');
});

test('approval: the form says so, and confirming says the ticket follows approval', async ({ page }) => {
  await setup(page, { config: CONFIG({ approval: true }), confirm: () => ({ body: { status: 'awaiting_approval', first_name: 'Maya' } }) });
  await page.goto(URL_);
  await expect(page.locator('#flow-note')).toContainText('The organizer reviews each registration');
  const p2 = await page.context().newPage();
  await setup(p2, { config: CONFIG({ approval: true }), confirm: () => ({ body: { status: 'awaiting_approval', first_name: 'Maya' } }) });
  await p2.goto(URL_ + '#t=' + TOKEN);
  await p2.click('#cf-btn');
  await expect(p2.locator('#done-h')).toHaveText('Thanks, Maya');
  await expect(p2.locator('#done-p')).toContainText('once yours is approved');
});

test('test mode: a waitlisted test registration says so', async ({ page }) => {
  await setup(page, { config: CONFIG({ test: true, state: 'waitlist' }), register: () => ({ body: { status: 'ok', test: true, held: 'waitlist' } }) });
  await page.goto(URL_);
  await fill(page);
  await page.click('#submit');
  await expect(page.locator('#done-h')).toHaveText('Added to the waitlist (test)');
});
