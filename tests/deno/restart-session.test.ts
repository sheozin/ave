// tests/deno/restart-session.test.ts
// Runs the real restart-session Edge Function (and set-ready, which shares
// runTransition) against a stubbed Supabase: fetch is replaced, so
// supabase-js talks to an in-memory table set.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/restart-session.test.ts
// (tests/restart-session.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')

const USER = '11111111-1111-4111-8111-111111111111'
const EVENT = '33333333-3333-4333-8333-333333333333'
const SESSION = '77777777-7777-4777-8777-777777777777'
const STARTED = '2026-10-05T10:28:00.000Z'
const ENDED_AT = '2026-10-05T10:58:00.000Z'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let patches: { table: string; body: Row }[]
// Runs just before a PATCH is applied: lets a test play another writer.
let beforePatch: ((table: string) => void) | null = null

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) tests.push(r => String(r[k]) === v.slice(3))
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
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  if (url.pathname === '/auth/v1/user') {
    return reply(200, { id: USER, email: 'director@stub.test', aud: 'authenticated' })
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
      // leod_commands.command_id is UNIQUE
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
    beforePatch?.(table)
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
for (const fn of ['restart-session', 'set-ready', 'go-live']) {
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
  const text = await res.text()
  let parsed: Row = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text } }
  return { status: res.status, body: parsed }
}

function setup(session: Row) {
  patches = []
  beforePatch = null
  tables = {
    leod_sessions: [{
      id: SESSION, event_id: EVENT, title: "Chair's opening remarks", version: 7,
      scheduled_start: '10:30:00', scheduled_end: '10:45:00',
      delay_minutes: 5, cumulative_delay: 5,
      actual_start: STARTED, actual_end: null, status: 'LIVE',
      ...session,
    }],
    leod_commands: [],
    leod_event_log: [],
    // The caller owns the event (runTransition checks membership).
    leod_events: [{ id: EVENT, created_by: USER }],
    leod_users: [{ id: USER, role: 'director', invited_by: null, active: true }],
  }
}
const sess = () => tables.leod_sessions[0]
const sessionWrites = () => patches.filter(p => p.table === 'leod_sessions')

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

for (const from of ['LIVE', 'HOLD', 'OVERRUN', 'ENDED', 'CALLING']) {
  // CALLING counts as started only with an actual_start (HOLD -> CALLING); the default row has one.
  Deno.test(`restart-session: ${from} goes back to READY with its run cleared`, async () => {
    setup({ status: from, actual_end: from === 'ENDED' ? ENDED_AT : null })
    const r = await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-' + from, operator_role: 'director' })
    assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`)
    assert(r.body.ok === true && r.body.status === 'READY' && r.body.version === 8, JSON.stringify(r.body))
    const s = sess()
    assert(s.status === 'READY', 'status ' + s.status)
    assert(s.actual_start === null, 'actual_start not cleared: ' + s.actual_start)
    assert(s.actual_end === null, 'actual_end not cleared: ' + s.actual_end)
    assert(s.version === 8, 'version ' + s.version)
    // The schedule is not the run: a delay shifted the programme and stays.
    assert(s.scheduled_start === '10:30:00' && s.scheduled_end === '10:45:00', 'schedule changed')
    assert(s.delay_minutes === 5 && s.cumulative_delay === 5, 'delay changed')
  })
}

Deno.test('restart-session: READY with an old actual_start is restartable', async () => {
  setup({ status: 'READY' })
  const r = await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-ready' })
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`)
  assert(sess().actual_start === null, 'actual_start not cleared')
})

for (const [from, start] of [['PLANNED', STARTED], ['CANCELLED', STARTED], ['READY', null], ['CALLING', null]] as const) {
  Deno.test(`restart-session: ${from}${start ? '' : ' that never started'} is refused with 409`, async () => {
    setup({ status: from, actual_start: start })
    const r = await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-refuse' })
    assert(r.status === 409, `status ${r.status} ${JSON.stringify(r.body)}`)
    assert(r.body.error === 'NOT_RESTARTABLE', JSON.stringify(r.body))
    assert(patches.length === 0, 'something was written: ' + JSON.stringify(patches))
    assert(sess().status === from && sess().actual_start === start && sess().version === 7, 'session changed')
    // A refusal leaves no PENDING command behind to block a retry.
    assert(tables.leod_commands.length === 0, 'command registered: ' + JSON.stringify(tables.leod_commands))
    assert(tables.leod_event_log.length === 0, 'event logged')
  })
}

Deno.test('restart-session: writes the event log with the run it cleared', async () => {
  setup({ status: 'ENDED', actual_end: ENDED_AT })
  await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-log', operator_role: 'director' })
  assert(tables.leod_event_log.length === 1, 'log rows ' + tables.leod_event_log.length)
  const log = tables.leod_event_log[0]
  assert(log.action === 'SESSION_STATUS_CHANGE', 'action ' + log.action)
  assert(log.from_status === 'ENDED' && log.to_status === 'READY', JSON.stringify(log))
  assert(log.operator_id === USER && log.operator_role === 'director' && log.session_id === SESSION && log.event_id === EVENT, JSON.stringify(log))
  const p = log.payload as Row
  assert(p.restart === true && p.command_id === 'cmd-log', JSON.stringify(p))
  assert(p.previous_actual_start === STARTED && p.previous_actual_end === ENDED_AT, JSON.stringify(p))
  const cmd = tables.leod_commands[0]
  assert(cmd.fn_name === 'restart_session' && cmd.status === 'EXECUTED', JSON.stringify(cmd))
})

Deno.test('restart-session: the same command id runs once', async () => {
  setup({ status: 'LIVE' })
  const first = await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-twice' })
  // Someone goes live again after the restart; a retried restart must not undo that.
  Object.assign(sess(), { status: 'LIVE', actual_start: '2026-10-05T11:00:00.000Z', version: 9 })
  const again = await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-twice' })
  assert(again.status === 200 && JSON.stringify(again.body) === JSON.stringify(first.body), JSON.stringify(again))
  assert(sessionWrites().length === 1, 'session written ' + sessionWrites().length + ' times')
  assert(sess().status === 'LIVE' && sess().actual_start === '2026-10-05T11:00:00.000Z', 'retry re-applied the restart')
  assert(tables.leod_event_log.length === 1, 'logged ' + tables.leod_event_log.length + ' times')
})

Deno.test('restart-session: a stale version is refused', async () => {
  setup({ status: 'LIVE' })
  const r = await call('restart-session', { session_id: SESSION, version: 6, command_id: 'cmd-stale' })
  assert(r.status === 409 && r.body.error === 'Version conflict', JSON.stringify(r))
  assert(patches.length === 0 && sess().actual_start === STARTED, 'session changed')
})

Deno.test('restart-session: no Authorization header is a 401', async () => {
  setup({ status: 'LIVE' })
  const res = await handlers['restart-session'](new Request('http://stub.local/functions/v1/restart-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION, version: 7 }),
  }))
  assert(res.status === 401, 'status ' + res.status)
  await res.body?.cancel()
  assert(patches.length === 0, 'session changed')
})

Deno.test('restart then go-live stamps a fresh actual_start', async () => {
  setup({ status: 'ENDED', actual_end: ENDED_AT })
  await call('restart-session', { session_id: SESSION, version: 7, command_id: 'cmd-r' })
  const before = Date.now()
  const r = await call('go-live', { session_id: SESSION, version: 8, command_id: 'cmd-g' })
  assert(r.status === 200, JSON.stringify(r))
  const started = Date.parse(String(sess().actual_start))
  assert(started >= before - 1000, 'actual_start is the old one: ' + sess().actual_start)
  assert(sess().actual_end === null, 'actual_end ' + sess().actual_end)
})

Deno.test('set-ready is unchanged: it keeps actual_start', async () => {
  setup({ status: 'HOLD' })
  const r = await call('set-ready', { session_id: SESSION, version: 7, command_id: 'cmd-sr' })
  assert(r.status === 200, JSON.stringify(r))
  assert(sess().status === 'READY' && sess().actual_start === STARTED, JSON.stringify(sess()))
  assert(tables.leod_commands[0].fn_name === 'transition_ready', JSON.stringify(tables.leod_commands[0]))
})

// Another writer bumps the version between the read and the guarded update:
// the update matches no row and must not be reported as a success.
for (const [fn, status] of [['restart-session', 'LIVE'], ['go-live', 'READY']] as const) {
  Deno.test(`${fn}: losing the race after the version check is a 409, not a success`, async () => {
    setup({ status, actual_start: status === 'READY' ? null : STARTED })
    beforePatch = (table) => {
      if (table === 'leod_sessions') { Object.assign(sess(), { status: 'HOLD', version: 8 }); beforePatch = null }
    }
    const r = await call(fn, { session_id: SESSION, version: 7, command_id: 'cmd-race-' + fn })
    assert(r.status === 409 && r.body.error === 'Version conflict', `${r.status} ${JSON.stringify(r.body)}`)
    assert(sess().status === 'HOLD' && sess().version === 8, 'other writer overwritten: ' + JSON.stringify(sess()))
    const cmd = tables.leod_commands[0]
    assert(cmd.status === 'REJECTED', 'command ' + JSON.stringify(cmd))
    assert(tables.leod_event_log.length === 0, 'event logged for a write that did not happen')
  })
}
