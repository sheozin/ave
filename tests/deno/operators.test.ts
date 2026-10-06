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
Deno.env.set('RESEND_API_KEY', 're_stub_key_for_tests') // api.resend.com is stubbed below

const OWNER    = '20000000-0000-4000-8000-000000000001'
const OP_DIR   = '20000000-0000-4000-8000-000000000002' // director invited by OWNER
const OP_STAGE = '20000000-0000-4000-8000-000000000003' // stage invited by OWNER
const OP_OFF   = '20000000-0000-4000-8000-000000000004' // director invited by OWNER, deactivated
const STRANGER = '20000000-0000-4000-8000-000000000005' // another tenant's owner
const THEIR_OP = '20000000-0000-4000-8000-000000000006' // invited by STRANGER
const NEW_ID   = '20000000-0000-4000-8000-0000000000aa'
const PENDING  = '20000000-0000-4000-8000-000000000007' // pending, on OWNER's team

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let invited: { email: string; data: Row }[]
let emails: Row[] = []
let banned: string[]
let authAdmin: { method: string; id: string }[]
// created_at the stubbed invite reports: now (a new account) unless a test says otherwise
let inviteCreatedAt: string | null = null
// Which id the next invite creates, and whether that auth user already had a row.
let inviteAs: { id: string; preexisting?: Row } = { id: NEW_ID }
let failOn: Record<string, { status: number; body: Row }> = {}

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    // 'payload->>key' reads inside a json column, as PostgREST does.
    const get = (r: Row) => { const m = k.match(/^(\w+)->>(\w+)$/); return m ? (r[m[1]] as Row | undefined)?.[m[2]] : r[k] }
    if (v.startsWith('eq.')) tests.push(r => String(get(r)) === v.slice(3))
    if (v.startsWith('gte.')) tests.push(r => String(get(r) ?? '') >= v.slice(4))
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
  if (url.host === 'api.resend.com') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    emails.push(b)
    if (failOn['RESEND']) return reply(failOn['RESEND'].status, failOn['RESEND'].body)
    return reply(200, { id: 'email-stub' })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  const key = `${method} ${url.pathname}`
  if (failOn[key]) return reply(failOn[key].status, failOn[key].body)
  if (url.pathname === '/auth/v1/user') {
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  // invite-operator makes the account with generate_link (type invite) and
  // sends its own email; /invite is kept for anything still calling it.
  if (url.pathname === '/auth/v1/invite' || url.pathname === '/auth/v1/admin/generate_link') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    invited.push({ email: b.email, data: b.data })
    // handle_new_auth_user: INSERT ... ON CONFLICT (id) DO NOTHING, role director
    const users = tables.leod_users
    if (inviteAs.preexisting) users.push({ id: inviteAs.id, email: b.email, ...inviteAs.preexisting })
    else if (!users.some(u => u.id === inviteAs.id)) {
      users.push({ id: inviteAs.id, email: b.email, role: 'director', invited_by: null, active: true, name: '' })
    }
    return reply(200, { id: inviteAs.id, email: b.email, aud: 'authenticated', created_at: inviteCreatedAt ?? new Date().toISOString(),
      action_link: 'https://stub.local/verify?token=inv&type=invite' })
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/)
  if (adminUser) {
    authAdmin.push({ method, id: adminUser[1] })
    if (method === 'PUT') banned.push(adminUser[1])
    return reply(200, { id: adminUser[1] })
  }

  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  const wantRows = (headers.get('Prefer') ?? '').includes('return=representation')
  if (method === 'HEAD') {
    // count: 'exact', head: true
    return new Response(null, { status: 200, headers: { 'Content-Range': `*/${rows.filter(match).length}` } })
  }
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
  emails = []
  banned = []
  authAdmin = []
  inviteCreatedAt = null
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
      { id: PENDING,  email: 'pend@x.test',   role: 'pending',  invited_by: OWNER,    active: true },
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

const EV_OURS   = '30000000-0000-4000-8000-000000000001'
const EV_THEIRS = '30000000-0000-4000-8000-000000000002'
function withEvents() {
  tables.leod_events.push({ id: EV_OURS, created_by: OWNER, name: 'Gala <b>2026</b>', date: '2026-10-18' },
                          { id: EV_THEIRS, created_by: STRANGER, name: 'Their Secret Launch', date: '2026-11-01' })
  tables.leod_users.find(u => u.id === OP_DIR)!.name = 'Dana Director'
}

Deno.test('invite: the email names the event, the inviter and the role, and Supabase sends nothing itself', async () => {
  setup(); withEvents()
  const r = await call('invite-operator', OP_DIR, { email: 'crew@x.test', role: 'stage', event_id: EV_OURS })
  assert(r.status === 200, JSON.stringify(r))
  assert(emails.length === 1, 'emails ' + emails.length)
  const m = emails[0] as { subject: string; html: string; to: string }
  assert(m.to === 'crew@x.test', 'to ' + m.to)
  assert(m.subject === "You're invited to Gala b2026/b on CueDeck", 'subject ' + m.subject)
  assert(m.html.includes('Gala &lt;b&gt;2026&lt;/b&gt;') && !m.html.includes('<b>2026'), 'escaping')
  assert(m.html.includes('Dana Director has invited you to work on') && m.html.includes('the Stage role'), 'body')
  assert(m.html.includes('https://stub.local/verify?token=inv&amp;type=invite'), 'link')
  const log = tables.leod_event_log[0] as { payload: Row }
  assert(log.payload.event_id === EV_OURS && log.payload.event_named === 'Gala <b>2026</b>', 'log ' + JSON.stringify(log))
})

Deno.test("invite: another team's event is never named", async () => {
  setup(); withEvents()
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV_THEIRS })
  assert(r.status === 200, JSON.stringify(r))
  const m = emails[0] as { subject: string; html: string }
  assert(!m.subject.includes('Their Secret Launch') && !m.html.includes('Their Secret Launch'), 'leaked ' + m.subject)
  assert(m.subject === "You're invited to join a team on CueDeck", 'subject ' + m.subject)
})

Deno.test("invite: with no event sent, the team's only active event is named", async () => {
  setup()
  tables.leod_events = [{ id: '30000000-0000-4000-8000-000000000003', created_by: OWNER, name: 'GTR North Africa 2026', date: '2026-11-10', active: true },
                        { id: '30000000-0000-4000-8000-000000000004', created_by: OWNER, name: 'Old Event', date: '2025-01-01', active: false }]
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av' })
  assert(r.status === 200, JSON.stringify(r))
  assert((emails[0] as { subject: string }).subject === "You're invited to GTR North Africa 2026 on CueDeck", (emails[0] as { subject: string }).subject)
})

Deno.test('invite: with no event sent and two active events, none is guessed', async () => {
  setup()
  tables.leod_events = [{ id: '30000000-0000-4000-8000-000000000003', created_by: OWNER, name: 'Event A', date: null, active: true },
                        { id: '30000000-0000-4000-8000-000000000005', created_by: OWNER, name: 'Event B', date: null, active: true }]
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av' })
  assert(r.status === 200 && (emails[0] as { subject: string }).subject === "You're invited to join a team on CueDeck", JSON.stringify(emails[0]))
})

Deno.test('invite: a team gets 20 invitations per 24 hours, then 429 before anything is created', async () => {
  setup(); withEvents()
  const recent = new Date(Date.now() - 3600e3).toISOString()
  const old = new Date(Date.now() - 30 * 3600e3).toISOString()
  for (let i = 0; i < 20; i++) tables.leod_event_log.push({ id: i, action: 'OPERATOR_INVITED', ts: recent, payload: { team_owner: OWNER } })
  tables.leod_event_log.push({ id: 99, action: 'OPERATOR_INVITED', ts: recent, payload: { team_owner: STRANGER } })
  const r = await call('invite-operator', OP_DIR, { email: 'one.more@x.test', role: 'av' })
  assert(r.status === 429 && r.body.code === 'invite_rate', JSON.stringify(r))
  assert(invited.length === 0 && emails.length === 0, 'created or sent anyway')
  // Older than 24 hours does not count.
  tables.leod_event_log.forEach(l => { if (l.payload && (l.payload as Row).team_owner === OWNER) l.ts = old })
  const r2 = await call('invite-operator', OP_DIR, { email: 'one.more@x.test', role: 'av' })
  assert(r2.status === 200, JSON.stringify(r2))
})

Deno.test('invite: a link-shaped event or inviter name is left out of the email', async () => {
  setup(); withEvents()
  tables.leod_events.push({ id: '30000000-0000-4000-8000-000000000009', created_by: OWNER, name: 'Account locked, verify at evil.example', date: null })
  tables.leod_users.find(u => u.id === OWNER)!.name = 'support@evil.example'
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: '30000000-0000-4000-8000-000000000009' })
  assert(r.status === 200, JSON.stringify(r))
  const m = emails[0] as { subject: string; html: string; text: string }
  assert(!/evil\.example/.test(m.subject + m.html + m.text), 'link text sent: ' + m.subject)
  assert(m.subject === "You're invited to join a team on CueDeck" && m.html.includes('You have been invited'), m.subject)
})

Deno.test('invite: a failed invitation email withdraws the new account', async () => {
  setup(); withEvents()
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV_OURS })
  assert(r.status === 502, JSON.stringify(r))
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'not deleted ' + JSON.stringify(authAdmin))
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

Deno.test('invite: a failed row write is a 500 and the new auth account is deleted', async () => {
  setup()
  failOn['POST /rest/v1/leod_users'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage' })
  assert(r.status === 500, JSON.stringify(r))
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'auth user not deleted: ' + JSON.stringify(authAdmin))
})

Deno.test('invite: a failed row write never deletes an account that existed before the invite', async () => {
  setup()
  inviteCreatedAt = '2026-01-01T00:00:00.000Z'
  failOn['POST /rest/v1/leod_users'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage' })
  assert(r.status === 500, JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'deleted an older account: ' + JSON.stringify(authAdmin))
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

Deno.test('manage: a failed ban is a 500 and the operator row stays', async () => {
  setup()
  failOn['PUT /auth/v1/admin/users/' + OP_STAGE] = { status: 500, body: { message: 'auth down' } }
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: OP_STAGE })
  assert(r.status === 500, JSON.stringify(r))
  assert(String(r.body.error).toLowerCase().includes('ban'), JSON.stringify(r.body))
  assert(user(OP_STAGE), 'row deleted although the account was not banned')
})

// ── set_role ─────────────────────────────────────────────────────────────────
Deno.test('set_role: the owner changes a teammate\'s role and approves a pending one', async () => {
  setup()
  let r = await call('manage-operator', OWNER, { action: 'set_role', user_id: OP_STAGE, role: 'av' })
  assert(r.status === 200 && user(OP_STAGE)?.role === 'av', JSON.stringify(r))
  r = await call('manage-operator', OWNER, { action: 'set_role', user_id: PENDING, role: 'stage' })
  assert(r.status === 200 && user(PENDING)?.role === 'stage', JSON.stringify(r))
})

Deno.test('set_role: an invited director changes a teammate\'s role', async () => {
  setup()
  const r = await call('manage-operator', OP_DIR, { action: 'set_role', user_id: OP_STAGE, role: 'director' })
  assert(r.status === 200 && user(OP_STAGE)?.role === 'director', JSON.stringify(r))
})

Deno.test('set_role: admin, pending and unknown roles are refused', async () => {
  for (const role of ['admin', 'pending', 'superuser', '']) {
    setup()
    const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: OP_STAGE, role })
    assert(r.status === 400 && user(OP_STAGE)?.role === 'stage', role + ' ' + JSON.stringify(r))
  }
})

Deno.test('set_role: never on the owner, another team, or by stage/deactivated/stranger', async () => {
  const cases: [string, string][] = [[OP_DIR, OWNER], [STRANGER, OP_STAGE], [OWNER, THEIR_OP], [OP_STAGE, OP_DIR], [OP_OFF, OP_STAGE]]
  for (const [who, target] of cases) {
    setup()
    const before = user(target)?.role
    const r = await call('manage-operator', who, { action: 'set_role', user_id: target, role: 'director' })
    assert(r.status === 403, `${who} -> ${target}: ${JSON.stringify(r)}`)
    assert(user(target)?.role === before, 'role changed')
  }
})

Deno.test('set_role: a teammate who owns events is not changed', async () => {
  setup()
  tables.leod_events.push({ id: 'ev-3', created_by: OP_STAGE })
  const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: OP_STAGE, role: 'av' })
  assert(r.status === 409 && user(OP_STAGE)?.role === 'stage', JSON.stringify(r))
})
