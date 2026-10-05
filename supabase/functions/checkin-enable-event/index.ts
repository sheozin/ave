// supabase/functions/checkin-enable-event/index.ts
// Provisions the check-in module for an event: creates the
// entitlements row (idempotent via upsert) and makes sure the event's
// creator holds an organizer grant (covers events created before
// migration 045's auto-grant trigger existed). Caller must be the
// owner, an organizer (checkin-roles.ts 'test_setup'), or a CueDeck
// admin. A complimentary owner's call also takes the event live;
// nobody else's does (roles ruling 1).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { can, loadCallerRole } from '../_shared/checkin-roles.ts'

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
  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) {
    return new Response(JSON.stringify({ error: roleErr }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const isAdmin = callerRow?.role === 'admin'
  // Test mode and event settings: the owner, an organizer, or a CueDeck admin.
  if (!isAdmin && !can(role, 'test_setup')) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Complimentary accounts: read from the table with the service role,
  // never from the request body.
  let isComp = false
  if (event.created_by) {
    const { data: compRow, error: compErr } = await sb.from('leod_checkin_comp_accounts')
      .select('user_id').eq('user_id', event.created_by).maybeSingle()
    if (compErr) {
      return new Response(JSON.stringify({ error: compErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    isComp = !!compRow
  }

  // Always create in test. ON CONFLICT DO NOTHING: an existing row keeps
  // its status (only checkin_mark_paid / checkin_mark_refunded /
  // checkin_mark_comp_live move it).
  const { error: insErr } = await sb.from('leod_checkin_entitlements')
    .upsert({ event_id, checkin_core: true, status: 'test' }, { onConflict: 'event_id', ignoreDuplicates: true })
  if (insErr) {
    return new Response(JSON.stringify({ error: insErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Comp owner: go live through the same lock + test-data cleanup as a
  // paid go-live (no-op when already live).
  // A complimentary go-live is the same act as paying, so it is the
  // owner's alone (roles ruling 1). An organizer saving settings on a
  // complimentary event leaves it in test mode.
  if (isComp && can(role, 'go_live')) {
    const { error: liveErr } = await sb.rpc('checkin_mark_comp_live', { p_event_id: event_id })
    if (liveErr) {
      return new Response(JSON.stringify({ error: liveErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
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

  return new Response(JSON.stringify({ ok: true, event_id, status: after.status, comp: isComp }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
