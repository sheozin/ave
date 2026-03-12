// ai-proxy — Server-side proxy for Anthropic API calls.
// Authenticates the caller's JWT, verifies their plan has AI access,
// then forwards the request to Anthropic using the server-side API key.
// The Anthropic key never touches the browser.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const AI_PLANS = new Set(['trial', 'pro', 'enterprise'])

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

  // ── Auth: verify caller JWT ──────────────────────────────────────
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

  // ── Plan check: AI is only available on trial / pro / enterprise ─
  const { data: subRow } = await sb
    .from('leod_subscriptions')
    .select('plan')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const plan = (subRow?.plan as string) || 'trial'
  if (!AI_PLANS.has(plan)) {
    return new Response(
      JSON.stringify({ error: 'AI features are not available on your current plan. Upgrade to Pro to unlock AI.' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }

  // ── Validate payload ────────────────────────────────────────────
  const model      = body.model      as string | undefined
  const max_tokens = body.max_tokens as number | undefined
  const messages   = body.messages   as unknown[] | undefined

  if (!model || !max_tokens || !Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid payload: model, max_tokens, messages required' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Forward to Anthropic ────────────────────────────────────────
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'AI service temporarily unavailable' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens, messages }),
  })

  const result = await anthropicRes.json()

  return new Response(JSON.stringify(result), {
    status: anthropicRes.status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
