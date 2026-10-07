// supabase/functions/_shared/checkin-tickets.ts
// Paid tickets (migration 109): Stripe Checkout on the event owner's
// connected account, and settling an order with what Stripe says.
// Used by checkin-register (the guest's link and return), checkin-orders-sweep
// (guests who closed the tab) and checkin-tickets (refunds).
//
// There is no webhook: Stripe is asked. A session that says paid makes the
// guest a ticket holder (checkin_web_order_paid, idempotent), and their QR
// email goes out once.

import { stripe } from './stripe.ts'
import { sendQrEmailsForAttendees, withBrand } from './qr-email.ts'

type Sb = any
type StripeClient = ReturnType<typeof stripe>

export const APP = 'https://app.cuedeck.io'

export type Order = {
  id: string; event_id: string; ticket_name: string; first_name: string; last_name: string; email: string
  amount_cents: number; currency: string; fee_cents: number; stripe_account_id: string
  checkout_session_id: string | null; payment_intent: string | null; status: 'open' | 'expired' | 'paid' | 'refunded'
  expires_at: string; attendee_id: string | null; ref?: string | null
}

export type SessionView = { status: string | null; payment_status: string | null; payment_intent: string | null; url: string | null; order_id: string | null }

// What one Checkout session means for its order. Pure, so it is tested
// without Stripe. 'pending': completed but the money has not cleared (a
// delayed method). Sessions are card only, so this should not happen, but
// such an order is never expired or reopened: it would orphan a payment.
export function sessionVerdict(s: SessionView): 'paid' | 'open' | 'pending' | 'expired' {
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return 'paid'
  if (s.status === 'open') return 'open'
  if (s.status === 'complete') return 'pending'
  return 'expired'
}

// A session ends a minute before its order's hold, so nobody can pay after
// the place was released. Stripe needs at least 30 minutes; null when the
// hold has less left than that (refresh the hold first). Derived from the
// order alone, so a retried create sends identical parameters.
export function sessionExpiry(holdUntilIso: string, nowMs: number): number | null {
  const end = Math.floor(Date.parse(holdUntilIso) / 1000) - 60
  return end >= Math.floor(nowMs / 1000) + 30 * 60 + 15 ? end : null
}

// Formats an amount for people: 4900 eur -> "€49.00".
export function money(cents: number, currency: string, locale = 'en-GB'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
  } catch {
    return (cents / 100).toFixed(2) + ' ' + currency.toUpperCase()
  }
}

const view = (s: any): SessionView => ({
  status: s?.status ?? null, payment_status: s?.payment_status ?? null,
  payment_intent: typeof s?.payment_intent === 'string' ? s.payment_intent : s?.payment_intent?.id ?? null,
  url: s?.url ?? null,
  order_id: s?.metadata?.cuedeck_order_id ?? s?.client_reference_id ?? null,
})

// A Checkout session for an open order. The idempotency key ties one
// session to one hold of the order (expires_at changes when it reopens),
// so two clicks or two tabs get the same session.
export async function openCheckout(st: StripeClient, sb: Sb, order: Order, ctx: { code: string; eventName: string }): Promise<string> {
  const expiresAt = sessionExpiry(order.expires_at, Date.now())
  if (expiresAt === null) throw new Error('hold too short for a checkout session')
  const session = await st.checkout.sessions.create({
    mode: 'payment',
    // Card (with Apple Pay and Google Pay): settles at once. Delayed methods
    // would complete unpaid and clear after the hold.
    payment_method_types: ['card'],
    customer_email: order.email,
    client_reference_id: order.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: order.currency,
        unit_amount: order.amount_cents,
        product_data: { name: order.ticket_name, description: ctx.eventName },
      },
    }],
    payment_intent_data: {
      ...(order.fee_cents > 0 ? { application_fee_amount: order.fee_cents } : {}),
      receipt_email: order.email,
      description: ctx.eventName + ': ' + order.ticket_name,
      metadata: { cuedeck_order_id: order.id, event_id: order.event_id },
    },
    metadata: { cuedeck_order_id: order.id, event_id: order.event_id },
    success_url: `${APP}/r/${ctx.code}?paid=1`,
    cancel_url: `${APP}/r/${ctx.code}?unpaid=1`,
    expires_at: expiresAt,
    locale: 'auto',
  }, { stripeAccount: order.stripe_account_id, idempotencyKey: 'cuedeck-order-' + order.id + '-' + order.expires_at })
  const { error } = await sb.from('leod_checkin_web_orders')
    .update({ checkout_session_id: session.id }).eq('id', order.id)
  if (error) throw new Error('could not record the session: ' + error.message)
  if (!session.url) throw new Error('Stripe returned no checkout URL')
  return session.url
}

export type Settled =
  | { kind: 'paid'; attendee: { id: string; first_name: string; email: string; qr_token: string; qr_email_sent_at: string | null } | null }
  | { kind: 'open'; url: string | null }
  | { kind: 'pending' }
  | { kind: 'expired' }
  | { kind: 'refunded' }

// Marks an order paid. The QR email goes out from the one call that marked
// it (out.first), so the guest's return and the sweep cannot both send it.
export async function completeOrder(sb: Sb, order: Order, paymentIntent: string | null): Promise<Settled> {
  const { data: out, error } = await sb.rpc('checkin_web_order_paid', { p_order_id: order.id, p_payment_intent: paymentIntent ?? '' })
  if (error || !out) throw new Error('order_paid: ' + (error?.message ?? 'no result'))
  if (out.status === 'refunded') return { kind: 'refunded' }
  const att = out.attendee ?? null
  // (125) The paying guest keeps the source of their request.
  if (att && out.first === true) {
    const { error: srcErr } = await sb.from('leod_checkin_attendees').update({ reg_source: order.ref ?? 'direct' }).eq('id', att.id).is('reg_source', null)
    if (srcErr) console.error('checkin-tickets: source not recorded', srcErr.code)
  }
  // The order is paid whatever happens to the email: a failure here is
  // logged, never turned into "payment failed". The ticket stays on the
  // guest's link, and the organizer can resend from Emails.
  if (att && out.first === true && !att.qr_email_sent_at) {
    try {
      const { data: ev, error: evErr } = await sb.from('leod_events').select('name, date, venue').eq('id', order.event_id).single()
      if (evErr || !ev) console.error('checkin-tickets: event read for QR email failed', order.event_id, evErr?.code)
      else {
        const res = await sendQrEmailsForAttendees(sb, await withBrand(sb, order.event_id, ev), [att])
        if (res.some((r: { status: string }) => r.status === 'error')) console.error('checkin-tickets: QR email failed, attendee', att.id)
      }
    } catch (e) {
      console.error('checkin-tickets: QR email threw, attendee', att.id, (e as Error).message)
    }
  }
  return { kind: 'paid', attendee: att }
}

// Asks Stripe about an order's session. Does not open a new session.
export async function settleOrder(st: StripeClient, sb: Sb, order: Order): Promise<Settled> {
  if (order.status === 'refunded') return { kind: 'refunded' }
  if (order.status === 'paid') return completeOrder(sb, order, order.payment_intent)
  if (!order.checkout_session_id) return order.status === 'open' && Date.parse(order.expires_at) > Date.now() ? { kind: 'open', url: null } : { kind: 'expired' }
  const s = view(await st.checkout.sessions.retrieve(order.checkout_session_id, {}, { stripeAccount: order.stripe_account_id }))
  // The session was made for this order; one that says otherwise is never
  // taken as payment for it.
  if (s.order_id !== order.id) throw new Error('session ' + order.checkout_session_id + ' does not belong to order ' + order.id)
  const v = sessionVerdict(s)
  if (v === 'paid') return completeOrder(sb, order, s.payment_intent)
  if (v === 'pending') return { kind: 'pending' }
  if (v === 'open' && order.status === 'open' && Date.parse(order.expires_at) > Date.now()) return { kind: 'open', url: s.url }
  if (v === 'open') {
    // The hold is over but Stripe would still take payment (should not
    // happen: sessions end before holds). Close it before anyone reopens.
    const x = view(await st.checkout.sessions.expire(order.checkout_session_id, {}, { stripeAccount: order.stripe_account_id }))
    if (sessionVerdict(x) === 'paid') return completeOrder(sb, order, x.payment_intent)
  }
  return { kind: 'expired' }
}

export async function loadOrder(sb: Sb, id: string): Promise<Order | null> {
  const { data, error } = await sb.from('leod_checkin_web_orders')
    .select('id, event_id, ticket_name, first_name, last_name, email, amount_cents, currency, fee_cents, stripe_account_id, checkout_session_id, payment_intent, status, expires_at, attendee_id, ref')
    .eq('id', id).maybeSingle()
  if (error) throw new Error('order read: ' + error.message)
  return data as Order | null
}
