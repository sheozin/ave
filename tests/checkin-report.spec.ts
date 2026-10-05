// tests/checkin-report.spec.ts
// Shaping for /checkin/report (event-day spec, feature 6).
import { describe, it, expect } from 'vitest';
import * as r from '../checkin-report.js';

const WAW = 'Europe/Warsaw';
const T0 = 1792310400; // 2026-10-18T08:00:00Z, 10:00 in Warsaw
const REP = (over: Record<string, unknown> = {}) => ({
  registered: 120, checked_in: 87, walk_ins: 6, walk_ins_in: 5,
  first_arrival_at: '2026-10-18T06:52:00Z', last_arrival_at: '2026-10-18T13:10:00Z',
  status: 'live', role: 'organizer',
  event: { name: 'Probe Summit', date: '2026-10-18', timezone: WAW, venue: 'Hall A' },
  by_ticket: [{ ticket_type: 'VIP', registered: 20, checked_in: 12, no_shows: 8 }],
  peak: { t: T0, n: 31 },
  offline: { late_checkins: 4, longest_delay_s: 330, desks: 1 },
  desks: [{ label: 'Front desk', checkins: 60, busiest_15: 22 }, { label: null, checkins: 27, busiest_15: 9 }],
  companies: [{ company: 'Fabrikam Demo', expected: 5, arrived: 1 }],
  ...over,
});

describe('fmtDuration', () => {
  it('reads hours and minutes', () => {
    expect(r.fmtDuration(6 * 3600e3 + 18 * 60e3)).toBe('6 h 18 min');
    expect(r.fmtDuration(45 * 60e3)).toBe('45 min');
    expect(r.fmtDuration(30e3)).toBe('under a minute');
  });
  it('a bad span is empty, not NaN', () => {
    expect(r.fmtDuration(NaN)).toBe('');
    expect(r.fmtDuration(-5)).toBe('');
  });
});

describe('reportTiles', () => {
  it('turnout, no-shows, walk-ins, peak window and first-to-last span', () => {
    expect(r.reportTiles(REP(), WAW)).toEqual({
      checkedIn: 87, registered: 120, turnout: 73, noShows: 33, walkIns: 6,
      peakN: 31, peakRange: '10:00 to 10:15', span: '6 h 18 min', firstLast: '08:52 to 15:10',
    });
  });
  it('no arrivals: no peak, no span, no turnout on an empty list', () => {
    const t = r.reportTiles(REP({ registered: 0, checked_in: 0, peak: null, first_arrival_at: null, last_arrival_at: null }), WAW);
    expect(t.turnout).toBeNull();
    expect(t.peakN).toBe(0);
    expect(t.peakRange).toBe('');
    expect(t.span).toBe('');
    expect(t.firstLast).toBe('');
  });
});

describe('offlineLine', () => {
  it('says how many check-ins synced late and the longest delay', () => {
    expect(r.offlineLine(REP())).toBe('4 check-ins were made offline on 1 desk and synced later. The longest delay was 5 min.');
  });
  it('none is said plainly', () => {
    expect(r.offlineLine(REP({ offline: { late_checkins: 0, longest_delay_s: 0, desks: 0 } }))).toBe('Every check-in reached the server within a minute.');
  });
  it('a missing block is not a crash', () => {
    expect(r.offlineLine(REP({ offline: null }))).toBe('Every check-in reached the server within a minute.');
  });
});

describe('deskRows', () => {
  it('numbers desks without a label', () => {
    expect(r.deskRows(REP())).toEqual([
      { label: 'Front desk', checkins: 60, busiest: 22 },
      { label: 'Desk 2', checkins: 27, busiest: 9 },
    ]);
  });
  it('a viewer report (no labels) is numbered throughout', () => {
    expect(r.deskRows(REP({ desks: [{ label: null, checkins: 3, busiest_15: 2 }] }))[0].label).toBe('Desk 1');
  });
});

describe('ticketRows', () => {
  it('turnout per ticket type', () => {
    expect(r.ticketRows(REP())).toEqual([{ ticketType: 'VIP', registered: 20, checkedIn: 12, noShows: 8, turnout: 60 }]);
  });
});
