// supabase/functions/checkin-held/index.ts
// Waitlist and approval (migration 108): the organizer moves a held guest
// onto the guest list, and the guest gets their QR code by email.
//
//   POST { event_id, action: 'release', held_id }   one guest
//   POST { event_id, action: 'fill' }                the waitlist, in order,
//                                                    into the free places
//   POST { action: 'auto' } with x-cron-secret        (124) every event whose
//        automatic waitlist can move; pg_cron every 5 minutes, a watched job
// Owner and organizers only (FUNCTION_GATES 'checkin-held'), except 'auto'.
// Turning a guest away needs no email and is the RPC checkin_held_remove.
// Fills run in checkin_web_waitlist_fill, under the event's lock (124).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { sendQrEmailsForAttendees, withBrand } from '../_shared/qr-email.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Released = { status: string; is_test: boolean; attendee: { id: string; first_name: string; email: string | null; qr_token: string; qr_email_sent_at: string | null } | null;
                  plus_ones?: { id: string; first_name: string; qr_token: string }[] }

// The tickets of a released guest and their plus-ones. Test mode never
// emails guests (as everywhere else in check-in). True when the guest's own
// email went.
// deno-lint-ignore no-explicit-any
async function emailReleased(sb: any, branded: Awaited<ReturnType<typeof withBrand>>, out: Released): Promise<boolean> {
  if (out.is_test || !out.attendee) return false
  const res = await sendQrEmailsForAttendees(sb, branded, [out.attendee])
  const ok = !res.some(r => r.status === 'error')
  if (!ok) console.error('checkin-held: QR email failed, attendee', out.attendee.id)
  const plus = Array.isArray(out.plus_ones) ? out.plus_ones : []
  if (plus.length && out.attendee.email) {
    const pr = await sendQrEmailsForAttendees(sb, branded, plus.map(p => ({ ...p, email: null })),
      { overrideTo: out.attendee.email, guestOf: out.attendee.first_name })
    if (pr.some(r => r.status === 'error')) console.error('checkin-held: plus-one QR email failed, guest', out.attendee.id)
  }
  return ok
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400)
  if (body._ping) return json({ pong: true })

  // ── (124) the automatic waitlist, from the cron ──
  if (body.action === 'auto') {
    const sbc = adminClient()
    const { data: allowed, error: secErr } = await sbc.rpc('checkin_waitlist_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
    if (secErr) { console.error('checkin-held: secret check failed', secErr.message); return json({ error: 'secret check failed' }, 500) }
    if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
    const { data: run, error: runErr } = await sbc.from('leod_checkin_job_runs').insert({ job_name: 'checkin-waitlist' }).select('id').single()
    if (runErr || !run) { console.error('checkin-held: could not record the run', runErr?.message); return json({ error: 'could not record the run' }, 500) }
    let released = 0
    const failures: string[] = []
    try {
      const { data: due, error: dueErr } = await sbc.rpc('checkin_web_waitlist_due')
      if (dueErr) throw new Error('due: ' + dueErr.message)
      for (const d of (due ?? []) as { event_id: string }[]) {
        try {
          const { data: ev, error: evErr } = await sbc.from('leod_events').select('name, date, venue').eq('id', d.event_id).single()
          if (evErr || !ev) throw new Error('event read')
          const { data: outs, error } = await sbc.rpc('checkin_web_waitlist_fill', { p_event_id: d.event_id })
          if (error) throw new Error('fill: ' + error.message)
          const branded = await withBrand(sbc, d.event_id, { name: ev.name, date: ev.date, venue: ev.venue })
          for (const out of (outs ?? []) as Released[]) { released++; await emailReleased(sbc, branded, out) }
        } catch (e) { failures.push(d.event_id + ': ' + (e as Error).message.slice(0, 160)) }
      }
    } catch (e) { failures.push((e as Error).message) }
    const status = failures.length ? 'failed' : 'ok'
    const detail = 'released ' + released + (failures.length ? '; ' + failures.join(' | ') : '')
    const { error: finErr } = await sbc.from('leod_checkin_job_runs').update({ status, detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
    if (finErr) console.error('checkin-held: could not close the run', finErr.message)
    return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
  }

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
    if (!ent.registration_capacity) return json({ error: 'Set a capacity first: with no capacity there are no free places to fill.' }, 400)
    // (124) In order, whole parties, under the event's lock.
    const { data: outs, error } = await sb.rpc('checkin_web_waitlist_fill', { p_event_id: event_id })
    if (error) return json({ error: error.message }, 500)
    const branded = await withBrand(sb, event_id, { name: event.name, date: event.date, venue: event.venue })
    let emailed = 0
    for (const out of (outs ?? []) as Released[]) if (await emailReleased(sb, branded, out)) emailed++
    console.log('checkin-held: fill released', (outs ?? []).length, 'event', event_id)
    return json({ ok: true, released: (outs ?? []).length, emailed, failed: 0 })
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
    if (await emailReleased(sb, branded, out as Released)) emailed++
  }
  console.log('checkin-held:', body.action, 'released', released, 'emailed', emailed, 'event', event_id)
  return json({ ok: failed.length === 0, released, emailed, failed: failed.length })
})
