// supabase/functions/checkin-import-attendees/index.ts
// CSV/XLSX import with column mapping and dry-run preview. The client
// parses the file and sends normalized rows; this function validates,
// dedups, and (unless dry_run) upserts.
//
// Dedup key: external_ref if present, else email, scoped to event_id.
// New attendees get a random URL-safe qr_token; matched attendees keep
// theirs — re-importing never invalidates an already-sent QR.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

interface ImportRow {
  first_name: string
  last_name: string
  email?: string
  company?: string
  role_title?: string
  ticket_type?: string
  external_ref?: string
}

interface RowResult {
  row: ImportRow
  action: 'create' | 'update' | 'skip'
  reason?: string
}

function makeQrToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function validateRow(row: ImportRow): string | null {
  if (!row.first_name?.trim()) return 'Missing first_name'
  if (!row.last_name?.trim()) return 'Missing last_name'
  return null
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

  const event_id = String(body.event_id || '')
  const rows = Array.isArray(body.rows) ? (body.rows as ImportRow[]) : []
  const dry_run = body.dry_run !== false

  if (!event_id || rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing event_id or rows' }), {
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

  const { data: existing } = await sb.from('leod_checkin_attendees')
    .select('id, external_ref, email')
    .eq('event_id', event_id)

  const byExternalRef = new Map((existing || []).filter(a => a.external_ref).map(a => [a.external_ref, a]))
  const byEmail = new Map((existing || []).filter(a => a.email).map(a => [a.email!.toLowerCase(), a]))

  const results: RowResult[] = []
  const toInsert: Record<string, unknown>[] = []
  const toUpdate: { id: string; patch: Record<string, unknown> }[] = []

  for (const row of rows) {
    const invalid = validateRow(row)
    if (invalid) { results.push({ row, action: 'skip', reason: invalid }); continue }

    const match = (row.external_ref && byExternalRef.get(row.external_ref))
      || (row.email && byEmail.get(row.email.toLowerCase()))

    if (match) {
      results.push({ row, action: 'update' })
      toUpdate.push({
        id: match.id,
        patch: {
          first_name: row.first_name, last_name: row.last_name,
          email: row.email || null, company: row.company || null,
          role_title: row.role_title || null,
          ticket_type: row.ticket_type || 'attendee',
        },
      })
    } else {
      results.push({ row, action: 'create' })
      toInsert.push({
        event_id,
        first_name: row.first_name, last_name: row.last_name,
        email: row.email || null, company: row.company || null,
        role_title: row.role_title || null,
        ticket_type: row.ticket_type || 'attendee',
        external_ref: row.external_ref || null,
        qr_token: makeQrToken(),
      })
    }
  }

  const summary = {
    total: rows.length,
    to_create: results.filter(r => r.action === 'create').length,
    to_update: results.filter(r => r.action === 'update').length,
    to_skip: results.filter(r => r.action === 'skip').length,
  }

  if (dry_run) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, summary, results }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (toInsert.length) {
    const { error } = await sb.from('leod_checkin_attendees').insert(toInsert)
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }
  // Track per-row failures rather than discarding them: silently
  // swallowing an update error here would make summary.to_update
  // overcount successes and mislead the organizer about whether
  // their re-import actually applied.
  const updateErrors: { id: string; error: string }[] = []
  for (const u of toUpdate) {
    const { error } = await sb.from('leod_checkin_attendees').update(u.patch).eq('id', u.id)
    if (error) {
      console.error('checkin-import-attendees: update failed for attendee', u.id, error.message)
      updateErrors.push({ id: u.id, error: error.message })
    }
  }

  return new Response(JSON.stringify({
    ok: true, dry_run: false, summary,
    ...(updateErrors.length ? { update_errors: updateErrors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
