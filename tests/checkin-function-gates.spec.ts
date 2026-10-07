// tests/checkin-function-gates.spec.ts
// Who may call each check-in Edge Function. The decisions live in
// supabase/functions/_shared/checkin-gates.ts as pure functions, run here
// for every role against the spec's permission table (written out below,
// not read from checkin-roles.ts, so a table change cannot quietly change
// what is expected). The real handlers are exercised end to end by
// tests/deno/checkin-function-handlers.test.ts, which this file runs when
// deno is installed.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  functionGate, enableEventGate, compGoLiveDecision, FUNCTION_GATES, NOT_OWNER, type GatedFunction,
  staffGate, inviteRoleVerdict, removeResponse, transferVerdict, archiveVerdict, STAFF_FORBIDDEN,
  archivedVerdict, visibleStaff, ARCHIVED,
} from '../supabase/functions/_shared/checkin-gates.ts';
import { loadCallerRole, removeVerdict, type CheckinRole, type GrantRole } from '../supabase/functions/_shared/checkin-roles.ts';

// Operator-row value -> what loadCallerRole resolves it to (not the owner).
const ROWS: [string, string | null][] = [
  ['organizer', 'organizer'], ['lead', 'lead'], ['crew', 'crew'], ['viewer', 'viewer'],
  ['api_consumer', 'api_consumer'], ['unknown', 'mystery'], ['none', null],
  // A non-creator whose operator row says 'owner' gets no owner rights.
  ['row_says_owner', 'owner'],
];
type Who = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer' | 'api_consumer' | 'unknown' | 'none' | 'row_says_owner';
const WHO: Who[] = ['owner', ...ROWS.map(r => r[0] as Who)];

// Roles are resolved by the real loadCallerRole over a stubbed client, so
// the matrix covers how an operator row becomes a role (an 'owner' row on
// a non-creator included), not a hand-written copy of that rule.
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
function stubSb(createdBy: string, opRole: string | null) {
  const rows: Record<string, Record<string, unknown> | null> = {
    leod_events: { created_by: createdBy },
    leod_checkin_operators: opRole ? { role: opRole } : null,
  };
  return {
    from: (t: string) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[t] ?? null, error: null }) };
      return q;
    },
  };
}
const RESOLVED = new Map<Who, CheckinRole | null>();
beforeAll(async () => {
  for (const who of WHO) {
    const sb = who === 'owner' ? stubSb(USER, 'organizer') : stubSb(OTHER, ROWS.find(r => r[0] === who)![1]);
    const r = await loadCallerRole(sb, EVENT, USER);
    if (r.error) throw new Error(r.error);
    RESOLVED.set(who, r.role);
  }
});
const roleOf = (who: Who): CheckinRole | null => RESOLVED.get(who) ?? null;

describe('loadCallerRole', () => {
  it('a non-creator whose operator row says owner has no role', () => {
    expect(roleOf('row_says_owner')).toBeNull();
  });
  it('the creator is the owner', () => {
    expect(roleOf('owner')).toBe('owner');
  });
});

const ALLOWED: Record<GatedFunction, Who[]> = {
  'checkin-create-checkout': ['owner'],
  'checkin-import-attendees': ['owner', 'organizer'],
  'checkin-send-qr-emails': ['owner', 'organizer'],
  'checkin-kiosk-pair': ['owner', 'organizer', 'lead'],
  'checkin-record-scans': ['owner', 'organizer', 'lead', 'crew'],
  'checkin-add-walk-in': ['owner', 'organizer', 'lead'],
  'checkin-held': ['owner', 'organizer'],
  'checkin-tickets': ['owner', 'organizer'],
  'checkin-reminders': ['owner', 'organizer'],
  'checkin-tickets-owner': ['owner'],
};

describe('functionGate', () => {
  for (const fn of Object.keys(ALLOWED) as GatedFunction[]) {
    it.each(WHO)(`${fn}: %s`, (who) => {
      const v = functionGate(fn, { role: roleOf(who), error: null });
      if (ALLOWED[fn].includes(who)) expect(v).toEqual({ ok: true });
      else expect(v).toEqual({ ok: false, status: 403, body: FUNCTION_GATES[fn].forbidden });
    });
    it(`${fn}: a role read error is a 500 even for the owner`, () => {
      expect(functionGate(fn, { role: 'owner', error: 'db down' })).toEqual({ ok: false, status: 500, body: { error: 'db down' } });
    });
  }
  it('create-checkout refuses with code not_owner', () => {
    const v = functionGate('checkin-create-checkout', { role: 'organizer', error: null });
    expect(v.ok === false && v.body).toEqual(NOT_OWNER);
  });
  it('walk-in refusal carries code forbidden', () => {
    expect(FUNCTION_GATES['checkin-add-walk-in'].forbidden).toEqual({ error: 'Only an organizer or a desk lead can add a walk-in', code: 'forbidden' });
  });
  it('kiosk refusal keeps the word the desk maps to its kiosk note', () => {
    expect(FUNCTION_GATES['checkin-kiosk-pair'].forbidden.error.toLowerCase()).toContain('organizer');
  });
});

describe('enableEventGate', () => {
  it.each(WHO)('%s', (who) => {
    const v = enableEventGate({ role: roleOf(who), error: null }, false);
    expect(v.ok).toBe(who === 'owner' || who === 'organizer');
  });
  it('a CueDeck admin with no role passes', () => {
    expect(enableEventGate({ role: null, error: null }, true)).toEqual({ ok: true });
  });
  it('a role read error is a 500, admin or not', () => {
    expect(enableEventGate({ role: null, error: 'db down' }, true)).toMatchObject({ ok: false, status: 500 });
  });
});

describe('compGoLiveDecision', () => {
  const base = { isComp: true, existingStatus: 'test' as string | null, hasSettings: false };
  it('not a comp event: proceed', () => {
    expect(compGoLiveDecision({ ...base, isComp: false, role: 'organizer' })).toBe('proceed');
  });
  it('owner: go live', () => {
    expect(compGoLiveDecision({ ...base, role: 'owner' })).toBe('go_live');
  });
  it.each(WHO.filter(w => w !== 'owner'))('%s asking to go live on a test event: refuse', (who) => {
    expect(compGoLiveDecision({ ...base, role: roleOf(who) })).toBe('refuse');
  });
  it('admin who is not the owner (no role): refuse', () => {
    expect(compGoLiveDecision({ ...base, role: null })).toBe('refuse');
  });
  it('first setup (no entitlement row) by an organizer: proceed in test', () => {
    expect(compGoLiveDecision({ ...base, role: 'organizer', existingStatus: null })).toBe('proceed');
  });
  it('settings save by an organizer: proceed in test', () => {
    expect(compGoLiveDecision({ ...base, role: 'organizer', hasSettings: true })).toBe('proceed');
  });
  // A settings toggle never goes live, the owner's included: only the
  // explicit "Turn on live check-in" call (no settings) does.
  it('settings save by the owner: proceed in test', () => {
    expect(compGoLiveDecision({ ...base, role: 'owner', hasSettings: true })).toBe('proceed');
  });
  it('settings save by the owner with no entitlement row yet: proceed in test', () => {
    expect(compGoLiveDecision({ ...base, role: 'owner', hasSettings: true, existingStatus: null })).toBe('proceed');
  });
});

// ── checkin-invite-staff ────────────────────────────────────────────
describe('staffGate (every invite-staff action)', () => {
  const STAFF_ALLOWED: Who[] = ['owner', 'organizer', 'lead'];
  it.each(WHO)('%s', (who) => {
    const v = staffGate({ role: roleOf(who), error: null });
    if (STAFF_ALLOWED.includes(who)) expect(v).toEqual({ ok: true });
    else expect(v).toEqual({ ok: false, status: 403, body: STAFF_FORBIDDEN });
  });
  it('a role read error is a 500 even for the owner', () => {
    expect(staffGate({ role: 'owner', error: 'db down' })).toEqual({ ok: false, status: 500, body: { error: 'db down' } });
  });
});

describe('inviteRoleVerdict', () => {
  const WANT: GrantRole[] = ['organizer', 'lead', 'crew', 'viewer'];
  const MAY: Record<string, GrantRole[]> = { owner: WANT, organizer: WANT, lead: ['crew'] };
  for (const who of ['owner', 'organizer', 'lead'] as Who[]) {
    it.each(WANT)(`${who} inviting %s`, (want) => {
      const v = inviteRoleVerdict(roleOf(who), want);
      if (MAY[who].includes(want)) expect(v).toEqual({ ok: true });
      else expect(v).toMatchObject({ ok: false, status: 403, body: { code: 'role_not_allowed' } });
    });
  }
  it.each(['crew', 'viewer', 'none'] as Who[])('%s may invite nobody', (who) => {
    for (const want of WANT) expect(inviteRoleVerdict(roleOf(who), want).ok).toBe(false);
  });
});

describe('remove through removeVerdict', () => {
  const team = [
    { user_id: 'own', role: 'organizer' }, { user_id: 'org', role: 'organizer' },
    { user_id: 'ld', role: 'lead' }, { user_id: 'cr', role: 'crew' }, { user_id: 'vw', role: 'viewer' },
  ];
  const r = (who: CheckinRole, target: string, t = team) => removeResponse(removeVerdict(who, target, 'own', t));
  it('a lead removes crew', () => { expect(r('lead', 'cr')).toEqual({ ok: true }); });
  it.each(['org', 'ld', 'vw'])('a lead cannot remove %s', (target) => {
    expect(r('lead', target)).toEqual({ ok: false, status: 403, body: { error: 'Desk leads can remove desk staff only', code: 'forbidden' } });
  });
  it('a lead cannot remove the owner', () => { expect(r('lead', 'own')).toMatchObject({ ok: false, body: { code: 'event_owner' } }); });
  it.each(['owner', 'organizer'] as CheckinRole[])('%s cannot remove the owner', (who) => {
    expect(r(who, 'own')).toEqual({ ok: false, status: 409, body: { error: 'The event owner cannot be removed', code: 'event_owner' } });
  });
  it.each(['org', 'ld', 'cr', 'vw'])('an organizer removes %s', (target) => { expect(r('organizer', target)).toEqual({ ok: true }); });
  it('the owner counts as an organizer: the other organizer can go', () => {
    expect(r('owner', 'org', [{ user_id: 'own', role: 'organizer' }, { user_id: 'org', role: 'organizer' }])).toEqual({ ok: true });
  });
  it('the last organizer stays', () => {
    expect(removeResponse(removeVerdict('organizer', 'org', null, [{ user_id: 'org', role: 'organizer' }])))
      .toEqual({ ok: false, status: 409, body: { error: 'An event needs at least one organizer', code: 'last_organizer' } });
  });
  it('someone not on the event is a 404', () => { expect(r('owner', 'nobody')).toMatchObject({ ok: false, status: 404, body: { code: 'not_found' } }); });
  it('crew and viewers remove nobody', () => {
    expect(r('crew', 'cr')).toMatchObject({ ok: false, status: 403 });
    expect(r('viewer', 'cr')).toMatchObject({ ok: false, status: 403 });
  });
});

describe('archivedVerdict', () => {
  it.each(['invite', 'transfer_owner', 'archive_event'])('%s on an archived event: archived', (a) => {
    expect(archivedVerdict(a, false)).toEqual({ ok: false, status: 409, body: ARCHIVED });
    expect(ARCHIVED).toEqual({ error: 'This event was deleted.', code: 'archived' });
  });
  it.each(['list', 'remove'])('%s on an archived event stays allowed', (a) => {
    expect(archivedVerdict(a, false)).toEqual({ ok: true });
  });
  it.each([true, null, undefined])('active %s blocks nothing', (active) => {
    for (const a of ['invite', 'transfer_owner', 'archive_event']) expect(archivedVerdict(a, active)).toEqual({ ok: true });
  });
});

describe('visibleStaff', () => {
  const team = [
    { user_id: 'own', role: 'organizer' }, { user_id: 'ld', role: 'lead' }, { user_id: 'ld2', role: 'lead' },
    { user_id: 'cr', role: 'crew' }, { user_id: 'vw', role: 'viewer' },
  ];
  it('a lead sees crew and their own row only', () => {
    expect(visibleStaff('lead', 'ld', team).map(o => o.user_id)).toEqual(['ld', 'cr']);
  });
  it.each(['owner', 'organizer'] as CheckinRole[])('%s sees everyone', (r) => {
    expect(visibleStaff(r, 'own', team)).toHaveLength(5);
  });
});

describe('transferVerdict', () => {
  const T = '44444444-4444-4444-8444-444444444444';
  const team = [{ user_id: USER, role: 'organizer' }, { user_id: T, role: 'organizer' }, { user_id: OTHER, role: 'lead' }];
  const base = { role: 'owner' as CheckinRole | null, createdVia: 'checkin', callerId: USER, targetId: T, targetIsUuid: true, team, targetActive: true };
  it('owner to an organizer on a check-in event', () => { expect(transferVerdict(base)).toEqual({ ok: true }); });
  it.each(WHO.filter(w => w !== 'owner'))('%s: not_owner', (who) => {
    expect(transferVerdict({ ...base, role: roleOf(who) })).toMatchObject({ ok: false, status: 403, body: { code: 'not_owner' } });
  });
  it('a console event: console_event', () => {
    expect(transferVerdict({ ...base, createdVia: 'console' })).toMatchObject({ ok: false, status: 409, body: { code: 'console_event' } });
    expect(transferVerdict({ ...base, createdVia: null })).toMatchObject({ ok: false, status: 409, body: { code: 'console_event' } });
  });
  it('to yourself or a malformed id: bad_target', () => {
    expect(transferVerdict({ ...base, targetId: USER })).toMatchObject({ ok: false, status: 400, body: { code: 'bad_target' } });
    expect(transferVerdict({ ...base, targetId: 'x', targetIsUuid: false })).toMatchObject({ ok: false, status: 400, body: { code: 'bad_target' } });
  });
  it('to an inactive account: target_inactive', () => {
    expect(transferVerdict({ ...base, targetActive: false })).toMatchObject({ ok: false, status: 409, body: { code: 'target_inactive' } });
  });
  it('to a lead or someone not on the event: not_organizer', () => {
    expect(transferVerdict({ ...base, targetId: OTHER })).toMatchObject({ ok: false, status: 409, body: { code: 'not_organizer' } });
    expect(transferVerdict({ ...base, targetId: EVENT })).toMatchObject({ ok: false, status: 409, body: { code: 'not_organizer' } });
  });
});

describe('archiveVerdict', () => {
  const base = { role: 'owner' as CheckinRole | null, createdVia: 'checkin', entStatus: 'test' as string | null };
  it('owner, check-in event, test mode', () => { expect(archiveVerdict(base)).toEqual({ ok: true }); });
  it('owner, check-in event never set up', () => { expect(archiveVerdict({ ...base, entStatus: null })).toEqual({ ok: true }); });
  it.each(WHO.filter(w => w !== 'owner'))('%s: not_owner', (who) => {
    expect(archiveVerdict({ ...base, role: roleOf(who) })).toMatchObject({ ok: false, status: 403, body: { code: 'not_owner' } });
  });
  it('a console event: console_event', () => {
    expect(archiveVerdict({ ...base, createdVia: 'console' })).toMatchObject({ ok: false, status: 409, body: { code: 'console_event' } });
  });
  const NOW = Date.parse('2026-10-05T10:00:00Z');
  it('an open checkout: checkout_open', () => {
    expect(archiveVerdict({ ...base, checkoutSessionId: 'cs_1', checkoutExpiresAt: '2026-10-05T10:30:00Z', nowMs: NOW }))
      .toEqual({ ok: false, status: 409, body: { error: 'A payment is in progress for this event. Try again in an hour.', code: 'checkout_open' } });
  });
  it('an expired or absent checkout does not block', () => {
    expect(archiveVerdict({ ...base, checkoutSessionId: 'cs_1', checkoutExpiresAt: '2026-10-05T09:59:59Z', nowMs: NOW })).toEqual({ ok: true });
    expect(archiveVerdict({ ...base, checkoutSessionId: null, checkoutExpiresAt: '2026-10-05T10:30:00Z', nowMs: NOW })).toEqual({ ok: true });
  });
  it('a live event: live_event', () => {
    expect(archiveVerdict({ ...base, entStatus: 'live' })).toMatchObject({ ok: false, status: 409, body: { code: 'live_event' } });
  });
});

describe('handlers route through the shared gates', () => {
  const src = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');
  it.each(Object.keys(ALLOWED).filter(f => !f.startsWith('checkin-tickets')))('%s', (fn) => {
    // checkin-record-scans also takes a paired scanner's device key (scanner
    // Build A); there is no user then, so its operator path gates on
    // operatorId (= user.id, set only after a valid JWT).
    const who = fn === 'checkin-record-scans' ? 'operatorId' : 'user.id';
    expect(src(fn)).toContain(`functionGate('${fn}', await loadCallerRole(sb, event_id, ${who}))`);
  });
  it('checkin-record-scans gates every operator and sets operatorId only from a verified user', () => {
    const s = src('checkin-record-scans');
    expect(s).toContain('if (authErr || !user) return fail(401, \'Unauthorized\')\n    operatorId = user.id');
    expect(s).toContain('if (operatorId) {\n    const gate = functionGate(');
    expect(s).toContain("const auth = await authDevice(sb, event_id, deviceKey, 'scanner')");
  });
  it('checkin-tickets: status for organizers, money moves for the owner only', () => {
    const s = src('checkin-tickets');
    expect(s).toContain('const caller = await loadCallerRole(sb, event_id, user.id)');
    expect(s).toContain("functionGate(action === 'payout_status' ? 'checkin-tickets' : 'checkin-tickets-owner', caller)");
    expect(s).toContain("if (!['payout_status', 'payout_connect', 'refund'].includes(action)) return json({ error: 'Bad request' }, 400)");
  });
  it('checkin-enable-event', () => {
    const s = src('checkin-enable-event');
    expect(s).toContain('enableEventGate(caller, isAdmin)');
    expect(s).toContain('compGoLiveDecision(');
  });
  it('checkin-invite-staff', () => {
    const s = src('checkin-invite-staff');
    for (const call of [
      'staffGate(callerRole)',
      'const callerRole = await loadCallerRole(sb, event_id, user.id)',
      'inviteRoleVerdict(role, want)',
      'removeResponse(removeVerdict(role, target, ev.created_by, team))',
      'transferVerdict({',
      'archiveVerdict({',
      'archivedVerdict(action, ev.active)',
      'visibleStaff(role, user.id, team)',
    ]) expect(s).toContain(call);
    // The invite log row is written before any send.
    expect(s.indexOf('await logInvite()')).toBeGreaterThan(0);
    // (New accounts are made with generateLink, which also creates the
    // account; there is no inviteUserByEmail any more.)
    expect(s).not.toContain('inviteUserByEmail(');
    expect(s.indexOf('await logInvite()')).toBeLessThan(s.indexOf('generateLink('));
    expect(s.lastIndexOf('await logInvite()')).toBeLessThan(s.indexOf('generateLink('));
  });
  it('checkin-add-walk-in refuses an archived event before the insert', () => {
    const s = src('checkin-add-walk-in');
    expect(s).toContain('if (ev.active === false) return json({ ...ARCHIVED }, 409)');
    expect(s.indexOf('ev.active === false')).toBeLessThan(s.indexOf(".from('leod_checkin_attendees')"));
  });
  it('checkin-create-checkout refuses an archived event', () => {
    const s = src('checkin-create-checkout');
    expect(s).toContain('if (ev.active === false) return json({ ...ARCHIVED }, 409)');
    expect(s.indexOf('ev.active === false')).toBeLessThan(s.indexOf('const st = stripe()'));
    // No hand-rolled operator-row comparison left over from the two-role version.
    expect(s).not.toContain('me?.role');
  });
});

// The handler tests need deno. A local machine without it skips them
// (visibly); CI installs deno (.github/workflows/ci.yml) and must never
// skip, so there a missing deno is a failure.
const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno && !process.env.CI)('Edge Function handlers (deno)', () => {
  it('tests/deno/checkin-function-handlers.test.ts passes', () => {
    expect(hasDeno, 'deno is not installed; CI must install it (denoland/setup-deno)').toBe(true);
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/checkin-function-handlers.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
