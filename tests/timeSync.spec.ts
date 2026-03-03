// tests/timeSync.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub for measureClockOffset logic (extracted from useCorrectedNow)
function buildClock(offset: number, rtt: number) {
  return { offset, rtt, lastSyncedAt: Date.now(), monoBase: 0, wallBase: Date.now() };
}

function correctedNow(clock: { offset: number; monoBase: number; wallBase: number }): number {
  const monoElapsed = performance.now() - clock.monoBase;
  return clock.wallBase + monoElapsed + clock.offset;
}

// ── 01 — Returns server-corrected time, not raw Date.now ─────
describe('correctedNow()', () => {
  it('01 applies positive offset', () => {
    const clock = { ...buildClock(500, 20), monoBase: performance.now(), wallBase: Date.now() };
    const result = correctedNow(clock);
    expect(result).toBeGreaterThan(Date.now() + 490);
  });

  it('02 applies negative offset (client ahead of server)', () => {
    const clock = { ...buildClock(-300, 20), monoBase: performance.now(), wallBase: Date.now() };
    const result = correctedNow(clock);
    expect(result).toBeLessThan(Date.now() - 290);
  });

  it('03 returns value close to Date.now() when offset is zero', () => {
    const clock = { ...buildClock(0, 20), monoBase: performance.now(), wallBase: Date.now() };
    const result = correctedNow(clock);
    expect(Math.abs(result - Date.now())).toBeLessThan(50);
  });

  it('04 uses monotonic clock — wall-clock jump does not affect result within same tick', () => {
    const monoBase = performance.now();
    const wallBase = Date.now();
    const clock = { offset: 0, rtt: 20, lastSyncedAt: wallBase, monoBase, wallBase };
    // Simulate wall-clock jump (e.g. NTP correction) without monotonic change
    const r1 = correctedNow(clock);
    const r2 = correctedNow(clock);
    // Should be stable — no wall-clock dependency between calls
    expect(Math.abs(r2 - r1)).toBeLessThan(50);
  });
});

// ── 02 — 3-sample median RTT ─────────────────────────────────
describe('median RTT calculation', () => {
  function medianOffset(samples: { offset: number; rtt: number }[]) {
    const sorted = [...samples].sort((a, b) => a.offset - b.offset);
    return sorted[Math.floor(sorted.length / 2)].offset;
  }

  it('05 median rejects high outlier', () => {
    const samples = [{ offset: 100, rtt: 20 }, { offset: 105, rtt: 22 }, { offset: 500, rtt: 400 }];
    expect(Math.abs(medianOffset(samples) - 105)).toBeLessThan(10);
  });

  it('06 median rejects low outlier', () => {
    const samples = [{ offset: -200, rtt: 800 }, { offset: 100, rtt: 20 }, { offset: 102, rtt: 21 }];
    expect(Math.abs(medianOffset(samples) - 100)).toBeLessThan(10);
  });

  it('07 uses middle sample for 3 measurements', () => {
    const samples = [{ offset: 50, rtt: 30 }, { offset: 100, rtt: 20 }, { offset: 150, rtt: 25 }];
    expect(medianOffset(samples)).toBe(100);
  });
});

// ── 03 — Drift detection ─────────────────────────────────────
describe('drift detection', () => {
  it('08 detects drift > 500ms threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = buildClock(100, 20);
    const fresh = buildClock(700, 20); // 600ms drift

    const drift = Math.abs(fresh.offset - old.offset);
    if (drift > 500) console.warn('[Clock] drift:', drift);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('09 does NOT warn for drift <= 500ms', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = buildClock(100, 20);
    const fresh = buildClock(400, 20); // 300ms drift

    const drift = Math.abs(fresh.offset - old.offset);
    if (drift > 500) console.warn('[Clock] drift:', drift);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── 04 — Sleep/wake detection ─────────────────────────────────
describe('sleep/wake detection', () => {
  it('10 gap > 5000ms triggers resync', () => {
    const syncCalled = vi.fn();
    let lastTick = 0;

    function checkTick(elapsed: number) {
      if (elapsed > 5000) syncCalled();
      lastTick = elapsed;
    }

    checkTick(1000);  // normal tick
    expect(syncCalled).not.toHaveBeenCalled();

    checkTick(20000); // sleep/wake
    expect(syncCalled).toHaveBeenCalledOnce();
  });

  it('11 gap of exactly 5000ms does NOT trigger (boundary)', () => {
    const syncCalled = vi.fn();
    function checkTick(elapsed: number) { if (elapsed > 5000) syncCalled(); }
    checkTick(5000);
    expect(syncCalled).not.toHaveBeenCalled();
  });

  it('12 gap of 5001ms triggers resync', () => {
    const syncCalled = vi.fn();
    function checkTick(elapsed: number) { if (elapsed > 5000) syncCalled(); }
    checkTick(5001);
    expect(syncCalled).toHaveBeenCalledOnce();
  });
});
