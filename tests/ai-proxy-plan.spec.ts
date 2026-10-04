// Mirror of the plan check in supabase/functions/ai-proxy/index.ts, which
// mirrors get_subscription_for_user() in migration 011. Keep in sync.
import { describe, it, expect } from 'vitest';

type Me = { role: string; invited_by: string | null };
type Sub = { plan: string; status: string; trial_ends_at: string | null } | null;

const PAID_AI_PLANS = new Set(['pro', 'enterprise']);

function subscriptionOwnerId(me: Me, userId: string): string {
  return (me.role === 'director' || !me.invited_by) ? userId : me.invited_by;
}

function aiAllowed(sub: Sub, now = Date.now()): boolean {
  const plan = sub?.plan;
  const paidOk = !!plan && PAID_AI_PLANS.has(plan) && sub?.status === 'active';
  const ends = sub?.trial_ends_at ? Date.parse(sub.trial_ends_at) : NaN;
  const trialOk = plan === 'trial' && !Number.isNaN(ends) && ends > now;
  return paidOk || trialOk;
}

// Subscriptions keyed by director_id, as in leod_subscriptions.
const subs: Record<string, Sub> = {
  dir: { plan: 'pro', status: 'active', trial_ends_at: null },
};

describe('subscriptionOwnerId', () => {
  it('director resolves to self', () => {
    expect(subscriptionOwnerId({ role: 'director', invited_by: null }, 'dir')).toBe('dir');
  });
  it('director with a stray invited_by still resolves to self', () => {
    expect(subscriptionOwnerId({ role: 'director', invited_by: 'x' }, 'dir')).toBe('dir');
  });
  it('operator with invited_by resolves to the inviter', () => {
    for (const role of ['stage', 'av', 'interp', 'reg', 'signage']) {
      expect(subscriptionOwnerId({ role, invited_by: 'dir' }, 'op')).toBe('dir');
    }
  });
  it('checkin_staff (invited_by null) resolves to self, which has no row: denied', () => {
    const owner = subscriptionOwnerId({ role: 'checkin_staff', invited_by: null }, 'staff');
    expect(owner).toBe('staff');
    expect(aiAllowed(subs[owner] ?? null)).toBe(false);
  });
  it('operator inherits the director plan', () => {
    const owner = subscriptionOwnerId({ role: 'stage', invited_by: 'dir' }, 'op');
    expect(aiAllowed(subs[owner] ?? null)).toBe(true);
  });
});

describe('aiAllowed', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('denies expired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
  });
  it('allows unexpired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-10T00:00:00Z' }, now)).toBe(true);
  });
  it('allows active pro', () => {
    expect(aiAllowed({ plan: 'pro', status: 'active', trial_ends_at: null }, now)).toBe(true);
  });
  it('denies past_due pro', () => {
    expect(aiAllowed({ plan: 'pro', status: 'past_due', trial_ends_at: null }, now)).toBe(false);
  });
  it('denies no row', () => {
    expect(aiAllowed(null, now)).toBe(false);
  });
});
