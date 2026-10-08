// tests/deno/session-auth.test.ts
// Who may change a session. Runs the real transition Edge Functions (all
// through runTransition) and apply-delay against a stubbed Supabase: fetch
// is replaced, so supabase-js talks to an in-memory table set. The bearer
// token picks the caller, so each test signs in as a different person.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/session-auth.test.ts
// (tests/session-auth.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')

const OWNER       = '10000000-0000-4000-8000-000000000001'
const OP_DIRECTOR = '10000000-0000-4000-8000-000000000002' // director member of EVENT
const OP_STAGE    = '10000000-0000-4000-8000-000000000003' // stage on EVENT, director on OTHER_EVENT
const OP_AV       = '10000000-0000-4000-8000-000000000004' // av member of EVENT
const OP_OFF      = '10000000-0000-4000-8000-000000000005' // director member of EVENT, suspended
const STRANGER    = '10000000-0000-4000-8000-000000000006' // creates OTHER_EVENT
const OTHER_OP    = '10000000-0000-4000-8000-000000000007' // stage member of OTHER_EVENT only
const NO_ROW      = '10000000-0000-4000-8000-000000000008' // signed in, no leod_users row
const LEGACY      = '10000000-0000-4000-8000-000000000009' // leod_users.invited_by = OWNER, no membership
const EVENT       = '33333333-3333-4333-8333-333333333333'
const OTHER_EVENT = '44444444-4444-4444-8444-444444444444'
const SESSION     = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let patches: { table: string; body: Row }[]
let rpcCalls: { fn: string; body: Row }[]
let rpcReply: { status: number; body: unknown }

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
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  if (url.pathname === '/auth/v1/user') {
    // The test's bearer token is the user id.
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/)
  if (rpc) {
    rpcCalls.push({ fn: rpc[1], body: JSON.parse(String(init?.body ?? '{}')) })
    return reply(rpcReply.status, rpcReply.body)
  }
  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  if (method === 'GET') {
    const hit = rows.filter(match)
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (hit.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      return reply(200, hit[0])
    }
    return reply(200, hit)
  }
  if (method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const list: Row[] = Array.isArray(body) ? body : [body]
    for (const r of list) {
      if (table === 'leod_commands' && rows.some(x => x.command_id === r.command_id)) {
        return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' })
      }
      rows.push({ ...r })
    }
    return reply(201, undefined)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(init?.body ?? '{}'))
    patches.push({ table, body: patch })
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
const FNS = ['go-live', 'end-session', 'set-ready', 'hold-stage', 'call-speaker', 'cancel-session',
  'reinstate', 'set-overrun', 'restart-session', 'apply-delay']
for (const fn of FNS) {
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

function setup(session: Row = {}) {
  patches = []
  rpcCalls = []
  rpcReply = { status: 200, body: { ok: true, affected: 2, minutes: 5 } }
  tables = {
    leod_events: [
      { id: EVENT, created_by: OWNER },
      { id: OTHER_EVENT, created_by: STRANGER },
    ],
    leod_users: [
      { id: OWNER,       role: 'director', invited_by: null,  active: true },
      { id: OP_DIRECTOR, role: 'director', invited_by: null,  active: true },
      { id: OP_STAGE,    role: 'director', invited_by: null,  active: true },
      { id: OP_AV,       role: 'director', invited_by: null,  active: true },
      { id: OP_OFF,      role: 'director', invited_by: null,  active: true },
      { id: STRANGER,    role: 'director', invited_by: null,  active: true },
      { id: OTHER_OP,    role: 'director', invited_by: null,  active: true },
      { id: LEGACY,      role: 'stage',    invited_by: OWNER, active: true },
    ],
    leod_event_members: [
      { event_id: EVENT,       user_id: OP_DIRECTOR, role: 'director', active: true },
      { event_id: EVENT,       user_id: OP_STAGE,    role: 'stage',    active: true },
      { event_id: EVENT,       user_id: OP_AV,       role: 'av',       active: true },
      { event_id: EVENT,       user_id: OP_OFF,      role: 'director', active: false },
      { event_id: OTHER_EVENT, user_id: OTHER_OP,    role: 'stage',    active: true },
      { event_id: OTHER_EVENT, user_id: OP_STAGE,    role: 'director', active: true },
    ],
    leod_sessions: [{
      id: SESSION, event_id: EVENT, title: 'Keynote', version: 7,
      scheduled_start: '10:30:00', scheduled_end: '10:45:00',
      delay_minutes: 0, cumulative_delay: 0,
      actual_start: null, actual_end: null, status: 'READY',
      ...session,
    }],
    leod_commands: [],
    leod_event_log: [],
  }
}
const sess = () => tables.leod_sessions[0]

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// [label, function, starting status, caller, expected HTTP status]
const CASES: [string, string, string, string, number][] = [
  ['owner goes live',                       'go-live',         'READY',   OWNER,       200],
  ['owner cancels',                         'cancel-session',  'READY',   OWNER,       200],
  ['invited active director cancels',       'cancel-session',  'READY',   OP_DIRECTOR, 200],
  ['invited active director reinstates',    'reinstate',       'CANCELLED', OP_DIRECTOR, 200],
  ['invited stage goes live',               'go-live',         'READY',   OP_STAGE,    200],
  ['invited stage ends',                    'end-session',     'LIVE',    OP_STAGE,    200],
  ['invited stage cannot cancel',           'cancel-session',  'READY',   OP_STAGE,    403],
  ['invited stage cannot reinstate',        'reinstate',       'CANCELLED', OP_STAGE,  403],
  ['invited stage restarts',                'restart-session', 'LIVE',    OP_STAGE,    200],
  ['av holds',                              'hold-stage',      'LIVE',    OP_AV,       200],
  ['av cannot go live',                     'go-live',         'READY',   OP_AV,       403],
  ['av cannot end',                         'end-session',     'LIVE',    OP_AV,       403],
  ['av cannot call the speaker',            'call-speaker',    'READY',   OP_AV,       403],
  ['av cannot set ready',                   'set-ready',       'PLANNED', OP_AV,       403],
  ['av cannot restart',                     'restart-session', 'LIVE',    OP_AV,       403],
  // The console's 1s tick sends set-overrun for director, stage and av.
  ['av marks an overrun',                   'set-overrun',     'LIVE',    OP_AV,       200],
  ['deactivated director is refused',       'go-live',         'READY',   OP_OFF,      403],
  ['owner of another event is refused',     'go-live',         'READY',   STRANGER,    403],
  ["another owner's operator is refused",   'end-session',     'LIVE',    OTHER_OP,    403],
  ['a user with no operator row is refused','go-live',         'READY',   NO_ROW,      403],
  ['a global director who is stage on this event cannot cancel', 'cancel-session', 'READY', OP_STAGE, 403],
  ['a suspended member is refused',          'end-session',     'LIVE',    OP_OFF,      403],
  ['the old invited_by link alone is refused', 'go-live',       'READY',   LEGACY,      403],
  ['director on another event is stage here: no reinstate', 'reinstate', 'CANCELLED', OP_STAGE, 403],
]

for (const [label, fn, from, who, expected] of CASES) {
  Deno.test(`${fn}: ${label} (${expected})`, async () => {
    setup({ status: from, actual_start: from === 'READY' || from === 'PLANNED' || from === 'CANCELLED' ? null : '2026-10-05T10:28:00.000Z' })
    const r = await call(fn, who, { session_id: SESSION, version: 7, command_id: `cmd-${fn}-${who}`, operator_role: 'director' })
    assert(r.status === expected, `status ${r.status} ${JSON.stringify(r.body)}`)
    if (expected === 403) {
      assert(r.body.error === 'Forbidden', JSON.stringify(r.body))
      assert(patches.length === 0, 'something was written: ' + JSON.stringify(patches))
      assert(sess().status === from && sess().version === 7, 'session changed: ' + JSON.stringify(sess()))
      assert(tables.leod_commands.length === 0, 'command registered: ' + JSON.stringify(tables.leod_commands))
      assert(tables.leod_event_log.length === 0, 'event logged')
    } else {
      assert(sess().version === 8, 'not written: ' + JSON.stringify(sess()))
    }
  })
}

Deno.test('operator_role in the body is not trusted: av claiming director is refused', async () => {
  setup({ status: 'READY' })
  const r = await call('go-live', OP_AV, { session_id: SESSION, version: 7, command_id: 'cmd-claim', operator_role: 'director' })
  assert(r.status === 403 && r.body.error === 'Forbidden', JSON.stringify(r))
  assert(sess().status === 'READY', 'session changed')
})

Deno.test('a refused caller learns nothing about the version', async () => {
  setup({ status: 'READY' })
  const r = await call('go-live', STRANGER, { session_id: SESSION, version: 1, command_id: 'cmd-ver' })
  assert(r.status === 403 && r.body.current === undefined, JSON.stringify(r))
})

// apply-delay: ROLE_DELAY is director and stage.
const DELAY_CASES: [string, string, number][] = [
  ['owner',                       OWNER,       200],
  ['invited active director',     OP_DIRECTOR, 200],
  ['invited stage',               OP_STAGE,    200],
  ['invited av',                  OP_AV,       403],
  ['deactivated director',        OP_OFF,      403],
  ['owner of another event',      STRANGER,    403],
  ["another owner's operator",    OTHER_OP,    403],
  ['the old invited_by link alone', LEGACY,     403],
]
for (const [label, who, expected] of DELAY_CASES) {
  Deno.test(`apply-delay: ${label} (${expected})`, async () => {
    setup({ status: 'LIVE' })
    const r = await call('apply-delay', who, { session_id: SESSION, minutes: 5, command_id: 'cmd-delay-' + who, operator_role: 'director' })
    assert(r.status === expected, `status ${r.status} ${JSON.stringify(r.body)}`)
    if (expected === 403) {
      assert(r.body.error === 'Forbidden', JSON.stringify(r.body))
      assert(rpcCalls.length === 0, 'rpc called: ' + JSON.stringify(rpcCalls))
      assert(tables.leod_commands.length === 0, 'command registered')
    } else {
      assert(rpcCalls.length === 1 && rpcCalls[0].fn === 'rpc_apply_delay', JSON.stringify(rpcCalls))
      assert(rpcCalls[0].body.p_operator_id === who && rpcCalls[0].body.p_session_id === SESSION, JSON.stringify(rpcCalls[0]))
    }
  })
}

Deno.test('apply-delay: an unknown session is a 404 and calls nothing', async () => {
  setup({ status: 'LIVE' })
  const r = await call('apply-delay', OWNER, { session_id: '99999999-9999-4999-8999-999999999999', minutes: 5 })
  assert(r.status === 404, `status ${r.status}`)
  assert(rpcCalls.length === 0, 'rpc called')
})

Deno.test('apply-delay: the RPC refusing (42501) is a 403, not a 500', async () => {
  // The role changed between the EF check and the transaction.
  setup({ status: 'LIVE' })
  rpcReply = { status: 403, body: { code: '42501', message: 'Forbidden', details: null, hint: null } }
  const r = await call('apply-delay', OP_STAGE, { session_id: SESSION, minutes: 5, command_id: 'cmd-rpc-403' })
  assert(r.status === 403 && r.body.error === 'Forbidden', `${r.status} ${JSON.stringify(r.body)}`)
  assert(tables.leod_commands[0]?.status === 'REJECTED', JSON.stringify(tables.leod_commands))
})
