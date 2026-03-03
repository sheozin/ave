// tests/delayPropagation.spec.ts
import { describe, it, expect } from 'vitest';

type Status = 'PLANNED'|'READY'|'CALLING'|'LIVE'|'OVERRUN'|'HOLD'|'ENDED'|'CANCELLED';
type Policy = 'CASCADE'|'ABSORB'|'ANCHOR';

interface Session {
  id: string; sort_order: number; status: Status;
  scheduled_start: string; scheduled_end: string;
  cumulative_delay: number; delay_minutes: number;
  is_anchor: boolean; shift_policy: Policy;
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number); return h * 60 + m;
}
function fromMin(n: number): string {
  const h = Math.floor(n / 60); const m = n % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function addMin(t: string, d: number): string { return fromMin(toMin(t) + d); }

function applyDelay(sessions: Session[], sourceId: string, minutes: number): Session[] {
  const result = sessions.map(s => ({ ...s }));
  const sourceIdx = result.findIndex(s => s.id === sourceId);
  if (sourceIdx < 0) throw new Error('source not found');

  // Find cascade boundary: first ANCHOR after source
  let boundary = result.length;
  for (let j = sourceIdx + 1; j < result.length; j++) {
    if (result[j].is_anchor || result[j].shift_policy === 'ANCHOR') { boundary = j; break; }
  }

  for (let i = sourceIdx; i < boundary; i++) {
    const s = result[i];
    if (s.status === 'ENDED' || s.status === 'CANCELLED') continue;
    s.scheduled_start  = addMin(s.scheduled_start, minutes);
    s.scheduled_end    = addMin(s.scheduled_end,   minutes);
    s.cumulative_delay = s.cumulative_delay + minutes;
    if (i === sourceIdx) s.delay_minutes = s.delay_minutes + minutes;
    if (i === sourceIdx && s.status === 'LIVE') s.status = 'OVERRUN';
  }

  return result;
}

function makeSession(overrides: Partial<Session> & { id: string; sort_order: number }): Session {
  return {
    status: 'PLANNED', scheduled_start: '09:00', scheduled_end: '09:45',
    cumulative_delay: 0, delay_minutes: 0, is_anchor: false, shift_policy: 'CASCADE',
    ...overrides,
  };
}

describe('Delay Propagation', () => {

  it('01 basic cascade: 3 downstream sessions all shift', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
      makeSession({ id:'s2', sort_order:2, scheduled_start:'09:45', scheduled_end:'10:00' }),
      makeSession({ id:'s3', sort_order:3, scheduled_start:'10:00', scheduled_end:'11:00' }),
    ];
    const result = applyDelay(sessions, 's1', 10);
    expect(result[0].scheduled_start).toBe('09:10');
    expect(result[1].scheduled_start).toBe('09:55');
    expect(result[2].scheduled_start).toBe('10:10');
  });

  it('02 anchor stops cascade at boundary', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
      makeSession({ id:'s2', sort_order:2, scheduled_start:'09:45', scheduled_end:'10:00' }),
      makeSession({ id:'s3', sort_order:3, scheduled_start:'10:00', scheduled_end:'11:00', is_anchor: true }),
      makeSession({ id:'s4', sort_order:4, scheduled_start:'11:00', scheduled_end:'12:00' }),
    ];
    const result = applyDelay(sessions, 's1', 8);
    expect(result[0].scheduled_start).toBe('09:08');
    expect(result[1].scheduled_start).toBe('09:53');
    // s3 is anchor: should NOT shift
    expect(result[2].scheduled_start).toBe('10:00');
    // s4 after anchor: should NOT shift
    expect(result[3].scheduled_start).toBe('11:00');
  });

  it('03 shift_policy ANCHOR on session (not is_anchor flag) also stops cascade', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
      makeSession({ id:'s2', sort_order:2, shift_policy:'ANCHOR', scheduled_start:'09:45', scheduled_end:'10:00' }),
    ];
    const result = applyDelay(sessions, 's1', 5);
    expect(result[0].cumulative_delay).toBe(5);
    // s2 is the anchor — stops cascade at boundary j=1, so s2 does NOT shift
    expect(result[1].scheduled_start).toBe('09:45');
  });

  it('04 ENDED sessions are skipped in cascade', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:30' }),
      makeSession({ id:'s2', sort_order:2, status:'ENDED', scheduled_start:'09:30', scheduled_end:'09:45' }),
      makeSession({ id:'s3', sort_order:3, scheduled_start:'09:45', scheduled_end:'10:30' }),
    ];
    const result = applyDelay(sessions, 's1', 10);
    // s2 ENDED — not shifted
    expect(result[1].scheduled_start).toBe('09:30');
    expect(result[1].cumulative_delay).toBe(0);
    // s3 is shifted
    expect(result[2].scheduled_start).toBe('09:55');
  });

  it('05 CANCELLED sessions are skipped in cascade', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:30' }),
      makeSession({ id:'s2', sort_order:2, status:'CANCELLED', scheduled_start:'09:30', scheduled_end:'09:45' }),
      makeSession({ id:'s3', sort_order:3, scheduled_start:'09:45', scheduled_end:'10:30' }),
    ];
    const result = applyDelay(sessions, 's1', 10);
    expect(result[1].cumulative_delay).toBe(0);
    expect(result[2].scheduled_start).toBe('09:55');
  });

  it('06 cumulative_delay accumulates across multiple delays', () => {
    let sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
    ];
    sessions = applyDelay(sessions, 's1', 5);
    sessions = applyDelay(sessions, 's1', 8);
    expect(sessions[0].cumulative_delay).toBe(13);
    expect(sessions[0].delay_minutes).toBe(13);
  });

  it('07 source session LIVE transitions to OVERRUN on delay', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
    ];
    const result = applyDelay(sessions, 's1', 5);
    expect(result[0].status).toBe('OVERRUN');
  });

  it('08 source session in READY does NOT transition to OVERRUN on delay', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'READY', scheduled_start:'09:00', scheduled_end:'09:45' }),
    ];
    const result = applyDelay(sessions, 's1', 5);
    expect(result[0].status).toBe('READY');
  });

  it('09 delay_minutes updated only on source, not downstream', () => {
    const sessions = [
      makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:30' }),
      makeSession({ id:'s2', sort_order:2, scheduled_start:'09:30', scheduled_end:'10:00' }),
    ];
    const result = applyDelay(sessions, 's1', 10);
    expect(result[0].delay_minutes).toBe(10); // source: updated
    expect(result[1].delay_minutes).toBe(0);  // downstream: NOT updated
    expect(result[1].cumulative_delay).toBe(10); // downstream: cumulative updated
  });

  it('10 planned_start is NOT modified (immutable)', () => {
    interface FullSession extends Session { planned_start: string; planned_end: string; }
    const sessions: FullSession[] = [{
      ...makeSession({ id:'s1', sort_order:1, status:'LIVE', scheduled_start:'09:00', scheduled_end:'09:45' }),
      planned_start: '09:00', planned_end: '09:45',
    }];
    const result = applyDelay(sessions, 's1', 10) as FullSession[];
    expect(result[0].planned_start).toBe('09:00'); // unchanged
    expect(result[0].scheduled_start).toBe('09:10'); // shifted
  });
});
