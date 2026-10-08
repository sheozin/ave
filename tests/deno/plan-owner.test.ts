// tests/deno/plan-owner.test.ts
// Whose plan an AI call and a promo code use (event teams, spec 2026-10-08 §6),
// against a stubbed Supabase and a stubbed Anthropic API: AI on an event uses
// that event creator's plan; members have no plan of their own; codes apply
// to the caller's own subscription only.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/plan-owner.test.ts
// (tests/plan-owner.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('ANTHROPIC_API_KEY', 'stub-anthropic-key')   // api.anthropic.com is stubbed below

const OWNER   = '50000000-0000-4000-8000-000000000001' // Pro, creates EV
const MEMBER  = '50000000-0000-4000-8000-000000000002' // stage on EV, no plan of their own
const ORG2    = '50000000-0000-4000-8000-000000000003' // Starter, creates EV2, av on EV
const SUSP    = '50000000-0000-4000-8000-000000000004' // stage on EV, suspended
const STRANGER = '50000000-0000-4000-8000-000000000005' // Pro of their own, on no event here
const T_OWNER = '50000000-0000-4000-8000-000000000006' // trial ended, creates EV3
const T_MEMBER = '50000000-0000-4000-8000-000000000007' // director on EV3
const EV  = '60000000-0000-4000-8000-000000000001'
const EV2 = '60000000-0000-4000-8000-000000000002'
const EV3 = '60000000-0000-4000-8000-000000000003'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let anthropicCalls: number
let failOn: Record<string, { status: number; body: Row }> = {}

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    // eq never matches NULL (as in SQL); is.null does
    if (v.startsWith('eq.')) tests.push(r => r[k] !== null && r[k] !== undefined && String(r[k]) === v.slice(3))
    if (v === 'is.null') tests.push(r => r[k] === null || r[k] === undefined)
  }
  return (r: Row) => tests.every(fn => fn(r))
}
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers)
  const rawBody = init?.body ?? (req ? await req.clone().text() : undefined)
  if (url.host === 'api.anthropic.com') {
    anthropicCalls++
    return reply(200, { content: [{ type: 'text', text: 'stub answer' }] })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  if (failOn[`${method} ${url.pathname}`]) return reply(failOn[`${method} ${url.pathname}`].status, failOn[`${method} ${url.pathname}`].body)
  if (url.pathname === '/auth/v1/user') {
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  if (method === 'GET') {
    let hit = rows.filter(match)
    const limit = url.searchParams.get('limit')
    if (limit) hit = hit.slice(0, Number(limit))
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (hit.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      return reply(200, hit[0])
    }
    return reply(200, hit)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(rawBody ?? '{}'))
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, patch))
    return (headers.get('Prefer') ?? '').includes('return=representation') ? reply(200, hit) : reply(204, undefined)
  }
  return reply(405, { message: 'stub: method' })
}) as typeof fetch

const handlers: Record<string, (req: Request) => Promise<Response>> = {}
let captured: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', {
  configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { captured = h; return { finished: Promise.resolve(), shutdown: async () => {} } },
})
for (const fn of ['ai-proxy', 'redeem-code']) {
  captured = null
  await import(`${FN_DIR}${fn}/index.ts`)
  if (!captured) throw new Error('no handler captured for ' + fn)
  handlers[fn] = captured
}

async function call(fn: string, as: string, body: Row): Promise<{ status: number; body: Row }> {
  const res = await handlers[fn](new Request('http://stub.local/functions/v1/' + fn, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + as, 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io' },
    body: JSON.stringify(body),
  }))
  const text = await res.text()
  let parsed: Row = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text } }
  return { status: res.status, body: parsed }
}

const AI = { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
const past = new Date(Date.now() - 3600e3).toISOString()

function setup() {
  anthropicCalls = 0
  failOn = {}
  tables = {
    // MEMBER still carries the old team link (role stage, invited_by OWNER):
    // it must no longer decide anything.
    leod_users: [OWNER, MEMBER, ORG2, SUSP, STRANGER, T_OWNER, T_MEMBER].map(id =>
      id === MEMBER ? { id, role: 'stage', invited_by: OWNER, active: true } : { id, role: 'director', active: true }),
    leod_events: [
      { id: EV,  created_by: OWNER },
      { id: EV2, created_by: ORG2 },
      { id: EV3, created_by: T_OWNER },
    ],
    leod_event_members: [
      { event_id: EV,  user_id: MEMBER,   role: 'stage',    active: true },
      { event_id: EV,  user_id: ORG2,     role: 'av',       active: true },
      { event_id: EV,  user_id: SUSP,     role: 'stage',    active: false },
      { event_id: EV3, user_id: T_MEMBER, role: 'director', active: true },
    ],
    leod_subscriptions: [
      { director_id: OWNER,    plan: 'pro',     status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: ORG2,     plan: 'starter', status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: STRANGER, plan: 'pro',     status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: T_OWNER,  plan: 'trial',   status: 'active', trial_ends_at: past, created_at: '2026-10-01T00:00:00Z' },
    ],
    leod_promo_codes: [
      { code: 'EXTEND7', type: 'trial_extension', active: true, expires_at: null, max_uses: null, uses: 0, extra_days: 7 },
      { code: 'PROUNLOCK', type: 'plan_unlock', active: true, expires_at: null, max_uses: null, uses: 0, granted_plan: 'pro', granted_months: 1 },
    ],
  }
}
const sub = (id: string) => tables.leod_subscriptions.find(s => s.director_id === id)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// [label, caller, event_id or null, expected status]
const AI_CASES: [string, string, string | null, number][] = [
  ['a member uses the event owner\'s Pro plan',                 MEMBER,   EV,   200],
  ['a member has no plan of their own without an event',       MEMBER,   null, 403],
  ['another organiser\'s plan never opens this event',          STRANGER, EV,   403],
  ['another organiser still uses their own plan for their own', STRANGER, null, 200],
  ['a suspended member is refused',                             SUSP,     EV,   403],
  ['an organiser on Starter uses the Pro owner\'s plan there',  ORG2,     EV,   200],
  ['and their own Starter plan on their own event',             ORG2,     EV2,  403],
  ['a member of an event whose owner\'s trial ended',           T_MEMBER, EV3,  403],
  ['the owner whose trial ended',                               T_OWNER,  EV3,  403],
]
for (const [label, who, ev, expected] of AI_CASES) {
  Deno.test(`ai-proxy: ${label} (${expected})`, async () => {
    setup()
    const r = await call('ai-proxy', who, ev ? { ...AI, event_id: ev } : AI)
    assert(r.status === expected, `status ${r.status} ${JSON.stringify(r.body)}`)
    assert(anthropicCalls === (expected === 200 ? 1 : 0), 'anthropic calls ' + anthropicCalls)
  })
}

Deno.test('ai-proxy: an event_id that is not an id is a 400 and calls nothing', async () => {
  setup()
  const r = await call('ai-proxy', MEMBER, { ...AI, event_id: 'not-an-id' })
  assert(r.status === 400 && anthropicCalls === 0, JSON.stringify(r))
})

Deno.test("redeem-code: a member without a plan of their own cannot touch the organiser's", async () => {
  setup()
  const before = JSON.stringify(sub(OWNER))
  const r = await call('redeem-code', MEMBER, { code: 'PROUNLOCK' })
  assert(r.status === 400 && String(r.body.error).includes('No subscription'), JSON.stringify(r))
  assert(JSON.stringify(sub(OWNER)) === before, "the organiser's plan changed")
})

Deno.test('redeem-code: an organiser who is also a member redeems on their own plan only', async () => {
  setup()
  const before = JSON.stringify(sub(OWNER))
  const r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  assert(r.status === 200 && r.body.type === 'plan_unlock', JSON.stringify(r))
  assert(sub(ORG2)?.plan === 'pro' && JSON.stringify(sub(OWNER)) === before, JSON.stringify(tables.leod_subscriptions))
})

Deno.test('redeem-code: two redemptions at once cannot both pass a one-use cap', async () => {
  setup()
  const promo = tables.leod_promo_codes.find(p => p.code === 'PROUNLOCK')!
  promo.max_uses = 1
  const [a, b] = await Promise.all([
    call('redeem-code', ORG2, { code: 'PROUNLOCK' }),
    call('redeem-code', T_OWNER, { code: 'PROUNLOCK' }),
  ])
  const ok = [a, b].filter(r => r.status === 200)
  assert(ok.length === 1, 'both or neither passed: ' + JSON.stringify([a, b]))
  assert(promo.uses === 1, 'uses ' + promo.uses)
  const unlocked = [sub(ORG2), sub(T_OWNER)].filter(x => x?.plan === 'pro')
  assert(unlocked.length === 1, 'plans changed: ' + JSON.stringify(tables.leod_subscriptions))
})

Deno.test('redeem-code: a failed use count is a 500 and the plan is not changed', async () => {
  setup()
  failOn['PATCH /rest/v1/leod_promo_codes'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const before = JSON.stringify(sub(ORG2))
  const r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  assert(r.status === 500, JSON.stringify(r))
  assert(JSON.stringify(sub(ORG2)) === before, 'the plan changed')
})

Deno.test('redeem-code: a code whose use count is NULL is claimed (NULL counts as 0)', async () => {
  setup()
  const promo = tables.leod_promo_codes.find(p => p.code === 'PROUNLOCK')!
  promo.uses = null
  const r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  assert(r.status === 200 && promo.uses === 1 && sub(ORG2)?.plan === 'pro', JSON.stringify(r) + ' uses ' + promo.uses)
})

Deno.test('redeem-code: two redemptions at once of a code with no limit both succeed', async () => {
  setup()
  const promo = tables.leod_promo_codes.find(p => p.code === 'PROUNLOCK')!
  assert(promo.max_uses === null, 'fixture')
  const [a, b] = await Promise.all([
    call('redeem-code', ORG2, { code: 'PROUNLOCK' }),
    call('redeem-code', T_OWNER, { code: 'PROUNLOCK' }),
  ])
  assert(a.status === 200 && b.status === 200, JSON.stringify([a, b]))
  assert(promo.uses === 2 && sub(ORG2)?.plan === 'pro' && sub(T_OWNER)?.plan === 'pro', 'uses ' + promo.uses)
})

Deno.test('redeem-code: a failed apply gives the use back; a give-back that matches nothing is logged', async () => {
  setup()
  const promo = tables.leod_promo_codes.find(p => p.code === 'PROUNLOCK')!
  failOn['PATCH /rest/v1/leod_subscriptions'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  let r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  assert(r.status === 500 && promo.uses === 0, 'use not given back: ' + promo.uses + ' ' + JSON.stringify(r))
  // someone redeems between the claim and the give-back: the give-back
  // matches no row and says so
  setup()
  const promo2 = tables.leod_promo_codes.find(p => p.code === 'PROUNLOCK')!
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'PATCH' && url.pathname === '/rest/v1/leod_subscriptions') {
      promo2.uses = Number(promo2.uses) + 1   // another redemption lands
      return new Response(JSON.stringify({ code: 'XX000', message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    return origFetch(input, init)
  }) as typeof fetch
  const logged: string[] = []
  const origErr = console.error
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  try {
    r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  } finally {
    globalThis.fetch = origFetch
    console.error = origErr
  }
  assert(r.status === 500, JSON.stringify(r))
  assert(logged.some(l => l.includes('use not given back') && l.includes('PROUNLOCK')), 'not logged: ' + JSON.stringify(logged))
})
