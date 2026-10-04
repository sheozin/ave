// stripe-webhook — Handles Stripe webhook events.
// No JWT auth — uses Stripe signature verification instead.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }        from '../_shared/stripe.ts'
import { routeCheckoutSession, checkinAmountMatches, classifyPurchaseLookup, type PurchaseLookup } from '../_shared/checkin-policy.ts'

// Types for Supabase client
type SupabaseClient = ReturnType<typeof adminClient>
type StripeClient = ReturnType<typeof stripe>

// ── Shared-Stripe-account guard ────────────────────────────
// This Stripe account is shared with CueQuote, which has its own webhook
// endpoint (rurazinghbfskuoeikwi). Stripe cannot scope an endpoint by product,
// so CueQuote's subscription events arrive here too.
//
// That matters because the handlers below match on stripe_customer_id alone.
// A CueQuote event for a customer who also uses CueDeck would overwrite their
// stripe_subscription_id, replace their billing dates and null trial_ends_at —
// and customer.subscription.deleted would set status='expired', cancelling a
// live CueDeck subscription.
//
// Keyed on product id, NOT on price.metadata.cuedeck_plan: verified 2026-08-06
// that no price or product on this account carries that key, so requiring it
// would reject every CueDeck event too. Product ids also survive repricing.
const CUEDECK_PRODUCTS = new Set([
  'prod_U7KbPVFt9Ghe3x', // CueDeck Starter
  'prod_U7KgJwoWMsbmzN', // CueDeck Pro
  'prod_U7KZqMU9oG4QWD', // CueDeck Pay-per-Event
])
const PEREVENT_PRODUCT_ID = 'prod_U7KZqMU9oG4QWD'
// Check-in product id comes from the secret so it is not hardcoded twice.
// Empty means every check-in session routes to 'ignore' (logged loudly below).
const CHECKIN_PRODUCT_ID = Deno.env.get('CHECKIN_PRODUCT_ID') || ''
if (CHECKIN_PRODUCT_ID) CUEDECK_PRODUCTS.add(CHECKIN_PRODUCT_ID)

function isCueDeckSubscription(subscription: Record<string, unknown> | null | undefined): boolean {
  const items = (subscription?.items as { data?: Record<string, unknown>[] } | undefined)?.data
  const price = items?.[0]?.price as Record<string, unknown> | undefined
  const product = price?.product
  const productId = typeof product === 'string' ? product : (product as { id?: string } | undefined)?.id
  return !!productId && CUEDECK_PRODUCTS.has(productId)
}

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
  const { error: logErr } = await sb.rpc('log_activity', {
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
  })
  if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)

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

// ── Check-in / Pay-per-Event helpers ───────────────────────
// Product ids on a Checkout Session's line items. Throws on a Stripe error;
// the caller turns that into a 500 so Stripe retries.
async function sessionProductIds(st: StripeClient, sessionId: string): Promise<string[]> {
  const items = await st.checkout.sessions.listLineItems(sessionId, { limit: 10, expand: ['data.price.product'] })
  // deno-lint-ignore no-explicit-any
  return items.data.map((li: Record<string, any>) =>
    typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id).filter(Boolean)
}

// Records a routed, paid check-in session. Returns checkin_mark_paid's
// result ('live' | 'already_processed' | 'already_live' | 'orphaned'), or
// null when the RPC failed, so the caller answers 500 and Stripe retries.
async function handleCheckinPaid(sb: SupabaseClient, session: Record<string, unknown>): Promise<string | null> {
  const md = session.metadata as Record<string, string>
  const details = session.total_details as Record<string, number> | undefined
  const { data, error } = await sb.rpc('checkin_mark_paid', {
    p_event_id: md.event_id,
    p_buyer_id: md.buyer_id,
    p_session_id: session.id as string,
    p_payment_intent: (session.payment_intent as string) ?? null,
    p_customer: (session.customer as string) ?? null,
    p_amount_total: (session.amount_total as number) ?? null,
    p_amount_tax: details?.amount_tax ?? null,
    p_currency: (session.currency as string) ?? null,
  })
  if (error) {
    console.error('stripe-webhook: checkin_mark_paid failed for', session.id, error.message)
    return null
  }
  return String(data)
}

// Is this payment intent a check-in purchase? 'error' must fail the
// delivery so Stripe retries, never read as "not ours".
async function lookupCheckinPurchase(sb: SupabaseClient, pi: string): Promise<PurchaseLookup> {
  const res = await sb.from('leod_checkin_purchases')
    .select('buyer_id, event_id').eq('stripe_payment_intent_id', pi).maybeSingle()
  const r = classifyPurchaseLookup(res)
  if (r.kind === 'error') console.error('stripe-webhook: purchase lookup failed for', pi, r.message)
  return r
}

// Something a person must act on (refund, double charge, dispute). Lands in
// activity_log under category 'billing_alert' (allowed since migration 065).
// p_user_id is nullable; a failed write is logged, never fatal.
async function billingAlert(sb: SupabaseClient, kind: string, userId: string | null, description: string, details: Record<string, unknown>) {
  console.error('stripe-webhook: BILLING ALERT', kind, description, JSON.stringify(details))
  const { error } = await sb.rpc('log_activity', {
    p_user_id: userId,
    p_action: kind,
    p_category: 'billing_alert',
    p_description: description,
    p_metadata: details,
  })
  if (error) console.error('stripe-webhook: billing alert not recorded', kind, error.message)
}

// The check-in price, cached per isolate like checkin-price. Throws when the
// price id is unset or Stripe fails; the caller answers 500 so Stripe retries.
let checkinPriceCache: { at: number; unit_amount: number | null; currency: string } | null = null
async function checkinPrice(st: StripeClient): Promise<{ unit_amount: number | null; currency: string }> {
  if (checkinPriceCache && Date.now() - checkinPriceCache.at < 10 * 60 * 1000) return checkinPriceCache
  const priceId = Deno.env.get('CHECKIN_PRICE_ID')
  if (!priceId) throw new Error('CHECKIN_PRICE_ID is not set')
  const p = await st.prices.retrieve(priceId)
  checkinPriceCache = { at: Date.now(), unit_amount: p.unit_amount, currency: p.currency }
  return checkinPriceCache
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  // Non-200 makes Stripe retry the delivery. Used only where a paid
  // check-in or Pay-per-Event credit would otherwise be lost.
  const retry = (msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })

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
    console.error('Webhook signature verification failed:', (e as Error).message)
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Handle events ────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object
        const isCheckinMd = session.metadata?.product === 'checkin'
        const isPereventMd = session.metadata?.plan === 'perevent'
        // Subscriptions are set up by customer.subscription.created.
        if (!isCheckinMd && !isPereventMd) break

        // A misconfiguration must not drop a payment: without the product id
        // the router would ignore the session, so answer 500 and let Stripe
        // retry until CHECKIN_PRODUCT_ID is set.
        if (isCheckinMd && !CHECKIN_PRODUCT_ID) {
          console.error('stripe-webhook: CHECKIN_PRODUCT_ID is not set; check-in session', session.id, 'NOT recorded, asking Stripe to retry')
          return retry('check-in not configured')
        }

        // The outer catch answers 200 to stop retries. A paid session that
        // failed to record must be retried, so exceptions here (a Stripe
        // line-item fetch, a network blip) become a 500.
        let productIds: string[]
        try {
          productIds = await sessionProductIds(st, session.id)
        } catch (e) {
          console.error('stripe-webhook: line-item fetch failed for', session.id, (e as Error).message)
          return retry('line items unavailable')
        }

        const r = routeCheckoutSession(session, productIds, CHECKIN_PRODUCT_ID, PEREVENT_PRODUCT_ID)
        if (r.route === 'ignore') {
          console.log('stripe-webhook: session', session.id, 'ignored:', r.reason)
          break
        }

        if (r.route === 'checkin') {
          const buyerId = (session.metadata?.buyer_id as string) || null
          const eventId = (session.metadata?.event_id as string) || null
          const alertBase = { session_id: session.id, event_id: eventId, payment_intent: session.payment_intent ?? null }

          let price: { unit_amount: number | null; currency: string }
          try {
            price = await checkinPrice(st)
          } catch (e) {
            console.error('stripe-webhook: check-in price unavailable for', session.id, (e as Error).message)
            return retry('check-in price unavailable')
          }
          if (!checkinAmountMatches(session, price)) {
            await billingAlert(sb, 'checkin_amount_mismatch', buyerId,
              'Check-in session paid an amount that does not match the check-in price; event NOT made live',
              { ...alertBase, amount_subtotal: session.amount_subtotal ?? null, currency: session.currency ?? null,
                expected_amount: price.unit_amount, expected_currency: price.currency })
            break
          }

          let result: string | null
          try {
            result = await handleCheckinPaid(sb, session)
          } catch (e) {
            console.error('stripe-webhook: check-in handling threw for', session.id, (e as Error).message)
            return retry('check-in handling failed')
          }
          if (result === null) return retry('checkin_mark_paid failed')

          if (result === 'already_live') {
            await billingAlert(sb, 'checkin_already_live', buyerId,
              'Second paid check-in session for an event that was already live; likely double charge, refund one',
              { ...alertBase, amount_total: session.amount_total ?? null })
          } else if (result === 'orphaned') {
            await billingAlert(sb, 'checkin_orphaned_payment', buyerId,
              'Check-in paid for an event or entitlement that no longer exists; needs a manual refund',
              { ...alertBase, amount_total: session.amount_total ?? null })
          } else {
            console.log('stripe-webhook: check-in', eventId, '->', result)
          }
          break
        }

        // r.route === 'perevent': the router has confirmed payment_status
        // 'paid' and the Pay-per-Event product, so either event type is safe.
        const directorId = session.client_reference_id || session.metadata?.director_id
        if (!directorId) {
          await billingAlert(sb, 'perevent_no_director', null,
            'Paid Pay-per-Event session has no director id; credit not recorded',
            { session_id: session.id, customer: session.customer ?? null })
          break
        }

        // Idempotent per session since migration 065: a redelivery returns
        // 'already_processed' instead of crediting twice.
        const { data: credit, error: incErr } = await sb.rpc('increment_events_purchased', {
          p_director_id: directorId,
          p_session_id: session.id,
        })
        if (incErr) {
          console.error('stripe-webhook: increment_events_purchased failed for', directorId, incErr.message)
          return retry('credit not recorded')
        }
        if (credit === 'orphaned') {
          await billingAlert(sb, 'perevent_orphaned_payment', directorId,
            'Paid Pay-per-Event session for a director with no subscription row; credit not applied',
            { session_id: session.id })
          break
        }
        console.log('stripe-webhook: Pay-per-Event', session.id, '->', credit)
        if (credit !== 'credited') break

        const { error: logErr } = await sb.rpc('log_activity', {
          p_user_id: directorId,
          p_action: 'event_purchased',
          p_category: 'billing',
          p_description: 'Purchased per-event credit',
          p_metadata: { plan: 'perevent', checkout_session_id: session.id },
        })
        if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)
        break
      }

      case 'charge.refunded': {
        const charge = event.data.object
        const pi = charge.payment_intent as string | null
        if (!pi) break
        if (charge.metadata?.product !== 'checkin') {
          const found = await lookupCheckinPurchase(sb, pi)
          if (found.kind === 'error') return retry('purchase lookup failed')
          if (found.kind === 'not_checkin') break
        }
        // Partial refunds keep the event live; only a full refund reverts it.
        if (charge.amount_refunded < charge.amount) {
          console.log('stripe-webhook: partial check-in refund', pi, charge.amount_refunded, 'of', charge.amount, '- event stays as is')
          break
        }
        const { data, error } = await sb.rpc('checkin_mark_refunded', { p_payment_intent: pi })
        if (error) {
          console.error('stripe-webhook: checkin_mark_refunded failed for', pi, error.message)
          return retry('refund not recorded')
        }
        // 'test' | 'refunded_still_live' | 'not_found' | 'already_refunded'
        console.log('stripe-webhook: check-in refund', pi, '->', data)
        break
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object
        const pi = dispute.payment_intent as string | null
        if (!pi) break
        const found = await lookupCheckinPurchase(sb, pi)
        if (found.kind === 'error') return retry('purchase lookup failed')
        if (found.kind === 'not_checkin') break
        // No state change: a dispute is decided by Stripe, a person responds.
        await billingAlert(sb, 'checkin_dispute', found.buyer_id,
          'Check-in payment disputed; respond in the Stripe dashboard',
          { dispute_id: dispute.id, payment_intent: pi, event_id: found.event_id,
            amount: dispute.amount ?? null, reason: dispute.reason ?? null })
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        const customerId = subscription.customer

        // Not ours — belongs to CueQuote on this shared account. Writing here
        // would clobber this customer's CueDeck subscription id, billing dates
        // and trial.
        if (!isCueDeckSubscription(subscription)) {
          console.log(`Ignoring non-CueDeck subscription ${subscription.id}`)
          break
        }

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
          const { error: logErr } = await sb.rpc('log_activity', {
            p_user_id: subOwner.director_id,
            p_action: event.type === 'customer.subscription.created' ? 'subscription_created' : 'subscription_updated',
            p_category: 'billing',
            p_description: `Subscription ${event.type === 'customer.subscription.created' ? 'started' : 'updated'}: ${plan || 'unknown'} (${status})`,
            p_metadata: { plan, status, interval, subscription_id: subscription.id },
          })
          if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)
        }

        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object

        // A CueQuote cancellation must not expire this customer's CueDeck plan.
        if (!isCueDeckSubscription(subscription)) {
          console.log(`Ignoring non-CueDeck subscription.deleted ${subscription.id}`)
          break
        }
        // Get director_id before updating
        const { data: cancelledSub } = await sb.from('leod_subscriptions')
          .select('director_id, plan').eq('stripe_customer_id', subscription.customer).single()

        await sb.from('leod_subscriptions')
          .update({ status: 'expired', stripe_subscription_id: null })
          .eq('stripe_customer_id', subscription.customer)

        // Log activity
        if (cancelledSub?.director_id) {
          const { error: logErr } = await sb.rpc('log_activity', {
            p_user_id: cancelledSub.director_id,
            p_action: 'subscription_cancelled',
            p_category: 'billing',
            p_description: `Subscription cancelled: ${cancelledSub.plan || 'unknown'}`,
            p_metadata: { previous_plan: cancelledSub.plan, subscription_id: subscription.id },
          })
          if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)
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
            const { error: logErr } = await sb.rpc('log_activity', {
              p_user_id: failedSub.director_id,
              p_action: 'payment_failed',
              p_category: 'billing',
              p_description: `Payment failed for ${failedSub.plan || 'subscription'}`,
              p_metadata: { invoice_id: invoice.id, amount: invoice.amount_due },
            })
            if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)
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
        // Create invoice record and trigger email delivery. Subscription
        // invoices only: a one-off check-in purchase already is a Stripe
        // invoice (invoice_creation), and capturing it would issue it a
        // second invoice number.
        if (invoice.subscription) {
          try {
            await captureInvoice(sb, st, invoice)
          } catch (invoiceErr) {
            // Log but don't fail the webhook
            console.error('Invoice capture failed:', invoiceErr)
          }
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
