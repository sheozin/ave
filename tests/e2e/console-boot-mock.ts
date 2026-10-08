// tests/e2e/console-boot-mock.ts
// Signed-in boot of cuedeck-console.html for the redesign specs: a stored
// supabase-js session, every REST/RPC/Edge Function call answered by
// context.route, a fake realtime WebSocket that reports SUBSCRIBED, the
// supabase-js CDN served from node_modules, Inter served from tests/fixtures, Stripe blocked,
// and the page clock frozen at 11:40:45 event-local (Africa/Cairo).
// Fictional data (GTR North Africa demo), never real customers.
import { expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
export const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
export const USER_ID = '5d0c1e2a-7a41-4c1b-9d8e-0a1b2c3d4e5f';
export const EVENT_ID = 'e7a1c9b0-2f34-4d6e-8a1b-3c5d7e9f1a2b';
// 08:40 UTC = 11:40 in Cairo (UTC+3). Sessions are in event-local time.
export const T0 = Date.parse('2026-10-06T08:40:00Z');
// Before the 60 s clock resync timer fires, after any realistic boot.
export const FROZEN_AT = T0 + 45_000;
export const iso = (minsFromT0: number) => new Date(T0 + minsFromT0 * 60_000).toISOString();
export const ID = (k: number) => `${String(k).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(k).padStart(12, '0')}`;
export const PANEL_ID = ID(3);

const PEOPLE = [
  { name: 'Dina Farouk', company: 'Nilegate Retail Advisory', role: 'moderator' },
  { name: 'Karim Benali', company: 'Marrakai Airport Stores', role: 'panelist' },
  { name: 'Leila Mansour', company: 'Qantara Duty Free', role: 'panelist' },
  { name: 'Omar Haddad', company: 'Sahel Travel Retail', role: 'panelist' },
];
const base = {
  event_id: EVENT_ID, version: 3, delay_minutes: 0, cumulative_delay: 0, is_anchor: false,
  actual_start: null as string | null, actual_end: null as string | null, notes: null as string | null,
  state_changed_at: null as string | null,
  remote: false, streaming: false, recording: false, interpretation: false, languages: [] as string[], mics: 0,
  speaker_arrived: false, people: [] as unknown[], company: null as string | null, speaker: null as string | null,
};
type Sess = typeof base & Record<string, unknown>;
const sess = (k: number, o: Record<string, unknown>): Sess => ({ ...base, id: ID(k), sort_order: k, ...o });

export function demoSessions(): Sess[] {
  return [
    sess(1, { title: "Opening Keynote: North Africa's Travel Retail Outlook", type: 'Keynote', room: 'Main Stage',
      speaker: 'Youssef Amari', company: 'Meridian Gateway Holdings', status: 'ENDED', version: 7,
      planned_start: '09:30:00', planned_end: '10:15:00', scheduled_start: '09:30:00', scheduled_end: '10:15:00',
      actual_start: iso(-129), actual_end: iso(-83), state_changed_at: iso(-83), mics: 1, recording: true, streaming: true }),
    sess(2, { title: 'Workshop: Fragrance & Beauty Category Planning', type: 'Workshop', room: 'Hall B',
      speaker: 'Salma Khoury', company: 'Rivaline Beauty Group', status: 'HOLD', version: 5,
      planned_start: '11:00:00', planned_end: '11:45:00', scheduled_start: '11:00:00', scheduled_end: '11:45:00',
      actual_start: iso(-38), state_changed_at: iso(-9), mics: 2,
      notes: 'Projector input dropped at 11:31. AV on it, hold until signal is back.' }),
    sess(3, { title: 'Panel: Airport Retail in Cairo, Casablanca and Tunis', type: 'Panel', room: 'Main Stage',
      speaker: 'Dina Farouk (moderator), Karim Benali, Leila Mansour, Omar Haddad', people: PEOPLE,
      status: 'LIVE', version: 9, speaker_arrived: true,
      planned_start: '11:30:00', planned_end: '12:00:00', scheduled_start: '11:30:00', scheduled_end: '12:00:00',
      actual_start: iso(-10), state_changed_at: iso(-10), mics: 5, recording: true, streaming: true,
      interpretation: true, languages: ['EN', 'AR', 'FR'],
      notes: 'Moderator opens with audience poll. Two handheld mics for Q&A from 11:50.' }),
    sess(4, { title: 'Case Study: Rebuilding the Hurghada Arrivals Store', type: 'Talk', room: 'Hall B',
      speaker: 'Hany Wassef', company: 'Redsea Retail Partners', status: 'CALLING', version: 4,
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:00:00', scheduled_end: '12:30:00',
      state_changed_at: iso(-11), mics: 1 }),
    sess(5, { title: 'Duty Free Pricing After the Currency Float', type: 'Talk', room: 'Main Stage',
      speaker: 'Rania Saleh', company: 'Orbis Pricing Lab', status: 'READY', version: 4,
      delay_minutes: 5, cumulative_delay: 5,
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:05:00', scheduled_end: '12:35:00',
      state_changed_at: iso(-20), mics: 1, recording: true }),
    sess(6, { title: 'Digital Pre-Order and Click & Collect at the Gate', type: 'Talk', room: 'Main Stage',
      speaker: 'Tarek Nassar', company: 'Gateline Digital', status: 'PLANNED', version: 2, cumulative_delay: 5,
      planned_start: '13:30:00', planned_end: '14:15:00', scheduled_start: '13:35:00', scheduled_end: '14:20:00', mics: 1 }),
    sess(7, { title: 'Roundtable: Sustainable Packaging in Travel Retail', type: 'Workshop', room: 'Hall B',
      speaker: 'Mariam Gaber', company: 'Papyra Packaging', status: 'PLANNED', version: 1, is_anchor: true,
      planned_start: '14:00:00', planned_end: '14:45:00', scheduled_start: '14:00:00', scheduled_end: '14:45:00', mics: 4 }),
    sess(8, { title: 'Supplier Speed Meetings', type: 'Networking', room: 'Hall B',
      status: 'CANCELLED', version: 3, state_changed_at: iso(-55),
      planned_start: '15:00:00', planned_end: '15:30:00', scheduled_start: '15:00:00', scheduled_end: '15:30:00' }),
  ];
}
// Panel started 40 min ago with 30 min planned: +10:45 over at the frozen time.
export function overrunSessions(): Sess[] {
  return demoSessions().map(x => x.id === PANEL_ID
    ? { ...x, status: 'OVERRUN', planned_start: '11:00:00', planned_end: '11:30:00',
        scheduled_start: '11:00:00', scheduled_end: '11:30:00', actual_start: iso(-40) }
    : x);
}
export function noLiveSessions(): Sess[] {
  return demoSessions().map(x => (x.status === 'LIVE' || x.status === 'HOLD')
    ? { ...x, status: 'ENDED', actual_end: iso(-1), state_changed_at: iso(-1) } : x);
}
// Four rooms: Main Stage LIVE, Hall B HOLD, Hall C LIVE, Terrace idle with a next session.
export function fourRoomSessions(): Sess[] {
  return [
    ...demoSessions(),
    sess(9, { title: 'Masterclass: Luxury Watches at the Gate', type: 'Workshop', room: 'Hall C',
      speaker: 'Nadia Selmi', status: 'LIVE', version: 3, speaker_arrived: true,
      planned_start: '11:15:00', planned_end: '12:15:00', scheduled_start: '11:15:00', scheduled_end: '12:15:00',
      actual_start: iso(-25), state_changed_at: iso(-25), mics: 2 }),
    sess(10, { title: 'Sunset Networking Reception', type: 'Networking', room: 'Terrace',
      status: 'PLANNED', version: 1,
      planned_start: '17:00:00', planned_end: '18:30:00', scheduled_start: '17:00:00', scheduled_end: '18:30:00' }),
  ];
}
export function roomlessSessions(): Sess[] {
  return demoSessions().map(x => ({ ...x, room: null }));
}
export function longTitleSessions(): Sess[] {
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Panelist Number ${i + 1} With A Long Name`, company: 'Example Co', role: i ? 'panelist' : 'moderator' }));
  return demoSessions().map(x => x.id === PANEL_ID
    ? { ...x, title: 'Panel: ' + 'Airport retail across North Africa and the Gulf, from Casablanca to Muscat, '.repeat(2).slice(0, 132), people: nine,
        speaker: nine.map(p => p.name).join(', ') }
    : x);
}

// The demo plus six afternoon sessions, so the list is longer than the screen
// and "at least 8 rows visible" is a real limit, not the whole list.
export function manySessions(): Sess[] {
  const extra: [string, string, string, string][] = [
    ['Retail Media Networks at the Airport', 'Main Stage', '14:30:00', '15:00:00'],
    ['Panel: Arrivals Duty Free After Two Years', 'Hall B', '15:00:00', '15:45:00'],
    ['Loyalty Programmes for Transit Passengers', 'Main Stage', '15:15:00', '15:45:00'],
    ['Workshop: Planogram Basics for Gate Stores', 'Hall B', '16:00:00', '16:45:00'],
    ['Closing Remarks', 'Main Stage', '16:00:00', '16:15:00'],
    ['Networking Coffee', 'Hall B', '16:45:00', '17:00:00'],
  ];
  return [...demoSessions(), ...extra.map(([title, room, a, b], i) => sess(11 + i, { title, type: 'Talk', room, status: 'PLANNED', version: 1,
    planned_start: a, planned_end: b, scheduled_start: a, scheduled_end: b }))];
}

export const EVENT = {
  id: EVENT_ID, name: 'GTR North Africa 2026', date: '2026-10-06', venue: 'Cairo', timezone: 'Africa/Cairo',
  active: true, created_via: 'console', event_start: '09:00:00', event_end: '17:00:00', created_at: '2026-09-01T08:00:00Z',
};
const BROADCAST = { id: EVENT_ID, event_id: EVENT_ID, message: 'Hall B on hold: projector signal lost. Main Stage running on time.', priority: 'warn', sent_at: iso(-8) };
const LOG = [
  { action: 'BROADCAST', payload: { message: 'Hall B on hold: projector signal lost' }, ts: iso(-8) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(2), from_status: 'LIVE', to_status: 'HOLD', ts: iso(-9) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(3), from_status: 'CALLING', to_status: 'LIVE', ts: iso(-10) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(4), from_status: 'READY', to_status: 'CALLING', ts: iso(-11) },
  { action: 'DELAY_APPLIED', session_id: ID(5), payload: { minutes: 5 }, ts: iso(-14) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(5), from_status: 'PLANNED', to_status: 'READY', ts: iso(-20) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(2), from_status: 'CALLING', to_status: 'LIVE', ts: iso(-38) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(8), from_status: 'PLANNED', to_status: 'CANCELLED', ts: iso(-55) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(1), from_status: 'LIVE', to_status: 'ENDED', ts: iso(-83) },
].map((r, i) => ({ id: 1000 - i, event_id: EVENT_ID, from_status: null, to_status: null, session_id: null, payload: null, ...r }));
const DISPLAYS = [
  { id: 'd1000000-0000-4000-8000-000000000001', event_id: EVENT_ID, name: 'Main Foyer Schedule', zone_type: 'lobby', orientation: 'landscape',
    content_mode: 'schedule', filter_room: null, last_seen_at: iso(0), override_content: null, sequence: null },
  { id: 'd1000000-0000-4000-8000-000000000002', event_id: EVENT_ID, name: 'Hall B Door', zone_type: 'prefunction', orientation: 'portrait',
    content_mode: 'schedule', filter_room: 'Hall B', last_seen_at: iso(0), override_content: null, sequence: null },
];
const SPONSORS = [{ id: 's1', event_id: EVENT_ID, name: 'Qantara Duty Free', logo_url: null, sort_order: 1 }];
const NAMES: Record<string, string> = { director: 'Nour Selim', stage: 'Ahmed Fawzy', av: 'Mona Adel', interp: 'Sami Rashed', reg: 'Hoda Zaki', signage: 'Bassem Lotfy' };
const OPERATORS = Object.entries(NAMES).map(([role, name], i) => ({
  id: i ? `op-${i}` : USER_ID, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, role,
  organization: 'Nilegate Events', active: true, last_sign_in_at: iso(-i),
}));
// Event teams (spec 2026-10-08): what cuedeck_my_events answers. Default:
// the demo event, with the scenario's role on it, owned when that role is
// director, organiser Nilegate Events on Pro.
export const OTHER_OWNER = '0e0e0e0e-0000-4000-8000-0000000000e1';
export interface MyEvent {
  id: string; name: string; role: string; isOwner: boolean;
  ownerId?: string; organiser?: string | null; plan?: string | null; planStatus?: string | null; trialEndsAt?: string | null;
}
export const PRO_SUB = { plan: 'pro', status: 'active', trial_ends_at: null, current_period_end: '2026-11-01T00:00:00Z' };
export interface Call { method: string; path: string; body: any }
export const defaultTeam = () => ({
  is_owner: true, seats: { used: 2, limit: 20 },
  owner: { user_id: USER_ID, name: 'Nour Selim', email: 'nour@example.com', last_sign_in_at: iso(0) },
  members: [
    { user_id: 'op-1', name: 'Ahmed Fawzy', email: 'ahmed@example.com', role: 'stage', active: true,  last_sign_in_at: iso(-5), added_at: '2026-09-02T09:00:00Z' },
    { user_id: 'op-2', name: 'Mona Adel',   email: 'mona@example.com',  role: 'av',    active: false, last_sign_in_at: null,     added_at: '2026-09-03T09:00:00Z' },
  ],
});

export interface Scenario {
  role?: string;
  sessions?: unknown[];
  broadcast?: unknown | null;
  viewport?: { width: number; height: number };
  timezoneId?: string;
  locale?: 'en' | 'ar' | 'pl' | 'de';
  reducedMotion?: 'reduce' | 'no-preference';
  touch?: boolean;
  stageMessages?: unknown[];   // leod_stage_messages rows the boot read returns
  accountRole?: string;          // leod_users.role, the account's kind; default: role
  myEvents?: MyEvent[];          // cuedeck_my_events; read on every request, so a test may change it
  ownSub?: Record<string, unknown> | null;   // get_subscription_for_user row; null = none
  fnReply?: (fn: string, body: any) => { status: number; body: unknown } | undefined;   // Edge Function answers
  team?: Record<string, unknown>;   // cuedeck_event_team answer per event id (default: defaultTeam)
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SUPABASE_UMD = path.resolve(__dirname, '../../node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const FONTS = path.resolve(__dirname, '../fixtures/fonts');
// Supabase requests the page has sent and not yet had answered (see afterBootReread).
const sbInFlight = new WeakMap<Page, number>();

export async function openConsole(browser: Browser, sc: Scenario = {}): Promise<{ ctx: BrowserContext; page: Page; calls: Call[] }> {
  const role = sc.role ?? 'director';
  const sessions = sc.sessions ?? demoSessions();
  const broadcast = sc.broadcast === undefined ? BROADCAST : sc.broadcast;
  const myEvents = (): MyEvent[] => sc.myEvents ?? [{ id: EVENT_ID, name: EVENT.name, role, isOwner: role === 'director' }];
  const calls: Call[] = [];
  const ctx = await browser.newContext({
    viewport: sc.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: Number(process.env.CONSOLE_DSF ?? 1),
    timezoneId: sc.timezoneId ?? 'UTC', locale: 'en-GB',
    reducedMotion: sc.reducedMotion ?? 'no-preference',
    hasTouch: !!sc.touch, isMobile: !!sc.touch,
  });
  await ctx.clock.install({ time: T0 });

  const exp = 1924992000;
  const email = `${NAMES[role].split(' ')[0].toLowerCase()}@example.com`;
  const token = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: USER_ID, role: 'authenticated', exp, email }) + '.c2ln';
  const session = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'demo-refresh',
    user: { id: USER_ID, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-06-01T00:00:00Z' } };
  await ctx.addInitScript(([k, v, uid, r, loc]) => {
    try {
      localStorage.setItem(k, v);
      localStorage.setItem('cuedeck_last_role_' + uid, r);
      localStorage.setItem('cuedeck_ck_' + uid + '_dismissed', '1');
      localStorage.setItem('cuedeck_wiz_' + uid + '_done', '1');
      for (const x of ['director', 'stage', 'av', 'interp', 'reg', 'signage']) localStorage.setItem('cuedeck_tips_' + uid + '_' + x, '1');
      if (loc && loc !== 'en') localStorage.setItem('cuedeck_locale', loc);
    } catch { /* storage blocked */ }
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
        ((window as any).__rtSent ||= []).push(m);
        const out = (topic: string, event: string, payload: unknown, ref: string | null, join_ref: string | null) =>
          setTimeout(() => this._emit(arr ? JSON.stringify([join_ref, ref, topic, event, payload]) : JSON.stringify({ topic, event, payload, ref, join_ref })), 10);
        if (m.event === 'phx_join') {
          const pc = (m.payload?.config?.postgres_changes || []).map((b: any, i: number) => ({ ...b, id: 1000 + i }));
          out(m.topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } }, m.ref, m.join_ref ?? m.ref);
          const w = window as any;
          (w.__rtJoins ||= new Map()).set(m.topic, { ws: this, pc, arr });
          const meta = (rl: string, key: string, name: string) => ({ [key]: { metas: [{ phx_ref: key, role: rl, userId: key, name }] } });
          out(m.topic, 'presence_state', { ...meta('director', 'p1', 'Nour Selim'), ...meta('stage', 'p2', 'Ahmed Fawzy'), ...meta('av', 'p3', 'Mona Adel'), ...meta('signage', 'p4', 'Bassem Lotfy') }, null, m.join_ref ?? m.ref);
        } else {
          out(m.topic, 'phx_reply', { status: 'ok', response: {} }, m.ref, m.join_ref ?? null);
        }
      }
      close() { this.readyState = 3; const e = new CloseEvent('close', { code: 1000 }); this.onclose?.(e); this.dispatchEvent(e); }
    }
    // Deliver a postgres change the way Supabase Realtime does: a binding with a
    // filter gets INSERT/UPDATE only when the row matches it and never gets
    // DELETE ("Delete events are not filterable"); DELETE carries old_record = { id }
    // (replica identity default).
    (window as any).__rtPush = (table: string, type: 'INSERT' | 'UPDATE' | 'DELETE', record: any, oldRecord: any) => {
      let sent = 0;
      for (const [topic, j] of ((window as any).__rtJoins || new Map()) as Map<string, any>) {
        const ids = j.pc.filter((b: any) => {
          if (b.schema !== 'public' || b.table !== table) return false;
          if (b.event !== '*' && String(b.event).toUpperCase() !== type) return false;
          if (!b.filter) return true;
          if (type === 'DELETE') return false;
          const [col, val] = String(b.filter).split('=eq.');
          return String(record?.[col]) === val;
        }).map((b: any) => b.id);
        if (!ids.length) continue;
        const cols = Object.keys({ ...(record || {}), ...(oldRecord || {}) }).map(name => ({ name, type: 'text' }));
        const payload = { ids, data: { schema: 'public', table, commit_timestamp: new Date().toISOString(), type, columns: cols,
          record: type === 'DELETE' ? {} : record, old_record: type === 'INSERT' ? {} : oldRecord, errors: null } };
        j.ws._emit(j.arr ? JSON.stringify([null, null, topic, 'postgres_changes', payload]) : JSON.stringify({ topic, event: 'postgres_changes', payload, ref: null }));
        sent++;
      }
      return sent;
    };
    (window as any).WebSocket = function (url: string, p?: any) {
      return String(url).includes('supabase.co') ? new FakeWS(url) : new Native(url, p);
    } as any;
    Object.assign((window as any).WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }, ['sb-sawekpguemzvuvvulfbc-auth-token', JSON.stringify(session), USER_ID, role, sc.locale ?? 'en']);

  // External CDNs: deterministic and offline.
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SUPABASE_UMD, 'utf8') }));
  await ctx.route(/^https:\/\/js\.stripe\.com\//, r => r.abort());
  // Inter as operators get it: Google's CSS for the console's @import and its
  // latin + latin-ext files, byte for byte (tests/fixtures/fonts, SIL OFL).
  // Without it, layout specs measured the system fallback (SF on a Mac,
  // DejaVu on CI Linux) and passed or failed by machine.
  await ctx.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => {
    const url = r.request().url();
    if (url.startsWith('https://fonts.googleapis.com/css2?family=Inter:'))
      return r.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(FONTS, 'inter.css'), 'utf8') });
    const m = url.match(/^https:\/\/fonts\.gstatic\.com\/s\/inter\/v20\/([\w-]+\.woff2)$/);
    const file = m && path.join(FONTS, m[1]);
    if (!file || !fs.existsSync(file)) return r.abort();   // other subsets (cyrillic, greek, vietnamese) are not used
    return r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) });
  });
  await ctx.route('https://ave-brain.vercel.app/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"insights":[]}' }));

  const json = (r: Route, body: unknown, status = 200) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  const unmocked: string[] = [];
  await ctx.route(new RegExp('^' + SB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    if (p.startsWith('/functions/v1/')) {
      let body: any = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
      calls.push({ method: req.method(), path: p, body });
      const custom = sc.fnReply?.(p.split('/').pop()!, body);
      if (custom) return json(r, custom.body, custom.status);
      return json(r, { ok: true, status: 'OK', version: 10 });
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      if (fn === 'get_server_clock') return json(r, [{ server_time: new Date(T0).toISOString(), tick: 48213 }]);
      if (fn === 'get_subscription_for_user') return json(r, sc.ownSub === null ? [] : [sc.ownSub ?? PRO_SUB]);
      if (fn === 'cuedeck_event_team') {
        const ev = (() => { try { return JSON.parse(req.postData() || '{}').p_event_id; } catch { return null; } })();
        return json(r, (sc.team as Record<string, unknown> | undefined)?.[ev] ?? defaultTeam());
      }
      if (fn === 'cuedeck_my_events') return json(r, myEvents().map(m => ({
        event_id: m.id, role: m.role, is_owner: m.isOwner, owner_id: m.isOwner ? USER_ID : (m.ownerId ?? OTHER_OWNER),
        organiser: m.organiser === undefined ? 'Nilegate Events' : m.organiser,
        plan: m.plan === undefined ? 'pro' : m.plan, plan_status: m.planStatus === undefined ? 'active' : m.planStatus,
        trial_ends_at: m.trialEndsAt ?? null })));
      if (fn === 'get_operators_with_last_seen') return json(r, OPERATORS);
      return json(r, null);
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.split('/').pop()!;
      if (req.method() === 'HEAD') {
        const cnt = table === 'leod_users' ? (url.search.includes('role=eq.pending') ? 0 : 6) : 0;
        return r.fulfill({ status: 200, headers: { 'content-range': `*/${cnt}`, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
      }
      if (req.method() !== 'GET') {
        let body: any = null;
        try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
        calls.push({ method: req.method(), path: p + url.search, body });
        if (req.method() === 'PATCH') return json(r, [{ id: (url.searchParams.get('id') || '').replace(/^eq\./, '') }]);
        return json(r, [], 201);
      }
      const rows: Record<string, unknown[]> = {
        leod_users: [{ id: USER_ID, name: NAMES[role], email, role: sc.accountRole ?? role, organization: 'Nilegate Events', phone: null, active: true, company_name: 'Nilegate Events', vat_id: null, billing_address: null }],
        leod_config: [], leod_events: myEvents().map(m => ({ ...EVENT, id: m.id, name: m.name })), leod_sessions: sessions, leod_broadcast: broadcast ? [broadcast] : [],
        leod_event_log: LOG, leod_signage_displays: DISPLAYS, leod_signage_sponsors: SPONSORS,
        leod_stage_messages: sc.stageMessages ?? [],
      };
      if (!(table in rows)) unmocked.push(table);
      const data = rows[table] ?? [];
      if (one) return data.length ? json(r, data[0]) : json(r, { code: 'PGRST116', message: 'no rows' }, 406);
      return json(r, data);
    }
    unmocked.push(p);
    return json(r, { message: 'unmocked' }, 404);
  });

  const page = await ctx.newPage();
  sbInFlight.set(page, 0);
  const isSb = (r: { url(): string }) => r.url().startsWith(SB + '/');
  page.on('request', r => { if (isSb(r)) sbInFlight.set(page, sbInFlight.get(page)! + 1); });
  const done = (r: { url(): string }) => { if (isSb(r)) sbInFlight.set(page, sbInFlight.get(page)! - 1); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.style.display === 'none', null, { timeout: 30_000 });
  await page.waitForFunction(() => (document.getElementById('conn-lbl')?.textContent || '').length > 0);
  await page.waitForTimeout(1500);
  // Every layout number assumes Inter; fail loudly rather than measure a fallback.
  const inter = await page.evaluate(async () => { await document.fonts.ready;
    return [...document.fonts].some(f => f.family.replace(/["']/g, '') === 'Inter' && f.status === 'loaded'); });
  if (!inter) throw new Error('Inter did not load: the console would be measured in a fallback font');
  if (unmocked.length) console.log('[unmocked]', [...new Set(unmocked)].join(', '));
  await freeze(page);
  return { ctx, page, calls };
}

// Stop the clock at FROZEN_AT, zero the clock offset and draw once more, so
// every countdown, progress bar and NOW line is identical on every run.
export async function freeze(page: Page) {
  const now = await page.evaluate(() => Date.now());
  if (now >= FROZEN_AT) throw new Error(`boot took too long: page clock ${new Date(now).toISOString()} is past FROZEN_AT`);
  await page.clock.pauseAt(FROZEN_AT);
  await page.evaluate(() => {
    const St = (0, eval)('S');
    St.clockOffset = 0; St.clockRtt = 12; St.clockSynced = Date.now();
    (0, eval)('refreshClockUI(); renderSessions();');
    document.getElementById('toast-container')?.replaceChildren();
  });
}

export const evalPage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);

// freeze()'s jump to FROZEN_AT looks like a laptop waking from sleep (the 1 s
// tick sees a ~43 s gap), so the console runs syncClock (three RPCs 200 ms
// apart on the page clock) and then re-reads the sessions. That re-read
// overwrites any realtime update pushed before it lands. It needs page-clock
// time AND real network time, so a fixed runFor() lost the race on slow CI.
// Step the clock only while no Supabase request is in flight, until the
// re-read has been applied (loadSnapshot stamps S.lastSyncAt with page time).
export async function afterBootReread(page: Page) {
  const deadline = Date.now() + 15_000;
  for (let advanced = 0; ;) {
    if (await page.evaluate((f) => (0, eval)('S').lastSyncAt >= f, FROZEN_AT)) return;
    const inFlight = sbInFlight.get(page) ?? 0;
    if (Date.now() > deadline || advanced > 3000) throw new Error(`boot re-read not applied (page clock +${advanced} ms, ${inFlight} requests in flight)`);
    if (inFlight > 0) { await page.waitForTimeout(10); continue; }
    await page.clock.runFor(50);
    advanced += 50;
    await page.waitForTimeout(5);
  }
}

// Live timers are masked even though the clock is frozen (spec stage 0).
// The card timers ('.lt-remain', '.lt-elapsed') went with stage 3; '#sb-time'
// and '.le-ts' go in stage 4. A mask locator that matches nothing is harmless.
// Every new countdown sits inside an element with data-timer.
export const MASK_SELECTORS = ['#hdr-clock', '#hdr-offset', '#sb-time', '.ck-val', '.le-ts', '[data-timer]'];

// toHaveScreenshot against the committed baseline, or, with CONSOLE_NOTES_DIR
// set, a plain PNG for the before/after note to Sherif (use CONSOLE_DSF=2).
// One realtime postgres change through the fake socket (see __rtPush above).
export async function rtPush(page: Page, table: string, type: 'INSERT' | 'UPDATE' | 'DELETE', record: unknown, old: unknown = {}) {
  return page.evaluate(([tb, ty, r, o]) => (window as any).__rtPush(tb, ty, r, o), [table, type, record, old] as const);
}

export async function snap(page: Page, name: string) {
  const notes = process.env.CONSOLE_NOTES_DIR;
  if (notes) {
    fs.mkdirSync(notes, { recursive: true });
    await page.screenshot({ path: path.join(notes, `${name}.png`), animations: 'disabled', caret: 'hide' });
    return;
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0,
    mask: MASK_SELECTORS.map(s => page.locator(s)),
  });
}

// WCAG contrast of a border or text colour against the element's own
// composited background (ancestors' background colours stacked).
const CONTRAST_JS = `(() => {
  const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (f, b) => [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const bgOf = el => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); let acc = [10, 14, 20, 1];
    for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) acc = over(c, acc); } return acc; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  return { border: (sel, side) => { const el = document.querySelector(sel); if (!el) return -1; const bg = bgOf(el);
             const c = parse(getComputedStyle(el)['border' + side[0].toUpperCase() + side.slice(1) + 'Color']); return ratio(over(c, bg), bg); },
           text: sel => { const el = document.querySelector(sel); if (!el) return -1; const bg = bgOf(el); return ratio(over(parse(getComputedStyle(el).color), bg), bg); } };
})()`;
export const borderContrast = (page: Page, sel: string, side: 'top' | 'right' | 'bottom' | 'left') =>
  page.evaluate(([js, s, d]) => (0, eval)(js).border(s, d), [CONTRAST_JS, sel, side] as const);
export const textContrast = (page: Page, sel: string) =>
  page.evaluate(([js, s]) => (0, eval)(js).text(s), [CONTRAST_JS, sel] as const);
