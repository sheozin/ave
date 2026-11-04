// tests/checkin-export.spec.ts: the attendance and activity exports.
import { describe, it, expect } from 'vitest';
import { localParts, attendanceTable, activityTable, exportOptions, presenceByDay, dayCounts } from '../checkin-export.js';

const TZ = 'Europe/Warsaw';
const ANA = { id: 'a', first_name: 'Ana', last_name: 'Nowak', email: 'ana@x.io', company: 'Contoso', ticket_type: 'VIP', source: 'import',
  checked_in_at: '2026-12-09T07:41:12Z', badge_printed_at: '2026-12-09T07:41:20Z' };
const BEN = { id: 'b', first_name: 'Ben', last_name: 'Lis', email: 'ben@x.io', company: 'Fabrikam', ticket_type: 'attendee', source: 'web',
  checked_in_at: null, badge_printed_at: null };
const CAL = { id: 'c', first_name: 'Cal', last_name: 'Adams', email: null, company: null, ticket_type: 'attendee', source: 'walk_in',
  checked_in_at: '2026-12-10T09:05:00Z', badge_printed_at: null };
const row = (at, kind, a, over = {}) => ({ at, kind, attendee_id: a.id, first_name: a.first_name, last_name: a.last_name, email: a.email,
  company: a.company, ticket_type: a.ticket_type, desk: null, place: null, device: null, staff: null, ...over });
const ACT = [
  row('2026-12-09T07:30:00Z', 'ok', ANA, { desk: 'Desk 1', staff: 'Ola' }),
  row('2026-12-09T07:31:00Z', 'undo', ANA, { desk: 'Desk 1', staff: 'Ola' }),
  row('2026-12-09T07:41:12Z', 'ok', ANA, { desk: 'Desk 2', staff: 'Marek' }),
  row('2026-12-09T08:02:00Z', 'duplicate', ANA, { place: 'Main door', device: 'Door phone' }),
  row('2026-12-09T09:00:00Z', 'new_badge', ANA, { staff: 'Marek' }),
  row('2026-12-09T09:30:00Z', 'revoked', ANA, { place: 'Main door', device: 'Door phone' }),
  row('2026-12-10T09:05:00Z', 'ok', CAL, { place: 'Hall B', device: 'Hall phone' }),
];

describe('localParts', () => {
  it('gives the date and time in the event timezone', () => {
    expect(localParts('2026-12-09T07:41:12Z', TZ)).toEqual({ date: '2026-12-09', time: '08:41:12' });
    expect(localParts('2026-12-09T23:30:00Z', TZ)).toEqual({ date: '2026-12-10', time: '00:30:00' });
    expect(localParts(null, TZ)).toEqual({ date: '', time: '' });
  });
});

describe('attendanceTable', () => {
  it('one row per guest, with the desk and staff of the check-in that stands', () => {
    const t = attendanceTable([ANA, BEN, CAL], ACT, TZ, {});
    expect(t.head).toEqual(['First name', 'Last name', 'Email', 'Company', 'Ticket', 'Source', 'Checked in (date)', 'Checked in (time)',
      'Desk or door', 'Checked in by', 'Badge printed at', 'Badges replaced', 'Scanned on 2026-12-09', 'Scanned on 2026-12-10']);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]).toEqual(['Ana', 'Nowak', 'ana@x.io', 'Contoso', 'VIP', 'Imported', '2026-12-09', '08:41:12', 'Desk 2', 'Marek', '2026-12-09 08:41:20', 1, 'Yes', '']);
    expect(t.rows[1].slice(6, 10)).toEqual(['', '', '', '']);
    expect(t.rows[2].slice(8, 10)).toEqual(['Hall B (Hall phone)', '']);
  });
  it('filters by day, time, ticket, status and desk', () => {
    const names = (o) => attendanceTable([ANA, BEN, CAL], ACT, TZ, o).rows.map(r => r[0]);
    expect(names({ day: '2026-12-10' })).toEqual(['Cal']);
    expect(names({ status: 'out' })).toEqual(['Ben']);
    expect(names({ status: 'in' })).toEqual(['Ana', 'Cal']);
    expect(names({ from: '09:00' })).toEqual(['Ben', 'Cal']);
    expect(names({ ticket: 'VIP' })).toEqual(['Ana']);
    expect(names({ place: 'Desk 2' })).toEqual(['Ana']);
  });
});

describe('attendance per day', () => {
  // Ana: checked in on day 1, scanned again at the door on day 2.
  // Dan: checked in on day 1, then on day 2 his check-in was undone.
  // Eve: checked in on day 2 only. An old badge of hers was blocked on day 1.
  const DAN = { ...BEN, id: 'd', first_name: 'Dan', checked_in_at: '2026-12-09T08:00:00Z' };
  const EVE = { ...BEN, id: 'e', first_name: 'Eve', checked_in_at: '2026-12-10T10:00:00Z' };
  const MULTI = [
    row('2026-12-09T07:41:12Z', 'ok', ANA), row('2026-12-10T07:50:00Z', 'duplicate', ANA, { place: 'Main door' }),
    row('2026-12-09T08:00:00Z', 'ok', DAN), row('2026-12-10T08:00:00Z', 'duplicate', DAN), row('2026-12-10T08:05:00Z', 'undo', DAN),
    row('2026-12-09T09:00:00Z', 'revoked', EVE), row('2026-12-10T10:00:00Z', 'ok', EVE),
  ];
  it('a day counts when the last scan that day stands', () => {
    const p = presenceByDay(MULTI, TZ);
    expect([...p.get('a')]).toEqual(['2026-12-09', '2026-12-10']);
    expect([...p.get('d')]).toEqual(['2026-12-09']);
    expect([...p.get('e')]).toEqual(['2026-12-10']);
  });
  it('leaving through an exit counts as scanned that day, and reads in plain words', () => {
    const act = [row('2026-12-09T07:41:12Z', 'ok', ANA), row('2026-12-10T16:00:00Z', 'out', ANA, { place: 'Exit' })];
    expect([...presenceByDay(act, TZ).get('a')]).toEqual(['2026-12-09', '2026-12-10']);
    const t = activityTable(act, TZ, { what: 'problems' });
    expect(t.rows).toEqual([]);
    expect(activityTable(act, TZ, {}).rows[1][7]).toBe('Left (exit scan)');
  });
  it('counts guests here each day', () => {
    expect(dayCounts([ANA, DAN, EVE, BEN], MULTI, TZ)).toEqual([{ date: '2026-12-09', count: 2 }, { date: '2026-12-10', count: 2 }]);
  });
  it('the day filter means here that day, and each day has a column', () => {
    const t = attendanceTable([ANA, DAN, EVE], MULTI, TZ, { day: '2026-12-10' });
    expect(t.rows.map(r => r[0])).toEqual(['Ana', 'Eve']);
    expect(t.head.slice(-2)).toEqual(['Scanned on 2026-12-09', 'Scanned on 2026-12-10']);
    expect(t.rows[0].slice(-2)).toEqual(['Yes', 'Yes']);
  });
  it('a one-day event gets no extra columns', () => {
    const t = attendanceTable([ANA], [row('2026-12-09T07:41:12Z', 'ok', ANA)], TZ, {});
    expect(t.head[t.head.length - 1]).toBe('Badges replaced');
  });
  it('the time filter applies to the check-in day only', () => {
    const names = (o) => attendanceTable([ANA, DAN, EVE], MULTI, TZ, o).rows.map(r => r[0]);
    expect(names({ day: '2026-12-10', from: '10:30' })).toEqual(['Ana', 'Eve']);
    expect(names({ day: '2026-12-10', from: '11:30' })).toEqual(['Ana']);
  });
});

describe('activityTable', () => {
  it('every action in time order, in plain words', () => {
    const t = activityTable(ACT, TZ, {});
    expect(t.head).toEqual(['Date', 'Time', 'First name', 'Last name', 'Email', 'Company', 'Ticket', 'What happened', 'Desk or door', 'Staff']);
    expect(t.rows.map(r => r[7])).toEqual(['Checked in', 'Check-in undone', 'Checked in', 'Scanned again, already checked in',
      'New badge printed, old code blocked', 'Old badge scanned, blocked', 'Checked in']);
    expect(t.rows[3].slice(0, 2)).toEqual(['2026-12-09', '09:02:00']);
    expect(t.rows[3][8]).toBe('Main door (Door phone)');
  });
  it('a code that matched no guest still shows, without a name', () => {
    const t = activityTable([{ at: '2026-12-09T08:00:00Z', kind: 'unknown_token', attendee_id: null, first_name: null, last_name: null,
      email: null, company: null, ticket_type: null, desk: 'Desk 1', place: null, device: null, staff: 'Ola' }], TZ, {});
    expect(t.rows[0].slice(2, 4)).toEqual(['', '']);
    expect(t.rows[0][7]).toBe('Code not on the guest list');
  });
  it('filters by what happened: check-ins, problems, new badges', () => {
    const kinds = (what) => activityTable(ACT, TZ, { what }).rows.map(r => r[7]);
    expect(kinds('checkins')).toEqual(['Checked in', 'Check-in undone', 'Checked in', 'Checked in']);
    expect(kinds('problems')).toEqual(['Scanned again, already checked in', 'Old badge scanned, blocked']);
    expect(kinds('badges')).toEqual(['New badge printed, old code blocked']);
  });
  it('filters by day, time window and desk or door', () => {
    expect(activityTable(ACT, TZ, { day: '2026-12-10' }).rows).toHaveLength(1);
    expect(activityTable(ACT, TZ, { from: '08:40', to: '09:05' }).rows.map(r => r[1])).toEqual(['08:41:12', '09:02:00']);
    expect(activityTable(ACT, TZ, { place: 'Main door (Door phone)' }).rows).toHaveLength(2);
  });
});

describe('exportOptions', () => {
  it('lists the days, tickets and desks or doors that occur', () => {
    expect(exportOptions([ANA, BEN, CAL], ACT, TZ)).toEqual({
      days: ['2026-12-09', '2026-12-10'],
      tickets: ['attendee', 'VIP'],
      places: ['Desk 1', 'Desk 2', 'Hall B (Hall phone)', 'Main door (Door phone)'],
    });
  });
});
