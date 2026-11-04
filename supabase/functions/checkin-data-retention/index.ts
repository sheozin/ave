// checkin-data-retention: hourly (pg_cron, migration 160). Guests'
// personal data is deleted 90 days after their event finishes; this job
// warns the owner 14 days before, then deletes.
//
// checkin_retention_due lists what is due:
//   warn   claim the warning (checkin_retention_claim_warning, so two runs
//          never both send), then email the owner. A failed send gives the
//          claim back and the next run tries again. An owner without an
//          email address (or one at a reserved test domain) keeps the
//          claim: there is nobody to warn, and the
//          14 days run from here. Guard G22 reports any event whose data
//          outlives its deletion date by a week, so a warning that never
//          goes out cannot postpone deletion unnoticed.
//   purge  checkin_purge_event, which itself refuses anything not yet due.
//
// Auth: x-cron-secret against the vault (checkin_retention_cron_ok).
// Each run is a row in leod_checkin_job_runs, watched by the AVE Brain.
import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import { retentionEmail } from '../_shared/retention-email.ts'

const JOB = 'checkin-data-retention'
const APP = 'https://app.cuedeck.io'
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_retention_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) return json({ error: 'secret check failed' }, 500)
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) return json({ error: 'could not record the run' }, 500)

  const failures: string[] = []
  const notes: string[] = []   // worth saying, not a failure
  let warned = 0, purged = 0, due: { event_id: string; owner_id: string; action: string }[] = []
  try {
    const { data, error } = await sb.rpc('checkin_retention_due')
    if (error) throw new Error('retention_due: ' + error.message)
    due = data ?? []
  } catch (e) { failures.push(msg(e)) }

  for (const d of due) {
    if (d.action === 'purge') {
      const { error } = await sb.rpc('checkin_purge_event', { p_event_id: d.event_id })
      if (error) failures.push(d.event_id + ' purge: ' + error.message)
      else purged++
      continue
    }
    if (d.action !== 'warn') continue
    const { data: purgeAt, error: claimErr } = await sb.rpc('checkin_retention_claim_warning', { p_event_id: d.event_id })
    if (claimErr) { failures.push(d.event_id + ' claim: ' + claimErr.message); continue }
    if (!purgeAt) continue   // another run has it
    try {
      const { data: ev, error: evErr } = await sb.from('leod_events').select('date, timezone').eq('id', d.event_id).single()
      if (evErr || !ev) throw new Error('event: ' + (evErr?.message ?? 'not found'))
      const { data: owner, error: ownerErr } = await sb.auth.admin.getUserById(d.owner_id)
      if (ownerErr) throw new Error('owner: ' + ownerErr.message)
      // A reserved test domain (RFC 2606) can never receive mail: same as none.
      const to = owner?.user?.email && !/\.(test|invalid|example|localhost)$/i.test(owner.user.email) ? owner.user.email : ''
      if (!to) { notes.push(d.event_id + ' owner has no email: deleting without a warning'); continue }
      const m = retentionEmail(ev.date, new Date(purgeAt as string), ev.timezone || 'UTC', APP + '/checkin/setup?event=' + d.event_id + '&step=reports')
      const res = await sendEmail({ to, subject: m.subject, html: m.html, text: m.text,
                                    tags: [{ name: 'type', value: 'checkin_retention' }],
                                    idempotencyKey: 'checkin-retention-' + d.event_id + '-' + ev.date })
      if (res.error) throw new Error('send: ' + res.error)
      warned++
    } catch (e) {
      failures.push(d.event_id + ' ' + msg(e))
      const { error: backErr } = await sb.rpc('checkin_retention_release_warning', { p_event_id: d.event_id })
      if (backErr) failures.push(d.event_id + ' release: ' + backErr.message)
    }
  }

  const status = failures.length ? 'failed' : 'ok'
  const detail = (due.length + ' due, ' + warned + ' warned, ' + purged + ' deleted' + [...failures, ...notes].map(x => '; ' + x).join('')).slice(0, 1000)
  const { error: finErr } = await sb.from('leod_checkin_job_runs')
    .update({ status, detail, finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-data-retention: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
