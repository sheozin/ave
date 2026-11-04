// tests/checkin-host-email.spec.ts: the host arrival email (migration 154).
import { describe, it, expect } from 'vitest';
import { hostEmail, hostTime, headerSafe, fromDisplayName } from '../supabase/functions/_shared/host-email.ts';

const BASE = { hostName: 'Anna', eventName: 'Spring Forum', timeZone: 'Europe/Warsaw', stopUrl: 'https://app.cuedeck.io/checkin/host-stop?t=abc' };

describe('hostEmail', () => {
  it('one guest: names them, their company and the time in the event zone, with the stop link', () => {
    const m = hostEmail({ ...BASE, arrivals: [{ name: 'Marta Kowalczyk', company: 'Nordlight', at: '2026-12-09T08:12:00Z' }] });
    expect(m.subject).toBe('Marta Kowalczyk has arrived at Spring Forum');
    expect(m.html).toContain('Marta Kowalczyk');
    expect(m.html).toContain('Nordlight');
    expect(m.html).toContain('09:12');
    expect(m.html).toContain('href="https://app.cuedeck.io/checkin/host-stop?t=abc"');
    expect(m.text).toContain('09:12  Marta Kowalczyk (Nordlight)');
    expect(m.text).toContain('Stop them: https://app.cuedeck.io/checkin/host-stop?t=abc');
  });
  it('count only: no name or company anywhere, just how many and when', () => {
    const one = hostEmail({ ...BASE, countOnly: true, arrivals: [{ name: 'Marta Kowalczyk', company: 'Nordlight', at: '2026-12-09T08:12:00Z' }] });
    expect(one.subject).toBe('A guest of yours has arrived at Spring Forum');
    const two = hostEmail({ ...BASE, countOnly: true, arrivals: [
      { name: 'Marta Kowalczyk', company: 'Nordlight', at: '2026-12-09T08:12:00Z' }, { name: 'Jan Nowak', company: 'Acme', at: '2026-12-09T08:14:00Z' }] });
    for (const m of [one, two]) {
      for (const x of ['Marta', 'Kowalczyk', 'Nordlight', 'Jan', 'Nowak', 'Acme']) { expect(m.html).not.toContain(x); expect(m.text).not.toContain(x); expect(m.subject).not.toContain(x); }
    }
    expect(two.subject).toBe('2 of your guests have arrived at Spring Forum');
    expect(two.text).toContain('09:14  A guest');
  });
  it('several guests in one email, earliest first', () => {
    const m = hostEmail({ ...BASE, arrivals: [
      { name: 'B', company: null, at: '2026-12-09T08:13:00Z' },
      { name: 'A', company: 'X', at: '2026-12-09T08:12:00Z' },
    ] });
    expect(m.subject).toBe('2 of your guests have arrived at Spring Forum');
    expect(m.text.indexOf('A (X)')).toBeLessThan(m.text.indexOf('  B'));
  });
  it('escapes everything typed, and keeps the subject to one clean line', () => {
    const m = hostEmail({ ...BASE, eventName: 'Fest\r\nBcc: x@y.z <b>', hostName: '<img src=x>', arrivals: [{ name: '<script>', company: '"Co"', at: '2026-12-09T08:12:00Z' }] });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img src=x>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.subject).not.toMatch(/[\r\n<>]/);
  });
  it('drops the CueDeck line for white label', () => {
    expect(hostEmail({ ...BASE, whiteLabel: true, arrivals: [{ name: 'A', company: null, at: '2026-12-09T08:12:00Z' }] }).html).not.toContain('Check-in powered by');
  });
});

describe('hostTime and headerSafe', () => {
  it('falls back to UTC for a bad zone and says so', () => {
    expect(hostTime('2026-12-09T08:12:00Z', 'Not/AZone')).toBe('08:12 UTC');
  });
  it('strips breaks and brackets', () => {
    expect(headerSafe('a\nb<c>')).toBe('a bc');
  });
});

describe('fromDisplayName', () => {
  it('quotes the name and drops what could split the From header', () => {
    expect(fromDisplayName('Spring Forum')).toBe('"Spring Forum Check-in"');
    const n = fromDisplayName('Evil" <a@b.c>, x@y.z;\u202e\r\n');
    expect(n).not.toMatch(/[@<>,;\r\n\u202e]/);
    expect(n.slice(1, -1)).not.toContain('"');
  });
  it('falls back to CueDeck for an empty name', () => {
    expect(fromDisplayName('  ""  ')).toBe('"CueDeck Check-in"');
  });
});
