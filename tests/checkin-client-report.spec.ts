// tests/checkin-client-report.spec.ts: the client's morning-after email
// (migration 157) and its page link (158).
import { describe, it, expect } from 'vitest';
import { clientReportEmail, guestCsv } from '../supabase/functions/_shared/client-report-email.ts';

const R = {
  registered: 200, checked_in: 150, walk_ins: 3, walk_ins_in: 3, peak: { t: 0, n: 41 }, desks: [],
  event: { date: '2026-11-03', name: 'Med Summit', venue: 'Hall A', timezone: 'Europe/Warsaw' },
  by_ticket: [{ ticket_type: 'Delegate', registered: 180, checked_in: 132, no_shows: 48 }],
} as never;

describe('clientReportEmail', () => {
  it('names the event, carries numbers only, and links the page to save as PDF', () => {
    const m = clientReportEmail(R, 'AVE Events', 'https://app.cuedeck.io/cr/0123456789abcdef0123456789abcdef');
    expect(m.subject).toBe('Check-in report: Med Summit, 3 November 2026');
    expect(m.text).toContain('- 150 of 200 checked in (75%)');
    expect(m.text).toContain('- Delegate: 132 of 180');
    expect(m.text).toContain('Save it as a PDF: https://app.cuedeck.io/cr/0123456789abcdef0123456789abcdef');
    expect(m.html).toContain('href="https://app.cuedeck.io/cr/0123456789abcdef0123456789abcdef"');
    expect(m.html + m.text).not.toContain('—');
  });
  it('without a page link the email still goes, without the button', () => {
    const m = clientReportEmail(R, null, null);
    expect(m.text).not.toContain('Save it as a PDF');
    expect(m.html).not.toContain('/cr/');
    expect(m.text).toContain('Reply to this email to reach The organizer.');
  });
});

describe('guestCsv', () => {
  it('makes a leading formula sign inert', () => {
    const csv = guestCsv([{ first_name: '=cmd', last_name: 'X', company: null, ticket_type: null, checked_in_at: null }], 'UTC');
    expect(csv).toContain("'=cmd;X;;;No;;");
  });
});
