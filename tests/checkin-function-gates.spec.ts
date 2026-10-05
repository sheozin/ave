// tests/checkin-function-gates.spec.ts
// Who may call each check-in Edge Function. The decisions live in
// supabase/functions/_shared/checkin-gates.ts as pure functions, run here
// for every role against the spec's permission table (written out below,
// not read from checkin-roles.ts, so a table change cannot quietly change
// what is expected). The real handlers are exercised end to end by
// tests/deno/checkin-function-handlers.test.ts, which this file runs when
// deno is installed.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  functionGate, enableEventGate, compGoLiveDecision, FUNCTION_GATES, NOT_OWNER, type GatedFunction,
} from '../supabase/functions/_shared/checkin-gates.ts';
import { effectiveRole, type CheckinRole } from '../supabase/functions/_shared/checkin-roles.ts';

// Operator-row value -> what loadCallerRole resolves it to (not the owner).
const ROWS: [string, string | null][] = [
  ['organizer', 'organizer'], ['lead', 'lead'], ['crew', 'crew'], ['viewer', 'viewer'],
  ['api_consumer', 'api_consumer'], ['unknown', 'mystery'], ['none', null],
];
type Who = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer' | 'api_consumer' | 'unknown' | 'none';
const roleOf = (who: Who): CheckinRole | null =>
  who === 'owner' ? effectiveRole('organizer', true) : effectiveRole(ROWS.find(r => r[0] === who)![1], false);
const WHO: Who[] = ['owner', ...ROWS.map(r => r[0] as Who)];

const ALLOWED: Record<GatedFunction, Who[]> = {
  'checkin-create-checkout': ['owner'],
  'checkin-import-attendees': ['owner', 'organizer'],
  'checkin-send-qr-emails': ['owner', 'organizer'],
  'checkin-kiosk-pair': ['owner', 'organizer', 'lead'],
  'checkin-record-scans': ['owner', 'organizer', 'lead', 'crew'],
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
});

describe('handlers route through the shared gates', () => {
  const src = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');
  it.each(Object.keys(ALLOWED))('%s', (fn) => {
    expect(src(fn)).toContain(`functionGate('${fn}', await loadCallerRole(sb, event_id, user.id))`);
  });
  it('checkin-enable-event', () => {
    const s = src('checkin-enable-event');
    expect(s).toContain('enableEventGate(caller, isAdmin)');
    expect(s).toContain('compGoLiveDecision(');
  });
});

// The handler tests need deno. Skipped (visibly) where it is not installed,
// which today includes CI.
const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno)('Edge Function handlers (deno)', () => {
  it('tests/deno/checkin-function-handlers.test.ts passes', () => {
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/checkin-function-handlers.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
