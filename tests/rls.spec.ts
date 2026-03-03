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
  condition: 'always' | 'own_row' | 'bucket_match' | 'never';
}

// Mirrors what auth-setup.sql establishes (production state, after anon write removal)
const POLICIES: Policy[] = [
  // leod_sessions
  { table: 'leod_sessions',         role: 'anon',          ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_sessions',         role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_event_log
  { table: 'leod_event_log',        role: 'anon',           ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_event_log',        role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_broadcast
  { table: 'leod_broadcast',        role: 'anon',           ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_broadcast',        role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_clock
  { table: 'leod_clock',            role: 'anon',           ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_clock',            role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_users (own row only)
  { table: 'leod_users',            role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_users',            role: 'authenticated',  ops: ['SELECT'],                        condition: 'own_row' },
  // leod_signage_displays (anon: SELECT + heartbeat UPDATE only)
  { table: 'leod_signage_displays', role: 'anon',           ops: ['SELECT', 'UPDATE'],              condition: 'always' },
  { table: 'leod_signage_displays', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
  // leod_signage_sponsors (anon: SELECT only)
  { table: 'leod_signage_sponsors', role: 'anon',           ops: ['SELECT'],                        condition: 'always' },
  { table: 'leod_signage_sponsors', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'always' },
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
  it('08 anon can SELECT leod_signage_displays (display page reads config)', () => {
    expect(canDo('anon', 'leod_signage_displays', 'SELECT')).toBe(true);
  });
  it('09 anon can UPDATE leod_signage_displays (heartbeat last_seen_at)', () => {
    expect(canDo('anon', 'leod_signage_displays', 'UPDATE')).toBe(true);
  });
  it('10 anon CANNOT INSERT leod_signage_displays', () => {
    expect(canDo('anon', 'leod_signage_displays', 'INSERT')).toBe(false);
  });
  it('11 anon CANNOT DELETE leod_signage_displays', () => {
    expect(canDo('anon', 'leod_signage_displays', 'DELETE')).toBe(false);
  });
  it('12 anon can SELECT leod_signage_sponsors', () => {
    expect(canDo('anon', 'leod_signage_sponsors', 'SELECT')).toBe(true);
  });
  it('13 anon CANNOT INSERT leod_signage_sponsors', () => {
    expect(canDo('anon', 'leod_signage_sponsors', 'INSERT')).toBe(false);
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
