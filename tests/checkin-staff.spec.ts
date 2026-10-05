// tests/checkin-staff.spec.ts
// checkin-invite-staff removes people through removeVerdict() in
// supabase/functions/_shared/checkin-roles.ts; these are its organizer cases.
import { describe, it, expect } from 'vitest';
import { removeVerdict } from '../supabase/functions/_shared/checkin-roles.ts';
import { normalizeInviteEmail, likeEscape as likeSafe } from '../supabase/functions/_shared/checkin-gates.ts';

type Op = { user_id: string; role: 'organizer' | 'lead' | 'crew' | 'viewer' };

const canRemove = (target: string, ownerId: string | null, ops: Op[]) => removeVerdict('organizer', target, ownerId, ops);

describe('canRemove', () => {
  const ops: Op[] = [{ user_id: 'owner', role: 'organizer' }, { user_id: 'co', role: 'organizer' }, { user_id: 'crew1', role: 'crew' }];
  it('never removes the event owner', () => { expect(canRemove('owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' }); });
  it('removes crew', () => { expect(canRemove('crew1', 'owner', ops)).toEqual({ ok: true }); });
  it('removes a co-organizer when another organizer remains', () => { expect(canRemove('co', 'owner', ops)).toEqual({ ok: true }); });
  it('keeps the last organizer', () => {
    expect(canRemove('co', null, [{ user_id: 'co', role: 'organizer' }])).toEqual({ ok: false, code: 'last_organizer' });
  });
});

describe('normalizeInviteEmail', () => {
  it('lowercases and trims', () => { expect(normalizeInviteEmail('  Ana@Example.COM ')).toBe('ana@example.com'); });
  it('rejects garbage', () => { expect(normalizeInviteEmail('not an email')).toBeNull(); });
  it('rejects non-strings', () => { expect(normalizeInviteEmail(42)).toBeNull(); });
  // PostgREST reads '*' in an ilike pattern as '%', with no escape for it.
  it('refuses a * anywhere', () => {
    for (const e of ['*@example.com', 'a*@example.com', 'a@*.com', 'a@example.*']) expect(normalizeInviteEmail(e)).toBeNull();
  });
  it('keeps _ and %, which are legal in real addresses', () => {
    expect(normalizeInviteEmail('a_b@example.com')).toBe('a_b@example.com');
    expect(normalizeInviteEmail('a%b@example.com')).toBe('a%b@example.com');
  });
});

describe('likeSafe', () => {
  it('escapes backslash, percent and underscore', () => { expect(likeSafe('a_b%c\\d@x.com')).toBe('a\\_b\\%c\\\\d@x.com'); });
  it('leaves ordinary addresses alone', () => { expect(likeSafe('ana@example.com')).toBe('ana@example.com'); });
  // The escaped pattern, read as Postgres LIKE reads it, matches only itself.
  it('a_b@example.com does not match axb@example.com once escaped', () => {
    const like = (pattern: string, v: string) => new RegExp('^' + pattern.replace(/\\(.)|([%_])|([^\\%_])/g,
      (_m, esc, wild, ch) => esc !== undefined ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : wild ? (wild === '%' ? '.*' : '.') : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) + '$', 'i').test(v);
    expect(like('a_b@example.com', 'axb@example.com')).toBe(true); // why the escape exists
    expect(like(likeSafe('a_b@example.com'), 'axb@example.com')).toBe(false);
    expect(like(likeSafe('a_b@example.com'), 'A_B@example.com')).toBe(true);
  });
});

// Mirrors the existing-grant decision, subject sanitizer and rate-limit predicate.
// An existing account that has never signed in gets a fresh link: an invite
// link when its email is unconfirmed, else a recovery (set-password) link.
type Decision = 'insert' | 'noop' | 'already_on_event' | 'insert+link' | 'link';
function inviteDecision(cur: string | null, role: string, neverSignedIn = false): Decision {
  if (cur !== null && cur !== role) return 'already_on_event';
  if (cur === null) return neverSignedIn ? 'insert+link' : 'insert';
  return neverSignedIn ? 'link' : 'noop';
}
const linkType = (emailConfirmedAt: string | null) => emailConfirmedAt ? 'recovery' : 'invite';
const safeSubjectName = (n: string) => n.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 80);
const rateLimited = (eventCount: number, inviterCount: number) => eventCount >= 50 || inviterCount >= 100;

describe('inviteDecision', () => {
  it('inserts when no grant exists', () => { expect(inviteDecision(null, 'crew')).toBe('insert'); });
  it('is a no-op for the same role', () => { expect(inviteDecision('crew', 'crew')).toBe('noop'); });
  it('refuses a different role (crew -> organizer)', () => { expect(inviteDecision('crew', 'organizer')).toBe('already_on_event'); });
  it('refuses demoting an organizer/owner', () => { expect(inviteDecision('organizer', 'crew')).toBe('already_on_event'); });
  it('refuses api_consumer', () => { expect(inviteDecision('api_consumer', 'crew')).toBe('already_on_event'); });
  it('re-sends a link to a same-role grantee who never signed in', () => { expect(inviteDecision('crew', 'crew', true)).toBe('link'); });
  it('grants and sends a link to a new grantee who never signed in', () => { expect(inviteDecision(null, 'crew', true)).toBe('insert+link'); });
  it('still refuses a different role even if never signed in', () => { expect(inviteDecision('crew', 'organizer', true)).toBe('already_on_event'); });
  it('uses an invite link when unconfirmed, recovery when confirmed', () => {
    expect(linkType(null)).toBe('invite');
    expect(linkType('2026-10-01T00:00:00Z')).toBe('recovery');
  });
});

describe('safeSubjectName', () => {
  it('strips newlines and angle brackets/quotes', () => { expect(safeSubjectName('Gala\r\nBcc: x <b>"hi"</b>')).toBe('Gala Bcc: x bhi/b'); });
  it('caps at 80 chars', () => { expect(safeSubjectName('x'.repeat(200))).toHaveLength(80); });
});

describe('rateLimited', () => {
  it('allows below both caps', () => { expect(rateLimited(49, 99)).toBe(false); });
  it('blocks at the event cap', () => { expect(rateLimited(50, 0)).toBe(true); });
  it('blocks at the inviter cap', () => { expect(rateLimited(0, 100)).toBe(true); });
});
