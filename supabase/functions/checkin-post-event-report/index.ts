// supabase/functions/checkin-post-event-report/index.ts
// Post-event report email (event-day spec, feature 6). Called by pg_cron
// every 15 minutes through pg_net (migration 089). For each live event
// whose check-in window closed two hours ago or more, it claims the event
// (report_sent_at, migration 088) and only then emails the owner the
// headline numbers and a link. Winning the claim first means two
// overlapping runs cannot both send; a failed send gives the claim back so
// the next run retries, up to 5 times (092). The Resend Idempotency-Key
// stops a resend when only the reply to a successful send was lost.
//
// Auth: the x-cron-secret header must match the vault secret, checked by
// checkin_report_cron_ok (089). The secret exists only in the vault and in
// the cron job's request; it is never in this function's environment.
// Deployed with --no-verify-jwt (see supabase/config.toml).
//
// Every run writes one leod_checkin_job_runs row, so the AVE Brain can tell
// a job that stopped running from one with nothing to do.

import { corsHeaders }  from '../_shared/cors.ts'
import { adminClient }  from '../_shared/client.ts'
import { sendEmail }    from '../_shared/resend.ts'
import { reportEmail }  from '../_shared/checkin-report-email.ts'
import { clientReportEmail, guestCsv, base64Utf8 } from '../_shared/client-report-email.ts'
import { fromDisplayName } from '../_shared/host-email.ts'

const JOB = 'checkin-post-event-report'
const APP = 'https://app.cuedeck.io'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no body: a cron call */ }
  // scripts/deploy-functions.sh verifies every deploy with POST {"_ping":true}.
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_report_cron_ok', {
    p_secret: req.headers.get('x-cron-secret') ?? '',
  })
  if (secErr) {
    console.error('checkin-post-event-report: secret check failed', secErr.message)
    return json({ error: 'secret check failed' }, 500)
  }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)

  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs')
    .insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) {
    console.error('checkin-post-event-report: could not record the run', runErr?.message)
    return json({ error: 'could not record the run' }, 500)
  }

  let status: 'ok' | 'failed' = 'ok'
  let detail = ''
  const failures: string[] = []
  let sent = 0
  try {
    const { data: due, error: dueErr } = await sb.rpc('checkin_reports_due')
    if (dueErr) throw new Error('reports_due: ' + dueErr.message)
    for (const d of (due ?? []) as { event_id: string; owner_id: string }[]) {
      const { data: won, error: claimErr } = await sb.rpc('checkin_claim_report', { p_event_id: d.event_id })
      if (claimErr) { failures.push(d.event_id + ' claim: ' + claimErr.message); continue }
      if (won !== true) continue   // another run has it
      try {
        const { data: rep, error: repErr } = await sb.rpc('checkin_event_report_data', { p_event_id: d.event_id, p_people: false })
        if (repErr) throw new Error('report: ' + repErr.message)
        const { data: owner, error: ownerErr } = await sb.auth.admin.getUserById(d.owner_id)
        if (ownerErr) throw new Error('owner: ' + ownerErr.message)
        const to = owner?.user?.email
        if (!to) throw new Error('owner has no email')
        const m = reportEmail(rep, APP + '/checkin/report?event=' + d.event_id)
        const res = await sendEmail({ to, subject: m.subject, html: m.html, text: m.text,
                                      tags: [{ name: 'type', value: 'checkin_report' }],
                                      idempotencyKey: 'checkin-report-' + d.event_id })
        if (res.error) throw new Error('send: ' + res.error)
        sent++
      } catch (e) {
        // Gives the claim back and counts the attempt; after 5 the event is
        // parked and guard G11 reports it (migration 092).
        failures.push(d.event_id + ' ' + msg(e))
        const { error: backErr } = await sb.rpc('checkin_report_failed', { p_event_id: d.event_id, p_error: msg(e) })
        if (backErr) failures.push(d.event_id + ' record failure: ' + backErr.message)
      }
    }
    detail = (due ?? []).length + ' due, ' + sent + ' sent'
  } catch (e) {
    failures.push(msg(e))
  }

  // The client's copy (migration 157): 08:00 event time the morning after,
  // to the addresses the organizer named. Same claim, give-back and park
  // rules as the owner's report above.
  let clientSent = 0
  try {
    const { data: due, error: dueErr } = await sb.rpc('checkin_client_reports_due')
    if (dueErr) throw new Error('client_reports_due: ' + dueErr.message)
    for (const d of (due ?? []) as { event_id: string; owner_id: string; recipients: string[]; attach_guests: boolean }[]) {
      const { data: won, error: claimErr } = await sb.rpc('checkin_claim_client_report', { p_event_id: d.event_id })
      if (claimErr) { failures.push(d.event_id + ' client claim: ' + claimErr.message); continue }
      if (won !== true) continue
      try {
        const { data: rep, error: repErr } = await sb.rpc('checkin_event_report_data', { p_event_id: d.event_id, p_people: false })
        if (repErr) throw new Error('report: ' + repErr.message)
        const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
          .select('registration_host_name').eq('event_id', d.event_id).single()
        if (entErr) throw new Error('host: ' + entErr.message)
        const { data: owner, error: ownerErr } = await sb.auth.admin.getUserById(d.owner_id)
        if (ownerErr) throw new Error('owner: ' + ownerErr.message)
        const replyTo = owner?.user?.email
        if (!replyTo) throw new Error('owner has no email')
        let attachments: { filename: string; content: string; content_type: string }[] | undefined
        if (d.attach_guests) {
          const { data: guests, error: gErr } = await sb.rpc('checkin_client_report_guests', { p_event_id: d.event_id })
          if (gErr) throw new Error('guests: ' + gErr.message)
          attachments = [{ filename: 'guest-list.csv', content_type: 'text/csv; charset=utf-8',
                           content: base64Utf8(guestCsv(guests ?? [], rep?.event?.timezone || 'UTC')) }]
        }
        const m = clientReportEmail(rep, ent?.registration_host_name ?? null)
        for (const to of d.recipients) {
          const res = await sendEmail({ to, replyTo, subject: m.subject, html: m.html, text: m.text, attachments,
                                        fromName: fromDisplayName(rep?.event?.name ?? ''), tags: [{ name: 'type', value: 'checkin_client_report' }],
                                        idempotencyKey: 'checkin-client-report-' + d.event_id + '-' + to })
          if (res.error) throw new Error('send: ' + res.error)
        }
        clientSent++
      } catch (e) {
        failures.push(d.event_id + ' client ' + msg(e))
        const { error: backErr } = await sb.rpc('checkin_client_report_failed', { p_event_id: d.event_id, p_error: msg(e) })
        if (backErr) failures.push(d.event_id + ' record client failure: ' + backErr.message)
      }
    }
    detail = (detail ? detail + '; ' : '') + (due ?? []).length + ' client due, ' + clientSent + ' sent'
  } catch (e) {
    failures.push(msg(e))
  }
  if (failures.length) {
    status = 'failed'
    detail = (detail ? detail + '; ' : '') + failures.join('; ').slice(0, 900)
  }

  const { error: finErr } = await sb.from('leod_checkin_job_runs')
    .update({ status, detail, finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-post-event-report: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
