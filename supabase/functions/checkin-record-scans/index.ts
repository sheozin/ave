// supabase/functions/checkin-record-scans/index.ts
// Batch scan ingest for the check-in station. The server is the final
// authority on checked_in_at: it is set only when currently NULL, so
// the first scan wins even when two desks sync out of order. A scan
// that arrives second is recorded as 'duplicate', never dropped.
// Each item is ONE call to checkin_apply_scan (migration 062): dedup,
// attendee update, test cap and audit row commit in a single
// transaction, serialised per event.
//
// Every item produces a scan_events row — including unknown_token and
// wrong_event — so the audit shows the attempt and the client_id is
// deduped against the station's retry-on-reconnect.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { isWithinWindow } from '../_shared/checkin-policy.ts'

interface Item {
  client_id: string
  attendee_id: string
  scanned_at: string
  action: 'checkin' | 'undo'
  // Required for action 'undo': the checked_in_at the desk was looking
  // at when the operator pressed undo. Used as a compare-and-set guard
  // so a stale undo cannot wipe a newer check-in — see the undo branch.
  prev_checked_in_at?: string
}

interface ItemError {
  client_id: string | null
  stage: string
  error: string
}

// A desk offline through a keynote accumulates hundreds of scans, and
// each item costs 2-4 sequential round trips. An unbounded batch blows
// the function's wall-clock limit, the response is lost, and the desk
// re-sends the identical batch on every reconnect — a livelock that
// gets worse the longer the desk was offline. Failing fast is
// recoverable; a livelock is not.
// THE CLIENT MUST CHUNK its outbox into requests of at most this size.
const MAX_ITEMS = 200

// The live window must not trust the device clock: a desk could stamp
// scans with any time. A live check-in is only honoured when scanned_at
// is within a small skew of the server's now, and not older than a day
// (an offline desk flushing the same day is fine). Test mode is exempt.
const LIVE_SKEW_FUTURE_MS = 5 * 60 * 1000
const LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Strict ISO-8601 with an explicit zone; Date.parse alone accepts
// zone-less and non-ISO strings that Postgres would read differently.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
function validTs(v: unknown): v is string {
  return typeof v === 'string' && ISO_TS.test(v) && Number.isFinite(Date.parse(v))
}
function liveTimeOk(scannedMs: number, nowMs: number): boolean {
  if (!Number.isFinite(scannedMs)) return false
  return scannedMs <= nowMs + LIVE_SKEW_FUTURE_MS && scannedMs >= nowMs - LIVE_MAX_AGE_MS
}

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

  const event_id      = String(body.event_id || '')
  const scan_point_id = body.scan_point_id ? String(body.scan_point_id) : null
  const items         = Array.isArray(body.items) ? (body.items as Item[]) : null

  if (!event_id || !items) {
    return new Response(JSON.stringify({ error: 'event_id and items required' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (items.length > MAX_ITEMS) {
    return new Response(JSON.stringify({
      error: `Too many items: ${items.length}. Maximum is ${MAX_ITEMS} per request — chunk the outbox.`,
    }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // This client uses the service-role key, which bypasses RLS entirely.
  // checkin_role_for_event() cannot be used here: it is SECURITY
  // DEFINER over auth.uid(), which is NULL on a service-role
  // connection, so it would return NULL for every caller. The operator
  // grant is therefore read directly, exactly as
  // checkin-import-attendees does.
  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer' && opRow?.role !== 'crew') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers and crew only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Second half of what checkin_role_for_event() would have enforced:
  // the entitlement gate from migration 051. An operator grant alone is
  // auto-created for every event's owner regardless of purchase, so
  // without this an event that never enabled check-in could still take
  // scans.
  const { data: entRow, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status').eq('event_id', event_id).maybeSingle()
  if (entErr) {
    return new Response(JSON.stringify({ error: entErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!entRow?.checkin_core) {
    return new Response(JSON.stringify({ error: 'Check-in is not enabled for this event' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const isTest = entRow.status !== 'live'

  // The live window is a calendar rule in the event's own timezone.
  const { data: evRow, error: evErr } = await sb.from('leod_events')
    .select('date, timezone').eq('id', event_id).single()
  if (evErr || !evRow) {
    return new Response(JSON.stringify({ error: evErr?.message || 'Event not found' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const nowMs = Date.now()

  // Validated once here rather than per item: the migration 049 trigger
  // rejects a scan_point_id belonging to another event, which would
  // otherwise fail the insert for every item in the batch.
  if (scan_point_id) {
    const { data: sp } = await sb.from('leod_checkin_scan_points')
      .select('id').eq('id', scan_point_id).eq('event_id', event_id).maybeSingle()
    if (!sp) {
      return new Response(JSON.stringify({ error: 'scan_point_id does not belong to this event' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  const results: Record<string, string> = {}
  const errors: ItemError[] = []

  // Validate every item first (both modes), so nothing malformed reaches
  // the sort or the database.
  const valid: Item[] = []
  for (const raw of items) {
    const it = raw as Partial<Item> | null
    const cid = it && typeof it === 'object' && typeof it.client_id === 'string' ? it.client_id : null
    const bad = (error: string) => {
      errors.push({ client_id: cid, stage: 'validate', error })
      if (cid) results[cid] = 'error'
    }
    if (!it || typeof it !== 'object') { bad('item must be an object'); continue }
    if (!cid || typeof it.attendee_id !== 'string' || !it.attendee_id) {
      bad('client_id and attendee_id are required'); continue
    }
    if (!validTs(it.scanned_at)) { bad('scanned_at must be ISO-8601 with a timezone'); continue }
    if (it.action !== 'checkin' && it.action !== 'undo') { bad(`Unknown action: ${it.action}`); continue }
    if (it.action === 'undo' && !validTs(it.prev_checked_in_at)) {
      bad('prev_checked_in_at is required for action undo (ISO-8601 with a timezone)'); continue
    }
    valid.push(it as Item)
  }

  // Defense in depth for ordering: a checkin and its later undo arriving
  // in the wrong array order must still apply in time order. Sorted on
  // parsed instants, since offsets may differ between strings.
  const ordered = valid.sort((a, b) => Date.parse(a.scanned_at) - Date.parse(b.scanned_at))

  for (const it of ordered) {
    // Computed in test mode too: SQL ignores it while the event is test,
    // but the event can go live between our entitlement read and the RPC.
    const p_live_time_ok = liveTimeOk(Date.parse(it.scanned_at), nowMs)
      && isWithinWindow(it.scanned_at, evRow.date, evRow.timezone)
    const { data: result, error } = await sb.rpc('checkin_apply_scan', {
      p_event_id: event_id,
      p_client_id: it.client_id,
      p_attendee_id: it.attendee_id,
      p_scanned_at: it.scanned_at,
      p_action: it.action,
      p_prev_checked_in_at: it.action === 'undo' ? it.prev_checked_in_at : null,
      p_operator_id: user.id,
      p_scan_point_id: scan_point_id,
      p_live_time_ok,
    })
    if (error) {
      const clash = 'client_id already used for another event'
      // CK001: raised by checkin_apply_scan when the client_id is recorded under another event.
      if (error.code === 'CK001') {
        errors.push({ client_id: it.client_id, stage: 'apply', error: clash })
        results[it.client_id] = 'error'
        continue
      }
      // 23505: a concurrent insert of the same client_id won; its row is authoritative.
      if (error.code === '23505') {
        const { data: raced } = await sb.from('leod_checkin_scan_events')
          .select('result, event_id').eq('client_id', it.client_id).maybeSingle()
        if (raced?.event_id && raced.event_id !== event_id) {
          errors.push({ client_id: it.client_id, stage: 'apply', error: clash })
          results[it.client_id] = 'error'
          continue
        }
        if (raced?.result) { results[it.client_id] = raced.result; continue }
      }
      console.error('checkin-record-scans: apply failed for', it.client_id, error.message)
      errors.push({ client_id: it.client_id, stage: 'apply', error: error.message })
      results[it.client_id] = 'error'
      continue
    }
    results[it.client_id] = String(result)
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, results, errors }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
