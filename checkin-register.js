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

// See the server copy: NFKC, no format characters, collapsed whitespace.
export function cleanText(s) {
  return s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
}

export function isRegistrationCode(code) {
  return typeof code === 'string' && CODE_SHAPE.test(code);
}

export function validateRegistration(f, questions) {
  const errors = [];
  const first = cleanText(f.first_name);
  const last = cleanText(f.last_name);
  const email = f.email.trim();

  if (!first) errors.push('first_name');
  else if (first.length > MAX_NAME) errors.push('first_name_too_long');
  else if (!HAS_LETTER.test(first) || LINKISH.test(first)) errors.push('first_name_invalid');

  if (!last) errors.push('last_name');
  else if (last.length > MAX_NAME) errors.push('last_name_too_long');
  else if (!HAS_LETTER.test(last) || LINKISH.test(last)) errors.push('last_name_invalid');

  if (!email) errors.push('email');
  else if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) errors.push('email_format');

  if (cleanText(f.company).length > MAX_COMPANY) errors.push('company_too_long');

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
// Plus-ones (migration 114): at most `max` people, each a first and last
// name under the same rules as the guest's own. A row left wholly empty is
// dropped (the guest added a row and changed their mind). Codes are
// 'plus:<index>' for the row that failed.
export function validatePlusOnes(list, max) {
  const errors = [];
  const names = [];
  const rows = Array.isArray(list) ? list : [];
  rows.forEach((r, i) => {
    const o = r && typeof r === 'object' ? r : {};
    const first = cleanText(typeof o.first_name === 'string' ? o.first_name : '');
    const last = cleanText(typeof o.last_name === 'string' ? o.last_name : '');
    if (!first && !last) return;
    const ok = (s) => s && s.length <= MAX_NAME && HAS_LETTER.test(s) && !LINKISH.test(s);
    if (!ok(first) || !ok(last)) errors.push('plus:' + i);
    else names.push({ first_name: first, last_name: last });
  });
  if (names.length > Math.max(0, max)) errors.push('plus_too_many');
  return { errors, names };
}

export function fieldMessage(code) {
  if (code.startsWith('q:')) return { field: code, text: 'Please answer this question.' };
  if (code.startsWith('plus:')) return { field: code, text: 'Please enter their first and last name in letters.' };
  if (code === 'plus_too_many') return { field: 'plus', text: 'That is more guests than this event allows.' };
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

// ── page design helpers (registration page redesign, migration 104) ──

// The brand palette from one #RRGGBB: soft background, darker ink for text
// on white (kept dark enough for 4.5:1), and a deep tone for the cover.
export function palette(hex) {
  const c = /^#[0-9A-Fa-f]{6}$/.test(hex || '') ? hex : '#1F4ED8';
  const rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (to, t) => '#' + rgb.map((v, i) => Math.round(v * (1 - t) + to[i] * t).toString(16).padStart(2, '0')).join('');
  return { accent: c, soft: mix([255, 255, 255], 0.88), ink: mix([0, 0, 0], 0.3), deep: mix([10, 12, 20], 0.5) };
}

// "Europe/Warsaw" -> "Warsaw time"; anything unexpected -> "".
export function tzLabel(tz) {
  if (typeof tz !== 'string' || !tz.includes('/')) return '';
  return tz.split('/').pop().replace(/_/g, ' ') + ' time';
}

export function initials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
}

const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// An .ics calendar file. Text is escaped per RFC 5545 (\ ; , and newlines);
// a missing end becomes start + 2 hours.
export function buildIcs({ uid, title, startUtc, endUtc, location, description, url }) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const end = endUtc || new Date(Date.parse(startUtc) + 2 * 3600e3).toISOString();
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CueDeck//Registration//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + esc(uid), 'DTSTAMP:' + stamp(new Date().toISOString()),
    'DTSTART:' + stamp(startUtc), 'DTEND:' + stamp(end),
    'SUMMARY:' + esc(title), location ? 'LOCATION:' + esc(location) : null,
    description ? 'DESCRIPTION:' + esc(description) : null, url ? 'URL:' + esc(url) : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

export function googleCalUrl({ title, startUtc, endUtc, location, details }) {
  const end = endUtc || new Date(Date.parse(startUtc) + 2 * 3600e3).toISOString();
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title || '', dates: stamp(startUtc) + '/' + stamp(end), location: location || '', details: details || '' });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

export function outlookCalUrl({ title, startUtc, endUtc, location, details }) {
  const end = endUtc || new Date(Date.parse(startUtc) + 2 * 3600e3).toISOString();
  const q = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title || '', startdt: startUtc, enddt: end, location: location || '', body: details || '' });
  return 'https://outlook.live.com/calendar/0/deeplink/compose?' + q.toString();
}

export function mapsUrl(venue, address) {
  const q = [venue, address].filter(Boolean).join(', ');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}
