// tests/e2e/checkin-mock.ts
// Mocked Supabase for the check-in pages, so a page can be checked in a
// real browser without a database or an account. Every Supabase URL that
// a test does not mock answers 404 "unmocked", so a missing mock fails
// loudly instead of reaching production.
import type { Page, Route } from '@playwright/test';

export const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A stored supabase-js session that is valid until 2031, so a page clock
// fixed to any 2026 date never tries to refresh it.
export async function signedIn(page: Page, userId = USER_ID, email = 'probe@cuedeck-test.io') {
  const exp = 1924992000;
  const token = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: userId, role: 'authenticated', exp, email }) + '.c2ln';
  const session = {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'probe-refresh',
    user: { id: userId, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
  };
  await page.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, ['sb-sawekpguemzvuvvulfbc-auth-token', JSON.stringify(session)]);
  await page.route(new RegExp('^' + esc(SB) + '/'), (r: Route) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"unmocked"}' }));
}

// POST /rest/v1/rpc/<name>. `body` may be a function of the JSON arguments.
export async function rpc(page: Page, name: string, body: unknown | ((args: Record<string, unknown>) => unknown), status = 200) {
  await page.route(new RegExp('^' + esc(SB + '/rest/v1/rpc/' + name) + '(\\?|$)'), async (r: Route) => {
    let args: Record<string, unknown> = {};
    try { args = r.request().postDataJSON() ?? {}; } catch { /* no body */ }
    const out = typeof body === 'function' ? (body as (a: Record<string, unknown>) => unknown)(args) : body;
    await r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

// GET /rest/v1/<table>?... A .single()/.maybeSingle() read asks for one
// object (Accept: application/vnd.pgrst.object+json); anything else gets the array.
export async function table(page: Page, name: string, rows: unknown[]) {
  await page.route(new RegExp('^' + esc(SB + '/rest/v1/' + name) + '(\\?|$)'), async (r: Route) => {
    const one = /vnd\.pgrst\.object/.test(r.request().headers()['accept'] || '');
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(one ? (rows[0] ?? null) : rows) });
  });
}

// /functions/v1/<name>. The handler gets the parsed JSON body (or {} for GET).
export async function fn(page: Page, name: string, handler: (body: Record<string, unknown>) => { status?: number; body: unknown }) {
  await page.route(new RegExp('^' + esc(SB + '/functions/v1/' + name) + '(\\?|$)'), async (r: Route) => {
    if (r.request().method() === 'OPTIONS') { await r.fulfill({ status: 200, body: 'ok' }); return; }
    let body: Record<string, unknown> = {};
    try { body = r.request().postDataJSON() ?? {}; } catch { /* GET */ }
    const out = handler(body);
    await r.fulfill({ status: out.status ?? 200, contentType: 'application/json', body: JSON.stringify(out.body) });
  });
}

export function myEventsRow(over: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID, name: 'Probe Summit', date: '2026-10-18', venue: 'Hall A', timezone: 'Europe/Warsaw',
    event_start: '09:00:00', event_end: '18:00:00', created_via: 'checkin', is_owner: false, role: 'organizer',
    status: 'live', attendees: 120, arrived: 45, test_used: 0, is_comp: false, ...over,
  };
}

// 2026-10-18 11:00 in Warsaw: inside the check-in window of a 2026-10-18 event.
export const FIXED_NOW = new Date('2026-10-18T09:00:00Z');
