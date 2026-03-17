// admin-manage-subscription — Admin-only subscription management.
// Actions: override_plan, extend_trial, gift_months

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ACTIONS = new Set(['override_plan', 'extend_trial', 'gift_months'])
const VALID_PLANS   = new Set(['trial', 'perevent', 'starter', 'pro', 'enterprise'])
const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const action     = String(body.action      || '').trim()
  const directorId = String(body.director_id || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: `Invalid action — must be one of: ${[...VALID_ACTIONS].join(', ')}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!directorId || !UUID_RE.test(directorId)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid director_id — must be a valid UUID' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Fetch existing subscription ──────────────────────────────────────
  const { data: subscription, error: subErr } = await sb
    .from('leod_subscriptions')
    .select('*')
    .eq('director_id', directorId)
    .single()

  if (subErr || !subscription) {
    return new Response(JSON.stringify({ error: 'No subscription found for this director' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Execute action ───────────────────────────────────────────────────
  let responseExtra: Record<string, unknown> = {}

  try {
    if (action === 'override_plan') {
      const plan = String(body.plan || '').trim()
      if (!VALID_PLANS.has(plan)) {
        return new Response(JSON.stringify({ error: `Invalid plan — must be one of: ${[...VALID_PLANS].join(', ')}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const { error } = await sb.from('leod_subscriptions')
        .update({ plan, status: 'active' })
        .eq('director_id', directorId)
      if (error) throw error

      responseExtra = { plan }

    } else if (action === 'extend_trial') {
      const days = Number(body.days ?? 14)
      if (!Number.isFinite(days) || days <= 0) {
        return new Response(JSON.stringify({ error: 'days must be a positive number' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const baseDate = subscription.trial_ends_at
        ? new Date(subscription.trial_ends_at)
        : new Date()
      const newTrialEnd = new Date(baseDate.getTime() + days * 86_400_000)

      const { error } = await sb.from('leod_subscriptions')
        .update({ trial_ends_at: newTrialEnd.toISOString(), status: 'active' })
        .eq('director_id', directorId)
      if (error) throw error

      responseExtra = { new_trial_ends_at: newTrialEnd.toISOString(), days_added: days }

    } else if (action === 'gift_months') {
      const plan   = String(body.plan || 'pro').trim()
      const months = Number(body.months ?? 1)

      if (!VALID_PLANS.has(plan)) {
        return new Response(JSON.stringify({ error: `Invalid plan — must be one of: ${[...VALID_PLANS].join(', ')}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      if (!Number.isFinite(months) || months <= 0) {
        return new Response(JSON.stringify({ error: 'months must be a positive number' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      const now = new Date()
      const periodEnd = new Date(now)
      periodEnd.setMonth(periodEnd.getMonth() + months)

      const { error } = await sb.from('leod_subscriptions')
        .update({
          plan,
          status:             'active',
          current_period_end: periodEnd.toISOString(),
          trial_ends_at:      null,
        })
        .eq('director_id', directorId)
      if (error) throw error

      responseExtra = {
        plan,
        months_gifted:      months,
        new_period_end:     periodEnd.toISOString(),
      }
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Audit log ─────────────────────────────────────────────────────────
  try {
    await sb.from('leod_admin_audit').insert({
      admin_id:    user.id,
      action:      `manage_subscription.${action}`,
      target_type: 'subscription',
      target_id:   directorId,
      details:     { action, plan: body.plan, days: body.days, months: body.months, ...responseExtra },
    })
  } catch (auditErr) {
    console.error('Audit log insert failed:', (auditErr as Error).message)
  }

  return new Response(
    JSON.stringify({ ok: true, action, ...responseExtra }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
