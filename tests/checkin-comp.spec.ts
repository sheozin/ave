// tests/checkin-comp.spec.ts
// Mirrors the comp decisions in supabase/functions/checkin-enable-event.
import { describe, it, expect } from 'vitest';

const entitlementStatusOnCreate = (isComp: boolean) => (isComp ? 'live' : 'test');
const shouldUpgradeExisting = (existingStatus: string, isComp: boolean) => isComp && existingStatus === 'test';

describe('checkin comp accounts', () => {
  it('creates live for comp, test otherwise', () => {
    expect(entitlementStatusOnCreate(true)).toBe('live');
    expect(entitlementStatusOnCreate(false)).toBe('test');
  });
  it('upgrades only an existing test row of a comp owner', () => {
    expect(shouldUpgradeExisting('test', true)).toBe(true);
    expect(shouldUpgradeExisting('test', false)).toBe(false);
    expect(shouldUpgradeExisting('live', true)).toBe(false);
    expect(shouldUpgradeExisting('refunded', true)).toBe(false);
  });
});
