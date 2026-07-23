// tests/checkin-rls.spec.ts
// Check-in module security tests — validates policy assumptions and
// trigger behavior for all leod_checkin_* tables (migrations 044-049).
// These tests run without a live DB, following this repo's convention
// (see tests/rls.spec.ts): RLS policies and Postgres triggers aren't
// importable into vitest, so the SQL logic is re-expressed as plain
// JS/TS and asserted against here. This IS the specification, kept in
// sync by a human/reviewer diffing it against the real migration SQL
// in supabase/migrations/044_checkin_organizations.sql through
// 049_checkin_scan_events_print_jobs.sql.
//
// Part A (below) models the RLS policy grants themselves.
// Part B models the four BEFORE-trigger functions that close gaps RLS
// alone can't express (RLS can filter rows, but can't compare OLD vs
// NEW columns, or check foreign rows in another table declaratively).
// checkin_auto_grant_organizer() (migration 045, AFTER INSERT ON
// leod_events) is intentionally NOT modeled here — it's a single
// NULL-guard on a different table's trigger, not a leod_checkin_*
// cross-tenant check like the four below.

import { describe, it, expect } from 'vitest';

// ════════════════════════════════════════════════════════════════
// PART A — RLS policy model
// ════════════════════════════════════════════════════════════════

// checkin_role_for_event() returns one of these, or NULL (modeled as
// 'none' below) when the caller holds no leod_checkin_operators row
// for the event.
type CheckinRole = 'organizer' | 'crew' | 'api_consumer' | 'none';
// leod_organizations uses a different authorization axis entirely
// (org membership via leod_users.org_id), not an event operator role.
type OrgRole = 'member' | 'none';
type Role = CheckinRole | OrgRole;
type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface Policy {
  table: string;
  role: Role;
  ops: Op[];
}

// Mirrors the policies created in supabase/migrations/044-049 exactly.
// 'none' rows are intentionally omitted (or listed with ops: []) —
// canDo() returns false for anything not explicitly granted.
const POLICIES: Policy[] = [
  // ── leod_organizations (044) — member_read_org: SELECT only, no write policy at all ──
  { table: 'leod_organizations', role: 'member', ops: ['SELECT'] },
  { table: 'leod_organizations', role: 'none',   ops: [] },

  // ── leod_checkin_operators (045) ──
  // checkin_op_read: SELECT, any operator
  // checkin_op_write / checkin_op_update / checkin_op_delete: organizer only
  { table: 'leod_checkin_operators', role: 'organizer',    ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_operators', role: 'crew',         ops: ['SELECT'] },
  { table: 'leod_checkin_operators', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_operators', role: 'none',         ops: [] },

  // ── leod_checkin_entitlements (046) ──
  // checkin_ent_read: SELECT, any operator. NO write policy exists for
  // ANY role — writes only via checkin-enable-event's service-role client.
  { table: 'leod_checkin_entitlements', role: 'organizer',    ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', role: 'crew',         ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', role: 'none',         ops: [] },

  // ── leod_checkin_attendees (047) ──
  // checkin_att_read: SELECT any operator
  // checkin_att_write: INSERT organizer only
  // checkin_att_update: UPDATE organizer OR crew
  // checkin_att_delete: DELETE organizer only
  { table: 'leod_checkin_attendees', role: 'organizer',    ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_attendees', role: 'crew',         ops: ['SELECT', 'UPDATE'] },
  { table: 'leod_checkin_attendees', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_attendees', role: 'none',         ops: [] },

  // ── leod_checkin_scan_points (048) ──
  // checkin_sp_read: SELECT any operator
  // checkin_sp_write: ALL (SELECT/INSERT/UPDATE/DELETE), organizer only
  { table: 'leod_checkin_scan_points', role: 'organizer',    ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_scan_points', role: 'crew',         ops: ['SELECT'] },
  { table: 'leod_checkin_scan_points', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_scan_points', role: 'none',         ops: [] },

  // ── leod_checkin_devices (048) ──
  // checkin_dev_read: SELECT any operator
  // checkin_dev_write: ALL, organizer only
  { table: 'leod_checkin_devices', role: 'organizer',    ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_devices', role: 'crew',         ops: ['SELECT'] },
  { table: 'leod_checkin_devices', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_devices', role: 'none',         ops: [] },

  // ── leod_checkin_scan_events (049) ──
  // checkin_se_read: SELECT any operator
  // checkin_se_write: INSERT only, organizer OR crew
  // No UPDATE/DELETE policy exists for ANY role — append-only log.
  { table: 'leod_checkin_scan_events', role: 'organizer',    ops: ['SELECT', 'INSERT'] },
  { table: 'leod_checkin_scan_events', role: 'crew',         ops: ['SELECT', 'INSERT'] },
  { table: 'leod_checkin_scan_events', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_scan_events', role: 'none',         ops: [] },

  // ── leod_checkin_print_jobs (049) ──
  // checkin_pj_read: SELECT any operator (via attendee's event)
  // checkin_pj_write: ALL, organizer OR crew (via attendee's event)
  { table: 'leod_checkin_print_jobs', role: 'organizer',    ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_print_jobs', role: 'crew',         ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_print_jobs', role: 'api_consumer', ops: ['SELECT'] },
  { table: 'leod_checkin_print_jobs', role: 'none',         ops: [] },
];

function canDo(role: Role, table: string, op: Op): boolean {
  return POLICIES.some(p => p.table === table && p.role === role && p.ops.includes(op));
}

// All 8 tables covered by the model above, for exhaustive iteration.
const ALL_TABLES = [
  'leod_organizations',
  'leod_checkin_operators',
  'leod_checkin_entitlements',
  'leod_checkin_attendees',
  'leod_checkin_scan_points',
  'leod_checkin_devices',
  'leod_checkin_scan_events',
  'leod_checkin_print_jobs',
];

const ALL_OPS: Op[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

describe('Checkin RLS: no-grant-means-no-access', () => {
  it('01 a caller with no leod_checkin_operators row ("none") has zero access to every checkin_* table', () => {
    const checkinTables = ALL_TABLES.filter(t => t !== 'leod_organizations');
    for (const table of checkinTables) {
      for (const op of ALL_OPS) {
        expect(canDo('none', table, op)).toBe(false);
      }
    }
  });

  it('02 a non-member ("none") of an organization has zero access to leod_organizations', () => {
    for (const op of ALL_OPS) {
      expect(canDo('none', 'leod_organizations', op)).toBe(false);
    }
  });

  it('03 an org member can SELECT leod_organizations (member_read_org)', () => {
    expect(canDo('member', 'leod_organizations', 'SELECT')).toBe(true);
  });

  it('04 leod_organizations has no write policy at all, even for members', () => {
    expect(canDo('member', 'leod_organizations', 'INSERT')).toBe(false);
    expect(canDo('member', 'leod_organizations', 'UPDATE')).toBe(false);
    expect(canDo('member', 'leod_organizations', 'DELETE')).toBe(false);
  });
});

describe('Checkin RLS: organizer has full control', () => {
  it('05 organizer can SELECT/INSERT/UPDATE/DELETE leod_checkin_operators', () => {
    for (const op of ALL_OPS) expect(canDo('organizer', 'leod_checkin_operators', op)).toBe(true);
  });

  it('06 organizer can SELECT/INSERT/UPDATE/DELETE leod_checkin_attendees', () => {
    for (const op of ALL_OPS) expect(canDo('organizer', 'leod_checkin_attendees', op)).toBe(true);
  });

  it('07 organizer can SELECT/INSERT/UPDATE/DELETE leod_checkin_scan_points', () => {
    for (const op of ALL_OPS) expect(canDo('organizer', 'leod_checkin_scan_points', op)).toBe(true);
  });

  it('08 organizer can SELECT/INSERT/UPDATE/DELETE leod_checkin_devices', () => {
    for (const op of ALL_OPS) expect(canDo('organizer', 'leod_checkin_devices', op)).toBe(true);
  });

  it('09 organizer can SELECT/INSERT/UPDATE/DELETE leod_checkin_print_jobs', () => {
    for (const op of ALL_OPS) expect(canDo('organizer', 'leod_checkin_print_jobs', op)).toBe(true);
  });

  it('10 organizer can SELECT and INSERT leod_checkin_scan_events, but CANNOT UPDATE or DELETE (append-only, no policy exists)', () => {
    expect(canDo('organizer', 'leod_checkin_scan_events', 'SELECT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_scan_events', 'INSERT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_scan_events', 'UPDATE')).toBe(false);
    expect(canDo('organizer', 'leod_checkin_scan_events', 'DELETE')).toBe(false);
  });

  it('11 even organizer only has SELECT on leod_checkin_entitlements (no write policy exists for anyone)', () => {
    expect(canDo('organizer', 'leod_checkin_entitlements', 'SELECT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_entitlements', 'INSERT')).toBe(false);
    expect(canDo('organizer', 'leod_checkin_entitlements', 'UPDATE')).toBe(false);
    expect(canDo('organizer', 'leod_checkin_entitlements', 'DELETE')).toBe(false);
  });
});

describe('Checkin RLS: crew has a narrower scope than organizer', () => {
  it('12 crew can SELECT but CANNOT INSERT/UPDATE/DELETE leod_checkin_operators (organizer-only writes)', () => {
    expect(canDo('crew', 'leod_checkin_operators', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_operators', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_operators', 'UPDATE')).toBe(false);
    expect(canDo('crew', 'leod_checkin_operators', 'DELETE')).toBe(false);
  });

  it('13 crew can SELECT and UPDATE attendees, but CANNOT INSERT (create) or DELETE them', () => {
    expect(canDo('crew', 'leod_checkin_attendees', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_attendees', 'UPDATE')).toBe(true);
    expect(canDo('crew', 'leod_checkin_attendees', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_attendees', 'DELETE')).toBe(false);
  });

  it('14 crew can SELECT but CANNOT manage (INSERT/UPDATE/DELETE) scan_points', () => {
    expect(canDo('crew', 'leod_checkin_scan_points', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_scan_points', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_scan_points', 'UPDATE')).toBe(false);
    expect(canDo('crew', 'leod_checkin_scan_points', 'DELETE')).toBe(false);
  });

  it('15 crew can SELECT but CANNOT manage (INSERT/UPDATE/DELETE) devices', () => {
    expect(canDo('crew', 'leod_checkin_devices', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_devices', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_devices', 'UPDATE')).toBe(false);
    expect(canDo('crew', 'leod_checkin_devices', 'DELETE')).toBe(false);
  });

  it('16 crew can SELECT and INSERT scan_events (manual corrections), but CANNOT UPDATE/DELETE (no policy exists)', () => {
    expect(canDo('crew', 'leod_checkin_scan_events', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_scan_events', 'INSERT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_scan_events', 'UPDATE')).toBe(false);
    expect(canDo('crew', 'leod_checkin_scan_events', 'DELETE')).toBe(false);
  });

  it('17 crew has full print_jobs access (SELECT/INSERT/UPDATE/DELETE), same as organizer', () => {
    for (const op of ALL_OPS) expect(canDo('crew', 'leod_checkin_print_jobs', op)).toBe(true);
  });

  it('18 crew can only SELECT entitlements, same restriction as organizer', () => {
    expect(canDo('crew', 'leod_checkin_entitlements', 'SELECT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_entitlements', 'INSERT')).toBe(false);
  });
});

describe('Checkin RLS: api_consumer is read-only everywhere', () => {
  it('19 api_consumer can SELECT every checkin table but cannot INSERT/UPDATE/DELETE any of them', () => {
    const checkinTables = ALL_TABLES.filter(t => t !== 'leod_organizations');
    for (const table of checkinTables) {
      expect(canDo('api_consumer', table, 'SELECT')).toBe(true);
      expect(canDo('api_consumer', table, 'INSERT')).toBe(false);
      expect(canDo('api_consumer', table, 'UPDATE')).toBe(false);
      expect(canDo('api_consumer', table, 'DELETE')).toBe(false);
    }
  });
});

describe('Checkin RLS: leod_checkin_entitlements has ZERO write access for any role (Task 3 regression test)', () => {
  // This is a regression test for the fix made during Task 3's review:
  // a write policy was removed because it would let any event owner
  // self-grant paid feature flags, bypassing checkin-enable-event's
  // authorization. If a future migration re-adds a write policy here,
  // this test must fail.
  it('20 no role (organizer, crew, api_consumer, none) can INSERT into leod_checkin_entitlements', () => {
    const roles: CheckinRole[] = ['organizer', 'crew', 'api_consumer', 'none'];
    for (const role of roles) expect(canDo(role, 'leod_checkin_entitlements', 'INSERT')).toBe(false);
  });

  it('21 no role can UPDATE leod_checkin_entitlements', () => {
    const roles: CheckinRole[] = ['organizer', 'crew', 'api_consumer', 'none'];
    for (const role of roles) expect(canDo(role, 'leod_checkin_entitlements', 'UPDATE')).toBe(false);
  });

  it('22 no role can DELETE leod_checkin_entitlements', () => {
    const roles: CheckinRole[] = ['organizer', 'crew', 'api_consumer', 'none'];
    for (const role of roles) expect(canDo(role, 'leod_checkin_entitlements', 'DELETE')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// PART B — Trigger-behavior simulation
// ════════════════════════════════════════════════════════════════
// Each function below is a line-for-line re-expression of the actual
// deployed trigger body (cross-checked against the migration SQL after
// writing). If a test case here disagrees with the real SQL, the
// simulation is wrong — not the test.

// ── 1. checkin_lock_attendee_identity() — migration 047 ──────────
// Real SQL:
//   IF checkin_role_for_event(OLD.event_id) != 'organizer'
//      OR (NEW.event_id IS DISTINCT FROM OLD.event_id
//          AND checkin_role_for_event(NEW.event_id) != 'organizer') THEN
//     NEW.event_id := OLD.event_id;
//     NEW.qr_token := OLD.qr_token;
//   END IF;

interface AttendeeIdentityRow {
  event_id: string;
  qr_token: string;
  [key: string]: unknown;
}

function simulateLockAttendeeIdentity(
  oldRow: AttendeeIdentityRow,
  newRow: AttendeeIdentityRow,
  roleForEvent: (eventId: string) => CheckinRole,
): AttendeeIdentityRow {
  const result = { ...newRow };
  if (
    roleForEvent(oldRow.event_id) !== 'organizer' ||
    (newRow.event_id !== oldRow.event_id && roleForEvent(newRow.event_id) !== 'organizer')
  ) {
    result.event_id = oldRow.event_id;
    result.qr_token = oldRow.qr_token;
  }
  return result;
}

describe('Trigger: checkin_lock_attendee_identity (migration 047)', () => {
  it('23 crew on event A moving a row to event B and swapping qr_token: both reverted, but a concurrent name change still applies', () => {
    const roleForEvent = (eventId: string): CheckinRole => (eventId === 'A' ? 'crew' : 'none');
    const oldRow: AttendeeIdentityRow = { event_id: 'A', qr_token: 'tok-1', first_name: 'Jane' };
    const attemptedNew: AttendeeIdentityRow = { event_id: 'B', qr_token: 'tok-2', first_name: 'Janet' };

    const result = simulateLockAttendeeIdentity(oldRow, attemptedNew, roleForEvent);

    expect(result.event_id).toBe('A');       // reverted
    expect(result.qr_token).toBe('tok-1');    // reverted
    expect(result.first_name).toBe('Janet');  // unrelated column change still applies
  });

  it('24 organizer of A who is only crew on B attempts the same move: still reverted (symmetric gap, round 2 of Task 4 review)', () => {
    const roleForEvent = (eventId: string): CheckinRole => (eventId === 'A' ? 'organizer' : 'crew');
    const oldRow: AttendeeIdentityRow = { event_id: 'A', qr_token: 'tok-1' };
    const attemptedNew: AttendeeIdentityRow = { event_id: 'B', qr_token: 'tok-2' };

    const result = simulateLockAttendeeIdentity(oldRow, attemptedNew, roleForEvent);

    expect(result.event_id).toBe('A');
    expect(result.qr_token).toBe('tok-1');
  });

  it('25 organizer of BOTH A and B moving a row between them: allowed', () => {
    const roleForEvent = (): CheckinRole => 'organizer';
    const oldRow: AttendeeIdentityRow = { event_id: 'A', qr_token: 'tok-1' };
    const attemptedNew: AttendeeIdentityRow = { event_id: 'B', qr_token: 'tok-2' };

    const result = simulateLockAttendeeIdentity(oldRow, attemptedNew, roleForEvent);

    expect(result.event_id).toBe('B');
    expect(result.qr_token).toBe('tok-2');
  });

  it('26 organizer of the event making no event_id change can still change qr_token (lock is about moving events, not qr_token in general)', () => {
    const roleForEvent = (): CheckinRole => 'organizer';
    const oldRow: AttendeeIdentityRow = { event_id: 'A', qr_token: 'tok-1' };
    const attemptedNew: AttendeeIdentityRow = { event_id: 'A', qr_token: 'tok-reissued' };

    const result = simulateLockAttendeeIdentity(oldRow, attemptedNew, roleForEvent);

    expect(result.event_id).toBe('A');
    expect(result.qr_token).toBe('tok-reissued');
  });
});

// ── 2. checkin_validate_device_scan_point() — migration 048 ──────
// Real SQL:
//   IF NEW.scan_point_id IS NOT NULL AND NOT EXISTS (
//     SELECT 1 FROM leod_checkin_scan_points
//     WHERE id = NEW.scan_point_id AND event_id = NEW.event_id
//   ) THEN RAISE EXCEPTION ...

interface ScanPointRef { id: string; event_id: string; }
interface DeviceRow { event_id: string; scan_point_id: string | null; }

function simulateValidateDeviceScanPoint(
  device: DeviceRow,
  scanPoints: ScanPointRef[],
): { ok: true } | { ok: false; error: string } {
  if (device.scan_point_id !== null) {
    const exists = scanPoints.some(sp => sp.id === device.scan_point_id && sp.event_id === device.event_id);
    if (!exists) return { ok: false, error: 'scan_point_id must belong to the same event as the device' };
  }
  return { ok: true };
}

describe('Trigger: checkin_validate_device_scan_point (migration 048)', () => {
  const scanPoints: ScanPointRef[] = [
    { id: 'sp-a', event_id: 'A' },
    { id: 'sp-b', event_id: 'B' },
  ];

  it('27 device on event A pointing at a scan_point from event B: rejected', () => {
    const result = simulateValidateDeviceScanPoint({ event_id: 'A', scan_point_id: 'sp-b' }, scanPoints);
    expect(result.ok).toBe(false);
  });

  it('28 device on event A pointing at a scan_point from its own event A: allowed', () => {
    const result = simulateValidateDeviceScanPoint({ event_id: 'A', scan_point_id: 'sp-a' }, scanPoints);
    expect(result.ok).toBe(true);
  });

  it('29 device with no scan_point_id (checkin_station kind): allowed', () => {
    const result = simulateValidateDeviceScanPoint({ event_id: 'A', scan_point_id: null }, scanPoints);
    expect(result.ok).toBe(true);
  });
});

// ── 3. checkin_validate_scan_event_refs() — migration 049 ────────
// Real SQL: three independent IF ... IS NOT NULL AND NOT EXISTS ...
// RAISE EXCEPTION blocks, one each for attendee_id, scan_point_id,
// device_id.

interface AttendeeRef { id: string; event_id: string; }
interface DeviceRef { id: string; event_id: string; }
interface ScanEventRow {
  event_id: string;
  attendee_id: string | null;
  scan_point_id: string | null;
  device_id: string | null;
}

function simulateValidateScanEventRefs(
  se: ScanEventRow,
  attendees: AttendeeRef[],
  scanPoints: ScanPointRef[],
  devices: DeviceRef[],
): { ok: true } | { ok: false; error: string } {
  if (se.attendee_id !== null && !attendees.some(a => a.id === se.attendee_id && a.event_id === se.event_id)) {
    return { ok: false, error: 'attendee_id must belong to the same event as the scan event' };
  }
  if (se.scan_point_id !== null && !scanPoints.some(sp => sp.id === se.scan_point_id && sp.event_id === se.event_id)) {
    return { ok: false, error: 'scan_point_id must belong to the same event as the scan event' };
  }
  if (se.device_id !== null && !devices.some(d => d.id === se.device_id && d.event_id === se.event_id)) {
    return { ok: false, error: 'device_id must belong to the same event as the scan event' };
  }
  return { ok: true };
}

describe('Trigger: checkin_validate_scan_event_refs (migration 049)', () => {
  const attendees: AttendeeRef[] = [{ id: 'att-a', event_id: 'A' }, { id: 'att-b', event_id: 'B' }];
  const scanPoints: ScanPointRef[] = [{ id: 'sp-a', event_id: 'A' }, { id: 'sp-b', event_id: 'B' }];
  const devices: DeviceRef[] = [{ id: 'dev-a', event_id: 'A' }, { id: 'dev-b', event_id: 'B' }];

  it('30 cross-event attendee_id alone (scan_point_id/device_id null): rejected', () => {
    const result = simulateValidateScanEventRefs(
      { event_id: 'A', attendee_id: 'att-b', scan_point_id: null, device_id: null },
      attendees, scanPoints, devices,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('attendee_id') });
  });

  it('31 cross-event scan_point_id alone (attendee_id/device_id null): rejected', () => {
    const result = simulateValidateScanEventRefs(
      { event_id: 'A', attendee_id: null, scan_point_id: 'sp-b', device_id: null },
      attendees, scanPoints, devices,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('scan_point_id') });
  });

  it('32 cross-event device_id alone (attendee_id/scan_point_id null): rejected', () => {
    const result = simulateValidateScanEventRefs(
      { event_id: 'A', attendee_id: null, scan_point_id: null, device_id: 'dev-b' },
      attendees, scanPoints, devices,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('device_id') });
  });

  it('33 all three refs from the same event as the scan event: allowed', () => {
    const result = simulateValidateScanEventRefs(
      { event_id: 'A', attendee_id: 'att-a', scan_point_id: 'sp-a', device_id: 'dev-a' },
      attendees, scanPoints, devices,
    );
    expect(result.ok).toBe(true);
  });

  it('34 all three refs null (e.g. an unknown_token scan result with no attendee match): allowed', () => {
    const result = simulateValidateScanEventRefs(
      { event_id: 'A', attendee_id: null, scan_point_id: null, device_id: null },
      attendees, scanPoints, devices,
    );
    expect(result.ok).toBe(true);
  });
});

// ── 4. checkin_validate_print_job_device() — migration 049 ───────
// Real SQL:
//   IF TG_OP = 'UPDATE' AND NEW.attendee_id IS DISTINCT FROM OLD.attendee_id THEN
//     RAISE EXCEPTION 'attendee_id cannot be changed after a print job is created';
//   END IF;
//   IF NEW.device_id IS NOT NULL AND NOT EXISTS (
//     SELECT 1 FROM leod_checkin_attendees a JOIN leod_checkin_devices d ON d.event_id = a.event_id
//     WHERE a.id = NEW.attendee_id AND d.id = NEW.device_id
//   ) THEN RAISE EXCEPTION ...

interface PrintJobRow { attendee_id: string; device_id: string | null; status?: string; }

function simulateValidatePrintJobDevice(
  op: 'INSERT' | 'UPDATE',
  oldRow: PrintJobRow | null,
  newRow: PrintJobRow,
  attendees: AttendeeRef[],
  devices: DeviceRef[],
): { ok: true } | { ok: false; error: string } {
  if (op === 'UPDATE' && oldRow !== null && newRow.attendee_id !== oldRow.attendee_id) {
    return { ok: false, error: 'attendee_id cannot be changed after a print job is created' };
  }
  if (newRow.device_id !== null) {
    const attendee = attendees.find(a => a.id === newRow.attendee_id);
    const device = devices.find(d => d.id === newRow.device_id);
    const valid = attendee !== undefined && device !== undefined && attendee.event_id === device.event_id;
    if (!valid) return { ok: false, error: 'device_id must belong to the same event as the attendee' };
  }
  return { ok: true };
}

describe('Trigger: checkin_validate_print_job_device (migration 049)', () => {
  const attendees: AttendeeRef[] = [{ id: 'att-a', event_id: 'A' }];
  const devices: DeviceRef[] = [{ id: 'dev-a', event_id: 'A' }, { id: 'dev-b', event_id: 'B' }];

  it('35 INSERT with a cross-event device_id: rejected', () => {
    const result = simulateValidatePrintJobDevice(
      'INSERT', null, { attendee_id: 'att-a', device_id: 'dev-b' }, attendees, devices,
    );
    expect(result.ok).toBe(false);
  });

  it('36 INSERT with a same-event device_id: allowed', () => {
    const result = simulateValidatePrintJobDevice(
      'INSERT', null, { attendee_id: 'att-a', device_id: 'dev-a' }, attendees, devices,
    );
    expect(result.ok).toBe(true);
  });

  it('37 UPDATE changing only status (attendee_id and device_id unchanged): allowed', () => {
    const oldRow: PrintJobRow = { attendee_id: 'att-a', device_id: 'dev-a', status: 'queued' };
    const newRow: PrintJobRow = { attendee_id: 'att-a', device_id: 'dev-a', status: 'printing' };
    const result = simulateValidatePrintJobDevice('UPDATE', oldRow, newRow, attendees, devices);
    expect(result.ok).toBe(true);
  });

  it('38 UPDATE attempting to change attendee_id on a job with device_id IS NULL (common "just queued" case): rejected', () => {
    const oldRow: PrintJobRow = { attendee_id: 'att-a', device_id: null, status: 'queued' };
    const newRow: PrintJobRow = { attendee_id: 'att-other', device_id: null, status: 'queued' };
    const result = simulateValidatePrintJobDevice('UPDATE', oldRow, newRow, attendees, devices);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('attendee_id') });
  });

  it('39 UPDATE attempting to change attendee_id where device_id is also set: rejected (attendee_id check fires first)', () => {
    const oldRow: PrintJobRow = { attendee_id: 'att-a', device_id: 'dev-a', status: 'printing' };
    const newRow: PrintJobRow = { attendee_id: 'att-other', device_id: 'dev-a', status: 'printing' };
    const result = simulateValidatePrintJobDevice('UPDATE', oldRow, newRow, attendees, devices);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('attendee_id cannot be changed') });
  });
});
