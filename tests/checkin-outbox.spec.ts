// tests/checkin-outbox.spec.ts
// Offline outbox for the check-in station: queueing, ordering, and
// replay after reconnect. Mirrored in cuedeck-checkin.html.
// Both are replayed in scanned_at order and the server applies them
// sequentially, so a checkin followed by an undo nets out correctly
// without any client-side collapsing.
import { describe, it, expect } from 'vitest';

type Pending = {
  client_id: string; attendee_id: string;
  // scanned_at MUST be canonical UTC ISO-8601 from Date#toISOString()
  // (always 'Z', fixed width). Ordering compares these as strings, so a
  // mixed offset like +02:00 would sort wrong.
  scanned_at: string;
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
    .sort((a, b) => (a.scanned_at < b.scanned_at ? -1 : a.scanned_at > b.scanned_at ? 1 : 0));
}

function markSynced(outbox: Pending[], ids: string[]): Pending[] {
  const s = new Set(ids);
  return outbox.map(p => (s.has(p.client_id) ? { ...p, synced: true } : p));
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

  it('orders across different attendees, not just one', () => {
    const ob = [
      mk({ client_id: 'b', attendee_id: 'a2', scanned_at: '2026-08-03T09:05:00Z' }),
      mk({ client_id: 'a', attendee_id: 'a1', scanned_at: '2026-08-03T09:01:00Z' }),
      mk({ client_id: 'c', attendee_id: 'a3', scanned_at: '2026-08-03T09:09:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a checkin and its later undo in order for replay', () => {
    const ob = [
      mk({ client_id: 'c2', action: 'undo', scanned_at: '2026-08-03T09:01:00Z' }),
      mk({ client_id: 'c1', action: 'checkin', scanned_at: '2026-08-03T09:00:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.action)).toEqual(['checkin', 'undo']);
  });
});
