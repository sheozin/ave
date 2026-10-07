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
// Tested after NFKC, so full-width ＠ ／ ． fold to their ASCII forms;
// the ideographic full stops are listed because NFKC keeps them.
const LINKISH = /[@/\\]|[\p{L}\p{N}-][.。｡]\p{L}{2,}/u
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{10}$/

// What is stored and printed for a typed name or company: NFKC (full-width
// look-alikes folded), format characters removed (zero-width spaces and
// bidi controls, which hid a 'word.tld' from the link check), whitespace
// collapsed. Validation runs on this same value.
export function cleanText(s: string): string {
  return s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
}

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
  const first = cleanText(f.first_name)
  const last = cleanText(f.last_name)
  const email = f.email.trim()

  if (!first) errors.push('first_name')
  else if (first.length > MAX_NAME) errors.push('first_name_too_long')
  else if (!HAS_LETTER.test(first) || LINKISH.test(first)) errors.push('first_name_invalid')

  if (!last) errors.push('last_name')
  else if (last.length > MAX_NAME) errors.push('last_name_too_long')
  else if (!HAS_LETTER.test(last) || LINKISH.test(last)) errors.push('last_name_invalid')

  if (!email) errors.push('email')
  else if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) errors.push('email_format')

  if (cleanText(f.company).length > MAX_COMPANY) errors.push('company_too_long')

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

// Plus-ones (migration 114): at most `max` people, each a first and last
// name under the same rules as the guest's own. A row left wholly empty is
// dropped (the guest added a row and changed their mind). Codes are
// 'plus:<index>' for the row that failed.
export function validatePlusOnes(
  list: unknown, max: number,
): { errors: string[]; names: { first_name: string; last_name: string }[] } {
  const errors: string[] = []
  const names: { first_name: string; last_name: string }[] = []
  const rows = Array.isArray(list) ? list : []
  rows.forEach((r, i) => {
    const o = r && typeof r === 'object' ? r as Record<string, unknown> : {}
    const first = cleanText(typeof o.first_name === 'string' ? o.first_name : '')
    const last = cleanText(typeof o.last_name === 'string' ? o.last_name : '')
    if (!first && !last) return
    const ok = (s: string) => s && s.length <= MAX_NAME && HAS_LETTER.test(s) && !LINKISH.test(s)
    if (!ok(first) || !ok(last)) errors.push('plus:' + i)
    else names.push({ first_name: first, last_name: last })
  })
  if (names.length > Math.max(0, max)) errors.push('plus_too_many')
  return { errors, names }
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

// An IPv6 client is keyed by its /64: one connection usually holds a whole
// /64, so keying the full address would let it rotate past the limit. An
// IPv4-mapped address (::ffff:a.b.c.d) is keyed as the IPv4 address.
// Anything that is not a well-formed address is refused (null).
export function clientKey(raw: string): string | null {
  const ip = raw.trim().toLowerCase().replace(/%.*$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
  const mapped = ip.match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/)
  if (mapped) return mapped[1]
  if (!/^[0-9a-f:]+$/.test(ip) || ip.split('::').length > 2) return null
  const [h, t] = ip.includes('::') ? ip.split('::') : [ip, null]
  const head = h ? h.split(':') : []
  const tail = t ? t.split(':') : []
  const groups = t === null ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':') + '::/64'
}
