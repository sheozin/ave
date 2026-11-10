// signup-watch: every 10 minutes (pg_cron, migration 165) with the
// x-cron-secret the welcome-emails job uses. signup_watch_run() suspends
// accounts in a signup cluster (3+ in an hour sharing a name or sign-in IP)
// and reports; this emails the report to BILLING_ALERT_EMAIL when there were
// 5+ signups in the hour or any cluster. One email per burst: the alert key
// is the hour of the newest signup plus the clusters, so the same burst seen
// on the next run is not mailed again, and a new cluster is.
// Each run is a row in leod_checkin_job_runs (job 'signup-watch').

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'

const JOB = 'signup-watch'

type Report = {
  signups_last_hour: number
  newest_signup: string | null
  clusters: { kind: string; value: string; emails: string[] }[]
  suspended: string[]
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('welcome_emails_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) { console.error('signup-watch: secret check failed', secErr.message); return json({ error: 'secret check failed' }, 500) }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) { console.error('signup-watch: could not record the run', runErr?.message); return json({ error: 'could not record the run' }, 500) }

  const finish = async (status: 'ok' | 'failed', detail: string, payload: Record<string, unknown>, code = 200) => {
    const { error } = await sb.from('leod_checkin_job_runs')
      .update({ status, detail: detail.slice(0, 500), finished_at: new Date().toISOString() }).eq('id', run.id)
    if (error) console.error('signup-watch: could not close the run', error.message)
    return json(payload, code)
  }

  const { data, error } = await sb.rpc('signup_watch_run')
  if (error || !data) return finish('failed', `signup_watch_run: ${error?.message ?? 'no report'}`, { error: 'watch failed' }, 500)
  const r = data as Report

  if (r.signups_last_hour < 5 && r.clusters.length === 0) {
    return finish('ok', `${r.signups_last_hour} signups, no cluster`, { ok: true, alerted: false })
  }

  const hour = (r.newest_signup ?? new Date().toISOString()).slice(0, 13)
  const key = `${hour}|${r.clusters.map(c => `${c.kind}:${c.value}`).sort().join(',')}`
  const { data: claimed, error: claimErr } = await sb.from('leod_signup_watch_alerts')
    .upsert({ alert_key: key }, { onConflict: 'alert_key', ignoreDuplicates: true }).select('alert_key')
  if (claimErr) return finish('failed', `alert claim: ${claimErr.message}`, { error: 'alert claim failed' }, 500)
  if (!claimed || claimed.length === 0) {
    return finish('ok', `already alerted ${key}`, { ok: true, alerted: false, duplicate: true })
  }

  const to = Deno.env.get('BILLING_ALERT_EMAIL')
  if (!to) return finish('failed', 'BILLING_ALERT_EMAIL is not set; alert recorded, not emailed', { error: 'no recipient' }, 500)

  const clusterHtml = r.clusters.map(c =>
    `<li><b>${esc(c.kind === 'ip' ? 'Same sign-in IP' : 'Same name')}: ${esc(c.value)}</b><br>${c.emails.map(esc).join('<br>')}</li>`).join('')
  const sent = await sendEmail({
    to,
    subject: r.clusters.length
      ? `CueDeck signup alert: ${r.clusters.length} cluster(s), ${r.suspended.length} account(s) suspended`
      : `CueDeck signup alert: ${r.signups_last_hour} signups in the last hour`,
    html: `<p><b>${r.signups_last_hour}</b> CueDeck accounts were created in the last hour.</p>` +
      (r.clusters.length ? `<p>Clusters (3+ accounts in an hour sharing a name or sign-in IP):</p><ul>${clusterHtml}</ul>` : '') +
      (r.suspended.length
        ? `<p>Suspended automatically: ${r.suspended.map(esc).join(', ')}. If any is genuine, open the admin dashboard and use Reactivate.</p>`
        : '<p>Nobody was suspended.</p>'),
    idempotencyKey: `signup-watch:${key}`.slice(0, 256),
  })
  if (sent.error) {
    // Release the claim so the next run retries the email.
    const { error: relErr } = await sb.from('leod_signup_watch_alerts').delete().eq('alert_key', key)
    if (relErr) console.error('signup-watch: could not release the alert claim', relErr.message)
    return finish('failed', `email failed: ${sent.error}`, { error: 'email failed' }, 500)
  }
  return finish('ok', `alerted ${key}; suspended ${r.suspended.length}`, { ok: true, alerted: true, suspended: r.suspended.length })
})
