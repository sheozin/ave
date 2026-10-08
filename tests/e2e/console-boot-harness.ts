// tests/e2e/console-boot-harness.ts
// Signed-in console boot with no real backend: a stored supabase-js session
// in localStorage, every REST/RPC/Edge Function call answered by
// context.route, and a fake WebSocket that speaks enough Phoenix for realtime
// channels to report SUBSCRIBED. Demo data is fictional.
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';

export const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
export const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
export const USER_ID = '5d0c1e2a-7a41-4c1b-9d8e-0a1b2c3d4e5f';
export const EVENT_ID = 'e7a1c9b0-2f34-4d6e-8a1b-3c5d7e9f1a2b';
export const T0 = Date.parse('2026-10-06T11:40:00Z');
export const iso = (minsFromT0: number) => new Date(T0 + minsFromT0 * 60_000).toISOString();
export const ID = (k: number) => `0000000${k}-aaaa-4bbb-8ccc-00000000000${k}`;

const base = {
  event_id: EVENT_ID, version: 3, delay_minutes: 0, cumulative_delay: 0, is_anchor: false,
  actual_start: null as string | null, actual_end: null as string | null, notes: null as string | null,
  remote: false, streaming: false, recording: false, interpretation: false, languages: [] as string[], mics: 0,
  speaker_arrived: false, people: [] as unknown[], company: null as string | null, speaker: null as string | null,
};
export function sess(k: number, o: Record<string, unknown>) {
  return { ...base, id: ID(k), sort_order: k, type: 'Talk', ...o };
}
export function demoSessions() {
  return [
    sess(1, { title: 'Opening keynote', room: 'Main Stage', status: 'ENDED',
      planned_start: '09:30:00', planned_end: '10:15:00', scheduled_start: '09:30:00', scheduled_end: '10:15:00',
      actual_start: '2026-10-06T09:31:00Z', actual_end: '2026-10-06T10:17:00Z' }),
    sess(2, { title: 'Category planning workshop', room: 'Hall B', status: 'HOLD',
      planned_start: '11:00:00', planned_end: '11:45:00', scheduled_start: '11:00:00', scheduled_end: '11:45:00',
      actual_start: '2026-10-06T11:02:00Z' }),
    sess(3, { title: 'Airport retail panel', room: 'Main Stage', status: 'OVERRUN',
      planned_start: '11:00:00', planned_end: '11:30:00', scheduled_start: '11:00:00', scheduled_end: '11:30:00',
      actual_start: iso(-40) }),
    sess(4, { title: 'Arrivals store case study', room: 'Hall B', status: 'CALLING',
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:00:00', scheduled_end: '12:30:00' }),
    sess(5, { title: 'Duty free pricing', room: 'Main Stage', status: 'READY',
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:00:00', scheduled_end: '12:30:00' }),
    sess(6, { title: 'Click and collect at the gate', room: 'Main Stage', status: 'PLANNED',
      planned_start: '13:30:00', planned_end: '14:15:00', scheduled_start: '13:30:00', scheduled_end: '14:15:00' }),
    sess(7, { title: 'Supplier speed meetings', room: 'Hall B', status: 'CANCELLED',
      planned_start: '15:00:00', planned_end: '15:30:00', scheduled_start: '15:00:00', scheduled_end: '15:30:00' }),
  ];
}
export const EVENT = {
  id: EVENT_ID, name: 'GTR North Africa 2026', date: '2026-10-06', venue: 'Cairo', timezone: 'Africa/Cairo',
  active: true, created_via: 'console', event_start: '09:00:00', event_end: '17:00:00', created_at: '2026-09-01T08:00:00Z',
};
const LOG = [ // newest first, as the query orders it
  { action: 'BROADCAST', payload: { message: 'Hall B on hold: projector signal lost' }, ts: iso(-8) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(2), from_status: 'LIVE', to_status: 'HOLD', ts: iso(-9) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(3), from_status: 'CALLING', to_status: 'LIVE', ts: iso(-40) },
].map((r, i) => ({ id: 1000 - i, event_id: EVENT_ID, from_status: null, to_status: null, session_id: null, payload: null, ...r }));

export interface Scenario {
  role?: string;
  sessions?: unknown[];
  viewport?: { width: number; height: number };
  timezoneId?: string;
  extraEvents?: Record<string, unknown>[];              // more active events besides EVENT
  sessionsByEvent?: Record<string, unknown[]>;          // leod_sessions rows per event id
  sessionDelayMs?: Record<string, number>;              // slow leod_sessions answer per event id
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function openConsole(browser: Browser, sc: Scenario = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const role = sc.role ?? 'director';
  const sessions = sc.sessions ?? demoSessions();
  const ctx = await browser.newContext({
    viewport: sc.viewport ?? { width: 1440, height: 900 },
    timezoneId: sc.timezoneId ?? 'UTC', locale: 'en-GB',
  });
  await ctx.clock.install({ time: T0 });
  const realStart = Date.now();

  const exp = 1924992000;
  const email = 'operator@example.com';
  const token = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: USER_ID, role: 'authenticated', exp, email }) + '.c2ln';
  const session = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'demo-refresh',
    user: { id: USER_ID, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-06-01T00:00:00Z' } };
  await ctx.addInitScript(([k, v, uid, r]) => {
    try {
      localStorage.setItem(k, v);
      localStorage.setItem('cuedeck_last_role_' + uid, r);           // no welcome modal
      localStorage.setItem('cuedeck_ck_' + uid + '_dismissed', '1'); // checklist done
      localStorage.setItem('cuedeck_wiz_' + uid + '_done', '1');
      for (const x of ['director', 'stage', 'av', 'interp', 'reg', 'signage']) localStorage.setItem('cuedeck_tips_' + uid + '_' + x, '1');
    } catch { /* ignore */ }
    const Native = window.WebSocket;
    class FakeWS extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      url: string; readyState = 0; protocol = ''; extensions = ''; bufferedAmount = 0; binaryType = 'arraybuffer';
      onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
      constructor(url: string) {
        super(); this.url = url;
        setTimeout(() => { this.readyState = 1; const e = new Event('open'); this.onopen?.(e); this.dispatchEvent(e); }, 30);
      }
      _emit(data: string) { const e = new MessageEvent('message', { data }); this.onmessage?.(e); this.dispatchEvent(e); }
      send(raw: string) {
        if (typeof raw !== 'string') return;
        const arr = raw.startsWith('[');
        const m = arr ? (() => { const [join_ref, ref, topic, event, payload] = JSON.parse(raw); return { join_ref, ref, topic, event, payload }; })() : JSON.parse(raw);
        const out = (topic: string, event: string, payload: unknown, ref: string | null, join_ref: string | null) =>
          setTimeout(() => this._emit(arr ? JSON.stringify([join_ref, ref, topic, event, payload]) : JSON.stringify({ topic, event, payload, ref, join_ref })), 10);
        if (m.event === 'phx_join') {
          const pc = (m.payload?.config?.postgres_changes || []).map((b: any, i: number) => ({ ...b, id: 1000 + i }));
          out(m.topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } }, m.ref, m.join_ref ?? m.ref);
        } else {
          out(m.topic, 'phx_reply', { status: 'ok', response: {} }, m.ref, m.join_ref ?? null);
        }
      }
      close() { this.readyState = 3; const e = new CloseEvent('close', { code: 1000 }); this.onclose?.(e); this.dispatchEvent(e); }
    }
    (window as any).WebSocket = function (url: string, p?: any) {
      return String(url).includes('supabase.co') ? new FakeWS(url) : new Native(url, p);
    } as any;
    Object.assign((window as any).WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }, ['sb-sawekpguemzvuvvulfbc-auth-token', JSON.stringify(session), USER_ID, role]);

  const json = (r: Route, body: unknown, status = 200) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  await ctx.route(new RegExp('^' + escRe(SB) + '/'), async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    if (p.startsWith('/functions/v1/')) return json(r, { ok: true, status: 'OK', version: 10 });
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      if (fn === 'get_server_clock') return json(r, [{ server_time: new Date(T0 + (Date.now() - realStart)).toISOString(), tick: 48213 }]);
      if (fn === 'get_subscription_for_user') return json(r, [{ plan: 'pro', status: 'active', trial_ends_at: null, current_period_end: '2026-11-01T00:00:00Z' }]);
      if (fn === 'cuedeck_my_events') return json(r, [EVENT, ...(sc.extraEvents ?? [])].map((e: any) => ({
        event_id: e.id, role, is_owner: role === 'director', owner_id: role === 'director' ? USER_ID : '0e0e0e0e-0000-4000-8000-0000000000e1',
        organiser: 'Demo Events', plan: 'pro', plan_status: 'active', trial_ends_at: null })));
      return json(r, null);
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.split('/').pop()!;
      if (req.method() === 'HEAD') {
        return r.fulfill({ status: 200, headers: { 'content-range': '*/0', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
      }
      if (req.method() !== 'GET') return json(r, [], 201);
      const evId = (url.searchParams.get('event_id') || '').replace(/^eq\./, '');
      if (table === 'leod_sessions' && sc.sessionDelayMs?.[evId]) await new Promise(res => setTimeout(res, sc.sessionDelayMs![evId]));
      const rows: Record<string, unknown[]> = {
        leod_users: [{ id: USER_ID, name: 'Demo Operator', email, role, organization: 'Demo Events', phone: null, active: true, company_name: 'Demo Events', vat_id: null, billing_address: null }],
        leod_events: [EVENT, ...(sc.extraEvents ?? [])],
        leod_sessions: (sc.sessionsByEvent && evId in sc.sessionsByEvent) ? sc.sessionsByEvent[evId] : sessions,
        leod_event_log: LOG,
      };
      const data = rows[table] ?? [];
      if (one) return data.length ? json(r, data[0]) : json(r, { code: 'PGRST116', message: 'no rows' }, 406);
      return json(r, data);
    }
    return json(r, { message: 'unmocked' }, 404);
  });
  await ctx.route('https://ave-brain.vercel.app/**', r => json(r, { insights: [] }));

  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.style.display === 'none', null, { timeout: 30_000 });
  await page.waitForTimeout(1000); // realtime join and first ticks
  return { ctx, page, errors };
}
