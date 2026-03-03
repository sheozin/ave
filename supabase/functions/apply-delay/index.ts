import { adminClient, } from '../_shared/client.ts'
import { addMinutes } from '../_shared/transition.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Auth
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

  const { session_id, minutes, command_id, operator_role } = body as {
    session_id: string
    minutes: number
    command_id?: string
    operator_role?: string
  }
  if (!session_id || !minutes) {
    return new Response('Missing session_id or minutes', { status: 400, headers: corsHeaders })
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
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (existing?.status === 'PENDING') {
      return new Response(
        JSON.stringify({ error: 'IN_FLIGHT' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // Load anchor session to get event_id + sort_order
  const { data: anchor } = await sb
    .from('leod_sessions')
    .select('event_id, sort_order')
    .eq('id', session_id)
    .single()

  if (!anchor) return new Response('Session not found', { status: 404, headers: corsHeaders })

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
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  const now = new Date().toISOString()

  // Load this session and all subsequent ones
  const { data: sessions } = await sb
    .from('leod_sessions')
    .select('id, sort_order, scheduled_start, scheduled_end, cumulative_delay, delay_minutes, status, is_anchor')
    .eq('event_id', anchor.event_id)
    .gte('sort_order', anchor.sort_order)
    .order('sort_order')

  // Cascade: stop at anchors, skip ENDED/CANCELLED
  const updates: Array<{ id: string; [key: string]: unknown }> = []
  for (const s of sessions ?? []) {
    if (s.status === 'ENDED' || s.status === 'CANCELLED') continue
    if (s.id !== session_id && s.is_anchor) break
    updates.push({
      id: s.id,
      scheduled_start:  addMinutes(s.scheduled_start, minutes),
      scheduled_end:    addMinutes(s.scheduled_end,   minutes),
      cumulative_delay: (s.cumulative_delay ?? 0) + minutes,
      ...(s.id === session_id ? { delay_minutes: (s.delay_minutes ?? 0) + minutes } : {}),
    })
  }

  // Write all updates
  let writeErr: unknown = null
  for (const u of updates) {
    const { id, ...fields } = u
    const { error } = await sb.from('leod_sessions').update(fields).eq('id', id)
    if (error) { writeErr = error; break }
  }

  if (writeErr) {
    // Mark command rejected (best-effort)
    if (command_id) {
      const msg = (writeErr as { message?: string }).message ?? 'write error'
      await sb.from('leod_commands')
        .update({ status: 'REJECTED', error: msg, resolved_at: now })
        .eq('command_id', command_id)
        .then(() => {}).catch(() => {})
    }
    const msg = (writeErr as { message?: string }).message ?? 'Internal error'
    return new Response(msg, { status: 500, headers: corsHeaders })
  }

  const resultPayload = { ok: true, affected: updates.length, minutes }

  // ── Mark command executed ────────────────────────────────────────────────
  if (command_id) {
    await sb.from('leod_commands')
      .update({ status: 'EXECUTED', result: resultPayload, resolved_at: now })
      .eq('command_id', command_id)
      .then(() => {}).catch(() => {})
  }

  // Event log
  await sb.from('leod_event_log').insert({
    event_id:       anchor.event_id,
    session_id,
    action:         'DELAY_APPLIED',
    operator_id:    user.id,
    operator_role:  operator_role ?? null,
    payload:        { minutes, affected: updates.length, command_id, via: 'edge-function' },
    server_time_ms: Date.now(),
  }).then(() => {}).catch(() => {})

  return new Response(
    JSON.stringify(resultPayload),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
