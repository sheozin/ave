// supabase/functions/checkin-invite-staff/index.ts
// Organizer lists, adds or removes desk staff for one event. A new address
// gets a Supabase invite carrying checkin_staff = 'true', which migration
// 059's signup trigger turns into a check-in-only leod_users row (never
// a director). An existing CueDeck user just gets the grant and a short
// notice email, unless they have never signed in: then the first invite
// was lost or expired, so they get a fresh invite (or set-password) link,
// also when re-invited with the role they already hold. Removing deletes
// the grant only; the login is theirs.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
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
  if (!event_id || !['invite', 'remove', 'list'].includes(action)) return json({ error: 'event_id and action required' }, 400)

  const { data: me, error: meErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).maybeSingle()
  if (meErr) return json({ error: meErr.message }, 500)
  if (me?.role !== 'organizer') return json({ error: 'Forbidden, organizers only' }, 403)

  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('name, created_by').eq('id', event_id).single()
  if (evErr || !ev) return json({ error: evErr?.message || 'Event not found' }, 404)

  if (action === 'list') {
    const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
      .select('user_id, role').eq('event_id', event_id).in('role', ['organizer', 'crew'])
    if (opsErr) return json({ error: opsErr.message }, 500)
    const ids = (ops || []).map(o => o.user_id)
    const { data: people, error: pErr } = ids.length
      ? await sb.from('leod_users').select('id, email, name').in('id', ids)
      : { data: [], error: null }
    if (pErr) return json({ error: pErr.message }, 500)
    const byId = new Map((people || []).map(p => [p.id, p]))
    return json({ ok: true, staff: (ops || []).map(o => ({
      user_id: o.user_id, role: o.role,
      email: byId.get(o.user_id)?.email ?? null, name: byId.get(o.user_id)?.name ?? null,
      is_owner: o.user_id === ev.created_by,
    })) })
  }

  if (action === 'remove') {
    const target = String(body.user_id || '')
    if (!target) return json({ error: 'user_id required' }, 400)
    const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
      .select('user_id, role').eq('event_id', event_id).in('role', ['organizer', 'crew'])
    if (opsErr) return json({ error: opsErr.message }, 500)
    const row = (ops || []).find(o => o.user_id === target)
    if (!row) return json({ error: 'Not on this event' }, 404)
    if (target === ev.created_by) return json({ error: 'The event owner cannot be removed', code: 'event_owner' }, 409)
    if (row.role === 'organizer' && (ops || []).filter(o => o.role === 'organizer').length <= 1) {
      return json({ error: 'An event needs at least one organizer', code: 'last_organizer' }, 409)
    }
    const { error: delErr } = await sb.from('leod_checkin_operators').delete().eq('event_id', event_id).eq('user_id', target)
    if (delErr) return json({ error: delErr.message }, 500)
    return json({ ok: true })
  }

  const email = normalizeInviteEmail(body.email)
  const role = body.role === 'organizer' ? 'organizer' : body.role === 'crew' ? 'crew' : null
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (!email || !role) return json({ error: 'A valid email and role are required' }, 400)

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
    if (cur && cur.role !== role) {
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
      .insert({ event_id, user_id: userId, role })
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
      html: `<p>You have been invited to the check-in desk for <b>${escapeHtml(ev.name)}</b>.</p>` +
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
      html: `<p>You can now open the check-in desk for <b>${escapeHtml(ev.name)}</b>.</p>` +
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
