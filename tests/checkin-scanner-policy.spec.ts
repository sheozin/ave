// tests/checkin-scanner-policy.spec.ts
// Scanner rules shared by checkin-record-scans, checkin-scanner and
// checkin-kiosk-pair (spec 2026-08-18, "Every feature is optional per
// event"). Imported for real, not re-expressed: a test that restates the
// rule passes whatever the code does.
import { describe, it, expect } from 'vitest';
import { scanPointRefusal, shouldAccept, normalizeToken, COOLDOWN_MS } from '../supabase/functions/_shared/checkin-scanner.ts';

const on = { multi_point_scanning: true, entrance_scanning: true, session_scanning: true };

describe('scanPointRefusal', () => {
  it('an entrance point needs only entrance scanning', () => {
    expect(scanPointRefusal('entrance', on)).toBeNull();
    expect(scanPointRefusal('entrance', { ...on, multi_point_scanning: false, session_scanning: false })).toBeNull();
    expect(scanPointRefusal('entrance', { ...on, entrance_scanning: false }))
      .toBe('Door scanning is switched off for this event. Ask the organizer to turn it on in Setup, or check people in at the desk.');
  });
  it('an interior point needs the plan and the setting', () => {
    expect(scanPointRefusal('interior', on)).toBeNull();
    expect(scanPointRefusal('interior', { ...on, multi_point_scanning: false }))
      .toBe('Session scanning is not included for this event. Check people in at the desk.');
    expect(scanPointRefusal('interior', { ...on, session_scanning: false }))
      .toBe('Session scanning is switched off for this event. Ask the organizer to turn it on in Setup.');
  });
  it('an unknown kind is refused, not allowed', () => {
    expect(scanPointRefusal('roof' as never, on)).toBe('This scan point has an unknown kind.');
  });
});

describe('shouldAccept (cooldown)', () => {
  it('accepts a code the first time and again after the cooldown', () => {
    const seen = new Map<string, number>();
    expect(shouldAccept(seen, 'AAA', 1000)).toBe(true);
    expect(shouldAccept(seen, 'AAA', 1000 + COOLDOWN_MS - 1)).toBe(false);
    expect(shouldAccept(seen, 'AAA', 1000 + COOLDOWN_MS)).toBe(true);
  });
  it('one code does not block another', () => {
    const seen = new Map<string, number>();
    shouldAccept(seen, 'AAA', 1000);
    expect(shouldAccept(seen, 'BBB', 1001)).toBe(true);
  });
  it('forgets old codes so the map cannot grow all day', () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 1000; i++) shouldAccept(seen, 'T' + i, i);
    shouldAccept(seen, 'late', 10 * COOLDOWN_MS);
    expect(seen.size).toBe(1);
  });
});

describe('normalizeToken', () => {
  it('trims scanner noise', () => {
    expect(normalizeToken('  abc12345\n')).toBe('abc12345');
  });
  it('refuses anything that is not a plausible token', () => {
    expect(normalizeToken('')).toBeNull();
    expect(normalizeToken('a b')).toBeNull();
    expect(normalizeToken('x'.repeat(201))).toBeNull();
    expect(normalizeToken('https://evil.example/?q=1')).toBeNull();
  });
});
