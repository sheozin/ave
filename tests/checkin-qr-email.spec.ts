// tests/checkin-qr-email.spec.ts
// Check-in QR/email delivery — targeting and gating logic, re-expressed
// as pure functions per this repo's no-live-DB testing convention (see
// tests/checkin-import.spec.ts). Mirrors the real logic in
// supabase/functions/_shared/qr-email.ts,
// supabase/functions/checkin-send-qr-emails/index.ts, and the
// auto-send addition in supabase/functions/checkin-import-attendees/index.ts.
//
// These functions ARE the specification, kept in sync by a human diffing
// them against the real deployed code. If a test case here disagrees with
// the real Edge Function, the simulation is wrong — not the test. If the
// auto-send block in checkin-import-attendees/index.ts changes shape again,
// shouldAutoSend below is what needs to change.

import { describe, it, expect } from 'vitest';

interface Attendee {
  id: string;
  email: string | null;
  qr_email_sent_at: string | null;
}

// Mirrors checkin-send-qr-emails/index.ts's query-building logic:
// attendee_ids provided -> those exact rows; omitted -> never-sent rows.
function selectTargets(attendees: Attendee[], attendeeIds?: string[]): Attendee[] {
  if (attendeeIds && attendeeIds.length) {
    const idSet = new Set(attendeeIds);
    return attendees.filter(a => idSet.has(a.id));
  }
  return attendees.filter(a => a.qr_email_sent_at === null);
}

describe('checkin-send-qr-emails: target selection', () => {
  const attendees: Attendee[] = [
    { id: 'a1', email: 'a1@x.com', qr_email_sent_at: null },
    { id: 'a2', email: 'a2@x.com', qr_email_sent_at: '2026-07-01T00:00:00Z' },
    { id: 'a3', email: 'a3@x.com', qr_email_sent_at: null },
  ];

  it('01 with no attendee_ids, targets only never-sent attendees', () => {
    const targets = selectTargets(attendees);
    expect(targets.map(a => a.id)).toEqual(['a1', 'a3']);
  });

  it('02 with explicit attendee_ids, targets exactly those regardless of send state (forces a resend)', () => {
    const targets = selectTargets(attendees, ['a2']);
    expect(targets.map(a => a.id)).toEqual(['a2']);
  });

  it('03 an empty attendee_ids array behaves like "omitted" (never-sent only), not "target nothing"', () => {
    const targets = selectTargets(attendees, []);
    expect(targets.map(a => a.id)).toEqual(['a1', 'a3']);
  });
});

// Mirrors sendQrEmailsForAttendees()'s per-attendee classification in
// _shared/qr-email.ts (the no-email skip specifically).
function classifyForSend(attendee: Attendee): 'send' | 'skip_no_email' {
  return attendee.email ? 'send' : 'skip_no_email';
}

describe('sendQrEmailsForAttendees: no-email skip', () => {
  it('04 an attendee with no email is classified skip_no_email, never attempted', () => {
    const attendee: Attendee = { id: 'a4', email: null, qr_email_sent_at: null };
    expect(classifyForSend(attendee)).toBe('skip_no_email');
  });

  it('05 an attendee with an email is classified send', () => {
    const attendee: Attendee = { id: 'a5', email: 'a5@x.com', qr_email_sent_at: null };
    expect(classifyForSend(attendee)).toBe('send');
  });
});

// Mirrors the auto-send gate added to checkin-import-attendees
// (index.ts, right after the update-errors loop):
//
//   if (entRow.auto_send_qr_email && insertedAttendees.length) {
//     const { data: event, error: eventErr } = await sb.from('leod_events')...
//     if (event) {
//       ...send...
//     } else {
//       console.error('checkin-import-attendees: auto-send skipped, event fetch failed for', ...)
//     }
//   }
//
// This is a THREE-condition branch, not two: auto_send_qr_email must
// be true, insertedCount must be > 0, AND the post-import event fetch
// must succeed (non-null `event`) — if that fetch fails (or returns
// null for any reason), sending is silently skipped (now logged) even
// though the first two conditions alone would say "should send".
// eventFetchSucceeded models `event !== null` from that fetch.
function shouldAutoSend(autoSendEnabled: boolean, insertedCount: number, eventFetchSucceeded: boolean): boolean {
  return autoSendEnabled && insertedCount > 0 && eventFetchSucceeded;
}

describe('checkin-import-attendees: auto-send gate', () => {
  it('06 does not auto-send when auto_send_qr_email is false, even with new attendees and a successful event fetch', () => {
    expect(shouldAutoSend(false, 3, true)).toBe(false);
  });

  it('07 does not auto-send when auto_send_qr_email is true but nothing was newly inserted (e.g. a batch of pure updates), even with a successful event fetch', () => {
    expect(shouldAutoSend(true, 0, true)).toBe(false);
  });

  it('08 auto-sends when auto_send_qr_email is true, at least one attendee was newly inserted, and the event fetch succeeds', () => {
    expect(shouldAutoSend(true, 1, true)).toBe(true);
  });

  it('09 does not auto-send when the gate says yes (enabled + new attendees) but the post-import event fetch failed', () => {
    expect(shouldAutoSend(true, 1, false)).toBe(false);
  });
});

// Mirrors sendQrEmailsForAttendees(): the email payload always reuses
// the attendee's existing qr_token, whether this is the first send or
// an explicit resend — never regenerated.
function buildEmailQrToken(attendee: { qr_token: string }): string {
  return attendee.qr_token;
}

describe('QR token reuse on resend', () => {
  it('10 a resend for an already-sent attendee uses their existing qr_token unchanged', () => {
    const attendee = { id: 'a2', qr_token: 'existing-token-abc' };
    expect(buildEmailQrToken(attendee)).toBe('existing-token-abc');
  });
});
