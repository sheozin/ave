// supabase/functions/checkin-send-qr-emails/index.ts
// Manual/resend QR email delivery. Organizer-only. With no
// attendee_ids, targets every attendee for the event that has never
// been sent a QR email (qr_email_sent_at IS NULL). With attendee_ids,
// forces a resend for exactly those attendees regardless of prior
// send state — always reusing their existing qr_token, never
// regenerating it (that would invalidate anything they already
// saved from a prior email).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendQrEmailsForAttendees, type QrEmailResult } from '../_shared/qr-email.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const event_id = String(body.event_id || '')
  const attendee_ids = Array.isArray(body.attendee_ids) ? (body.attendee_ids as string[]) : undefined
  if (!event_id) {
    return new Response(JSON.stringify({ error: 'Missing event_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Service-role client bypasses RLS entirely, so the entitlement gate
  // (migration 051's checkin_role_for_event) is never consulted here —
  // same explicit check as checkin-import-attendees.
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core').eq('event_id', event_id).single()
  if (!entRow?.checkin_core) {
    return new Response(JSON.stringify({ error: 'Check-in is not enabled for this event' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: event } = await sb.from('leod_events')
    .select('name, date, venue').eq('id', event_id).single()
  if (!event) {
    return new Response(JSON.stringify({ error: 'Event not found' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  let attendeesQuery = sb.from('leod_checkin_attendees')
    .select('id, first_name, email, qr_token')
    .eq('event_id', event_id)

  attendeesQuery = attendee_ids && attendee_ids.length
    ? attendeesQuery.in('id', attendee_ids)
    : attendeesQuery.is('qr_email_sent_at', null)

  const { data: attendees, error: fetchErr } = await attendeesQuery
  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const results: QrEmailResult[] = await sendQrEmailsForAttendees(sb, event, attendees || [])

  const summary = {
    total: results.length,
    sent: results.filter(r => r.status === 'sent').length,
    skipped_no_email: results.filter(r => r.status === 'skipped_no_email').length,
    errored: results.filter(r => r.status === 'error').length,
  }
  const send_errors = results.filter(r => r.status === 'error')

  return new Response(JSON.stringify({
    ok: true, summary,
    ...(send_errors.length ? { send_errors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
