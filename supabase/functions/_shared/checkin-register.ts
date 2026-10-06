// checkin-register.ts: rules for the public registration page
// (spec docs/superpowers/specs/2026-10-06-checkin-public-registration-design.md).
// Used by the checkin-register Edge Function and loaded by the page through
// /checkin-register.js (a copy kept equal by tests/checkin-register.spec.ts),
// so the guest sees the same verdict the server will reach. Plain
// TypeScript with no imports so vitest and the browser copy can load it.

export interface Question {
  id: string
  label: string
  type: 'text' | 'choice'
  required: boolean
  options: string[]
}

export interface RegistrationForm {
  first_name: string
  last_name: string
  email: string
  company: string
  answers: Record<string, unknown>
  consent: boolean
}

export const MAX_NAME = 80
export const MAX_EMAIL = 254
export const MAX_COMPANY = 80
export const MAX_ANSWER = 500

// Same rules as the kiosk (checkin-self-register): a name needs a letter in
// any script, email is something@something.something with no spaces.
const HAS_LETTER = /\p{L}/u
// A plain addr-spec only. Rejecting <>()[]\\,;:" stops 'x<victim@y>' and
// list-shaped strings, which a mail API would parse as a different recipient
// than the one stored and de-duplicated (security review of migration 100).
const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
// A name is printed in the guest's QR email, so nothing shaped like a link:
// no @, slash or backslash, and no domain-like 'word.tld'.
const LINKISH = /[@/\\]|[\p{L}\p{N}-]\.\p{L}{2,}/u
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{10}$/

export function isRegistrationCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_SHAPE.test(code)
}

// Returns the field codes that failed and, when there are none, the answers
// to store: one entry per question, keyed by id, with the label kept beside
// the value so a later edit to the question does not re-label old answers.
// Answers to questions that do not exist are dropped, never stored.
export function validateRegistration(
  f: RegistrationForm,
  questions: Question[],
): { errors: string[]; answers: Record<string, { label: string; value: string }> } {
  const errors: string[] = []
  const first = f.first_name.trim()
  const last = f.last_name.trim()
  const email = f.email.trim()

  if (!first) errors.push('first_name')
  else if (first.length > MAX_NAME) errors.push('first_name_too_long')
  else if (!HAS_LETTER.test(first) || LINKISH.test(first)) errors.push('first_name_invalid')

  if (!last) errors.push('last_name')
  else if (last.length > MAX_NAME) errors.push('last_name_too_long')
  else if (!HAS_LETTER.test(last) || LINKISH.test(last)) errors.push('last_name_invalid')

  if (!email) errors.push('email')
  else if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) errors.push('email_format')

  if (f.company.trim().length > MAX_COMPANY) errors.push('company_too_long')

  const answers: Record<string, { label: string; value: string }> = {}
  for (const q of questions) {
    const raw = f.answers?.[q.id]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) {
      if (q.required) errors.push('q:' + q.id)
      continue
    }
    if (value.length > MAX_ANSWER) { errors.push('q:' + q.id); continue }
    if (q.type === 'choice' && !q.options.includes(value)) { errors.push('q:' + q.id); continue }
    answers[q.id] = { label: q.label, value }
  }

  // GDPR: always required, compared to true so a truthy string is not consent.
  if (f.consent !== true) errors.push('consent')

  return { errors, answers }
}

// The short code shown on screen in test mode, same derivation as the kiosk.
export function shortCode(token: string): string {
  return token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
}

// One re-send of the QR to an address already on the list per 10 minutes,
// so the form cannot be used to mail the same person repeatedly.
export const RESEND_GAP_MS = 10 * 60 * 1000
export function mayResend(lastSentIso: string | null, nowMs: number): boolean {
  if (!lastSentIso) return true
  const t = Date.parse(lastSentIso)
  return Number.isNaN(t) || nowMs - t >= RESEND_GAP_MS
}
