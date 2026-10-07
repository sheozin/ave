// supabase/functions/checkin-webhooks/index.ts
// Sends the webhook outbox (migration 126). pg_cron every minute, with the
// x-cron-secret from the vault; each run is a row in leod_checkin_job_runs.
//
// Each delivery is POSTed as JSON to the organizer's https URL with
//   X-CueDeck-Event: <topic>
//   X-CueDeck-Delivery: <id>
//   X-CueDeck-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
// A 2xx answer within 10 seconds is success. Redirects are not followed.
//
// The URL is the organizer's, so it is treated as hostile: https only, and
// the name must resolve to public addresses only (no private, loopback,
// link-local or carrier-grade NAT ranges, which would reach CueDeck's own
// infrastructure or cloud metadata).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { isPrivateIp }  from '../_shared/net-guard.ts'

const JOB = 'checkin-webhooks'
const BUDGET_MS = 45_000

async function checkTarget(raw: string): Promise<string | null> {
  let u: URL
  try { u = new URL(raw) } catch { return 'not a valid address' }
  if (u.protocol !== 'https:') return 'not https'
  // (127) The standard port only, and no credentials in the address.
  if (u.port && u.port !== '443') return 'not the standard https port'
  if (u.username || u.password) return 'credentials in the address'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return 'an IP address, not a name'
  const ips: string[] = []
  for (const type of ['A', 'AAAA'] as const) {
    try { ips.push(...await Deno.resolveDns(host, type)) } catch { /* no records of this type */ }
  }
  if (!ips.length) return 'the name does not resolve'
  if (ips.some(isPrivateIp)) return 'the name resolves to a private address'
  return null
}

async function sign(secret: string, t: number, body: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t + '.' + body))
  return Array.from(new Uint8Array(s)).map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_webhooks_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) { console.error('checkin-webhooks: secret check failed', secErr.message); return json({ error: 'secret check failed' }, 500) }
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) { console.error('checkin-webhooks: could not record the run', runErr?.message); return json({ error: 'could not record the run' }, 500) }

  const started = Date.now()
  const counts = { sent: 0, retry: 0, failed: 0 }
  const problems: string[] = []
  try {
    const { data: due, error } = await sb.rpc('checkin_webhooks_due', { p_limit: 200 })
    if (error) throw new Error('due: ' + error.message)
    const targets = new Map<string, string | null>()   // url -> problem, checked once a run
    for (const d of (due ?? []) as { id: number; topic: string; payload: unknown; url: string; secret: string }[]) {
      if (Date.now() - started > BUDGET_MS) break     // the rest go next minute
      let ok = false, detail = ''
      try {
        if (!targets.has(d.url)) targets.set(d.url, await checkTarget(d.url))
        const problem = targets.get(d.url)
        if (problem) throw new Error('refused: ' + problem)
        const payload = JSON.stringify(d.payload)
        const t = Math.floor(Date.now() / 1000)
        const r = await fetch(d.url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'CueDeck-Webhooks/1', 'X-CueDeck-Event': d.topic,
                     'X-CueDeck-Delivery': String(d.id), 'X-CueDeck-Signature': 't=' + t + ',v1=' + await sign(d.secret, t, payload) },
          body: payload,
        })
        await r.body?.cancel()
        ok = r.status >= 200 && r.status < 300
        detail = 'HTTP ' + r.status
      } catch (e) {
        detail = (e as Error).name === 'TimeoutError' ? 'timed out after 10 s' : (e as Error).message.slice(0, 200)
      }
      const { data: res, error: rErr } = await sb.rpc('checkin_webhook_result', { p_id: d.id, p_ok: ok, p_detail: detail })
      if (rErr) { problems.push('result ' + d.id + ': ' + rErr.message); continue }
      if (res === 'sent') counts.sent++; else if (res === 'failed') counts.failed++; else if (res === 'retry') counts.retry++
    }
  } catch (e) { problems.push((e as Error).message) }

  // A receiver that refuses is the organizer's to fix (shown in Event
  // admin); only CueDeck's own failures fail the run.
  const status = problems.length ? 'failed' : 'ok'
  const detail = `sent ${counts.sent}, retrying ${counts.retry}, gave up ${counts.failed}` + (problems.length ? '; ' + problems.join(' | ') : '')
  const { error: finErr } = await sb.from('leod_checkin_job_runs').update({ status, detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-webhooks: could not close the run', finErr.message)
  return json({ status, detail }, status === 'ok' && !finErr ? 200 : 500)
})
