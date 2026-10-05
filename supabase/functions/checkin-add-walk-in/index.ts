// supabase/functions/checkin-add-walk-in/index.ts
// A desk lead or above adds a person who is standing at the desk (roles
// ruling 7). Service role, because checkin_guard_attendee_insert refuses
// is_test from any JWT caller, and a test-mode walk-in must be is_test so
// it counts toward the test cap and is cleared at go-live.
// The desk then checks the person in through the normal outbox.
//
//   POST { event_id, first_name, last_name, email?, company?, ticket_type? }
//   -> { ok: true, attendee: { id, event_id, first_name, last_name, email,
//        company, ticket_type, qr_token, checked_in_at, badge_printed_at } }
//   Errors: 400 invalid, 403 forbidden / test_cap, 409 archived /
//   already_registered.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { TEST_CAP } from '../_shared/checkin-policy.ts'
import { isUuid, loadCallerRole } from '../_shared/checkin-roles.ts'
import { ARCHIVED, functionGate } from '../_shared/checkin-gates.ts'
import { normalizeWalkIn } from '../_shared/checkin-walk-in.ts'

const COLS = 'id,event_id,first_name,last_name,email,company,ticket_type,qr_token,checked_in_at,badge_printed_at'
const ALREADY = { error: 'Someone with this email is already on the list. Search for them instead.', code: 'already_registered' }

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad request' }, 400)
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
  if (!isUuid(event_id)) return json({ error: 'event_id required', code: 'invalid' }, 400)

  // Owner, organizer or desk lead (checkin-roles.ts 'walk_in').
  const gate = functionGate('checkin-add-walk-in', await loadCallerRole(sb, event_id, user.id))
  if (!gate.ok) return json(gate.body, gate.status)

  // A deleted (archived) event takes no new people, as in checkin-invite-staff.
  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('active').eq('id', event_id).maybeSingle()
  if (evErr) return json({ error: evErr.message }, 500)
  if (!ev) return json({ error: 'Event not found' }, 404)
  if (ev.active === false) return json({ ...ARCHIVED }, 409)

  // The service-role client bypasses RLS, so the entitlement is re-checked here.
  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent?.checkin_core) return json({ error: 'Check-in is not enabled for this event', code: 'forbidden' }, 403)

  const parsed = normalizeWalkIn(body)
  if (!parsed.ok) return json({ error: parsed.error, code: 'invalid' }, 400)

  // Same key the import dedupes on: email, case-insensitive, per event.
  // The unique index (event_id, lower(email)) still decides a race below.
  if (parsed.row.email) {
    const likeSafe = parsed.row.email.replace(/[\\%_]/g, (m) => '\\' + m)
    const { data: dup, error: dupErr } = await sb.from('leod_checkin_attendees')
      .select('id').eq('event_id', event_id).ilike('email', likeSafe).limit(1)
    if (dupErr) return json({ error: dupErr.message }, 500)
    if (dup && dup.length) return json(ALREADY, 409)
  }

  const isTest = ent.status !== 'live'
  if (isTest) {
    const { data: used, error: usedErr } = await sb.rpc('checkin_test_usage', { p_event_id: event_id })
    if (usedErr || typeof used !== 'number') {
      console.error('checkin-add-walk-in: test usage read failed for event', event_id, usedErr?.code)
      return json({ error: 'The walk-in was not added' }, 500)
    }
    if (used >= TEST_CAP) {
      return json({ error: 'This event is in test mode and has used its ' + TEST_CAP + ' test check-ins. Go live to keep adding people.', code: 'test_cap' }, 403)
    }
  }

  const { data: created, error: insErr } = await sb.from('leod_checkin_attendees')
    .insert({
      event_id,
      ...parsed.row,
      qr_token: crypto.randomUUID().replace(/-/g, ''),
      source: 'walk_in',
      is_test: isTest,
    })
    .select(COLS)
    .single()
  if (insErr) {
    // Migration 050's unique index on (event_id, lower(email)).
    if (insErr.code === '23505') return json(ALREADY, 409)
    console.error('checkin-add-walk-in: insert failed for event', event_id, insErr.code)
    return json({ error: 'The walk-in was not added' }, 500)
  }
  return json({ ok: true, attendee: created })
})
