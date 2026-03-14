// manage-operator — Director suspends, reactivates, or removes an operator.
// suspend  → leod_users.active = false
// reactivate → leod_users.active = true
// remove   → delete leod_users row + ban auth account (≈100 years)

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ACTIONS = new Set(['suspend', 'reactivate', 'remove'])

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

  // ── Auth: verify JWT ────────────────────────────────────────────
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

  // Verify caller is a director
  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'director') {
    return new Response(JSON.stringify({ error: 'Forbidden — directors only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ──────────────────────────────────────────────
  const action   = String(body.action   || '').trim()
  const targetId = String(body.user_id  || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action — must be suspend, reactivate, or remove' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!targetId) {
    return new Response(JSON.stringify({ error: 'Missing user_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Cannot act on yourself
  if (targetId === user.id) {
    return new Response(JSON.stringify({ error: 'Cannot perform this action on your own account' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Execute action ──────────────────────────────────────────────
  try {
    if (action === 'suspend') {
      const { error } = await sb.from('leod_users')
        .update({ active: false })
        .eq('id', targetId)
      if (error) throw error

    } else if (action === 'reactivate') {
      const { error } = await sb.from('leod_users')
        .update({ active: true })
        .eq('id', targetId)
      if (error) throw error

    } else if (action === 'remove') {
      // Delete leod_users row first
      const { error: deleteErr } = await sb.from('leod_users')
        .delete()
        .eq('id', targetId)
      if (deleteErr) throw deleteErr

      // Ban auth account (preserves audit trail — ≈100 years)
      const { error: banErr } = await sb.auth.admin.updateUserById(targetId, {
        ban_duration: '876600h',
      })
      if (banErr) {
        console.error('Auth ban failed (non-fatal):', banErr.message)
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log (best-effort, fire-and-forget) ────────────────────
  sb.from('leod_event_log').insert({
    event_id:       null,
    session_id:     null,
    action:         `OPERATOR_${action.toUpperCase()}`,
    operator_id:    user.id,
    operator_role:  'director',
    payload:        { target_user_id: targetId, action },
    server_time_ms: Date.now(),
  }).then(() => {}).catch(() => {})

  return new Response(
    JSON.stringify({ ok: true, action }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
