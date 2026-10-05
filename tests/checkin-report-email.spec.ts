// tests/checkin-report-email.spec.ts
// The post-event report email (event-day spec, feature 6). It carries the
// headline numbers and a link, never attendee names, companies, desk
// labels or the event name: outbound mail states account facts only.
import { describe, it, expect } from 'vitest';
import { reportEmail, headline } from '../supabase/functions/_shared/checkin-report-email.ts';

const REPORT = {
  registered: 120, checked_in: 87, walk_ins: 6, walk_ins_in: 6,
  first_arrival_at: '2026-10-18T06:52:00Z', last_arrival_at: '2026-10-18T13:10:00Z',
  status: 'live', event: { name: 'Contoso <b>Summit</b>', date: '2026-10-18', timezone: 'Europe/Warsaw', venue: 'Hall A' },
  by_ticket: [{ ticket_type: 'VIP', registered: 20, checked_in: 12, no_shows: 8 }],
  peak: { t: 1792310400, n: 31 },
  offline: { late_checkins: 4, longest_delay_s: 300, desks: 1 },
  desks: [{ label: 'Front desk', checkins: 60, busiest_15: 22 }, { label: 'Side', checkins: 27, busiest_15: 9 }],
  companies: [{ company: 'Fabrikam Demo', expected: 5, arrived: 1 }],
};
const URL_ = 'https://app.cuedeck.io/checkin/report?event=e1';

describe('headline', () => {
  it('computes the numbers the email states', () => {
    expect(headline(REPORT)).toEqual({ registered: 120, checkedIn: 87, turnout: 73, noShows: 33, walkIns: 6, peak: 31, desks: 2 });
  });
  it('an empty guest list has no turnout, not NaN', () => {
    const h = headline({ ...REPORT, registered: 0, checked_in: 0, peak: null, desks: [] });
    expect(h.turnout).toBeNull();
    expect(h.peak).toBe(0);
  });
});

describe('reportEmail', () => {
  const m = reportEmail(REPORT, URL_);
  it('states the date and the numbers and links to the report', () => {
    expect(m.subject).toBe('Your check-in report for 18 Oct 2026');
    for (const s of ['87 of 120 checked in', '73%', '33 did not arrive', '6 walk-ins', '31 in the busiest 15 minutes', '2 desks']) {
      expect(m.text).toContain(s);
      expect(m.html).toContain(s);
    }
    expect(m.text).toContain(URL_);
    expect(m.html).toContain('href="' + URL_ + '"');
  });
  it('never carries the event name, venue, companies or desk labels', () => {
    for (const s of ['Contoso', 'Summit', 'Hall A', 'Fabrikam', 'Front desk', 'Side']) {
      expect(m.html).not.toContain(s);
      expect(m.text).not.toContain(s);
      expect(m.subject).not.toContain(s);
    }
  });
  it('uses no em dashes', () => {
    expect(m.html + m.text + m.subject).not.toMatch(/—/);
  });
  it('one desk is singular', () => {
    expect(reportEmail({ ...REPORT, desks: [REPORT.desks[0]] }, URL_).text).toContain('1 desk');
    expect(reportEmail({ ...REPORT, desks: [REPORT.desks[0]] }, URL_).text).not.toContain('1 desks');
  });
  it('a link that is not https to app.cuedeck.io is refused', () => {
    expect(() => reportEmail(REPORT, 'https://evil.example/checkin/report?event=e1')).toThrow();
  });
});
