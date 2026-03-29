// stripe-webhook — Handles Stripe webhook events.
// No JWT auth — uses Stripe signature verification instead.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }        from '../_shared/stripe.ts'

// Types for Supabase client
type SupabaseClient = ReturnType<typeof adminClient>
type StripeClient = ReturnType<typeof stripe>

// ── Invoice Capture Helper ─────────────────────────────────
// Captures invoice details into our database and triggers email
async function captureInvoice(
  sb: SupabaseClient,
  st: StripeClient,
  invoice: Record<string, unknown>
) {
  // Skip $0 invoices (e.g., trial start)
  const amountPaid = invoice.amount_paid as number || 0
  if (amountPaid === 0) {
    console.log('Skipping $0 invoice:', invoice.id)
    return
  }

  // Skip if invoice already captured
  const { data: existing } = await sb
    .from('leod_invoices')
    .select('id')
    .eq('stripe_invoice_id', invoice.id as string)
    .single()

  if (existing) {
    console.log('Invoice already captured:', invoice.id)
    return
  }

  // Find director_id from customer
  const customerId = invoice.customer as string
  const { data: subData } = await sb
    .from('leod_subscriptions')
    .select('director_id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!subData?.director_id) {
    console.error('No director found for customer:', customerId)
    return
  }

  // Fetch user's billing details
  const { data: userData } = await sb
    .from('leod_users')
    .select('name, email, company_name, vat_id, billing_address')
    .eq('id', subData.director_id)
    .single()

  // Extract customer email from Stripe invoice or user record
  const customerEmail = (invoice.customer_email as string) ||
    userData?.email ||
    (invoice.receipt_email as string)

  if (!customerEmail) {
    console.error('No customer email found for invoice:', invoice.id)
    return
  }

  // Generate invoice number
  const { data: invNum } = await sb.rpc('generate_invoice_number')
  const invoiceNumber = invNum || `INV-${Date.now()}`

  // Extract line items from Stripe invoice
  const stripeLines = (invoice.lines as { data?: Array<Record<string, unknown>> })?.data || []
  const lineItems = stripeLines.map((line) => {
    const period = line.period as { start?: number; end?: number } | undefined
    return {
      description: (line.description as string) || 'CueDeck Subscription',
      quantity: (line.quantity as number) || 1,
      unit_amount: (line.unit_amount as number) || (line.amount as number) || 0,
      amount: (line.amount as number) || 0,
      period_start: period?.start
        ? new Date(period.start * 1000).toISOString()
        : undefined,
      period_end: period?.end
        ? new Date(period.end * 1000).toISOString()
        : undefined,
    }
  })

  // Determine period from first line item
  const firstLine = stripeLines[0] as Record<string, unknown> | undefined
  const firstPeriod = firstLine?.period as { start?: number; end?: number } | undefined
  const periodStart = firstPeriod?.start
    ? new Date(firstPeriod.start * 1000).toISOString()
    : null
  const periodEnd = firstPeriod?.end
    ? new Date(firstPeriod.end * 1000).toISOString()
    : null

  // Insert invoice record
  const { data: newInvoice, error: insertError } = await sb
    .from('leod_invoices')
    .insert({
      director_id: subData.director_id,
      stripe_invoice_id: invoice.id as string,
      stripe_customer_id: customerId,
      invoice_number: invoiceNumber,
      status: 'paid',
      amount_due: (invoice.amount_due as number) || 0,
      amount_paid: amountPaid,
      currency: (invoice.currency as string) || 'eur',
      tax_amount: (invoice.tax as number) || 0,
      customer_email: customerEmail,
      customer_name: userData?.name || (invoice.customer_name as string) || null,
      company_name: userData?.company_name || null,
      vat_id: userData?.vat_id || null,
      billing_address: userData?.billing_address || null,
      line_items: lineItems,
      invoice_date: new Date().toISOString(),
      period_start: periodStart,
      period_end: periodEnd,
      paid_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('Failed to insert invoice:', insertError)
    return
  }

  console.log('Invoice captured:', invoiceNumber, newInvoice?.id)

  // Log activity
  await sb.rpc('log_activity', {
    p_user_id: subData.director_id,
    p_action: 'invoice_paid',
    p_category: 'billing',
    p_description: `Invoice ${invoiceNumber} paid: ${amountPaid / 100} ${(invoice.currency as string || 'eur').toUpperCase()}`,
    p_metadata: {
      invoice_id: newInvoice?.id,
      invoice_number: invoiceNumber,
      amount: amountPaid,
      currency: invoice.currency,
    },
  }).catch(() => {})

  // Trigger invoice email (fire and forget)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (supabaseUrl && serviceKey && newInvoice?.id) {
    fetch(`${supabaseUrl}/functions/v1/send-invoice-email`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ invoice_id: newInvoice.id }),
    }).catch(err => console.error('Failed to trigger invoice email:', err))
  }
}

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

          // Log activity
          await sb.rpc('log_activity', {
            p_user_id: directorId,
            p_action: 'event_purchased',
            p_category: 'billing',
            p_description: 'Purchased per-event credit',
            p_metadata: { plan: 'perevent', checkout_session_id: session.id },
          }).catch(() => {})
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

        // Log activity
        const { data: subOwner } = await sb.from('leod_subscriptions')
          .select('director_id').eq('stripe_customer_id', customerId).single()
        if (subOwner?.director_id) {
          await sb.rpc('log_activity', {
            p_user_id: subOwner.director_id,
            p_action: event.type === 'customer.subscription.created' ? 'subscription_created' : 'subscription_updated',
            p_category: 'billing',
            p_description: `Subscription ${event.type === 'customer.subscription.created' ? 'started' : 'updated'}: ${plan || 'unknown'} (${status})`,
            p_metadata: { plan, status, interval, subscription_id: subscription.id },
          }).catch(() => {})
        }

        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        // Get director_id before updating
        const { data: cancelledSub } = await sb.from('leod_subscriptions')
          .select('director_id, plan').eq('stripe_customer_id', subscription.customer).single()

        await sb.from('leod_subscriptions')
          .update({ status: 'expired', stripe_subscription_id: null })
          .eq('stripe_customer_id', subscription.customer)

        // Log activity
        if (cancelledSub?.director_id) {
          await sb.rpc('log_activity', {
            p_user_id: cancelledSub.director_id,
            p_action: 'subscription_cancelled',
            p_category: 'billing',
            p_description: `Subscription cancelled: ${cancelledSub.plan || 'unknown'}`,
            p_metadata: { previous_plan: cancelledSub.plan, subscription_id: subscription.id },
          }).catch(() => {})
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription) {
          const { data: failedSub } = await sb.from('leod_subscriptions')
            .select('director_id, plan').eq('stripe_subscription_id', invoice.subscription).single()

          await sb.from('leod_subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription)

          // Log activity
          if (failedSub?.director_id) {
            await sb.rpc('log_activity', {
              p_user_id: failedSub.director_id,
              p_action: 'payment_failed',
              p_category: 'billing',
              p_description: `Payment failed for ${failedSub.plan || 'subscription'}`,
              p_metadata: { invoice_id: invoice.id, amount: invoice.amount_due },
            }).catch(() => {})
          }
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

        // ── Invoice capture (non-blocking) ──────────────────────
        // Create invoice record and trigger email delivery
        try {
          await captureInvoice(sb, st, invoice)
        } catch (invoiceErr) {
          // Log but don't fail the webhook
          console.error('Invoice capture failed:', invoiceErr)
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
