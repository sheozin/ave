// checkin-email-log.ts: record a check-in email Resend accepted, so its
// delivery can be followed (migration 150, checkin-email-status). Best
// effort: the email has already left, so a failed record is logged, never
// thrown.
// deno-lint-ignore no-explicit-any
type Client = any

export async function logCheckinEmail(sb: Client, row: {
  event_id: string; kind: 'qr' | 'guest_invite' | 'staff_invite'; resend_id?: string | null;
  attendee_id?: string | null; user_id?: string | null;
}): Promise<void> {
  if (!row.resend_id || !row.event_id || (!row.attendee_id && !row.user_id)) return
  const { error } = await sb.from('leod_checkin_emails').insert({
    event_id: row.event_id, kind: row.kind, resend_id: row.resend_id,
    attendee_id: row.attendee_id ?? null, user_id: row.user_id ?? null,
  })
  if (error) console.error('checkin-email-log: not recorded', row.kind, error.code)
}
