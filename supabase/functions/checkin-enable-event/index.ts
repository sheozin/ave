// supabase/functions/checkin-enable-event/index.ts
// Provisions the check-in module for an event: creates the
// entitlements row (idempotent via upsert) and makes sure the event's
// creator holds an organizer grant (covers events created before
// migration 045's auto-grant trigger existed). Caller must be the
// event's creator or a CueDeck admin.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

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
  if (!event_id) {
    return new Response(JSON.stringify({ error: 'Missing event_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: event } = await sb.from('leod_events')
    .select('id, created_by').eq('id', event_id).single()
  if (!event) {
    return new Response(JSON.stringify({ error: 'Event not found' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  const isOwner = event.created_by === user.id
  const isAdmin = callerRow?.role === 'admin'
  if (!isOwner && !isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const opts = (body.entitlements as Record<string, boolean>) || {}
  const { error: upsertErr } = await sb.from('leod_checkin_entitlements').upsert({
    event_id,
    checkin_core: true,
    multi_point_scanning: !!opts.multi_point_scanning,
    integration_api: !!opts.integration_api,
    personalization_station: !!opts.personalization_station,
    pii_in_api: !!opts.pii_in_api,
  }, { onConflict: 'event_id' })

  if (upsertErr) {
    return new Response(JSON.stringify({ error: upsertErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // created_by is nullable (service-role / no-JWT event inserts) — skip
  // the operator grant rather than fail on leod_checkin_operators'
  // NOT NULL user_id, matching the guard pattern in migration 045's
  // checkin_auto_grant_organizer() trigger.
  if (event.created_by) {
    const { error: grantErr } = await sb.from('leod_checkin_operators')
      .upsert({ event_id, user_id: event.created_by, role: 'organizer' },
        { onConflict: 'event_id,user_id' })
    if (grantErr) console.error('checkin-enable-event: organizer grant failed:', grantErr.message)
  }

  return new Response(JSON.stringify({ ok: true, event_id }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
