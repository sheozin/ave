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
for (const fn of ['checkin-create-checkout', 'checkin-enable-event', 'checkin-import-attendees', 'checkin-send-qr-emails', 'checkin-kiosk-pair', 'checkin-record-scans', 'checkin-invite-staff', 'checkin-add-walk-in', 'checkin-scanner']) {
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
}
const BODY: Record<string, Row> = {
  'checkin-create-checkout': { event_id: EVENT },
  'checkin-import-attendees': { event_id: EVENT, rows: [{ first_name: 'A', last_name: 'B' }], dry_run: true },
  'checkin-send-qr-emails': { event_id: EVENT },
  'checkin-kiosk-pair': { action: 'mint', event_id: EVENT, label: 'Lobby' },
  'checkin-record-scans': { event_id: EVENT, items: [] },
  'checkin-add-walk-in': { event_id: EVENT, first_name: 'Ewa', last_name: 'Sample' },
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
