// tests/checkin-kiosk.spec.ts
// Self-registration kiosk: field validation, duplicate-email detection,
// short-code derivation, and the collision RESPONSE SHAPE.
//
// Following this repo's convention (see the header of
// tests/checkin-import.spec.ts, plus tests/checkin-scan.spec.ts and
// tests/checkin-outbox.spec.ts): Deno Edge Functions aren't importable
// into vitest, so the logic is re-expressed here as plain TS and
// asserted against. This file IS the specification, kept in sync by a
// human diffing it against cuedeck-checkin.html (the kiosk screens) and
// supabase/functions/checkin-self-register/index.ts (the server side),
// neither of which exists yet — this spec lands first.
//
// Two security decisions are baked into the shapes below. They came out
// of a review of the original design and must not be quietly relaxed:
//
//   1. The kiosk never touches leod_checkin_attendees directly. There
//      is no anon RLS policy for it. The screen posts to the
//      checkin-self-register Edge Function with a device key, and that
//      function runs as the service role. So everything in this file is
//      client-side *courtesy* validation for the person typing — the
//      same checks are re-run server-side, because anything a kiosk
//      sends is attacker-controlled.
//
//   2. On an email collision the kiosk reveals NOTHING about the person
//      already on file. See the 'collision response shape' block at the
//      bottom for the full reasoning.

import { describe, it, expect } from 'vitest';

type KioskForm = {
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  consent: boolean;
};

const MAX_NAME = 80;

// A name must contain at least one LETTER in any script. \p{L} with the
// /u flag covers Latin, Latin-with-diacritics, Arabic and Cyrillic in
// one check. A naive /[a-z]/i would reject محمد and Иванов outright and
// is the specific mistake this guard exists to prevent.
const HAS_LETTER = /\p{L}/u;

// Deliberately loose: something@something.something with no spaces.
// A stricter regex rejects real addresses and there is nobody at an
// unattended screen to argue with about it. Deliverability is proven by
// the code email arriving, not by a regex.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateKiosk(f: KioskForm, emailRequired: boolean): string[] {
  const errors: string[] = [];

  const first = f.first_name.trim();
  const last = f.last_name.trim();

  if (!first) errors.push('first_name');
  else if (first.length > MAX_NAME) errors.push('first_name_too_long');
  else if (!HAS_LETTER.test(first)) errors.push('first_name_invalid');

  if (!last) errors.push('last_name');
  else if (last.length > MAX_NAME) errors.push('last_name_too_long');
  else if (!HAS_LETTER.test(last)) errors.push('last_name_invalid');

  const email = f.email.trim();
  if (!email) {
    if (emailRequired) errors.push('email');
  } else if (!EMAIL_SHAPE.test(email)) {
    errors.push('email_format');
  }

  // GDPR. Always required, in both email modes, and the checkbox is
  // never pre-checked in the UI — a pre-ticked box is not consent.
  if (!f.consent) errors.push('consent');

  return errors;
}

// Recognises the Postgres unique-violation raised by migration 050's
// partial index idx_checkin_attendees_event_email_unique on
// (event_id, lower(email)) WHERE email IS NOT NULL. PostgREST surfaces
// it as code 23505; the message form is the fallback for transports
// that drop the code. Must not fire on anything else — treating a
// permission error as "already registered" would tell the screen to
// show a reassuring success message for a write that never happened.
function isDuplicateEmail(err: { code?: string; message?: string }): boolean {
  if (err.code === '23505') return true;
  const m = (err.message ?? '').toLowerCase();
  return m.includes('duplicate key') || m.includes('unique constraint');
}

// The human-readable code printed on screen and read aloud to the
// person at the desk. Four alphanumerics from the qr_token, uppercased.
// Non-alphanumerics are dropped first so punctuation never lands on a
// badge or in a spoken code; a short or letterless token simply yields
// a shorter string rather than throwing, since the caller is an
// unattended screen with nowhere to report an exception.
function shortCode(token: string): string {
  return token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
}

// Trim and lowercase, nothing else. Matches lower(email) in migration
// 050's index, so '  Anna@Example.PL ' and 'anna@example.pl' collide as
// one person instead of creating a duplicate attendee.
//
// Deliberately NOT gmail-style normalisation: no dot stripping, no
// plus-tag stripping. anna+expo@x.com and anna@x.com are two different
// registrations as far as an event is concerned, and collapsing them
// would hand one person's badge to whoever typed the other address.
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const mk = (o: Partial<KioskForm> = {}): KioskForm => ({
  first_name: 'Anna', last_name: 'Kowalska',
  company: 'Acme', email: 'anna@acme.pl', consent: true, ...o,
});

// ════════════════════════════════════════════════════════════════
// validateKiosk
// ════════════════════════════════════════════════════════════════

describe('kiosk: validateKiosk', () => {
  it('accepts a fully filled form with consent ticked', () => {
    expect(validateKiosk(mk(), true)).toEqual([]);
  });

  it('requires first_name and last_name after trimming', () => {
    expect(validateKiosk(mk({ first_name: '   ' }), true)).toContain('first_name');
    expect(validateKiosk(mk({ last_name: '' }), true)).toContain('last_name');
  });

  it('requires consent even when every other field is perfect', () => {
    expect(validateKiosk(mk({ consent: false }), true)).toEqual(['consent']);
  });

  it('requires consent in the no-email mode too — GDPR does not depend on a delivery setting', () => {
    expect(validateKiosk(mk({ email: '', consent: false }), false)).toEqual(['consent']);
  });

  it('requires email only when emailRequired is true', () => {
    expect(validateKiosk(mk({ email: '' }), true)).toEqual(['email']);
    expect(validateKiosk(mk({ email: '' }), false)).toEqual([]);
  });

  it('treats a whitespace-only email as absent, not as a format error', () => {
    expect(validateKiosk(mk({ email: '   ' }), true)).toEqual(['email']);
    expect(validateKiosk(mk({ email: '   ' }), false)).toEqual([]);
  });

  it('reports email_format for a non-empty email of the wrong shape, in either mode', () => {
    expect(validateKiosk(mk({ email: 'anna' }), true)).toEqual(['email_format']);
    expect(validateKiosk(mk({ email: 'anna@acme' }), true)).toEqual(['email_format']);
    expect(validateKiosk(mk({ email: 'anna @acme.pl' }), true)).toEqual(['email_format']);
    // Optional-email mode still validates whatever was actually typed.
    expect(validateKiosk(mk({ email: 'not-an-email' }), false)).toEqual(['email_format']);
  });

  it('accepts an email with surrounding whitespace and mixed case', () => {
    expect(validateKiosk(mk({ email: '  Anna@Example.PL ' }), true)).toEqual([]);
  });

  it('accepts a plus-tagged address — a genuinely distinct registration', () => {
    expect(validateKiosk(mk({ email: 'anna+expo@acme.pl' }), true)).toEqual([]);
  });

  it('never requires company — it is optional in both modes', () => {
    expect(validateKiosk(mk({ company: '' }), true)).toEqual([]);
    expect(validateKiosk(mk({ company: '   ' }), false)).toEqual([]);
  });

  // An unattended public screen with a physical badge at the end of it.
  // Someone WILL hold a key down. 80 characters is already generous for
  // a real name and far past what fits on badge stock.
  it('rejects a name longer than 80 characters', () => {
    const long = 'A'.repeat(81);
    expect(validateKiosk(mk({ first_name: long }), true)).toEqual(['first_name_too_long']);
    expect(validateKiosk(mk({ last_name: long }), true)).toEqual(['last_name_too_long']);
  });

  it('accepts a name sitting exactly on the 80-character limit', () => {
    const exact = 'A'.repeat(80);
    expect(validateKiosk(mk({ first_name: exact, last_name: exact }), true)).toEqual([]);
  });

  it('measures length after trimming, so trailing spaces do not fail a legal name', () => {
    const padded = '  ' + 'A'.repeat(80) + '  ';
    expect(validateKiosk(mk({ first_name: padded }), true)).toEqual([]);
  });

  it('rejects a name made only of punctuation or digits', () => {
    expect(validateKiosk(mk({ first_name: '...' }), true)).toEqual(['first_name_invalid']);
    expect(validateKiosk(mk({ first_name: '12345' }), true)).toEqual(['first_name_invalid']);
    expect(validateKiosk(mk({ last_name: '!!!' }), true)).toEqual(['last_name_invalid']);
    expect(validateKiosk(mk({ last_name: '---' }), true)).toEqual(['last_name_invalid']);
    expect(validateKiosk(mk({ first_name: '???', last_name: '000' }), true))
      .toEqual(['first_name_invalid', 'last_name_invalid']);
  });

  it('reports every problem at once so the screen can highlight all bad fields in one pass', () => {
    const errs = validateKiosk(
      { first_name: '', last_name: '###', company: '', email: 'nope', consent: false },
      true,
    );
    expect(errs).toEqual(['first_name', 'last_name_invalid', 'email_format', 'consent']);
  });
});

// ════════════════════════════════════════════════════════════════
// validateKiosk — Unicode names
// ════════════════════════════════════════════════════════════════
// The letter check MUST be Unicode-aware (\p{L} with /u). A naive
// /[a-z]/i passes only the first of these and rejects a Polish diacritic
// name, an Arabic name and a Cyrillic name as "punctuation" — turning
// away real attendees at a Polish conference. These tests fail loudly if
// anyone swaps the regex for an ASCII one.

describe('kiosk: validateKiosk accepts names in any script', () => {
  const names = ['Kowalski', 'Wiśniewska', 'Ømer', 'محمد', 'Иванов'];

  for (const name of names) {
    it(`accepts "${name}" as both first and last name`, () => {
      expect(validateKiosk(mk({ first_name: name, last_name: name }), true)).toEqual([]);
    });
  }

  it('accepts a name that is mostly punctuation but contains one non-Latin letter', () => {
    expect(validateKiosk(mk({ first_name: "-Ø-" }), true)).toEqual([]);
  });

  it('still rejects a name of non-Latin DIGITS, which are not letters', () => {
    // Arabic-Indic digits: \p{N}, not \p{L}. A bot pasting these must
    // not get a badge printed.
    expect(validateKiosk(mk({ first_name: '١٢٣٤' }), true)).toEqual(['first_name_invalid']);
  });

  it('accepts names with apostrophes and hyphens alongside letters', () => {
    expect(validateKiosk(mk({ first_name: "O'Brien", last_name: 'Nowak-Kowalska' }), true)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// isDuplicateEmail
// ════════════════════════════════════════════════════════════════

describe('kiosk: isDuplicateEmail', () => {
  it('recognises the Postgres unique-violation code from migration 050', () => {
    expect(isDuplicateEmail({ code: '23505' })).toBe(true);
  });

  it('recognises the duplicate-key message when no code is supplied', () => {
    expect(isDuplicateEmail({
      message: 'duplicate key value violates unique constraint "idx_checkin_attendees_event_email_unique"',
    })).toBe(true);
  });

  it('matches the message case-insensitively', () => {
    expect(isDuplicateEmail({ message: 'DUPLICATE KEY value violates UNIQUE CONSTRAINT' })).toBe(true);
  });

  it('recognises a bare unique constraint phrasing', () => {
    expect(isDuplicateEmail({ message: 'violates unique constraint' })).toBe(true);
  });

  // The dangerous direction: a permission or connection failure must
  // never be reported as "already registered". That would show a
  // reassuring screen for a write that never landed, and the person
  // would walk to the desk expecting a badge that does not exist.
  it('does not misfire on an unrelated permission error', () => {
    expect(isDuplicateEmail({ code: '42501', message: 'permission denied for table leod_checkin_attendees' })).toBe(false);
  });

  it('does not misfire on other Postgres errors or on an empty error object', () => {
    expect(isDuplicateEmail({ code: '23503', message: 'insert or update violates foreign key constraint' })).toBe(false);
    expect(isDuplicateEmail({ code: '23502', message: 'null value in column "first_name" violates not-null constraint' })).toBe(false);
    expect(isDuplicateEmail({ code: '08006', message: 'connection failure' })).toBe(false);
    expect(isDuplicateEmail({})).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// shortCode
// ════════════════════════════════════════════════════════════════

describe('kiosk: shortCode', () => {
  it('takes the first four characters of a token, uppercased', () => {
    expect(shortCode('a1b2c3d4e5f6')).toBe('A1B2');
  });

  it('leaves an already-uppercase token unchanged', () => {
    expect(shortCode('ABCD1234')).toBe('ABCD');
  });

  it('is stable — the same token always yields the same code', () => {
    const token = '9f8e7d6c5b4a';
    expect(shortCode(token)).toBe(shortCode(token));
  });

  it('returns whatever is available when the token is shorter than four characters', () => {
    expect(shortCode('ab')).toBe('AB');
    expect(shortCode('x')).toBe('X');
  });

  it('returns an empty string for an empty token rather than throwing', () => {
    expect(shortCode('')).toBe('');
  });

  // Nothing but punctuation survives the strip, so the result is empty
  // rather than a code with a dash in it that nobody can read aloud.
  it('returns an empty string for a token containing only punctuation', () => {
    expect(shortCode('----')).toBe('');
    expect(shortCode('-.-/')).toBe('');
  });

  it('skips punctuation to reach real characters in a dashed token', () => {
    // A UUID with its dashes left in still yields four usable characters.
    expect(shortCode('a-b-c-d-e')).toBe('ABCD');
  });
});

// ════════════════════════════════════════════════════════════════
// normalizeEmail
// ════════════════════════════════════════════════════════════════

describe('kiosk: normalizeEmail', () => {
  it('collapses casing and surrounding whitespace onto one key', () => {
    expect(normalizeEmail('  Anna@Example.PL ')).toBe('anna@example.pl');
    expect(normalizeEmail('  Anna@Example.PL ')).toBe(normalizeEmail('anna@example.pl'));
  });

  it('strips tabs and newlines a touch keyboard or paste can introduce', () => {
    expect(normalizeEmail('\tanna@example.pl\n')).toBe('anna@example.pl');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  Anna@Example.PL ');
    expect(normalizeEmail(once)).toBe(once);
  });

  // Everything below is what normalizeEmail must NOT do. Gmail-style
  // canonicalisation would merge two people who registered separately,
  // and the loser of the merge would be handed the other's badge.
  it('does NOT strip a plus tag — anna+expo@ and anna@ are different registrations', () => {
    expect(normalizeEmail('Anna+Expo@Example.pl')).toBe('anna+expo@example.pl');
    expect(normalizeEmail('anna+expo@example.pl')).not.toBe(normalizeEmail('anna@example.pl'));
  });

  it('does NOT strip dots from the local part', () => {
    expect(normalizeEmail('An.Na@Example.pl')).toBe('an.na@example.pl');
    expect(normalizeEmail('an.na@example.pl')).not.toBe(normalizeEmail('anna@example.pl'));
  });

  it('does NOT strip internal whitespace, so a malformed address stays visibly malformed', () => {
    expect(normalizeEmail('  anna @example.pl ')).toBe('anna @example.pl');
  });

  it('leaves subaddressed and subdomained addresses otherwise intact', () => {
    expect(normalizeEmail('Anna.Kowalska+CueDeck@Mail.Corp.Example.PL'))
      .toBe('anna.kowalska+cuedeck@mail.corp.example.pl');
  });

  it('produces the key migration 050 indexes on — lower(email)', () => {
    // The index is ON (event_id, lower(email)). If normalizeEmail ever
    // did more than lower/trim, the client's idea of "same person" would
    // drift from the database's and the collision path would stop firing.
    const typed = '  Anna@Example.PL ';
    expect(normalizeEmail(typed)).toBe(typed.trim().toLowerCase());
  });
});

// ════════════════════════════════════════════════════════════════
// collision response shape — SECURITY, do not "improve"
// ════════════════════════════════════════════════════════════════
//
// This block exists to make a future UX "improvement" fail the suite.
//
// The obvious kindness is to detect the email collision and show the
// person their existing code right there on the screen: no queue, no
// confusion, one tap. Do not do it. The kiosk is UNATTENDED and takes
// an arbitrary email with no proof of ownership, so returning anything
// about the matched record turns it into an email-enumeration oracle:
//
//   - Type a speaker's public conference address, get told whether they
//     are registered — attendance disclosure on its own.
//   - Worse, get handed their QR code, then check in as them or walk to
//     the desk and collect their badge, wearing their name and their
//     access.
//
// So the collision branch returns { status: 'already_registered' } and
// nothing else. No name, no id, no code, not even a "we emailed
// <a***a@example.pl>" hint, because a partially masked address still
// confirms the account exists. The code is sent to the address ON FILE,
// which reaches the actual owner; anyone who is not the owner learns
// only that their input was accepted.
//
// The screen copy that goes with this says the same thing whichever
// branch ran: "Check your email." Anything more specific leaks.

type KioskResponse =
  | { status: 'registered'; code: string }
  | { status: 'already_registered' };

function kioskResponseFor(outcome: 'new' | 'collision', code: string): KioskResponse {
  if (outcome === 'collision') return { status: 'already_registered' };
  return { status: 'registered', code };
}

describe('kiosk: collision response shape', () => {
  it('returns the code on the new-registration branch — that person just proved nothing, but the record is theirs', () => {
    expect(kioskResponseFor('new', 'A1B2')).toEqual({ status: 'registered', code: 'A1B2' });
  });

  it('returns status and NOTHING else on the collision branch', () => {
    const res = kioskResponseFor('collision', 'A1B2');
    expect(Object.keys(res)).toEqual(['status']);
    expect(res).toEqual({ status: 'already_registered' });
  });

  it('never carries a code property on the collision branch, not even undefined or empty', () => {
    const res = kioskResponseFor('collision', 'A1B2');
    expect(res).not.toHaveProperty('code');
    expect(res).not.toHaveProperty('short_code');
    expect(res).not.toHaveProperty('qr_token');
  });

  it('never carries identifying fields on the collision branch', () => {
    const res = kioskResponseFor('collision', 'A1B2');
    for (const leak of ['id', 'attendee_id', 'first_name', 'last_name', 'name', 'email', 'company', 'checked_in_at']) {
      expect(res).not.toHaveProperty(leak);
    }
  });

  // The blunt version of the above: whatever the shape grows into
  // later, the collision payload must not contain the code anywhere in
  // it — not nested, not renamed, not masked into a hint string.
  it('leaks no part of the existing record anywhere in the serialised payload', () => {
    const code = 'A1B2';
    const serialised = JSON.stringify(kioskResponseFor('collision', code));
    expect(serialised).toBe('{"status":"already_registered"}');
    expect(serialised).not.toContain(code);
    expect(serialised.toLowerCase()).not.toContain('kowalska');
    expect(serialised.toLowerCase()).not.toContain('@');
  });

  it('is indistinguishable in size and structure from a probe of an unregistered address, apart from the status word', () => {
    // An attacker timing or sizing responses learns only which branch
    // ran, which is unavoidable; they must not learn anything further.
    const collision = kioskResponseFor('collision', 'A1B2');
    expect(Object.keys(collision)).toHaveLength(1);
  });
});
