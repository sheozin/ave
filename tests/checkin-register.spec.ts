// tests/checkin-register.spec.ts
// Rules for the public registration page, imported for real from the
// server module, plus parity of the browser copy (checkin-register.js):
// every case below runs through both and must reach the same verdict.
import { describe, it, expect } from 'vitest';
import * as server from '../supabase/functions/_shared/checkin-register.ts';
import * as page from '../checkin-register.js';

const qs: server.Question[] = [
  { id: 'diet', label: 'Dietary needs', type: 'text', required: false, options: [] },
  { id: 'track', label: 'Track', type: 'choice', required: true, options: ['Tech', 'Business'] },
];
const ok = { first_name: 'Maya', last_name: 'Lindqvist', email: 'maya@example.com', company: 'Contoso', answers: { track: 'Tech' }, consent: true };

const cases: [string, typeof ok, string[]][] = [
  ['a complete form', ok, []],
  ['Arabic and Cyrillic names', { ...ok, first_name: 'محمد', last_name: 'Иванов' }, []],
  ['missing names', { ...ok, first_name: ' ', last_name: '' }, ['first_name', 'last_name']],
  ['a name with no letters', { ...ok, first_name: '1234' }, ['first_name_invalid']],
  ['a name too long', { ...ok, last_name: 'x'.repeat(81) }, ['last_name_too_long']],
  ['missing email', { ...ok, email: '' }, ['email']],
  ['malformed email', { ...ok, email: 'maya@example' }, ['email_format']],
  ['email over 254', { ...ok, email: 'a'.repeat(250) + '@x.io' }, ['email_format']],
  ['company too long', { ...ok, company: 'c'.repeat(81) }, ['company_too_long']],
  ['required question unanswered', { ...ok, answers: {} }, ['q:track']],
  ['choice not among the options', { ...ok, answers: { track: 'Marketing' } }, ['q:track']],
  ['answer too long', { ...ok, answers: { track: 'Tech', diet: 'd'.repeat(501) } }, ['q:diet']],
  ['no consent', { ...ok, consent: false }, ['consent']],
  ['consent as a string is not consent', { ...ok, consent: 'true' as unknown as boolean }, ['consent']],
];

describe('validateRegistration', () => {
  for (const [name, form, expected] of cases) {
    it(name, () => {
      expect(server.validateRegistration(form, qs).errors).toEqual(expected);
      expect(page.validateRegistration(form, qs).errors).toEqual(expected);
    });
  }

  it('stores answers with their label, trimmed, and drops unknown questions', () => {
    const r = server.validateRegistration({ ...ok, answers: { track: ' Tech ', diet: ' none ', hack: 'x' } }, qs);
    expect(r.answers).toEqual({ track: { label: 'Track', value: 'Tech' }, diet: { label: 'Dietary needs', value: 'none' } });
    expect(page.validateRegistration({ ...ok, answers: { track: ' Tech ', diet: ' none ', hack: 'x' } }, qs).answers).toEqual(r.answers);
  });

  it('ignores answers that are not strings', () => {
    expect(server.validateRegistration({ ...ok, answers: { track: ['Tech'] as unknown as string } }, qs).errors).toEqual(['q:track']);
  });
});

describe('registration codes', () => {
  it('accepts ten characters of the unambiguous alphabet only', () => {
    for (const c of ['ABCDEFGH23', 'Z9Z9Z9Z9Z9']) {
      expect(server.isRegistrationCode(c)).toBe(true);
      expect(page.isRegistrationCode(c)).toBe(true);
    }
    for (const c of ['ABCDEFGH2', 'ABCDEFGH234', 'abcdefgh23', 'ABCDEFGH01', 'ABCDEFGHIO', '', null, 42]) {
      expect(server.isRegistrationCode(c)).toBe(false);
      expect(page.isRegistrationCode(c)).toBe(false);
    }
  });
});

describe('re-send throttle', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it('allows a first send and one per 10 minutes after', () => {
    expect(server.mayResend(null, now)).toBe(true);
    expect(server.mayResend('2026-10-06T11:55:00Z', now)).toBe(false);
    expect(server.mayResend('2026-10-06T11:50:00Z', now)).toBe(true);
    expect(server.mayResend('garbage', now)).toBe(true);
  });
});

describe('page wording', () => {
  it('maps every server field code to a field and a sentence', () => {
    for (const code of ['first_name', 'first_name_too_long', 'first_name_invalid', 'last_name', 'last_name_too_long',
      'last_name_invalid', 'email', 'email_format', 'company_too_long', 'consent', 'q:track']) {
      const m = page.fieldMessage(code);
      expect(m.field).not.toBeNull();
      expect(m.text.length).toBeGreaterThan(5);
    }
  });
  it('formats the event date without shifting the day', () => {
    expect(page.formatEventDate('2026-10-18')).toBe('Sunday 18 October 2026');
    expect(page.formatEventDate(null)).toBe('');
  });
});
