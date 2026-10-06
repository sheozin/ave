// invite-operator — Director invites a crew member by email.
// Creates the auth account with generateLink (Supabase sends nothing) and
// emails the link itself through _shared/invite-email.ts, so the invitation
// names the event the director has open, who invited them and the role.
// then sets the leod_users row the auth trigger (handle_new_auth_user)
// already created as a self-registered director: role, invited_by, active.
// The operator joins the caller's team: invited_by is the event owner, also
// when an invited director sends the invite.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendInviteEmail } from '../_shared/invite-email.ts'

const VALID_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])
const ROLE_TEXT: Record<string, string> = {
  director: 'the Director role', stage: 'the Stage role', av: 'the AV role',
  interp: 'the Interpretation role', reg: 'the Registration role', signage: 'the Signage role',
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
    .select('role, invited_by, active, name, email').eq('id', user.id).maybeSingle()
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

  // ── Rate limit: 20 invitations per team per 24 hours ──────────
  // The email is ours now, not Supabase's, so Supabase's own invite rate
  // limit no longer applies. Counted from the audit log before anything is
  // created or sent; a failed count refuses rather than sends.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString()
  const { count: sent, error: countErr } = await sb.from('leod_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'OPERATOR_INVITED').eq('payload->>team_owner', teamOwner).gte('ts', since)
  if (countErr) { console.error('invite-operator: invite count failed', countErr.code); return json(503, { error: 'Could not send the invitation right now. Try again shortly.' }) }
  if ((sent ?? 0) >= 20) return json(429, { error: 'Your team has sent 20 invitations in the last 24 hours. Try again later.', code: 'invite_rate' })

  // ── The event to name in the invitation ───────────────────────
  // Only an event the director's team owns: a forged id must not put another
  // team's event name into an email to an address the caller chose.
  let event: { name: string; date: string | null } | null = null
  const eventId = typeof body.event_id === 'string' && UUID.test(body.event_id) ? body.event_id : null
  if (eventId) {
    const { data: ev, error: evErr } = await sb.from('leod_events')
      .select('name, date, created_by').eq('id', eventId).maybeSingle()
    if (evErr) console.error('invite-operator: event read failed', evErr.code)
    else if (ev && ev.created_by === teamOwner) event = { name: ev.name, date: ev.date }
  }

  // ── Create the account and its link; Supabase sends no email ───
  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const { data: linkData, error: inviteErr } = await sb.auth.admin.generateLink({
    type: 'invite', email,
    options: { data: { name: name || '', invited_role: role }, redirectTo: appUrl },
  })
  const actionLink = linkData?.properties?.action_link
  if (inviteErr || !linkData?.user || !actionLink) {
    return new Response(
      JSON.stringify({ error: inviteErr?.message ?? 'Could not create the invitation' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }
  const inviteData = { user: linkData.user }

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

  // ── The invitation email ──────────────────────────────────────
  const { error: mailErr } = await sendInviteEmail({
    to: email, product: 'console', eventName: event?.name ?? null, eventDate: event?.date ?? null,
    inviterName: callerRow.name || callerRow.email || null, roleText: ROLE_TEXT[role],
    actionUrl: actionLink, actionLabel: 'Accept the invitation',
  })
  if (mailErr) {
    // No email means no way in: withdraw what this request created.
    const created = Date.parse(String(inviteData.user.created_at ?? ''))
    if (Number.isFinite(created) && created >= startedAt - 5_000) {
      const { error: delErr } = await sb.auth.admin.deleteUser(newId)
      if (delErr) return json(500, { error: `The invitation email failed (${mailErr}) and the new account could not be removed (${delErr.message})` })
    }
    return json(502, { error: 'The invitation email could not be sent. Nothing was created; try again.' })
  }

  // ── Audit log (best-effort, but a failure is logged) ──────────
  const { error: logErr } = await sb.from('leod_event_log').insert({
    event_id:      null,
    session_id:    null,
    action:        'OPERATOR_INVITED',
    operator_id:   user.id,
    operator_role: 'director',
    payload:       { invited_email: email, assigned_role: role, invited_user_id: newId, team_owner: teamOwner, event_id: event ? eventId : null },
    server_time_ms: Date.now(),
  })
  if (logErr) console.error('OPERATOR_INVITED log failed:', logErr.message)

  return new Response(
    JSON.stringify({ ok: true, user_id: newId, role }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
