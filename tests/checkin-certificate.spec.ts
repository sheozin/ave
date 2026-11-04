// tests/checkin-certificate.spec.ts: the certificate of attendance page
// (checkin-certificate.js, migration 156).
import { describe, it, expect } from 'vitest';
import { T, langOf, tokenOf, fmtDate, fmtTime, certText } from '../checkin-certificate.js';

const CERT = {
  guest: 'Ola Nowak', company: 'Acme', event: 'Med Summit', venue: 'Hall A', date: '2026-11-03', timezone: 'Europe/Warsaw',
  checked_in_at: '2026-11-03T08:12:00Z', host: 'AVE Events', brand_color: '#123456', logo_path: null, white_label: false,
  code: '0123-4567', rooms: [{ name: 'Plenary', first_at: '2026-11-03T09:00:00Z' }, { name: 'Workshop B', first_at: '2026-11-03T13:00:00Z' }],
};

describe('certificate page', () => {
  it('reads only a 32-hex token and a known language', () => {
    expect(tokenOf('/c/0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    expect(tokenOf('/c/0123456789ABCDEF0123456789abcdef')).toBeNull();
    expect(tokenOf('/c/short')).toBeNull();
    expect(tokenOf('/c/0123456789abcdef0123456789abcdef/x')).toBeNull();
    expect(langOf('?l=pl')).toBe('pl');
    expect(langOf('?l=fr')).toBe('en');
    expect(langOf('')).toBe('en');
  });
  it('states what was recorded, in the event time zone, and never a duration', () => {
    const x = certText(CERT, 'en');
    expect(x.name).toBe('Ola Nowak');
    expect(x.place).toBe('attended Med Summit at Hall A on 3 November 2026.');
    expect(x.checkedIn).toBe('Checked in at 09:12.');
    expect(x.rooms).toBe('Also attended: Plenary, Workshop B.');
    expect(x.code).toBe('Code 0123-4567');
    expect(x.powered).toBe('Check-in by CueDeck');
    expect(JSON.stringify(x)).not.toMatch(/hour|minute|duration/i);
  });
  it('leaves out what it does not know', () => {
    const x = certText({ ...CERT, venue: null, date: null, company: null, rooms: [], white_label: true }, 'en');
    expect(x.place).toBe('attended Med Summit.');
    expect(x.rooms).toBe('');
    expect(x.company).toBe('');
    expect(x.powered).toBe('');
  });
  it('the event date does not move with the reader\'s time zone', () => {
    expect(fmtDate('2026-11-03', 'en')).toBe('3 November 2026');
    expect(fmtDate('nonsense', 'en')).toBe('');
    expect(fmtTime('2026-11-03T08:12:00Z', 'Not/AZone', 'en')).toBe('08:12 UTC');
  });
  it('every language has every string, no em dashes', () => {
    for (const l of ['pl', 'de', 'ar']) {
      expect(Object.keys(T[l]).sort()).toEqual(Object.keys(T.en).sort());
      expect(Object.values(T[l]).filter(v => v.includes('—'))).toEqual([]);
    }
    expect(Object.values(T.en).filter(v => v.includes('—'))).toEqual([]);
    expect(certText(CERT, 'ar').rooms).toBe('حضر أيضًا: Plenary، Workshop B.');
  });
});
