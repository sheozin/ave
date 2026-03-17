// admin-promote — Promotes a user to the admin role.
// Cannot modify own admin status.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse body
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Ping support (deploy verification)
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Auth: verify JWT ─────────────────────────────────────────────────
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

  // Verify caller is admin
  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden — admins only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ───────────────────────────────────────────────────
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const targetId = String(body.user_id || '').trim()
  if (!targetId || !UUID_RE.test(targetId)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid user_id — must be a valid UUID' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Cannot modify own admin status
  if (targetId === user.id) {
    return new Response(JSON.stringify({ error: 'Cannot modify your own admin status' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Guard: prevent demoting existing admins ──────────────────────────
  const { data: targetRow } = await sb.from('leod_users')
    .select('role').eq('id', targetId).single()
  if (targetRow?.role === 'admin') {
    return new Response(JSON.stringify({ error: 'User is already an admin — this endpoint only promotes, it cannot demote' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Promote to admin ─────────────────────────────────────────────────
  try {
    const { error } = await sb.from('leod_users')
      .update({ role: 'admin' })
      .eq('id', targetId)
    if (error) throw error
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log ─────────────────────────────────────────────────────────
  try {
    await sb.from('leod_admin_audit').insert({
      admin_id:    user.id,
      action:      'promote_to_admin',
      target_type: 'user',
      target_id:   targetId,
      details:     { previous_action: 'role set to admin' },
    })
  } catch (auditErr) {
    console.error('Audit log insert failed:', (auditErr as Error).message)
  }

  return new Response(
    JSON.stringify({ ok: true, action: 'promote_to_admin', user_id: targetId }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
