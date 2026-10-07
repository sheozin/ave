// supabase/functions/checkin-reminders/index.ts
// Reminder and thank-you emails for live events (migration 110).
//
//   cron (pg_cron every 5 minutes, x-cron-secret from the vault):
//     claims up to BATCH due guests (checkin_claim_reminders) and emails
//     them; a failed send gives its claim back so the next run retries.
//     Each run is a row in leod_checkin_job_runs.
//   POST { event_id, action: 'test', kind: 'reminder' | 'thankyou' } with a
//     user's JWT: the owner or an organizer gets that email themselves,
//     with the event's real settings and a sample QR code.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'
import { withBrand }    from '../_shared/qr-email.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { reminderEmail, thankyouEmail, type ReminderEvent } from '../_shared/reminder-email.ts'
import { langsFor, type Lang } from '../_shared/email-i18n.ts'

const JOB = 'checkin-reminders'
// Sends one at a time; this many fit comfortably in one run, and the cron
// comes back in 5 minutes for the rest (1,400 an hour).
const BATCH = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Sb = ReturnType<typeof adminClient>

async function loadEvent(sb: Sb, eventId: string): Promise<ReminderEvent> {
  const [{ data: ev, error: evErr }, { data: ent, error: entErr }] = await Promise.all([
    sb.from('leod_events').select('name, date, venue, timezone, event_start').eq('id', eventId).single(),
    sb.from('leod_checkin_entitlements').select('registration_address, reminder_message, thankyou_message, thankyou_link').eq('event_id', eventId).single(),
  ])
  if (evErr || !ev) throw new Error('event read: ' + (evErr?.message ?? 'missing'))
  if (entErr || !ent) throw new Error('entitlement read: ' + (entErr?.message ?? 'missing'))
  const base = await withBrand(sb, eventId, { name: ev.name, date: ev.date, venue: ev.venue })
  return {
    ...base, start: typeof ev.event_start === 'string' ? ev.event_start.slice(0, 5) : null, timezone: ev.timezone ?? null,
    address: ent.registration_address ?? null, reminder_message: ent.reminder_message ?? null,
    thankyou_message: ent.thankyou_message ?? null, thankyou_link: ent.thankyou_link ?? null,
  }
}
const fromName = (name: string) => (name.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 64) || 'CueDeck') + ' Check-in'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no body: a cron call */ }
  if (body._ping) return json({ pong: true })
  const sb = adminClient()

  // ── an organizer's test email ──
  if (body.action === 'test') {
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
    if (!jwt) return json({ error: 'Unauthorized' }, 401)
    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
    if (authErr || !user?.email) return json({ error: 'Unauthorized' }, 401)
    const event_id = String(body.event_id || '')
    if (!UUID.test(event_id)) return json({ error: 'Missing event_id' }, 400)
    const kind = body.kind === 'thankyou' ? 'thankyou' : body.kind === 'reminder' ? 'reminder' : null
    if (!kind) return json({ error: 'Bad request' }, 400)
    const gate = functionGate('checkin-reminders', await loadCallerRole(sb, event_id, user.id))
    if (!gate.ok) return json(gate.body, gate.status)
    let ev: ReminderEvent
    try { ev = await loadEvent(sb, event_id) } catch (e) { return json({ error: (e as Error).message }, 500) }
    const first = String(user.user_metadata?.first_name ?? user.user_metadata?.name ?? '').split(' ')[0] || 'there'
    const m = kind === 'reminder' ? reminderEmail(ev, { first_name: first, qr_token: 'SAMPLE' + crypto.randomUUID().replace(/-/g, '') }) : thankyouEmail(ev, { first_name: first })
    const { error } = await sendEmail({ to: user.email, subject: '[Test] ' + m.subject, html: m.html, fromName: fromName(ev.name) })
    if (error) return json({ error: 'The email could not be sent: ' + error }, 502)
    return json({ ok: true, to: user.email })
  }

  // ── the cron ──
  const { data: allowed, error: secErr } = await sb.rpc('checkin_reminders_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) {
    console.error('checkin-reminders: secret check failed', secErr.message)
    return json({ error: 'secret check failed' }, 500)
  }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)

  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) {
    console.error('checkin-reminders: could not record the run', runErr?.message)
    return json({ error: 'could not record the run' }, 500)
  }

  const counts = { reminder: 0, thankyou: 0 }
  const failures: string[] = []
  try {
    const { data: due, error: dueErr } = await sb.rpc('checkin_claim_reminders', { p_limit: BATCH })
    if (dueErr) throw new Error('claim: ' + dueErr.message)
    const events = new Map<string, Promise<ReminderEvent>>()
    // (123) Each guest's language, one lookup per event in the batch.
    const rows = (due ?? []) as { event_id: string; email: string }[]
    const langs = new Map<string, Map<string, Lang>>()
    for (const ev of new Set(rows.map(r => r.event_id))) langs.set(ev, await langsFor(sb, ev, rows.filter(r => r.event_id === ev).map(r => r.email)))
    for (const d of (due ?? []) as { attendee_id: string; kind: 'reminder' | 'thankyou'; event_id: string; first_name: string; email: string; qr_token: string }[]) {
      try {
        if (!events.has(d.event_id)) events.set(d.event_id, loadEvent(sb, d.event_id))
        const ev = await events.get(d.event_id)!
        const lang = langs.get(d.event_id)?.get(String(d.email).toLowerCase()) ?? 'en'
        const m = d.kind === 'reminder' ? reminderEmail(ev, d, lang) : thankyouEmail(ev, d, lang)
        const { error } = await sendEmail({ to: d.email, subject: m.subject, html: m.html, fromName: fromName(ev.name) })
        if (error) throw new Error(error)
        counts[d.kind]++
      } catch (e) {
        // Attendee ids only: never the address.
        failures.push(d.kind + ' ' + d.attendee_id + ': ' + (e as Error).message.slice(0, 160))
        const { error } = await sb.rpc('checkin_unclaim_reminder', { p_attendee_id: d.attendee_id, p_kind: d.kind })
        if (error) failures.push('unclaim ' + d.attendee_id + ': ' + error.message)
      }
    }
  } catch (e) {
    failures.push((e as Error).message)
  }

  const status = failures.length ? 'failed' : 'ok'
  const detail = `reminders ${counts.reminder}, thank-yous ${counts.thankyou}` + (failures.length ? '; ' + failures.slice(0, 20).join(' | ') : '')
  if (failures.length) console.error('checkin-reminders:', detail)
  const { error: finErr } = await sb.from('leod_checkin_job_runs')
    .update({ status, detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-reminders: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
