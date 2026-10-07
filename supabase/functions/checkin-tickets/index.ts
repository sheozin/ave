// supabase/functions/checkin-tickets/index.ts
// Paid tickets (migration 109), the parts that talk to Stripe for the
// organizer. Ticket types and the order list are plain RPCs
// (checkin_ticket_type_save, checkin_tickets_overview, checkin_orders_list).
//
//   POST { event_id, action: 'payout_status' }   owner and organizers; asks
//        Stripe while the account is not yet able to take charges
//   POST { event_id, action: 'payout_connect' }  owner: a Stripe onboarding
//        link for their own (Standard) account, created on first use
//   POST { event_id, action: 'refund', order_id } owner: a full refund on
//        the owner's account, CueDeck's fee returned too
//
// The payout account belongs to the event owner (leod_events.created_by),
// not to the event: one account serves all their events.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }       from '../_shared/stripe.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { APP, loadOrder } from '../_shared/checkin-tickets.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400)
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const event_id = String(body.event_id || '')
  if (!UUID.test(event_id)) return json({ error: 'Missing event_id' }, 400)
  const action = String(body.action || '')
  if (!['payout_status', 'payout_connect', 'refund'].includes(action)) return json({ error: 'Bad request' }, 400)

  const caller = await loadCallerRole(sb, event_id, user.id)
  const gate = functionGate(action === 'payout_status' ? 'checkin-tickets' : 'checkin-tickets-owner', caller)
  if (!gate.ok) return json(gate.body, gate.status)

  const { data: ev, error: evErr } = await sb.from('leod_events').select('created_by, name').eq('id', event_id).maybeSingle()
  if (evErr) return json({ error: evErr.message }, 500)
  if (!ev) return json({ error: 'Event not found' }, 404)
  const ownerId = String(ev.created_by)

  const { data: acct, error: acctErr } = await sb.from('leod_checkin_payout_accounts')
    .select('stripe_account_id, charges_enabled, details_submitted, default_currency').eq('user_id', ownerId).maybeSingle()
  if (acctErr) return json({ error: acctErr.message }, 500)

  const st = stripe()

  if (action === 'payout_status') {
    if (!acct) return json({ connected: false, charges_enabled: false, details_submitted: false, default_currency: null })
    let row = acct
    // Stripe is asked only while onboarding is unfinished; once charges are
    // enabled the stored answer stands (a later restriction shows up as a
    // failed checkout, which the guest sees and Stripe emails the owner about).
    if (!acct.charges_enabled) {
      try {
        const a = await st.accounts.retrieve(acct.stripe_account_id)
        row = { stripe_account_id: acct.stripe_account_id, charges_enabled: !!a.charges_enabled,
                details_submitted: !!a.details_submitted, default_currency: a.default_currency ?? null }
        const { error } = await sb.from('leod_checkin_payout_accounts')
          .update({ ...row, updated_at: new Date().toISOString() }).eq('user_id', ownerId)
        if (error) console.error('checkin-tickets: payout status not stored', error.message)
      } catch (e) {
        console.error('checkin-tickets: account retrieve failed', (e as Error).message)
      }
    }
    return json({ connected: true, charges_enabled: row.charges_enabled, details_submitted: row.details_submitted, default_currency: row.default_currency })
  }

  if (action === 'payout_connect') {
    let accountId = acct?.stripe_account_id as string | undefined
    try {
      if (!accountId) {
        const a = await st.accounts.create({
          type: 'standard', email: user.email ?? undefined,
          metadata: { cuedeck_user_id: ownerId },
        }, { idempotencyKey: 'cuedeck-connect-' + ownerId })
        accountId = a.id
        const { error } = await sb.from('leod_checkin_payout_accounts')
          .upsert({ user_id: ownerId, stripe_account_id: accountId }, { onConflict: 'user_id', ignoreDuplicates: true })
        if (error) {
          console.error('checkin-tickets: payout account not recorded', ownerId, error.message)
          return json({ error: 'Could not save your Stripe account. Please try again.' }, 500)
        }
      }
      const back = `${APP}/checkin/setup?event=${event_id}&step=tickets`
      const link = await st.accountLinks.create({
        account: accountId, type: 'account_onboarding',
        refresh_url: back + '&connect=retry', return_url: back + '&connect=done',
      })
      return json({ url: link.url })
    } catch (e) {
      const msg = (e as Error).message
      console.error('checkin-tickets: connect failed', msg)
      if (/connect/i.test(msg) && /(sign(ed)? up|enable|platform)/i.test(msg)) {
        return json({ error: 'Stripe payouts are not switched on for CueDeck yet. Please try again later.', code: 'connect_disabled' }, 503)
      }
      return json({ error: 'Could not reach Stripe. Please try again.' }, 502)
    }
  }

  // ── refund ──
  const order_id = String(body.order_id || '')
  if (!UUID.test(order_id)) return json({ error: 'Missing order_id' }, 400)
  let order
  try { order = await loadOrder(sb, order_id) } catch (e) { return json({ error: (e as Error).message }, 500) }
  if (!order || order.event_id !== event_id) return json({ error: 'Order not found' }, 404)
  if (order.status === 'refunded') return json({ ok: true, status: 'refunded', removed: false })
  if (order.status !== 'paid') return json({ error: 'Only a paid order can be refunded' }, 409)
  // The money went to the account that was connected then. After an
  // ownership transfer the new owner cannot refund from someone else's
  // account; the previous owner refunds in their own Stripe dashboard.
  if (!acct || acct.stripe_account_id !== order.stripe_account_id) {
    return json({ error: 'This ticket was paid to a different Stripe account. Its owner can refund it from their Stripe dashboard.', code: 'other_account' }, 409)
  }
  try {
    let pi = order.payment_intent
    if (!pi && order.checkout_session_id) {
      const s = await st.checkout.sessions.retrieve(order.checkout_session_id, {}, { stripeAccount: order.stripe_account_id })
      pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null
    }
    if (!pi) return json({ error: 'This order has no payment to refund' }, 409)
    await st.refunds.create({ payment_intent: pi, refund_application_fee: true, metadata: { cuedeck_order_id: order.id } },
      { stripeAccount: order.stripe_account_id, idempotencyKey: 'cuedeck-refund-' + order.id })
  } catch (e) {
    console.error('checkin-tickets: refund failed', order.id, (e as Error).message)
    return json({ error: 'Stripe refused the refund: ' + (e as Error).message }, 502)
  }
  const { data: out, error } = await sb.rpc('checkin_web_order_refunded', { p_order_id: order.id })
  if (error || !out) {
    // The money is back with the guest; only CueDeck's record lags. Say so.
    console.error('checkin-tickets: refund recorded in Stripe but not here', order.id, error?.message)
    return json({ error: 'Refunded in Stripe, but CueDeck could not record it. Please reload and try again.' }, 500)
  }
  console.log('checkin-tickets: refunded order', order.id, 'event', event_id)
  return json({ ok: true, status: 'refunded', removed: out.removed === true })
})
