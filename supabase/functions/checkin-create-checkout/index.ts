// supabase/functions/checkin-create-checkout/index.ts
// Opens Stripe Checkout for one event's go-live. The webhook, not this
// function and not the success redirect, is what makes the event live.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }       from '../_shared/stripe.ts'
import { isWindowClosed } from '../_shared/checkin-policy.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: caller, error: callerErr } = await sb.from('leod_users')
    .select('active').eq('id', user.id).maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 500)
  if (!caller || caller.active === false) return json({ error: 'Account inactive' }, 403)

  const event_id = String(body.event_id || '')
  if (!event_id) return json({ error: 'event_id required' }, 400)

  // Going live is the owner's act alone, paid or complimentary (roles ruling 1).
  const gate = functionGate('checkin-create-checkout', await loadCallerRole(sb, event_id, user.id))
  if (!gate.ok) return json(gate.body, gate.status)

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('status, checkout_session_id, checkout_expires_at').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent) return json({ error: 'Set up check-in for this event first' }, 409)
  if (ent.status === 'live') return json({ error: 'This event is already live', code: 'already_live' }, 409)

  const { data: ev, error: evErr } = await sb.from('leod_events').select('name, date, timezone').eq('id', event_id).maybeSingle()
  if (evErr) return json({ error: evErr.message }, 500)
  if (!ev) return json({ error: 'Event not found' }, 404)
  // Before any Stripe call: paying for a window that has already closed
  // (or cannot be computed) buys nothing.
  if (isWindowClosed(String(ev.date ?? ''), String(ev.timezone ?? ''))) {
    return json({ error: 'Check-in for this event has already closed. Change the event date before going live.', code: 'window_closed' }, 409)
  }

  const priceId = Deno.env.get('CHECKIN_PRICE_ID')
  if (!priceId) return json({ error: 'Check-in payments are not configured' }, 503)

  const st = stripe()

  // Reuse this buyer's still-open session for the event, so a second click
  // (or a second tab) cannot produce two payable sessions.
  if (ent.checkout_session_id && ent.checkout_expires_at && new Date(ent.checkout_expires_at).getTime() > Date.now()) {
    try {
      const open = await st.checkout.sessions.retrieve(ent.checkout_session_id)
      if (open.status === 'open' && open.url && open.metadata?.buyer_id === user.id) return json({ url: open.url })
    } catch (e) {
      console.error('checkin-create-checkout: could not retrieve session', ent.checkout_session_id, (e as Error).message)
    }
  }

  // Customer reuse: CueDeck subscription, then the billing customer map,
  // then an earlier check-in purchase, else a new customer (recorded in the
  // map so repeated clicks do not create one customer each).
  // Check-in-only buyers have no leod_subscriptions row, which
  // create-checkout-session assumes.
  let customerId: string | null = null
  const { data: sub, error: subErr } = await sb.from('leod_subscriptions')
    .select('stripe_customer_id').eq('director_id', user.id).maybeSingle()
  if (subErr) return json({ error: subErr.message }, 500)
  customerId = sub?.stripe_customer_id ?? null
  if (!customerId) {
    const { data: bc, error: bcErr } = await sb.from('leod_billing_customers')
      .select('stripe_customer_id').eq('user_id', user.id).maybeSingle()
    if (bcErr) return json({ error: bcErr.message }, 500)
    customerId = bc?.stripe_customer_id ?? null
  }
  if (!customerId) {
    const { data: prev, error: prevErr } = await sb.from('leod_checkin_purchases')
      .select('stripe_customer_id').eq('buyer_id', user.id).not('stripe_customer_id', 'is', null)
      .order('created_at', { ascending: false }).limit(1)
    if (prevErr) return json({ error: prevErr.message }, 500)
    customerId = prev?.[0]?.stripe_customer_id ?? null
  }

  try {
    if (!customerId) {
      const c = await st.customers.create({ email: user.email ?? undefined, metadata: { cuedeck_user_id: user.id } })
      customerId = c.id
      const { error: mapErr } = await sb.from('leod_billing_customers')
        .insert({ user_id: user.id, stripe_customer_id: customerId })
      if (mapErr) console.error('checkin-create-checkout: billing customer not recorded for', user.id, mapErr.message)
    }
    const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
    const session = await st.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      invoice_creation: { enabled: true, invoice_data: { description: `CueDeck Check-in: ${ev.name}`, metadata: { event_id } } },
      client_reference_id: user.id,
      metadata: { product: 'checkin', event_id, buyer_id: user.id },
      payment_intent_data: { metadata: { product: 'checkin', event_id } },
      success_url: `${appUrl}/checkin/setup?event=${event_id}&paid=1`,
      cancel_url: `${appUrl}/checkin/setup?event=${event_id}&step=golive`,
      locale: 'auto',
      expires_at: expiresAt,
    })
    const { error: entUpdErr } = await sb.from('leod_checkin_entitlements')
      .update({ checkout_session_id: session.id, checkout_expires_at: new Date(expiresAt * 1000).toISOString() })
      .eq('event_id', event_id)
    if (entUpdErr) console.error('checkin-create-checkout: session not recorded on entitlement', event_id, entUpdErr.message)
    return json({ url: session.url })
  } catch (e) {
    console.error('checkin-create-checkout: stripe error for event', event_id, (e as Error).message)
    return json({ error: 'Could not start payment. Please try again.' }, 502)
  }
})
