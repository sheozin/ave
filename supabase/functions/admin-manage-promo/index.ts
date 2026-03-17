// admin-manage-promo — Admin-only promo code management.
// Actions: create, update, deactivate

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ACTIONS    = new Set(['create', 'update', 'deactivate'])
const VALID_CODE_TYPES = new Set(['discount', 'trial_extension', 'plan_unlock'])

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
  const action = String(body.action || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: `Invalid action — must be one of: ${[...VALID_ACTIONS].join(', ')}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const code = String(body.code || '').trim().toUpperCase()
  if (!code) {
    return new Response(JSON.stringify({ error: 'Missing code' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Execute action ───────────────────────────────────────────────────
  let responseExtra: Record<string, unknown> = {}

  try {
    if (action === 'create') {
      const type = String(body.type || '').trim()
      if (!VALID_CODE_TYPES.has(type)) {
        return new Response(JSON.stringify({ error: `Invalid type — must be one of: ${[...VALID_CODE_TYPES].join(', ')}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const insertPayload: Record<string, unknown> = {
        code,
        type,
        active: true,
      }

      // Optional fields
      if (body.stripe_coupon_id !== undefined) insertPayload.stripe_coupon_id = String(body.stripe_coupon_id)
      if (body.extra_days       !== undefined) insertPayload.extra_days       = Number(body.extra_days)
      if (body.granted_plan     !== undefined) insertPayload.granted_plan     = String(body.granted_plan)
      if (body.granted_months   !== undefined) insertPayload.granted_months   = Number(body.granted_months)
      if (body.max_uses         !== undefined) insertPayload.max_uses         = Number(body.max_uses)
      if (body.expires_at       !== undefined) insertPayload.expires_at       = String(body.expires_at)

      const { data, error } = await sb.from('leod_promo_codes')
        .insert(insertPayload)
        .select()
        .single()
      if (error) throw error

      responseExtra = { promo: data }

    } else if (action === 'update') {
      const updatePayload: Record<string, unknown> = {}

      if (body.max_uses         !== undefined) updatePayload.max_uses         = body.max_uses === null ? null : Number(body.max_uses)
      if (body.expires_at       !== undefined) updatePayload.expires_at       = body.expires_at === null ? null : String(body.expires_at)
      if (body.active           !== undefined) updatePayload.active           = Boolean(body.active)
      if (body.stripe_coupon_id !== undefined) updatePayload.stripe_coupon_id = String(body.stripe_coupon_id)
      if (body.extra_days       !== undefined) updatePayload.extra_days       = Number(body.extra_days)
      if (body.granted_plan     !== undefined) updatePayload.granted_plan     = String(body.granted_plan)
      if (body.granted_months   !== undefined) updatePayload.granted_months   = Number(body.granted_months)

      if (Object.keys(updatePayload).length === 0) {
        return new Response(JSON.stringify({ error: 'No updatable fields provided' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const { data, error } = await sb.from('leod_promo_codes')
        .update(updatePayload)
        .eq('code', code)
        .select()
        .single()
      if (error) throw error
      if (!data) {
        return new Response(JSON.stringify({ error: 'Code not found' }), {
          status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      responseExtra = { promo: data }

    } else if (action === 'deactivate') {
      const { data, error } = await sb.from('leod_promo_codes')
        .update({ active: false })
        .eq('code', code)
        .select()
        .single()
      if (error) throw error
      if (!data) {
        return new Response(JSON.stringify({ error: 'Code not found' }), {
          status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      responseExtra = { code, deactivated: true }
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log ─────────────────────────────────────────────────────────
  sb.from('leod_admin_audit').insert({
    admin_id:    user.id,
    action:      `manage_promo.${action}`,
    target_type: 'promo_code',
    target_id:   code,
    details:     { action, code, type: body.type, max_uses: body.max_uses, expires_at: body.expires_at },
  }).then(() => {}).catch(() => {})

  return new Response(
    JSON.stringify({ ok: true, action, ...responseExtra }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
