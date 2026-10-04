// tests/checkin-comp.spec.ts
// Mirrors the comp decisions in supabase/functions/checkin-enable-event
// and the outcome rule of checkin_mark_comp_live (migration 068).
import { describe, it, expect } from 'vitest';

const entitlementStatusOnCreate = (_isComp: boolean) => 'test';
const shouldCallCompLive = (isComp: boolean) => isComp;
const compLiveOutcome = (status: string | null): string =>
  status === null ? 'no_entitlement' : status === 'live' ? 'already_live' : 'live';

describe('checkin comp accounts', () => {
  it('always creates in test; go-live is a separate step for comp only', () => {
    expect(entitlementStatusOnCreate(true)).toBe('test');
    expect(entitlementStatusOnCreate(false)).toBe('test');
    expect(shouldCallCompLive(true)).toBe(true);
    expect(shouldCallCompLive(false)).toBe(false);
  });
  it('comp go-live outcomes', () => {
    expect(compLiveOutcome(null)).toBe('no_entitlement');
    expect(compLiveOutcome('live')).toBe('already_live');
    expect(compLiveOutcome('test')).toBe('live');
  });
});
