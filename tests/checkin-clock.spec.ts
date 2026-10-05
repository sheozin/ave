// tests/checkin-clock.spec.ts
// The desk's clock correction. scanned_at decides arrival order and the
// live window, and the server refuses a live check-in stamped more than
// 5 minutes ahead of its own clock, so a desk with a fast clock would be
// refused all day without this.
import { describe, it, expect } from 'vitest';
import * as c from '../checkin-clock.js';

describe('bestOffset', () => {
  it('takes the sample with the smallest round trip, corrected by half of it', () => {
    // server time is read at the midpoint of the round trip
    const samples = [
      { sentAt: 1000, receivedAt: 1400, serverMs: 61200 },   // rtt 400 -> offset 61200 - 1200 = 60000
      { sentAt: 2000, receivedAt: 2100, serverMs: 62049 },   // rtt 100 -> offset 62049 - 2050 = 59999
    ];
    expect(c.bestOffset(samples)).toEqual({ offsetMs: 59999, rttMs: 100 });
  });
  it('ignores unusable samples and returns null when none is left', () => {
    expect(c.bestOffset([])).toBeNull();
    expect(c.bestOffset([{ sentAt: 5, receivedAt: 4, serverMs: 10 }, { sentAt: 0, receivedAt: 10, serverMs: NaN }])).toBeNull();
  });
  it('a round trip over 10 seconds is too slow to trust', () => {
    expect(c.bestOffset([{ sentAt: 0, receivedAt: 10001, serverMs: 5000 }])).toBeNull();
  });
});

describe('correctedIso', () => {
  it('applies the offset and keeps canonical UTC ISO', () => {
    expect(c.correctedIso(Date.UTC(2026, 9, 18, 8, 0, 0), 90000)).toBe('2026-10-18T08:01:30.000Z');
  });
  it('no offset yet means the device clock', () => {
    expect(c.correctedIso(Date.UTC(2026, 9, 18, 8, 0, 0), null)).toBe('2026-10-18T08:00:00.000Z');
  });
});

describe('skewNotice', () => {
  it('stays quiet within a minute', () => {
    expect(c.skewNotice(59000)).toBe('');
    expect(c.skewNotice(-59000)).toBe('');
    expect(c.skewNotice(null)).toBe('');
  });
  it('says which way and by how much, and that times are corrected', () => {
    expect(c.skewNotice(-7 * 60000)).toBe("This device's clock is 7 minutes fast. Check-in times use the server's clock instead.");
    expect(c.skewNotice(2 * 3600000 + 60000)).toBe("This device's clock is 2 hours 1 minute slow. Check-in times use the server's clock instead.");
  });
});
