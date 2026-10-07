// supabase/functions/checkin-held/index.ts
// Waitlist and approval (migration 108): the organizer moves a held guest
// onto the guest list, and the guest gets their QR code by email.
//
//   POST { event_id, action: 'release', held_id }   one guest
//   POST { event_id, action: 'fill' }                the waitlist, in order,
//                                                    into the free places
// Owner and organizers only (FUNCTION_GATES 'checkin-held'). Turning a
// guest away needs no email and is the RPC checkin_held_remove.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { sendQrEmailsForAttendees, withBrand } from '../_shared/qr-email.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400)
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const event_id = String(body.event_id || '')
  if (!UUID.test(event_id)) return json({ error: 'Missing event_id' }, 400)
  const gate = functionGate('checkin-held', await loadCallerRole(sb, event_id, user.id))
  if (!gate.ok) return json(gate.body, gate.status)

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status, registration_capacity').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent?.checkin_core) return json({ error: 'Check-in is not enabled for this event' }, 403)
  const { data: event, error: evErr } = await sb.from('leod_events').select('name, date, venue').eq('id', event_id).maybeSingle()
  if (evErr || !event) return json({ error: 'Event not found' }, 404)

  let ids: string[] = []
  if (body.action === 'release') {
    const id = String(body.held_id || '')
    if (!UUID.test(id)) return json({ error: 'Missing held_id' }, 400)
    ids = [id]
  } else if (body.action === 'fill') {
    // The waitlist, oldest first, into the places capacity leaves free.
    const test = ent.status !== 'live'
    if (!ent.registration_capacity) return json({ error: 'Set a capacity first: with no capacity there are no free places to fill.' }, 400)
    // Places taken as the registration page counts them (orders being paid
    // hold theirs, 109), and a guest comes with their plus-ones (114): the
    // queue is filled in order while whole parties fit.
    const { data: taken, error: cErr } = await sb.rpc('checkin_web_places_taken', { p_event_id: event_id, p_test: test })
    if (cErr) return json({ error: cErr.message }, 500)
    let free = Math.max(0, ent.registration_capacity - Number(taken ?? 0))
    if (!free) return json({ ok: true, released: 0, emailed: 0, free: 0 })
    const { data: rows, error: hErr } = await sb.from('leod_checkin_held').select('id, plus_ones')
      .eq('event_id', event_id).eq('kind', 'waitlist').eq('is_test', test).order('created_at').limit(500)
    if (hErr) return json({ error: hErr.message }, 500)
    for (const r of rows ?? []) {
      const need = 1 + (Array.isArray(r.plus_ones) ? r.plus_ones.length : 0)
      if (need > free) break
      ids.push(r.id); free -= need
    }
  } else {
    return json({ error: 'Bad request' }, 400)
  }

  const branded = await withBrand(sb, event_id, { name: event.name, date: event.date, venue: event.venue })
  let released = 0, emailed = 0
  const failed: string[] = []
  for (const id of ids) {
    const { data: out, error } = await sb.rpc('checkin_web_release_held', { p_event_id: event_id, p_held_id: id })
    if (error || !out) { console.error('checkin-held: release failed', error?.code); failed.push(id); continue }
    if (out.status !== 'released') continue
    released++
    // Test mode never emails guests (as everywhere else in check-in).
    if (!out.is_test && out.attendee) {
      const res = await sendQrEmailsForAttendees(sb, branded, [out.attendee])
      if (res.some(r => r.status === 'error')) console.error('checkin-held: QR email failed, attendee', out.attendee.id)
      else emailed++
      // (114) Their plus-ones' tickets go to them too.
      const plus = Array.isArray(out.plus_ones) ? out.plus_ones : []
      if (plus.length && out.attendee.email) {
        const pr = await sendQrEmailsForAttendees(sb, branded, plus.map((p: { id: string; first_name: string; qr_token: string }) => ({ ...p, email: null })),
          { overrideTo: out.attendee.email, guestOf: out.attendee.first_name })
        if (pr.some(r => r.status === 'error')) console.error('checkin-held: plus-one QR email failed, guest', out.attendee.id)
      }
    }
  }
  console.log('checkin-held:', body.action, 'released', released, 'emailed', emailed, 'event', event_id)
  return json({ ok: failed.length === 0, released, emailed, failed: failed.length })
})
