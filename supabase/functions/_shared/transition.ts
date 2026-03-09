import { adminClient } from './client.ts'
import { corsHeaders } from './cors.ts'

// ── Time helper ──────────────────────────────────────────────────────────────
// timeStr is "HH:MM:SS" (TIME column from Postgres)
export function addMinutes(timeStr: string, mins: number): string {
  const [h, m, s] = timeStr.split(':').map(Number)
  const total = h * 60 + m + mins
  const nh = Math.floor(total / 60) % 24
  const nm = total % 60
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}:${String(s ?? 0).padStart(2, '0')}`
}

// ── Shared transition runner ─────────────────────────────────────────────────
export async function runTransition(req: Request, toStatus: string): Promise<Response> {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400, headers: cors })
  }

  // Ping (used by checkEF diagnostic in the console)
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Auth — extract JWT sent by the Supabase JS client
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }
  const jwt = authHeader.replace('Bearer ', '')

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }

  // Validate body
  const { session_id, version, command_id, operator_role } = body as {
    session_id: string
    version: number
    command_id?: string
    operator_role?: string
  }
  if (!session_id || version === undefined) {
    return new Response('Missing session_id or version', { status: 400, headers: cors })
  }

  // ── Idempotency check ────────────────────────────────────────────────────
  // If the client supplies a command_id, check the leod_commands table.
  // EXECUTED → return the cached result without re-applying the state change.
  // PENDING  → another request for this command is in flight; return 409.
  if (command_id) {
    const { data: existing } = await sb
      .from('leod_commands')
      .select('status, result, error')
      .eq('command_id', command_id)
      .single()

    if (existing?.status === 'EXECUTED') {
      return new Response(
        JSON.stringify(existing.result),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
    if (existing?.status === 'PENDING') {
      return new Response(
        JSON.stringify({ error: 'IN_FLIGHT' }),
        { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
  }

  // Load session
  const { data: session, error: fetchErr } = await sb
    .from('leod_sessions')
    .select('*')
    .eq('id', session_id)
    .single()

  if (fetchErr || !session) {
    return new Response('Session not found', { status: 404, headers: cors })
  }

  // Optimistic lock — check version before registering the command
  if (session.version !== version) {
    return new Response(
      JSON.stringify({ error: 'Version conflict', current: session.version }),
      { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }

  // ── Register command as PENDING ──────────────────────────────────────────
  // UNIQUE constraint on command_id prevents race conditions.
  if (command_id) {
    const { error: regErr } = await sb
      .from('leod_commands')
      .insert({
        command_id,
        session_id,
        fn_name:     `transition_${toStatus.toLowerCase()}`,
        operator_id: user.id,
        status:      'PENDING',
      })
    if (regErr) {
      // UNIQUE violation → concurrent duplicate; treat as IN_FLIGHT
      return new Response(
        JSON.stringify({ error: 'IN_FLIGHT' }),
        { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
  }

  // Build update
  const now = new Date().toISOString()
  const upd: Record<string, unknown> = {
    status: toStatus,
    state_changed_at: now,
    version: version + 1,
    state_changed_by: user.id,
  }
  if (toStatus === 'LIVE' && !session.actual_start) upd.actual_start = now
  if (toStatus === 'ENDED') upd.actual_end = now

  // Write session (with version guard)
  const { error: upErr } = await sb
    .from('leod_sessions')
    .update(upd)
    .eq('id', session_id)
    .eq('version', version)

  if (upErr) {
    // Mark command rejected (best-effort)
    if (command_id) {
      await sb.from('leod_commands')
        .update({ status: 'REJECTED', error: upErr.message, resolved_at: now })
        .eq('command_id', command_id)
        .then(() => {}).catch(() => {})
    }
    return new Response(upErr.message, { status: 500, headers: cors })
  }

  const resultPayload = { ok: true, status: toStatus, version: version + 1 }

  // ── Mark command executed ────────────────────────────────────────────────
  if (command_id) {
    await sb.from('leod_commands')
      .update({ status: 'EXECUTED', result: resultPayload, resolved_at: now })
      .eq('command_id', command_id)
      .then(() => {}).catch(() => {})
  }

  // Write event log (best-effort)
  await sb.from('leod_event_log').insert({
    event_id:       session.event_id,
    session_id,
    action:         'SESSION_STATUS_CHANGE',
    from_status:    session.status,
    to_status:      toStatus,
    operator_id:    user.id,
    operator_role:  operator_role ?? null,
    payload:        { command_id, via: 'edge-function' },
    server_time_ms: Date.now(),
  }).then(() => {}).catch(() => {})

  return new Response(
    JSON.stringify(resultPayload),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
}
