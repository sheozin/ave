// supabase/functions/checkin-orders-sweep/index.ts
// Settles paid-ticket orders (migration 109) for guests who paid and closed
// the tab, or never paid. Every 5 minutes from pg_cron; asks Stripe about
// each open order a few minutes old or past its hold:
//   paid    -> the guest joins the list and gets their QR email
//   expired -> the held place is free again
//   open    -> left for the next run
//
// Auth: x-cron-secret, checked by checkin_orders_cron_ok against the vault
// (same pattern as checkin-post-event-report, 089). Each run is a row in
// leod_checkin_job_runs, so a sweep that stops running is reported stale,
// and guard G16 reports any order it left open past its expiry.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }       from '../_shared/stripe.ts'
import { settleOrder, type Order } from '../_shared/checkin-tickets.ts'

const JOB = 'checkin-orders-sweep'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no body: a cron call */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_orders_cron_ok', {
    p_secret: req.headers.get('x-cron-secret') ?? '',
  })
  if (secErr) {
    console.error('checkin-orders-sweep: secret check failed', secErr.message)
    return json({ error: 'secret check failed' }, 500)
  }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)

  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs')
    .insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) {
    console.error('checkin-orders-sweep: could not record the run', runErr?.message)
    return json({ error: 'could not record the run' }, 500)
  }

  const counts = { paid: 0, expired: 0, open: 0 }
  const failures: string[] = []
  try {
    const { data: due, error: dueErr } = await sb.rpc('checkin_web_orders_due')
    if (dueErr) throw new Error('orders_due: ' + dueErr.message)
    const st = stripe()
    for (const o of (due ?? []) as Order[]) {
      const { error: ckErr } = await sb.from('leod_checkin_web_orders').update({ last_checked_at: new Date().toISOString() }).eq('id', o.id)
      if (ckErr) failures.push(o.id + ': last_checked_at ' + ckErr.message)
      try {
        const s = await settleOrder(st, sb, o)
        if (s.kind === 'paid') counts.paid++
        else if (s.kind === 'open' || s.kind === 'pending') counts.open++
        else if (s.kind === 'expired') {
          // Only an order past its hold is ended; a session that ended early
          // (the guest cancelled) keeps its place until then, so their link
          // can start a new payment.
          if (Date.parse(o.expires_at) <= Date.now()) {
            const { error } = await sb.rpc('checkin_web_order_expire', { p_order_id: o.id })
            if (error) throw new Error('expire: ' + error.message)
            counts.expired++
          } else counts.open++
        }
      } catch (e) {
        // Order ids only: the message never carries the guest's details.
        failures.push(o.id + ': ' + (e as Error).message.slice(0, 160))
        // Stripe has not answered for an hour past the hold (the owner
        // disconnected CueDeck, say). Its session ended a minute before the
        // hold, so no payment can arrive: release the place.
        if (Date.parse(o.expires_at) < Date.now() - 60 * 60 * 1000) {
          const { error } = await sb.rpc('checkin_web_order_expire', { p_order_id: o.id })
          if (!error) counts.expired++
        }
      }
    }
  } catch (e) {
    failures.push((e as Error).message)
  }

  const status = failures.length ? 'failed' : 'ok'
  const detail = `paid ${counts.paid}, expired ${counts.expired}, open ${counts.open}` + (failures.length ? '; ' + failures.join(' | ') : '')
  if (failures.length) console.error('checkin-orders-sweep:', detail)
  const { error: finErr } = await sb.from('leod_checkin_job_runs')
    .update({ status, detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-orders-sweep: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
