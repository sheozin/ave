// manage-operator — Director suspends, reactivates, or removes an operator.
// suspend  → leod_users.active = false
// reactivate → leod_users.active = true
// remove   → ban auth account (≈100 years), then delete leod_users row
// set_role → leod_users.role = body.role (operator roles only)
// The target must be an operator on the caller's team (invited_by = the
// team owner); the caller must be an active director.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ACTIONS = new Set(['suspend', 'reactivate', 'remove', 'set_role'])
// Never 'admin' or 'pending': set_role only moves operators between crew roles.
const OPERATOR_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

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

  // Verify caller is an active director
  const { data: callerRow, error: callerErr } = await sb.from('leod_users')
    .select('role, invited_by, active').eq('id', user.id).maybeSingle()
  if (callerErr) {
    return new Response(JSON.stringify({ error: callerErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!callerRow || callerRow.role !== 'director' || callerRow.active === false) {
    return new Response(JSON.stringify({ error: 'Forbidden — directors only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ──────────────────────────────────────────────
  const action   = String(body.action   || '').trim()
  const targetId = String(body.user_id  || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action — must be suspend, reactivate, remove or set_role' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const newRole = String(body.role || '').trim()
  if (action === 'set_role' && !OPERATOR_ROLES.has(newRole)) {
    return new Response(JSON.stringify({ error: 'Invalid role' }), {
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

  // ── Target must be an operator on the caller's team ─────────────
  // Before this check any director could suspend or remove any user,
  // including other tenants' event owners.
  const teamOwner: string = callerRow.invited_by ?? user.id
  const { data: target, error: targetErr } = await sb.from('leod_users')
    .select('id, invited_by').eq('id', targetId).maybeSingle()
  if (targetErr) {
    return new Response(JSON.stringify({ error: targetErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!target || target.invited_by !== teamOwner) {
    return new Response(JSON.stringify({ error: 'Forbidden: not an operator on your team' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Execute action ──────────────────────────────────────────────
  try {
    if (action === 'suspend') {
      const { data, error } = await sb.from('leod_users')
        .update({ active: false })
        .eq('id', targetId).select('id')
      if (error) throw error
      if (!data?.length) throw new Error('No operator row updated')

    } else if (action === 'reactivate') {
      const { data, error } = await sb.from('leod_users')
        .update({ active: true })
        .eq('id', targetId).select('id')
      if (error) throw error
      if (!data?.length) throw new Error('No operator row updated')

    } else if (action === 'remove') {
      // Ban the auth account first (preserves audit trail — ≈100 years).
      // If the ban fails nothing is deleted: a removed operator whose account
      // still signs in must not be reported as removed.
      const { error: banErr } = await sb.auth.admin.updateUserById(targetId, {
        ban_duration: '876600h',
      })
      if (banErr) throw new Error(`Remove failed: the account could not be banned (${banErr.message})`)

      const { error: deleteErr } = await sb.from('leod_users')
        .delete()
        .eq('id', targetId)
      if (deleteErr) throw deleteErr

    } else if (action === 'set_role') {
      const { data: owned, error: ownedErr } = await sb.from('leod_events')
        .select('id').eq('created_by', targetId).limit(1)
      if (ownedErr) throw ownedErr
      if (owned && owned.length > 0) {
        return new Response(JSON.stringify({ error: 'This account owns events; its role cannot be changed here' }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const { data, error } = await sb.from('leod_users')
        .update({ role: newRole })
        .eq('id', targetId).select('id')
      if (error) throw error
      if (!data?.length) throw new Error('No operator row updated')
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log (best-effort, fire-and-forget) ────────────────────
  const { error: logErr } = await sb.from('leod_event_log').insert({
    event_id:       null,
    session_id:     null,
    action:         `OPERATOR_${action.toUpperCase()}`,
    operator_id:    user.id,
    operator_role:  'director',
    payload:        action === 'set_role' ? { target_user_id: targetId, action, role: newRole } : { target_user_id: targetId, action },
    server_time_ms: Date.now(),
  })
  if (logErr) console.error(`OPERATOR_${action.toUpperCase()} log failed:`, logErr.message)

  return new Response(
    JSON.stringify(action === 'set_role' ? { ok: true, action, role: newRole } : { ok: true, action }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
