// tests/checkin-scan.spec.ts
// Check-in station scan resolution and party assembly. Following this
// repo's convention (see tests/checkin-import.spec.ts): Deno Edge
// Functions aren't importable into vitest, so the logic is re-expressed
// here and kept in sync by a human diffing it against
// supabase/functions/_shared/checkin-scan.ts.
import { describe, it, expect } from 'vitest';

type Attendee = {
  id: string; event_id: string; first_name: string; last_name: string;
  email: string | null; company: string | null; ticket_type: string;
  qr_token: string; checked_in_at: string | null;
};

type ScanResult =
  | { kind: 'ok'; attendee: Attendee }
  | { kind: 'duplicate'; attendee: Attendee; since: string }
  | { kind: 'unknown_token' };

function resolveToken(token: string, roster: Attendee[]): ScanResult {
  const t = token.trim();
  const found = roster.find(a => a.qr_token === t);
  if (!found) return { kind: 'unknown_token' };
  if (found.checked_in_at) return { kind: 'duplicate', attendee: found, since: found.checked_in_at };
  return { kind: 'ok', attendee: found };
}

function searchByName(query: string, roster: Attendee[]): Attendee[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return roster.filter(a =>
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
    (a.email ?? '').toLowerCase().includes(q) ||
    (a.company ?? '').toLowerCase().includes(q)
  );
}

function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  if (!anchor.company) return [anchor];
  const mates = roster.filter(a =>
    a.id !== anchor.id &&
    a.company !== null &&
    a.company.toLowerCase() === anchor.company!.toLowerCase()
  );
  return [anchor, ...mates];
}

const mk = (o: Partial<Attendee> & { id: string }): Attendee => ({
  event_id: 'e1', first_name: 'A', last_name: 'B', email: null, company: null,
  ticket_type: 'attendee', qr_token: 'tok-' + o.id, checked_in_at: null, ...o,
});

describe('checkin-scan: resolveToken', () => {
  const roster = [
    mk({ id: '1', qr_token: 'AAA', first_name: 'Anna', last_name: 'Kowalska' }),
    mk({ id: '2', qr_token: 'BBB', checked_in_at: '2026-08-03T09:02:00Z' }),
  ];

  it('returns ok for a valid unused token', () => {
    expect(resolveToken('AAA', roster).kind).toBe('ok');
  });

  it('trims surrounding whitespace from scanner input', () => {
    expect(resolveToken('  AAA \n', roster).kind).toBe('ok');
  });

  it('returns duplicate with the original time when already checked in', () => {
    const r = resolveToken('BBB', roster);
    expect(r.kind).toBe('duplicate');
    if (r.kind === 'duplicate') expect(r.since).toBe('2026-08-03T09:02:00Z');
  });

  it('returns unknown_token for a code not on this roster', () => {
    expect(resolveToken('ZZZ', roster).kind).toBe('unknown_token');
  });
});

describe('checkin-scan: searchByName', () => {
  const roster = [
    mk({ id: '1', first_name: 'Anna', last_name: 'Kowalska', company: 'Acme', email: 'anna@acme.pl' }),
    mk({ id: '2', first_name: 'Adam', last_name: 'Kowal', company: 'Rivo' }),
  ];

  it('ignores queries shorter than two characters', () => {
    expect(searchByName('a', roster)).toHaveLength(0);
  });

  it('matches on partial surname, case-insensitively', () => {
    expect(searchByName('kowal', roster)).toHaveLength(2);
  });

  it('matches on email and company too', () => {
    expect(searchByName('acme', roster)).toHaveLength(1);
    expect(searchByName('anna@', roster)).toHaveLength(1);
  });
});

describe('checkin-scan: assembleParty', () => {
  const roster = [
    mk({ id: '1', company: 'Acme' }),
    mk({ id: '2', company: 'acme' }),
    mk({ id: '3', company: 'Rivo' }),
    mk({ id: '4', company: null }),
  ];

  it('groups colleagues case-insensitively, anchor first', () => {
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1', '2']);
  });

  it('returns a party of one when the attendee has no company', () => {
    expect(assembleParty(roster[3], roster).map(a => a.id)).toEqual(['4']);
  });
});
