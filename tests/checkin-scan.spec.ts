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

const GENERIC_COMPANY = new Set([
  'freelance', 'freelancer', 'self employed', 'selfemployed', 'self',
  'n/a', 'na', 'none', 'nil', 'student', 'private', 'individual',
  'unemployed', 'retired', 'me', 'myself', 'guest', 'visitor', 'other',
]);

function normalizeCompany(raw: string | null): string | null {
  if (!raw) return null;
  let n = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
             .toLowerCase().trim().replace(/\s+/g, ' ');
  n = n.replace(/\b(sp\.?\s?z\s?o\.?\s?o\.?|s\.?a\.?|ltd|limited|llc|inc|gmbh|b\.?v\.?|oy|ab|a\/s|srl|sarl|plc|co)\b/g, '');
  n = n.replace(/[.,\-–—\s]+$/, '').replace(/\s+/g, ' ').trim();
  if (!n || GENERIC_COMPANY.has(n)) return null;
  return n;
}

const MAX_PARTY = 8;

function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  const key = normalizeCompany(anchor.company);
  if (!key) return [anchor];
  const mates = roster.filter(a => a.id !== anchor.id && normalizeCompany(a.company) === key);
  if (mates.length + 1 > MAX_PARTY) return [anchor];
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

describe('checkin-scan: normalizeCompany', () => {
  it('collapses the legal-form spellings of one firm onto one key', () => {
    const key = normalizeCompany('Acme');
    expect(normalizeCompany('Acme Sp. z o.o.')).toBe(key);
    expect(normalizeCompany('ACME Ltd')).toBe(key);
    expect(normalizeCompany('  acme   ')).toBe(key);
    expect(normalizeCompany('Acme S.A.')).toBe(key);
  });

  it('strips diacritics so one firm is not split by keyboard layout', () => {
    expect(normalizeCompany('Żabka')).toBe(normalizeCompany('Zabka'));
  });

  it('treats generic free-text answers as no company at all', () => {
    expect(normalizeCompany('Freelance')).toBeNull();
    expect(normalizeCompany('self employed')).toBeNull();
    expect(normalizeCompany('N/A')).toBeNull();
    expect(normalizeCompany('Student')).toBeNull();
  });

  it('returns null for a value that normalises away to nothing', () => {
    expect(normalizeCompany('Ltd')).toBeNull();
    expect(normalizeCompany('---')).toBeNull();
    expect(normalizeCompany('   ')).toBeNull();
  });

  it('keeps two genuinely different firms apart', () => {
    expect(normalizeCompany('Orange')).not.toBe(normalizeCompany('Orange Events'));
  });
});

describe('checkin-scan: assembleParty normalisation and safety cap', () => {
  it('groups a firm written three different ways into one party', () => {
    const roster = [
      mk({ id: '1', company: 'Acme' }),
      mk({ id: '2', company: 'Acme Sp. z o.o.' }),
      mk({ id: '3', company: 'ACME Ltd' }),
      mk({ id: '4', company: 'Rivo' }),
    ];
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1', '2', '3']);
  });

  // The dangerous direction: without the blocklist every freelancer at
  // the event would assemble into one party of strangers, each of them a
  // single tick away from being checked in.
  it('never assembles a party out of people who typed a generic company', () => {
    const roster = [
      mk({ id: '1', company: 'Freelance' }),
      mk({ id: '2', company: 'freelance' }),
      mk({ id: '3', company: 'Self employed' }),
      mk({ id: '4', company: 'n/a' }),
    ];
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1']);
    expect(assembleParty(roster[2], roster).map(a => a.id)).toEqual(['3']);
  });

  it('returns a party of one when the company normalises to empty', () => {
    const roster = [mk({ id: '1', company: 'Ltd' }), mk({ id: '2', company: 'Ltd' })];
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1']);
  });

  it('falls back to the anchor alone when the group exceeds MAX_PARTY', () => {
    const roster = Array.from({ length: MAX_PARTY + 1 }, (_, i) =>
      mk({ id: String(i + 1), company: 'Bigcorp' }));
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1']);
  });

  it('still assembles a group sitting exactly on MAX_PARTY', () => {
    const roster = Array.from({ length: MAX_PARTY }, (_, i) =>
      mk({ id: String(i + 1), company: 'Bigcorp' }));
    expect(assembleParty(roster[0], roster)).toHaveLength(MAX_PARTY);
  });
});
