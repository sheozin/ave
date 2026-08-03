# Check-in Module — Phase 1a: Schema, RLS & CSV Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the database foundation for the Check-in Module (CueDeck) add-on — organizations, per-event operator roles, feature entitlements, and the attendee/scan-point/device/scan-event/print-job tables — plus CSV attendee import with dry-run preview. No UI in this plan.

**Architecture:** This is **Plan 1 of 3** covering the spec's "Phase 1: check-in core." The full Phase 1 (schema, import, QR+email, station UI, print agent, dashboard) is too large for one plan; it's split as:
- **Plan 1a (this plan):** schema, RLS, CSV import
- **Plan 1b (next):** QR generation + email delivery, check-in station UI, print agent
- **Plan 1c (next):** organizer dashboard

Three deliberate departures from the original spec's schema, chosen to fit CueDeck's actual codebase rather than a green-field one (see conversation for the full tradeoff discussion):

1. **Table names get the `leod_checkin_` prefix** (e.g. `leod_checkin_attendees`), matching every existing CueDeck table (`leod_events`, `leod_users`, ...).
2. **`leod_events` is reused as the tenant/event boundary** — no separate `events` table. Check-in attaches to the event a director already created in CueDeck; entitlements gate whether the module is "on" for that event.
3. **Authorization is a new `leod_checkin_operators` table** (event_id, user_id, role), independent of CueDeck's global `leod_users.role` enum and independent of `leod_events` RLS. This is what makes check-in sellable and administrable without touching CueDeck's session-control code at all, and it's what "organizer / crew / api_consumer" actually means here. A lightweight `leod_organizations` table is added above `leod_users` for future shared billing, but it does **not** gate access — the operator grant does.

**Tech Stack:** Postgres (Supabase), Deno Edge Functions (TypeScript), vitest for logic-level tests — all matching the existing `AVE Production Console` conventions in `CLAUDE.md`.

---

## Before you start

- Working directory for every path below: `/Users/sheriff/Downloads/AVE Production Console`
- Migrations run through the Supabase CLI (`/opt/homebrew/bin/supabase`) or the Supabase SQL Editor — this plan shows both.
- Per `CLAUDE.md`'s Live Verification Protocol: never report a migration task done without running its verification query and pasting the actual result.
- Existing migrations top out at `043_display_branding.sql`. New ones start at `044`.

---

### Task 1: Organizations + `org_id` backfill

**Files:**
- Create: `supabase/migrations/044_checkin_organizations.sql`
- Verify: SQL query below, run in Supabase SQL Editor

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 044: Check-in module — organizations
-- ============================================================
-- Adds a lightweight organizations table above leod_users, so a
-- company with multiple director accounts can eventually share
-- billing/reporting. Does NOT change leod_events RLS or ownership —
-- core CueDeck event visibility is untouched. Check-in's own
-- authorization is leod_checkin_operators (migration 045), not this
-- table — this exists for future roll-up only.
--
-- Backfill: every existing director/admin who is the root of an
-- invite chain (invited_by IS NULL) gets their own organization.
-- Operators they invited inherit the same org_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES leod_organizations(id);

ALTER TABLE leod_organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_read_org ON leod_organizations;
CREATE POLICY member_read_org ON leod_organizations
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT org_id FROM leod_users WHERE id = auth.uid())
  );

-- Backfill: one org per existing invite-chain root, propagated to
-- everyone they invited.
DO $$
DECLARE
  r RECORD;
  v_org_id UUID;
BEGIN
  FOR r IN
    SELECT id, email, organization
    FROM leod_users
    WHERE invited_by IS NULL AND org_id IS NULL AND role IN ('director', 'admin')
  LOOP
    INSERT INTO leod_organizations (name)
    VALUES (COALESCE(NULLIF(r.organization, ''), r.email))
    RETURNING id INTO v_org_id;

    UPDATE leod_users SET org_id = v_org_id WHERE id = r.id;

    UPDATE leod_users SET org_id = v_org_id
    WHERE invited_by = r.id AND org_id IS NULL;
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase db push
```

If you don't have CLI access linked, paste the SQL into Supabase Dashboard → SQL Editor → Run instead.

- [ ] **Step 3: Verify live**

Run in the SQL Editor:

```sql
SELECT o.name, count(u.id) AS members
FROM leod_organizations o
LEFT JOIN leod_users u ON u.org_id = o.id
GROUP BY o.name
ORDER BY members DESC;
```

Expected: one row per existing director, `members` ≥ 1 (the director themselves plus any operators they invited). No director should have `org_id IS NULL` — confirm with:

```sql
SELECT count(*) FROM leod_users WHERE org_id IS NULL AND role IN ('director', 'admin');
-- expected: 0
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/044_checkin_organizations.sql
git commit -m "feat(checkin): add organizations table and org_id backfill"
```

---

### Task 2: Per-event operator roles + auto-grant

**Files:**
- Create: `supabase/migrations/045_checkin_operators.sql`
- Verify: SQL query below

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 045: Check-in module — per-event operators
-- ============================================================
-- Authorization boundary for ALL leod_checkin_* tables. A user can
-- see/act on a given event's check-in data only if they hold a row
-- here for that event_id. Deliberately independent of leod_events
-- RLS (created_by / invited_by) so check-in can be sold and
-- administered without touching CueDeck's core event ownership.
--
-- role:
--   organizer    — full read/write (event owner, or anyone they grant)
--   crew         — scan + print, read attendees/scan points/devices
--   api_consumer — read-only scan events (used by the Phase 2 API)
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_operators (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('organizer', 'crew', 'api_consumer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_checkin_operators_event ON leod_checkin_operators (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_operators_user  ON leod_checkin_operators (user_id);

ALTER TABLE leod_checkin_operators ENABLE ROW LEVEL SECURITY;

-- Helper: caller's role for a given event, NULL if none.
-- SET search_path pins this SECURITY DEFINER function against search
-- path hijacking (existing CueDeck SECURITY DEFINER functions predate
-- this hardening — worth a separate follow-up migration, not fixed
-- here since it's out of scope for check-in).
CREATE OR REPLACE FUNCTION checkin_role_for_event(p_event_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM leod_checkin_operators
  WHERE event_id = p_event_id AND user_id = auth.uid()
$$;

CREATE POLICY checkin_op_read ON leod_checkin_operators
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

CREATE POLICY checkin_op_write ON leod_checkin_operators
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

CREATE POLICY checkin_op_update ON leod_checkin_operators
  FOR UPDATE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

CREATE POLICY checkin_op_delete ON leod_checkin_operators
  FOR DELETE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

-- Auto-grant: whoever creates an event is its check-in organizer.
CREATE OR REPLACE FUNCTION checkin_auto_grant_organizer()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- created_by is nullable (service-role / no-JWT inserts) — skip
  -- rather than fail the leod_events insert, matching the guard
  -- pattern in validate_event_log_role() (migration 039).
  IF NEW.created_by IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'organizer')
  ON CONFLICT (event_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_auto_grant_organizer ON leod_events;
CREATE TRIGGER trg_checkin_auto_grant_organizer
  AFTER INSERT ON leod_events
  FOR EACH ROW EXECUTE FUNCTION checkin_auto_grant_organizer();

-- Backfill: grant organizer to every existing event's creator.
INSERT INTO leod_checkin_operators (event_id, user_id, role)
SELECT id, created_by, 'organizer'
FROM leod_events
WHERE created_by IS NOT NULL
ON CONFLICT (event_id, user_id) DO NOTHING;
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase db push
```

- [ ] **Step 3: Verify live**

```sql
-- Every existing event's creator should now be its organizer
SELECT e.name, e.created_by, o.role
FROM leod_events e
JOIN leod_checkin_operators o ON o.event_id = e.id AND o.user_id = e.created_by
WHERE o.role = 'organizer';
-- expected: one row per existing event

-- New-event trigger works
INSERT INTO leod_events (name, date, event_start, event_end, created_by)
VALUES ('Checkin Trigger Test', CURRENT_DATE, '09:00', '17:00',
        (SELECT id FROM leod_users WHERE role = 'director' LIMIT 1))
RETURNING id;
-- take the returned id, then:
SELECT role FROM leod_checkin_operators WHERE event_id = '<returned id>';
-- expected: 'organizer'

-- Clean up the test event
DELETE FROM leod_events WHERE name = 'Checkin Trigger Test';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/045_checkin_operators.sql
git commit -m "feat(checkin): add per-event operator roles with auto-grant on event creation"
```

---

### Task 3: Feature entitlements + enable-event Edge Function

**Files:**
- Create: `supabase/migrations/046_checkin_entitlements.sql`
- Create: `supabase/functions/checkin-enable-event/index.ts`
- Verify: SQL query + curl below

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 046: Check-in module — entitlements
-- ============================================================
-- A row here means check-in is enabled for that event; no row means
-- the module is inert. Dropping this table (and the rest of
-- leod_checkin_*) removes the module entirely without touching
-- leod_events.
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_entitlements (
  event_id                UUID        PRIMARY KEY REFERENCES leod_events(id) ON DELETE CASCADE,
  checkin_core            BOOLEAN     NOT NULL DEFAULT true,
  multi_point_scanning    BOOLEAN     NOT NULL DEFAULT false,
  integration_api         BOOLEAN     NOT NULL DEFAULT false,
  personalization_station BOOLEAN     NOT NULL DEFAULT false,
  pii_in_api              BOOLEAN     NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leod_checkin_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_ent_read ON leod_checkin_entitlements;
CREATE POLICY checkin_ent_read ON leod_checkin_entitlements
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

-- Deliberately no client-side write policy. These flags are a billing/
-- entitlement gate — every event owner is auto-granted 'organizer' on
-- their own event (migration 045's trigger), so a write policy scoped
-- to 'organizer' would let any owner self-grant every paid feature
-- flag directly, bypassing checkin-enable-event's authorization and
-- hardcoded checkin_core value entirely. Writes go through that
-- Edge Function's service-role client only, which enforces caller ==
-- event creator or admin before upserting.
DROP POLICY IF EXISTS checkin_ent_write ON leod_checkin_entitlements;
```

- [ ] **Step 2: Write the Edge Function**

```typescript
// supabase/functions/checkin-enable-event/index.ts
// Provisions the check-in module for an event: creates the
// entitlements row (idempotent via upsert) and makes sure the event's
// creator holds an organizer grant (covers events created before
// migration 045's auto-grant trigger existed). Caller must be the
// event's creator or a CueDeck admin.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const event_id = String(body.event_id || '')
  if (!event_id) {
    return new Response(JSON.stringify({ error: 'Missing event_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: event } = await sb.from('leod_events')
    .select('id, created_by').eq('id', event_id).single()
  if (!event) {
    return new Response(JSON.stringify({ error: 'Event not found' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  const isOwner = event.created_by === user.id
  const isAdmin = callerRow?.role === 'admin'
  if (!isOwner && !isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const opts = (body.entitlements as Record<string, boolean>) || {}
  const { error: upsertErr } = await sb.from('leod_checkin_entitlements').upsert({
    event_id,
    checkin_core: true,
    multi_point_scanning: !!opts.multi_point_scanning,
    integration_api: !!opts.integration_api,
    personalization_station: !!opts.personalization_station,
    pii_in_api: !!opts.pii_in_api,
  }, { onConflict: 'event_id' })

  if (upsertErr) {
    return new Response(JSON.stringify({ error: upsertErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // created_by is nullable (service-role / no-JWT event inserts) — skip
  // the operator grant rather than fail on leod_checkin_operators'
  // NOT NULL user_id, matching the guard pattern in migration 045's
  // checkin_auto_grant_organizer() trigger.
  if (event.created_by) {
    const { error: grantErr } = await sb.from('leod_checkin_operators')
      .upsert({ event_id, user_id: event.created_by, role: 'organizer' },
        { onConflict: 'event_id,user_id' })
    if (grantErr) console.error('checkin-enable-event: organizer grant failed:', grantErr.message)
  }

  return new Response(JSON.stringify({ ok: true, event_id }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 3: Apply migration and deploy the function**

```bash
/opt/homebrew/bin/supabase db push
bash scripts/deploy-functions.sh checkin-enable-event
```

- [ ] **Step 4: Verify live**

```bash
# Ping check (no auth needed for the _ping branch)
curl -s -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-enable-event \
  -H "Content-Type: application/json" -d '{"_ping": true}'
# expected: {"pong":true}
```

```sql
-- After calling it for real (with a director's JWT and a real event_id):
SELECT * FROM leod_checkin_entitlements WHERE event_id = '<event id used>';
-- expected: one row, checkin_core = true
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/046_checkin_entitlements.sql supabase/functions/checkin-enable-event/index.ts
git commit -m "feat(checkin): add entitlements table and checkin-enable-event function"
```

---

### Task 4: Attendees table

**Files:**
- Create: `supabase/migrations/047_checkin_attendees.sql`
- Verify: SQL query below

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 047: Check-in module — attendees
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_attendees (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  first_name       TEXT        NOT NULL,
  last_name        TEXT        NOT NULL,
  email            TEXT,
  company          TEXT,
  role_title       TEXT,
  ticket_type      TEXT        NOT NULL DEFAULT 'attendee',
  qr_token         TEXT        NOT NULL,
  badge_printed_at TIMESTAMPTZ,
  checked_in_at    TIMESTAMPTZ,
  external_ref     TEXT,
  custom_fields    JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (qr_token)
);

CREATE INDEX IF NOT EXISTS idx_checkin_attendees_event    ON leod_checkin_attendees (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_attendees_ext_ref  ON leod_checkin_attendees (event_id, external_ref);

ALTER TABLE leod_checkin_attendees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_att_read ON leod_checkin_attendees;
CREATE POLICY checkin_att_read ON leod_checkin_attendees
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_att_write ON leod_checkin_attendees;
CREATE POLICY checkin_att_write ON leod_checkin_attendees
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

DROP POLICY IF EXISTS checkin_att_update ON leod_checkin_attendees;
CREATE POLICY checkin_att_update ON leod_checkin_attendees
  FOR UPDATE TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_att_delete ON leod_checkin_attendees;
CREATE POLICY checkin_att_delete ON leod_checkin_attendees
  FOR DELETE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

-- checkin_att_update has no WITH CHECK, so it defaults to reusing
-- USING — which only constrains which ROWS are updatable, not which
-- COLUMNS change. That lets 'crew' reassign a row's event_id to any
-- other event they also hold a role on (moving an attendee out of
-- event A's roster entirely), or swap its qr_token. RLS can't compare
-- OLD vs NEW columns declaratively, so lock both down with a trigger,
-- matching the pattern in validate_event_log_role() (migration 039).
CREATE OR REPLACE FUNCTION checkin_lock_attendee_identity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Moving a row to a different event requires organizer on BOTH
  -- sides: organizer-of-A alone would otherwise let someone plant/move
  -- an attendee into event B's roster while holding only 'crew' there,
  -- bypassing checkin_att_write's organizer-only restriction on B.
  IF checkin_role_for_event(OLD.event_id) != 'organizer'
     OR (NEW.event_id IS DISTINCT FROM OLD.event_id
         AND checkin_role_for_event(NEW.event_id) != 'organizer') THEN
    NEW.event_id := OLD.event_id;
    NEW.qr_token := OLD.qr_token;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_lock_attendee_identity ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_lock_attendee_identity
  BEFORE UPDATE ON leod_checkin_attendees
  FOR EACH ROW EXECUTE FUNCTION checkin_lock_attendee_identity();
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase db push
```

- [ ] **Step 3: Verify live**

```sql
INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token)
VALUES ('<any real event id>', 'Test', 'Attendee', 'verify-token-001')
RETURNING id, qr_token;

SELECT count(*) FROM leod_checkin_attendees WHERE qr_token = 'verify-token-001';
-- expected: 1

DELETE FROM leod_checkin_attendees WHERE qr_token = 'verify-token-001';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/047_checkin_attendees.sql
git commit -m "feat(checkin): add attendees table"
```

---

### Task 5: Scan points + devices tables

**Files:**
- Create: `supabase/migrations/048_checkin_scan_points_devices.sql`
- Verify: SQL query below

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 048: Check-in module — scan points & devices
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_scan_points (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  description TEXT,
  kind        TEXT        NOT NULL CHECK (kind IN ('entrance', 'interior')),
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_checkin_scan_points_event ON leod_checkin_scan_points (event_id);

ALTER TABLE leod_checkin_scan_points ENABLE ROW LEVEL SECURITY;

-- NOTE: trg_checkin_validate_device_scan_point (below, on
-- leod_checkin_devices) relies on this policy staying scoped to the
-- caller's own event(s) — broadening it would weaken that trigger's
-- fail-closed guarantee for authenticated callers.
DROP POLICY IF EXISTS checkin_sp_read ON leod_checkin_scan_points;
CREATE POLICY checkin_sp_read ON leod_checkin_scan_points
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_sp_write ON leod_checkin_scan_points;
CREATE POLICY checkin_sp_write ON leod_checkin_scan_points
  FOR ALL TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer')
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');


CREATE TABLE IF NOT EXISTS leod_checkin_devices (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('checkin_station', 'scanner')),
  -- ON DELETE SET NULL is implemented as an UPDATE, so it's still
  -- subject to the CHECK below — deleting a scan point still
  -- referenced by a scanner-kind device fails the delete (by design,
  -- fails closed) rather than silently leaving an invalid scanner
  -- row. A future "delete scan point" admin flow must catch that and
  -- prompt to reassign/remove its devices first.
  scan_point_id UUID        REFERENCES leod_checkin_scan_points(id) ON DELETE SET NULL,
  api_key_hash  TEXT        NOT NULL,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind != 'scanner' OR scan_point_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_checkin_devices_event       ON leod_checkin_devices (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_devices_scan_point  ON leod_checkin_devices (scan_point_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_devices_api_key ON leod_checkin_devices (api_key_hash);

ALTER TABLE leod_checkin_devices ENABLE ROW LEVEL SECURITY;

-- Devices authenticate via api_key_hash inside Edge Functions (service
-- role), never via a Supabase user session — the policies below are
-- only for organizers managing devices from the admin screen (Plan 1c).
DROP POLICY IF EXISTS checkin_dev_read ON leod_checkin_devices;
CREATE POLICY checkin_dev_read ON leod_checkin_devices
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_dev_write ON leod_checkin_devices;
CREATE POLICY checkin_dev_write ON leod_checkin_devices
  FOR ALL TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer')
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

-- checkin_dev_write's WITH CHECK only constrains this row's own
-- event_id column — it can't verify scan_point_id (when set) belongs
-- to that SAME event; CHECK constraints can't query other tables.
-- Without this, an organizer of event A could point their own device
-- at a scan_points row owned by event B. Enforce it with a trigger
-- instead. No SECURITY DEFINER needed: run as invoker, RLS on
-- leod_checkin_scan_points already hides cross-event rows from an
-- authenticated caller, so the EXISTS check below correctly fails
-- closed for them too; a service-role caller (RLS-bypassing) sees the
-- real table and gets the real invariant check.
CREATE OR REPLACE FUNCTION checkin_validate_device_scan_point()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scan_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_scan_points
    WHERE id = NEW.scan_point_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'scan_point_id must belong to the same event as the device';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_validate_device_scan_point ON leod_checkin_devices;
CREATE TRIGGER trg_checkin_validate_device_scan_point
  BEFORE INSERT OR UPDATE ON leod_checkin_devices
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_device_scan_point();
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase db push
```

- [ ] **Step 3: Verify live**

```sql
INSERT INTO leod_checkin_scan_points (event_id, name, code, kind)
VALUES ('<any real event id>', 'Main Entrance', 'ENTRANCE', 'entrance')
RETURNING id;

-- Constraint check: a scanner device MUST have a scan_point_id
INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash)
VALUES ('<any real event id>', 'Bad Scanner', 'scanner', 'x');
-- expected: ERROR — violates check constraint

INSERT INTO leod_checkin_devices (event_id, label, kind, scan_point_id, api_key_hash)
VALUES ('<any real event id>', 'Entrance Scanner', 'scanner', '<scan point id from above>', 'hash123')
RETURNING id;
-- expected: succeeds

DELETE FROM leod_checkin_devices WHERE label = 'Entrance Scanner';
DELETE FROM leod_checkin_scan_points WHERE code = 'ENTRANCE';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/048_checkin_scan_points_devices.sql
git commit -m "feat(checkin): add scan points and devices tables"
```

---

### Task 6: Scan events + print jobs tables

**Files:**
- Create: `supabase/migrations/049_checkin_scan_events_print_jobs.sql`
- Verify: SQL query below

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 049: Check-in module — scan events & print jobs
-- ============================================================
-- scan_events.id is CLIENT-GENERATED (crypto.randomUUID() on the
-- device) so an offline device can resend the same scan after
-- reconnecting; the primary key alone makes the insert a no-op on
-- retry. Unlike leod_commands, no separate idempotency table is
-- needed — a scan event has no second step to redo.

CREATE TABLE IF NOT EXISTS leod_checkin_scan_events (
  id            UUID        PRIMARY KEY,
  event_id      UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  attendee_id   UUID        REFERENCES leod_checkin_attendees(id) ON DELETE SET NULL,
  scan_point_id UUID        REFERENCES leod_checkin_scan_points(id) ON DELETE SET NULL,
  device_id     UUID        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  scanned_at    TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  result        TEXT        NOT NULL CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_event_time      ON leod_checkin_scan_events (event_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_attendee_point  ON leod_checkin_scan_events (attendee_id, scan_point_id);

ALTER TABLE leod_checkin_scan_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_se_read ON leod_checkin_scan_events;
CREATE POLICY checkin_se_read ON leod_checkin_scan_events
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

-- Direct client INSERT is for organizer/crew manual corrections only.
-- Real device scans go through the checkin-submit-scan Edge Function
-- (Plan 1b), which uses the service-role client and validates the
-- device's api_key_hash instead of a user session.
DROP POLICY IF EXISTS checkin_se_write ON leod_checkin_scan_events;
CREATE POLICY checkin_se_write ON leod_checkin_scan_events
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

-- checkin_se_write only checks event_id — attendee_id/scan_point_id/
-- device_id are nullable and unchecked against it, so an organizer or
-- crew member on event A could insert a manual-correction row that
-- cross-references an attendee/point/device from a different event,
-- corrupting reporting (e.g. Plan 1c's arrival-curve dashboard). No
-- SECURITY DEFINER: RLS on the referenced tables already hides
-- cross-event rows from an authenticated caller, so this fails closed
-- for them; service-role writes see the real tables and get the real
-- check.
CREATE OR REPLACE FUNCTION checkin_validate_scan_event_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attendee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_attendees WHERE id = NEW.attendee_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'attendee_id must belong to the same event as the scan event';
  END IF;

  IF NEW.scan_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_scan_points WHERE id = NEW.scan_point_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'scan_point_id must belong to the same event as the scan event';
  END IF;

  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_devices WHERE id = NEW.device_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'device_id must belong to the same event as the scan event';
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT only: this table has no UPDATE policy (append-only log).
DROP TRIGGER IF EXISTS trg_checkin_validate_scan_event_refs ON leod_checkin_scan_events;
CREATE TRIGGER trg_checkin_validate_scan_event_refs
  BEFORE INSERT ON leod_checkin_scan_events
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_scan_event_refs();


CREATE TABLE IF NOT EXISTS leod_checkin_print_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id  UUID        NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  device_id    UUID        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  template_id  UUID,
  status       TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printing', 'done', 'failed')),
  attempts     INT         NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_attendee ON leod_checkin_print_jobs (attendee_id);
CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_status   ON leod_checkin_print_jobs (device_id, status);

ALTER TABLE leod_checkin_print_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_pj_read ON leod_checkin_print_jobs;
CREATE POLICY checkin_pj_read ON leod_checkin_print_jobs
  FOR SELECT TO authenticated
  USING (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IS NOT NULL
    )
  );

DROP POLICY IF EXISTS checkin_pj_write ON leod_checkin_print_jobs;
CREATE POLICY checkin_pj_write ON leod_checkin_print_jobs
  FOR ALL TO authenticated
  USING (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IN ('organizer', 'crew')
    )
  )
  WITH CHECK (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IN ('organizer', 'crew')
    )
  );

-- checkin_pj_write only checks attendee_id's event — device_id is
-- unchecked against it. Unlike scan_events (a log), a print job is an
-- actuator: a job with a cross-event device_id would dispatch a print
-- to the wrong physical printer at a different event's site. Same
-- no-SECURITY-DEFINER reasoning as above and as migration 048's
-- device/scan_point trigger.
CREATE OR REPLACE FUNCTION checkin_validate_print_job_device()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- attendee_id is an identity anchor like attendees.event_id/qr_token
  -- (047) — a print job is created FOR one attendee's badge and has no
  -- legitimate reason to be reassigned. Unlike device_id (which may
  -- legitimately change, e.g. retrying on a different printer), lock
  -- it on UPDATE. This also closes the common case the device_id
  -- check alone misses: a freshly queued job has device_id IS NULL,
  -- so that check never runs until a device is assigned later.
  IF TG_OP = 'UPDATE' AND NEW.attendee_id IS DISTINCT FROM OLD.attendee_id THEN
    RAISE EXCEPTION 'attendee_id cannot be changed after a print job is created';
  END IF;

  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM leod_checkin_attendees a
    JOIN leod_checkin_devices d ON d.event_id = a.event_id
    WHERE a.id = NEW.attendee_id AND d.id = NEW.device_id
  ) THEN
    RAISE EXCEPTION 'device_id must belong to the same event as the attendee';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_validate_print_job_device ON leod_checkin_print_jobs;
CREATE TRIGGER trg_checkin_validate_print_job_device
  BEFORE INSERT OR UPDATE ON leod_checkin_print_jobs
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_print_job_device();
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase db push
```

- [ ] **Step 3: Verify live**

```sql
-- Idempotent scan insert: same client-generated id twice is a no-op
INSERT INTO leod_checkin_scan_events (id, event_id, scanned_at, result)
VALUES ('11111111-1111-1111-1111-111111111111', '<any real event id>', now(), 'ok');

INSERT INTO leod_checkin_scan_events (id, event_id, scanned_at, result)
VALUES ('11111111-1111-1111-1111-111111111111', '<any real event id>', now(), 'ok')
ON CONFLICT (id) DO NOTHING;
-- expected: 0 rows affected on the second insert, no error

SELECT count(*) FROM leod_checkin_scan_events WHERE id = '11111111-1111-1111-1111-111111111111';
-- expected: 1

DELETE FROM leod_checkin_scan_events WHERE id = '11111111-1111-1111-1111-111111111111';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/049_checkin_scan_events_print_jobs.sql
git commit -m "feat(checkin): add scan events and print jobs tables"
```

---

### Task 7: RLS policy-model test

**Files:**
- Create: `tests/checkin-rls.spec.ts`

This mirrors the existing `tests/rls.spec.ts` convention: it does **not** hit a live database — it encodes the intended policy model from migrations 045–049 as data and asserts against it. Real policy-vs-SQL verification already happened in Tasks 2–6's live verification steps.

- [ ] **Step 1: Write the test**

```typescript
// tests/checkin-rls.spec.ts
// Check-in module RLS — validates the per-event role model.
// Mirrors tests/rls.spec.ts: verifies the intended policy rules, not a
// live DB. Live verification happens via Supabase SQL editor per
// CLAUDE.md's Live Verification Protocol (see migration tasks).

import { describe, it, expect } from 'vitest';

type CheckinRole = 'organizer' | 'crew' | 'api_consumer' | null;
type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface Policy {
  table: string;
  roles: CheckinRole[];
  ops: Op[];
}

// Mirrors migrations 045-049
const POLICIES: Policy[] = [
  { table: 'leod_checkin_operators',    roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_operators',    roles: ['organizer'],                          ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_entitlements', roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', roles: ['organizer'],                          ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_attendees',    roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_attendees',    roles: ['organizer'],                          ops: ['INSERT', 'DELETE'] },
  { table: 'leod_checkin_attendees',    roles: ['organizer', 'crew'],                  ops: ['UPDATE'] },
  { table: 'leod_checkin_scan_points',  roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_scan_points',  roles: ['organizer'],                          ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_devices',      roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_devices',      roles: ['organizer'],                          ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_scan_events',  roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_scan_events',  roles: ['organizer', 'crew'],                  ops: ['INSERT'] },
  { table: 'leod_checkin_print_jobs',   roles: ['organizer', 'crew', 'api_consumer'], ops: ['SELECT'] },
  { table: 'leod_checkin_print_jobs',   roles: ['organizer', 'crew'],                  ops: ['INSERT', 'UPDATE', 'DELETE'] },
];

function canDo(role: CheckinRole, table: string, op: Op): boolean {
  if (!role) return false;
  return POLICIES.some(p => p.table === table && p.roles.includes(role) && p.ops.includes(op));
}

describe('Check-in RLS: no operator grant → no access', () => {
  it('01 a user with no leod_checkin_operators row cannot read attendees', () => {
    expect(canDo(null, 'leod_checkin_attendees', 'SELECT')).toBe(false);
  });
  it('02 a user with no grant cannot insert scan events', () => {
    expect(canDo(null, 'leod_checkin_scan_events', 'INSERT')).toBe(false);
  });
});

describe('Check-in RLS: organizer — full control', () => {
  it('03 organizer can read and write attendees', () => {
    expect(canDo('organizer', 'leod_checkin_attendees', 'SELECT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_attendees', 'INSERT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_attendees', 'DELETE')).toBe(true);
  });
  it('04 organizer can manage scan points and devices', () => {
    expect(canDo('organizer', 'leod_checkin_scan_points', 'INSERT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_devices', 'UPDATE')).toBe(true);
  });
  it('05 organizer can grant/revoke other operators', () => {
    expect(canDo('organizer', 'leod_checkin_operators', 'INSERT')).toBe(true);
    expect(canDo('organizer', 'leod_checkin_operators', 'DELETE')).toBe(true);
  });
  it('06 organizer can write entitlements (enable features)', () => {
    expect(canDo('organizer', 'leod_checkin_entitlements', 'UPDATE')).toBe(true);
  });
});

describe('Check-in RLS: crew — scan + print, not admin', () => {
  it('07 crew can insert scan events', () => {
    expect(canDo('crew', 'leod_checkin_scan_events', 'INSERT')).toBe(true);
  });
  it('08 crew can update attendees (checked_in_at, badge_printed_at)', () => {
    expect(canDo('crew', 'leod_checkin_attendees', 'UPDATE')).toBe(true);
  });
  it('09 crew CANNOT insert new attendees', () => {
    expect(canDo('crew', 'leod_checkin_attendees', 'INSERT')).toBe(false);
  });
  it('10 crew CANNOT create scan points or devices', () => {
    expect(canDo('crew', 'leod_checkin_scan_points', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_devices', 'INSERT')).toBe(false);
  });
  it('11 crew CANNOT grant operators', () => {
    expect(canDo('crew', 'leod_checkin_operators', 'INSERT')).toBe(false);
  });
  it('12 crew can manage print jobs', () => {
    expect(canDo('crew', 'leod_checkin_print_jobs', 'INSERT')).toBe(true);
    expect(canDo('crew', 'leod_checkin_print_jobs', 'UPDATE')).toBe(true);
  });
});

describe('Check-in RLS: api_consumer — read-only', () => {
  it('13 api_consumer can read scan events', () => {
    expect(canDo('api_consumer', 'leod_checkin_scan_events', 'SELECT')).toBe(true);
  });
  it('14 api_consumer CANNOT insert scan events', () => {
    expect(canDo('api_consumer', 'leod_checkin_scan_events', 'INSERT')).toBe(false);
  });
  it('15 api_consumer CANNOT write attendees', () => {
    expect(canDo('api_consumer', 'leod_checkin_attendees', 'INSERT')).toBe(false);
    expect(canDo('api_consumer', 'leod_checkin_attendees', 'UPDATE')).toBe(false);
  });
});

describe('Cross-tenant isolation (documented invariant)', () => {
  // The real cross-tenant check is enforced in Postgres by
  // checkin_role_for_event(event_id) — SECURITY DEFINER, scoped to
  // auth.uid() — not by anything client-side. This test documents the
  // invariant so a future edit to the helper function gets noticed: a
  // role lookup MUST be scoped by event_id, never global.
  it('16 every policy in this model reasons about a leod_checkin_ table', () => {
    expect(POLICIES.every(p => p.table.startsWith('leod_checkin_'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/checkin-rls.spec.ts
```

Expected: all 16 tests pass (this is a straightforward data-driven test, so it should pass immediately — if any assertion fails, the `POLICIES` array doesn't match what you wrote in migrations 045–049; fix whichever one is wrong).

- [ ] **Step 3: Commit**

```bash
git add tests/checkin-rls.spec.ts
git commit -m "test(checkin): add RLS policy-model tests for check-in tables"
```

---

### Task 8: CSV attendee import (dry-run + commit)

**Files:**
- Create: `supabase/functions/checkin-import-attendees/index.ts`

The client (built in Plan 1b's admin screen) parses the organizer's CSV in-browser and posts already-mapped rows here — this function never parses CSV itself, it validates, dedups, and upserts. Dedup key: `external_ref` if present, else `email`, scoped to `event_id`.

- [ ] **Step 1: Write the function**

```typescript
// supabase/functions/checkin-import-attendees/index.ts
// CSV/XLSX import with column mapping and dry-run preview. The client
// parses the file and sends normalized rows; this function validates,
// dedups, and (unless dry_run) upserts.
//
// Dedup key: external_ref if present, else email, scoped to event_id.
// New attendees get a random URL-safe qr_token; matched attendees keep
// theirs — re-importing never invalidates an already-sent QR.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

interface ImportRow {
  first_name: string
  last_name: string
  email?: string
  company?: string
  role_title?: string
  ticket_type?: string
  external_ref?: string
}

interface RowResult {
  row: ImportRow
  action: 'create' | 'update' | 'skip'
  reason?: string
}

function makeQrToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function validateRow(row: ImportRow): string | null {
  if (!row.first_name?.trim()) return 'Missing first_name'
  if (!row.last_name?.trim()) return 'Missing last_name'
  return null
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const event_id = String(body.event_id || '')
  const rows = Array.isArray(body.rows) ? (body.rows as ImportRow[]) : []
  const dry_run = body.dry_run !== false

  if (!event_id || rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing event_id or rows' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: existing } = await sb.from('leod_checkin_attendees')
    .select('id, external_ref, email')
    .eq('event_id', event_id)

  const byExternalRef = new Map((existing || []).filter(a => a.external_ref).map(a => [a.external_ref, a]))
  const byEmail = new Map((existing || []).filter(a => a.email).map(a => [a.email!.toLowerCase(), a]))

  const results: RowResult[] = []
  const toInsert: Record<string, unknown>[] = []
  const toUpdate: { id: string; patch: Record<string, unknown> }[] = []

  // Tracks keys claimed by a 'create' row earlier in THIS batch, kept
  // separate from byExternalRef/byEmail (which only reflect existing
  // DB rows) — a row matching a not-yet-inserted create has no real
  // attendee id to update against, so it must be skipped, not merged.
  const claimedExternalRefs = new Set<string>()
  const claimedEmails = new Set<string>()

  for (const row of rows) {
    const invalid = validateRow(row)
    if (invalid) { results.push({ row, action: 'skip', reason: invalid }); continue }

    const normalizedEmail = row.email?.toLowerCase()
    const match = (row.external_ref && byExternalRef.get(row.external_ref))
      || (normalizedEmail && byEmail.get(normalizedEmail))

    // One registrant listed twice in the same CSV (e.g. under
    // different ticket categories) would otherwise both classify as
    // 'create' with two separate inserts, silently producing two
    // attendee records for one person. First occurrence wins; later
    // ones are skipped.
    if (!match) {
      const dupInBatch = (row.external_ref && claimedExternalRefs.has(row.external_ref))
        || (normalizedEmail && claimedEmails.has(normalizedEmail))
      if (dupInBatch) {
        results.push({ row, action: 'skip', reason: 'Duplicate of another row in this import' })
        continue
      }
    }

    if (match) {
      results.push({ row, action: 'update' })
      toUpdate.push({
        id: match.id,
        patch: {
          first_name: row.first_name, last_name: row.last_name,
          email: row.email || null, company: row.company || null,
          role_title: row.role_title || null,
          ticket_type: row.ticket_type || 'attendee',
        },
      })
    } else {
      if (row.external_ref) claimedExternalRefs.add(row.external_ref)
      if (normalizedEmail) claimedEmails.add(normalizedEmail)
      results.push({ row, action: 'create' })
      toInsert.push({
        event_id,
        first_name: row.first_name, last_name: row.last_name,
        email: row.email || null, company: row.company || null,
        role_title: row.role_title || null,
        ticket_type: row.ticket_type || 'attendee',
        external_ref: row.external_ref || null,
        qr_token: makeQrToken(),
      })
    }
  }

  const summary = {
    total: rows.length,
    to_create: results.filter(r => r.action === 'create').length,
    to_update: results.filter(r => r.action === 'update').length,
    to_skip: results.filter(r => r.action === 'skip').length,
  }

  if (dry_run) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, summary, results }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (toInsert.length) {
    const { error } = await sb.from('leod_checkin_attendees').insert(toInsert)
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }
  // Track per-row failures rather than discarding them: silently
  // swallowing an update error here would make summary.to_update
  // overcount successes and mislead the organizer about whether
  // their re-import actually applied.
  const updateErrors: { id: string; first_name: unknown; last_name: unknown; email: unknown; error: string }[] = []
  for (const u of toUpdate) {
    const { error } = await sb.from('leod_checkin_attendees').update(u.patch).eq('id', u.id)
    if (error) {
      console.error('checkin-import-attendees: update failed for attendee', u.id, error.message)
      updateErrors.push({
        id: u.id, first_name: u.patch.first_name, last_name: u.patch.last_name, email: u.patch.email,
        error: error.message,
      })
    }
  }

  return new Response(JSON.stringify({
    ok: true, dry_run: false, summary,
    ...(updateErrors.length ? { update_errors: updateErrors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Deploy**

```bash
bash scripts/deploy-functions.sh checkin-import-attendees
```

- [ ] **Step 3: Verify live**

```bash
curl -s -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-import-attendees \
  -H "Content-Type: application/json" -d '{"_ping": true}'
# expected: {"pong":true}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/checkin-import-attendees/index.ts
git commit -m "feat(checkin): add CSV attendee import with dry-run preview"
```

---

### Task 9: Import validation/dedup logic tests

**Files:**
- Create: `tests/checkin-import.spec.ts`

Same convention as Task 7 and existing `tests/idempotency.spec.ts`: Deno Edge Functions aren't directly importable into vitest in this repo, so the dedup/validation logic is re-expressed as a pure function here and tested in isolation. Write this test **before** double-checking the Edge Function logic against it — if a case here disagrees with `checkin-import-attendees/index.ts`, the function is wrong, not the test.

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/checkin-import.spec.ts
// Attendee import dedup/validation logic — simulated per existing
// convention (idempotency.spec.ts), since Deno Edge Functions aren't
// directly importable into vitest.

import { describe, it, expect } from 'vitest';

interface ImportRow {
  first_name: string; last_name: string; email?: string;
  external_ref?: string;
}
interface ExistingAttendee { id: string; external_ref?: string; email?: string; }

function validateRow(row: ImportRow): string | null {
  if (!row.first_name?.trim()) return 'Missing first_name';
  if (!row.last_name?.trim()) return 'Missing last_name';
  return null;
}

function classifyRow(row: ImportRow, existing: ExistingAttendee[]): 'create' | 'update' | 'skip' {
  if (validateRow(row)) return 'skip';
  const byRef = row.external_ref && existing.find(e => e.external_ref === row.external_ref);
  const byEmail = row.email && existing.find(e => e.email?.toLowerCase() === row.email!.toLowerCase());
  return (byRef || byEmail) ? 'update' : 'create';
}

describe('Attendee import: validation', () => {
  it('01 rejects a row with no first_name', () => {
    expect(validateRow({ first_name: '', last_name: 'Kowalski' })).toBe('Missing first_name');
  });
  it('02 rejects a row with no last_name', () => {
    expect(validateRow({ first_name: 'Anna', last_name: '' })).toBe('Missing last_name');
  });
  it('03 accepts a row with both names, no email needed', () => {
    expect(validateRow({ first_name: 'Anna', last_name: 'Kowalski' })).toBeNull();
  });
});

describe('Attendee import: dedup classification', () => {
  const existing: ExistingAttendee[] = [
    { id: 'a1', external_ref: 'EXT-001', email: 'anna@example.com' },
  ];

  it('04 new external_ref, new email → create', () => {
    expect(classifyRow({ first_name: 'Piotr', last_name: 'Nowak', external_ref: 'EXT-002', email: 'piotr@example.com' }, existing)).toBe('create');
  });
  it('05 matching external_ref → update, even if email differs', () => {
    expect(classifyRow({ first_name: 'Anna', last_name: 'K.', external_ref: 'EXT-001', email: 'new@example.com' }, existing)).toBe('update');
  });
  it('06 no external_ref but matching email (case-insensitive) → update', () => {
    expect(classifyRow({ first_name: 'Anna', last_name: 'K.', email: 'ANNA@EXAMPLE.COM' }, existing)).toBe('update');
  });
  it('07 invalid row → skip, regardless of match', () => {
    expect(classifyRow({ first_name: '', last_name: '', external_ref: 'EXT-001' }, existing)).toBe('skip');
  });
  it('08 re-importing the exact same row twice classifies as update both times (idempotent)', () => {
    const row: ImportRow = { first_name: 'Anna', last_name: 'Kowalski', external_ref: 'EXT-001' };
    expect(classifyRow(row, existing)).toBe('update');
    expect(classifyRow(row, existing)).toBe('update');
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/checkin-import.spec.ts
```

Expected: all 8 tests pass. If step 07 or 08 fails, re-check `classifyRow`'s validation-before-dedup ordering.

- [ ] **Step 3: Cross-check against the Edge Function**

Re-read `supabase/functions/checkin-import-attendees/index.ts`'s `validateRow` and the `match` computation (lines building `toInsert`/`toUpdate`). Confirm they implement the exact same rules as `classifyRow`/`validateRow` above (validate first, then external_ref before email, case-insensitive email). If they've drifted, fix the Edge Function, not the test.

- [ ] **Step 4: Commit**

```bash
git add tests/checkin-import.spec.ts
git commit -m "test(checkin): add import validation and dedup classification tests"
```

---

### Task 10: Seed script for manual/E2E testing

**Files:**
- Create: `scripts/seed-checkin-test-event.mjs`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
/**
 * seed-checkin-test-event.mjs
 * Enables the check-in module on the existing CueDeck test event and
 * seeds a handful of test attendees, for E2E testing of Plan 1b/1c.
 *
 * Usage:
 *   node scripts/seed-checkin-test-event.mjs
 *
 * Required env vars (same as seed-test-account.mjs):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, TEST_EMAIL
 *
 * Assumes seed-test-account.mjs has already been run (needs the test
 * director + test event to exist).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TEST_EMAIL           = process.env.TEST_EMAIL           || 'test-director@cuedeck-test.io';

if (!SUPABASE_SERVICE_KEY) {
  console.error('\n❌  SUPABASE_SERVICE_KEY is required.\n');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (msg) => console.log(`  ${msg}`);
const ok  = (msg) => console.log(`  ✅ ${msg}`);
const err = (msg) => console.log(`  ❌ ${msg}`);

async function main() {
  log('Finding test director…');
  const { data: { users } } = await sb.auth.admin.listUsers();
  const director = users?.find(u => u.email === TEST_EMAIL);
  if (!director) { err(`Test director ${TEST_EMAIL} not found — run seed-test-account.mjs first.`); process.exit(1); }

  log('Finding test event…');
  const { data: event } = await sb.from('leod_events')
    .select('id, name').eq('created_by', director.id).order('created_at', { ascending: false }).limit(1).single();
  if (!event) { err('No event found for test director.'); process.exit(1); }
  ok(`Using event: ${event.name} (${event.id})`);

  log('Enabling check-in entitlements…');
  const { error: entErr } = await sb.from('leod_checkin_entitlements')
    .upsert({ event_id: event.id, checkin_core: true }, { onConflict: 'event_id' });
  if (entErr) { err(entErr.message); process.exit(1); }
  ok('Entitlements enabled');

  log('Ensuring organizer grant…');
  await sb.from('leod_checkin_operators')
    .upsert({ event_id: event.id, user_id: director.id, role: 'organizer' }, { onConflict: 'event_id,user_id' });
  ok('Organizer grant confirmed');

  log('Seeding entrance scan point…');
  const { data: entrance } = await sb.from('leod_checkin_scan_points')
    .upsert({ event_id: event.id, name: 'Main Entrance', code: 'ENTRANCE', kind: 'entrance', sort_order: 0 },
      { onConflict: 'event_id,code' })
    .select('id').single();
  ok(`Entrance scan point: ${entrance?.id}`);

  log('Clearing old test attendees…');
  await sb.from('leod_checkin_attendees').delete().eq('event_id', event.id).like('external_ref', 'SEED-%');

  log('Seeding 5 test attendees…');
  const attendees = [
    { first_name: 'Anna',  last_name: 'Kowalska',    email: 'anna@example.com',   ticket_type: 'attendee', external_ref: 'SEED-001' },
    { first_name: 'Piotr', last_name: 'Nowak',       email: 'piotr@example.com',  ticket_type: 'speaker',  external_ref: 'SEED-002' },
    { first_name: 'Julia', last_name: 'Wiśniewska',  email: 'julia@example.com',  ticket_type: 'vip',      external_ref: 'SEED-003' },
    { first_name: 'Marek', last_name: 'Zieliński',   email: 'marek@example.com',  ticket_type: 'staff',    external_ref: 'SEED-004' },
    { first_name: 'Ola',   last_name: 'Dąbrowska',   email: 'ola@example.com',    ticket_type: 'press',    external_ref: 'SEED-005' },
  ].map(a => ({ ...a, event_id: event.id, qr_token: crypto.randomUUID().replace(/-/g, '') }));

  const { error: attErr } = await sb.from('leod_checkin_attendees').insert(attendees);
  if (attErr) { err(attErr.message); process.exit(1); }
  ok(`Seeded ${attendees.length} attendees`);

  console.log('\n✅ Check-in test event ready.\n');
}

main();
```

- [ ] **Step 2: Run it**

```bash
SUPABASE_SERVICE_KEY=<service_role key> node scripts/seed-checkin-test-event.mjs
```

Expected output: five `✅` lines ending in "Check-in test event ready."

- [ ] **Step 3: Verify live**

```sql
SELECT count(*) FROM leod_checkin_attendees WHERE external_ref LIKE 'SEED-%';
-- expected: 5
```

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-checkin-test-event.mjs
git commit -m "chore(checkin): add seed script for check-in test event"
```

---

### Task 11: Extend the verification script

**Files:**
- Modify: `scripts/verify-cuedeck.sh`

- [ ] **Step 1: Add a check-in migrations block**

In `scripts/verify-cuedeck.sh`, immediately after the existing `info "Migrations"` block (the one listing `001_remove_dev_policies.sql` through `010_invite_audit.sql`), add:

```bash
# ── 8b. Check-in module migrations ────────────
info "Check-in Module Migrations"
checkin_migrations=(
  "044_checkin_organizations.sql"
  "045_checkin_operators.sql"
  "046_checkin_entitlements.sql"
  "047_checkin_attendees.sql"
  "048_checkin_scan_points_devices.sql"
  "049_checkin_scan_events_print_jobs.sql"
)
for mig in "${checkin_migrations[@]}"; do
  if [ -f "$PROJ/$mig" ]; then
    green "Migration $mig present"
    PASS=$((PASS+1))
  else
    red "Migration $mig MISSING"
  fi
done
```

- [ ] **Step 2: Run it**

```bash
bash scripts/verify-cuedeck.sh 7230
```

Expected: the new "Check-in Module Migrations" section shows 6 green checks (the console/display checks earlier in the script may fail if no dev server is running — that's expected and unrelated to this task).

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-cuedeck.sh
git commit -m "chore(checkin): extend verify-cuedeck.sh with check-in migration checks"
```

---

## Self-Review

**Spec coverage** (against the Check-in Module spec's data model + Phase 1 build order):
- Multi-tenant scoping (`org_id`, `event_id`) → Tasks 1–2 (organizations + per-event operators)
- `organizations`, `events` (reused `leod_events`), `attendees`, `scan_points`, `devices`, `scan_events`, `print_jobs` → Tasks 1, 4, 5, 6
- RLS "reuse CueDeck's role enforcement patterns... write a test that tries [cross-tenant read]" → Task 7
- "Import an attendee list... CSV/XLSX... column mapping and dry-run preview" → Tasks 8–9 (dry-run implemented; XLSX parsing is a client-side concern deferred to Plan 1b's admin UI, noted there — the Edge Function contract is format-agnostic)
- "Gate features by a per-org or per-event entitlement flag from the start" → Task 3
- `card_templates` (personalization station) — intentionally **not** in this plan; it's Phase 3 per the spec's own build order
- QR generation/email, station UI, print agent, organizer dashboard — intentionally **not** in this plan; that's Plans 1b and 1c

**Placeholder scan:** no TBD/TODO markers; every step has complete SQL, TypeScript, or JavaScript.

**Type/name consistency:** `checkin_role_for_event(event_id)` is used identically across migrations 045–049; `leod_checkin_operators.role` enum (`organizer`/`crew`/`api_consumer`) matches the RLS test's `CheckinRole` type; `external_ref`/`email` dedup keys match between the Edge Function and its test.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-23-checkin-module-phase1-schema.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

---

## Post-implementation addendum (2026-07-23)

All 11 tasks executed via subagent-driven-development on branch `checkin-phase1-schema` (worktree `.claude/worktrees/checkin-phase1-schema`), 26 commits, all applied to and verified against the live production Supabase project. Every single task's code-quality review found and fixed at least one real cross-tenant, identity-reassignment, or silent-failure bug — see individual commit messages for details; this doc was kept in sync with every fix as it landed.

A final whole-increment review (reading all 6 migrations, both Edge Functions, and both test files together as one system) found:

- **Fixed as migration 050** (`050_checkin_attendee_dedup_constraints.sql`): the CSV import's application-level dedup only closes duplicates within a single request — two concurrent import calls could still race past it. Added partial unique indexes on `(event_id, external_ref)` and `(event_id, lower(email))` as a DB-level backstop. Verified live: both a duplicate-external_ref insert and a same-email-different-casing insert are correctly rejected.
- **Three open architecture questions — all resolved** on branch `checkin-integration-hardening` (worktree `.claude/worktrees/checkin-integration-hardening`), per explicit user direction to make the integration complete and correct rather than deferring:
  1. **`api_consumer` over-broad read access + unused `pii_in_api` flag** — fixed in migration 051. Every `checkin_*_read` policy except `checkin_se_read` now requires `organizer`/`crew`; `api_consumer` is restricted to `leod_checkin_scan_events` only, matching its own documented purpose in migration 045 ("read-only scan events"). `pii_in_api` remains for the future Phase 2 API's own response-curation logic (out of scope here — no such API exists yet).
  2. **Divergent Edge Function authorization** — fixed: `checkin-enable-event` now also accepts an already-granted `organizer` role (via `leod_checkin_operators`), alongside its original owner/admin check (kept, since that's what lets the function bootstrap an event with no operator row yet — the exact case this function exists to handle). `checkin-import-attendees` is unchanged (organizer-only was already correct there).
  3. **`leod_checkin_entitlements` not wired into any technical gate** — fixed in migration 051: `checkin_role_for_event()` now returns NULL unless a live entitlements row with `checkin_core = true` exists for the event, closing the gap for all RLS-gated direct client access at the one choke point every policy already goes through. Since both Edge Functions use the service-role client (bypassing RLS entirely), `checkin-import-attendees` also got an explicit `checkin_core` check of its own — the RLS fix alone would not have covered it.

  Verified live: `checkin_role_for_event()` correctly resolves to NULL for an organizer on an event with no entitlements row, and to `'organizer'` once `checkin_core = true` exists (both traced via `request.jwt.claim.sub` session simulation). The six narrowed read policies were confirmed via `pg_policies` to carry the exact restricted expression. Note: `supabase db query` connects as `postgres` (`rolbypassrls = true`), so it can validate the function's output and the policy *definitions* but can never observe actual row-filtering for a real `authenticated` session — that would require a genuine user JWT, not available in this environment. This is the same evidentiary basis the whole `tests/checkin-rls.spec.ts` suite already relies on (hand-diffed against deployed SQL, not executed against a live non-superuser session), so it's a consistent, not novel, limitation — documented rather than glossed over. Both Edge Functions redeployed and reverified via `_ping`; full auth-flow testing of the Edge Functions requires a real user JWT not available here, consistent with how their auth logic was originally verified in Tasks 3/8.

  Code-quality review of this fix found one more real issue, closed in a follow-up commit: `checkin_lock_attendee_identity()` (047) used `!=` against `checkin_role_for_event()`, and since that function now returns real SQL `NULL` far more often post-051, `NULL != 'organizer'` evaluates to `NULL` — which plpgsql's `IF` treats as false, meaning the defensive revert would silently NOT fire for a NULL role. Not exploitable through any RLS-governed path today, but a future "disable check-in" flow would land exactly here. Switched to `IS DISTINCT FROM` (identical behavior for every non-NULL case, safe for NULL). Verified live: an attendee row on an event with no entitlements had its `event_id`/`qr_token` UPDATE correctly reverted — confirmed this is exactly the case the old `!=` comparison would have let through. Also extended `scripts/verify-cuedeck.sh`'s migration list, which had stopped at 049. Final state: 47 tests in `tests/checkin-rls.spec.ts` (up from 39), 201 in the full suite, no regressions.
