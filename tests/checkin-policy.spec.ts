// tests/checkin-policy.spec.ts
// Mirrors supabase/functions/_shared/checkin-policy.ts. Deno Edge
// Functions are not importable into vitest (see checkin-scan.spec.ts),
// so the logic is re-expressed here and kept in sync by hand.
import { describe, it, expect } from 'vitest';

const TEST_CAP = 25;

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function checkinWindow(eventDate: string, timeZone: string) {
  return { opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
           closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone) };
}

function isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean {
  const t = Date.parse(scannedAtIso);
  if (Number.isNaN(t)) return false;
  const w = checkinWindow(eventDate, timeZone);
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}

function routeCheckoutSession(
  s: { metadata?: Record<string, string> | null; payment_status?: string },
  lineItemProductIds: string[], checkinProductId: string,
): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string } {
  const md = s.metadata || {};
  if (md.product === 'checkin') {
    if (!md.event_id || !md.buyer_id) return { route: 'ignore', reason: 'checkin session missing event_id or buyer_id' };
    if (!lineItemProductIds.includes(checkinProductId)) return { route: 'ignore', reason: 'checkin metadata but line item is not the check-in product' };
    if (s.payment_status !== 'paid') return { route: 'ignore', reason: `payment_status ${s.payment_status}` };
    return { route: 'checkin' };
  }
  if (md.plan === 'perevent') return { route: 'perevent' };
  return { route: 'ignore', reason: 'not a CueDeck check-in or Pay-per-Event session' };
}

describe('checkinWindow', () => {
  it('opens at local midnight 7 days before, Warsaw summer (UTC+2)', () => {
    expect(checkinWindow('2026-06-20', 'Europe/Warsaw').opensAt.toISOString()).toBe('2026-06-12T22:00:00.000Z');
  });
  it('closes at local midnight starting date+3, Warsaw summer', () => {
    expect(checkinWindow('2026-06-20', 'Europe/Warsaw').closesAt.toISOString()).toBe('2026-06-22T22:00:00.000Z');
  });
  it('handles a DST change inside the window (Warsaw, Oct 25 2026)', () => {
    const w = checkinWindow('2026-10-26', 'Europe/Warsaw');
    expect(w.opensAt.toISOString()).toBe('2026-10-18T22:00:00.000Z'); // still CEST
    expect(w.closesAt.toISOString()).toBe('2026-10-28T23:00:00.000Z'); // CET
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
});

describe('routeCheckoutSession', () => {
  const P = 'prod_checkin';
  it('routes a paid check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [P], P).route).toBe('checkin');
  });
  it('ignores an unpaid (async) check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'unpaid' }, [P], P).route).toBe('ignore');
  });
  it('ignores check-in metadata on a different product (forged or CueQuote)', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, ['prod_other'], P).route).toBe('ignore');
  });
  it('routes Pay-per-Event', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, ['prod_U7KZqMU9oG4QWD'], P).route).toBe('perevent');
  });
  it('ignores a CueQuote session with no CueDeck metadata', () => {
    expect(routeCheckoutSession({ metadata: { company_id: 'x' }, payment_status: 'paid' }, ['prod_cq'], P).route).toBe('ignore');
  });
  it('TEST_CAP is 25', () => { expect(TEST_CAP).toBe(25); });
});
