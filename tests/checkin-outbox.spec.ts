// tests/checkin-outbox.spec.ts
// Offline outbox for the check-in station: queueing, ordering, and
// replay after reconnect. Mirrored in cuedeck-checkin.html.
import { describe, it, expect } from 'vitest';

type Pending = {
  client_id: string; attendee_id: string; scanned_at: string;
  action: 'checkin' | 'undo'; synced: boolean;
};

function enqueue(outbox: Pending[], item: Omit<Pending, 'synced'>): Pending[] {
  if (outbox.some(p => p.client_id === item.client_id)) return outbox;
  return [...outbox, { ...item, synced: false }];
}

function pendingCount(outbox: Pending[]): number {
  return outbox.filter(p => !p.synced).length;
}

function replayOrder(outbox: Pending[]): Pending[] {
  return outbox
    .filter(p => !p.synced)
    .slice()
    .sort((a, b) => a.scanned_at.localeCompare(b.scanned_at));
}

function markSynced(outbox: Pending[], ids: string[]): Pending[] {
  const s = new Set(ids);
  return outbox.map(p => (s.has(p.client_id) ? { ...p, synced: true } : p));
}

function collapse(outbox: Pending[]): Pending[] {
  const last = new Map<string, Pending>();
  for (const p of replayOrder(outbox)) last.set(p.attendee_id, p);
  return [...last.values()];
}

const mk = (o: Partial<Pending> & { client_id: string }): Pending => ({
  attendee_id: 'a1', scanned_at: '2026-08-03T09:00:00Z',
  action: 'checkin', synced: false, ...o,
});

describe('checkin-outbox', () => {
  it('ignores a re-enqueued client_id so a double tap queues once', () => {
    let ob: Pending[] = [];
    ob = enqueue(ob, mk({ client_id: 'c1' }));
    ob = enqueue(ob, mk({ client_id: 'c1' }));
    expect(ob).toHaveLength(1);
  });

  it('counts only unsynced items', () => {
    const ob = [mk({ client_id: 'c1', synced: true }), mk({ client_id: 'c2' })];
    expect(pendingCount(ob)).toBe(1);
  });

  it('replays in scanned_at order, not insertion order', () => {
    const ob = [
      mk({ client_id: 'late', scanned_at: '2026-08-03T09:05:00Z' }),
      mk({ client_id: 'early', scanned_at: '2026-08-03T09:01:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['early', 'late']);
  });

  it('survives a partial sync — unsynced items remain queued', () => {
    let ob = [mk({ client_id: 'c1' }), mk({ client_id: 'c2' })];
    ob = markSynced(ob, ['c1']);
    expect(pendingCount(ob)).toBe(1);
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['c2']);
  });

  it('collapses check-in then undo for one attendee to the undo', () => {
    const ob = [
      mk({ client_id: 'c1', attendee_id: 'a1', action: 'checkin', scanned_at: '2026-08-03T09:00:00Z' }),
      mk({ client_id: 'c2', attendee_id: 'a1', action: 'undo', scanned_at: '2026-08-03T09:01:00Z' }),
    ];
    const c = collapse(ob);
    expect(c).toHaveLength(1);
    expect(c[0].action).toBe('undo');
  });
});
