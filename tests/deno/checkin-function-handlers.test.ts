// tests/deno/checkin-function-handlers.test.ts
// Runs the real check-in Edge Function handlers against a stubbed
// Supabase (fetch is replaced, so supabase-js talks to an in-memory
// table set). Proves each handler's gate end to end: every role, a
// database error while reading the role, and the complimentary go-live
// rules in checkin-enable-event.
//
// Run: deno test --allow-env --allow-read tests/deno/checkin-function-handlers.test.ts
// (tests/checkin-function-gates.spec.ts runs it from `npm test` when deno is installed.)

import { FUNCTION_GATES, NOT_OWNER } from '../../supabase/functions/_shared/checkin-gates.ts'

const FN_DIR = Deno.env.get('CHECKIN_FN_DIR') ?? new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_stub')
Deno.env.set('RESEND_API_KEY', 're_stub_key_for_tests') // api.resend.com is stubbed below
Deno.env.delete('CHECKIN_PRICE_ID') // env var, not a supabase-js write

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const DESK = '44444444-4444-4444-8444-444444444444'
const ATT = '55555555-5555-4555-8555-555555555555'
const NEW_USER = '66666666-6666-4666-8666-666666666666'

type Row = Record<string, unknown>
type World = {
  tables: Record<string, Row[]>
  failTable?: string
  rpcCalls: { name: string; args: Row }[]
  rpcResult: Record<string, unknown>
  // checkin-invite-staff: auth admin and email calls
  authUsers?: Record<string, Row>
  invites?: Row[]
  links?: Row[]
  emails?: Row[]
  // Paid tickets: what api.stripe.com was asked, and what a session says
  stripe?: { method: string; path: string; account: string | null; body: string }[]
  stripeSession?: Row
  stripeSessions?: Record<string, Row>
}
let world: World

// ilike as PostgREST and Postgres run it: PostgREST turns every '*' into
// '%' (there is no escaping a '*'), then LIKE reads '\' as the escape,
// '%' as any run and '_' as any one character, ignoring case.
function ilikeMatch(pattern: string, value: string): boolean {
  const p = pattern.replace(/\*/g, '%')
  const lit = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\' && i + 1 < p.length) re += lit(p[++i])
    else re += c === '%' ? '.*' : c === '_' ? '.' : lit(c)
  }
  return new RegExp('^' + re + '$', 'is').test(value)
}

// eq, in and ilike are the filters the handlers use; anything else is ignored.
function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) tests.push(r => String(r[k]) === v.slice(3))
    else if (v.startsWith('in.(') && v.endsWith(')')) {
      const set = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, ''))
      tests.push(r => set.includes(String(r[k])))
    } else if (v.startsWith('ilike.')) {
      const pattern = v.slice(6)
      tests.push(r => ilikeMatch(pattern, String(r[k] ?? '')))
    }
  }
  return (r: Row) => tests.every(t => t(r))
}
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers)
  if (url.host === 'api.resend.com') {
    ;(world.emails ??= []).push(JSON.parse(String(init?.body ?? '{}')))
    return reply(200, { id: 'email-stub' })
  }
  if (url.host === 'api.stripe.com') {
    const body = String(init?.body ?? '')
    ;(world.stripe ??= []).push({ method, path: url.pathname, account: headers.get('Stripe-Account'), body })
    const p = url.pathname
    if (method === 'POST' && p === '/v1/checkout/sessions') return reply(200, { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1', status: 'open', payment_status: 'unpaid' })
    if (method === 'GET' && p.startsWith('/v1/checkout/sessions/')) return reply(200, world.stripeSessions?.[p.split('/').pop()!] ?? world.stripeSession ?? { id: p.split('/').pop(), object: 'checkout.session', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/x', client_reference_id: ORDER })
    if (method === 'POST' && p === '/v1/refunds') return reply(200, { id: 're_1', object: 'refund', status: 'succeeded' })
    if (method === 'POST' && p === '/v1/accounts') return reply(200, { id: 'acct_test123456', object: 'account' })
    if (method === 'GET' && p.startsWith('/v1/accounts/')) return reply(200, { id: p.split('/').pop(), object: 'account', charges_enabled: true, details_submitted: true, default_currency: 'eur' })
    if (method === 'POST' && p === '/v1/account_links') return reply(200, { object: 'account_link', url: 'https://connect.stripe.com/setup/s/stub' })
    return reply(404, { error: { message: 'stub: no stripe route ' + method + ' ' + p } })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })

  if (url.pathname === '/auth/v1/user') {
    return reply(200, { id: USER, email: 'desk@stub.test', email_confirmed_at: '2026-01-01T00:00:00Z', aud: 'authenticated' })
  }
  if (url.pathname === '/auth/v1/invite' && method === 'POST') {
    const b = JSON.parse(String(init?.body ?? '{}'))
    ;(world.invites ??= []).push(b)
    return reply(200, { id: NEW_USER, email: b.email, aud: 'authenticated', user_metadata: b.data })
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/)
  if (adminUser && method === 'GET') {
    const u = world.authUsers?.[adminUser[1]]
    return u ? reply(200, u) : reply(404, { msg: 'User not found', code: 'user_not_found' })
  }
  if (url.pathname === '/auth/v1/admin/generate_link' && method === 'POST') {
    const b = JSON.parse(String(init?.body ?? '{}'))
    const known = Object.values(world.authUsers ?? {}).find(u => String((u as Row).email).toLowerCase() === String(b.email).toLowerCase())
    if (b.type === 'invite' && !known) {
      // An invite link for a new address creates the account, as /invite did
      // (checkin-invite-staff makes new accounts this way so it can send its
      // own email naming the event).
      ;(world.invites ??= []).push({ email: b.email, data: b.data })
      return reply(200, { action_link: 'https://stub.local/verify?token=new&type=invite', id: NEW_USER, email: b.email, aud: 'authenticated', user_metadata: b.data })
    }
    ;(world.links ??= []).push(b)
    return reply(200, { action_link: 'https://stub.local/verify?token=abc&type=' + b.type, id: 'x', email: b.email })
  }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/)
  if (rpc) {
    const args = JSON.parse(String(init?.body ?? '{}'))
    world.rpcCalls.push({ name: rpc[1], args })
    return reply(200, world.rpcResult[rpc[1]] ?? null)
  }
  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  if (world.failTable === table) return reply(500, { message: 'stub: database unavailable', code: 'XX000' })
  const rows = (world.tables[table] ??= [])
  const match = rowFilter(url)
  const prefer = headers.get('Prefer') ?? ''

  if (method === 'GET' || method === 'HEAD') {
    const hit = rows.filter(match)
    if (prefer.includes('count=exact')) {
      return new Response(method === 'HEAD' ? null : JSON.stringify(hit), {
        status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(hit.length - 1, 0)}/${hit.length}` },
      })
    }
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (hit.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      return reply(200, hit[0])
    }
    return reply(200, hit)
  }
  if (method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '[]'))
    const list: Row[] = Array.isArray(body) ? body : [body]
    const isUpsert = (headers.get('Prefer') ?? '').includes('resolution=')
    for (const r of list) {
      const dup = isUpsert && rows.find(x => x.event_id === r.event_id && (r.user_id === undefined || x.user_id === r.user_id))
      if (dup) { if ((headers.get('Prefer') ?? '').includes('merge-duplicates')) Object.assign(dup, r); continue }
      rows.push({ id: crypto.randomUUID(), ...r })
    }
    if (!(headers.get('Prefer') ?? '').includes('return=representation')) return reply(201, undefined)
    const out = list.map(r => rows.find(x => x.event_id === r.event_id && Object.keys(r).every(k => x[k] === r[k])) ?? r)
    return reply(201, (headers.get('Accept') ?? '').includes('vnd.pgrst.object+json') && out.length === 1 ? out[0] : out)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(init?.body ?? '{}'))
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, patch))
    return prefer.includes('return=representation') ? reply(200, hit) : reply(204, undefined)
  }
  if (method === 'DELETE') {
    const keep = rows.filter(r => !match(r))
    world.tables[table] = keep
    return reply(204, undefined)
  }
  return reply(405, { message: 'stub: method' })
}) as typeof fetch

// Capture each module's handler instead of starting a server.
const handlers: Record<string, (req: Request) => Promise<Response>> = {}
let captured: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', {
  configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { captured = h; return { finished: Promise.resolve(), shutdown: async () => {} } },
})
for (const fn of ['checkin-create-checkout', 'checkin-enable-event', 'checkin-import-attendees', 'checkin-send-qr-emails', 'checkin-kiosk-pair', 'checkin-record-scans', 'checkin-invite-staff', 'checkin-add-walk-in', 'checkin-scanner', 'checkin-held', 'checkin-tickets', 'checkin-orders-sweep', 'checkin-register', 'checkin-reminders', 'checkin-invite-guests', 'checkin-webhooks']) {
  captured = null
  await import(`${FN_DIR}${fn}/index.ts`)
  if (!captured) throw new Error('no handler captured for ' + fn)
  handlers[fn] = captured
}

async function call(fn: string, body: Row): Promise<{ status: number; body: Row }> {
  const res = await handlers[fn](new Request('http://stub.local/functions/v1/' + fn, {
    method: 'POST',
    headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io' },
    body: JSON.stringify(body),
  }))
  return { status: res.status, body: await res.json() }
}

type Who = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer' | 'api_consumer' | 'unknown' | 'operator-row-says-owner' | 'none'
const WHO: Who[] = ['owner', 'organizer', 'lead', 'crew', 'viewer', 'api_consumer', 'unknown', 'operator-row-says-owner', 'none']

function setup(who: Who, opts: { ent?: Row | null; comp?: boolean; admin?: boolean } = {}) {
  const opRole: Record<Who, string | null> = {
    owner: 'organizer', organizer: 'organizer', lead: 'lead', crew: 'crew', viewer: 'viewer',
    api_consumer: 'api_consumer', unknown: 'mystery', 'operator-row-says-owner': 'owner', none: null,
  }
  const createdBy = who === 'owner' ? USER : OTHER
  world = {
    tables: {
      leod_events: [{ id: EVENT, created_by: createdBy, name: 'Stub event', date: '2099-06-01', timezone: 'UTC', venue: 'Hall' }],
      leod_users: [{ id: USER, role: opts.admin ? 'admin' : 'director', active: true }],
      leod_checkin_operators: [
        { event_id: EVENT, user_id: OTHER, role: 'organizer' },
        ...(opRole[who] ? [{ event_id: EVENT, user_id: USER, role: opRole[who] }] : []),
      ],
      leod_checkin_entitlements: opts.ent === null ? [] : [{ event_id: EVENT, ...(opts.ent ?? { checkin_core: false, status: 'test' }) }],
      leod_checkin_comp_accounts: opts.comp ? [{ user_id: createdBy }] : [],
    },
    rpcCalls: [],
    rpcResult: { checkin_apply_scan: 'ok' },
  }
}

// The spec's permission table (docs/superpowers/specs/2026-10-04-checkin-roles-design.md),
// written out here rather than read from checkin-roles.ts so a change to
// the table cannot silently change what this test expects.
const ALLOWED: Record<string, Who[]> = {
  'checkin-create-checkout': ['owner'],
  'checkin-import-attendees': ['owner', 'organizer'],
  'checkin-send-qr-emails': ['owner', 'organizer'],
  'checkin-kiosk-pair': ['owner', 'organizer', 'lead'],
  'checkin-record-scans': ['owner', 'organizer', 'lead', 'crew'],
  'checkin-add-walk-in': ['owner', 'organizer', 'lead'],
  'checkin-held': ['owner', 'organizer'],
  'checkin-tickets': ['owner', 'organizer'],
  'checkin-reminders': ['owner', 'organizer'],
  'checkin-invite-guests': ['owner', 'organizer'],
}
const BODY: Record<string, Row> = {
  'checkin-create-checkout': { event_id: EVENT },
  'checkin-import-attendees': { event_id: EVENT, rows: [{ first_name: 'A', last_name: 'B' }], dry_run: true },
  'checkin-send-qr-emails': { event_id: EVENT },
  'checkin-kiosk-pair': { action: 'mint', event_id: EVENT, label: 'Lobby' },
  'checkin-record-scans': { event_id: EVENT, items: [] },
  'checkin-add-walk-in': { event_id: EVENT, first_name: 'Ewa', last_name: 'Sample' },
  'checkin-held': { event_id: EVENT, action: 'fill' },
  'checkin-tickets': { event_id: EVENT, action: 'payout_status' },
  'checkin-reminders': { event_id: EVENT, action: 'test', kind: 'reminder' },
  'checkin-invite-guests': { event_id: EVENT, action: 'test' },
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

for (const fn of Object.keys(ALLOWED) as (keyof typeof FUNCTION_GATES)[]) {
  const forbidden = FUNCTION_GATES[fn].forbidden.error
  for (const who of WHO) {
    const allow = ALLOWED[fn].includes(who)
    Deno.test(`${fn}: ${who} is ${allow ? 'allowed' : 'refused'}`, async () => {
      // create-checkout: a live entitlement stops right after the gate (409).
      setup(who, { ent: fn === 'checkin-create-checkout' ? { checkin_core: true, status: 'live' } : undefined })
      const r = await call(fn, BODY[fn])
      if (allow) {
        assert(r.status !== 403 || r.body.error !== forbidden, `${who} refused: ${r.status} ${JSON.stringify(r.body)}`)
        assert(r.status !== 500, `${who} got 500: ${JSON.stringify(r.body)}`)
      } else {
        assert(r.status === 403 && r.body.error === forbidden, `${who} not refused: ${r.status} ${JSON.stringify(r.body)}`)
      }
    })
  }
  Deno.test(`${fn}: a database error reading the role is a 500, not a 403`, async () => {
    setup('organizer')
    world.failTable = 'leod_checkin_operators'
    const r = await call(fn, BODY[fn])
    assert(r.status === 500, `expected 500, got ${r.status} ${JSON.stringify(r.body)}`)
  })
}

Deno.test('checkin-create-checkout: refusal carries code not_owner', async () => {
  setup('organizer')
  const r = await call('checkin-create-checkout', { event_id: EVENT })
  assert(r.status === 403 && r.body.code === 'not_owner', JSON.stringify(r))
})

// ── checkin-enable-event ────────────────────────────────────────────
const ENABLE_ALLOWED: Who[] = ['owner', 'organizer']
for (const who of WHO) {
  const allow = ENABLE_ALLOWED.includes(who)
  Deno.test(`checkin-enable-event: ${who} is ${allow ? 'allowed' : 'refused'}`, async () => {
    setup(who, { ent: { checkin_core: true, status: 'test' } })
    const r = await call('checkin-enable-event', { event_id: EVENT })
    if (allow) assert(r.status === 200, `${who}: ${r.status} ${JSON.stringify(r.body)}`)
    else assert(r.status === 403 && r.body.error === 'Forbidden', `${who}: ${r.status} ${JSON.stringify(r.body)}`)
  })
}
Deno.test('checkin-enable-event: a CueDeck admin with no role passes the setup gate', async () => {
  setup('none', { admin: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 200, JSON.stringify(r))
})
Deno.test('checkin-enable-event: a database error reading the role is a 500', async () => {
  setup('organizer'); world.failTable = 'leod_checkin_operators'
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 500, JSON.stringify(r))
})
for (const table of ['leod_events', 'leod_users', 'leod_checkin_entitlements']) {
  Deno.test(`checkin-enable-event: a database error reading ${table} is a 500`, async () => {
    setup('owner'); world.failTable = table
    const r = await call('checkin-enable-event', { event_id: EVENT })
    assert(r.status === 500, `${table}: ${r.status} ${JSON.stringify(r.body)}`)
  })
}

const compLive = () => world.rpcCalls.some(c => c.name === 'checkin_mark_comp_live')

Deno.test('comp: the owner goes live', async () => {
  setup('owner', { comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 200 && compLive(), JSON.stringify(r))
})
Deno.test('comp: a settings toggle by the owner stays in test', async () => {
  setup('owner', { comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT, settings: { self_registration: true } })
  assert(r.status === 200 && r.body.status === 'test', JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran on a settings toggle')
})
Deno.test('comp: a non-owner organizer asking to go live is refused with not_owner', async () => {
  setup('organizer', { comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 403 && r.body.code === NOT_OWNER.code && r.body.error === NOT_OWNER.error, JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran')
})
Deno.test('comp: a CueDeck admin who is not the owner cannot go live', async () => {
  setup('none', { admin: true, comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 403 && r.body.code === 'not_owner', JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran')
})
Deno.test('comp: first setup by a non-owner organizer (no entitlement yet) proceeds in test', async () => {
  setup('organizer', { comp: true, ent: null })
  const r = await call('checkin-enable-event', { event_id: EVENT })
  assert(r.status === 200 && r.body.status === 'test', JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran')
})
Deno.test('comp: a settings save by a non-owner organizer proceeds in test', async () => {
  setup('organizer', { comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT, settings: { self_registration: true } })
  assert(r.status === 200 && r.body.status === 'test', JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran')
})
Deno.test('comp: a settings save by an admin who is not the owner proceeds without going live', async () => {
  setup('none', { admin: true, comp: true, ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-enable-event', { event_id: EVENT, settings: { self_registration: true } })
  assert(r.status === 200, JSON.stringify(r))
  assert(!compLive(), 'comp go-live ran')
})

// ── reads that used to hide a database fault ────────────────────────
for (const fn of ['checkin-import-attendees', 'checkin-send-qr-emails', 'checkin-kiosk-pair', 'checkin-add-walk-in']) {
  Deno.test(`${fn}: a database error reading the entitlement is a 500`, async () => {
    setup('owner'); world.failTable = 'leod_checkin_entitlements'
    const r = await call(fn, BODY[fn])
    assert(r.status === 500, `${r.status} ${JSON.stringify(r.body)}`)
  })
}
Deno.test('checkin-import-attendees: a database error reading existing guests is a 500', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'test', auto_send_qr_email: false } })
  world.failTable = 'leod_checkin_attendees'
  const r = await call('checkin-import-attendees', BODY['checkin-import-attendees'])
  assert(r.status === 500, `${r.status} ${JSON.stringify(r.body)}`)
})
Deno.test('checkin-create-checkout: a database error reading the event is a 500, not a 404', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'test' } })
  // Fails only the second leod_events read (the role read is the first).
  let n = 0
  const real = globalThis.fetch
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (u.includes('/rest/v1/leod_events') && ++n === 2) return Promise.resolve(reply(500, { message: 'stub', code: 'XX000' }))
    return real(input, init)
  }) as typeof fetch
  try {
    const r = await call('checkin-create-checkout', { event_id: EVENT })
    assert(r.status === 500, `${r.status} ${JSON.stringify(r.body)}`)
  } finally { globalThis.fetch = real }
})

// ── record-scans desk id ────────────────────────────────────────────
const scanItem = () => ({ client_id: crypto.randomUUID(), attendee_id: ATT, scanned_at: new Date().toISOString(), action: 'checkin' })
Deno.test('checkin-record-scans: a desk_id is passed to checkin_apply_scan', async () => {
  setup('crew', { ent: { checkin_core: true, status: 'test' } })
  const r = await call('checkin-record-scans', { event_id: EVENT, desk_id: DESK, items: [scanItem()] })
  assert(r.status === 200, JSON.stringify(r))
  const c = world.rpcCalls.find(x => x.name === 'checkin_apply_scan')
  assert(c && c.args.p_desk_id === DESK, JSON.stringify(world.rpcCalls))
})
Deno.test('checkin-record-scans: a malformed or missing desk_id is stored as null', async () => {
  for (const desk_id of ['not-a-uuid', undefined]) {
    setup('crew', { ent: { checkin_core: true, status: 'test' } })
    const r = await call('checkin-record-scans', { event_id: EVENT, desk_id, items: [scanItem()] })
    assert(r.status === 200, JSON.stringify(r))
    const c = world.rpcCalls.find(x => x.name === 'checkin_apply_scan')
    assert(c && c.args.p_desk_id === null, JSON.stringify(world.rpcCalls))
  }
})

// ── record-scans: paired scanner (Build A, migration 097) ──────────
const SCAN_KEY = 'k'.repeat(64)
const DEV = 'aaaaaaaa-0000-4000-8000-000000000001'
const DOOR = 'aaaaaaaa-0000-4000-8000-000000000002'
const ROOM = 'aaaaaaaa-0000-4000-8000-000000000003'
const TOKEN = 'tok0123456789abcdef0123456789abcd'
async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('')
}
async function setupScanner(o: { ent?: Row; point?: string; revoked?: boolean; kind?: string } = {}) {
  setup('none', { ent: { checkin_core: true, status: 'test', multi_point_scanning: false, entrance_scanning: true, session_scanning: false, ...(o.ent ?? {}) } })
  world.tables.leod_checkin_scan_points = [
    { id: DOOR, event_id: EVENT, name: 'Main door', kind: 'entrance' },
    { id: ROOM, event_id: EVENT, name: 'Hall B', kind: 'interior' },
  ]
  world.tables.leod_checkin_devices = [{ id: DEV, event_id: EVENT, kind: o.kind ?? 'scanner', scan_point_id: o.point ?? DOOR,
    api_key_hash: await sha256(SCAN_KEY), revoked_at: o.revoked ? '2026-10-01T00:00:00Z' : null }]
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, qr_token: TOKEN, first_name: 'Ewa', ticket_type: 'VIP' }]
  world.rpcResult.checkin_apply_scan = 'ok'
  world.rpcResult.checkin_device_name_quota = true
  world.tables.leod_checkin_scan_events = []
}
const scanTok = (qr_token = TOKEN, action = 'checkin') => ({ client_id: crypto.randomUUID(), qr_token, scanned_at: new Date().toISOString(), action })

Deno.test('checkin-record-scans scanner: a token checks in at the paired point, attributed to the device', async () => {
  await setupScanner()
  const item = scanTok('  ' + TOKEN + '\n')
  // The row checkin_apply_scan would have inserted for this scan.
  world.tables.leod_checkin_scan_events.push({ id: crypto.randomUUID(), client_id: item.client_id, event_id: EVENT, attendee_id: ATT, device_id: DEV, result: 'ok' })
  // scan_point_id in the body is ignored: a scanner scans where it was paired.
  const r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, scan_point_id: ROOM, items: [item] })
  assert(r.status === 200, JSON.stringify(r))
  const c = world.rpcCalls.find(x => x.name === 'checkin_apply_scan')
  assert(c && c.args.p_attendee_id === ATT && c.args.p_device_id === DEV && c.args.p_operator_id === null
    && c.args.p_scan_point_id === DOOR && c.args.p_desk_id === null, JSON.stringify(c))
  const who = (r.body.who as Row)[item.client_id] as Row
  assert(who && who.first_name === 'Ewa' && who.ticket_type === 'VIP', JSON.stringify(r.body))
  assert(world.tables.leod_checkin_devices[0].last_seen_at, 'last_seen_at not stamped')
})
Deno.test('checkin-record-scans scanner: an unknown token is recorded as an attempt, with no name back', async () => {
  await setupScanner()
  world.rpcResult.checkin_apply_scan = 'unknown_token'
  const item = scanTok('nottheright0123456789abcdefghijk')
  const r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [item] })
  assert(r.status === 200, JSON.stringify(r))
  const c = world.rpcCalls.find(x => x.name === 'checkin_apply_scan')
  assert(c && c.args.p_attendee_id !== ATT && typeof c.args.p_attendee_id === 'string', JSON.stringify(c))
  assert(!(item.client_id in (r.body.who as Row)), JSON.stringify(r.body))
})
Deno.test('checkin-record-scans scanner: wrong key, revoked device or a kiosk key are refused', async () => {
  for (const o of [{ key: 'x'.repeat(64) }, { revoked: true }, { kind: 'kiosk' }]) {
    await setupScanner(o as Row)
    const r = await call('checkin-record-scans', { event_id: EVENT, device_key: (o as Row).key ?? SCAN_KEY, items: [scanTok()] })
    assert(r.status === 401, JSON.stringify([o, r]))
    assert(!world.rpcCalls.some(x => x.name === 'checkin_apply_scan'), 'scan applied')
  }
})
Deno.test('checkin-record-scans scanner: door scanning off is refused with the reason', async () => {
  await setupScanner({ ent: { entrance_scanning: false } })
  const r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [scanTok()] })
  assert(r.status === 403 && String(r.body.error).startsWith('Door scanning is switched off'), JSON.stringify(r))
})
Deno.test('checkin-record-scans scanner: a session room needs the plan and the setting', async () => {
  await setupScanner({ point: ROOM, ent: { session_scanning: true } })
  let r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [scanTok()] })
  assert(r.status === 403 && String(r.body.error).startsWith('Session scanning is not included'), JSON.stringify(r))
  await setupScanner({ point: ROOM, ent: { multi_point_scanning: true, session_scanning: true } })
  r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [scanTok()] })
  assert(r.status === 200, JSON.stringify(r))
})
Deno.test('checkin-record-scans scanner: cannot undo and cannot send an attendee id', async () => {
  await setupScanner()
  const undo = scanTok(TOKEN, 'undo')
  const byId = { client_id: crypto.randomUUID(), attendee_id: ATT, scanned_at: new Date().toISOString(), action: 'checkin' }
  const r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [undo, byId] })
  assert((r.body.results as Row)[undo.client_id] === 'error' && (r.body.results as Row)[byId.client_id] === 'error', JSON.stringify(r.body))
  assert(!world.rpcCalls.some(x => x.name === 'checkin_apply_scan'), 'scan applied')
})

Deno.test('checkin-record-scans scanner: no names for a batch, an old scan, or past the rate', async () => {
  await setupScanner()
  const two = [scanTok(), scanTok()]
  let r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: two })
  assert(r.status === 200 && Object.keys(r.body.who as Row).length === 0, 'batch got names ' + JSON.stringify(r.body))
  await setupScanner()
  const old = { ...scanTok(), scanned_at: new Date(Date.now() - 10 * 60000).toISOString() }
  r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [old] })
  assert(r.status === 200 && Object.keys(r.body.who as Row).length === 0, 'old scan got a name ' + JSON.stringify(r.body))
  await setupScanner()
  world.rpcResult.checkin_device_name_quota = false
  const fresh = scanTok()
  world.tables.leod_checkin_scan_events.push({ id: crypto.randomUUID(), client_id: fresh.client_id, event_id: EVENT, attendee_id: ATT, device_id: DEV, result: 'ok' })
  r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [fresh] })
  assert(r.status === 200 && Object.keys(r.body.who as Row).length === 0, 'quota not applied ' + JSON.stringify(r.body))
  const q = world.rpcCalls.find(x => x.name === 'checkin_device_name_quota')
  assert(q && q.args.p_device_id === DEV && q.args.p_limit === 20, JSON.stringify(q))
  // A repeat scan of someone already in gets no name and claims no quota.
  await setupScanner()
  world.rpcResult.checkin_apply_scan = 'duplicate'
  r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY, items: [scanTok()] })
  assert(r.status === 200 && Object.keys(r.body.who as Row).length === 0, 'duplicate got a name ' + JSON.stringify(r.body))
  assert(!world.rpcCalls.some(x => x.name === 'checkin_device_name_quota'), 'quota claimed for a duplicate')
})
Deno.test('checkin-record-scans scanner: a replayed client_id with another token gets no name', async () => {
  // checkin_apply_scan returns the stored result for a known client_id
  // without inserting; the stored row belongs to the first guest.
  await setupScanner()
  world.tables.leod_checkin_attendees.push({ id: OTHER, event_id: EVENT, qr_token: 'oth0123456789abcdef0123456789abcd', first_name: 'Olga', ticket_type: 'Speaker' })
  const X = crypto.randomUUID()
  world.tables.leod_checkin_scan_events = [{ id: crypto.randomUUID(), client_id: X, event_id: EVENT, attendee_id: ATT, device_id: DEV, result: 'ok' }]
  const r = await call('checkin-record-scans', { event_id: EVENT, device_key: SCAN_KEY,
    items: [{ client_id: X, qr_token: 'oth0123456789abcdef0123456789abcd', scanned_at: new Date().toISOString(), action: 'checkin' }] })
  assert(r.status === 200 && Object.keys(r.body.who as Row).length === 0, 'replay leaked a name ' + JSON.stringify(r.body))
  assert(!world.rpcCalls.some(x => x.name === 'checkin_device_name_quota'), 'quota claimed on a replay')
})
Deno.test('checkin-scanner: no tokens when scanning at its point is switched off', async () => {
  await setupScanner({ ent: { entrance_scanning: false } })
  const r = await call('checkin-scanner', { action: 'tokens', event_id: EVENT, device_key: SCAN_KEY })
  assert(r.status === 403 && !r.body.tokens && String(r.body.error).startsWith('Door scanning is switched off'), JSON.stringify(r))
})

// ── scanner pairing (098) and checkin-scanner ───────────────────────
Deno.test('checkin-kiosk-pair: a scanner code needs a scan point that is on, not self-registration', async () => {
  setup('lead', { ent: { checkin_core: true, status: 'test', self_registration: false, entrance_scanning: true, session_scanning: false, multi_point_scanning: false } })
  world.tables.leod_checkin_scan_points = [{ id: DOOR, event_id: EVENT, name: 'Main door', kind: 'entrance' }, { id: ROOM, event_id: EVENT, name: 'Hall B', kind: 'interior' }]
  let r = await call('checkin-kiosk-pair', { action: 'mint', event_id: EVENT, label: 'Door phone', device_kind: 'scanner' })
  assert(r.status === 400 && String(r.body.error).startsWith('Choose the door'), JSON.stringify(r))
  r = await call('checkin-kiosk-pair', { action: 'mint', event_id: EVENT, label: 'Room phone', device_kind: 'scanner', scan_point_id: ROOM })
  assert(r.status === 403 && String(r.body.error).startsWith('Session scanning is not included'), JSON.stringify(r))
  r = await call('checkin-kiosk-pair', { action: 'mint', event_id: EVENT, label: 'Door phone', device_kind: 'scanner', scan_point_id: DOOR })
  assert(r.status === 200 && r.body.device_kind === 'scanner', JSON.stringify(r))
  const row = (world.tables.leod_checkin_kiosk_pairing ?? [])[0]
  assert(row && row.device_kind === 'scanner' && row.scan_point_id === DOOR, JSON.stringify(row))
  // A kiosk mint still needs self-registration.
  r = await call('checkin-kiosk-pair', { action: 'mint', event_id: EVENT, label: 'Lobby' })
  assert(r.status === 403, JSON.stringify(r))
})
Deno.test('checkin-kiosk-pair: claiming a scanner code makes a scanner device at its scan point', async () => {
  setup('none', { ent: { checkin_core: true, status: 'test', self_registration: false, entrance_scanning: true } })
  world.tables.leod_checkin_scan_points = [{ id: DOOR, event_id: EVENT, name: 'Main door', kind: 'entrance' }]
  world.rpcResult.checkin_kiosk_pair_rate_check = true
  world.rpcResult.checkin_kiosk_claim_pairing = [{ event_id: EVENT, label: 'Door phone', device_kind: 'scanner', scan_point_id: DOOR }]
  const r = await call('checkin-kiosk-pair', { action: 'claim', code: 'ABCD-EFGH', device_kind: 'scanner' })
  assert(r.status === 200 && r.body.device_kind === 'scanner' && (r.body.scan_point as Row).name === 'Main door', JSON.stringify(r))
  const c = world.rpcCalls.find(x => x.name === 'checkin_kiosk_claim_pairing')
  assert(c && c.args.p_kind === 'scanner', JSON.stringify(c))
  const dev = world.tables.leod_checkin_devices[0]
  assert(dev.kind === 'scanner' && dev.scan_point_id === DOOR && typeof dev.api_key_hash === 'string' && dev.api_key_hash !== r.body.device_key, JSON.stringify(dev))
})
Deno.test('checkin-kiosk-pair: a kiosk claim asks only for kiosk codes', async () => {
  setup('none', { ent: { checkin_core: true, status: 'test', self_registration: true } })
  world.rpcResult.checkin_kiosk_pair_rate_check = true
  world.rpcResult.checkin_kiosk_claim_pairing = [{ event_id: EVENT, label: 'Lobby', device_kind: 'kiosk', scan_point_id: null }]
  const r = await call('checkin-kiosk-pair', { action: 'claim', code: 'ABCD-EFGH' })
  assert(r.status === 200 && r.body.device_kind === 'kiosk', JSON.stringify(r))
  const c = world.rpcCalls.find(x => x.name === 'checkin_kiosk_claim_pairing')
  assert(c && c.args.p_kind === 'kiosk', JSON.stringify(c))
  assert(world.tables.leod_checkin_devices[0].kind === 'kiosk', 'kiosk device kind')
})
Deno.test('checkin-scanner: config says where it is and whether it may scan', async () => {
  await setupScanner()
  let r = await call('checkin-scanner', { action: 'config', event_id: EVENT, device_key: SCAN_KEY })
  assert(r.status === 200 && r.body.allowed === true && (r.body.scan_point as Row).name === 'Main door' && r.body.status === 'test', JSON.stringify(r))
  await setupScanner({ ent: { entrance_scanning: false } })
  r = await call('checkin-scanner', { action: 'config', event_id: EVENT, device_key: SCAN_KEY })
  assert(r.status === 200 && r.body.allowed === false && String(r.body.reason).startsWith('Door scanning is switched off'), JSON.stringify(r))
})
Deno.test('checkin-scanner: tokens are tokens only', async () => {
  await setupScanner()
  const r = await call('checkin-scanner', { action: 'tokens', event_id: EVENT, device_key: SCAN_KEY })
  assert(r.status === 200 && JSON.stringify(r.body.tokens) === JSON.stringify([TOKEN]), JSON.stringify(r))
  assert(!JSON.stringify(r.body).includes('Ewa') && !JSON.stringify(r.body).includes(ATT), 'leaked more than tokens')
})
Deno.test('checkin-scanner: a user session, a wrong key or a revoked device gets nothing', async () => {
  for (const o of [{ key: '' }, { key: 'y'.repeat(64) }, { revoked: true }]) {
    await setupScanner(o as Row)
    const r = await call('checkin-scanner', { action: 'tokens', event_id: EVENT, device_key: (o as Row).key ?? SCAN_KEY })
    assert(r.status === 401 && !r.body.tokens, JSON.stringify([o, r]))
  }
})

// ── checkin-invite-staff ────────────────────────────────────────────
const ORG2 = '77777777-7777-4777-8777-777777777777'
const LEAD = '88888888-8888-4888-8888-888888888888'
const CREW = '99999999-9999-4999-8999-999999999999'
const VIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const API = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// Staff world: the caller (USER) as `who`, the owner OTHER unless the
// caller is the owner, plus one of each other role and an api_consumer.
function staffSetup(who: Who, opts: { via?: string; ent?: Row | null; comp?: string[]; eventName?: string } = {}) {
  setup(who, { ent: opts.ent })
  const ev = world.tables.leod_events[0]
  ev.created_via = opts.via ?? 'checkin'
  ev.active = true
  if (opts.eventName) ev.name = opts.eventName
  world.tables.leod_checkin_operators.push(
    { event_id: EVENT, user_id: ORG2, role: 'organizer' },
    { event_id: EVENT, user_id: LEAD, role: 'lead' },
    { event_id: EVENT, user_id: CREW, role: 'crew' },
    { event_id: EVENT, user_id: VIEW, role: 'viewer' },
    { event_id: EVENT, user_id: API, role: 'api_consumer' },
  )
  world.tables.leod_users.push(
    { id: OTHER, email: 'owner@stub.test', name: 'Owner', active: true },
    { id: ORG2, email: 'org2@stub.test', name: 'Org Two', active: true },
    { id: LEAD, email: 'lead@stub.test', name: 'Lead', active: true },
    { id: CREW, email: 'crew@stub.test', name: 'Crew', active: true },
    { id: VIEW, email: 'view@stub.test', name: 'Viewer', active: true },
  )
  world.tables.leod_checkin_comp_accounts = (opts.comp ?? []).map(user_id => ({ user_id }))
  world.tables.leod_checkin_invite_log = []
  world.authUsers = {}
  world.invites = []; world.links = []; world.emails = []
}
const ops = () => world.tables.leod_checkin_operators
const opRole = (id: string) => ops().find(o => o.user_id === id)?.role ?? null
const IS = 'checkin-invite-staff'
const STAFF_ALLOWED: Who[] = ['owner', 'organizer', 'lead']

for (const who of WHO) {
  const allow = STAFF_ALLOWED.includes(who)
  Deno.test(`${IS} list: ${who} is ${allow ? 'allowed' : 'refused'}`, async () => {
    staffSetup(who)
    const r = await call(IS, { event_id: EVENT, action: 'list' })
    if (allow) assert(r.status === 200 && Array.isArray(r.body.staff), `${who}: ${r.status} ${JSON.stringify(r.body)}`)
    else assert(r.status === 403 && r.body.error === 'Forbidden, organizers and desk leads only', `${who}: ${r.status} ${JSON.stringify(r.body)}`)
  })
}
Deno.test(`${IS}: a database error reading the role is a 500, not a 403`, async () => {
  staffSetup('organizer'); world.failTable = 'leod_checkin_operators'
  const r = await call(IS, { event_id: EVENT, action: 'list' })
  assert(r.status === 500, JSON.stringify(r))
})
for (const table of ['leod_users', 'leod_checkin_comp_accounts']) {
  Deno.test(`${IS} list: a database error reading ${table} is a 500`, async () => {
    staffSetup('owner')
    // leod_users is also read for the caller's active flag; fail only the people read.
    const real = globalThis.fetch
    let n = 0
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input)
      if (u.includes('/rest/v1/' + table) && (table !== 'leod_users' || ++n === 2)) return Promise.resolve(reply(500, { message: 'stub', code: 'XX000' }))
      return real(input, init)
    }) as typeof fetch
    try {
      const r = await call(IS, { event_id: EVENT, action: 'list' })
      assert(r.status === 500, `${r.status} ${JSON.stringify(r.body)}`)
    } finally { globalThis.fetch = real }
  })
}
Deno.test(`${IS} list: four roles, no api_consumer, today's fields, is_comp for the owner only`, async () => {
  staffSetup('owner', { comp: [USER] })
  const r = await call(IS, { event_id: EVENT, action: 'list' })
  const staff = r.body.staff as Row[]
  assert(r.status === 200, JSON.stringify(r))
  assert(!staff.some(s => s.user_id === API), 'api_consumer listed')
  for (const role of ['organizer', 'lead', 'crew', 'viewer']) assert(staff.some(s => s.role === role), 'missing ' + role)
  for (const s of staff) for (const k of ['user_id', 'role', 'email', 'name', 'is_owner', 'is_comp']) assert(k in s, `missing ${k}`)
  const me = staff.find(s => s.user_id === USER)!
  assert(me.is_owner === true && me.is_comp === true, JSON.stringify(me))
  assert(staff.find(s => s.user_id === ORG2)!.is_comp === false, 'org2 comp')

  staffSetup('organizer', { comp: [OTHER] })
  const r2 = await call(IS, { event_id: EVENT, action: 'list' })
  assert(r2.status === 200 && !(r2.body.staff as Row[]).some(s => 'is_comp' in s), 'is_comp shown to a non-owner')
  assert((r2.body.staff as Row[]).find(s => s.user_id === OTHER)!.is_owner === true, 'owner not flagged')
})
Deno.test(`${IS}: unknown action or bad event id is a 400`, async () => {
  staffSetup('owner')
  assert((await call(IS, { event_id: EVENT, action: 'promote' })).status === 400, 'action')
  assert((await call(IS, { event_id: 'nope', action: 'list' })).status === 400, 'event id')
})

// invite
for (const [who, want, ok] of [
  ['owner', 'organizer', true], ['owner', 'lead', true], ['owner', 'viewer', true], ['owner', 'crew', true],
  ['organizer', 'organizer', true], ['organizer', 'lead', true], ['organizer', 'viewer', true], ['organizer', 'crew', true],
  ['lead', 'crew', true], ['lead', 'organizer', false], ['lead', 'lead', false], ['lead', 'viewer', false],
] as [Who, string, boolean][]) {
  Deno.test(`${IS} invite: ${who} inviting a new ${want} is ${ok ? 'allowed' : 'refused'}`, async () => {
    staffSetup(who)
    const r = await call(IS, { event_id: EVENT, action: 'invite', email: ' New.Person@Stub.test ', role: want, name: 'New' })
    if (!ok) {
      assert(r.status === 403 && r.body.code === 'role_not_allowed', JSON.stringify(r))
      assert(world.invites!.length === 0 && opRole(NEW_USER) === null, 'invited anyway')
      return
    }
    assert(r.status === 200, JSON.stringify(r))
    // Ruling 9: every new address is a check-in-only account.
    const inv = world.invites![0]
    assert(inv && inv.email === 'new.person@stub.test' && (inv.data as Row).checkin_staff === 'true', JSON.stringify(world.invites))
    assert(opRole(NEW_USER) === want, `grant ${opRole(NEW_USER)}`)
    assert(world.tables.leod_checkin_invite_log.length === 1, 'invite not counted')
  })
}
for (const role of ['owner', 'api_consumer', 'admin', undefined]) {
  Deno.test(`${IS} invite: role ${role} is a 400`, async () => {
    staffSetup('owner')
    const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'x@stub.test', role })
    assert(r.status === 400 && world.invites!.length === 0, JSON.stringify(r))
  })
}
Deno.test(`${IS} invite: the rate limit still counts`, async () => {
  staffSetup('organizer')
  for (let i = 0; i < 50; i++) world.tables.leod_checkin_invite_log.push({ event_id: EVENT, inviter_id: OTHER, created_at: new Date().toISOString() })
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'x@stub.test', role: 'crew' })
  assert(r.status === 429 && r.body.code === 'invite_rate' && world.invites!.length === 0, JSON.stringify(r))
})
Deno.test(`${IS} invite: an existing user who never signed in gets a fresh link, name escaped`, async () => {
  staffSetup('organizer', { eventName: 'Gala <script>x</script> & "co"' })
  world.authUsers![CREW] = { id: CREW, email: 'crew@stub.test', email_confirmed_at: null, last_sign_in_at: null, aud: 'authenticated' }
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'crew@stub.test', role: 'crew' })
  assert(r.status === 200, JSON.stringify(r))
  assert(world.links!.length === 1 && world.links![0].type === 'invite', JSON.stringify(world.links))
  const html = String(world.emails![0]?.html ?? '')
  assert(html.includes('Gala &lt;script&gt;x&lt;/script&gt; &amp; &quot;co&quot;') && !html.includes('<script>'), html)
  assert(opRole(CREW) === 'crew' && ops().filter(o => o.user_id === CREW).length === 1, 'grant duplicated')
})
Deno.test(`${IS} invite: a viewer invite email speaks of the dashboard`, async () => {
  staffSetup('organizer')
  world.authUsers![VIEW] = { id: VIEW, email: 'view@stub.test', email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: null, aud: 'authenticated' }
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'view@stub.test', role: 'viewer' })
  assert(r.status === 200 && world.links![0].type === 'recovery', JSON.stringify(r))
  assert(String(world.emails![0].html).includes('the live check-in dashboard'), String(world.emails![0].html))
})
Deno.test(`${IS} invite: someone already on the event with another role is a 409`, async () => {
  staffSetup('organizer')
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'lead@stub.test', role: 'crew' })
  assert(r.status === 409 && r.body.code === 'already_on_event' && opRole(LEAD) === 'lead', JSON.stringify(r))
})

// PostgREST reads '*' in an ilike pattern as '%', so '*@domain' would find
// whoever has an address there and grant them the role.
Deno.test(`${IS} invite: an address with '*' is refused and grants nobody`, async () => {
  staffSetup('organizer')
  world.tables.leod_users.push({ id: NEW_USER, email: 'someone@solo.test', name: 'Solo', active: true })
  world.authUsers![NEW_USER] = { id: NEW_USER, email: 'someone@solo.test', email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-01-02T00:00:00Z', aud: 'authenticated' }
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: '*@solo.test', role: 'crew' })
  assert(r.status === 400, JSON.stringify(r))
  assert(opRole(NEW_USER) === null && world.invites!.length === 0, 'granted anyway')
})
Deno.test(`${IS} invite: '_' in an address is literal and does not match another account`, async () => {
  staffSetup('organizer')
  world.tables.leod_users.push({ id: NEW_USER, email: 'axb@solo.test', name: 'Axb', active: true })
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'a_b@solo.test', role: 'crew' })
  assert(r.status === 200, JSON.stringify(r))
  assert(world.invites!.length === 1 && world.invites![0].email === 'a_b@solo.test', JSON.stringify(world.invites))
})

// remove
for (const [who, target, status, code] of [
  ['lead', CREW, 200, null], ['lead', LEAD, 403, 'forbidden'], ['lead', ORG2, 403, 'forbidden'], ['lead', VIEW, 403, 'forbidden'],
  ['lead', OTHER, 409, 'event_owner'], ['organizer', OTHER, 409, 'event_owner'], ['organizer', VIEW, 200, null],
  ['organizer', ORG2, 200, null], ['owner', ORG2, 200, null], ['owner', USER, 409, 'event_owner'], ['owner', NEW_USER, 404, 'not_found'],
  ['crew', CREW, 403, null], ['viewer', CREW, 403, null],
] as [Who, string, number, string | null][]) {
  Deno.test(`${IS} remove: ${who} removing ${target.slice(0, 4)} -> ${status}${code ? ' ' + code : ''}`, async () => {
    staffSetup(who)
    const before = opRole(target)
    const r = await call(IS, { event_id: EVENT, action: 'remove', user_id: target })
    assert(r.status === status && (code === null || r.body.code === code), JSON.stringify(r))
    if (status === 200) assert(opRole(target) === null, 'still there')
    else assert(opRole(target) === before, 'removed anyway')
  })
}
Deno.test(`${IS} remove: the last organizer stays`, async () => {
  staffSetup('organizer')
  // Only USER is an organizer row now (owner OTHER has none in this world).
  world.tables.leod_checkin_operators = ops().filter(o => !(o.role === 'organizer' && o.user_id !== USER))
  const r = await call(IS, { event_id: EVENT, action: 'remove', user_id: USER })
  assert(r.status === 409 && r.body.code === 'last_organizer' && opRole(USER) === 'organizer', JSON.stringify(r))
})

// transfer_owner
Deno.test(`${IS} transfer_owner: owner to an organizer`, async () => {
  staffSetup('owner', { comp: [USER] })
  const r = await call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: ORG2 })
  assert(r.status === 200, JSON.stringify(r))
  assert(world.tables.leod_events[0].created_by === ORG2, 'created_by not moved')
  assert(opRole(USER) === 'organizer', 'old owner not an organizer')
  assert(r.body.owner_id === ORG2 && r.body.was_comp === true && r.body.is_comp === false && r.body.comp_changed === true, JSON.stringify(r.body))
})
Deno.test(`${IS} transfer_owner: an old owner with no operator row gets one`, async () => {
  staffSetup('owner')
  world.tables.leod_checkin_operators = ops().filter(o => o.user_id !== USER)
  const r = await call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: ORG2 })
  assert(r.status === 200 && opRole(USER) === 'organizer' && r.body.comp_changed === false, JSON.stringify(r))
})
for (const [label, who, opts, target, status, code] of [
  ['organizer', 'organizer', {}, ORG2, 403, 'not_owner'],
  ['lead', 'lead', {}, ORG2, 403, 'not_owner'],
  ['console event', 'owner', { via: 'console' }, ORG2, 409, 'console_event'],
  ['to a lead', 'owner', {}, LEAD, 409, 'not_organizer'],
  ['to someone not on the event', 'owner', {}, NEW_USER, 409, 'not_organizer'],
  ['to self', 'owner', {}, USER, 400, 'bad_target'],
  ['to garbage', 'owner', {}, 'x', 400, 'bad_target'],
] as [string, Who, { via?: string }, string, number, string][]) {
  Deno.test(`${IS} transfer_owner: ${label} -> ${status} ${code}`, async () => {
    staffSetup(who, opts)
    const owner = world.tables.leod_events[0].created_by
    const r = await call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: target })
    assert(r.status === status && r.body.code === code, JSON.stringify(r))
    assert(world.tables.leod_events[0].created_by === owner, 'owner changed')
  })
}
Deno.test(`${IS} transfer_owner: a lost compare-and-set is owner_changed`, async () => {
  staffSetup('owner')
  const real = globalThis.fetch
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (u.includes('/rest/v1/leod_events') && (init?.method ?? '').toUpperCase() === 'PATCH') world.tables.leod_events[0].created_by = ORG2
    return real(input, init)
  }) as typeof fetch
  try {
    const r = await call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: ORG2 })
    assert(r.status === 409 && r.body.code === 'owner_changed', JSON.stringify(r))
  } finally { globalThis.fetch = real }
})

// archive_event
Deno.test(`${IS} archive_event: owner, test mode`, async () => {
  staffSetup('owner', { ent: { checkin_core: true, status: 'test' } })
  const r = await call(IS, { event_id: EVENT, action: 'archive_event' })
  assert(r.status === 200 && world.tables.leod_events[0].active === false, JSON.stringify(r))
})
for (const [label, who, opts, status, code] of [
  ['organizer', 'organizer', {}, 403, 'not_owner'],
  ['lead', 'lead', {}, 403, 'not_owner'],
  ['console event', 'owner', { via: 'console' }, 409, 'console_event'],
  ['live event', 'owner', { ent: { checkin_core: true, status: 'live' } }, 409, 'live_event'],
] as [string, Who, { via?: string; ent?: Row }, number, string][]) {
  Deno.test(`${IS} archive_event: ${label} -> ${status} ${code}`, async () => {
    staffSetup(who, opts)
    const r = await call(IS, { event_id: EVENT, action: 'archive_event' })
    assert(r.status === status && r.body.code === code, JSON.stringify(r))
    assert(world.tables.leod_events[0].active === true, 'archived anyway')
  })
}
Deno.test(`${IS} archive_event: a database error reading the entitlement is a 500`, async () => {
  staffSetup('owner'); world.failTable = 'leod_checkin_entitlements'
  const r = await call(IS, { event_id: EVENT, action: 'archive_event' })
  assert(r.status === 500 && world.tables.leod_events[0].active === true, JSON.stringify(r))
})
Deno.test(`${IS}: a database error reading the team is a 500`, async () => {
  staffSetup('owner')
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (u.includes('/rest/v1/leod_checkin_operators') && ++n === 2) return Promise.resolve(reply(500, { message: 'stub', code: 'XX000' }))
    return real(input, init)
  }) as typeof fetch
  try {
    const r = await call(IS, { event_id: EVENT, action: 'list' })
    assert(r.status === 500, `${r.status} ${JSON.stringify(r.body)}`)
  } finally { globalThis.fetch = real }
})

// ── fix round 1: archived events, open checkout, lead list, log before send, inactive target ──
async function withFetch<T>(wrap: (real: typeof fetch) => typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = wrap(real)
  try { return await run() } finally { globalThis.fetch = real }
}
const urlOf = (input: Request | URL | string) => String(input instanceof Request ? input.url : input)
const methodOf = (input: Request | URL | string, init?: RequestInit) =>
  (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

for (const [action, extra] of [
  ['invite', { email: 'x@stub.test', role: 'crew' }],
  ['transfer_owner', { user_id: ORG2 }],
  ['archive_event', {}],
] as [string, Row][]) {
  Deno.test(`${IS} ${action}: an archived event is a 409 archived`, async () => {
    staffSetup('owner')
    world.tables.leod_events[0].active = false
    const r = await call(IS, { event_id: EVENT, action, ...extra })
    assert(r.status === 409 && r.body.code === 'archived' && r.body.error === 'This event was deleted.', JSON.stringify(r))
    assert(world.invites!.length === 0 && world.tables.leod_events[0].created_by === USER, 'acted anyway')
  })
}
Deno.test(`${IS}: list and remove still work on an archived event`, async () => {
  staffSetup('owner')
  world.tables.leod_events[0].active = false
  assert((await call(IS, { event_id: EVENT, action: 'list' })).status === 200, 'list')
  const r = await call(IS, { event_id: EVENT, action: 'remove', user_id: CREW })
  assert(r.status === 200 && opRole(CREW) === null, JSON.stringify(r))
})
Deno.test(`${IS} archive_event: an open checkout is a 409 checkout_open`, async () => {
  staffSetup('owner', { ent: { checkin_core: true, status: 'test', checkout_session_id: 'cs_test_1', checkout_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } })
  const r = await call(IS, { event_id: EVENT, action: 'archive_event' })
  assert(r.status === 409 && r.body.code === 'checkout_open' && r.body.error === 'A payment is in progress for this event. Try again in an hour.', JSON.stringify(r))
  assert(world.tables.leod_events[0].active === true, 'archived anyway')
})
Deno.test(`${IS} archive_event: an expired checkout does not block`, async () => {
  staffSetup('owner', { ent: { checkin_core: true, status: 'test', checkout_session_id: 'cs_test_1', checkout_expires_at: new Date(Date.now() - 60_000).toISOString() } })
  const r = await call(IS, { event_id: EVENT, action: 'archive_event' })
  assert(r.status === 200 && world.tables.leod_events[0].active === false, JSON.stringify(r))
})
Deno.test(`${IS} list: a desk lead sees crew and their own row only`, async () => {
  staffSetup('lead')
  const r = await call(IS, { event_id: EVENT, action: 'list' })
  const ids = (r.body.staff as Row[]).map(s => s.user_id).sort()
  assert(r.status === 200 && JSON.stringify(ids) === JSON.stringify([USER, CREW].sort()), JSON.stringify(r.body))
  assert(!JSON.stringify(r.body).includes('org2@stub.test') && !JSON.stringify(r.body).includes('view@stub.test'), 'leaked emails')
})
Deno.test(`${IS} list: an organizer sees every role`, async () => {
  staffSetup('organizer')
  const r = await call(IS, { event_id: EVENT, action: 'list' })
  const roles = new Set((r.body.staff as Row[]).map(s => s.role))
  assert(r.status === 200 && ['organizer', 'lead', 'crew', 'viewer'].every(x => roles.has(x)), JSON.stringify(r.body))
})

// The invite log row is written before the send, and a failed log write stops the send.
const logFirst = async (run: () => Promise<{ status: number; body: Row }>) => {
  const order: string[] = []
  const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
    const u = urlOf(input)
    if (u.includes('/rest/v1/leod_checkin_invite_log') && methodOf(input, init) === 'POST') order.push('log')
    if (u.includes('/auth/v1/invite') || u.includes('/auth/v1/admin/generate_link') || u.includes('api.resend.com')) order.push('send')
    return real(input, init)
  }) as typeof fetch, run)
  return { r, order }
}
Deno.test(`${IS} invite: new address, log row before the invite`, async () => {
  staffSetup('organizer')
  const { r, order } = await logFirst(() => call(IS, { event_id: EVENT, action: 'invite', email: 'new@stub.test', role: 'crew' }))
  assert(r.status === 200 && order[0] === 'log' && order.includes('send') && order.filter(o => o === 'log').length === 1, JSON.stringify(order))
})
Deno.test(`${IS} invite: re-invite, log row before the link and email`, async () => {
  staffSetup('organizer')
  world.authUsers![CREW] = { id: CREW, email: 'crew@stub.test', email_confirmed_at: null, last_sign_in_at: null, aud: 'authenticated' }
  const { r, order } = await logFirst(() => call(IS, { event_id: EVENT, action: 'invite', email: 'crew@stub.test', role: 'crew' }))
  assert(r.status === 200 && order[0] === 'log' && order.filter(o => o === 'send').length === 2, JSON.stringify(order))
})
Deno.test(`${IS} invite: same role, already signed in, is a no-op without a log row`, async () => {
  staffSetup('organizer')
  world.authUsers![CREW] = { id: CREW, email: 'crew@stub.test', email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-01-02T00:00:00Z', aud: 'authenticated' }
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'crew@stub.test', role: 'crew' })
  assert(r.status === 200 && world.tables.leod_checkin_invite_log.length === 0 && world.emails!.length === 0, JSON.stringify(r))
})
for (const [label, email, prep] of [
  ['new address', 'new@stub.test', () => {}],
  ['re-invite', 'crew@stub.test', () => { world.authUsers![CREW] = { id: CREW, email: 'crew@stub.test', email_confirmed_at: null, last_sign_in_at: null, aud: 'authenticated' } }],
] as [string, string, () => void][]) {
  Deno.test(`${IS} invite: ${label}, a failed log write is a 500 and nothing is sent`, async () => {
    staffSetup('organizer'); prep()
    const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
      if (urlOf(input).includes('/rest/v1/leod_checkin_invite_log') && methodOf(input, init) === 'POST') return Promise.resolve(reply(500, { message: 'stub', code: 'XX000' }))
      return real(input, init)
    }) as typeof fetch, () => call(IS, { event_id: EVENT, action: 'invite', email, role: 'crew' }))
    assert(r.status === 500, JSON.stringify(r))
    assert(world.invites!.length === 0 && world.links!.length === 0 && world.emails!.length === 0, 'sent anyway')
  })
}
Deno.test(`${IS} transfer_owner: an inactive target is a 409 target_inactive`, async () => {
  staffSetup('owner')
  world.tables.leod_users.find(u => u.id === ORG2)!.active = false
  const r = await call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: ORG2 })
  assert(r.status === 409 && r.body.code === 'target_inactive' && world.tables.leod_events[0].created_by === USER, JSON.stringify(r))
})
Deno.test(`${IS} transfer_owner: a database error reading the target is a 500`, async () => {
  staffSetup('owner')
  let n = 0
  const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
    if (urlOf(input).includes('/rest/v1/leod_users') && ++n === 2) return Promise.resolve(reply(500, { message: 'stub', code: 'XX000' }))
    return real(input, init)
  }) as typeof fetch, () => call(IS, { event_id: EVENT, action: 'transfer_owner', user_id: ORG2 }))
  assert(r.status === 500 && world.tables.leod_events[0].created_by === USER, JSON.stringify(r))
})

// checkin-create-checkout on an archived event
Deno.test('checkin-create-checkout: an archived event is a 409 archived, before any Stripe call', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'test' } })
  world.tables.leod_events[0].active = false
  Deno.env.set('CHECKIN_PRICE_ID', 'price_stub')
  const offHost: string[] = []
  try {
    const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
      const h = new URL(urlOf(input)).host
      if (h !== 'stub.local') offHost.push(h)
      return real(input, init)
    }) as typeof fetch, () => call('checkin-create-checkout', { event_id: EVENT }))
    assert(r.status === 409 && r.body.code === 'archived' && r.body.error === 'This event was deleted.', JSON.stringify(r))
    assert(offHost.length === 0, 'network call to ' + offHost.join(','))
  } finally { Deno.env.delete('CHECKIN_PRICE_ID') }
})

// ── checkin-add-walk-in ─────────────────────────────────────────────
const WI = 'checkin-add-walk-in'
const walkIns = () => (world.tables.leod_checkin_attendees ?? []).filter(a => a.source === 'walk_in')
function walkSetup(status: 'test' | 'live', used = 3) {
  setup('lead', { ent: { checkin_core: true, status } })
  world.rpcResult.checkin_test_usage = used
}
Deno.test(`${WI}: a lead adds a test-mode walk-in, is_test, source walk_in`, async () => {
  walkSetup('test')
  const r = await call(WI, { event_id: EVENT, first_name: ' Ewa ', last_name: 'Sample', email: 'Ewa@Example.com', company: 'Contoso' })
  assert(r.status === 200 && r.body.ok === true, JSON.stringify(r))
  const a = r.body.attendee as Row
  assert(a.first_name === 'Ewa' && a.email === 'Ewa@Example.com' && a.ticket_type === 'attendee' && typeof a.qr_token === 'string' && typeof a.id === 'string', JSON.stringify(a))
  const rows = walkIns()
  assert(rows.length === 1 && rows[0].is_test === true && rows[0].event_id === EVENT, JSON.stringify(rows))
  assert(world.rpcCalls.some(c => c.name === 'checkin_test_usage' && c.args.p_event_id === EVENT), 'test usage not read')
})
Deno.test(`${WI}: a live event writes is_test false and skips the test cap`, async () => {
  walkSetup('live', 999)
  const r = await call(WI, BODY[WI])
  assert(r.status === 200, JSON.stringify(r))
  assert(walkIns()[0].is_test === false, JSON.stringify(walkIns()))
  assert(!world.rpcCalls.some(c => c.name === 'checkin_test_usage'), 'test usage read on a live event')
})
Deno.test(`${WI}: test mode at the cap is a 403 test_cap and nothing is written`, async () => {
  walkSetup('test', 25)
  const r = await call(WI, BODY[WI])
  assert(r.status === 403 && r.body.code === 'test_cap', JSON.stringify(r))
  assert(walkIns().length === 0, 'written anyway')
})
Deno.test(`${WI}: test mode one below the cap is allowed`, async () => {
  walkSetup('test', 24)
  const r = await call(WI, BODY[WI])
  assert(r.status === 200, JSON.stringify(r))
})
Deno.test(`${WI}: an unreadable test usage is a 500 and nothing is written`, async () => {
  walkSetup('test'); world.rpcResult.checkin_test_usage = null
  const r = await call(WI, BODY[WI])
  assert(r.status === 500 && walkIns().length === 0, JSON.stringify(r))
})
Deno.test(`${WI}: an archived event is a 409 archived`, async () => {
  walkSetup('test'); world.tables.leod_events[0].active = false
  const r = await call(WI, BODY[WI])
  assert(r.status === 409 && r.body.code === 'archived' && r.body.error === 'This event was deleted.', JSON.stringify(r))
  assert(walkIns().length === 0, 'written anyway')
})
Deno.test(`${WI}: check-in not enabled is a 403`, async () => {
  setup('lead', { ent: { checkin_core: false, status: 'test' } })
  const r = await call(WI, BODY[WI])
  assert(r.status === 403 && r.body.code === 'forbidden', JSON.stringify(r))
})
Deno.test(`${WI}: an email already on the event (any case) is a 409 already_registered`, async () => {
  walkSetup('test')
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, email: 'ewa@example.com', source: 'import' }]
  const r = await call(WI, { ...BODY[WI], email: 'EWA@example.COM' })
  assert(r.status === 409 && r.body.code === 'already_registered', JSON.stringify(r))
  assert(walkIns().length === 0, 'written anyway')
})
Deno.test(`${WI}: an address with '*' is refused`, async () => {
  walkSetup('test')
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, email: 'ewa@example.com', source: 'import' }]
  const r = await call(WI, { ...BODY[WI], email: '*@example.com' })
  assert(r.status === 400 && r.body.code === 'invalid', JSON.stringify(r))
  assert(walkIns().length === 0, 'written anyway')
})
Deno.test(`${WI}: '_' in an address is literal and does not match another guest`, async () => {
  walkSetup('test')
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, email: 'axb@example.com', source: 'import' }]
  const r = await call(WI, { ...BODY[WI], email: 'a_b@example.com' })
  assert(r.status === 200, JSON.stringify(r))
})
Deno.test(`${WI}: the same email on another event is fine`, async () => {
  walkSetup('test')
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: OTHER, email: 'ewa@example.com', source: 'import' }]
  const r = await call(WI, { ...BODY[WI], email: 'ewa@example.com' })
  assert(r.status === 200, JSON.stringify(r))
})
Deno.test(`${WI}: a unique violation on insert (race) is a 409 already_registered`, async () => {
  walkSetup('test')
  const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (urlOf(input).includes('/rest/v1/leod_checkin_attendees') && method === 'POST') {
      return Promise.resolve(reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' }))
    }
    return real(input, init)
  }) as typeof fetch, () => call(WI, { ...BODY[WI], email: 'ewa@example.com' }))
  assert(r.status === 409 && r.body.code === 'already_registered', JSON.stringify(r))
})
Deno.test(`${WI}: any other insert error is a 500`, async () => {
  walkSetup('test')
  const r = await withFetch(real => ((input: Request | URL | string, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (urlOf(input).includes('/rest/v1/leod_checkin_attendees') && method === 'POST') {
      return Promise.resolve(reply(500, { code: 'XX000', message: 'stub' }))
    }
    return real(input, init)
  }) as typeof fetch, () => call(WI, BODY[WI]))
  assert(r.status === 500, JSON.stringify(r))
})
for (const table of ['leod_events', 'leod_users', 'leod_checkin_attendees']) {
  Deno.test(`${WI}: a database error reading ${table} is a 500`, async () => {
    walkSetup('test'); world.failTable = table
    const r = await call(WI, { ...BODY[WI], email: 'ewa@example.com' })
    assert(r.status === 500, `${table}: ${r.status} ${JSON.stringify(r.body)}`)
  })
}
for (const [label, extra] of [
  ['missing last name', { last_name: ' ' }],
  ['malformed email', { email: 'not an email' }],
  ['long company', { company: 'x'.repeat(201) }],
  ['long ticket type', { ticket_type: 'x'.repeat(61) }],
] as [string, Row][]) {
  Deno.test(`${WI}: ${label} is a 400 invalid`, async () => {
    walkSetup('test')
    const r = await call(WI, { ...BODY[WI], ...extra })
    assert(r.status === 400 && r.body.code === 'invalid', JSON.stringify(r))
    assert(walkIns().length === 0, 'written anyway')
  })
}
Deno.test(`${WI}: a bad event id is a 400`, async () => {
  walkSetup('test')
  const r = await call(WI, { ...BODY[WI], event_id: 'nope' })
  assert(r.status === 400, JSON.stringify(r))
})
Deno.test(`${WI}: an inactive account is a 403`, async () => {
  walkSetup('test'); world.tables.leod_users[0].active = false
  const r = await call(WI, BODY[WI])
  assert(r.status === 403 && walkIns().length === 0, JSON.stringify(r))
})

Deno.test(`${IS} invite: a new address gets our email naming the event, not Supabase's generic one`, async () => {
  staffSetup('organizer', { eventName: 'Northwind Summit 2026' })
  const r = await call(IS, { event_id: EVENT, action: 'invite', email: 'fresh@stub.test', role: 'crew' })
  assert(r.status === 200, JSON.stringify(r))
  const m = world.emails![0] as { subject: string; html: string }
  assert(m && m.subject === "You're invited to Northwind Summit 2026 check-in", 'subject ' + m?.subject)
  assert(m.html.includes('access to the check-in desk') && m.html.includes('token=new'), m.html)
})

Deno.test('checkin-send-qr-emails: the guest email carries the event brand (Event admin)', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live', registration_brand_color: '#0F766E',
    registration_logo_path: EVENT + '/logo-abcdef12.png', registration_host_name: 'Northwind <Events>' } })
  ;(world.tables.leod_checkin_attendees ??= []).push({ id: 'b1000000-0000-4000-8000-000000000001', event_id: EVENT, first_name: 'Maya',
    email: 'maya@stub.test', qr_token: 'tok00000000000000000000000000001', qr_email_sent_at: null, is_test: false })
  const r = await call('checkin-send-qr-emails', { event_id: EVENT })
  assert(r.status === 200, JSON.stringify(r))
  const html = String(world.emails?.[0]?.html ?? '')
  assert(html.includes('border-top:4px solid #0F766E'), 'colour ' + html.slice(0, 300))
  assert(html.includes('/storage/v1/object/public/checkin-public/' + EVENT + '/logo-abcdef12.png'), 'logo')
  assert(html.includes('Northwind &lt;Events&gt;') && !html.includes('<Events>'), 'host escaped')
})

Deno.test('checkin-held: releasing a held guest on a live event emails their ticket', async () => {
  setup('organizer', { ent: { checkin_core: true, status: 'live', registration_capacity: 10 } })
  world.rpcResult.checkin_web_release_held = { status: 'released', kind: 'waitlist', is_test: false,
    attendee: { id: 'c1000000-0000-4000-8000-000000000001', first_name: 'Wes', email: 'wes@stub.test', qr_token: 'tok00000000000000000000000000009', qr_email_sent_at: null } }
  const r = await call('checkin-held', { event_id: EVENT, action: 'release', held_id: 'd1000000-0000-4000-8000-000000000001' })
  assert(r.status === 200 && r.body.released === 1 && r.body.emailed === 1, JSON.stringify(r))
  assert(world.rpcCalls.some(c => c.name === 'checkin_web_release_held'), 'rpc not called')
  assert(String(world.emails?.[0]?.to) === 'wes@stub.test', 'no email to the guest')
})
Deno.test('checkin-held: test mode releases without emailing', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'test', registration_capacity: 10 } })
  world.rpcResult.checkin_web_release_held = { status: 'released', kind: 'approval', is_test: true,
    attendee: { id: 'c1000000-0000-4000-8000-000000000002', first_name: 'Ada', email: 'ada@stub.test', qr_token: 'tok00000000000000000000000000008', qr_email_sent_at: null } }
  const r = await call('checkin-held', { event_id: EVENT, action: 'release', held_id: 'd1000000-0000-4000-8000-000000000002' })
  assert(r.status === 200 && r.body.released === 1 && r.body.emailed === 0 && !(world.emails?.length), JSON.stringify(r))
})
Deno.test('checkin-held: a bad held id or action is a 400', async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live' } })
  assert((await call('checkin-held', { event_id: EVENT, action: 'release', held_id: 'nope' })).status === 400, 'held id')
  assert((await call('checkin-held', { event_id: EVENT, action: 'promote' })).status === 400, 'action')
})

// ── Paid tickets (109) ──────────────────────────────────────────────
const TK = 'checkin-tickets'
const ORDER = 'e1000000-0000-4000-8000-000000000001'
const paidOrder = (over: Row = {}): Row => ({
  id: ORDER, event_id: EVENT, ticket_name: 'Standard', first_name: 'Pia', last_name: 'Payer', email: 'pia@stub.test',
  amount_cents: 4900, currency: 'eur', fee_cents: 0, stripe_account_id: 'acct_owner123', checkout_session_id: 'cs_test_1',
  payment_intent: 'pi_1', status: 'paid', expires_at: '2099-01-01T00:00:00Z', attendee_id: null, ...over,
})

const OWNER_ALLOWED: Who[] = ['owner']
for (const who of WHO) {
  const allow = OWNER_ALLOWED.includes(who)
  Deno.test(`${TK} refund: ${who} is ${allow ? 'allowed' : 'refused'}`, async () => {
    setup(who, { ent: { checkin_core: true, status: 'live' } })
    const r = await call(TK, { event_id: EVENT, action: 'refund', order_id: ORDER })
    if (allow) assert(r.status === 404, `${who}: ${r.status} ${JSON.stringify(r.body)}`)  // no such order
    else assert(r.status === 403 && r.body.code === 'not_owner', `${who}: ${r.status} ${JSON.stringify(r.body)}`)
    assert(!(world.stripe?.length), 'stripe was called')
  })
  Deno.test(`${TK} payout_connect: ${who} is ${allow ? 'allowed' : 'refused'}`, async () => {
    setup(who, { ent: { checkin_core: true, status: 'test' } })
    const r = await call(TK, { event_id: EVENT, action: 'payout_connect' })
    if (allow) assert(r.status === 200 && String(r.body.url).startsWith('https://connect.stripe.com/'), `${who}: ${r.status} ${JSON.stringify(r.body)}`)
    else assert(r.status === 403 && !(world.stripe?.length), `${who}: ${r.status} ${JSON.stringify(r.body)}`)
  })
}
Deno.test(`${TK} payout_connect: the account is created once and recorded for the owner`, async () => {
  setup('owner', { ent: { checkin_core: true, status: 'test' } })
  const r = await call(TK, { event_id: EVENT, action: 'payout_connect' })
  assert(r.status === 200, JSON.stringify(r))
  const rows = world.tables.leod_checkin_payout_accounts ?? []
  assert(rows.length === 1 && rows[0].user_id === USER && rows[0].stripe_account_id === 'acct_test123456', JSON.stringify(rows))
  assert(world.stripe!.some(c => c.path === '/v1/accounts' && c.body.includes('type=standard')), 'not a standard account')
  // Second time: the stored account, no new one.
  world.stripe = []
  const r2 = await call(TK, { event_id: EVENT, action: 'payout_connect' })
  assert(r2.status === 200 && !world.stripe.some(c => c.path === '/v1/accounts'), JSON.stringify(world.stripe))
})
Deno.test(`${TK} payout_status: an unfinished account is refreshed from Stripe`, async () => {
  setup('organizer', { ent: { checkin_core: true, status: 'test' } })
  world.tables.leod_checkin_payout_accounts = [{ user_id: OTHER, stripe_account_id: 'acct_owner123', charges_enabled: false, details_submitted: false }]
  const r = await call(TK, { event_id: EVENT, action: 'payout_status' })
  assert(r.status === 200 && r.body.charges_enabled === true, JSON.stringify(r))
  assert(world.tables.leod_checkin_payout_accounts[0].charges_enabled === true, 'not stored')
})
Deno.test(`${TK} refund: refunds on the owner's account, returns the fee, records it`, async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live' } })
  world.tables.leod_checkin_web_orders = [paidOrder()]
  world.tables.leod_checkin_payout_accounts = [{ user_id: USER, stripe_account_id: 'acct_owner123', charges_enabled: true, details_submitted: true }]
  world.rpcResult.checkin_web_order_refunded = { status: 'refunded', removed: true }
  const r = await call(TK, { event_id: EVENT, action: 'refund', order_id: ORDER })
  assert(r.status === 200 && r.body.removed === true, JSON.stringify(r))
  const c = world.stripe!.find(x => x.path === '/v1/refunds')!
  assert(c && c.account === 'acct_owner123' && c.body.includes('refund_application_fee=true') && c.body.includes('payment_intent=pi_1'), JSON.stringify(c))
  assert(world.rpcCalls.some(x => x.name === 'checkin_web_order_refunded'), 'not recorded')
})
Deno.test(`${TK} refund: an unpaid order is refused without calling Stripe`, async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live' } })
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open' })]
  const r = await call(TK, { event_id: EVENT, action: 'refund', order_id: ORDER })
  assert(r.status === 409 && !(world.stripe?.length), JSON.stringify(r))
})
Deno.test(`${TK} refund: another event's order is not found`, async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live' } })
  world.tables.leod_checkin_web_orders = [paidOrder({ event_id: '99999999-9999-4999-8999-999999999999' })]
  const r = await call(TK, { event_id: EVENT, action: 'refund', order_id: ORDER })
  assert(r.status === 404 && !(world.stripe?.length), JSON.stringify(r))
})

// The sweep
const SW = 'checkin-orders-sweep'
Deno.test(`${SW}: refuses without the cron secret`, async () => {
  setup('none'); world.rpcResult.checkin_orders_cron_ok = false
  const r = await call(SW, {})
  assert(r.status === 401 && !(world.tables.leod_checkin_job_runs?.length), JSON.stringify(r))
})
Deno.test(`${SW}: a paid session lists the guest and sends their QR`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [paidOrder({ status: 'open', payment_intent: null, expires_at: new Date(Date.now() + 600000).toISOString() })]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid', payment_intent: 'pi_9', metadata: { cuedeck_order_id: ORDER } }
  world.rpcResult.checkin_web_order_paid = { status: 'paid', first: true, attendee: { id: ATT, first_name: 'Pia', email: 'pia@stub.test', qr_token: 'tok00000000000000000000000000007', qr_email_sent_at: null } }
  const r = await call(SW, {})
  assert(r.status === 200 && String(r.body.detail).startsWith('paid 1'), JSON.stringify(r))
  const paid = world.rpcCalls.find(c => c.name === 'checkin_web_order_paid')!
  assert(paid && paid.args.p_payment_intent === 'pi_9', JSON.stringify(world.rpcCalls))
  assert(world.stripe![0].account === 'acct_owner123', 'not asked on the owner account')
  assert(String(world.emails?.[0]?.to) === 'pia@stub.test', 'no QR email')
  assert(world.tables.leod_checkin_job_runs?.[0]?.status === 'ok', 'run not closed ok')
})
Deno.test(`${SW}: an expired hold is ended, an early cancel keeps its place`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [
    paidOrder({ id: ORDER, status: 'open', expires_at: new Date(Date.now() - 60000).toISOString() }),
    paidOrder({ id: 'e1000000-0000-4000-8000-000000000002', checkout_session_id: 'cs_test_2', status: 'open', expires_at: new Date(Date.now() + 600000).toISOString() }),
  ]
  world.stripeSessions = {
    cs_test_1: { id: 'cs_test_1', object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { cuedeck_order_id: ORDER } },
    cs_test_2: { id: 'cs_test_2', object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { cuedeck_order_id: 'e1000000-0000-4000-8000-000000000002' } },
  }
  world.rpcResult.checkin_web_order_expire = 'expired'
  const r = await call(SW, {})
  assert(r.status === 200 && r.body.detail === 'paid 0, expired 1, open 1', JSON.stringify(r))
  const ex = world.rpcCalls.filter(c => c.name === 'checkin_web_order_expire')
  assert(ex.length === 1 && ex[0].args.p_order_id === ORDER, JSON.stringify(ex))
})
Deno.test(`${SW}: a Stripe failure on one order fails the run but not the others`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [
    paidOrder({ status: 'open', checkout_session_id: 'cs_missing', stripe_account_id: 'acct_gone' }),
    paidOrder({ id: 'e1000000-0000-4000-8000-000000000003', status: 'open', checkout_session_id: null, expires_at: new Date(Date.now() - 60000).toISOString() }),
  ]
  world.stripeSession = undefined
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('cs_missing')) return new Response(JSON.stringify({ error: { message: 'No such checkout.session' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    return real(i, init)
  }) as typeof fetch
  try {
    world.rpcResult.checkin_web_order_expire = 'expired'
    const r = await call(SW, {})
    assert(r.status === 500 && String(r.body.detail).includes('expired 1') && String(r.body.detail).includes(ORDER), JSON.stringify(r))
    assert(world.tables.leod_checkin_job_runs?.[0]?.status === 'failed', 'run not failed')
  } finally { globalThis.fetch = real }
})

// The guest's link, for a paid ticket
const RG = 'checkin-register'
async function guest(body: Row): Promise<{ status: number; body: Row }> {
  const res = await handlers[RG](new Request('http://stub.local/functions/v1/' + RG, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  }))
  return { status: res.status, body: await res.json() }
}
const LINK_TOKEN = 'A'.repeat(43)
function regSetup() {
  setup('none', { ent: { checkin_core: true, status: 'live', registration_enabled: true, registration_code: 'VTQBZ3ENFV' } })
  world.rpcResult.checkin_web_token_rate_check = true
}
Deno.test(`${RG} confirm: a paid ticket opens Checkout on the owner's account`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'payment_required', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open', checkout_session_id: null, payment_intent: null, fee_cents: 122,
    expires_at: new Date(Date.now() + 35 * 60000).toISOString() })]
  const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
  assert(r.status === 200 && r.body.status === 'payment' && r.body.checkout_url === 'https://checkout.stripe.com/c/pay/cs_test_1', JSON.stringify(r))
  assert(r.body.amount === '€49.00', 'amount ' + r.body.amount)
  const c = world.stripe!.find(x => x.path === '/v1/checkout/sessions')!
  assert(c.account === 'acct_owner123', 'wrong account ' + c.account)
  const b = decodeURIComponent(c.body)
  assert(b.includes('payment_intent_data[application_fee_amount]=122') && b.includes('unit_amount]=4900') && b.includes('/r/VTQBZ3ENFV?paid=1'), b)
  assert(b.includes('payment_method_types[0]=card'), 'not card only')
  // The session ends a minute before the hold.
  const exp = Number(/expires_at=(\d+)/.exec(b)![1])
  assert(exp === Math.floor(Date.parse(String(world.tables.leod_checkin_web_orders[0].expires_at)) / 1000) - 60, 'expiry ' + exp)
  assert(world.tables.leod_checkin_web_orders[0].checkout_session_id === 'cs_test_1', 'session not recorded')
})
Deno.test(`${RG} confirm: back from Stripe, a paid order shows the ticket`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'order', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open', payment_intent: null, expires_at: new Date(Date.now() + 600000).toISOString() })]
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, first_name: 'Pia', last_name: 'Payer', ticket_type: 'Standard', qr_token: 'tok00000000000000000000000000007' }]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid', payment_intent: 'pi_9', metadata: { cuedeck_order_id: ORDER } }
  world.rpcResult.checkin_web_order_paid = { status: 'paid', first: true, attendee: { id: ATT, first_name: 'Pia', email: 'pia@stub.test', qr_token: 'tok00000000000000000000000000007', qr_email_sent_at: null } }
  const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
  assert(r.status === 200 && r.body.status === 'registered' && (r.body.ticket as Row)?.ticket_type === 'Standard', JSON.stringify(r))
  assert(String(world.emails?.[0]?.to) === 'pia@stub.test', 'no QR email')
})
Deno.test(`${RG} confirm: an expired payment starts a new hold and a new session`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'order', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open', payment_intent: null, expires_at: new Date(Date.now() + 60000).toISOString() })]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { cuedeck_order_id: ORDER } }
  world.rpcResult.checkin_web_order_expire = 'expired'
  world.rpcResult.checkin_web_order_reopen = 'open'
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('/rpc/checkin_web_order_reopen')) world.tables.leod_checkin_web_orders[0].expires_at = new Date(Date.now() + 35 * 60000).toISOString()
    return real(i, init)
  }) as typeof fetch
  let r
  try { r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN }) } finally { globalThis.fetch = real }
  assert(r.status === 200 && r.body.status === 'payment', JSON.stringify(r))
  const names = world.rpcCalls.map(c => c.name)
  assert(names.indexOf('checkin_web_order_expire') < names.indexOf('checkin_web_order_reopen'), names.join(','))
  assert(world.stripe!.some(x => x.method === 'POST' && x.path === '/v1/checkout/sessions'), 'no new session')
})
Deno.test(`${RG} confirm: an expired payment with no place left says full`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'order', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'expired', checkout_session_id: null, payment_intent: null })]
  world.rpcResult.checkin_web_order_expire = null
  world.rpcResult.checkin_web_order_reopen = 'full'
  const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
  assert(r.status === 200 && r.body.status === 'full' && !(world.stripe?.length), JSON.stringify(r))
})

Deno.test(`${SW}: a paid session made for another order is never taken as payment`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [paidOrder({ status: 'open', payment_intent: null })]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid', payment_intent: 'pi_x', metadata: { cuedeck_order_id: 'e1000000-0000-4000-8000-0000000000ff' } }
  const r = await call(SW, {})
  assert(r.status === 500 && String(r.body.detail).includes('does not belong'), JSON.stringify(r))
  assert(!world.rpcCalls.some(c => c.name === 'checkin_web_order_paid'), 'marked paid')
})
Deno.test(`${SW}: the second settle of a paid order sends no second QR email`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [paidOrder({ status: 'open', payment_intent: null })]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid', payment_intent: 'pi_9', metadata: { cuedeck_order_id: ORDER } }
  world.rpcResult.checkin_web_order_paid = { status: 'paid', first: false, attendee: { id: ATT, first_name: 'Pia', email: 'pia@stub.test', qr_token: 'tok00000000000000000000000000007', qr_email_sent_at: null } }
  const r = await call(SW, {})
  assert(r.status === 200 && !(world.emails?.length), JSON.stringify(r) + ' emails ' + world.emails?.length)
})

Deno.test(`${TK} refund: a ticket paid to a previous owner's account is not refunded from here`, async () => {
  setup('owner', { ent: { checkin_core: true, status: 'live' } })
  world.tables.leod_checkin_web_orders = [paidOrder({ stripe_account_id: 'acct_previous1' })]
  world.tables.leod_checkin_payout_accounts = [{ user_id: USER, stripe_account_id: 'acct_owner123', charges_enabled: true }]
  const r = await call(TK, { event_id: EVENT, action: 'refund', order_id: ORDER })
  assert(r.status === 409 && r.body.code === 'other_account' && !(world.stripe?.length), JSON.stringify(r))
})
Deno.test(`${RG} confirm: a completed but unpaid session says processing and is never reopened`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'order', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open', payment_intent: null, expires_at: new Date(Date.now() - 60000).toISOString() })]
  world.stripeSession = { id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'unpaid', metadata: { cuedeck_order_id: ORDER } }
  const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
  assert(r.status === 200 && r.body.status === 'processing', JSON.stringify(r))
  assert(!world.rpcCalls.some(c => c.name === 'checkin_web_order_expire' || c.name === 'checkin_web_order_reopen'), 'expired a pending payment')
})
Deno.test(`${RG} confirm: too little hold left for a session starts a fresh hold first`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'order', order_id: ORDER }
  world.tables.leod_checkin_web_orders = [paidOrder({ status: 'open', checkout_session_id: null, payment_intent: null, expires_at: new Date(Date.now() + 10 * 60000).toISOString() })]
  world.rpcResult.checkin_web_order_expire = 'expired'
  world.rpcResult.checkin_web_order_reopen = 'open'
  // The reopen moves the hold; the stub table plays that part.
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('/rpc/checkin_web_order_reopen')) world.tables.leod_checkin_web_orders[0].expires_at = new Date(Date.now() + 35 * 60000).toISOString()
    return real(i, init)
  }) as typeof fetch
  try {
    const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
    assert(r.status === 200 && r.body.status === 'payment', JSON.stringify(r))
    assert(world.rpcCalls.some(c => c.name === 'checkin_web_order_reopen'), 'hold not refreshed')
  } finally { globalThis.fetch = real }
})
Deno.test(`${SW}: an order Stripe will not answer for is released an hour after its hold`, async () => {
  setup('none')
  world.rpcResult.checkin_orders_cron_ok = true
  world.rpcResult.checkin_web_orders_due = [paidOrder({ status: 'open', checkout_session_id: 'cs_missing', expires_at: new Date(Date.now() - 2 * 3600e3).toISOString() })]
  world.rpcResult.checkin_web_order_expire = 'expired'
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('cs_missing')) return new Response(JSON.stringify({ error: { message: 'account revoked' } }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    return real(i, init)
  }) as typeof fetch
  try {
    const r = await call(SW, {})
    assert(String(r.body.detail).includes('expired 1'), JSON.stringify(r))
    assert(world.rpcCalls.some(c => c.name === 'checkin_web_order_expire'), 'not released')
  } finally { globalThis.fetch = real }
})

// ── Reminder emails (110) ───────────────────────────────────────────
const RM = 'checkin-reminders'
function remSetup() {
  setup('none', { ent: { checkin_core: true, status: 'live', registration_address: 'Main St 1', reminder_message: 'Bring <b>ID</b>',
    thankyou_message: 'Thanks!', thankyou_link: 'https://example.com/slides' } })
  world.tables.leod_events[0].event_start = '09:00:00'
  world.rpcResult.checkin_reminders_cron_ok = true
}
Deno.test(`${RM}: refuses the cron without the secret`, async () => {
  remSetup(); world.rpcResult.checkin_reminders_cron_ok = false
  const r = await call(RM, {})
  assert(r.status === 401 && !(world.emails?.length), JSON.stringify(r))
})
Deno.test(`${RM}: sends each claimed guest their email, escaped, with the QR`, async () => {
  remSetup()
  world.rpcResult.checkin_claim_reminders = [
    { attendee_id: ATT, kind: 'reminder', event_id: EVENT, first_name: 'Ann<i>', email: 'ann@stub.test', qr_token: 'tok00000000000000000000000000001' },
    { attendee_id: 'b2000000-0000-4000-8000-000000000002', kind: 'thankyou', event_id: EVENT, first_name: 'Ben', email: 'ben@stub.test', qr_token: 'tok2' },
  ]
  const r = await call(RM, {})
  assert(r.status === 200 && r.body.detail === 'reminders 1, thank-yous 1', JSON.stringify(r))
  const [rem, thx] = world.emails as { to: string; subject: string; html: string }[]
  assert(rem.to === 'ann@stub.test' && rem.subject.startsWith('Reminder: Stub event'), rem.subject)
  assert(rem.html.includes('Ann&lt;i&gt;') && rem.html.includes('Bring &lt;b&gt;ID&lt;/b&gt;') && rem.html.includes('data:image/gif;base64') && rem.html.includes('doors open 09:00'), 'reminder body')
  assert(rem.html.includes('query=Hall%2C%20Main%20St%201'), 'maps link')
  assert(thx.to === 'ben@stub.test' && thx.html.includes('href="https://example.com/slides"'), 'thank-you body')
  assert(world.tables.leod_checkin_job_runs?.[0]?.status === 'ok', 'run not ok')
})
Deno.test(`${RM}: a failed send gives the claim back and fails the run`, async () => {
  remSetup()
  world.rpcResult.checkin_claim_reminders = [{ attendee_id: ATT, kind: 'reminder', event_id: EVENT, first_name: 'Ann', email: 'ann@stub.test', qr_token: 'tok1' }]
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('api.resend.com')) return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    return real(i, init)
  }) as typeof fetch
  try {
    const r = await call(RM, {})
    assert(r.status === 500, JSON.stringify(r))
    const un = world.rpcCalls.find(c => c.name === 'checkin_unclaim_reminder')
    assert(un && un.args.p_attendee_id === ATT && un.args.p_kind === 'reminder', JSON.stringify(world.rpcCalls))
    assert(world.tables.leod_checkin_job_runs?.[0]?.status === 'failed', 'run not failed')
  } finally { globalThis.fetch = real }
})
Deno.test(`${RM} test: goes only to the organizer, marked as a test`, async () => {
  remSetup()
  const r = await call(RM, { event_id: EVENT, action: 'test', kind: 'thankyou' })
  assert(r.status === 403, 'none role should be refused: ' + JSON.stringify(r))
  setup('organizer', { ent: { checkin_core: true, status: 'test', thankyou_link: 'https://example.com/x' } })
  const r2 = await call(RM, { event_id: EVENT, action: 'test', kind: 'thankyou' })
  assert(r2.status === 200 && r2.body.to === 'desk@stub.test', JSON.stringify(r2))
  const m = world.emails![0] as { to: string; subject: string }
  assert(m.to === 'desk@stub.test' && m.subject === '[Test] Thank you for coming to Stub event', m.subject)
})

// ── Plus-ones (114) ─────────────────────────────────────────────────
Deno.test(`${RG} confirm: each plus-one's ticket is emailed to the guest who brought them`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'registered', first_name: 'Maya',
    attendee: { id: ATT, first_name: 'Maya', email: 'maya@stub.test', qr_token: 'tok00000000000000000000000000001', qr_email_sent_at: null },
    plus_ones: [{ id: 'p1000000-0000-4000-8000-000000000001', first_name: 'Ola', last_name: 'Nowak', qr_token: 'tok00000000000000000000000000002' }] }
  world.tables.leod_checkin_attendees = [
    { id: ATT, event_id: EVENT, first_name: 'Maya', last_name: 'L', ticket_type: 'attendee', qr_token: 'tok00000000000000000000000000001' },
    { id: 'p1000000-0000-4000-8000-000000000001', event_id: EVENT, first_name: 'Ola', last_name: 'Nowak', ticket_type: 'attendee', qr_token: 'tok00000000000000000000000000002' }]
  const r = await guest({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN })
  assert(r.status === 200 && (r.body.plus_tickets as unknown[]).length === 1, JSON.stringify(r).slice(0, 300))
  const mails = world.emails as { to: string; subject: string; html: string }[]
  assert(mails.length === 2 && mails.every(m => m.to === 'maya@stub.test'), JSON.stringify(mails.map(m => [m.to, m.subject])))
  assert(mails[1].subject === 'Ticket for Ola: Stub event' && mails[1].html.includes('coming with you'), mails[1].subject)
})
Deno.test('checkin-held fill: runs the locked database fill and emails whoever it released', async () => {
  setup('organizer', { ent: { checkin_core: true, status: 'live', registration_capacity: 10 } })
  world.rpcResult.checkin_web_waitlist_fill = [{ status: 'released', is_test: false,
    attendee: { id: ATT, first_name: 'Wes', email: 'wes@stub.test', qr_token: 'tok00000000000000000000000000009', qr_email_sent_at: null },
    plus_ones: [{ id: 'p3000000-0000-4000-8000-000000000001', first_name: 'Ola', qr_token: 'tok00000000000000000000000000008' }] }]
  const r = await call('checkin-held', { event_id: EVENT, action: 'fill' })
  assert(r.status === 200 && r.body.released === 1 && r.body.emailed === 1, JSON.stringify(r))
  assert(world.rpcCalls.some(c => c.name === 'checkin_web_waitlist_fill' && c.args.p_event_id === EVENT), 'fill rpc not called')
  assert((world.emails ?? []).length === 2, 'guest and plus-one tickets: ' + world.emails?.length)
})

// ── Invitations (116) ───────────────────────────────────────────────
const IG = 'checkin-invite-guests'
function invSetup(status = 'live') {
  setup('organizer', { ent: { checkin_core: true, status, registration_enabled: true, registration_code: 'VTQBZ3ENFV' } })
  world.tables.leod_checkin_attendees = [
    { id: 'i1000000-0000-4000-8000-000000000001', event_id: EVENT, source: 'import', is_test: false, email: 'gina@stub.test' },
    { id: 'i1000000-0000-4000-8000-000000000002', event_id: EVENT, source: 'import', is_test: false, email: 'hal@stub.test' }]
  world.tables.leod_checkin_web_invites = [{ attendee_id: 'i1000000-0000-4000-8000-000000000002', event_id: EVENT }]
  world.rpcResult.checkin_web_invite_issue = { status: 'issued', first_name: 'Gina', email: 'gina@stub.test' }
}
Deno.test(`${IG} send: invites only guests not yet invited, with a personal link in the fragment`, async () => {
  invSetup()
  const r = await call(IG, { event_id: EVENT, action: 'send' })
  assert(r.status === 200 && r.body.sent === 1 && r.body.remaining === 0, JSON.stringify(r))
  const issued = world.rpcCalls.filter(c => c.name === 'checkin_web_invite_issue')
  assert(issued.length === 1 && issued[0].args.p_attendee_id === 'i1000000-0000-4000-8000-000000000001' && /^[0-9a-f]{64}$/.test(String(issued[0].args.p_token_hash)), JSON.stringify(issued))
  const m = world.emails![0] as { to: string; subject: string; html: string }
  assert(m.to === 'gina@stub.test' && m.subject === 'You are invited: Stub event' && /\/r\/VTQBZ3ENFV#i=[A-Za-z0-9_-]{43}"/.test(m.html), m.subject)
})
Deno.test(`${IG} send: refused in test mode, before any email`, async () => {
  invSetup('test')
  const r = await call(IG, { event_id: EVENT, action: 'send' })
  assert(r.status === 409 && r.body.code === 'test_mode' && !(world.emails?.length), JSON.stringify(r))
})
Deno.test(`${IG} send: a failed email takes the invitation back`, async () => {
  invSetup()
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('api.resend.com')) return new Response(JSON.stringify({ message: 'down' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    return real(i, init)
  }) as typeof fetch
  try {
    const r = await call(IG, { event_id: EVENT, action: 'send' })
    assert(r.body.failed === 1 && world.rpcCalls.some(c => c.name === 'checkin_web_invite_unissue'), JSON.stringify(r))
  } finally { globalThis.fetch = real }
})
Deno.test(`${RG} rsvp: going emails the ticket and the plus-ones' tickets to the guest`, async () => {
  regSetup()
  world.tables.leod_checkin_entitlements[0].registration_plus_ones = 2
  world.rpcResult.checkin_web_rsvp = { status: 'going', first_name: 'Gina',
    attendee: { id: ATT, first_name: 'Gina', email: 'gina@stub.test', qr_token: 'tok00000000000000000000000000001', qr_email_sent_at: null },
    plus_ones: [{ id: 'p2000000-0000-4000-8000-000000000001', first_name: 'Ola', last_name: 'N', qr_token: 'tok00000000000000000000000000002' }] }
  world.tables.leod_checkin_attendees = [
    { id: ATT, event_id: EVENT, first_name: 'Gina', last_name: 'G', ticket_type: 'attendee', qr_token: 'tok00000000000000000000000000001' },
    { id: 'p2000000-0000-4000-8000-000000000001', event_id: EVENT, first_name: 'Ola', last_name: 'N', ticket_type: 'attendee', qr_token: 'tok00000000000000000000000000002' }]
  const r = await guest({ action: 'rsvp', code: 'VTQBZ3ENFV', token: LINK_TOKEN, going: true, plus_ones: [{ first_name: 'Ola', last_name: 'N' }] })
  assert(r.status === 200 && r.body.status === 'going' && (r.body.plus_tickets as unknown[]).length === 1, JSON.stringify(r).slice(0, 300))
  assert((world.emails ?? []).length === 2, 'emails ' + world.emails?.length)
  const call1 = world.rpcCalls.find(c => c.name === 'checkin_web_rsvp')!
  assert(call1.args.p_going === true && JSON.stringify(call1.args.p_plus_ones) === '[{"first_name":"Ola","last_name":"N"}]', JSON.stringify(call1.args))
})
Deno.test(`${RG} rsvp: a plus-one with a link for a name is refused before the database`, async () => {
  regSetup()
  world.tables.leod_checkin_entitlements[0].registration_plus_ones = 2
  const r = await guest({ action: 'rsvp', code: 'VTQBZ3ENFV', token: LINK_TOKEN, going: true, plus_ones: [{ first_name: 'evil.com', last_name: 'X' }] })
  assert(r.status === 400 && !world.rpcCalls.some(c => c.name === 'checkin_web_rsvp'), JSON.stringify(r))
})

Deno.test(`${IG} limits: a resend too soon is refused with a reason; the daily cap stops a batch`, async () => {
  invSetup()
  world.rpcResult.checkin_web_invite_issue = { status: 'too_soon' }
  const r = await call(IG, { event_id: EVENT, action: 'resend', attendee_ids: ['e2000000-0000-4000-8000-000000000001'] })
  assert(r.status === 429 && r.body.code === 'too_soon' && !(world.emails?.length), JSON.stringify(r))
  invSetup()
  world.rpcResult.checkin_web_invite_issue = { status: 'daily_cap' }
  const r2 = await call(IG, { event_id: EVENT, action: 'send' })
  assert(r2.status === 200 && r2.body.capped === true && r2.body.remaining === 0 && !(world.emails?.length), JSON.stringify(r2))
})

// ── Guest emails in the guest's language (123) ─────────────────────
Deno.test(`${RG} confirm: the ticket email comes in the guest's language`, async () => {
  regSetup()
  world.rpcResult.checkin_web_confirm = { status: 'registered', first_name: 'Ola',
    attendee: { id: ATT, first_name: 'Ola', email: 'ola@stub.test', qr_token: 'tok00000000000000000000000000001', qr_email_sent_at: null } }
  world.rpcResult.checkin_web_langs = [{ email: 'ola@stub.test', lang: 'pl' }]
  world.tables.leod_checkin_attendees = [{ id: ATT, event_id: EVENT, first_name: 'Ola', last_name: 'N', ticket_type: 'attendee', qr_token: 'tok00000000000000000000000000001' }]
  const res = await handlers[RG](new Request('http://stub.local/functions/v1/' + RG, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ action: 'confirm', code: 'VTQBZ3ENFV', token: LINK_TOKEN, lang: 'pl' }) }))
  assert(res.status === 200, 'status ' + res.status)
  const set = world.rpcCalls.find(c => c.name === 'checkin_web_set_lang')
  assert(set && set.args.p_lang === 'pl' && set.args.p_email === 'ola@stub.test', 'language not recorded: ' + JSON.stringify(set))
  const m = world.emails![0] as { subject: string; html: string }
  assert(m.subject === 'Twój kod QR do wejścia: Stub event' && m.html.includes('lang="pl"') && m.html.includes('Cześć Ola,'), m.subject)
})
Deno.test(`${RM}: an Arabic guest gets the reminder in Arabic, right to left`, async () => {
  remSetup()
  world.rpcResult.checkin_claim_reminders = [{ attendee_id: ATT, kind: 'reminder', event_id: EVENT, first_name: 'Sara', email: 'sara@stub.test', qr_token: 'tok1' }]
  world.rpcResult.checkin_web_langs = [{ email: 'sara@stub.test', lang: 'ar' }]
  const r = await call(RM, {})
  assert(r.status === 200, JSON.stringify(r))
  const m = world.emails![0] as { subject: string; html: string }
  assert(m.subject.startsWith('تذكير: Stub event') && m.html.includes('dir="rtl"') && m.html.includes('نراك قريبًا'), m.subject)
})
Deno.test(`${RM}: a failed language lookup still sends, in English`, async () => {
  remSetup()
  world.rpcResult.checkin_claim_reminders = [{ attendee_id: ATT, kind: 'thankyou', event_id: EVENT, first_name: 'Sam', email: 'sam@stub.test', qr_token: 'tok1' }]
  const r = await call(RM, {})
  const m = world.emails![0] as { subject: string }
  assert(r.status === 200 && m.subject === 'Thank you for coming to Stub event', m.subject)
})

Deno.test(`${RG} register: the language of a form is not stored for an address nobody has confirmed`, async () => {
  regSetup()
  Deno.env.set('TURNSTILE_SECRET_KEY', 'ts-secret')
  world.tables.leod_checkin_entitlements[0].registration_questions = []
  world.rpcResult.checkin_web_rate_check = true
  world.rpcResult.checkin_web_request = { status: 'pending', send: true, event_id: EVENT }
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).includes('challenges.cloudflare.com')) return new Response(JSON.stringify({ success: true, hostname: 'app.cuedeck.io', action: 'register' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return real(i, init)
  }) as typeof fetch
  try {
    const res = await handlers[RG](new Request('http://stub.local/functions/v1/' + RG, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ action: 'register', code: 'VTQBZ3ENFV', lang: 'ar', first_name: 'Vic', last_name: 'Tim', email: 'victim@stub.test',
        company: '', answers: {}, consent: true, turnstile_token: 'tok', website: '' }) }))
    const body = await res.json()
    assert(res.status === 200 && body.status === 'check_email', JSON.stringify(body))
    assert(!world.rpcCalls.some(c => c.name === 'checkin_web_set_lang'), 'stored a language for an unconfirmed address')
    const m = (world.emails ?? [])[0] as { subject: string } | undefined
    assert(m && m.subject === 'أكّد تسجيلك', 'the confirmation itself still in the form language: ' + m?.subject)
  } finally { globalThis.fetch = real; Deno.env.delete('TURNSTILE_SECRET_KEY') }
})

Deno.test('checkin-held auto: refuses without the cron secret', async () => {
  setup('none'); world.rpcResult.checkin_waitlist_cron_ok = false
  const r = await call('checkin-held', { action: 'auto' })
  assert(r.status === 401 && !(world.tables.leod_checkin_job_runs?.length), JSON.stringify(r))
})
Deno.test('checkin-held auto: moves each due event and records the run', async () => {
  setup('none', { ent: { checkin_core: true, status: 'live', registration_capacity: 10 } })
  world.rpcResult.checkin_waitlist_cron_ok = true
  world.rpcResult.checkin_web_waitlist_due = [{ event_id: EVENT }]
  world.rpcResult.checkin_web_waitlist_fill = [{ status: 'released', is_test: false,
    attendee: { id: ATT, first_name: 'Wes', email: 'wes@stub.test', qr_token: 'tok00000000000000000000000000009', qr_email_sent_at: null }, plus_ones: [] }]
  const r = await call('checkin-held', { action: 'auto' })
  assert(r.status === 200 && r.body.detail === 'released 1', JSON.stringify(r))
  assert(String(world.emails?.[0]?.to) === 'wes@stub.test', 'ticket not emailed')
  assert(world.tables.leod_checkin_job_runs?.[0]?.status === 'ok', 'run not ok')
})

// ── Webhooks (126) ──────────────────────────────────────────────────
import { isPrivateIp } from '../../supabase/functions/_shared/net-guard.ts'
const WH = 'checkin-webhooks'
Deno.test('webhooks: private, loopback, link-local and metadata addresses are refused', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.5', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert(isPrivateIp(ip), ip + ' should be private')
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111']) assert(!isPrivateIp(ip), ip + ' should be public')
})
function whSetup(resolveTo: string[]) {
  setup('none')
  world.rpcResult.checkin_webhooks_cron_ok = true
  world.rpcResult.checkin_webhook_result = 'sent'
  world.rpcResult.checkin_webhooks_due = [{ id: 7, topic: 'guest.created', payload: { topic: 'guest.created', data: { first_name: 'Ana' } },
    url: 'https://hooks.example.com/in', secret: 'whsec_test' }]
  ;(Deno as unknown as { resolveDns: unknown }).resolveDns = async (_h: string, t: string) => (t === 'A' ? resolveTo : [])
}
Deno.test(`${WH}: a delivery is signed and its result recorded`, async () => {
  whSetup(['93.184.216.34'])
  let got: { headers: Headers; body: string } | null = null
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).startsWith('https://hooks.example.com')) {
      got = { headers: new Headers(init?.headers), body: String(init?.body) }
      return new Response('ok', { status: 200 })
    }
    return real(i, init)
  }) as typeof fetch
  try {
    const r = await call(WH, {})
    assert(r.status === 200 && String(r.body.detail).startsWith('sent 1'), JSON.stringify(r))
    const sig = got!.headers.get('X-CueDeck-Signature')!
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const want = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t + '.' + got!.body)))).map(b => b.toString(16).padStart(2, '0')).join('')
    assert(v1 === want, 'signature does not verify')
    assert(got!.headers.get('X-CueDeck-Event') === 'guest.created', 'event header')
    const res = world.rpcCalls.find(c => c.name === 'checkin_webhook_result')!
    assert(res.args.p_ok === true && res.args.p_id === 7, JSON.stringify(res.args))
  } finally { globalThis.fetch = real }
})
Deno.test(`${WH}: a name resolving to a private address is never called`, async () => {
  whSetup(['10.1.2.3'])
  let called = false
  const real = globalThis.fetch
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    if (String(i instanceof Request ? i.url : i).startsWith('https://hooks.example.com')) { called = true; return new Response('ok') }
    return real(i, init)
  }) as typeof fetch
  try {
    await call(WH, {})
    assert(!called, 'called a private address')
    const res = world.rpcCalls.find(c => c.name === 'checkin_webhook_result')!
    assert(res.args.p_ok === false && String(res.args.p_detail).includes('private'), JSON.stringify(res.args))
  } finally { globalThis.fetch = real }
})
