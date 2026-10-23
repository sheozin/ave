// process-welcome-triggers: sends the founder welcome email to new accounts.
// handle_first_login queues a row in welcome_email_trigger; pg_cron calls
// this every 10 minutes (migration 140) with the x-cron-secret from the vault.
// Each run is a row in leod_checkin_job_runs (job 'welcome-emails').
//
// Only the welcome itself is sent. The Day 3/7/14 follow-ups in
// EMAIL_SEQUENCE are not scheduled: the Day 7 one quotes a testimonial that
// is not real, and none carries an unsubscribe link. Rewrite them first.
//
// A row is closed only after its email is sent AND logged. If closing it
// fails, the run stops there and reports it, so a row that cannot be closed
// is never mailed again on the next run.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import { founderWelcomeEmail, type UserData } from '../_shared/email-templates.ts'

const JOB = 'welcome-emails'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('welcome_emails_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) { console.error('welcome: secret check failed', secErr.message); return json({ error: 'secret check failed' }, 500) }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) { console.error('welcome: could not record the run', runErr?.message); return json({ error: 'could not record the run' }, 500) }

  let sent = 0, failed = 0
  const problems: string[] = []
  try {
    const { data: triggers, error } = await sb.from('welcome_email_trigger')
      .select('user_id, email, name').eq('processed', false).order('triggered_at').limit(20)
    if (error) throw new Error('read: ' + error.message)

    for (const t of triggers ?? []) {
      const close = () => sb.from('welcome_email_trigger').update({ processed: true, processed_at: new Date().toISOString() }).eq('user_id', t.user_id)

      // Sent before (e.g. a run that died between sending and closing): close only.
      const { data: prior, error: priorErr } = await sb.from('email_log').select('id')
        .eq('user_id', t.user_id).eq('email_type', 'founder-welcome').limit(1)
      if (priorErr) throw new Error('log read: ' + priorErr.message)
      if (prior?.length) {
        const { error: cErr } = await close()
        if (cErr) throw new Error('close ' + t.user_id + ': ' + cErr.message)
        continue
      }

      const user: UserData = { email: t.email, name: t.name, firstName: t.name?.split(' ')[0] }
      const mail = founderWelcomeEmail(user)
      const result = await sendEmail({
        to: t.email, subject: mail.subject, html: mail.html, text: mail.text,
        fromName: 'Sherif from CueDeck', replyTo: 'support@cuedeck.io',
        tags: [{ name: 'type', value: 'founder-welcome' }, { name: 'user_id', value: t.user_id }],
      })
      if (result.error) { failed++; problems.push('send ' + t.user_id + ': ' + String(result.error).slice(0, 120)); continue }

      const { error: logErr } = await sb.from('email_log').insert({
        user_id: t.user_id, email_type: 'founder-welcome', email_address: t.email,
        subject: mail.subject, status: 'sent', resend_id: result.id, sent_at: new Date().toISOString(),
      })
      if (logErr) throw new Error('log ' + t.user_id + ': ' + logErr.message)
      const { error: cErr } = await close()
      if (cErr) throw new Error('close ' + t.user_id + ': ' + cErr.message)
      sent++
    }
  } catch (e) { problems.push((e as Error).message) }

  const status = problems.length ? 'failed' : 'ok'
  const detail = `sent ${sent}, failed ${failed}` + (problems.length ? '; ' + problems.join(' | ') : '')
  const { error: finErr } = await sb.from('leod_checkin_job_runs').update({ status, detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('welcome: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
