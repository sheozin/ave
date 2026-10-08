// invite-operator: a director adds a person to ONE event with ONE role
// (event teams, spec docs/superpowers/specs/2026-10-08-event-teams-design.md §4).
//  * A new email gets an account (auth.admin.generateLink, Supabase sends
//    nothing), a membership on this event, and the branded invitation that
//    names the event, the inviter and the role.
//  * An existing account (any organiser, any role) gets the membership and a
//    short "added to" email with a link to the console: no signup, no
//    password step. If it never signed in, a fresh link instead.
//  * Already on this event with the same role: nothing changes or is sent.
//    With another role: the role is changed, nothing is sent.
// Who: the event's creator and its active director members (eventRole).
// Seats: the event owner's plan (cuedeck_event_seats_of), checked before
// anything is created; the membership insert checks again in the database
// (trigger, migration 133), so two invites cannot both take the last seat.
// Rate limit: 20 invitations per event owner per 24 hours.
// The account's own leod_users role and team link are never written here.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendInviteEmail } from '../_shared/invite-email.ts'
import { eventRole } from '../_shared/transition.ts'
import { MEMBER_ROLES, UUID, logMemberChange } from '../_shared/members.ts'

const ROLE_TEXT: Record<string, string> = {
  director: 'the Director role', stage: 'the Stage role', av: 'the AV role',
  interp: 'the Interpretation role', reg: 'the Registration role', signage: 'the Signage role',
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const startedAt = Date.now()
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }

  // Ping support (deploy verification)
  if (body._ping) return json(200, { pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json(401, { error: 'Unauthorized' })
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json(401, { error: 'Unauthorized' })

  // ── Input ──────────────────────────────────────────────────────
  const email = String(body.email || '').trim().toLowerCase()
  const role  = String(body.role || '')
  const name  = String(body.name || '').trim().slice(0, 120) || null
  const eventId = typeof body.event_id === 'string' && UUID.test(body.event_id) ? body.event_id : null
  if (!email || !MEMBER_ROLES.has(role) || !eventId) {
    return json(400, { error: 'An email, a role and the event are required' })
  }

  // ── The event, and the caller's role on it ──────────────────────
  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('id, name, date, created_by, created_via').eq('id', eventId).maybeSingle()
  if (evErr) return json(500, { error: evErr.message })
  let callerRole: string | null = null
  if (ev) {
    try { callerRole = await eventRole(sb, user.id, eventId) } catch (e) { return json(500, { error: (e as Error).message }) }
  }
  // An unknown event and someone else's event answer alike.
  if (!ev || callerRole !== 'director') return json(403, { error: 'Forbidden: only the directors of this event can invite' })
  if (ev.created_via !== 'console') {
    return json(400, { error: 'Check-in events invite their staff from Check-in', code: 'not_console_event' })
  }
  const owner: string = ev.created_by
  const isOwner = owner === user.id

  // ── The person: an existing account, or none yet ───────────────
  const { data: existing, error: exErr } = await sb.from('leod_users').select('id').eq('email', email).maybeSingle()
  if (exErr) return json(500, { error: exErr.message })
  if (existing?.id === owner) {
    return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
  }
  let current: { role: string; active: boolean } | null = null
  if (existing) {
    const { data: m, error: mErr } = await sb.from('leod_event_members').select('role, active')
      .eq('event_id', eventId).eq('user_id', existing.id).maybeSingle()
    if (mErr) return json(500, { error: mErr.message })
    current = m
  }

  // ── On this event with another role: change it, send nothing ───
  if (existing && current && current.role !== role) {
    const { data: upd, error: upErr } = await sb.from('leod_event_members').update({ role })
      .eq('event_id', eventId).eq('user_id', existing.id).select('user_id')
    if (upErr) return json(500, { error: upErr.message })
    if (!upd?.length) return json(500, { error: 'No membership row updated' })
    await logMemberChange(sb, eventId, user.id, 'MEMBER_ROLE_CHANGED',
      { target_user_id: existing.id, from_role: current.role, role, event_owner: owner })
    return json(200, { ok: true, user_id: existing.id, role, result: 'role_changed' })
  }

  // ── An existing account: has it ever signed in? ─────────────────
  let signedIn = false
  let confirmed = false
  if (existing) {
    const { data: au, error: auErr } = await sb.auth.admin.getUserById(existing.id)
    if (auErr || !au?.user) {
      console.error('invite-operator: auth user lookup failed', auErr?.status ?? 'missing')
      return json(502, { error: 'Could not send the invitation' })
    }
    signedIn = !!au.user.last_sign_in_at
    confirmed = !!au.user.email_confirmed_at
    // Same role on this event, and the login works: nothing to do.
    if (current && signedIn) return json(200, { ok: true, user_id: existing.id, role, result: 'unchanged' })
  }

  // ── Rate limit: 20 invitations per event owner per 24 hours ─────
  // Counted from the event logs before anything is created or sent; a
  // failed count refuses rather than sends.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString()
  const { count: sent, error: countErr } = await sb.from('leod_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'MEMBER_INVITED').eq('payload->>event_owner', owner).gte('ts', since)
  if (countErr) {
    console.error('invite-operator: invite count failed', countErr.code)
    return json(503, { error: 'Could not send the invitation right now. Try again shortly.' })
  }
  if ((sent ?? 0) >= 20) {
    return json(429, { error: 'This organiser has sent 20 invitations in the last 24 hours. Try again later.', code: 'invite_rate' })
  }

  // ── Seats, before anything is created (a new membership only) ───
  if (!current) {
    const { data: seats, error: seatErr } = await sb.rpc('cuedeck_event_seats_of', { p_event_id: eventId })
    if (seatErr || !seats) return json(500, { error: seatErr?.message ?? 'Could not read the seats of this event' })
    const s = seats as { used: number; limit: number | null }
    if (s.limit !== null && s.used >= s.limit) {
      return json(409, { error: 'All seats on this event are taken', code: 'seats_full', used: s.used, limit: s.limit, is_owner: isOwner })
    }
  }

  // ── The account and its link ───────────────────────────────────
  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const notice = !!existing && signedIn   // a working login: a short notice, nothing to accept
  let userId: string
  let createdNow = false
  let actionLink = appUrl
  if (existing) {
    userId = existing.id
    if (!signedIn) {
      // Never signed in: a fresh link, an invite if never confirmed, else a password link.
      const { data: l, error: lErr } = await sb.auth.admin.generateLink({
        type: confirmed ? 'recovery' : 'invite', email, options: { redirectTo: appUrl },
      })
      const al = l?.properties?.action_link
      if (lErr || !al) {
        console.error('invite-operator: link failed', lErr?.status ?? 'no link')
        return json(502, { error: 'Could not send the invitation' })
      }
      actionLink = al
    }
  } else {
    const { data: l, error: lErr } = await sb.auth.admin.generateLink({
      type: 'invite', email, options: { data: { name: name || '', invited_role: role }, redirectTo: appUrl },
    })
    const al = l?.properties?.action_link
    if (lErr || !l?.user || !al) return json(500, { error: lErr?.message ?? 'Could not create the invitation' })
    userId = l.user.id
    const created = Date.parse(String(l.user.created_at ?? ''))
    createdNow = Number.isFinite(created) && created >= startedAt - 5_000
    actionLink = al
    if (userId === owner) {
      return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
    }
    // The signup trigger made the leod_users row; only the typed name is added.
    if (name && createdNow) {
      const { error: nameErr } = await sb.from('leod_users').update({ name }).eq('id', userId)
      if (nameErr) console.error('invite-operator: name not saved', nameErr.message)
    }
  }
  // Undo only an account this request made: never one that existed before.
  // "Made just now" is a time window, and a concurrent invite of the same new
  // email gets the same unconfirmed user back from generateLink, so both
  // requests see it as theirs. Delete only an account that is on no event's
  // team and organises no event; otherwise it is someone else's by now
  // (deleting it would cascade their membership).
  let accountKept = false
  const removeNewAccount = async (): Promise<string | null> => {
    if (!createdNow) return null
    const { count: memberships, error: mErr } = await sb.from('leod_event_members')
      .select('event_id', { count: 'exact', head: true }).eq('user_id', userId)
    if (mErr) return mErr.message
    const { count: owned, error: oErr } = await sb.from('leod_events')
      .select('id', { count: 'exact', head: true }).eq('created_by', userId)
    if (oErr) return oErr.message
    if ((memberships ?? 0) > 0 || (owned ?? 0) > 0) { accountKept = true; return null }
    const { error } = await sb.auth.admin.deleteUser(userId)
    return error ? error.message : null
  }

  // ── The membership (the database checks the seats again) ────────
  if (!current) {
    const { error: insErr } = await sb.from('leod_event_members')
      .insert({ event_id: eventId, user_id: userId, role, active: true, invited_by: user.id })
    if (insErr) {
      const msg = String(insErr.message ?? '')
      // These three refusals undo nothing: the account may be another
      // request's (concurrent invite of the same new email), and an
      // unconfirmed account with no membership is reused by the next invite.
      if (insErr.code === '23514' && msg.startsWith('seats_full')) {
        return json(409, { error: 'All seats on this event are taken', code: 'seats_full', is_owner: isOwner })
      }
      if (insErr.code === '23514' && msg.startsWith('owner_not_member')) {
        return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
      }
      // Another director added the same person a moment ago: theirs stays.
      if (insErr.code === '23505') {
        return json(409, { error: 'This person was just added to this event', code: 'already_on_event' })
      }
      const undoErr = await removeNewAccount()
      return json(500, { error: `The membership was not saved (${msg})`
        + (createdNow && !accountKept ? (undoErr ? `; the new account could not be removed (${undoErr})` : '; the invite was withdrawn') : '') })
    }
  }

  // ── The email ──────────────────────────────────────────────────
  const { data: caller, error: callerErr } = await sb.from('leod_users').select('name, email').eq('id', user.id).maybeSingle()
  if (callerErr) console.error('invite-operator: inviter name not read', callerErr.message)
  const mail = {
    to: email, product: 'console' as const, eventName: ev.name, eventDate: ev.date ?? null,
    inviterName: caller?.name || caller?.email || null, roleText: ROLE_TEXT[role],
  }
  if (notice) {
    const { error: mailErr } = await sendInviteEmail({ ...mail, actionUrl: appUrl, actionLabel: 'Open CueDeck', existingAccount: true })
    // The membership is in place; a lost notice is logged, not failed (as check-in does).
    if (mailErr) console.error('invite-operator: added-to notice failed for event', eventId, mailErr)
  } else {
    const { error: mailErr } = await sendInviteEmail({ ...mail, actionUrl: actionLink, actionLabel: 'Accept the invitation' })
    if (mailErr) {
      // No email means no way in: take back what this request created.
      if (!current) {
        const { error: delErr } = await sb.from('leod_event_members').delete().eq('event_id', eventId).eq('user_id', userId)
        if (delErr) return json(500, { error: `The invitation email failed (${mailErr}) and the membership could not be removed (${delErr.message})` })
      }
      const undoErr = await removeNewAccount()
      if (undoErr) return json(500, { error: `The invitation email failed (${mailErr}) and the new account could not be removed (${undoErr})` })
      return json(502, { error: 'The invitation email could not be sent. Nothing was created; try again.' })
    }
  }

  await logMemberChange(sb, eventId, user.id, 'MEMBER_INVITED',
    { target_user_id: userId, role, event_owner: owner, existing_account: !!existing })
  return json(200, { ok: true, user_id: userId, role, result: existing ? (current ? 'link_resent' : 'added') : 'invited' })
})
