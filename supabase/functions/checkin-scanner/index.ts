// supabase/functions/checkin-scanner/index.ts
// What a paired door/session scanner reads (scanner Build A, spec
// docs/superpowers/specs/2026-08-18-checkin-scanner-device-design.md).
// Authenticated by its device key, like the kiosk; never by a user session.
//
//   action 'config'  event name and date, test or live, the scan point it is
//                    paired to, whether scanning there is allowed now (with
//                    the reason when not), and the server's clock.
//   action 'tokens'  this event's QR tokens and nothing else: no names,
//                    emails, companies or ids. A roaming phone gets left on
//                    chairs, so the offline cache answers only "is this code
//                    on the list". Names arrive per scan, online, from
//                    checkin-record-scans.
//
// Scans themselves go to checkin-record-scans with the same device key.
// Deployed with --no-verify-jwt (see supabase/config.toml).

import { adminClient }      from '../_shared/client.ts'
import { corsHeaders }      from '../_shared/cors.ts'
import { authDevice }       from '../_shared/checkin-device.ts'
import { scanPointRefusal } from '../_shared/checkin-scanner.ts'
import { isUuid }           from '../_shared/checkin-roles.ts'

const MAX_TOKENS = 20000

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  // scripts/deploy-functions.sh verifies every deploy with POST {"_ping":true}.
  if (body._ping) return json({ pong: true })

  const event_id = String(body.event_id || '')
  const action = String(body.action || '')
  if (!isUuid(event_id) || (action !== 'config' && action !== 'tokens')) return json({ error: 'Bad request' }, 400)

  const sb = adminClient()
  const auth = await authDevice(sb, event_id, String(body.device_key || ''), 'scanner')
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status, multi_point_scanning, entrance_scanning, session_scanning').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent?.checkin_core) return json({ error: 'Check-in is not enabled for this event' }, 403)

  if (action === 'config') {
    const [{ data: ev, error: evErr }, { data: sp, error: spErr }] = await Promise.all([
      sb.from('leod_events').select('name, date, timezone').eq('id', event_id).maybeSingle(),
      sb.from('leod_checkin_scan_points').select('name, kind').eq('id', auth.device.scan_point_id).eq('event_id', event_id).maybeSingle(),
    ])
    if (evErr || spErr) return json({ error: (evErr || spErr)!.message }, 500)
    if (!ev) return json({ error: 'Event not found' }, 404)
    if (!sp) return json({ error: 'This scanner is not paired to a scan point. Pair it again from the desk.' }, 403)
    const refusal = scanPointRefusal(sp.kind, {
      multi_point_scanning: !!ent.multi_point_scanning,
      entrance_scanning: !!ent.entrance_scanning,
      session_scanning: !!ent.session_scanning,
    })
    return json({
      event: { name: ev.name, date: ev.date, timezone: ev.timezone },
      status: ent.status === 'live' ? 'live' : 'test',
      scan_point: { name: sp.name, kind: sp.kind },
      allowed: refusal === null,
      reason: refusal,
      // The phone has no user session for checkin_server_now; it corrects its
      // clock from this, as the desk does (checkin-clock.js).
      server_now: new Date().toISOString(),
    })
  }

  // tokens: same gate as checkin-record-scans and config. A scanner whose
  // scan point is switched off gets no guest data at all.
  const { data: tsp, error: tspErr } = await sb.from('leod_checkin_scan_points')
    .select('kind').eq('id', auth.device.scan_point_id).eq('event_id', event_id).maybeSingle()
  if (tspErr) return json({ error: tspErr.message }, 500)
  if (!tsp) return json({ error: 'This scanner is not paired to a scan point. Pair it again from the desk.' }, 403)
  const tokRefusal = scanPointRefusal(tsp.kind, {
    multi_point_scanning: !!ent.multi_point_scanning,
    entrance_scanning: !!ent.entrance_scanning,
    session_scanning: !!ent.session_scanning,
  })
  if (tokRefusal) return json({ error: tokRefusal }, 403)
  const { data: rows, error: tokErr } = await sb.from('leod_checkin_attendees')
    .select('qr_token').eq('event_id', event_id).not('qr_token', 'is', null).limit(MAX_TOKENS + 1)
  if (tokErr) return json({ error: tokErr.message }, 500)
  if ((rows ?? []).length > MAX_TOKENS) return json({ error: 'Guest list too large for the offline list' }, 413)
  return json({ tokens: (rows ?? []).map((r: { qr_token: string }) => r.qr_token), generated_at: new Date().toISOString() })
})
