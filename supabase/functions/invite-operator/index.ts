// invite-operator — Director invites a crew member by email.
// Creates auth account via inviteUserByEmail (sends Supabase invite email),
// then sets the leod_users row the auth trigger (handle_new_auth_user)
// already created as a self-registered director: role, invited_by, active.
// The operator joins the caller's team: invited_by is the event owner, also
// when an invited director sends the invite.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const startedAt = Date.now()

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

  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  // Verify caller is an active director
  const { data: callerRow, error: callerErr } = await sb.from('leod_users')
    .select('role, invited_by, active').eq('id', user.id).maybeSingle()
  if (callerErr) return json(500, { error: callerErr.message })
  if (!callerRow || callerRow.role !== 'director' || callerRow.active === false) {
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

  const teamOwner: string = callerRow.invited_by ?? user.id

  // ── Check if user already exists ───────────────────────────────
  const { data: existingUser, error: existingErr } = await sb.from('leod_users')
    .select('id, email, role').eq('email', email).maybeSingle()
  if (existingErr) return json(500, { error: existingErr.message })
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

  const newId = inviteData.user.id

  // ── Never take over someone else's account ─────────────────────
  // The auth trigger has normally just created this row as a fresh,
  // uninvited director. If the account already belongs to another team, or
  // owns events of its own, an invite must not change its role.
  const { data: row, error: rowErr } = await sb.from('leod_users')
    .select('id, invited_by').eq('id', newId).maybeSingle()
  if (rowErr) return json(500, { error: rowErr.message })
  if (row?.invited_by && row.invited_by !== teamOwner) {
    return json(409, { error: 'This account already belongs to another team' })
  }
  const { data: owned, error: ownedErr } = await sb.from('leod_events')
    .select('id').eq('created_by', newId).limit(1)
  if (ownedErr) return json(500, { error: ownedErr.message })
  if (owned && owned.length > 0) {
    return json(409, { error: 'This account owns events and cannot be made an operator' })
  }

  // ── Set the operator row (upsert: the trigger usually created it) ─
  const { data: saved, error: upsertErr } = await sb.from('leod_users').upsert({
    id:         newId,
    email,
    name,
    role,
    active:     true,
    invited_by: teamOwner,
  }, { onConflict: 'id' }).select('id')
  if (upsertErr || !saved?.length) {
    const why = upsertErr?.message ?? 'no row'
    // Undo the invite, but only for an account this request created: an
    // older account (an earlier, unconfirmed invite) is never deleted here.
    const created = Date.parse(String(inviteData.user.created_at ?? ''))
    if (Number.isFinite(created) && created >= startedAt - 5_000) {
      const { error: delErr } = await sb.auth.admin.deleteUser(newId)
      if (delErr) {
        return json(500, { error: `The operator row was not saved (${why}) and the new account could not be removed (${delErr.message})` })
      }
      return json(500, { error: `The operator row was not saved (${why}); the invite was withdrawn` })
    }
    return json(500, { error: `Invite sent but the operator row was not saved: ${why}` })
  }

  // ── Audit log (best-effort, but a failure is logged) ──────────
  const { error: logErr } = await sb.from('leod_event_log').insert({
    event_id:      null,
    session_id:    null,
    action:        'OPERATOR_INVITED',
    operator_id:   user.id,
    operator_role: 'director',
    payload:       { invited_email: email, assigned_role: role, invited_user_id: newId, team_owner: teamOwner },
    server_time_ms: Date.now(),
  })
  if (logErr) console.error('OPERATOR_INVITED log failed:', logErr.message)

  return new Response(
    JSON.stringify({ ok: true, user_id: newId, role }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
