// supabase/functions/checkin-price/index.ts
// Public read of the check-in price. The Stripe price is the single
// source of the amount; pages and cuedeck.io read it here.
// Deployed with --no-verify-jwt (see supabase/config.toml).

import { corsHeaders } from '../_shared/cors.ts'
import { stripe }      from '../_shared/stripe.ts'

let cache: { at: number; body: string } | null = null
const TTL_MS = 10 * 60 * 1000

Deno.serve(async (req) => {
  const cors = { ...corsHeaders(req), 'Access-Control-Allow-Origin': '*' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // scripts/deploy-functions.sh verifies every deploy with POST {"_ping":true}.
  if (req.method === 'POST') {
    let parsed: Record<string, unknown> | null = null
    try { parsed = await req.json() } catch { /* empty or non-JSON body: treat as a price read */ }
    if (parsed?._ping) return new Response(JSON.stringify({ pong: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  if (cache && Date.now() - cache.at < TTL_MS) {
    return new Response(cache.body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })
  }

  const priceId = Deno.env.get('CHECKIN_PRICE_ID')
  if (!priceId) return new Response(JSON.stringify({ error: 'Not configured' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    const p = await stripe().prices.retrieve(priceId)
    if (!p.active || p.unit_amount == null) throw new Error('price inactive or has no unit_amount')
    const body = JSON.stringify({ amount: p.unit_amount, currency: p.currency, tax_behavior: p.tax_behavior })
    cache = { at: Date.now(), body }
    return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })
  } catch (e) {
    console.error('checkin-price: stripe read failed', (e as Error).message)
    return new Response(JSON.stringify({ error: 'Price unavailable' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
