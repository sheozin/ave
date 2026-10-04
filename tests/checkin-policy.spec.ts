// tests/checkin-policy.spec.ts
// Imports supabase/functions/_shared/checkin-policy.ts directly.
// Tests verify validation, fail-closed behavior, and routing logic.
import { describe, it, expect } from 'vitest';
import { TEST_CAP, checkinWindow, isWithinWindow, routeCheckoutSession } from '../supabase/functions/_shared/checkin-policy.ts';

describe('checkinWindow', () => {
  it('opens at local midnight 7 days before, Warsaw summer (UTC+2)', () => {
    const w = checkinWindow('2026-06-20', 'Europe/Warsaw');
    expect(w).not.toBeNull();
    expect(w!.opensAt.toISOString()).toBe('2026-06-12T22:00:00.000Z');
  });
  it('closes at local midnight starting date+3, Warsaw summer', () => {
    const w = checkinWindow('2026-06-20', 'Europe/Warsaw');
    expect(w).not.toBeNull();
    expect(w!.closesAt.toISOString()).toBe('2026-06-22T22:00:00.000Z');
  });
  it('handles a DST change inside the window (Warsaw, Oct 25 2026)', () => {
    const w = checkinWindow('2026-10-26', 'Europe/Warsaw');
    expect(w).not.toBeNull();
    expect(w!.opensAt.toISOString()).toBe('2026-10-18T22:00:00.000Z'); // still CEST
    expect(w!.closesAt.toISOString()).toBe('2026-10-28T23:00:00.000Z'); // CET
  });
  it('Asia/Kolkata event 2026-11-20: opensAt is 2026-11-12T18:30:00.000Z', () => {
    const w = checkinWindow('2026-11-20', 'Asia/Kolkata');
    expect(w).not.toBeNull();
    expect(w!.opensAt.toISOString()).toBe('2026-11-12T18:30:00.000Z');
  });
  it('returns null for invalid eventDate', () => {
    expect(checkinWindow('2026-02-31', 'Europe/Warsaw')).toBeNull();
  });
  it('returns null for invalid timeZone', () => {
    expect(checkinWindow('2026-11-20', 'Mars/Base')).toBeNull();
  });
});

describe('isWithinWindow', () => {
  it('Cairo: 23:30 local on date+2 is inside', () => {
    // 2026-11-12 is the event; date+2 = 2026-11-14; Cairo is UTC+2 in November.
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(true);
  });
  it('Cairo: 00:10 local on date+3 is outside', () => {
    expect(isWithinWindow('2026-11-14T22:10:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(false);
  });
  it('Los Angeles: 23:59 local on date-8 is outside, 00:00 on date-7 is inside', () => {
    // event 2026-11-20; date-7 = 2026-11-13; LA is UTC-8 in November.
    expect(isWithinWindow('2026-11-13T07:59:00.000Z', '2026-11-20', 'America/Los_Angeles')).toBe(false);
    expect(isWithinWindow('2026-11-13T08:00:00.000Z', '2026-11-20', 'America/Los_Angeles')).toBe(true);
  });
  it('garbage timestamp is outside', () => {
    expect(isWithinWindow('not-a-date', '2026-11-20', 'UTC')).toBe(false);
  });
  it('returns false for invalid eventDate (bad format)', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-13-45', 'Europe/Warsaw')).toBe(false);
  });
  it('returns false for invalid eventDate (impossible date)', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-02-31', 'Europe/Warsaw')).toBe(false);
  });
  it('returns false for empty eventDate', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '', 'Europe/Warsaw')).toBe(false);
  });
  it('returns false for null eventDate', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', null as unknown as string, 'Europe/Warsaw')).toBe(false);
  });
  it('returns false for invalid timeZone (bad name)', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', 'Mars/Base')).toBe(false);
  });
  it('returns false for empty timeZone', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', '')).toBe(false);
  });
  it('returns false for undefined timeZone', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', undefined as unknown as string)).toBe(false);
  });
  it('returns false for ISO string without timezone', () => {
    expect(isWithinWindow('2026-11-12T12:00:00', '2026-11-12', 'UTC')).toBe(false);
  });
  it('never throws on any invalid input', () => {
    expect(() => isWithinWindow('garbage', '2026-13-45', 'Mars/Base')).not.toThrow();
  });
});

describe('routeCheckoutSession', () => {
  const P = 'prod_checkin';
  const PPE = 'prod_U7KZqMU9oG4QWD';

  it('routes a paid check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [P], P, PPE).route).toBe('checkin');
  });
  it('ignores an unpaid (async) check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'unpaid' }, [P], P, PPE).route).toBe('ignore');
  });
  it('ignores check-in metadata on a different product (forged or CueQuote)', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, ['prod_other'], P, PPE).route).toBe('ignore');
  });
  it('routes Pay-per-Event when paid with correct product', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, [PPE], P, PPE).route).toBe('perevent');
  });
  it('ignores a CueQuote session with no CueDeck metadata', () => {
    expect(routeCheckoutSession({ metadata: { company_id: 'x' }, payment_status: 'paid' }, ['prod_cq'], P, PPE).route).toBe('ignore');
  });
  it('ignores check-in with two line items', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [P, 'prod_x'], P, PPE).route).toBe('ignore');
  });
  it('ignores check-in with empty checkinProductId', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [''], '', PPE).route).toBe('ignore');
  });
  it('ignores check-in with whitespace-only event_id', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: '  ', buyer_id: 'b' }, payment_status: 'paid' }, [P], P, PPE).route).toBe('ignore');
  });
  it('ignores unpaid perevent session', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'unpaid' }, [PPE], P, PPE).route).toBe('ignore');
  });
  it('ignores perevent with different product in line items', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, ['prod_other'], P, PPE).route).toBe('ignore');
  });
  it('ignores undefined session', () => {
    expect(routeCheckoutSession(undefined, [P], P, PPE).route).toBe('ignore');
  });
  it('ignores null session', () => {
    expect(routeCheckoutSession(null, [P], P, PPE).route).toBe('ignore');
  });
  it('ignores non-array lineItemProductIds', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, 'not-array' as unknown as string[], P, PPE).route).toBe('ignore');
  });
  it('ignores session with null metadata', () => {
    expect(routeCheckoutSession({ metadata: null, payment_status: 'paid' }, [PPE], P, PPE).route).toBe('ignore');
  });
  it('routes a paid Pay-per-Event session with the real product among several line items', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, ['prod_other', 'prod_U7KZqMU9oG4QWD'], P, 'prod_U7KZqMU9oG4QWD').route).toBe('perevent');
  });
  it('routes Pay-per-Event even when the check-in product id is not configured', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, [PPE], '', PPE).route).toBe('perevent');
  });
  it('ignores an async Pay-per-Event session that completed unpaid (credit waits for async_payment_succeeded)', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'unpaid' }, [PPE], P, PPE).reason).toBe('payment_status unpaid');
  });
  it('ignores a no_payment_required Pay-per-Event session', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'no_payment_required' }, [PPE], P, PPE).route).toBe('ignore');
  });
  it('ignores Pay-per-Event metadata when the line items are only the check-in product', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, [P], P, PPE).route).toBe('ignore');
  });
  it('ignores Pay-per-Event when its product id is empty', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, [''], P, '').route).toBe('ignore');
  });
  it('a check-in session never routes perevent, even with plan=perevent and the Pay-per-Event product', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', plan: 'perevent', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [PPE], P, PPE).route).toBe('ignore');
  });
  it('TEST_CAP is 25', () => { expect(TEST_CAP).toBe(25); });
});

// Mirror of the server-clock bound in checkin-record-scans (keep identical).
const LIVE_SKEW_FUTURE_MS = 5 * 60 * 1000;
const LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function liveTimeOk(scannedMs: number, nowMs: number): boolean {
  if (!Number.isFinite(scannedMs)) return false;
  return scannedMs <= nowMs + LIVE_SKEW_FUTURE_MS && scannedMs >= nowMs - LIVE_MAX_AGE_MS;
}

// Mirrors the CASE order inside checkin_apply_scan (migration 062) for a
// 'checkin' item whose attendee belongs to the event. inWindow is the
// p_live_time_ok flag: calendar window AND server-clock bound (liveTimeOk).
function checkinVerdict(o: { alreadyIn: boolean; isTest: boolean; testUsed: number; inWindow: boolean }):
  'duplicate' | 'test_cap' | 'outside_window' | 'apply' {
  if (o.alreadyIn) return 'duplicate';
  if (o.isTest && o.testUsed >= TEST_CAP) return 'test_cap';
  if (!o.isTest && !o.inWindow) return 'outside_window';
  return 'apply';
}

// Mirror of validTs in checkin-record-scans (keep identical).
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
function validTs(v: unknown): boolean {
  return typeof v === 'string' && ISO_TS.test(v) && Number.isFinite(Date.parse(v));
}

describe('validTs', () => {
  it('accepts Z', () => { expect(validTs('2026-10-04T10:00:00Z')).toBe(true); });
  it('accepts fractional with offset', () => { expect(validTs('2026-10-04T10:00:00.123+02:00')).toBe(true); });
  it('rejects no zone', () => { expect(validTs('2026-10-04T10:00:00')).toBe(false); });
  it('rejects infinity', () => { expect(validTs('infinity')).toBe(false); });
  it('rejects non-string', () => { expect(validTs(null)).toBe(false); });
  // Documented: V8 and Postgres both read 24:00:00Z as the next day's midnight, so it is accepted.
  it('accepts 24:00:00Z (next midnight)', () => { expect(validTs('2026-10-04T24:00:00Z')).toBe(true); });
});

// The function computes p_live_time_ok regardless of mode (go-live race): the
// flag is a pure function of the scan time, never of isTest.
describe('p_live_time_ok is mode independent', () => {
  const NOW = Date.parse('2026-06-20T12:00:00.000Z');
  it('is false for a far-future scan even when the event was read as test', () => {
    expect(liveTimeOk(Date.parse('2026-06-20T13:00:00.000Z'), NOW)).toBe(false);
  });
  it('is true for a recent scan', () => {
    expect(liveTimeOk(Date.parse('2026-06-20T11:59:00.000Z'), NOW)).toBe(true);
  });
});

describe('checkinVerdict', () => {
  it('a duplicate never consumes the test cap', () => {
    expect(checkinVerdict({ alreadyIn: true, isTest: true, testUsed: 25, inWindow: true })).toBe('duplicate');
  });
  it('the 26th test check-in is refused', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 25, inWindow: true })).toBe('test_cap');
  });
  it('the 25th test check-in is applied', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 24, inWindow: true })).toBe('apply');
  });
  it('test mode ignores the live window', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 0, inWindow: false })).toBe('apply');
  });
  it('live outside the window is refused', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: false, testUsed: 0, inWindow: false })).toBe('outside_window');
  });
  const NOW = Date.parse('2026-06-20T12:00:00.000Z');
  const live = (scannedIso: string) =>
    checkinVerdict({ alreadyIn: false, isTest: false, testUsed: 0, inWindow: liveTimeOk(Date.parse(scannedIso), NOW) });
  it('live, scanned 10 min in the future is outside_window', () => {
    expect(live('2026-06-20T12:10:00.000Z')).toBe('outside_window');
  });
  it('live, scanned 25h ago is outside_window', () => {
    expect(live('2026-06-19T11:00:00.000Z')).toBe('outside_window');
  });
  it('live, scanned 2h ago inside window is applied', () => {
    expect(live('2026-06-20T10:00:00.000Z')).toBe('apply');
  });
  it('liveTimeOk rejects NaN', () => { expect(liveTimeOk(NaN, NOW)).toBe(false); });
});
