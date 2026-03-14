// create-checkout-session — Director creates a Stripe Checkout session for upgrade.
// Returns { url } to redirect the browser to Stripe Checkout.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }        from '../_shared/stripe.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

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

  // ── Auth: verify caller is a director ──────────────────────
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

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'director') {
    return new Response(JSON.stringify({ error: 'Forbidden — directors only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ─────────────────────────────────────────
  const priceId  = String(body.price_id || '').trim()
  const plan     = String(body.plan || '').trim()
  const interval = String(body.interval || '').trim() || null

  if (!priceId || !plan) {
    return new Response(JSON.stringify({ error: 'Missing price_id or plan' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    const st = stripe()

    // ── Get or create Stripe Customer ──────────────────────────
    const { data: subRow } = await sb.from('leod_subscriptions')
      .select('stripe_customer_id')
      .eq('director_id', user.id)
      .single()

    let customerId = subRow?.stripe_customer_id

    if (!customerId) {
      const customer = await st.customers.create({
        email: user.email,
        metadata: { cuedeck_director_id: user.id },
      })
      customerId = customer.id

      // Store customer ID
      await sb.from('leod_subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('director_id', user.id)
    }

    // ── Determine checkout mode ────────────────────────────────
    const isPerevent = plan === 'perevent'
    const siteUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'

    const sessionParams: Record<string, unknown> = {
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isPerevent ? 'payment' : 'subscription',
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url:  `${siteUrl}/?checkout=cancel`,
      client_reference_id: user.id,
      metadata: { director_id: user.id, plan, interval },
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
      locale: 'auto',
    }

    const session = await st.checkout.sessions.create(sessionParams)

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (e) {
    console.error('Stripe checkout error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
