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
Deno.env.delete('CHECKIN_PRICE_ID') // env var, not a supabase-js write

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const DESK = '44444444-4444-4444-8444-444444444444'
const ATT = '55555555-5555-4555-8555-555555555555'

type Row = Record<string, unknown>
type World = {
  tables: Record<string, Row[]>
  failTable?: string
  rpcCalls: { name: string; args: Row }[]
  rpcResult: Record<string, unknown>
}
let world: World

function eqFilters(url: URL): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) out.push([k, v.slice(3)])
  }
  return out
}
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers)
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })

  if (url.pathname === '/auth/v1/user') {
    return reply(200, { id: USER, email: 'desk@stub.test', email_confirmed_at: '2026-01-01T00:00:00Z', aud: 'authenticated' })
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
  const match = (r: Row) => eqFilters(url).every(([k, v]) => String(r[k]) === v)

  if (method === 'GET' || method === 'HEAD') {
    const hit = rows.filter(match)
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
    return reply(201, (headers.get('Prefer') ?? '').includes('return=representation') ? list : undefined)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(init?.body ?? '{}'))
    rows.filter(match).forEach(r => Object.assign(r, patch))
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
for (const fn of ['checkin-create-checkout', 'checkin-enable-event', 'checkin-import-attendees', 'checkin-send-qr-emails', 'checkin-kiosk-pair', 'checkin-record-scans']) {
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
}
const BODY: Record<string, Row> = {
  'checkin-create-checkout': { event_id: EVENT },
  'checkin-import-attendees': { event_id: EVENT, rows: [{ first_name: 'A', last_name: 'B' }], dry_run: true },
  'checkin-send-qr-emails': { event_id: EVENT },
  'checkin-kiosk-pair': { action: 'mint', event_id: EVENT, label: 'Lobby' },
  'checkin-record-scans': { event_id: EVENT, items: [] },
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
for (const fn of ['checkin-import-attendees', 'checkin-send-qr-emails', 'checkin-kiosk-pair']) {
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
