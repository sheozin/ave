// tests/checkin-retention-email.spec.ts
// The email 14 days before guest details are deleted (migration 160). It
// states the event date and the deletion date and links to Reports. Never
// the event name or anything about the guests.
import { describe, it, expect } from 'vitest';
import { retentionEmail } from '../supabase/functions/_shared/retention-email.ts';

const EV = '33333333-3333-4333-8333-333333333333';
const URL_ = 'https://app.cuedeck.io/checkin/setup?event=' + EV + '&step=reports';

describe('retentionEmail', () => {
  it('names both dates, in the event zone, and links to Reports', () => {
    // 23:30 UTC on 17 Nov is already 18 Nov in Warsaw.
    const m = retentionEmail('2026-03-11', new Date('2026-11-17T23:30:00Z'), 'Europe/Warsaw', URL_);
    expect(m.subject).toBe('Guest details from your 11 March 2026 event will be deleted on 18 November 2026');
    expect(m.text).toContain(URL_);
    expect(m.html).toContain('href="' + URL_ + '"');
    expect(m.text).toContain('The numbers stay');
  });
  it('falls back to UTC for an unknown zone', () => {
    const m = retentionEmail('2026-03-11', new Date('2026-11-17T23:30:00Z'), 'Not/AZone', URL_);
    expect(m.subject).toContain('17 November 2026');
  });
  it('refuses a link anywhere else, and bad dates', () => {
    expect(() => retentionEmail('2026-03-11', new Date(), 'UTC', 'https://evil.test/checkin/setup?event=' + EV + '&step=reports')).toThrow();
    expect(() => retentionEmail('2026-03-11', new Date(), 'UTC', 'https://app.cuedeck.io/checkin/setup?event=' + EV)).toThrow();
    expect(() => retentionEmail('11-03-2026', new Date(), 'UTC', URL_)).toThrow();
    expect(() => retentionEmail('2026-03-11', new Date('x'), 'UTC', URL_)).toThrow();
  });
  it('has no em dashes', () => {
    const m = retentionEmail('2026-03-11', new Date('2026-11-18T10:00:00Z'), 'UTC', URL_);
    expect(m.subject + m.html + m.text).not.toMatch(/—/);
  });
});
