// tests/deno/operators.test.ts
// invite-operator and manage-operator against a stubbed Supabase. The
// stubbed invite endpoint plays the auth trigger handle_new_auth_user: it
// pre-creates a leod_users row as a self-registered director, which the
// invite then has to turn into the invited operator.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/operators.test.ts
// (tests/operators.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')

const OWNER    = '20000000-0000-4000-8000-000000000001'
const OP_DIR   = '20000000-0000-4000-8000-000000000002' // director invited by OWNER
const OP_STAGE = '20000000-0000-4000-8000-000000000003' // stage invited by OWNER
const OP_OFF   = '20000000-0000-4000-8000-000000000004' // director invited by OWNER, deactivated
const STRANGER = '20000000-0000-4000-8000-000000000005' // another tenant's owner
const THEIR_OP = '20000000-0000-4000-8000-000000000006' // invited by STRANGER
const NEW_ID   = '20000000-0000-4000-8000-0000000000aa'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let invited: { email: string; data: Row }[]
let banned: string[]
// Which id the next invite creates, and whether that auth user already had a row.
let inviteAs: { id: string; preexisting?: Row } = { id: NEW_ID }
let failOn: Record<string, { status: number; body: Row }> = {}

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) tests.push(r => String(r[k]) === v.slice(3))
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
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  const key = `${method} ${url.pathname}`
  if (failOn[key]) return reply(failOn[key].status, failOn[key].body)
  if (url.pathname === '/auth/v1/user') {
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  if (url.pathname === '/auth/v1/invite') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    invited.push({ email: b.email, data: b.data })
    // handle_new_auth_user: INSERT ... ON CONFLICT (id) DO NOTHING, role director
    const users = tables.leod_users
    if (inviteAs.preexisting) users.push({ id: inviteAs.id, email: b.email, ...inviteAs.preexisting })
    else if (!users.some(u => u.id === inviteAs.id)) {
      users.push({ id: inviteAs.id, email: b.email, role: 'director', invited_by: null, active: true, name: '' })
    }
    return reply(200, { id: inviteAs.id, email: b.email, aud: 'authenticated' })
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/)
  if (adminUser) { banned.push(adminUser[1]); return reply(200, { id: adminUser[1] }) }

  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  const wantRows = (headers.get('Prefer') ?? '').includes('return=representation')
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
  if (method === 'POST') {
    const body = JSON.parse(String(rawBody ?? '{}'))
    const list: Row[] = Array.isArray(body) ? body : [body]
    const merge = (headers.get('Prefer') ?? '').includes('resolution=merge-duplicates')
    const out: Row[] = []
    for (const r of list) {
      const existing = r.id !== undefined ? rows.find(x => x.id === r.id) : undefined
      if (existing && !merge) return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "leod_users_pkey"' })
      if (existing) { Object.assign(existing, r); out.push(existing) } else { rows.push({ ...r }); out.push(r) }
    }
    return wantRows ? reply(201, out) : reply(201, undefined)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(rawBody ?? '{}'))
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, patch))
    return wantRows ? reply(200, hit) : reply(204, undefined)
  }
  if (method === 'DELETE') {
    const hit = rows.filter(match)
    tables[table] = rows.filter(r => !hit.includes(r))
    return wantRows ? reply(200, hit) : reply(204, undefined)
  }
  return reply(405, { message: 'stub: method' })
}) as typeof fetch

const handlers: Record<string, (req: Request) => Promise<Response>> = {}
let captured: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', {
  configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { captured = h; return { finished: Promise.resolve(), shutdown: async () => {} } },
})
for (const fn of ['invite-operator', 'manage-operator']) {
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

function setup() {
  invited = []
  banned = []
  inviteAs = { id: NEW_ID }
  failOn = {}
  tables = {
    leod_users: [
      { id: OWNER,    email: 'owner@x.test',  role: 'director', invited_by: null,     active: true },
      { id: OP_DIR,   email: 'dir@x.test',    role: 'director', invited_by: OWNER,    active: true },
      { id: OP_STAGE, email: 'stage@x.test',  role: 'stage',    invited_by: OWNER,    active: true },
      { id: OP_OFF,   email: 'off@x.test',    role: 'director', invited_by: OWNER,    active: false },
      { id: STRANGER, email: 'other@y.test',  role: 'director', invited_by: null,     active: true },
      { id: THEIR_OP, email: 'theirs@y.test', role: 'av',       invited_by: STRANGER, active: true },
    ],
    leod_events: [{ id: 'ev-1', created_by: OWNER }, { id: 'ev-2', created_by: STRANGER }],
    leod_event_log: [],
  }
}
const user = (id: string) => tables.leod_users.find(u => u.id === id)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ── invite-operator ──────────────────────────────────────────────────────────
Deno.test('invite: the new operator gets the role and team, not the trigger\'s director row', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'New.Crew@x.test', name: 'New Crew', role: 'stage' })
  assert(r.status === 200 && r.body.ok === true, JSON.stringify(r))
  const u = user(NEW_ID)
  assert(u?.role === 'stage' && u.invited_by === OWNER && u.active === true && u.name === 'New Crew',
    'row is ' + JSON.stringify(u))
  assert(tables.leod_users.filter(x => x.id === NEW_ID).length === 1, 'duplicate rows')
})

Deno.test('invite: an invited director invites into the owner\'s team', async () => {
  setup()
  const r = await call('invite-operator', OP_DIR, { email: 'av@x.test', role: 'av' })
  assert(r.status === 200, JSON.stringify(r))
  assert(user(NEW_ID)?.invited_by === OWNER, 'invited_by ' + user(NEW_ID)?.invited_by)
})

Deno.test('invite: stage and deactivated directors cannot invite', async () => {
  for (const who of [OP_STAGE, OP_OFF]) {
    setup()
    const r = await call('invite-operator', who, { email: 'n@x.test', role: 'av' })
    assert(r.status === 403, who + ' ' + JSON.stringify(r))
    assert(invited.length === 0, 'invite sent')
  }
})

Deno.test('invite: an existing email is refused before any invite is sent', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'director' })
  assert(r.status === 409, JSON.stringify(r))
  assert(invited.length === 0 && user(THEIR_OP)?.invited_by === STRANGER && user(THEIR_OP)?.role === 'av', 'existing user changed')
})

Deno.test('invite: an auth user already on another team is not taken over', async () => {
  setup()
  // No leod_users row matched the email (e.g. it changed), but the auth
  // account behind the invite already belongs to STRANGER's team.
  inviteAs = { id: THEIR_OP }
  const r = await call('invite-operator', OWNER, { email: 'renamed@y.test', role: 'director' })
  assert(r.status === 409, JSON.stringify(r))
  assert(String(r.body.error).includes('another team'), JSON.stringify(r.body))
  assert(user(THEIR_OP)?.invited_by === STRANGER && user(THEIR_OP)?.role === 'av', 'row changed: ' + JSON.stringify(user(THEIR_OP)))
})

Deno.test('invite: an auth user who owns events is not turned into an operator', async () => {
  setup()
  inviteAs = { id: STRANGER }
  const r = await call('invite-operator', OWNER, { email: 'renamed2@y.test', role: 'stage' })
  assert(r.status === 409, JSON.stringify(r))
  assert(String(r.body.error).includes('owns events'), JSON.stringify(r.body))
  assert(user(STRANGER)?.role === 'director' && user(STRANGER)?.invited_by === null, 'owner changed')
})

Deno.test('invite: a failed row write is a 500, not a success', async () => {
  setup()
  failOn['POST /rest/v1/leod_users'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage' })
  assert(r.status === 500, JSON.stringify(r))
})

// ── manage-operator ──────────────────────────────────────────────────────────
Deno.test('manage: the owner suspends and reactivates their own operator', async () => {
  setup()
  let r = await call('manage-operator', OWNER, { action: 'suspend', user_id: OP_STAGE })
  assert(r.status === 200 && user(OP_STAGE)?.active === false, JSON.stringify(r))
  r = await call('manage-operator', OWNER, { action: 'reactivate', user_id: OP_STAGE })
  assert(r.status === 200 && user(OP_STAGE)?.active === true, JSON.stringify(r))
})

Deno.test('manage: an invited director manages a teammate', async () => {
  setup()
  const r = await call('manage-operator', OP_DIR, { action: 'suspend', user_id: OP_STAGE })
  assert(r.status === 200 && user(OP_STAGE)?.active === false, JSON.stringify(r))
})

Deno.test("manage: another tenant's director cannot touch this team", async () => {
  for (const action of ['suspend', 'reactivate', 'remove']) {
    setup()
    const r = await call('manage-operator', STRANGER, { action, user_id: OP_STAGE })
    assert(r.status === 403, action + ' ' + JSON.stringify(r))
    assert(user(OP_STAGE)?.active === true && banned.length === 0, action + ' changed the target')
  }
})

Deno.test('manage: nobody can suspend or remove an event owner', async () => {
  setup()
  let r = await call('manage-operator', OP_DIR, { action: 'suspend', user_id: OWNER })
  assert(r.status === 403 && user(OWNER)?.active === true, JSON.stringify(r))
  r = await call('manage-operator', STRANGER, { action: 'remove', user_id: OWNER })
  assert(r.status === 403 && user(OWNER) && banned.length === 0, JSON.stringify(r))
})

Deno.test('manage: stage and deactivated directors cannot manage', async () => {
  for (const who of [OP_STAGE, OP_OFF]) {
    setup()
    const r = await call('manage-operator', who, { action: 'suspend', user_id: OP_DIR })
    assert(r.status === 403 && user(OP_DIR)?.active === true, who + ' ' + JSON.stringify(r))
  }
})

Deno.test('manage: remove deletes the row and bans the account', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: OP_STAGE })
  assert(r.status === 200 && !user(OP_STAGE) && banned.includes(OP_STAGE), JSON.stringify(r))
})

Deno.test('manage: an unknown target is refused', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'suspend', user_id: NEW_ID })
  assert(r.status === 403 || r.status === 404, JSON.stringify(r))
})
