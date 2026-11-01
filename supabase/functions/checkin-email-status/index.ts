// checkin-email-status: every 5 minutes (pg_cron, migration 150), asks
// Resend what became of recent check-in emails and records it, so Event
// admin can say "delivered" or "bounced" next to "sent". Polling, because
// Resend's webhook was never set up for this project.
//
// Up to 60 emails a run, sent in the last 3 days and still 'sent' or
// 'delivery_delayed', oldest-checked first, at most 2 requests a second
// (Resend's default rate limit). Each run is a row in leod_checkin_job_runs.
import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'

const JOB = 'checkin-email-status'
const KNOWN = new Set(['sent', 'delivered', 'delivery_delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed'])

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_email_status_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) return json({ error: 'secret check failed' }, 500)
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const key = Deno.env.get('RESEND_API_KEY')
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) return json({ error: 'could not record the run' }, 500)

  let checked = 0, changed = 0
  const problems: string[] = []
  try {
    if (!key) throw new Error('RESEND_API_KEY is not set')
    const since = new Date(Date.now() - 3 * 864e5).toISOString()
    const { data: rows, error } = await sb.from('leod_checkin_emails')
      .select('id, resend_id, status').in('status', ['sent', 'delivery_delayed']).gte('sent_at', since)
      .order('checked_at', { ascending: true, nullsFirst: true }).limit(60)
    if (error) throw new Error('read: ' + error.message)
    for (const r of rows ?? []) {
      const res = await fetch('https://api.resend.com/emails/' + encodeURIComponent(r.resend_id), { headers: { Authorization: 'Bearer ' + key } })
      const now = new Date().toISOString()
      if (res.status === 429) { problems.push('Resend rate limit; the rest wait for the next run'); break }
      const e = res.ok ? await res.json().catch(() => ({})) : {}
      const last = String((e as Record<string, unknown>).last_event || '')
      const next = KNOWN.has(last) ? last : r.status
      const patch: Record<string, unknown> = { checked_at: now }
      if (next !== r.status) { patch.status = next; patch.status_at = now; changed++ }
      const { error: uErr } = await sb.from('leod_checkin_emails').update(patch).eq('id', r.id)
      if (uErr) throw new Error('write: ' + uErr.message)
      if (!res.ok && res.status !== 404) problems.push('Resend ' + res.status + ' for one email')
      checked++
      await new Promise((ok) => setTimeout(ok, 550))
    }
    // Ninety days is plenty for "did it arrive".
    const { error: dErr } = await sb.from('leod_checkin_emails').delete().lt('sent_at', new Date(Date.now() - 90 * 864e5).toISOString())
    if (dErr) problems.push('cleanup: ' + dErr.message)
  } catch (e) { problems.push((e as Error).message) }

  const failed = problems.some(p => !p.startsWith('Resend rate limit') && !p.startsWith('Resend '))
  const detail = `checked ${checked}, changed ${changed}` + (problems.length ? '; ' + problems.slice(0, 5).join(' | ') : '')
  const { error: finErr } = await sb.from('leod_checkin_job_runs').update({ status: failed ? 'failed' : 'ok', detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-email-status: run not closed', finErr.code)
  return json({ status: failed ? 'failed' : 'ok', detail }, failed ? 500 : 200)
})
