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

export function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  if (!anchor.company) return [anchor];
  const mates = roster.filter(a =>
    a.id !== anchor.id &&
    a.company !== null &&
    a.company.toLowerCase() === anchor.company!.toLowerCase()
  );
  return [anchor, ...mates];
}
