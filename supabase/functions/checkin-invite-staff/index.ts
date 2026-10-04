// supabase/functions/checkin-invite-staff/index.ts
// Organizer lists, adds or removes desk staff for one event. A new address
// gets a Supabase invite carrying checkin_staff = 'true', which migration
// 059's signup trigger turns into a check-in-only leod_users row (never
// a director). An existing CueDeck user just gets the grant and a short
// notice email. Removing deletes the grant only; the login is theirs.

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

  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const likeSafe = email.replace(/[\\%_]/g, (m) => '\\' + m)
  const { data: existing, error: exErr } = await sb.from('leod_users')
    .select('id').ilike('email', likeSafe).maybeSingle()
  if (exErr) return json({ error: exErr.message }, 500)

  let userId: string
  let invited = false
  if (existing) {
    userId = existing.id
  } else {
    const { data: inv, error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { checkin_staff: 'true', name },
      redirectTo: `${appUrl}/checkin`,
    })
    if (invErr || !inv?.user) return json({ error: invErr?.message || 'Invite failed' }, 502)
    userId = inv.user.id
    invited = true
  }

  const { error: grantErr } = await sb.from('leod_checkin_operators')
    .upsert({ event_id, user_id: userId, role }, { onConflict: 'event_id,user_id' })
  if (grantErr) return json({ error: grantErr.message }, 500)

  if (!invited) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added to ${ev.name} check-in`,
      html: `<p>You can now open the check-in desk for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${appUrl}/checkin">Open CueDeck Check-in</a> and sign in with your CueDeck login.</p>`,
      fromName: 'CueDeck Check-in',
    })
    // The grant is in place; a lost notice is not worth failing the
    // request over, but it must be visible.
    if (mailErr) console.error('checkin-invite-staff: notice email failed for event', event_id, mailErr)
  }

  return json({ ok: true, user_id: userId, invited })
})
