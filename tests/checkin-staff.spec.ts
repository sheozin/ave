// tests/checkin-staff.spec.ts
// Mirrors the removal rule in supabase/functions/checkin-invite-staff.
import { describe, it, expect } from 'vitest';

type Op = { user_id: string; role: 'organizer' | 'crew' };

function canRemove(target: string, ownerId: string | null, ops: Op[]): { ok: true } | { ok: false; code: 'event_owner' | 'last_organizer' | 'not_found' } {
  const row = ops.find(o => o.user_id === target);
  if (!row) return { ok: false, code: 'not_found' };
  if (target === ownerId) return { ok: false, code: 'event_owner' };
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) return { ok: false, code: 'last_organizer' };
  return { ok: true };
}

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

// Mirrors the LIKE-escape applied before ilike in the existing-user lookup.
const likeSafe = (email: string) => email.replace(/[\\%_]/g, (m) => '\\' + m);

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
});

describe('likeSafe', () => {
  it('escapes backslash, percent and underscore', () => { expect(likeSafe('a_b%c\\d@x.com')).toBe('a\\_b\\%c\\\\d@x.com'); });
  it('leaves ordinary addresses alone', () => { expect(likeSafe('ana@example.com')).toBe('ana@example.com'); });
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
