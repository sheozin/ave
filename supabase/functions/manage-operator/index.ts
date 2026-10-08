// manage-operator: a director changes one person's membership of an event
// (event teams, spec docs/superpowers/specs/2026-10-08-event-teams-design.md §4):
// set_role, suspend, reactivate, remove.
//  * With event_id: that event only; the caller must be its creator or an
//    active director member.
//  * Without event_id: every event the caller created that the person is on
//    ("remove from all my events"). Consoles from before event teams send no
//    event_id, so their suspend and role changes land here too.
// Remove deletes the membership only. The login, the leod_users row and the
// person's other events (including their own) are never touched: no ban.
// Never on yourself; never on an event's creator (they are not a member).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { eventRole } from '../_shared/transition.ts'
import { MEMBER_ROLES, UUID, logMemberChange } from '../_shared/members.ts'

const VALID_ACTIONS = new Set(['suspend', 'reactivate', 'remove', 'set_role'])
const LOG_ACTION: Record<string, string> = {
  suspend: 'MEMBER_SUSPENDED', reactivate: 'MEMBER_REACTIVATED', remove: 'MEMBER_REMOVED', set_role: 'MEMBER_ROLE_CHANGED',
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
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
  const action   = String(body.action || '').trim()
  const targetId = String(body.user_id || '').trim()
  const newRole  = String(body.role || '').trim()
  if (!VALID_ACTIONS.has(action)) return json(400, { error: 'Invalid action: must be suspend, reactivate, remove or set_role' })
  if (action === 'set_role' && !MEMBER_ROLES.has(newRole)) return json(400, { error: 'Invalid role' })
  if (!UUID.test(targetId)) return json(400, { error: 'Missing user_id' })
  if (targetId === user.id) return json(400, { error: 'Cannot perform this action on your own account' })
  const hasEvent = body.event_id !== undefined && body.event_id !== null
  if (hasEvent && !(typeof body.event_id === 'string' && UUID.test(body.event_id))) {
    return json(400, { error: 'Invalid event_id' })
  }

  // ── The events this request may touch ──────────────────────────
  let events: string[]
  if (hasEvent) {
    const eventId = body.event_id as string
    let role: string | null
    try { role = await eventRole(sb, user.id, eventId) } catch (e) { return json(500, { error: (e as Error).message }) }
    if (role !== 'director') return json(403, { error: 'Forbidden: only the directors of this event can change its team' })
    events = [eventId]
  } else {
    const { data: own, error: ownErr } = await sb.from('leod_events').select('id').eq('created_by', user.id)
    if (ownErr) return json(500, { error: ownErr.message })
    events = (own ?? []).map((e: { id: string }) => e.id)
  }

  // ── The person's memberships on them ───────────────────────────
  // One query for all of them (an organiser may have many events).
  let targets: { event_id: string; role: string }[] = []
  if (events.length) {
    const { data: ms, error: mErr } = await sb.from('leod_event_members').select('event_id, role')
      .eq('user_id', targetId).in('event_id', events)
    if (mErr) return json(500, { error: mErr.message })
    targets = ms ?? []
  }
  if (!targets.length) return json(404, { error: 'This person is not on the team of this event', code: 'not_member' })

  // ── Change each membership; log each in its own event's log ────
  const done: string[] = []
  for (const m of targets) {
    const { data, error } = action === 'remove'
      ? await sb.from('leod_event_members').delete()
          .eq('event_id', m.event_id).eq('user_id', targetId).select('user_id')
      : await sb.from('leod_event_members').update(action === 'set_role' ? { role: newRole } : { active: action === 'reactivate' })
          .eq('event_id', m.event_id).eq('user_id', targetId).select('user_id')
    if (error || !data?.length) {
      const why = error?.message ?? 'no membership row changed'
      return json(500, { error: done.length ? `Changed on ${done.length} events, then failed: ${why}` : why, events: done })
    }
    done.push(m.event_id)
    await logMemberChange(sb, m.event_id, user.id, LOG_ACTION[action],
      action === 'set_role' ? { target_user_id: targetId, from_role: m.role, role: newRole } : { target_user_id: targetId })
  }
  return json(200, action === 'set_role' ? { ok: true, action, role: newRole, events: done } : { ok: true, action, events: done })
})
