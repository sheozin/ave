// supabase/functions/checkin-invite-staff/index.ts
// People on one check-in event: list, invite and remove them, plus two
// owner-only actions, transfer_owner and archive_event. Who may do what
// comes from _shared/checkin-roles.ts through the pure decisions in
// _shared/checkin-gates.ts (design:
// docs/superpowers/specs/2026-10-04-checkin-roles-design.md).
//
// A new address gets a Supabase invite carrying checkin_staff = 'true',
// which handle_new_auth_user turns into a check-in-only leod_users row
// (never a director) for every role, lead and viewer included (ruling 9).
// An existing CueDeck user just gets the grant and a short notice email,
// unless they have never signed in: then the first invite was lost or
// expired, so they get a fresh invite (or set-password) link, also when
// re-invited with the role they already hold. Removing deletes the grant
// only; the login is theirs.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'
import { isUuid, loadCallerRole, removeVerdict, GRANT_ROLES, type GrantRole } from '../_shared/checkin-roles.ts'
import {
  archiveVerdict, inviteRoleVerdict, removeResponse, staffGate, transferVerdict, type GateVerdict,
} from '../_shared/checkin-gates.ts'

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const ACTIONS = ['list', 'invite', 'remove', 'transfer_owner', 'archive_event']

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  const refuse = (v: Exclude<GateVerdict, { ok: true }>) => json(v.body, v.status)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: caller, error: callerErr } = await sb.from('leod_users')
    .select('active').eq('id', user.id).maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 500)
  if (!caller || caller.active === false) return json({ error: 'Account inactive' }, 403)

  const event_id = String(body.event_id || '')
  const action = String(body.action || '')
  if (!isUuid(event_id) || !ACTIONS.includes(action)) return json({ error: 'event_id and action required' }, 400)

  const callerRole = await loadCallerRole(sb, event_id, user.id)
  const gate = staffGate(callerRole)
  if (!gate.ok) return refuse(gate)
  const role = callerRole.role

  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('name, created_by, created_via').eq('id', event_id).maybeSingle()
  if (evErr) return json({ error: evErr.message }, 500)
  if (!ev) return json({ error: 'Event not found' }, 404)

  const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
    .select('user_id, role').eq('event_id', event_id).in('role', GRANT_ROLES)
  if (opsErr) return json({ error: opsErr.message }, 500)
  const team: { user_id: string; role: string }[] = ops || []

  if (action === 'list') {
    const ids = team.map(o => o.user_id)
    const { data: people, error: pErr } = ids.length
      ? await sb.from('leod_users').select('id, email, name').in('id', ids)
      : { data: [], error: null }
    if (pErr) return json({ error: pErr.message }, 500)
    // Complimentary status follows the owner (ruling 3), so the owner's
    // transfer dialog needs it for each organizer. Nobody else sees it.
    let comp = new Set<string>()
    if (role === 'owner' && ids.length) {
      const { data: comps, error: cErr } = await sb.from('leod_checkin_comp_accounts').select('user_id').in('user_id', ids)
      if (cErr) return json({ error: cErr.message }, 500)
      comp = new Set((comps || []).map((c: { user_id: string }) => c.user_id))
    }
    const byId = new Map((people || []).map((p: { id: string; email: string | null; name: string | null }) => [p.id, p]))
    return json({ ok: true, staff: team.map(o => ({
      user_id: o.user_id, role: o.role,
      email: byId.get(o.user_id)?.email ?? null, name: byId.get(o.user_id)?.name ?? null,
      is_owner: o.user_id === ev.created_by,
      ...(role === 'owner' ? { is_comp: comp.has(o.user_id) } : {}),
    })) })
  }

  if (action === 'remove') {
    const target = String(body.user_id || '')
    if (!isUuid(target)) return json({ error: 'user_id required' }, 400)
    const verdict = removeResponse(removeVerdict(role, target, ev.created_by, team))
    if (!verdict.ok) return refuse(verdict)
    const { error: delErr } = await sb.from('leod_checkin_operators').delete().eq('event_id', event_id).eq('user_id', target)
    if (delErr) return json({ error: delErr.message }, 500)
    return json({ ok: true })
  }

  if (action === 'transfer_owner') {
    const target = String(body.user_id || '')
    const verdict = transferVerdict({
      role, createdVia: ev.created_via ?? null, callerId: user.id, targetId: target, targetIsUuid: isUuid(target), team,
    })
    if (!verdict.ok) return refuse(verdict)
    // Complimentary status is read from created_by, so it moves with the
    // owner (ruling 3). Read both sides first so the answer can say so.
    const { data: comps, error: cErr } = await sb.from('leod_checkin_comp_accounts')
      .select('user_id').in('user_id', [user.id, target])
    if (cErr) return json({ error: cErr.message }, 500)
    const compIds = new Set((comps || []).map((c: { user_id: string }) => c.user_id))
    // The old owner stays on as an organizer.
    const { error: keepErr } = await sb.from('leod_checkin_operators')
      .upsert({ event_id, user_id: user.id, role: 'organizer' }, { onConflict: 'event_id,user_id' })
    if (keepErr) return json({ error: keepErr.message }, 500)
    // Compare-and-set on created_by: two tabs transferring at once cannot both win.
    const { data: moved, error: mvErr } = await sb.from('leod_events')
      .update({ created_by: target }).eq('id', event_id).eq('created_by', user.id).select('id')
    if (mvErr) return json({ error: mvErr.message }, 500)
    if (!moved || moved.length === 0) return json({ error: 'Ownership has already changed. Reload the page.', code: 'owner_changed' }, 409)
    const wasComp = compIds.has(user.id)
    const isComp = compIds.has(target)
    return json({
      ok: true, owner_id: target, previous_owner_role: 'organizer',
      was_comp: wasComp, is_comp: isComp, comp_changed: wasComp !== isComp,
    })
  }

  if (action === 'archive_event') {
    const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
      .select('status').eq('event_id', event_id).maybeSingle()
    if (entErr) return json({ error: entErr.message }, 500)
    const verdict = archiveVerdict({ role, createdVia: ev.created_via ?? null, entStatus: ent?.status ?? null })
    if (!verdict.ok) return refuse(verdict)
    const { data: gone, error: arErr } = await sb.from('leod_events')
      .update({ active: false }).eq('id', event_id).eq('created_by', user.id).select('id')
    if (arErr) return json({ error: arErr.message }, 500)
    if (!gone || gone.length === 0) return json({ error: 'Ownership has changed. Reload the page.', code: 'owner_changed' }, 409)
    return json({ ok: true })
  }

  // ── invite ──
  const email = normalizeInviteEmail(body.email)
  const want: GrantRole | null = typeof body.role === 'string' && (GRANT_ROLES as string[]).includes(body.role)
    ? body.role as GrantRole : null
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (!email || !want) return json({ error: 'A valid email and role are required' }, 400)
  const allowed = inviteRoleVerdict(role, want)
  if (!allowed.ok) return refuse(allowed)

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: eventCount, error: ecErr } = await sb.from('leod_checkin_invite_log')
    .select('id', { count: 'exact', head: true }).eq('event_id', event_id).gte('created_at', since)
  if (ecErr) return json({ error: ecErr.message }, 500)
  const { count: inviterCount, error: icErr } = await sb.from('leod_checkin_invite_log')
    .select('id', { count: 'exact', head: true }).eq('inviter_id', user.id).gte('created_at', since)
  if (icErr) return json({ error: icErr.message }, 500)
  if ((eventCount ?? 0) >= 50 || (inviterCount ?? 0) >= 100) {
    return json({ error: 'Invite limit reached for today', code: 'invite_rate' }, 429)
  }

  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const likeSafe = email.replace(/[\\%_]/g, (m) => '\\' + m)
  const { data: existing, error: exErr } = await sb.from('leod_users')
    .select('id').ilike('email', likeSafe).maybeSingle()
  if (exErr) return json({ error: exErr.message }, 500)

  // What the invitee is being let into, in the email's words.
  const what = want === 'viewer' ? 'the live check-in dashboard' : 'the check-in desk'

  let userId: string
  let isNew = false
  let needsLink = false        // existing account that has never signed in
  let unconfirmed = false
  let alreadyGranted = false
  if (existing) {
    userId = existing.id
    const { data: cur, error: curErr } = await sb.from('leod_checkin_operators')
      .select('role').eq('event_id', event_id).eq('user_id', userId).maybeSingle()
    if (curErr) return json({ error: curErr.message }, 500)
    if (cur && cur.role !== want) {
      return json({ error: 'This person is already on this event with another role', code: 'already_on_event' }, 409)
    }
    const { data: au, error: auErr } = await sb.auth.admin.getUserById(userId)
    if (auErr || !au?.user) {
      console.error('checkin-invite-staff: auth user lookup failed', auErr?.code ?? auErr?.status ?? 'missing')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    needsLink = !au.user.last_sign_in_at
    unconfirmed = !au.user.email_confirmed_at
    alreadyGranted = !!cur
    // Same role, already signed in before: nothing to do.
    if (alreadyGranted && !needsLink) return json({ ok: true })
  } else {
    const { data: inv, error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { checkin_staff: 'true', name },
      redirectTo: `${appUrl}/checkin`,
    })
    if (invErr || !inv?.user) {
      console.error('checkin-invite-staff: invite failed', invErr?.code ?? invErr?.status ?? 'unknown')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    userId = inv.user.id
    isNew = true
  }

  if (!alreadyGranted) {
    const { error: grantErr } = await sb.from('leod_checkin_operators')
      .insert({ event_id, user_id: userId, role: want })
    if (grantErr) return json({ error: grantErr.message }, 500)
  }

  if (needsLink) {
    const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
      type: unconfirmed ? 'invite' : 'recovery',
      email,
      options: { redirectTo: `${appUrl}/checkin` },
    })
    const actionLink = link?.properties?.action_link
    if (linkErr || !actionLink) {
      console.error('checkin-invite-staff: invite link failed', linkErr?.code ?? linkErr?.status ?? 'no link')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: 'Your CueDeck Check-in invitation',
      html: `<p>You have been invited to ${what} for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${escapeHtml(actionLink)}">Accept the invitation and set your password</a></p>` +
            `<p>This link works once. If it has expired, ask the organizer to invite you again.</p>`,
      fromName: 'CueDeck Check-in',
    })
    if (mailErr) {
      console.error('checkin-invite-staff: invite link email failed for event', event_id, mailErr)
      return json({ error: 'Could not send the invitation' }, 502)
    }
  } else if (!isNew) {
    const safeName = ev.name.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 80)
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added to ${safeName} check-in`,
      html: `<p>You can now open ${what} for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${appUrl}/checkin">Open CueDeck Check-in</a> and sign in with your CueDeck login.</p>`,
      fromName: 'CueDeck Check-in',
    })
    // The grant is in place; a lost notice is not worth failing the
    // request over, but it must be visible.
    if (mailErr) console.error('checkin-invite-staff: notice email failed for event', event_id, mailErr)
  }

  const { error: logErr } = await sb.from('leod_checkin_invite_log').insert({ event_id, inviter_id: user.id })
  if (logErr) console.error('checkin-invite-staff: invite log insert failed', logErr.message)

  return json({ ok: true })
})
