// tests/rls.spec.ts
// RLS security tests — validates policy assumptions and client-side privilege rules.
// These tests run without a live DB; they verify the logic rules that RLS policies enforce.
// Live DB tests are in the PRODUCTION_CHECKLIST.md (manual verification gates).

import { describe, it, expect } from 'vitest';

// ── RLS policy model ──────────────────────────────────────────
type Role = 'anon' | 'authenticated';
type Op   = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface Policy {
  table: string;
  role: Role;
  ops: Op[];
  condition: 'always' | 'own_row' | 'bucket_match' | 'never' | 'event_member';
}

// Mirrors what auth-setup.sql establishes (production state, after anon write removal)
const POLICIES: Policy[] = [
  // leod_sessions
  { table: 'leod_sessions',         role: 'anon',          ops: ['SELECT'],                        condition: 'always' },
  // writes (095): owner or active invited director/stage/av of the event (cuedeck_event_role)
  { table: 'leod_sessions',         role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'event_member' },
  // leod_event_log (095): members read and append; no anon, no UPDATE/DELETE
  { table: 'leod_event_log',        role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_event_log',        role: 'authenticated',  ops: ['SELECT','INSERT'],               condition: 'event_member' },
  // leod_broadcast (095): members only, one row per event; the display page does not read it
  { table: 'leod_broadcast',        role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_broadcast',        role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'event_member' },
  // leod_clock (095): read-only for clients; get_server_clock() (SECURITY DEFINER) writes it
  { table: 'leod_clock',            role: 'anon',           ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_clock',            role: 'authenticated',  ops: ['SELECT'],                        condition: 'always' },
  // leod_users (own row only)
  { table: 'leod_users',            role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_users',            role: 'authenticated',  ops: ['SELECT'],                        condition: 'own_row' },
  // leod_signage_displays (anon: none since 080; the display page reads through display_feed())
  { table: 'leod_signage_displays', role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_signage_displays', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_signage_sponsors (anon: none since 083; the display reads sponsors through display_feed()).
  // authenticated: own or invited events only (scoped_all_sponsors, 083)
  { table: 'leod_signage_sponsors', role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_signage_sponsors', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_signage_pairing (083: no direct access; display_pair_* functions only)
  { table: 'leod_signage_pairing',  role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_signage_pairing',  role: 'authenticated',  ops: [],                                condition: 'never' },
  // storage.objects
  { table: 'storage.objects',       role: 'anon',           ops: ['SELECT'],                        condition: 'bucket_match' },
  { table: 'storage.objects',       role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'bucket_match' },
];

function canDo(role: Role, table: string, op: Op): boolean {
  return POLICIES.some(p => p.table === table && p.role === role && p.ops.includes(op));
}

// ── Production rules (after auth-setup.sql applied) ──────────

describe('RLS: anon role — read-only on core tables', () => {
  it('01 anon can SELECT leod_sessions', () => {
    expect(canDo('anon', 'leod_sessions', 'SELECT')).toBe(true);
  });
  it('02 anon CANNOT INSERT leod_sessions', () => {
    expect(canDo('anon', 'leod_sessions', 'INSERT')).toBe(false);
  });
  it('03 anon CANNOT UPDATE leod_sessions', () => {
    expect(canDo('anon', 'leod_sessions', 'UPDATE')).toBe(false);
  });
  it('04 anon CANNOT DELETE leod_sessions', () => {
    expect(canDo('anon', 'leod_sessions', 'DELETE')).toBe(false);
  });
  it('05 anon CANNOT INSERT leod_event_log (immutable log)', () => {
    expect(canDo('anon', 'leod_event_log', 'INSERT')).toBe(false);
  });
  it('06 anon CANNOT INSERT leod_broadcast', () => {
    expect(canDo('anon', 'leod_broadcast', 'INSERT')).toBe(false);
  });
  it('07 anon CANNOT UPDATE leod_clock', () => {
    expect(canDo('anon', 'leod_clock', 'UPDATE')).toBe(false);
  });
});

describe('RLS: anon role — signage tables', () => {
  it('08 anon CANNOT SELECT leod_signage_displays (rows carry display_secret; page uses display_feed)', () => {
    expect(canDo('anon', 'leod_signage_displays', 'SELECT')).toBe(false);
  });
  it('09 anon CANNOT UPDATE leod_signage_displays (display_feed is the heartbeat)', () => {
    expect(canDo('anon', 'leod_signage_displays', 'UPDATE')).toBe(false);
  });
  it('10 anon CANNOT INSERT leod_signage_displays', () => {
    expect(canDo('anon', 'leod_signage_displays', 'INSERT')).toBe(false);
  });
  it('11 anon CANNOT DELETE leod_signage_displays', () => {
    expect(canDo('anon', 'leod_signage_displays', 'DELETE')).toBe(false);
  });
  it('12 anon CANNOT SELECT leod_signage_sponsors (display_feed carries them)', () => {
    expect(canDo('anon', 'leod_signage_sponsors', 'SELECT')).toBe(false);
  });
  it('13 anon CANNOT INSERT leod_signage_sponsors', () => {
    expect(canDo('anon', 'leod_signage_sponsors', 'INSERT')).toBe(false);
  });
  it('13b nobody reads or links leod_signage_pairing directly (083)', () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        expect(canDo(role, 'leod_signage_pairing', op)).toBe(false);
      }
    }
  });
});

describe('RLS: anon role — users table', () => {
  it('14 anon CANNOT SELECT leod_users (no ops)', () => {
    expect(canDo('anon', 'leod_users', 'SELECT')).toBe(false);
  });
  it('15 anon CANNOT INSERT leod_users', () => {
    expect(canDo('anon', 'leod_users', 'INSERT')).toBe(false);
  });
});

describe('RLS: authenticated role — full access to operational tables', () => {
  it('16 authenticated can INSERT leod_sessions', () => {
    expect(canDo('authenticated', 'leod_sessions', 'INSERT')).toBe(true);
  });
  it('17 authenticated can UPDATE leod_sessions', () => {
    expect(canDo('authenticated', 'leod_sessions', 'UPDATE')).toBe(true);
  });
  it('18 authenticated can INSERT leod_broadcast', () => {
    expect(canDo('authenticated', 'leod_broadcast', 'INSERT')).toBe(true);
  });
  it('19 authenticated can INSERT leod_signage_sponsors (logo upload)', () => {
    expect(canDo('authenticated', 'leod_signage_sponsors', 'INSERT')).toBe(true);
  });
  it('20 authenticated can SELECT own leod_users row', () => {
    expect(canDo('authenticated', 'leod_users', 'SELECT')).toBe(true);
  });
});

describe('RLS: storage bucket policies', () => {
  it('21 anon can SELECT from storage.objects (public logo reads)', () => {
    expect(canDo('anon', 'storage.objects', 'SELECT')).toBe(true);
  });
  it('22 anon CANNOT INSERT into storage.objects (no upload)', () => {
    expect(canDo('anon', 'storage.objects', 'INSERT')).toBe(false);
  });
  it('23 authenticated can INSERT into storage.objects (logo upload)', () => {
    expect(canDo('authenticated', 'storage.objects', 'INSERT')).toBe(true);
  });
  it('24 authenticated can UPDATE storage.objects (upsert)', () => {
    expect(canDo('authenticated', 'storage.objects', 'UPDATE')).toBe(true);
  });
});

// ── Critical: supabase-setup.sql dev policies must NOT be in prod ──
describe('Dev policy guard — anon write policies must not be in production', () => {
  // These are the exact policy names from supabase-setup.sql:198-202
  const DEV_POLICIES = [
    'anon_write_sessions',
    'anon_write_log',
    'anon_write_broadcast',
    'anon_write_clock',
  ];

  it('25 dev policy list is documented and known', () => {
    // This test exists to make the dev policies explicit and trackable.
    // If these appear in a production RLS audit, that is a CRITICAL failure.
    expect(DEV_POLICIES).toHaveLength(4);
    expect(DEV_POLICIES).toContain('anon_write_sessions');
  });

  it('26 production policy model does NOT include anon INSERT on leod_sessions', () => {
    // This verifies our POLICIES model above is correct (no dev policies included)
    expect(canDo('anon', 'leod_sessions', 'INSERT')).toBe(false);
  });

  it('27 production policy model does NOT include anon INSERT on leod_event_log', () => {
    expect(canDo('anon', 'leod_event_log', 'INSERT')).toBe(false);
  });
});

describe('095: event-scoped writes', () => {
  it('28 authenticated CANNOT UPDATE or DELETE leod_event_log', () => {
    expect(canDo('authenticated', 'leod_event_log', 'UPDATE')).toBe(false);
    expect(canDo('authenticated', 'leod_event_log', 'DELETE')).toBe(false);
  });
  it('29 nobody client-side writes leod_clock', () => {
    for (const op of ['INSERT', 'UPDATE', 'DELETE'] as Op[]) {
      expect(canDo('authenticated', 'leod_clock', op)).toBe(false);
      expect(canDo('anon', 'leod_clock', op)).toBe(false);
    }
  });
  it('30 anon CANNOT read leod_broadcast or leod_event_log', () => {
    expect(canDo('anon', 'leod_broadcast', 'SELECT')).toBe(false);
    expect(canDo('anon', 'leod_event_log', 'SELECT')).toBe(false);
  });
  it('31 session, log and broadcast writes are event-scoped, not open to any signed-in user', () => {
    for (const table of ['leod_sessions', 'leod_event_log', 'leod_broadcast']) {
      const p = POLICIES.find(x => x.table === table && x.role === 'authenticated')!;
      expect(p.condition).toBe('event_member');
    }
  });
});
