// tests/checkin-forecast.spec.ts: the staffing plan and the plan line.
import { describe, it, expect } from 'vitest';
import { historyProfile, expectedSlots, staffSlots, planAdvice, buildPlan, planVsActual, SLOT_MS } from '../checkin-forecast.js';

const TZ = 'Europe/Warsaw';
const START = Date.parse('2026-12-09T08:00:00Z');   // 09:00 in Warsaw

describe('historyProfile', () => {
  it('says nothing without a past event of at least 30 check-ins', () => {
    expect(historyProfile([])).toBeNull();
    expect(historyProfile([{ name: 'Small', date: '2026-03-11', registered: 5, checked_in: 1, buckets: [{ o: 0, n: 1 }], desk_busiest: [] }])).toBeNull();
  });
  it('averages arrival shares, pools turnout, and takes speed from busy desks only', () => {
    const p = historyProfile([
      { name: 'A', date: '2026-05-01', registered: 100, checked_in: 80, buckets: [{ o: -2, n: 40 }, { o: -1, n: 40 }], desk_busiest: [45, 30, 4] },
      { name: 'B', date: '2026-04-01', registered: 100, checked_in: 60, buckets: [{ o: -1, n: 30 }, { o: 0, n: 24 }, { o: 900, n: 6 }], desk_busiest: [] },
    ]);
    expect(p.turnoutPct).toBe(70);
    // 900 s / 45 = 20 s, 900 / 30 = 30 s; the desk with 4 was idle, not slow.
    expect(p.secondsPerGuest).toBe(25);
    // A: -2 .5, -1 .5. B: -1 .5, 0 .4 (the 6 arrivals days later count against the shares).
    expect(p.shape).toEqual([[-2, 0.25], [-1, 0.5], [0, 0.2]]);
    expect(p.events.map(e => e.name)).toEqual(['A', 'B']);
  });
  it('gives no speed when no desk was ever busy', () => {
    expect(historyProfile([{ name: 'A', date: '2026-05-01', registered: 50, checked_in: 40, buckets: [{ o: 0, n: 40 }], desk_busiest: [8] }]).secondsPerGuest).toBeNull();
  });
});

describe('expectedSlots', () => {
  it('spreads the expected guests evenly over the window', () => {
    const s = expectedSlots({ registered: 400, turnoutPct: 75, beforeMin: 60, afterMin: 30, startMs: START });
    expect(s).toHaveLength(6);
    expect(s[0].t).toBe(START - 4 * SLOT_MS);
    expect(s.every(x => x.expected === 50)).toBe(true);
  });
  it('follows a shape, filling slots it skips with zero', () => {
    const s = expectedSlots({ registered: 200, turnoutPct: 50, shape: [[-2, 0.5], [0, 0.5]], startMs: START });
    expect(s.map(x => x.expected)).toEqual([50, 0, 50]);
  });
  it('is empty with nothing to plan', () => {
    expect(expectedSlots({ registered: 0, turnoutPct: 80, beforeMin: 60, afterMin: 0, startMs: START })).toEqual([]);
  });
});

describe('staffSlots', () => {
  it('picks the fewest desks that keep the wait under 5 minutes, carrying the line', () => {
    // 20 s a guest = 3 a minute = 45 per desk per slot.
    const s = staffSlots([{ t: 0, expected: 40 }, { t: 1, expected: 100 }, { t: 2, expected: 10 }, { t: 3, expected: 0 }], 20);
    // The second desk stays a second slot; the last slot needs none.
    expect(s.map(x => x.desks)).toEqual([1, 2, 2, 0]);
    // 100 against 2 desks leaves 10 in line, 10 / 6 a minute: under 2 minutes.
    expect(s[1].waitMin).toBeCloseTo(10 / 6);
    expect(s.some(x => x.over)).toBe(false);
  });
  it('flags a plan no number of desks can meet', () => {
    expect(staffSlots([{ t: 0, expected: 5000 }], 60)[0].over).toBe(true);
  });
});

describe('planAdvice and buildPlan', () => {
  it('opens, adds desks at the peak, steps down, and says when arrivals end', () => {
    const s = staffSlots([40, 100, 10, 10].map((e, i) => ({ t: START + i * SLOT_MS, expected: e })), 20);
    expect(s.map(x => x.desks)).toEqual([1, 2, 2, 1]);
    expect(planAdvice(s, TZ).map(a => a.title)).toEqual(['Open with 1 desk', 'Open 1 more, 2 desks in all', 'Down to 1 desk', 'Arrivals end']);
    expect(planAdvice(s, TZ)[1].detail).toBe('Busiest 15 minutes from 09:15: about 100 guests.');
    expect(planAdvice(s, TZ)[3].detail).toBe('The plan expects everyone by 10:00.');
  });
  it('closes the desks in a gap and says when the next guests come', () => {
    const s = staffSlots([30, 0, 30].map((e, i) => ({ t: START + i * SLOT_MS, expected: e })), 20);
    expect(planAdvice(s, TZ)[1]).toMatchObject({ title: 'Close the desks for now', detail: 'The line should be clear. The next guests are expected from 09:30.' });
  });
  it('builds from saved inputs and is null without guests', () => {
    const p = buildPlan({ turnout_pct: 75, seconds_per_guest: 20, before_min: 60, after_min: 30 }, 400, START, TZ);
    expect(p.expectedTotal).toBe(300);
    expect(p.peakDesks).toBe(2);
    // 50 a slot against one desk's 45: the line grows 5 a slot until a
    // second desk is needed at 09:00, and it then stays 30 minutes.
    expect(p.staffed.map(x => x.desks)).toEqual([1, 1, 1, 2, 2, 1]);
    expect(p.advice.map(a => a.title)).toEqual(['Open with 1 desk', 'Open 1 more, 2 desks in all', 'Down to 1 desk', 'Arrivals end']);
    // An even spread has no busiest slot to name.
    expect(p.advice[0].detail).toBe('About 50 guests every 15 minutes.');
    expect(buildPlan({ turnout_pct: 75, seconds_per_guest: 20, before_min: 60, after_min: 30 }, 0, START, TZ)).toBeNull();
    expect(buildPlan(null, 400, START, TZ)).toBeNull();
  });
});

describe('planVsActual', () => {
  it('lines the plan up with real 15-minute bars and compares only slots that ended', () => {
    const staffed = [0, 1, 2].map(i => ({ t: START + i * SLOT_MS, expected: 20, desks: 1 }));
    const arrivals = [{ t: START / 1000, n: 12 }, { t: (START + SLOT_MS) / 1000, n: 30 }, { t: (START + 2 * SLOT_MS) / 1000, n: 5 }];
    const v = planVsActual(staffed, arrivals, START + 2 * SLOT_MS + 60000, TZ);
    expect(v.labels).toEqual(['09:00', '09:15', '09:30']);
    expect(v.plan).toEqual([20, 20, 20]);
    expect(v.actual).toEqual([12, 30, 5]);
    expect(v.expectedByNow).toBe(40);
    expect(v.arrivedByNow).toBe(42);
  });
  it('leaves future bars empty', () => {
    const v = planVsActual([{ t: START, expected: 10 }, { t: START + SLOT_MS, expected: 10 }], [], START + 60000, TZ);
    expect(v.actual).toEqual([0, null]);
    expect(v.expectedByNow).toBe(0);
  });
});
