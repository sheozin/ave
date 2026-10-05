// tests/checkin-dashboard.spec.ts
// Pure shaping for /checkin/dashboard. Every number the page shows comes
// through these functions, so the event-day rules are pinned here:
// 90 s online, 10 check-ins before pace, 5 active minutes per desk,
// 90% of capacity for 10 minutes before the staffing warning.
import { describe, it, expect } from 'vitest';
import * as d from '../checkin-dashboard.js';

const T0 = 1792310400; // 2026-10-18T08:00:00Z, 10:00 in Warsaw
const WAW = 'Europe/Warsaw';
const stats = (over: Record<string, unknown> = {}) => ({
  role: 'organizer', status: 'live', registered: 120, checked_in: 45, walk_ins: 6,
  by_source: { import: 114, kiosk: 4, walk_in: 2 }, qr: { sent: 100, not_sent: 15, no_email: 5 },
  by_ticket: [{ ticket_type: 'attendee', registered: 100, checked_in: 40 }, { ticket_type: 'VIP', registered: 20, checked_in: 5 }],
  arrivals: [{ t: T0, n: 10 }, { t: T0 + 900, n: 25 }, { t: T0 + 1800, n: 10 }],
  last_25_min: Array(25).fill(0), ops: null, ...over,
});

describe('fmtClock and pct', () => {
  it('formats in the event timezone, 24 hour', () => {
    expect(d.fmtClock(T0 * 1000, WAW)).toBe('10:00');
    expect(d.fmtClock(T0 * 1000, 'Asia/Kolkata')).toBe('13:30');
  });
  it('an invalid zone formats in UTC and says so; an invalid date is empty', () => {
    expect(d.fmtClock(T0 * 1000, 'Not/AZone')).toBe('08:00 UTC');
    expect(d.fmtClock(NaN, WAW)).toBe('');
  });
  it('never divides by zero', () => {
    expect(d.pct(45, 120)).toBe(38);
    expect(d.pct(0, 0)).toBeNull();
  });
});

describe('tiles', () => {
  it('reads the stats', () => {
    expect(d.tiles(stats(), false)).toEqual({
      registered: 120, checkedIn: 45, turnout: 38, expectedLabel: 'Still expected', expected: 75, walkIns: 6,
      peak: { t: T0 + 900, n: 25 },
    });
  });
  it('becomes No-shows once the window closes', () => {
    expect(d.tiles(stats(), true).expectedLabel).toBe('No-shows');
  });
  it('an empty list has no turnout and no peak', () => {
    const t = d.tiles(stats({ registered: 0, checked_in: 0, walk_ins: 0, arrivals: [] }), false);
    expect(t.turnout).toBeNull();
    expect(t.expected).toBe(0);
    expect(t.peak).toBeNull();
  });
});

describe('peakBucket', () => {
  it('takes the earliest of equal peaks', () => {
    expect(d.peakBucket([{ t: T0, n: 5 }, { t: T0 + 900, n: 5 }])).toEqual({ t: T0, n: 5 });
  });
  it('is null with no arrivals', () => { expect(d.peakBucket([])).toBeNull(); });
});

describe('arrivalSeries', () => {
  it('fills empty 15-minute buckets and runs a cumulative total', () => {
    const s = d.arrivalSeries([{ t: T0, n: 2 }, { t: T0 + 1800, n: 3 }], WAW);
    expect(s).toEqual({ labels: ['10:00', '10:15', '10:30'], bars: [2, 0, 3], cumulative: [2, 2, 5] });
  });
  it('keeps the latest 96 buckets and carries earlier arrivals into the total', () => {
    const s = d.arrivalSeries([{ t: T0, n: 2 }, { t: T0 + 200 * 900, n: 3 }], WAW);
    expect(s.labels).toHaveLength(96);
    expect(s.cumulative[0]).toBe(2);
    expect(s.cumulative[95]).toBe(5);
    expect(s.bars[95]).toBe(3);
  });
  it('is empty with no arrivals', () => {
    expect(d.arrivalSeries([], WAW)).toEqual({ labels: [], bars: [], cumulative: [] });
  });
});

describe('chart data', () => {
  it('status doughnut', () => {
    expect(d.statusDoughnut(stats(), false)).toEqual({ labels: ['Checked in', 'Still expected'], data: [45, 75] });
    expect(d.statusDoughnut(stats(), true).labels[1]).toBe('No-show');
  });
  it('ticket bars carry turnout in the label', () => {
    expect(d.ticketBars(stats())).toEqual({ labels: ['attendee · 40%', 'VIP · 25%'], registered: [100, 20], checkedIn: [40, 5] });
  });
  it('sources and QR status', () => {
    expect(d.sourceBars(stats())).toEqual({ labels: ['Imported', 'Kiosk', 'Walk-in'], data: [114, 4, 2] });
    expect(d.qrBars(stats())).toEqual({ labels: ['Sent', 'Not sent', 'No email address'], data: [100, 15, 5] });
  });
});

describe('rates', () => {
  const last = [...Array(10).fill(0), ...Array(15).fill(2)];
  it('arrival rate is the last 15 minutes per minute', () => {
    expect(d.arrivalRate(last)).toBe(2);
  });
  it('rateAt looks further back', () => {
    expect(d.rateAt(last, 10)).toBeCloseTo((5 * 2) / 15);
    expect(d.rateAt(last, 11)).toBeNull();
  });
  it('formats', () => {
    expect(d.fmtRate(12.4)).toBe('12');
    expect(d.fmtRate(2.25)).toBe('2.3');
    expect(d.fmtRate(2)).toBe('2');
  });
});

describe('clientView', () => {
  it('hides the rate until 10 check-ins', () => {
    expect(d.clientView(stats({ checked_in: 9 })).rate).toBeNull();
    expect(d.clientView(stats({ last_25_min: [...Array(10).fill(0), ...Array(15).fill(1)] })).rate).toBe(1);
  });
  it('numbers only', () => {
    expect(Object.keys(d.clientView(stats())).sort()).toEqual(['checkedIn', 'peak', 'rate', 'registered', 'turnout']);
  });
});

describe('deskState (90 s rule)', () => {
  it('89 and 90 seconds are online, 91 is offline', () => {
    expect(d.deskState({ seconds_since_seen: 89, pending_count: 0 }, WAW)).toEqual({ kind: 'online', text: 'Online' });
    expect(d.deskState({ seconds_since_seen: 90, pending_count: 0 }, WAW).kind).toBe('online');
    expect(d.deskState({ seconds_since_seen: 91, pending_count: 0, last_seen_at: '2026-10-18T09:02:00Z' }, WAW))
      .toEqual({ kind: 'offline', text: 'Offline since 11:02' });
  });
  it('online with a queue is syncing', () => {
    expect(d.deskState({ seconds_since_seen: 10, pending_count: 14 }, WAW)).toEqual({ kind: 'syncing', text: 'Syncing, 14 waiting' });
  });
  it('a kiosk never seen is not connected yet', () => {
    expect(d.deskState({ seconds_since_seen: null, last_seen_at: null }, WAW)).toEqual({ kind: 'offline', text: 'Not connected yet' });
  });
});

describe('deskSpeed', () => {
  const sp = (busiest: number, minutes: number) => ({
    k: 1, label: 'Desk 1', busiest_15: busiest, active_minutes: 10,
    first_at: '2026-10-18T08:00:00Z', last_at: new Date(Date.parse('2026-10-18T08:00:00Z') + minutes * 60000).toISOString(),
  });
  it('a long-running desk divides its busiest window by 15', () => { expect(d.deskSpeed(sp(30, 120))).toBe(2); });
  it('a desk open 6 minutes divides by 6, not 15', () => { expect(d.deskSpeed(sp(30, 6))).toBe(5); });
  it('never divides by less than 5 minutes', () => { expect(d.deskSpeed(sp(10, 1))).toBe(2); });
  it('zero without scans', () => { expect(d.deskSpeed(null)).toBe(0); });
});

describe('deskRows and gapLines', () => {
  const ops = {
    desks: [{ k: 1, label: 'Desk 2', operator: 'Ewa Sample', seconds_since_seen: 20, pending_count: 0, last_seen_at: '2026-10-18T09:10:00Z' },
            { k: 2, label: 'Desk 3', operator: null, seconds_since_seen: 300, pending_count: 14, last_seen_at: '2026-10-18T09:05:00Z' }],
    kiosks: [{ label: 'Lobby kiosk', seconds_since_seen: 5, last_seen_at: '2026-10-18T09:12:00Z' }],
    speeds: [], gaps: [
      { k: 1, label: 'Desk 2', start_at: '2026-10-18T09:02:00Z', end_at: '2026-10-18T09:09:00Z', synced_ok: 23 },
      { k: 2, label: 'Desk 3', start_at: '2026-10-18T08:30:00Z', end_at: '2026-10-18T08:31:00Z', synced_ok: 1 },
      { k: 9, start_at: '2026-10-18T08:00:00Z', end_at: '2026-10-18T08:05:00Z', synced_ok: 2 },
    ],
  };
  it('lists desks then kiosks', () => {
    expect(d.deskRows(ops, WAW)).toEqual([
      { label: 'Desk 2', who: 'Ewa Sample', state: { kind: 'online', text: 'Online' } },
      { label: 'Desk 3', who: '', state: { kind: 'offline', text: 'Offline since 11:05' } },
      { label: 'Lobby kiosk', who: 'Kiosk', state: { kind: 'online', text: 'Online' } },
    ]);
  });
  it('claims "0 lost" only when the desk reports an empty queue', () => {
    expect(d.gapLines(ops, WAW)).toEqual([
      'Desk 2 offline 11:02 to 11:09, 23 check-ins synced late, 0 lost.',
      'Desk 3 offline 10:30 to 10:31, 1 check-in synced late, 14 still on the device.',
      'A desk offline 10:00 to 10:05, 2 check-ins synced late, no report from that desk yet.',
    ]);
  });
});

describe('gapLines pairing by k', () => {
  const dk = (k: number, pending: number | null) => ({ k, label: 'Desk 1', operator: 'Unnamed', seconds_since_seen: 5, pending_count: pending, last_seen_at: '2026-10-18T09:10:00Z' });
  const g = (k: number) => ({ k, label: 'Desk 1', start_at: '2026-10-18T09:00:00Z', end_at: '2026-10-18T09:05:00Z', synced_ok: 3 });
  it('two desks labelled Desk 1 are judged separately', () => {
    const lines = d.gapLines({ desks: [dk(1, 0), dk(2, 4)], kiosks: [], speeds: [], gaps: [g(1), g(2)] }, WAW);
    expect(lines[0]).toMatch(/0 lost\.$/);
    expect(lines[1]).toMatch(/4 still on the device\.$/);
  });
  it('a missing desk row never reads 0 lost', () => {
    expect(d.gapLines({ desks: [dk(1, 0)], kiosks: [], speeds: [], gaps: [g(2)] }, WAW)[0]).toMatch(/no report from that desk yet\.$/);
  });
  it('an unreported queue never reads 0 lost', () => {
    expect(d.gapLines({ desks: [dk(1, null)], kiosks: [], speeds: [], gaps: [g(1)] }, WAW)[0]).not.toMatch(/0 lost/);
  });
});

describe('paceMessages', () => {
  const NOW = Date.parse('2026-10-18T07:30:00Z');
  const START = Date.parse('2026-10-18T07:00:00Z');
  const desk = (id: number, since = 10) => ({ k: id, label: 'Desk ' + id, seconds_since_seen: since, pending_count: 0, last_seen_at: '2026-10-18T07:29:00Z' });
  const speed = (id: number, busiest: number, active = 10) => ({ k: id, label: 'Desk ' + id, busiest_15: busiest, active_minutes: active, first_at: '2026-10-18T06:00:00Z', last_at: '2026-10-18T07:29:00Z' });
  const ops = (over: Record<string, unknown> = {}) => ({ desks: [desk(1), desk(2)], kiosks: [], gaps: [], speeds: [speed(1, 90), speed(2, 105)], ...over });

  it('nothing for roles without the desk panel', () => {
    expect(d.paceMessages({ stats: stats({ ops: null }), nowMs: NOW, eventStartMs: START })).toEqual([]);
  });
  it('waits for 10 check-ins', () => {
    expect(d.paceMessages({ stats: stats({ checked_in: 9, ops: ops() }), nowMs: NOW, eventStartMs: START }))
      .toEqual([{ tone: 'info', text: 'Pace appears after the first 10 check-ins.' }]);
  });
  it('waits for a desk with 5 active minutes', () => {
    expect(d.paceMessages({ stats: stats({ ops: ops({ speeds: [speed(1, 90, 4)] }) }), nowMs: NOW, eventStartMs: START }))
      .toEqual([{ tone: 'info', text: 'Desk speed appears once a desk has checked people in for 5 minutes.' }]);
  });
  it('warns when arrivals stay above 90% of capacity for 10 minutes', () => {
    // capacity 6 + 7 = 13/min; 12 per minute for the last 25 minutes.
    const s = stats({ ops: ops(), last_25_min: Array(25).fill(12) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })).toEqual([
      { tone: 'warn', text: 'Arrivals (12/min) are close to what your 2 desks clear (13/min). Consider opening another desk.' },
    ]);
  });
  it('does not warn when one of the last 10 minutes was below the line', () => {
    const last = Array(25).fill(12); last[0] = 0; last[1] = 0; last[2] = 0; last[3] = 0; last[4] = 0; last[5] = 0;
    // rateAt(k = 9) covers indexes 1..15: 5 quiet minutes pull it to 8/min, under 11.7.
    expect(d.paceMessages({ stats: stats({ ops: ops(), last_25_min: last }), nowMs: NOW, eventStartMs: START })).toEqual([]);
  });
  it('an offline desk adds no capacity', () => {
    const s = stats({ ops: ops({ desks: [desk(1), desk(2, 200)] }), last_25_min: Array(25).fill(6) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0].text)
      .toBe('Arrivals (6/min) are close to what your desk clears (6/min). Consider opening another desk.');
  });
  // The warning compares the numbers it prints, so it never says "close to"
  // over a rate that reads higher than the capacity.
  it('arrivals faster than a single desk clears', () => {
    const s = stats({ ops: ops({ desks: [desk(1), desk(2, 200)] }), last_25_min: Array(25).fill(12) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0]).toEqual(
      { tone: 'warn', text: 'Arrivals (12/min) are faster than your desk clears (6/min). Open another desk.' });
  });
  it('arrivals faster than several desks clear', () => {
    const s = stats({ ops: ops(), last_25_min: Array(25).fill(14) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0]).toEqual(
      { tone: 'warn', text: 'Arrivals (14/min) are faster than your 2 desks clear (13/min). Open another desk.' });
  });
  it('equal once formatted reads close to, even when the raw rate is a little higher', () => {
    // 13.2/min against 13/min: both print as 13.
    const last = Array(25).fill(13); last[22] = 14; last[23] = 14; last[24] = 14;
    const s = stats({ ops: ops(), last_25_min: last });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0].text)
      .toBe('Arrivals (13/min) are close to what your 2 desks clear (13/min). Consider opening another desk.');
  });
  it('91% of capacity reads close to', () => {
    // 178 in 15 minutes = 11.87/min, 91% of 13/min.
    const last = Array(25).fill(12); last[23] = 11; last[24] = 11;
    const s = stats({ ops: ops(), last_25_min: last });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0].text)
      .toBe('Arrivals (12/min) are close to what your 2 desks clear (13/min). Consider opening another desk.');
  });
  it('before the start, says how long the rest will take at measured speed', () => {
    const s = stats({ registered: 131, checked_in: 45, ops: ops() });
    expect(d.paceMessages({ stats: s, nowMs: START - 60000, eventStartMs: START })).toEqual([
      { tone: 'info', text: "86 still expected. At your desks' measured speed that is about 7 minutes of check-in." },
    ]);
  });

  it('uses the server clock: a skewed device clock changes nothing', () => {
    const s = stats({ registered: 131, checked_in: 45, ops: ops(), generated_at: '2026-10-18T06:59:00Z' });
    const a = d.paceMessages({ stats: s, nowMs: START - 60000, eventStartMs: START });
    const b = d.paceMessages({ stats: s, nowMs: START + 3600000, eventStartMs: START });
    expect(b).toEqual(a);
    expect(a[0].text).toContain('86 still expected');
  });
  it('two desks with the same label stay separate', () => {
    const o = ops({ desks: [{ ...desk(1), label: 'Desk 1' }, { ...desk(2, 200), label: 'Desk 1' }],
      speeds: [{ ...speed(1, 90), label: 'Desk 1' }, { ...speed(2, 105), label: 'Desk 1' }] });
    const s = stats({ ops: o, last_25_min: Array(25).fill(6) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0].text)
      .toBe('Arrivals (6/min) are close to what your desk clears (6/min). Consider opening another desk.');
  });
});

describe('eventStartUtc', () => {
  it('is DST-correct', () => {
    expect(d.eventStartUtc('2026-10-26', '09:00:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(d.eventStartUtc('2026-11-12', '18:30', 'Africa/Cairo')!.toISOString()).toBe('2026-11-12T16:30:00.000Z');
    expect(d.eventStartUtc('2026-11-20', '09:15', 'Asia/Kolkata')!.toISOString()).toBe('2026-11-20T03:45:00.000Z');
  });
  it('is right on the day the clocks change', () => {
    expect(d.eventStartUtc('2026-10-25', '09:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(d.eventStartUtc('2026-03-29', '09:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(d.eventStartUtc('2026-10-30', '09:00', 'Africa/Cairo')!.toISOString()).toBe('2026-10-30T07:00:00.000Z');
    expect(d.eventStartUtc('2026-10-29', '09:00', 'Africa/Cairo')!.toISOString()).toBe('2026-10-29T06:00:00.000Z');
    expect(d.eventStartUtc('2026-09-27', '09:00', 'Pacific/Auckland')!.toISOString()).toBe('2026-09-26T20:00:00.000Z');
  });
  it('null for anything it cannot read', () => {
    expect(d.eventStartUtc('2026-02-31', '09:00', 'Europe/Warsaw')).toBeNull();
    expect(d.eventStartUtc('2026-10-26', 'nine', 'Europe/Warsaw')).toBeNull();
    expect(d.eventStartUtc('2026-10-26', '09:00', 'Not/AZone')).toBeNull();
  });
});
