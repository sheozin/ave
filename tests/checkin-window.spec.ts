// tests/checkin-window.spec.ts
// The browser copy of the window rule (checkin-window.js) must agree with
// the server copy (supabase/functions/_shared/checkin-policy.ts). Both are
// imported for real and run over the same table, so drift fails here.
import { describe, it, expect } from 'vitest';
import * as browser from '../checkin-window.js';
import * as server from '../supabase/functions/_shared/checkin-policy.ts';

const iso = (w: { opensAt: Date; closesAt: Date } | null) =>
  w && { opensAt: w.opensAt.toISOString(), closesAt: w.closesAt.toISOString() };

const WINDOWS: [string, string][] = [
  ['2026-10-26', 'Europe/Warsaw'],   // DST change inside the window
  ['2026-06-20', 'Europe/Warsaw'],
  ['2026-11-12', 'Africa/Cairo'],
  ['2026-11-20', 'Asia/Kolkata'],
  ['2026-02-31', 'Europe/Warsaw'],   // invalid date
  ['26-10-2026', 'Europe/Warsaw'],   // invalid date format
  ['2026-10-26', 'Not/AZone'],       // invalid tz
  ['2026-10-26', ''],                // empty tz
];

const SCANS: [string, string, string][] = [
  ['2026-11-14T21:30:00.000Z', '2026-11-12', 'Africa/Cairo'],
  ['2026-11-14T22:10:00.000Z', '2026-11-12', 'Africa/Cairo'],
  ['2026-11-04T22:00:00.000Z', '2026-11-12', 'Africa/Cairo'],
  ['2026-11-12T18:30:00.000Z', '2026-11-20', 'Asia/Kolkata'],
  ['2026-11-12T18:29:59.000Z', '2026-11-20', 'Asia/Kolkata'],
  ['2026-10-20T10:00:00+02:00', '2026-10-26', 'Europe/Warsaw'],
  ['2026-10-20T10:00:00', '2026-10-26', 'Europe/Warsaw'],      // no zone
  ['2026-10-20T10:00:00.000Z', '2026-02-31', 'Europe/Warsaw'], // invalid date
  ['2026-10-20T10:00:00.000Z', '2026-10-26', 'Not/AZone'],     // invalid tz
  ['not a date Z', '2026-10-26', 'Europe/Warsaw'],
];

describe('checkin-window.js', () => {
  it('matches the server on Warsaw DST', () => {
    const w = browser.checkinWindow('2026-10-26', 'Europe/Warsaw');
    expect(w.opensAt.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(w.closesAt.toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
  it('matches the server on Cairo edges', () => {
    expect(browser.isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(true);
    expect(browser.isWithinWindow('2026-11-14T22:10:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(false);
  });
  it('returns null / false on invalid input and never throws', () => {
    expect(browser.checkinWindow('2026-02-31', 'Europe/Warsaw')).toBeNull();
    expect(browser.checkinWindow('2026-10-26', 'Not/AZone')).toBeNull();
    expect(browser.isWithinWindow('2026-10-20T10:00:00', '2026-10-26', 'Europe/Warsaw')).toBe(false);
    expect(() => browser.isWithinWindow(undefined as unknown as string, undefined as unknown as string, undefined as unknown as string)).not.toThrow();
  });
  it('TEST_CAP agrees with the server', () => {
    expect(browser.TEST_CAP).toBe(server.TEST_CAP);
  });
  it.each(WINDOWS)('checkinWindow(%s, %s) agrees with the server', (d, tz) => {
    expect(iso(browser.checkinWindow(d, tz))).toEqual(iso(server.checkinWindow(d, tz)));
  });
  it.each(WINDOWS)('isValidEventDate / isValidTimeZone agree for (%s, %s)', (d, tz) => {
    expect(browser.isValidEventDate(d)).toBe(server.isValidEventDate(d));
    expect(browser.isValidTimeZone(tz)).toBe(server.isValidTimeZone(tz));
  });
  it.each(SCANS)('isWithinWindow(%s, %s, %s) agrees with the server', (t, d, tz) => {
    expect(browser.isWithinWindow(t, d, tz)).toBe(server.isWithinWindow(t, d, tz));
  });
});
