import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response('Bad request', { status: 400, headers: cors })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Auth
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return new Response('Unauthorized', { status: 401, headers: cors })

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return new Response('Unauthorized', { status: 401, headers: cors })

  const { session_id, minutes, command_id, operator_role } = body as {
    session_id: string
    minutes: number
    command_id?: string
    operator_role?: string
  }
  if (!session_id || !minutes) {
    return new Response('Missing session_id or minutes', { status: 400, headers: cors })
  }

  // ── Idempotency check ────────────────────────────────────────────────────
  // If the client supplies a command_id, check the leod_commands table.
  // EXECUTED → return the cached result without re-applying the delay.
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

  // ── Register command as PENDING ──────────────────────────────────────────
  // UNIQUE constraint on command_id prevents race conditions.
  if (command_id) {
    const { error: regErr } = await sb
      .from('leod_commands')
      .insert({
        command_id,
        session_id,
        fn_name:     'apply_delay',
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

  const now = new Date().toISOString()

  // ── Apply delay via transactional RPC ────────────────────────────────────
  // rpc_apply_delay updates all sessions in a single transaction.
  // If any UPDATE fails, all roll back — no partial state.
  const { data: rpcResult, error: rpcError } = await sb.rpc('rpc_apply_delay', {
    p_session_id:    session_id,
    p_minutes:       minutes,
    p_operator_id:   user.id,
    p_operator_role: operator_role ?? null,
  })

  if (rpcError) {
    if (command_id) {
      await sb.from('leod_commands')
        .update({ status: 'REJECTED', error: rpcError.message, resolved_at: now })
        .eq('command_id', command_id)
        .then(() => {}).catch(() => {})
    }
    return new Response(rpcError.message ?? 'Internal error', { status: 500, headers: cors })
  }

  const resultPayload = rpcResult as { ok: boolean; affected: number; minutes: number }

  // ── Mark command executed ────────────────────────────────────────────────
  if (command_id) {
    await sb.from('leod_commands')
      .update({ status: 'EXECUTED', result: resultPayload, resolved_at: now })
      .eq('command_id', command_id)
      .then(() => {}).catch(() => {})
  }

  return new Response(
    JSON.stringify(resultPayload),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
