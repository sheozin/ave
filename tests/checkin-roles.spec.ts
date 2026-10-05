// tests/checkin-roles.spec.ts
// The approved permission table (docs/superpowers/specs/2026-10-04-checkin-roles-design.md)
// and parity between the server copy (supabase/functions/_shared/checkin-roles.ts)
// and the browser copy (/checkin-roles.js). Both are imported for real.
import { describe, it, expect } from 'vitest';
import * as server from '../supabase/functions/_shared/checkin-roles.ts';
import * as browser from '../checkin-roles.js';

type Role = server.CheckinRole;
const EV_ = '11111111-1111-4111-8111-111111111111';
const ROLES: Role[] = ['owner', 'organizer', 'lead', 'crew', 'viewer'];

// One row per line of the approved table, plus the three screen-only permissions.
const TABLE: [server.Permission, Role[]][] = [
  ['go_live',        ['owner']],
  ['transfer_owner', ['owner']],
  ['archive_event',  ['owner']],
  ['edit_details',   ['owner', 'organizer']],
  ['manage_guests',  ['owner', 'organizer']],
  ['test_setup',     ['owner', 'organizer']],
  ['export',         ['owner', 'organizer']],
  ['invite_any',     ['owner', 'organizer']],
  ['invite_crew',    ['owner', 'organizer', 'lead']],
  ['kiosk',          ['owner', 'organizer', 'lead']],
  ['walk_in',        ['owner', 'organizer', 'lead']],
  ['undo_any',       ['owner', 'organizer', 'lead']],
  ['desk_health',    ['owner', 'organizer', 'lead']],
  ['desk',           ['owner', 'organizer', 'lead', 'crew']],
  ['dashboard',      ['owner', 'organizer', 'lead', 'crew', 'viewer']],
];

describe('permission table', () => {
  it('covers every permission exactly once', () => {
    expect(TABLE.map(r => r[0]).sort()).toEqual(Object.keys(server.GRANTS).sort());
  });
  for (const [perm, allowed] of TABLE) {
    for (const role of ROLES) {
      it(`${role} ${allowed.includes(role) ? 'may' : 'may not'} ${perm}`, () => {
        expect(server.can(role, perm)).toBe(allowed.includes(role));
      });
    }
    it(`nobody without a role may ${perm}`, () => {
      expect(server.can(null, perm)).toBe(false);
      expect(server.can(undefined, perm)).toBe(false);
      expect(server.can('api_consumer' as Role, perm)).toBe(false);
    });
  }
});

describe('browser copy agrees with the server', () => {
  it('shares tables', () => {
    expect(browser.GRANTS).toEqual(server.GRANTS);
    expect(browser.ROLES).toEqual(server.ROLES);
    expect(browser.GRANT_ROLES).toEqual(server.GRANT_ROLES);
  });
  it.each([EV_, '', 'nope', null, 5, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])('isUuid(%s)', (v) => {
    expect(browser.isUuid(v)).toBe(server.isUuid(v));
  });
  it.each(['owner', 'organizer', 'lead', 'crew', 'viewer', null] as (Role | null)[])('removeVerdict as %s', (caller) => {
    const ops = [{ user_id: 'o', role: 'organizer' }, { user_id: 'c', role: 'crew' }, { user_id: 'l', role: 'lead' }];
    for (const t of ['o', 'c', 'l', 'ghost']) {
      expect(browser.removeVerdict(caller, t, 'o', ops)).toEqual(server.removeVerdict(caller, t, 'o', ops));
    }
  });
  it('can() ignores inherited property names', () => {
    for (const k of ['constructor', '__proto__', 'toString']) {
      expect(server.can('organizer', k as server.Permission)).toBe(false);
      expect(browser.can('organizer', k)).toBe(false);
    }
  });
  it('browser can() works without Object.hasOwn (Safari before 15.4)', () => {
    const hasOwn = Object.hasOwn;
    try {
      // @ts-expect-error simulating an older desk tablet
      delete Object.hasOwn;
      expect(browser.can('lead', 'walk_in')).toBe(true);
      expect(browser.can('crew', 'walk_in')).toBe(false);
      expect(browser.can('organizer', 'constructor')).toBe(false);
    } finally {
      Object.hasOwn = hasOwn;
    }
  });
  for (const [perm] of TABLE) {
    for (const role of [...ROLES, null, 'api_consumer']) {
      it(`can(${role}, ${perm})`, () => {
        expect(browser.can(role, perm)).toBe(server.can(role as Role, perm));
      });
    }
  }
  it.each([
    ['organizer', true], ['organizer', false], ['lead', false], ['crew', false], ['viewer', false],
    ['api_consumer', false], [null, true], [null, false], ['owner', false],
  ] as [string | null, boolean][])('effectiveRole(%s, %s)', (op, owner) => {
    expect(browser.effectiveRole(op, owner)).toBe(server.effectiveRole(op, owner));
  });
  it.each(ROLES)('invitableRoles(%s) and roleLabel(%s)', (r) => {
    expect(browser.invitableRoles(r)).toEqual(server.invitableRoles(r));
    expect(browser.roleLabel(r)).toBe(server.roleLabel(r));
  });
});

describe('effectiveRole', () => {
  it('the owner is owner whatever their operator row says', () => {
    expect(server.effectiveRole('organizer', true)).toBe('owner');
    expect(server.effectiveRole(null, true)).toBe('owner');
  });
  it('accepts the owner value migration 073 reports', () => {
    expect(server.effectiveRole('owner', false)).toBe('owner');
  });
  it('keeps the four grant roles and drops anything else', () => {
    for (const r of ['organizer', 'lead', 'crew', 'viewer']) expect(server.effectiveRole(r, false)).toBe(r);
    expect(server.effectiveRole('api_consumer', false)).toBeNull();
    expect(server.effectiveRole('', false)).toBeNull();
    expect(server.effectiveRole(undefined, false)).toBeNull();
  });
});

describe('invitableRoles', () => {
  it('office roles invite any grant role', () => {
    expect(server.invitableRoles('owner')).toEqual(['organizer', 'lead', 'crew', 'viewer']);
    expect(server.invitableRoles('organizer')).toEqual(['organizer', 'lead', 'crew', 'viewer']);
  });
  it('a desk lead invites desk staff only', () => { expect(server.invitableRoles('lead')).toEqual(['crew']); });
  it('desk staff and viewers invite nobody', () => {
    expect(server.invitableRoles('crew')).toEqual([]);
    expect(server.invitableRoles('viewer')).toEqual([]);
    expect(server.invitableRoles(null)).toEqual([]);
  });
});

describe('removeVerdict', () => {
  const ops = [
    { user_id: 'owner', role: 'organizer' }, { user_id: 'co', role: 'organizer' },
    { user_id: 'lead1', role: 'lead' }, { user_id: 'crew1', role: 'crew' }, { user_id: 'view1', role: 'viewer' },
  ];
  it('nobody removes the owner', () => {
    expect(server.removeVerdict('organizer', 'owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' });
    expect(server.removeVerdict('owner', 'owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' });
  });
  it('an organizer removes another organizer while one remains', () => {
    expect(server.removeVerdict('organizer', 'co', 'owner', ops)).toEqual({ ok: true });
  });
  it('keeps the last organizer', () => {
    expect(server.removeVerdict('owner', 'co', null, [{ user_id: 'co', role: 'organizer' }])).toEqual({ ok: false, code: 'last_organizer' });
  });
  it('a lead removes desk staff and nobody else', () => {
    expect(server.removeVerdict('lead', 'crew1', 'owner', ops)).toEqual({ ok: true });
    expect(server.removeVerdict('lead', 'co', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('lead', 'view1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('lead', 'lead1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
  });
  it('desk staff and viewers remove nobody', () => {
    expect(server.removeVerdict('crew', 'crew1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('viewer', 'crew1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
  });
  it('reports a person who is not on the event', () => {
    expect(server.removeVerdict('organizer', 'ghost', 'owner', ops)).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('roleLabel', () => {
  it('uses the approved names', () => {
    expect(ROLES.map(r => server.roleLabel(r))).toEqual(['Owner', 'Organizer', 'Desk lead', 'Desk staff', 'Viewer']);
    expect(server.roleLabel(null)).toBe('No access');
  });
});

// A fake supabase-js client: from(table).select().eq().eq().maybeSingle()
function fakeSb(rows: Record<string, { data: unknown; error: { message: string } | null }>) {
  return {
    from(t: string) {
      const r = rows[t] ?? { data: null, error: null };
      const q = { select: () => q, eq: () => q, maybeSingle: async () => r };
      return q;
    },
  };
}
const EV = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

describe('loadCallerRole', () => {
  it('the creator is owner', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: ME }, error: null }, leod_checkin_operators: { data: { role: 'organizer' }, error: null } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: 'owner', ownerId: ME, error: null });
  });
  it('an operator row gives its role', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: 'someone' }, error: null }, leod_checkin_operators: { data: { role: 'lead' }, error: null } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: 'lead', ownerId: 'someone', error: null });
  });
  it('an operator row saying owner does not make a non-creator owner', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: 'someone' }, error: null }, leod_checkin_operators: { data: { role: 'owner' }, error: null } });
    expect((await server.loadCallerRole(sb, EV, ME)).role).toBeNull();
  });
  it('no row means no role', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: 'someone' }, error: null } });
    expect((await server.loadCallerRole(sb, EV, ME)).role).toBeNull();
  });
  it('an unknown event means no role', async () => {
    expect((await server.loadCallerRole(fakeSb({}), EV, ME)).role).toBeNull();
  });
  it('a malformed event id is refused before any query', async () => {
    const sb = { from() { throw new Error('must not query'); } };
    expect(await server.loadCallerRole(sb, 'not-a-uuid', ME)).toEqual({ role: null, ownerId: null, error: null });
  });
  it('a database error is reported, never read as "no role"', async () => {
    const sb = fakeSb({ leod_events: { data: null, error: { message: 'boom' } } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: null, ownerId: null, error: 'boom' });
  });
});

describe('ownCheckins and mayUndo (desk, ruling 8)', () => {
  const T = '2026-10-18T08:00:00.000Z';
  const outbox = [
    { client_id: 'a', event_id: 'E', attendee_id: 'p1', action: 'checkin', scanned_at: T, operator_id: 'me', synced: true, result: 'ok' },
    { client_id: 'b', event_id: 'E', attendee_id: 'p2', action: 'checkin', scanned_at: T, operator_id: 'other', synced: true, result: 'ok' },
    { client_id: 'c', event_id: 'X', attendee_id: 'p3', action: 'checkin', scanned_at: T, operator_id: 'me', synced: false },
    { client_id: 'd', event_id: 'E', attendee_id: 'p4', action: 'checkin', scanned_at: T, operator_id: 'me', synced: true, result: 'duplicate' },
    { client_id: 'e', event_id: 'E', attendee_id: 'p5', action: 'checkin', scanned_at: T, synced: false },
  ];
  const own = browser.ownCheckins(outbox, 'me', 'E');
  it('counts only this user, this event, and check-ins the server did not refuse', () => {
    expect([...own.keys()]).toEqual(['p1']);
  });
  it('an item queued before operator ids existed belongs to nobody', () => {
    expect(own.has('p5')).toBe(false);
  });
  it('keeps the latest check-in per person', () => {
    const later = '2026-10-18T09:00:00.000Z';
    const m = browser.ownCheckins([...outbox, { client_id: 'f', event_id: 'E', attendee_id: 'p1', action: 'checkin', scanned_at: later, operator_id: 'me', synced: false }], 'me', 'E');
    expect(m.get('p1')).toBe(later);
  });
  it('desk staff undo their own check-in only', () => {
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: T }, own)).toBe(true);
    expect(browser.mayUndo('crew', { id: 'p2', checked_in_at: T }, own)).toBe(false);
  });
  it('matches the same instant written as PostgREST text', () => {
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: '2026-10-18T08:00:00+00:00' }, own)).toBe(true);
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: '2026-10-18T08:00:01+00:00' }, own)).toBe(false);
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: 'garbage' }, own)).toBe(false);
  });
  it('desk staff cannot undo once someone else checked the person in again', () => {
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: '2026-10-18T10:00:00.000Z' }, own)).toBe(false);
  });
  it('leads and above undo anyone', () => {
    for (const r of ['owner', 'organizer', 'lead']) expect(browser.mayUndo(r, { id: 'p2', checked_in_at: T }, own)).toBe(true);
  });
  it('nobody undoes a person who is not checked in, and viewers undo nothing', () => {
    expect(browser.mayUndo('lead', { id: 'p2', checked_in_at: null }, own)).toBe(false);
    expect(browser.mayUndo('viewer', { id: 'p1', checked_in_at: T }, own)).toBe(false);
  });
});

describe('transferNote (ruling 3)', () => {
  it('says nothing when complimentary status does not change, or the event is live', () => {
    expect(browser.transferNote(false, false, false)).toBe('');
    expect(browser.transferNote(true, true, false)).toBe('');
    expect(browser.transferNote(true, false, true)).toBe('');
  });
  it('warns when the event stops being complimentary', () => {
    expect(browser.transferNote(true, false, false)).toBe(' This event is complimentary because your account is. After the transfer it will need paying for before it can go live.');
  });
  it('says when the event becomes complimentary', () => {
    expect(browser.transferNote(false, true, false)).toBe(' This event will become complimentary, because their account is.');
  });
});

describe('ROLE_HELP', () => {
  it('describes every grant role in plain words without dashes', () => {
    for (const r of ['organizer', 'lead', 'crew', 'viewer']) {
      expect(browser.ROLE_HELP[r]).toMatch(/^[A-Z].*\.$/);
      expect(browser.ROLE_HELP[r]).not.toMatch(/[–—]/);
    }
  });
});
