// invite-operator — Director invites a crew member by email.
// Creates auth account via inviteUserByEmail (sends Supabase invite email),
// then inserts a leod_users row with the pre-assigned role (skips pending).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse body
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Ping support (deploy verification)
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Auth: verify caller is a director ──────────────────────────
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Verify caller is a director
  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'director') {
    return new Response(JSON.stringify({ error: 'Forbidden — directors only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ─────────────────────────────────────────────
  const email = String(body.email || '').trim().toLowerCase()
  const role  = String(body.role || '')
  const name  = String(body.name || '').trim() || null

  if (!email || !VALID_ROLES.has(role)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid email/role' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Check if user already exists ───────────────────────────────
  const { data: existingUser } = await sb.from('leod_users')
    .select('id, email, role').eq('email', email).single()
  if (existingUser) {
    return new Response(
      JSON.stringify({ error: 'User already exists', existing_role: existingUser.role }),
      { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }

  // ── Invite via Supabase Auth (sends email automatically) ──────
  const { data: inviteData, error: inviteErr } = await sb.auth.admin.inviteUserByEmail(email, {
    data: { name: name || '', invited_role: role },
  })
  if (inviteErr) {
    return new Response(
      JSON.stringify({ error: inviteErr.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }

  // ── Create leod_users row with assigned role (skip pending) ───
  const { error: insertErr } = await sb.from('leod_users').insert({
    id:         inviteData.user.id,
    email,
    name,
    role,
    active:     true,
    invited_by: user.id,
  })
  if (insertErr) {
    // Auth account was created but profile row failed — log but don't fail.
    // Director can still assign role manually via Operators modal.
    console.error('leod_users insert failed:', insertErr.message)
  }

  // ── Audit log (best-effort) ───────────────────────────────────
  sb.from('leod_event_log').insert({
    event_id:      null,
    session_id:    null,
    action:        'OPERATOR_INVITED',
    operator_id:   user.id,
    operator_role: 'director',
    payload:       { invited_email: email, assigned_role: role, invited_user_id: inviteData.user.id },
    server_time_ms: Date.now(),
  }).then(() => {}).catch(() => {})

  return new Response(
    JSON.stringify({ ok: true, user_id: inviteData.user.id, role }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
