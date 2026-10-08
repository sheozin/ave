// plan.ts: the plan rule for AI (ai-proxy). No imports, so vitest imports it too.
// Which plan is checked is decided by the caller of aiAllowed: for an event,
// the event creator's plan (event teams, spec 2026-10-08 §6).

export const PAID_AI_PLANS = new Set(['pro', 'enterprise'])

export type PlanRow = { plan: string; status: string; trial_ends_at: string | null } | null

// An active Pro or Enterprise plan, or a trial that has not ended. No row: no AI.
export function aiAllowed(sub: PlanRow, now = Date.now()): boolean {
  const plan = sub?.plan
  const paidOk = !!plan && PAID_AI_PLANS.has(plan) && sub?.status === 'active'
  const ends = sub?.trial_ends_at ? Date.parse(sub.trial_ends_at) : NaN
  const trialOk = plan === 'trial' && !Number.isNaN(ends) && ends > now
  return paidOk || trialOk
}
