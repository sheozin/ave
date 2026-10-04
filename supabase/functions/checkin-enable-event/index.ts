// supabase/functions/checkin-enable-event/index.ts
// Provisions the check-in module for an event: creates the
// entitlements row (idempotent via upsert) and makes sure the event's
// creator holds an organizer grant (covers events created before
// migration 045's auto-grant trigger existed). Caller must be the
// event's creator, a CueDeck admin, or already an 'organizer' in
// leod_checkin_operators — the last case covers a co-organizer
// granted by the original owner adjusting entitlements later, since
// migration 045 defines organizer as "event owner, or anyone they
// grant" full control. Ownership/admin must stay as separate,
// independent checks: they're what let this function work at all on
// an event that has never had check-in enabled, where no operator row
// satisfying that condition exists yet (this function IS the thing
// that creates the first one).

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
    .select('role, active').eq('id', user.id).single()
  if (!callerRow || callerRow.active === false) {
    return new Response(JSON.stringify({ error: 'Account inactive' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()

  const isOwner = event.created_by === user.id
  const isAdmin = callerRow?.role === 'admin'
  const isOrganizer = opRow?.role === 'organizer'
  if (!isOwner && !isAdmin && !isOrganizer) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Create in test. ON CONFLICT DO NOTHING: an existing row keeps its
  // status (this function must never move an event to or from live;
  // only checkin_mark_paid / checkin_mark_refunded do that).
  const { error: insErr } = await sb.from('leod_checkin_entitlements')
    .upsert({ event_id, checkin_core: true, status: 'test' }, { onConflict: 'event_id', ignoreDuplicates: true })
  if (insErr) {
    return new Response(JSON.stringify({ error: insErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Operational settings: what the organizer chose for this event.
  const s = (body.settings as Record<string, unknown>) || {}
  const patch: Record<string, boolean> = {}
  for (const k of ['self_registration', 'kiosk_self_print', 'auto_send_qr_email']) {
    if (typeof s[k] === 'boolean') patch[k] = s[k] as boolean
  }
  // Commercial entitlements: what was bought. Admin only. Before this
  // change any event owner could switch these on for themselves.
  const ent = (body.entitlements as Record<string, unknown>) || {}
  if (isAdmin) {
    for (const k of ['multi_point_scanning', 'integration_api', 'personalization_station', 'pii_in_api']) {
      if (typeof ent[k] === 'boolean') patch[k] = ent[k] as boolean
    }
  }
  if (Object.keys(patch).length) {
    const { error: patchErr } = await sb.from('leod_checkin_entitlements').update(patch).eq('event_id', event_id)
    if (patchErr) {
      return new Response(JSON.stringify({ error: patchErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  const { data: after, error: readErr } = await sb.from('leod_checkin_entitlements')
    .select('status').eq('event_id', event_id).single()
  if (readErr || !after) {
    return new Response(JSON.stringify({ error: readErr?.message || 'Entitlement missing after write' }), {
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
    if (grantErr) {
      return new Response(JSON.stringify({ error: 'Could not grant organizer: ' + grantErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  return new Response(JSON.stringify({ ok: true, event_id, status: after.status }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
