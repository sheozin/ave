// tests/checkin-client-report-page.spec.ts: the client report page,
// /cr/<token> (checkin-client-report.js, migration 158).
import { describe, it, expect } from 'vitest';
import { tokenOf, reportView } from '../checkin-client-report.js';

const R = {
  event: { name: 'Med Summit', date: '2026-11-03', venue: 'Hall A', timezone: 'Europe/Warsaw' },
  registered: 200, checked_in: 150, walk_ins: 1,
  first_arrival_at: '2026-11-03T07:31:00Z', last_arrival_at: '2026-11-03T12:02:00Z',
  peak: { t: Date.parse('2026-11-03T07:45:00Z') / 1000, n: 41 },
  by_ticket: [{ ticket_type: 'Delegate', registered: 180, checked_in: 132, no_shows: 48 }, { ticket_type: 'VIP', registered: 20, checked_in: 18, no_shows: 2 }],
  host: 'AVE Events', brand_color: '#123456', logo_path: null, white_label: false,
};

describe('client report page', () => {
  it('reads only a 32-hex token under /cr/', () => {
    expect(tokenOf('/cr/0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    expect(tokenOf('/c/0123456789abcdef0123456789abcdef')).toBeNull();
    expect(tokenOf('/cr/0123456789ABCDEF0123456789abcdef')).toBeNull();
  });
  it('the headline numbers, in the event time zone', () => {
    const v = reportView(R);
    expect(v.title).toBe('Med Summit');
    expect(v.sub).toBe('3 November 2026, Hall A');
    expect(v.tiles.map(t => t.big + ' ' + t.label)).toEqual([
      '150 of 200 checked in (75%)', '50 did not arrive', '1 walk-in', '41 arrived in the busiest 15 minutes, from 08:45']);
    expect(v.span).toBe('First arrival 08:31, last arrival 13:02.');
    expect(v.tickets).toEqual([{ name: 'Delegate', inn: 132, reg: 180, pct: '73%' }, { name: 'VIP', inn: 18, reg: 20, pct: '90%' }]);
    expect(v.host).toBe('Shared by AVE Events');
    expect(v.powered).toBe('Check-in by CueDeck');
  });
  it('an empty event says nothing it does not know', () => {
    const v = reportView({ event: { name: 'X', date: null, venue: null, timezone: null }, registered: 0, checked_in: 0, walk_ins: 0, peak: null, by_ticket: [], white_label: true });
    expect(v.tiles[0].label).toBe('of 0 checked in');
    expect(v.span).toBe('');
    expect(v.powered).toBe('');
    expect(JSON.stringify(v)).not.toContain('—');
  });
});
