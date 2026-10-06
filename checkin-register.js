// checkin-register.js: browser side of the public registration page
// (/r/<code>). validateRegistration is a copy of
// supabase/functions/_shared/checkin-register.ts, kept equal by
// tests/checkin-register.spec.ts; the guest-facing wording lives only here.

export const MAX_NAME = 80;
export const MAX_EMAIL = 254;
export const MAX_COMPANY = 80;
export const MAX_ANSWER = 500;

const HAS_LETTER = /\p{L}/u;
// A plain addr-spec only. Rejecting <>()[]\\,;:" stops 'x<victim@y>' and
// list-shaped strings, which a mail API would parse as a different recipient
// than the one stored and de-duplicated (security review of migration 100).
const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
// A name is printed in the guest's QR email, so nothing shaped like a link:
// no @, slash or backslash, and no domain-like 'word.tld'.
// Tested after NFKC, so full-width ＠ ／ ． fold to their ASCII forms;
// the ideographic full stops are listed because NFKC keeps them.
const LINKISH = /[@/\\]|[\p{L}\p{N}-][.。｡]\p{L}{2,}/u;
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{10}$/;

export function isRegistrationCode(code) {
  return typeof code === 'string' && CODE_SHAPE.test(code);
}

export function validateRegistration(f, questions) {
  const errors = [];
  const first = f.first_name.trim();
  const last = f.last_name.trim();
  const email = f.email.trim();

  if (!first) errors.push('first_name');
  else if (first.length > MAX_NAME) errors.push('first_name_too_long');
  else if (!HAS_LETTER.test(first) || LINKISH.test(first.normalize('NFKC'))) errors.push('first_name_invalid');

  if (!last) errors.push('last_name');
  else if (last.length > MAX_NAME) errors.push('last_name_too_long');
  else if (!HAS_LETTER.test(last) || LINKISH.test(last.normalize('NFKC'))) errors.push('last_name_invalid');

  if (!email) errors.push('email');
  else if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) errors.push('email_format');

  if (f.company.trim().length > MAX_COMPANY) errors.push('company_too_long');

  const answers = {};
  for (const q of questions) {
    const raw = f.answers?.[q.id];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (q.required) errors.push('q:' + q.id);
      continue;
    }
    if (value.length > MAX_ANSWER) { errors.push('q:' + q.id); continue; }
    if (q.type === 'choice' && !q.options.includes(value)) { errors.push('q:' + q.id); continue; }
    answers[q.id] = { label: q.label, value };
  }

  if (f.consent !== true) errors.push('consent');

  return { errors, answers };
}

// The field each error code belongs to, and what to tell the guest.
export function fieldMessage(code) {
  if (code.startsWith('q:')) return { field: code, text: 'Please answer this question.' };
  const m = {
    first_name: ['first_name', 'Please enter your first name.'],
    first_name_too_long: ['first_name', 'That name is too long.'],
    first_name_invalid: ['first_name', 'Please enter your first name in letters.'],
    last_name: ['last_name', 'Please enter your last name.'],
    last_name_too_long: ['last_name', 'That name is too long.'],
    last_name_invalid: ['last_name', 'Please enter your last name in letters.'],
    email: ['email', 'Please enter your email address. Your QR code is sent there.'],
    email_format: ['email', 'Please check your email address.'],
    company_too_long: ['company', 'Please shorten the company name.'],
    consent: ['consent', 'Please tick the box to continue.'],
  }[code];
  return m ? { field: m[0], text: m[1] } : { field: null, text: 'Please check the form.' };
}

// "Saturday 18 October 2026". The date is a calendar date with no time, so
// it is formatted in UTC to stop a browser west of UTC showing the day before.
export function formatEventDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  // Built by hand: toLocaleDateString's punctuation differs between ICU versions.
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
