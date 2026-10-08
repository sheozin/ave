// ai-proxy: server-side proxy for Anthropic API calls.
// Authenticates the caller's JWT, checks the plan that governs the call,
// then forwards the request to Anthropic using the server-side API key.
// The Anthropic key never touches the browser.
// Whose plan (event teams, spec 2026-10-08 §6): with event_id, the caller
// must be on that event and the plan is the event creator's (members have no
// plan of their own); without event_id, the caller's own plan.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { eventRole } from '../_shared/transition.ts'
import { UUID } from '../_shared/members.ts'
import { aiAllowed, type PlanRow } from '../_shared/plan.ts'

const NO_AI = 'AI features are not available on your current plan. Upgrade to Pro to unlock AI.'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }

  // Ping support (deploy verification)
  if (body._ping) return json(200, { pong: true })

  // ── Auth: verify caller JWT ──────────────────────────────────────
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json(401, { error: 'Unauthorized' })
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json(401, { error: 'Unauthorized' })

  const evId = body.event_id
  if (evId !== undefined && evId !== null && !(typeof evId === 'string' && UUID.test(evId))) {
    return json(400, { error: 'Invalid event_id' })
  }

  // A suspended account (admin action) gets no AI anywhere.
  const { data: me, error: meErr } = await sb.from('leod_users').select('active').eq('id', user.id).maybeSingle()
  if (meErr) {
    console.error('ai-proxy: user lookup failed', meErr.message)
    return json(500, { error: 'Could not verify your plan' })
  }
  if (!me || me.active === false) return json(403, { error: NO_AI })

  // ── Whose plan ───────────────────────────────────────────────────
  let ownerId = user.id
  if (typeof evId === 'string') {
    let role: string | null
    try { role = await eventRole(sb, user.id, evId) } catch (e) {
      console.error('ai-proxy: role lookup failed', (e as Error).message)
      return json(500, { error: 'Could not verify your plan' })
    }
    if (!role) return json(403, { error: 'Forbidden' })
    const { data: ev, error: evErr } = await sb.from('leod_events').select('created_by').eq('id', evId).maybeSingle()
    if (evErr || !ev?.created_by) {
      console.error('ai-proxy: event lookup failed', evErr?.message ?? 'no creator')
      return json(500, { error: 'Could not verify your plan' })
    }
    ownerId = ev.created_by
  }

  const { data: subRow, error: subErr } = await sb
    .from('leod_subscriptions')
    .select('plan, status, trial_ends_at')
    .eq('director_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (subErr) {
    console.error('ai-proxy: subscription lookup failed', subErr.message)
    return json(500, { error: 'Could not verify your plan' })
  }
  if (!aiAllowed(subRow as PlanRow)) return json(403, { error: NO_AI })

  // ── Validate payload ────────────────────────────────────────────
  const model      = body.model      as string | undefined
  const max_tokens = body.max_tokens as number | undefined
  const messages   = body.messages   as unknown[] | undefined
  if (!model || !max_tokens || !Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'Invalid payload: model, max_tokens, messages required' })
  }

  // ── Forward to Anthropic ────────────────────────────────────────
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json(503, { error: 'AI service temporarily unavailable' })

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
