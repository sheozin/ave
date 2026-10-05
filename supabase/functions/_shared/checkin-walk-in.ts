// supabase/functions/_shared/checkin-walk-in.ts
// Validation for a desk walk-in (roles ruling 7). Pure, so vitest can
// import it; tests/checkin-walk-in.spec.ts.

export type WalkIn = {
  first_name: string
  last_name: string
  email: string | null
  company: string | null
  ticket_type: string
}

// C0 controls, DEL, C1 controls and the bidi marks and overrides: the same
// set the desk strips (WALKIN_CONTROL in cuedeck-checkin.html). A name ends
// up on badges, exports and other people's screens, where a right-to-left
// override would make it read as something else. The desk is not the only
// possible caller, so the server strips them too.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\t\n\r]/g, ' ').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim() : '')

export function normalizeWalkIn(body: Record<string, unknown>): { ok: true; row: WalkIn } | { ok: false; error: string } {
  const first = clean(body.first_name)
  const last = clean(body.last_name)
  if (!first || !last) return { ok: false, error: 'First and last name are required' }
  if (first.length > 120 || last.length > 120) return { ok: false, error: 'A name is too long' }
  const email = clean(body.email)
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return { ok: false, error: 'That email address does not look right' }
  }
  const company = clean(body.company)
  if (company.length > 200) return { ok: false, error: 'The company name is too long' }
  const ticket = clean(body.ticket_type) || 'attendee'
  if (ticket.length > 60) return { ok: false, error: 'The ticket type is too long' }
  return { ok: true, row: { first_name: first, last_name: last, email: email || null, company: company || null, ticket_type: ticket } }
}
