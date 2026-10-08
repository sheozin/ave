// tests/ai-proxy-plan.spec.ts
// The AI plan rule used by supabase/functions/ai-proxy/index.ts, imported
// from the function itself (no mirror to keep in sync). Whose plan is
// checked (the event creator's, spec 2026-10-08 §6) is tested on the real
// handler in tests/deno/plan-owner.test.ts.
import { describe, it, expect } from 'vitest';
import { aiAllowed } from '../supabase/functions/_shared/plan.ts';

describe('aiAllowed', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('denies expired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
  });
  it('allows unexpired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-10T00:00:00Z' }, now)).toBe(true);
  });
  it('denies a trial with no end date', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: null }, now)).toBe(false);
  });
  it('allows active pro and enterprise', () => {
    expect(aiAllowed({ plan: 'pro', status: 'active', trial_ends_at: null }, now)).toBe(true);
    expect(aiAllowed({ plan: 'enterprise', status: 'active', trial_ends_at: null }, now)).toBe(true);
  });
  it('denies past_due pro, starter and perevent', () => {
    expect(aiAllowed({ plan: 'pro', status: 'past_due', trial_ends_at: null }, now)).toBe(false);
    expect(aiAllowed({ plan: 'starter', status: 'active', trial_ends_at: null }, now)).toBe(false);
    expect(aiAllowed({ plan: 'perevent', status: 'active', trial_ends_at: null }, now)).toBe(false);
  });
  it('denies no row', () => {
    expect(aiAllowed(null, now)).toBe(false);
  });
});
