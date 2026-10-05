// tests/checkin-walk-in.spec.ts
import { describe, it, expect } from 'vitest';
import { normalizeWalkIn } from '../supabase/functions/_shared/checkin-walk-in.ts';

describe('normalizeWalkIn', () => {
  it('trims and collapses spaces, defaults the ticket type', () => {
    expect(normalizeWalkIn({ first_name: '  Ewa ', last_name: 'Sample  Two', company: ' Contoso  Demo ' })).toEqual({
      ok: true, row: { first_name: 'Ewa', last_name: 'Sample Two', email: null, company: 'Contoso Demo', ticket_type: 'attendee' },
    });
  });
  it('keeps the email as typed after trimming', () => {
    const r = normalizeWalkIn({ first_name: 'A', last_name: 'B', email: ' Ewa@Example.com ' });
    expect(r).toEqual({ ok: true, row: { first_name: 'A', last_name: 'B', email: 'Ewa@Example.com', company: null, ticket_type: 'attendee' } });
  });
  it('requires both names', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: '  ' })).toEqual({ ok: false, error: 'First and last name are required' });
    expect(normalizeWalkIn({})).toEqual({ ok: false, error: 'First and last name are required' });
  });
  it('refuses a * in the email, which the duplicate lookup would read as a wildcard', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: '*@example.com' })).toEqual({ ok: false, error: 'That email address does not look right' });
  });
  it('accepts _ in the email', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: 'a_b@example.com' })).toMatchObject({ ok: true, row: { email: 'a_b@example.com' } });
  });
  it('rejects a malformed email', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: 'not an email' })).toEqual({ ok: false, error: 'That email address does not look right' });
  });
  it('rejects over-long fields', () => {
    expect(normalizeWalkIn({ first_name: 'x'.repeat(121), last_name: 'B' })).toEqual({ ok: false, error: 'A name is too long' });
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', company: 'x'.repeat(201) })).toEqual({ ok: false, error: 'The company name is too long' });
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', ticket_type: 'x'.repeat(61) })).toEqual({ ok: false, error: 'The ticket type is too long' });
  });
  it('strips control and bidi characters before collapsing spaces', () => {
    expect(normalizeWalkIn({ first_name: '\u202EWalt\u0007', last_name: 'Walk\u2066in', company: 'North\u200Ewind\u0000 \u0085 Demo', ticket_type: '\u061Cvip\u009F' })).toEqual({
      ok: true, row: { first_name: 'Walt', last_name: 'Walkin', email: null, company: 'Northwind Demo', ticket_type: 'vip' },
    });
  });
  it('tabs and line breaks separate words instead of vanishing', () => {
    expect(normalizeWalkIn({ first_name: 'Ewa', last_name: 'Jan\nKowalski', company: 'Contoso\tDemo\r\nLtd' })).toEqual({
      ok: true, row: { first_name: 'Ewa', last_name: 'Jan Kowalski', email: null, company: 'Contoso Demo Ltd', ticket_type: 'attendee' },
    });
  });
  it('a name made only of control characters counts as missing', () => {
    expect(normalizeWalkIn({ first_name: '\u202E\u2069', last_name: 'B' })).toEqual({ ok: false, error: 'First and last name are required' });
  });
  it('ignores non-string values', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: 42, company: ['x'] })).toEqual({
      ok: true, row: { first_name: 'A', last_name: 'B', email: null, company: null, ticket_type: 'attendee' },
    });
  });
});
