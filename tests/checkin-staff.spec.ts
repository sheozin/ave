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
