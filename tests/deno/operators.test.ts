// tests/deno/operators.test.ts
// invite-operator and manage-operator (event teams, spec 2026-10-08 §4)
// against a stubbed Supabase. The stubbed generate_link plays the auth
// trigger handle_new_auth_user: a new address gets a leod_users row with the
// signup default role (director), which the invite must leave alone; an
// address that already has an account returns that account.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/operators.test.ts
// (tests/operators.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('RESEND_API_KEY', 're_stub_key_for_tests') // api.resend.com is stubbed below

const OWNER    = '20000000-0000-4000-8000-000000000001' // creates EV and EV_OWN2
const DIR      = '20000000-0000-4000-8000-000000000002' // director member of EV
const STAGE    = '20000000-0000-4000-8000-000000000003' // stage on EV, av on EV_OWN2
const OFF      = '20000000-0000-4000-8000-000000000004' // director member of EV, suspended
const STRANGER = '20000000-0000-4000-8000-000000000005' // another organiser, creates EV_THEIRS
const THEIR_OP = '20000000-0000-4000-8000-000000000006' // av member of EV_THEIRS
const NEW_ID   = '20000000-0000-4000-8000-0000000000aa'
const EV        = '30000000-0000-4000-8000-000000000001'
const EV_THEIRS = '30000000-0000-4000-8000-000000000002'
const EV_OWN2   = '30000000-0000-4000-8000-000000000003'
const EV_CHECKIN = '30000000-0000-4000-8000-000000000004'
const SIGNED_IN = { last_sign_in_at: '2026-10-01T09:00:00Z', email_confirmed_at: '2026-09-01T09:00:00Z' }

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let authUsers: Record<string, Row>
let links: { email: string; type: string; data: Row }[]
let emails: Row[] = []
let authAdmin: { method: string; id: string }[]
let writes: { method: string; table: string; body: unknown }[]
let seatLimit: number | null
let inviteCreatedAt: string | null = null
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
  if (url.pathname === '/auth/v1/admin/generate_link') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    links.push({ email: b.email, type: b.type, data: b.data })
    // An address with an account returns that account; a new one gets the
    // signup trigger's row (role director, no team).
    const known = tables.leod_users.find(u => u.email === b.email)
    const id = known ? String(known.id) : NEW_ID
    if (!known) tables.leod_users.push({ id, email: b.email, role: 'director', active: true, name: '' })
    return reply(200, { id, email: b.email, aud: 'authenticated',
      created_at: known ? '2026-01-01T00:00:00.000Z' : (inviteCreatedAt ?? new Date().toISOString()),
      action_link: `https://stub.local/verify?token=${b.type}&type=${b.type}` })
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/)
  if (adminUser) {
    authAdmin.push({ method, id: adminUser[1] })
    if (method === 'GET') return reply(200, { id: adminUser[1], aud: 'authenticated', ...(authUsers[adminUser[1]] ?? {}) })
    return reply(200, { id: adminUser[1] })
  }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/)
  if (rpc) {
    const b = JSON.parse(String(rawBody ?? '{}'))
    if (rpc[1] === 'cuedeck_event_seats_of') {
      return reply(200, { used: tables.leod_event_members.filter(m => m.event_id === b.p_event_id).length, limit: seatLimit })
    }
    return reply(404, { message: 'stub: no rpc ' + rpc[1] })
  }

  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  const wantRows = (headers.get('Prefer') ?? '').includes('return=representation')
  if (method === 'HEAD') {
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
  const body = rawBody ? JSON.parse(String(rawBody)) : undefined
  writes.push({ method, table, body })
  if (method === 'POST') {
    const list: Row[] = Array.isArray(body) ? body : [body]
    for (const r of list) {
      if (table === 'leod_event_members' && rows.some(x => x.event_id === r.event_id && x.user_id === r.user_id)) {
        return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "leod_event_members_pkey"' })
      }
      rows.push({ ...r })
    }
    return wantRows ? reply(201, list) : reply(201, undefined)
  }
  if (method === 'PATCH') {
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, body))
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
  links = []
  emails = []
  authAdmin = []
  writes = []
  seatLimit = null
  inviteCreatedAt = null
  failOn = {}
  // Every account's global role is the signup default; roles live on memberships.
  tables = {
    leod_users: [
      { id: OWNER,    email: 'owner@x.test',  role: 'director', active: true, name: 'Olga Owner' },
      { id: DIR,      email: 'dir@x.test',    role: 'director', active: true, name: 'Dana Director' },
      { id: STAGE,    email: 'stage@x.test',  role: 'director', active: true, name: 'Sami Stage' },
      { id: OFF,      email: 'off@x.test',    role: 'director', active: true, name: 'Omar Off' },
      { id: STRANGER, email: 'other@y.test',  role: 'director', active: true, name: 'Yara Other' },
      { id: THEIR_OP, email: 'theirs@y.test', role: 'director', active: true, name: 'Tarek Theirs' },
    ],
    leod_events: [
      { id: EV,         created_by: OWNER,    name: 'Gala <b>2026</b>',    date: '2026-10-18', created_via: 'console', active: true },
      { id: EV_OWN2,    created_by: OWNER,    name: 'Spring summit',       date: '2027-03-02', created_via: 'console', active: true },
      { id: EV_THEIRS,  created_by: STRANGER, name: 'Their Secret Launch', date: '2026-11-01', created_via: 'console', active: true },
      { id: EV_CHECKIN, created_by: OWNER,    name: 'Desk only',           date: '2026-12-01', created_via: 'checkin', active: true },
    ],
    leod_event_members: [
      { event_id: EV,        user_id: DIR,      role: 'director', active: true },
      { event_id: EV,        user_id: STAGE,    role: 'stage',    active: true },
      { event_id: EV_OWN2,   user_id: STAGE,    role: 'av',       active: true },
      { event_id: EV,        user_id: OFF,      role: 'director', active: false },
      { event_id: EV_THEIRS, user_id: THEIR_OP, role: 'av',       active: true },
    ],
    leod_event_log: [],
  }
  authUsers = { [OWNER]: SIGNED_IN, [DIR]: SIGNED_IN, [STAGE]: SIGNED_IN, [OFF]: SIGNED_IN, [STRANGER]: SIGNED_IN, [THEIR_OP]: SIGNED_IN }
}
const member = (ev: string, id: string) => tables.leod_event_members.find(m => m.event_id === ev && m.user_id === id)
const user = (id: string) => tables.leod_users.find(u => u.id === id)
const logs = (action: string) => tables.leod_event_log.filter(l => l.action === action) as { event_id: string; operator_id: string; payload: Row }[]

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ── invite-operator ──────────────────────────────────────────────────────────
Deno.test('invite: a new email gets an account, a membership on this event only, and the invitation', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'New.Crew@x.test', name: 'New Crew', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'invited' && r.body.user_id === NEW_ID, JSON.stringify(r))
  const m = member(EV, NEW_ID)
  assert(m?.role === 'stage' && m.active === true && m.invited_by === OWNER, 'membership ' + JSON.stringify(m))
  assert(!member(EV_OWN2, NEW_ID), 'joined another event')
  const u = user(NEW_ID)
  assert(u?.role === 'director' && !('invited_by' in u) && u.name === 'New Crew', 'leod_users row ' + JSON.stringify(u))
  assert(links.length === 1 && links[0].type === 'invite' && links[0].email === 'new.crew@x.test', JSON.stringify(links))
  const mail = emails[0] as { subject: string; html: string; to: string }
  assert(mail.to === 'new.crew@x.test' && mail.subject === "You're invited to Gala b2026/b on CueDeck", mail.subject)
  assert(mail.html.includes('Olga Owner has invited you to work on') && mail.html.includes('the Stage role'), 'body')
  assert(mail.html.includes('Gala &lt;b&gt;2026&lt;/b&gt;') && !mail.html.includes('<b>2026'), 'escaping')
  const log = logs('MEMBER_INVITED')
  assert(log.length === 1 && log[0].event_id === EV && log[0].operator_id === OWNER
    && log[0].payload.event_owner === OWNER && log[0].payload.target_user_id === NEW_ID
    && log[0].payload.existing_account === false && !JSON.stringify(log[0].payload).includes('@'), JSON.stringify(log))
})

Deno.test("invite: an existing account on another organiser's event is added with a short notice, no password step", async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added' && r.body.user_id === THEIR_OP, JSON.stringify(r))
  assert(member(EV, THEIR_OP)?.role === 'av' && member(EV_THEIRS, THEIR_OP)?.role === 'av', 'memberships ' + JSON.stringify(tables.leod_event_members))
  assert(links.length === 0, 'a link was made for a login that already works')
  const mail = emails[0] as { subject: string; html: string }
  assert(mail.subject === "You've been added to Gala b2026/b on CueDeck", mail.subject)
  assert(mail.html.includes('Olga Owner has added you to') && mail.html.includes('Open CueDeck')
    && mail.html.includes('Sign in with your existing CueDeck login.'), 'notice body')
  assert(user(THEIR_OP)?.role === 'director' && writes.every(w => w.table !== 'leod_users'), 'the account was written')
})

Deno.test("invite: an organiser of their own events can crew someone else's event", async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'other@y.test', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added' && member(EV, STRANGER)?.role === 'stage', JSON.stringify(r))
})

Deno.test('invite: an existing email typed in another case joins that account', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: '  Theirs@Y.Test ', role: 'reg', event_id: EV })
  assert(r.status === 200 && r.body.user_id === THEIR_OP && member(EV, THEIR_OP)?.role === 'reg', JSON.stringify(r))
  assert(links.length === 0 && tables.leod_users.length === 6, 'a second account was made')
})

Deno.test('invite: the same role again changes nothing and sends nothing', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'stage@x.test', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'unchanged', JSON.stringify(r))
  assert(emails.length === 0 && links.length === 0 && writes.length === 0, 'something was sent or written')
})

Deno.test('invite: another role on the same event changes the role there only, and sends nothing', async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'stage@x.test', role: 'director', event_id: EV })
  assert(r.status === 200 && r.body.result === 'role_changed', JSON.stringify(r))
  assert(member(EV, STAGE)?.role === 'director' && member(EV_OWN2, STAGE)?.role === 'av', JSON.stringify(tables.leod_event_members))
  assert(emails.length === 0, 'an email was sent')
  const log = logs('MEMBER_ROLE_CHANGED')
  assert(log.length === 1 && log[0].payload.from_role === 'stage' && log[0].payload.role === 'director' && log[0].operator_id === DIR, JSON.stringify(log))
})

Deno.test('invite: an existing account that never signed in gets a fresh invite link', async () => {
  setup()
  authUsers[THEIR_OP] = { last_sign_in_at: null, email_confirmed_at: null }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added', JSON.stringify(r))
  assert(links.length === 1 && links[0].type === 'invite', JSON.stringify(links))
  assert((emails[0] as { html: string }).html.includes('https://stub.local/verify?token=invite&amp;type=invite'), 'link')
  // confirmed but never signed in: a password link instead
  setup()
  authUsers[THEIR_OP] = { last_sign_in_at: null, email_confirmed_at: '2026-09-01T00:00:00Z' }
  await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  // (a string, not the narrowed 'invite' from the assert above: setup() reset the links)
  assert(links.length === 1 && (links[0].type as string) === 'recovery', JSON.stringify(links))
})

Deno.test("invite: the event's creator cannot be invited to it", async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'owner@x.test', role: 'stage', event_id: EV })
  assert(r.status === 409 && r.body.code === 'is_owner', JSON.stringify(r))
  assert(writes.length === 0 && emails.length === 0, 'something was written or sent')
})

Deno.test('invite: only the creator and active director members may invite', async () => {
  for (const who of [STAGE, OFF, STRANGER, THEIR_OP]) {
    setup()
    const r = await call('invite-operator', who, { email: 'n@x.test', role: 'av', event_id: EV })
    assert(r.status === 403, who + ' ' + JSON.stringify(r))
    assert(links.length === 0 && writes.length === 0, who + ' created something')
  }
  setup()
  const r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 200, 'invited director ' + JSON.stringify(r))
})

Deno.test('invite: an invited director invites only on events they direct', async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV_OWN2 })
  assert(r.status === 403 && links.length === 0, JSON.stringify(r))
})

Deno.test('invite: the event is required, must exist, and must be a console event', async () => {
  setup()
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av' })
  assert(r.status === 400, 'no event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: '30000000-0000-4000-8000-0000000000ff' })
  assert(r.status === 403, 'unknown event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV_CHECKIN })
  assert(r.status === 400 && r.body.code === 'not_console_event', 'check-in event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'admin', event_id: EV })
  assert(r.status === 400, 'admin role ' + JSON.stringify(r))
  assert(links.length === 0 && writes.length === 0, 'something was created')
})

Deno.test('invite: a full team is refused before anything is created, with who should act', async () => {
  setup()
  seatLimit = 3   // DIR, STAGE and the suspended OFF hold the three seats
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full' && r.body.is_owner === true && r.body.used === 3 && r.body.limit === 3, JSON.stringify(r))
  r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full' && r.body.is_owner === false, JSON.stringify(r))
  assert(links.length === 0 && emails.length === 0 && writes.length === 0, 'created or sent anyway')
  // a role change needs no seat
  r = await call('invite-operator', OWNER, { email: 'stage@x.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'role_changed', 'role change on a full team ' + JSON.stringify(r))
})

Deno.test('invite: a seat taken while inviting (23514) is a 409 and deletes no account', async () => {
  // A concurrent invite of the same new email may have created this account
  // (generateLink reuses an unconfirmed user): refusing must never delete it.
  // An unconfirmed account with no membership is reused by the next invite.
  setup()
  failOn['POST /rest/v1/leod_event_members'] = { status: 400, body: { code: '23514', message: 'seats_full: 3 of 3 seats used on this event' } }
  const r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full', JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'an account was deleted: ' + JSON.stringify(authAdmin))
  assert(emails.length === 0, 'an email was sent')
})

// Two invites of the same NEW email at once (security review, stage 2 HIGH):
// both requests see the account as created just now. The loser must never
// delete it: the winner's membership (and its cascade) would go with it.
Deno.test('invite: the losing request of a concurrent new-email invite never deletes the winner\'s account', async () => {
  // a. same event: the winner's membership is there, the loser's insert hits 23505
  setup()
  inviteCreatedAt = new Date().toISOString()
  tables.leod_event_members.push({ event_id: EV, user_id: NEW_ID, role: 'av', active: true })
  failOn['POST /rest/v1/leod_event_members'] = { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "leod_event_members_pkey"' } }
  let r = await call('invite-operator', DIR, { email: 'fresh@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'already_on_event', 'a ' + JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'a: the winner\'s account was deleted')
  assert(member(EV, NEW_ID), 'a: the winner\'s membership is gone')
  // b. the winner is on another event, the loser's invitation email fails:
  //    the loser removes only its own membership, never the account
  setup()
  inviteCreatedAt = new Date().toISOString()
  tables.leod_event_members.push({ event_id: EV_THEIRS, user_id: NEW_ID, role: 'reg', active: true })
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  r = await call('invite-operator', OWNER, { email: 'fresh@x.test', role: 'av', event_id: EV })
  assert(r.status === 502, 'b ' + JSON.stringify(r))
  assert(!member(EV, NEW_ID) && member(EV_THEIRS, NEW_ID), 'b: memberships ' + JSON.stringify(tables.leod_event_members))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'b: the winner\'s account was deleted')
  // c. a failed membership write while the account already organises an event
  setup()
  inviteCreatedAt = new Date().toISOString()
  tables.leod_events.push({ id: '30000000-0000-4000-8000-0000000000ee', created_by: NEW_ID, name: 'Fresh own', created_via: 'console', active: true })
  failOn['POST /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  r = await call('invite-operator', OWNER, { email: 'fresh@x.test', role: 'av', event_id: EV })
  assert(r.status === 500, 'c ' + JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'c: an organiser\'s account was deleted')
})

Deno.test('invite: someone added the same person a moment earlier: 409, their membership stays', async () => {
  setup()
  // The read before the insert found no membership; the insert then hits the
  // row another director added in between (23505). Nothing is undone.
  failOn['POST /rest/v1/leod_event_members'] = { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "leod_event_members_pkey"' } }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'already_on_event', JSON.stringify(r))
  assert(!writes.some(w => w.method === 'DELETE' && w.table === 'leod_event_members'), 'a membership was deleted')
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'an existing account was deleted')
  assert(emails.length === 0, 'an email was sent')
})

Deno.test('invite: 20 invitations per event owner per 24 hours, then 429 before anything', async () => {
  setup()
  const recent = new Date(Date.now() - 3600e3).toISOString()
  const old = new Date(Date.now() - 30 * 3600e3).toISOString()
  for (let i = 0; i < 20; i++) tables.leod_event_log.push({ id: i, action: 'MEMBER_INVITED', ts: recent, payload: { event_owner: OWNER } })
  tables.leod_event_log.push({ id: 99, action: 'MEMBER_INVITED', ts: recent, payload: { event_owner: STRANGER } })
  const r = await call('invite-operator', DIR, { email: 'one.more@x.test', role: 'av', event_id: EV })
  assert(r.status === 429 && r.body.code === 'invite_rate', JSON.stringify(r))
  assert(links.length === 0 && emails.length === 0, 'created or sent anyway')
  tables.leod_event_log.forEach(l => { if ((l.payload as Row)?.event_owner === OWNER) l.ts = old })
  const r2 = await call('invite-operator', DIR, { email: 'one.more@x.test', role: 'av', event_id: EV })
  assert(r2.status === 200, JSON.stringify(r2))
})

Deno.test('invite: a link-shaped event or inviter name is left out of the email', async () => {
  setup()
  tables.leod_events.find(e => e.id === EV)!.name = 'Account locked, verify at evil.example'
  tables.leod_users.find(u => u.id === OWNER)!.name = 'support@evil.example'
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV })
  assert(r.status === 200, JSON.stringify(r))
  const m = emails[0] as { subject: string; html: string; text: string }
  assert(!/evil\.example/.test(m.subject + m.html + m.text), 'link text sent: ' + m.subject)
  assert(m.subject === "You're invited to join a team on CueDeck" && m.html.includes('You have been invited'), m.subject)
})

Deno.test('invite: a failed invitation email withdraws the new account and the membership', async () => {
  setup()
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV })
  assert(r.status === 502, JSON.stringify(r))
  assert(!member(EV, NEW_ID), 'membership kept')
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'account kept ' + JSON.stringify(authAdmin))
  assert(logs('MEMBER_INVITED').length === 0, 'logged as invited')
})

Deno.test('invite: a failed notice to an existing login keeps the membership', async () => {
  setup()
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && member(EV, THEIR_OP)?.role === 'av', JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'an existing account was deleted')
})

Deno.test('invite: a failed membership write is a 500 and deletes only an account made by this request', async () => {
  setup()
  failOn['POST /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage', event_id: EV })
  assert(r.status === 500, JSON.stringify(r))
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'new account kept: ' + JSON.stringify(authAdmin))
  setup()
  inviteCreatedAt = '2026-01-01T00:00:00.000Z'   // the auth account existed before this request
  failOn['POST /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage', event_id: EV })
  assert(r.status === 500, JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'deleted an older account: ' + JSON.stringify(authAdmin))
})

// ── manage-operator ──────────────────────────────────────────────────────────
Deno.test('manage: the creator suspends and reactivates a member on this event only', async () => {
  setup()
  let r = await call('manage-operator', OWNER, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === false && member(EV_OWN2, STAGE)?.active === true, JSON.stringify(r))
  assert(user(STAGE)?.active === true, 'the account was suspended')
  r = await call('manage-operator', OWNER, { action: 'reactivate', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === true, JSON.stringify(r))
  assert(logs('MEMBER_SUSPENDED').length === 1 && logs('MEMBER_SUSPENDED')[0].event_id === EV
    && logs('MEMBER_REACTIVATED').length === 1, JSON.stringify(tables.leod_event_log))
})

Deno.test('manage: an invited director manages a teammate on the event they direct, not elsewhere', async () => {
  setup()
  let r = await call('manage-operator', DIR, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === false, JSON.stringify(r))
  r = await call('manage-operator', DIR, { action: 'suspend', user_id: STAGE, event_id: EV_OWN2 })
  assert(r.status === 403 && member(EV_OWN2, STAGE)?.active === true, JSON.stringify(r))
})

Deno.test("manage: stage, suspended directors and another organiser cannot touch this event's team", async () => {
  for (const who of [STAGE, OFF, STRANGER, THEIR_OP]) {
    for (const action of ['suspend', 'remove', 'set_role']) {
      setup()
      const r = await call('manage-operator', who, { action, user_id: DIR, role: 'av', event_id: EV })
      assert(r.status === 403, `${who} ${action}: ${JSON.stringify(r)}`)
      assert(member(EV, DIR)?.role === 'director' && member(EV, DIR)?.active === true && writes.length === 0, `${who} ${action} changed the team`)
    }
  }
})

Deno.test('manage: remove takes the person off this event only: no ban, the login and other events stay', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && JSON.stringify(r.body.events) === JSON.stringify([EV]), JSON.stringify(r))
  assert(!member(EV, STAGE) && member(EV_OWN2, STAGE)?.role === 'av', JSON.stringify(tables.leod_event_members))
  assert(authAdmin.length === 0, 'the auth account was touched: ' + JSON.stringify(authAdmin))
  assert(user(STAGE) && writes.every(w => w.table !== 'leod_users'), 'the account row was touched')
  assert(logs('MEMBER_REMOVED').length === 1 && logs('MEMBER_REMOVED')[0].payload.target_user_id === STAGE, 'not logged')
})

Deno.test("manage: without an event, remove covers every event the caller created, and nobody else's", async () => {
  setup()
  tables.leod_event_members.push({ event_id: EV_THEIRS, user_id: STAGE, role: 'reg', active: true })
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: STAGE })
  assert(r.status === 200 && (r.body.events as string[]).sort().join() === [EV, EV_OWN2].sort().join(), JSON.stringify(r))
  assert(!member(EV, STAGE) && !member(EV_OWN2, STAGE) && member(EV_THEIRS, STAGE)?.role === 'reg', JSON.stringify(tables.leod_event_members))
  assert(logs('MEMBER_REMOVED').length === 2 && authAdmin.length === 0, 'logs or a ban')
})

Deno.test('manage: without an event, an invited director reaches nobody', async () => {
  setup()
  const r = await call('manage-operator', DIR, { action: 'remove', user_id: STAGE })
  assert(r.status === 404 && r.body.code === 'not_member' && member(EV, STAGE), JSON.stringify(r))
})

Deno.test('manage: set_role changes the role on this event only', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: STAGE, role: 'director', event_id: EV })
  assert(r.status === 200 && r.body.role === 'director', JSON.stringify(r))
  assert(member(EV, STAGE)?.role === 'director' && member(EV_OWN2, STAGE)?.role === 'av' && user(STAGE)?.role === 'director', JSON.stringify(tables))
  const log = logs('MEMBER_ROLE_CHANGED')
  assert(log.length === 1 && log[0].payload.from_role === 'stage' && log[0].payload.role === 'director', JSON.stringify(log))
})

Deno.test('manage: set_role refuses admin, pending, checkin_staff and unknown roles', async () => {
  for (const role of ['admin', 'pending', 'checkin_staff', 'superuser', '']) {
    setup()
    const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: STAGE, role, event_id: EV })
    assert(r.status === 400 && member(EV, STAGE)?.role === 'stage', role + ' ' + JSON.stringify(r))
  }
})

Deno.test("manage: the creator is never a target, nor yourself, nor someone not on the team", async () => {
  setup()
  let r = await call('manage-operator', DIR, { action: 'suspend', user_id: OWNER, event_id: EV })
  assert(r.status === 404 && r.body.code === 'not_member', 'creator ' + JSON.stringify(r))
  r = await call('manage-operator', DIR, { action: 'suspend', user_id: DIR, event_id: EV })
  assert(r.status === 400, 'self ' + JSON.stringify(r))
  r = await call('manage-operator', OWNER, { action: 'remove', user_id: THEIR_OP, event_id: EV })
  assert(r.status === 404 && member(EV_THEIRS, THEIR_OP), 'not a member ' + JSON.stringify(r))
  assert(writes.length === 0, 'something was written')
})

Deno.test('manage: a failed write is a 500 and logs nothing', async () => {
  setup()
  failOn['PATCH /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call('manage-operator', OWNER, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 500 && tables.leod_event_log.length === 0, JSON.stringify(r))
})
