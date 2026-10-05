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
//
// Two callers (scanner Build A, migration 097):
// - a desk: operator JWT, items carry attendee_id, check-in or undo;
// - a paired scanner: body.device_key instead of a JWT. A scanner holds
//   only QR tokens (no ids, names or companies), so its items carry
//   qr_token and may only check in. Its scans are attributed to the device
//   (device_id) and never to an invented operator, at the scan point the
//   device was paired to, which must be switched on (_shared/checkin-scanner.ts).
//   The reply adds the guest's first name and ticket type so the scanner can
//   show who it is, but only when that scan checked the guest in ('ok'), for
//   a single scan made in the last two minutes, within NAME_RATE_PER_MIN per
//   device claimed atomically (checkin_device_name_quota, migration 099). A
//   scanner holds every token; without these a paired phone could post them
//   all and harvest the guest list's names, which the tokens-only design
//   exists to prevent. Now learning a name means checking that guest in,
//   which shows on the dashboard. Repeats, batches and offline flushes get
//   verdicts without names.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { isWithinWindow } from '../_shared/checkin-policy.ts'
import { isUuid, loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { authDevice } from '../_shared/checkin-device.ts'
import { scanPointRefusal, normalizeToken } from '../_shared/checkin-scanner.ts'

interface Item {
  client_id: string
  attendee_id: string     // a scanner sends qr_token instead; resolved below
  qr_token?: string
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
// Names returned to a scanner per minute. A door sees one guest every few
// seconds at most; anything faster is not a person holding up a phone.
const NAME_RATE_PER_MIN = 20
const NAME_FRESH_MS = 2 * 60 * 1000

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

  const sb = adminClient()
  const event_id = String(body.event_id || '')
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  // ── Who is calling: a paired scanner, or a signed-in desk operator ──
  const deviceKey = typeof body.device_key === 'string' ? body.device_key : ''
  let operatorId: string | null = null
  let deviceId: string | null = null
  let deviceScanPoint: string | null = null
  if (deviceKey) {
    if (!isUuid(event_id)) return fail(400, 'event_id required')
    const auth = await authDevice(sb, event_id, deviceKey, 'scanner')
    if (!auth.ok) return fail(auth.status, auth.error)
    deviceId = auth.device.id
    deviceScanPoint = auth.device.scan_point_id
  } else {
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
    if (!jwt) return fail(401, 'Unauthorized')
    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
    if (authErr || !user) return fail(401, 'Unauthorized')
    operatorId = user.id
  }

  // A scanner always scans at the point it was paired to, whatever it sends.
  const scan_point_id = deviceId ? deviceScanPoint : (body.scan_point_id ? String(body.scan_point_id) : null)
  // Which browser desk sent this batch (event-day spec, feature 1). A
  // missing or malformed value is stored as NULL rather than failing the
  // batch: the scans matter more than the label.
  const desk_id       = isUuid(body.desk_id) ? body.desk_id : null
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
  // checkin_role_for_event() cannot be used here (auth.uid() is NULL on a
  // service-role connection), so the caller's role is read with
  // loadCallerRole() from _shared/checkin-roles.ts.
  // A device was checked against this event above; an operator's role is
  // checked here.
  if (operatorId) {
    const gate = functionGate('checkin-record-scans', await loadCallerRole(sb, event_id, operatorId))
    if (!gate.ok) {
      return new Response(JSON.stringify(gate.body), {
        status: gate.status, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  // Second half of what checkin_role_for_event() would have enforced:
  // the entitlement gate from migration 051. An operator grant alone is
  // auto-created for every event's owner regardless of purchase, so
  // without this an event that never enabled check-in could still take
  // scans.
  const { data: entRow, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status, multi_point_scanning, entrance_scanning, session_scanning').eq('event_id', event_id).maybeSingle()
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
    const { data: sp, error: spErr } = await sb.from('leod_checkin_scan_points')
      .select('id, kind').eq('id', scan_point_id).eq('event_id', event_id).maybeSingle()
    if (spErr) {
      return new Response(JSON.stringify({ error: spErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (!sp) {
      return new Response(JSON.stringify({ error: 'scan_point_id does not belong to this event' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    // Door and session scanning are per-event choices (058); a scan at a
    // point whose kind is switched off is refused with the reason.
    const refusal = scanPointRefusal(sp.kind, {
      multi_point_scanning: !!entRow.multi_point_scanning,
      entrance_scanning: !!entRow.entrance_scanning,
      session_scanning: !!entRow.session_scanning,
    })
    if (refusal) return fail(403, refusal)
  } else if (deviceId) {
    return fail(403, 'This scanner is not paired to a scan point. Pair it again from the desk.')
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
    if (deviceId) {
      // A scanner sends a token, never an id, and cannot undo.
      const tok = normalizeToken(String(it.qr_token ?? ''))
      if (!cid || !tok) { bad('client_id and a valid qr_token are required'); continue }
      if (it.action !== 'checkin') { bad('A scanner can only check people in'); continue }
      it.qr_token = tok
      it.attendee_id = ''
    } else if (!cid || typeof it.attendee_id !== 'string' || !it.attendee_id) {
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
  // Scanner tokens -> attendees, in one read. A token not on this event's
  // list gets a random id, so checkin_apply_scan records the attempt as
  // unknown_token in the audit like any other.
  const who: Record<string, { first_name: string | null; ticket_type: string | null }> = {}
  const whoByAttendee: Record<string, { first_name: string | null; ticket_type: string | null }> = {}
  // Names only for one fresh scan (see the header); the quota is claimed
  // after the scan, and only if it checked the guest in.
  const nameEligible = !!deviceId && valid.length === 1
    && Math.abs(Date.now() - Date.parse(valid[0].scanned_at)) <= NAME_FRESH_MS
  if (deviceId && valid.length) {
    const tokens = [...new Set(valid.map(it => it.qr_token as string))]
    const { data: rows, error: tokErr } = await sb.from('leod_checkin_attendees')
      .select('id, qr_token, first_name, ticket_type').eq('event_id', event_id).in('qr_token', tokens)
    if (tokErr) return fail(500, tokErr.message)
    const byToken = new Map<string, { id: string; first_name: string | null; ticket_type: string | null }>()
    for (const r of rows ?? []) byToken.set(r.qr_token, r)
    for (const it of valid) {
      const hit = byToken.get(it.qr_token as string)
      it.attendee_id = hit ? hit.id : crypto.randomUUID()
      if (hit && nameEligible) whoByAttendee[hit.id] = { first_name: hit.first_name, ticket_type: hit.ticket_type }
    }
  }

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
      p_operator_id: operatorId,
      p_scan_point_id: scan_point_id,
      p_live_time_ok,
      p_desk_id: deviceId ? null : desk_id,
      ...(deviceId ? { p_device_id: deviceId } : {}),
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
        const { data: raced, error: racedErr } = await sb.from('leod_checkin_scan_events')
          .select('result, event_id').eq('client_id', it.client_id).maybeSingle()
        if (racedErr) {
          errors.push({ client_id: it.client_id, stage: 'apply', error: racedErr.message })
          results[it.client_id] = 'error'
          continue
        }
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
    if (deviceId && result === 'ok' && whoByAttendee[it.attendee_id]) {
      // checkin_apply_scan answers a known client_id with its stored result
      // and inserts nothing, so 'ok' alone does not prove THIS token was
      // checked in: a replayed client_id with another guest's token would
      // otherwise read that guest's name. The stored row must be this
      // device's scan of this attendee (review of cc97059).
      const { data: row, error: rowErr } = await sb.from('leod_checkin_scan_events')
        .select('attendee_id, device_id').eq('client_id', it.client_id).eq('event_id', event_id).maybeSingle()
      if (rowErr) { console.warn('checkin-record-scans: scan row read failed', rowErr.message); continue }
      if (!row || row.attendee_id !== it.attendee_id || row.device_id !== deviceId) continue
      const { data: quotaOk, error: quotaErr } = await sb.rpc('checkin_device_name_quota', {
        p_device_id: deviceId, p_limit: NAME_RATE_PER_MIN,
      })
      if (quotaErr) console.warn('checkin-record-scans: name quota failed', quotaErr.message)
      else if (quotaOk === true) who[it.client_id] = whoByAttendee[it.attendee_id]
    }
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, results, errors, ...(deviceId ? { who } : {}) }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
