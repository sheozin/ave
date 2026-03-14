// update-billing-details — Director updates billing fields and syncs to Stripe customer.
// Updates company_name, vat_id, billing_address in leod_users and mirrors to Stripe metadata.

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

  // ── Auth: verify caller is a director ──────────────────────────
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

  // ── Extract and normalise billing fields ───────────────────────
  const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : '') || null
  const company_name     = trim(body.company_name)
  const vat_id           = trim(body.vat_id)
  const billing_address  = trim(body.billing_address)

  // ── Update leod_users ──────────────────────────────────────────
  const { error: updateErr } = await sb.from('leod_users')
    .update({ company_name, vat_id, billing_address })
    .eq('id', user.id)
  if (updateErr) {
    return new Response(JSON.stringify({ error: updateErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Sync to Stripe (non-fatal) ─────────────────────────────────
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (stripeKey) {
    const { data: subRow } = await sb.from('leod_subscriptions')
      .select('stripe_customer_id').eq('user_id', user.id).single()

    const stripeCustomerId = subRow?.stripe_customer_id as string | null | undefined
    if (stripeCustomerId) {
      try {
        const params = new URLSearchParams()
        if (company_name)    params.set('name', company_name)
        if (vat_id)          params.set('metadata[vat_id]', vat_id)
        if (billing_address) params.set('address[line1]', billing_address)

        const stripeRes = await fetch(
          `https://api.stripe.com/v1/customers/${stripeCustomerId}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${stripeKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          },
        )
        if (!stripeRes.ok) {
          const errText = await stripeRes.text()
          console.error('Stripe customer update failed:', stripeRes.status, errText)
        }
      } catch (stripeErr) {
        console.error('Stripe customer update error:', (stripeErr as Error).message)
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  )
})
