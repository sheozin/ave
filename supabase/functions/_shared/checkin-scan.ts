// supabase/functions/_shared/checkin-scan.ts
// Pure scan-resolution logic for the check-in station. Mirrored by
// tests/checkin-scan.spec.ts — keep the two in sync by hand.

export type Attendee = {
  id: string; event_id: string; first_name: string; last_name: string;
  email: string | null; company: string | null; ticket_type: string;
  qr_token: string; checked_in_at: string | null;
};

export type ScanResult =
  | { kind: 'ok'; attendee: Attendee }
  | { kind: 'duplicate'; attendee: Attendee; since: string }
  | { kind: 'unknown_token' };

export function resolveToken(token: string, roster: Attendee[]): ScanResult {
  const t = token.trim();
  const found = roster.find(a => a.qr_token === t);
  if (!found) return { kind: 'unknown_token' };
  if (found.checked_in_at) return { kind: 'duplicate', attendee: found, since: found.checked_in_at };
  return { kind: 'ok', attendee: found };
}

export function searchByName(query: string, roster: Attendee[]): Attendee[] {
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

// Company is free text typed by a dozen different people, so exact
// matching splits one firm into several parties ("Acme" vs "Acme Sp. z
// o.o."). Normalising fixes that. The generic blocklist guards the
// opposite and more dangerous failure: everyone who typed "Freelance"
// would otherwise assemble into one party of strangers, each a single
// tick from being checked in.
export function normalizeCompany(raw: string | null): string | null {
  if (!raw) return null;
  let n = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
             .toLowerCase().trim().replace(/\s+/g, ' ');
  n = n.replace(/\b(sp\.?\s?z\s?o\.?\s?o\.?|s\.?a\.?|ltd|limited|llc|inc|gmbh|b\.?v\.?|oy|ab|a\/s|srl|sarl|plc|co)\b/g, '');
  n = n.replace(/[.,\-–—\s]+$/, '').replace(/\s+/g, ' ').trim();
  if (!n || GENERIC_COMPANY.has(n)) return null;
  return n;
}

export const MAX_PARTY = 8;

export function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  const key = normalizeCompany(anchor.company);
  if (!key) return [anchor];
  const mates = roster.filter(a => a.id !== anchor.id && normalizeCompany(a.company) === key);
  // A party larger than a desk can handle is almost certainly a data
  // artefact, not eight colleagues standing there. Fall back to the
  // anchor alone rather than presenting a mass check-in.
  if (mates.length + 1 > MAX_PARTY) return [anchor];
  return [anchor, ...mates];
}
