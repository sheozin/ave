// checkin-print-station: the venue print station's only door in (migration
// 142). The station is a paired device of kind 'printer' and sends its
// device key, never a user session, so this runs with --no-verify-jwt and
// authenticates the key itself (checkin-device.ts), which also stamps
// last_seen_at: that stamp is what makes the station show as online.
//
//   { action: 'next', event_id, device_key }
//     Long-polls up to WAIT_MS for queued badges, claims up to 5 and returns
//     { jobs: [{ id, png, cut_mm }] }. An empty list after the wait is normal.
//   { action: 'done', event_id, device_key, job_id, ok, error? }
//     Reports one job. The image is cleared either way.
import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { authDevice } from '../_shared/checkin-device.ts'

const WAIT_MS = 20_000
const STEP_MS = 700
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { return json({ error: 'Send JSON' }, 400) }
  if (body._ping) return json({ pong: true })

  const eventId = String(body.event_id || '')
  if (!UUID.test(eventId)) return json({ error: 'Unauthorized device' }, 401)
  const sb = adminClient()
  const auth = await authDevice(sb, eventId, String(body.device_key || ''), 'printer')
  if (!auth.ok) return json({ error: auth.error }, auth.status)
  const deviceId = auth.device.id

  if (body.action === 'next') {
    const until = Date.now() + WAIT_MS
    for (;;) {
      const { data, error } = await sb.rpc('checkin_print_claim', { p_device_id: deviceId, p_limit: 5 })
      if (error) { console.error('checkin-print-station: claim failed', error.code); return json({ error: 'Could not read the queue' }, 500) }
      if (Array.isArray(data) && data.length) {
        return json({ jobs: data.map((j: { id: string; label_png: string; cut_mm: number }) => ({ id: j.id, png: j.label_png, cut_mm: Number(j.cut_mm) })) })
      }
      if (Date.now() + STEP_MS > until || req.signal.aborted) return json({ jobs: [] })
      await new Promise((r) => setTimeout(r, STEP_MS))
    }
  }

  if (body.action === 'done') {
    const jobId = String(body.job_id || '')
    if (!UUID.test(jobId)) return json({ error: 'job_id is required' }, 400)
    const { data, error } = await sb.rpc('checkin_print_finish', {
      p_device_id: deviceId, p_job_id: jobId, p_ok: body.ok === true,
      p_error: body.ok === true ? null : String(body.error || 'The printer did not print').slice(0, 300),
    })
    if (error) { console.error('checkin-print-station: finish failed', error.code); return json({ error: 'Could not record the result' }, 500) }
    return json({ ok: true, recorded: data === true })
  }

  return json({ error: 'action must be next or done' }, 400)
})
