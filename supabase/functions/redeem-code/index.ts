// redeem-code — Validates and applies a promo/gift code.
// Supports three code types: discount, trial_extension, plan_unlock.

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

  // ── Auth: verify caller via JWT ──────────────────────────────────
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

  // ── Extract and normalise code ───────────────────────────────────
  const code = String(body.code || '').trim().toUpperCase()
  if (!code) {
    return new Response(JSON.stringify({ error: 'Missing code' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Look up promo code ───────────────────────────────────────────
  const { data: promo, error: promoErr } = await sb
    .from('leod_promo_codes')
    .select('*')
    .eq('code', code)
    .single()

  if (promoErr || !promo) {
    return new Response(JSON.stringify({ error: 'Code not found' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate code ────────────────────────────────────────────────
  if (!promo.active) {
    return new Response(JSON.stringify({ error: 'Code is no longer active' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'Code has expired' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (promo.max_uses !== null && promo.uses >= promo.max_uses) {
    return new Response(JSON.stringify({ error: 'Code has reached its maximum uses' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Resolve director ID ──────────────────────────────────────────
  const { data: callerRow, error: callerErr } = await sb
    .from('leod_users')
    .select('role, invited_by')
    .eq('id', user.id)
    .single()

  if (callerErr || !callerRow) {
    return new Response(JSON.stringify({ error: 'User profile not found' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const directorId =
    callerRow.role === 'director' || !callerRow.invited_by
      ? user.id
      : callerRow.invited_by

  // ── Get director's subscription ──────────────────────────────────
  const { data: subscription, error: subErr } = await sb
    .from('leod_subscriptions')
    .select('*')
    .eq('director_id', directorId)
    .single()

  if (subErr || !subscription) {
    return new Response(JSON.stringify({ error: 'No subscription found for this account' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Apply code by type ───────────────────────────────────────────
  let result: Record<string, unknown>

  if (promo.type === 'discount') {
    // Discount codes are applied at checkout — nothing to write to DB here
    result = {
      ok: true,
      type: 'discount',
      stripe_coupon_id: promo.stripe_coupon_id,
      message: 'Discount will be applied at checkout',
    }

  } else if (promo.type === 'trial_extension') {
    const currentEnd = subscription.trial_ends_at
      ? new Date(subscription.trial_ends_at)
      : new Date()
    const newEnd = new Date(currentEnd.getTime() + promo.extra_days * 86_400_000)

    const { error: updateErr } = await sb
      .from('leod_subscriptions')
      .update({ trial_ends_at: newEnd.toISOString(), status: 'active' })
      .eq('director_id', directorId)

    if (updateErr) {
      return new Response(JSON.stringify({ error: 'Failed to extend trial: ' + updateErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    result = {
      ok: true,
      type: 'trial_extension',
      message: `Trial extended by ${promo.extra_days} day${promo.extra_days === 1 ? '' : 's'}`,
      new_trial_ends_at: newEnd.toISOString(),
    }

  } else if (promo.type === 'plan_unlock') {
    const now = new Date()
    const periodEnd = new Date(now)
    periodEnd.setMonth(periodEnd.getMonth() + (promo.granted_months ?? 1))

    const { error: updateErr } = await sb
      .from('leod_subscriptions')
      .update({
        plan: promo.granted_plan || 'pro',
        status: 'active',
        current_period_end: periodEnd.toISOString(),
        trial_ends_at: null,
      })
      .eq('director_id', directorId)

    if (updateErr) {
      return new Response(JSON.stringify({ error: 'Failed to unlock plan: ' + updateErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const months = promo.granted_months ?? 1
    result = {
      ok: true,
      type: 'plan_unlock',
      message: `Pro plan unlocked for ${months} month${months === 1 ? '' : 's'}`,
      new_period_end: periodEnd.toISOString(),
    }

  } else {
    return new Response(JSON.stringify({ error: `Unknown code type: ${promo.type}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Increment uses ───────────────────────────────────────────────
  await sb
    .from('leod_promo_codes')
    .update({ uses: promo.uses + 1 })
    .eq('code', code)

  return new Response(JSON.stringify(result), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
