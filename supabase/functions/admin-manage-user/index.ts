// admin-manage-user — Admin-only user management.
// Actions: update_role, suspend, reactivate, remove, reset_password, impersonate

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ACTIONS = new Set([
  'update_role', 'suspend', 'reactivate', 'remove', 'reset_password', 'impersonate',
])

const VALID_ROLES = new Set([
  'director', 'stage', 'av', 'interp', 'reg', 'signage', 'pending',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  // ── Auth: verify JWT ────────────────────────────────────────────────
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

  // ── Validate input ──────────────────────────────────────────────────
  const action   = String(body.action   || '').trim()
  const targetId = String(body.user_id  || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: `Invalid action — must be one of: ${[...VALID_ACTIONS].join(', ')}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!targetId || !UUID_RE.test(targetId)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid user_id — must be a valid UUID' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Cannot remove or suspend own account
  if ((action === 'remove' || action === 'suspend') && targetId === user.id) {
    return new Response(JSON.stringify({ error: 'Cannot perform this action on your own account' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Execute action ──────────────────────────────────────────────────
  let responseExtra: Record<string, unknown> = {}

  try {
    if (action === 'update_role') {
      const newRole = String(body.role || '').trim()
      if (!VALID_ROLES.has(newRole)) {
        return new Response(JSON.stringify({ error: `Invalid role — must be one of: ${[...VALID_ROLES].join(', ')}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const updatePayload: Record<string, unknown> = { role: newRole }
      if (body.name  !== undefined) updatePayload.name  = String(body.name).trim()
      if (body.organization !== undefined) updatePayload.organization = String(body.organization).trim()

      const { error } = await sb.from('leod_users')
        .update(updatePayload)
        .eq('id', targetId)
      if (error) throw error

    } else if (action === 'suspend') {
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

      // Ban auth account (preserves audit trail — ~100 years)
      const { error: banErr } = await sb.auth.admin.updateUserById(targetId, {
        ban_duration: '876600h',
      })
      if (banErr) {
        console.error('Auth ban failed (non-fatal):', banErr.message)
      }

    } else if (action === 'reset_password') {
      // Look up email for this user
      const { data: targetUser, error: lookupErr } = await sb.auth.admin.getUserById(targetId)
      if (lookupErr || !targetUser?.user?.email) {
        return new Response(JSON.stringify({ error: 'Could not find user email' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const email = targetUser.user.email

      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email,
      })
      if (linkErr) throw linkErr
      responseExtra = { recovery_link: linkData?.properties?.action_link }

    } else if (action === 'impersonate') {
      // Look up email for this user
      const { data: targetUser, error: lookupErr } = await sb.auth.admin.getUserById(targetId)
      if (lookupErr || !targetUser?.user?.email) {
        return new Response(JSON.stringify({ error: 'Could not find user email' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const email = targetUser.user.email

      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'magiclink',
        email,
      })
      if (linkErr) throw linkErr
      responseExtra = { magic_link: linkData?.properties?.action_link }
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log ────────────────────────────────────────────────────────
  try {
    await sb.from('leod_admin_audit').insert({
      admin_id:    user.id,
      action:      `manage_user.${action}`,
      target_type: 'user',
      target_id:   targetId,
      details:     { action, role: body.role, name: body.name, organization: body.organization },
    })
  } catch (auditErr) {
    console.error('Audit log insert failed:', (auditErr as Error).message)
  }

  return new Response(
    JSON.stringify({ ok: true, action, ...responseExtra }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
