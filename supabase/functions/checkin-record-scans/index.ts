// supabase/functions/checkin-record-scans/index.ts
// Batch scan ingest for the check-in station. The server is the final
// authority on checked_in_at: it is set only when currently NULL, so
// the first scan wins even when two desks sync out of order. A scan
// that arrives second is recorded as 'duplicate', never dropped.
//
// Every item produces a scan_events row — including unknown_token and
// wrong_event — so the audit shows the attempt and the client_id is
// deduped against the station's retry-on-reconnect.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

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
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core').eq('event_id', event_id).single()
  if (!entRow?.checkin_core) {
    return new Response(JSON.stringify({ error: 'Check-in is not enabled for this event' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

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

  for (const it of items) {
    if (!it?.client_id || !it.attendee_id || !it.scanned_at) {
      errors.push({
        client_id: it?.client_id ?? null, stage: 'validate',
        error: 'client_id, attendee_id and scanned_at are required',
      })
      if (it?.client_id) results[it.client_id] = 'error'
      continue
    }
    if (it.action !== 'checkin' && it.action !== 'undo') {
      errors.push({ client_id: it.client_id, stage: 'validate', error: `Unknown action: ${it.action}` })
      results[it.client_id] = 'error'
      continue
    }
    if (it.action === 'undo' && !it.prev_checked_in_at) {
      errors.push({
        client_id: it.client_id, stage: 'validate',
        error: 'prev_checked_in_at is required for action undo',
      })
      results[it.client_id] = 'error'
      continue
    }

    // At-most-once. The station retries on reconnect, so a flush whose
    // response was lost re-sends this item. If we already recorded it,
    // return the original verdict and touch nothing.
    const { data: prior, error: priorErr } = await sb
      .from('leod_checkin_scan_events')
      .select('result').eq('client_id', it.client_id).maybeSingle()
    if (priorErr) {
      errors.push({ client_id: it.client_id, stage: 'dedup_lookup', error: priorErr.message })
      results[it.client_id] = 'error'
      continue
    }
    if (prior) { results[it.client_id] = prior.result; continue }

    const { data: att, error: attErr } = await sb
      .from('leod_checkin_attendees')
      .select('id, event_id, checked_in_at').eq('id', it.attendee_id).maybeSingle()
    if (attErr) {
      errors.push({ client_id: it.client_id, stage: 'attendee_lookup', error: attErr.message })
      results[it.client_id] = 'error'
      continue
    }

    let result: string
    // The migration 049 trigger requires attendee_id to belong to the
    // scan event's event_id, so it stays NULL for both the no-match and
    // the cross-event cases — otherwise the audit insert would raise.
    let auditAttendeeId: string | null = null

    if (!att) {
      result = 'unknown_token'
    } else if (att.event_id !== event_id) {
      result = 'wrong_event'
    } else {
      auditAttendeeId = att.id

      if (it.action === 'undo') {
        // Compare-and-set against the value the desk saw. Without this
        // guard a stale undo silently revokes a newer, legitimate
        // check-in:
        //   09:00  Desk 1 checks in the attendee, syncs.
        //   09:02  Operator hits undo (wrong badge). Desk 1's wifi is
        //          already down, so the undo sits in its outbox.
        //   09:30  The attendee arrives properly and Desk 3 checks
        //          them in. Legitimate.
        //   10:15  Desk 1 reconnects and flushes the 09:02 undo.
        // An unconditional NULL would mark a physically present
        // attendee as not-checked-in and corrupt the head count. The
        // client sorts its own outbox by scanned_at, but that cannot
        // order across desks, which is exactly this case.
        const { data: cleared, error: undoErr } = await sb
          .from('leod_checkin_attendees')
          .update({ checked_in_at: null })
          .eq('id', it.attendee_id)
          .eq('checked_in_at', it.prev_checked_in_at!)
          .select('id')
        if (undoErr) {
          errors.push({ client_id: it.client_id, stage: 'undo_update', error: undoErr.message })
          results[it.client_id] = 'error'
          continue
        }
        // 0 rows means a newer check-in superseded this undo. Record
        // the attempt as a no-op rather than inventing a result value:
        // 'duplicate' is already in the migration 053 CHECK.
        result = cleared && cleared.length > 0 ? 'undo' : 'duplicate'
      } else if (att.checked_in_at) {
        result = 'duplicate'
      } else {
        const { data: updated, error: updErr } = await sb
          .from('leod_checkin_attendees')
          .update({ checked_in_at: it.scanned_at })
          .eq('id', it.attendee_id)
          .is('checked_in_at', null)
          .select('id')
        if (updErr) {
          // Must not fall through to the 0-rows branch: reporting a
          // failed write as 'duplicate' would tell the operator the
          // attendee was already checked in, which is the most
          // misleading verdict this function could return.
          errors.push({ client_id: it.client_id, stage: 'checkin_update', error: updErr.message })
          results[it.client_id] = 'error'
          continue
        }
        result = updated && updated.length > 0 ? 'ok' : 'duplicate'
      }
    }

    // The state change above and this audit row are separate
    // transactions. If the insert fails the attendee row still carries
    // the change, so the item is reported 'error' and the retry will
    // re-derive its verdict from current state. Making the pair atomic
    // needs a Postgres function; it is not achievable from here.
    const { error: insErr } = await sb
      .from('leod_checkin_scan_events').insert({
        id: crypto.randomUUID(),
        event_id,
        client_id: it.client_id,
        attendee_id: auditAttendeeId,
        scan_point_id,
        device_id: null,
        operator_id: user.id,
        scanned_at: it.scanned_at,
        result,
      })

    if (insErr) {
      // 23505 = unique violation on client_id: a concurrent flush of
      // the same item won the race. Its row is authoritative, so read
      // it back rather than reporting our own verdict.
      if (insErr.code === '23505') {
        const { data: raced } = await sb
          .from('leod_checkin_scan_events')
          .select('result').eq('client_id', it.client_id).maybeSingle()
        results[it.client_id] = raced?.result ?? result
        continue
      }
      console.error('checkin-record-scans: scan event insert failed for', it.client_id, insErr.message)
      errors.push({ client_id: it.client_id, stage: 'scan_event_insert', error: insErr.message })
      results[it.client_id] = 'error'
      continue
    }

    results[it.client_id] = result
  }

  return new Response(JSON.stringify({ ok: errors.length === 0, results, errors }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
