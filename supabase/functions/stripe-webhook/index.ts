// stripe-webhook — Handles Stripe webhook events.
// No JWT auth — uses Stripe signature verification instead.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }        from '../_shared/stripe.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  const sb = adminClient()
  const st = stripe()
  const rawBody = await req.text()

  // ── Ping support (deploy verification) ───────────────────
  // Check if body is a JSON ping before treating as webhook
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed._ping) {
      return new Response(JSON.stringify({ pong: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  } catch {
    // Not JSON — continue as webhook
  }

  // ── Verify Stripe signature ──────────────────────────────
  const signature = req.headers.get('Stripe-Signature')
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing Stripe-Signature' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
  let event
  try {
    event = await st.webhooks.constructEventAsync(rawBody, signature, webhookSecret)
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message)
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Handle events ────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object
        const directorId = session.client_reference_id || session.metadata?.director_id
        const plan = session.metadata?.plan

        if (!directorId) break

        if (plan === 'perevent') {
          // Increment per-event credits
          await sb.rpc('increment_events_purchased', { p_director_id: directorId }).catch(async () => {
            // Fallback: direct update
            const { data } = await sb.from('leod_subscriptions')
              .select('events_purchased').eq('director_id', directorId).single()
            if (data) {
              await sb.from('leod_subscriptions')
                .update({ events_purchased: data.events_purchased + 1, plan: 'perevent', status: 'active' })
                .eq('director_id', directorId)
            }
          })
        }
        // For subscriptions, the subscription.created event handles setup
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        const customerId = subscription.customer

        // Resolve plan from price metadata
        const priceId = subscription.items?.data?.[0]?.price?.id
        let plan = subscription.items?.data?.[0]?.price?.metadata?.cuedeck_plan
        if (!plan && priceId) {
          // Fallback: fetch price from Stripe
          try {
            const price = await st.prices.retrieve(priceId)
            plan = price.metadata?.cuedeck_plan || price.product?.metadata?.cuedeck_plan
          } catch { /* ignore */ }
        }

        // Map Stripe status to our status
        let status = 'active'
        if (subscription.status === 'past_due') status = 'past_due'
        else if (subscription.status === 'canceled' || subscription.status === 'unpaid') status = 'expired'
        else if (subscription.status === 'active' || subscription.status === 'trialing') status = 'active'

        const interval = subscription.items?.data?.[0]?.price?.recurring?.interval || null

        const updateData: Record<string, unknown> = {
          stripe_subscription_id: subscription.id,
          status,
          billing_interval: interval,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end:   new Date(subscription.current_period_end * 1000).toISOString(),
          trial_ends_at: null, // trial consumed
        }

        if (plan) updateData.plan = plan
        if (subscription.cancel_at) {
          updateData.cancel_at = new Date(subscription.cancel_at * 1000).toISOString()
        } else {
          updateData.cancel_at = null
        }

        await sb.from('leod_subscriptions')
          .update(updateData)
          .eq('stripe_customer_id', customerId)

        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        await sb.from('leod_subscriptions')
          .update({ status: 'expired', stripe_subscription_id: null })
          .eq('stripe_customer_id', subscription.customer)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription) {
          await sb.from('leod_subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription)
        }
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.subscription) {
          const updateData: Record<string, unknown> = { status: 'active' }
          if (invoice.lines?.data?.[0]?.period?.end) {
            updateData.current_period_end = new Date(invoice.lines.data[0].period.end * 1000).toISOString()
          }
          await sb.from('leod_subscriptions')
            .update(updateData)
            .eq('stripe_subscription_id', invoice.subscription)
        }
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }
  } catch (e) {
    console.error(`Error handling ${event.type}:`, e)
    // Still return 200 to prevent Stripe retries for processing errors
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
