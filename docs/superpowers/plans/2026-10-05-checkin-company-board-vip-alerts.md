# Check-in: Company Arrival Board and VIP Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship event-day features 4 (company arrival board) and 5 (VIP arrival alerts) to the check-in dashboard, Setup and the desk.

**Architecture:** Two migrations. 084 adds a read-only `checkin_company_board(event_id)`. 085 adds `alert_ticket_types` on the entitlement, a `leod_checkin_alerts` table written only by `checkin_apply_scan`, a setter RPC and a reader RPC that joins names. Realtime carries a bare row (no names) as a wake-up; the page then calls the reader RPC, and the existing refresh timers are the backstop if the socket dies. Pure shaping lives in `checkin-dashboard.js` and is unit-tested.

**Tech Stack:** Postgres (Supabase project `sawekpguemzvuvvulfbc`), plpgsql SECURITY DEFINER RPCs, Supabase Realtime `postgres_changes`, vanilla JS modules, vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md` (features 4 and 5 only; 6 is a later plan).

## Global Constraints

- Board: organizer, owner and lead only. Read through `checkin_company_board(event_id)`, SECURITY DEFINER. Filters **Not here yet** (0 arrived) and **Partly here**. Sorted by largest still missing.
- Alerts: `leod_checkin_entitlements.alert_ticket_types text[] default '{}'`, organizer-editable. The insert happens in `checkin_apply_scan`, in the same transaction, only for an `ok` scan.
- Alert copy: `"Ewa Sample (Speaker, Contoso Demo) just checked in at Desk 2"`, kept in a list for the day. Desk staff (crew) and viewers never receive them.
- The CueDeck console is out of scope.
- Migration numbers: 082 and 083 belong to parallel sessions. This plan uses **084** and **085**; re-check `ls supabase/migrations` and `supabase_migrations.schema_migrations` before applying.
- Since 079, new functions get no default EXECUTE: every new function needs an explicit `REVOKE ... FROM PUBLIC, anon` and `GRANT EXECUTE ... TO authenticated` (or service_role).
- `checkin_apply_scan` is replaced with the **live** definition plus the alert insert. Before writing 085, compare `md5(pg_get_functiondef)` on production with `8b0bb2a6021ef6e7252d0ed2e618006e` (read 2026-10-05, equal to the 071 body). If it differs, rebase on the live body.
- No names, companies or emails in Realtime payloads. Names reach the browser only through the reader RPC, which enforces the role.
- DOM: build every node with `textContent`; never `innerHTML` with data.
- Stage explicit file paths; commit with a pathspec (`git commit -- <files>`).

## Review Focus

1. **Company spellings:** `Acme`, ` ACME `, `acme  ` must be one row, labelled with the most common spelling. Pinned in the 084 probe.
2. **Ticket-type case:** an alert list holding `VIP` must fire for a guest whose ticket type is `vip ` (CSV imports vary). Pinned in the 085 probe.
3. **Undone check-in:** the alert stays (it happened) but is marked `still_in = false` and the line says the check-in was undone. Pinned in the 085 probe and the shaping test.
4. **Go-live:** test-mode alerts are deleted when the event goes live and are never returned once live. Pinned in the 085 probe.
5. **Crew and viewer:** both RPCs refuse them, and the RLS on `leod_checkin_alerts` hides rows from them (so Realtime does not deliver to them). Pinned in both probes.

---

### Task 1: Migration 084, company board RPC

**Files:**
- Create: `supabase/migrations/084_checkin_company_board.sql`
- Test: `tests/sql/084-company-board-probe.sql`

**Interfaces:**
- Produces: `checkin_company_board(p_event_id uuid) RETURNS jsonb`. The result is an array of `{company text, expected int, arrived int, last_arrival_at timestamptz|null}`, sorted by `expected - arrived` desc, then company. Companies that are null or blank are excluded.

- [ ] **Step 1: Write the probe** (`tests/sql/084-company-board-probe.sql`)

```sql
-- tests/sql/084-company-board-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 084'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_ev    uuid;
  v_b     jsonb;
  v_denied int := 0;
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_lead, v_crew, v_view]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 084', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'live');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  -- Acme: 3 spellings, 4 people, 1 in. Zeta: 2 people, 0 in. Solo: 1, 1 in.
  -- Two with no company (null, blank) must not appear.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, company, ticket_type, source, qr_token, checked_in_at)
  SELECT v_ev, 'P' || i, 'Probe', c, 'attendee', 'import', 'p084' || i || replace(gen_random_uuid()::text, '-', ''), t
    FROM (VALUES (1, 'Acme', now() - interval '5 minutes'), (2, ' ACME ', NULL), (3, 'acme  corp', NULL),
                 (4, 'Acme', NULL), (5, 'Zeta', NULL), (6, 'Zeta', NULL), (7, 'Solo', now() - interval '1 minute'),
                 (8, NULL, NULL), (9, '  ', NULL)) v(i, c, t);

  -- Owner, then lead: allowed.
  FOREACH r IN ARRAY ARRAY[v_owner, v_lead] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_b := checkin_company_board(v_ev);
    RESET ROLE;
  END LOOP;
  -- 'acme  corp' is a different company (whitespace collapses, words stay).
  IF jsonb_array_length(v_b) <> 4 THEN RAISE EXCEPTION 'FAIL rows %', v_b; END IF;
  IF v_b->0->>'company' <> 'Acme' OR (v_b->0->>'expected')::int <> 3 OR (v_b->0->>'arrived')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL acme merge/sort %', v_b->0; END IF;
  IF v_b->1->>'company' <> 'Zeta' OR (v_b->1->>'arrived')::int <> 0 OR v_b->1->>'last_arrival_at' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL zeta %', v_b->1; END IF;
  IF v_b::text ~* 'probe|P1' THEN RAISE EXCEPTION 'FAIL names leaked'; END IF;

  -- Crew and viewer: refused.
  FOREACH r IN ARRAY ARRAY[v_crew, v_view] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_company_board(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
  END LOOP;
  IF v_denied <> 2 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  RAISE EXCEPTION 'PROBE OK 084';
END
$probe$;
```

- [ ] **Step 2: Run the probe before the migration.** `execute_sql` on `sawekpguemzvuvvulfbc`. Expected: an error saying `function checkin_company_board(uuid) does not exist`.

- [ ] **Step 3: Write the migration** (`supabase/migrations/084_checkin_company_board.sql`)

```sql
-- 084_checkin_company_board.sql
-- Company arrival board (event-day spec, feature 4): per company, how
-- many are expected, how many arrived, and when the last one did.
-- Owner, organizer and lead only; desk staff and viewers are refused,
-- because company names are customer data the client view never shows.
-- Spellings that differ only in case or spacing are one company,
-- labelled with the spelling most guests carry. Guests with no company
-- are left out: "no company" is not a company to chase.
CREATE OR REPLACE FUNCTION checkin_company_board(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := checkin_role_for_event(p_event_id);
BEGIN
  IF auth.uid() IS NULL OR NOT (checkin_is_owner(p_event_id) OR COALESCE(v_role IN ('organizer', 'lead'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers and desk leads see the company board'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'company', label, 'expected', expected, 'arrived', arrived, 'last_arrival_at', last_at)
             ORDER BY expected - arrived DESC, label), '[]'::jsonb)
      FROM (SELECT mode() WITHIN GROUP (ORDER BY nm) AS label,
                   count(*)::int AS expected,
                   (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arrived,
                   max(checked_in_at) AS last_at
              FROM (SELECT checked_in_at,
                           regexp_replace(btrim(company), '\s+', ' ', 'g') AS nm
                      FROM leod_checkin_attendees
                     WHERE event_id = p_event_id AND NULLIF(btrim(company), '') IS NOT NULL) a
             GROUP BY lower(nm)) c);
END;
$$;
REVOKE ALL ON FUNCTION checkin_company_board(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_company_board(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
```

Note: `mode()` on the whitespace-collapsed spelling gives `Acme` (2 of 3) for the probe's Acme group. In a tie it picks the lowest value, which is deterministic.

- [ ] **Step 4: Apply and run the probe.** `apply_migration` name `checkin_company_board`, then `execute_sql` with the probe. Expected: `PROBE OK 084`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/084_checkin_company_board.sql tests/sql/084-company-board-probe.sql
git commit -m "feat(checkin): migration 084, company arrival board (applied)" -- supabase/migrations/084_checkin_company_board.sql tests/sql/084-company-board-probe.sql
```

---

### Task 2: Migration 085, VIP alerts in the database

**Files:**
- Create: `supabase/migrations/085_checkin_vip_alerts.sql`
- Test: `tests/sql/085-vip-alerts-probe.sql`

**Interfaces:**
- Produces:
  - `leod_checkin_entitlements.alert_ticket_types text[] NOT NULL DEFAULT '{}'`
  - table `leod_checkin_alerts (id uuid pk, event_id uuid, attendee_id uuid, ticket_type text, desk_id uuid null, is_test bool, created_at timestamptz)`, in publication `supabase_realtime`, RLS SELECT for owner, organizer and lead
  - `checkin_set_alert_ticket_types(p_event_id uuid, p_types text[]) RETURNS text[]` (organizer or owner; trims, drops blanks, dedupes case-insensitively, max 20 types of at most 80 chars)
  - `checkin_recent_alerts(p_event_id uuid) RETURNS jsonb`, an array of `{id, created_at, name, company, ticket_type, desk_label, still_in}`, newest first, max 50, owner, organizer and lead only
  - `checkin_apply_scan(...)`: same signature, also inserts the alert

- [ ] **Step 1: Verify the live `checkin_apply_scan` is unchanged.**

```sql
select md5(pg_get_functiondef(p.oid)) from pg_proc p where proname = 'checkin_apply_scan';
```
Expected: `8b0bb2a6021ef6e7252d0ed2e618006e`. If it differs, read `pg_get_functiondef` and use that body in Step 4.

- [ ] **Step 2: Write the probe** (`tests/sql/085-vip-alerts-probe.sql`)

```sql
-- tests/sql/085-vip-alerts-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 085'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_ev    uuid;
  v_vip   uuid := gen_random_uuid();
  v_std   uuid := gen_random_uuid();
  v_desk  uuid := gen_random_uuid();
  v_types text[];
  v_a     jsonb;
  v_n     int;
  v_denied int := 0;
  v_t     timestamptz := now() - interval '1 minute';
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_view]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 085', current_date, '00:00', '23:59', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)
  VALUES (v_ev, v_desk, 'Desk 2', v_crew, now(), 0, true);
  -- The guest list says 'vip ' (lower case, trailing space); the alert list says 'VIP'.
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, company, ticket_type, source, qr_token) VALUES
    (v_vip, v_ev, 'Ewa', 'Sample', 'Contoso Demo', 'vip ', 'import', 'p085a' || replace(gen_random_uuid()::text, '-', '')),
    (v_std, v_ev, 'Jan', 'Plain', NULL, 'attendee', 'import', 'p085b' || replace(gen_random_uuid()::text, '-', ''));

  -- Setter: organizer allowed and normalises; lead refused.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_types := checkin_set_alert_ticket_types(v_ev, ARRAY['VIP', ' vip', '', 'Speaker ']);
  RESET ROLE;
  IF v_types <> ARRAY['VIP', 'Speaker'] THEN RAISE EXCEPTION 'FAIL normalise %', v_types; END IF;
  IF (SELECT status FROM leod_checkin_entitlements WHERE event_id = v_ev) <> 'test' THEN
    RAISE EXCEPTION 'FAIL setter changed status'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_set_alert_ticket_types(v_ev, ARRAY['X']);
    RAISE EXCEPTION 'FAIL lead set types';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Scans (service path): VIP ok -> alert; standard ok -> none; VIP duplicate -> none.
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_std, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL alert count %', v_n; END IF;
  IF NOT (SELECT is_test FROM leod_checkin_alerts WHERE event_id = v_ev) THEN RAISE EXCEPTION 'FAIL is_test'; END IF;

  -- Reader: lead sees name, company, desk label, still_in.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_a := checkin_recent_alerts(v_ev);
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;  -- RLS: lead reads the row
  RESET ROLE;
  IF v_a->0->>'name' <> 'Ewa Sample' OR v_a->0->>'company' <> 'Contoso Demo' OR v_a->0->>'desk_label' <> 'Desk 2'
     OR v_a->0->>'ticket_type' <> 'vip' OR NOT (v_a->0->>'still_in')::boolean THEN
    RAISE EXCEPTION 'FAIL reader %', v_a; END IF;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL lead rls %', v_n; END IF;

  -- Crew and viewer: reader refused, table rows invisible.
  FOREACH r IN ARRAY ARRAY[v_crew, v_view] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_recent_alerts(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL rls leak to %', r; END IF;
  END LOOP;
  IF v_denied <> 2 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  -- Clients cannot write alerts.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO leod_checkin_alerts (event_id, attendee_id, ticket_type, is_test) VALUES (v_ev, v_std, 'x', true);
    RAISE EXCEPTION 'FAIL client insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Undo (lead may undo any): alert stays, still_in false.
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, now(), 'undo', v_t, v_lead, NULL, true, NULL);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_a := checkin_recent_alerts(v_ev);
  RESET ROLE;
  IF jsonb_array_length(v_a) <> 1 OR (v_a->0->>'still_in')::boolean THEN RAISE EXCEPTION 'FAIL undo %', v_a; END IF;

  -- Go-live deletes test alerts.
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = v_ev;
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL go-live left % alerts', v_n; END IF;

  -- The table is in the Realtime publication.
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_checkin_alerts') THEN
    RAISE EXCEPTION 'FAIL not published'; END IF;

  RAISE EXCEPTION 'PROBE OK 085';
END
$probe$;
```

- [ ] **Step 3: Run the probe before the migration.** Expected: an error saying `checkin_set_alert_ticket_types` does not exist.

- [ ] **Step 4: Write the migration** (`supabase/migrations/085_checkin_vip_alerts.sql`)

```sql
-- 085_checkin_vip_alerts.sql
-- VIP arrival alerts (event-day spec, feature 5). Organizers pick ticket
-- types; an 'ok' scan of a guest with one of them writes an alert row in
-- the same transaction as the check-in. Owner, organizers and desk leads
-- read alerts; desk staff and viewers never do.
--
-- Realtime carries this table's rows to the dashboard and lead desks as a
-- wake-up only. A row holds ids and the ticket type, never a name; the
-- page then calls checkin_recent_alerts, which joins names under the
-- role check. RLS below is what stops Realtime delivering to crew.
-- Ticket types match case- and space-insensitively: CSV imports vary.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS alert_ticket_types text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS leod_checkin_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  attendee_id uuid NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  ticket_type text NOT NULL,
  desk_id     uuid,
  is_test     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_alerts_event_idx ON leod_checkin_alerts (event_id, created_at DESC);

ALTER TABLE leod_checkin_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON leod_checkin_alerts TO authenticated;
DROP POLICY IF EXISTS checkin_alerts_read ON leod_checkin_alerts;
CREATE POLICY checkin_alerts_read ON leod_checkin_alerts FOR SELECT TO authenticated
  USING (checkin_is_owner(event_id) OR COALESCE(checkin_role_for_event(event_id) IN ('organizer', 'lead'), false));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_checkin_alerts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE leod_checkin_alerts;
  END IF;
END $$;

-- ── Setter: organizer or owner ──────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_set_alert_ticket_types(p_event_id uuid, p_types text[])
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out text[];
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer') THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can choose alert ticket types'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Trim, drop blanks, keep the first spelling of each type (case-insensitive), in order given.
  SELECT COALESCE(array_agg(t ORDER BY first_i), '{}') INTO v_out
    FROM (SELECT min(i) AS first_i, (array_agg(t ORDER BY i))[1] AS t
            FROM (SELECT btrim(x) AS t, i FROM unnest(COALESCE(p_types, '{}')) WITH ORDINALITY AS u(x, i)) s
           WHERE t <> ''
           GROUP BY lower(t)) d;
  IF cardinality(v_out) > 20 OR EXISTS (SELECT 1 FROM unnest(v_out) t WHERE length(t) > 80) THEN
    RAISE EXCEPTION 'At most 20 ticket types, 80 characters each' USING ERRCODE = '22023';
  END IF;
  UPDATE leod_checkin_entitlements SET alert_ticket_types = v_out WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_alert_ticket_types(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_alert_ticket_types(uuid, text[]) TO authenticated;

-- ── Reader: owner, organizer, lead ──────────────────────────────
-- Newest 50. Once live, test alerts are excluded (go-live deletes them;
-- this is the defensive copy). still_in is false when the check-in that
-- raised the alert was undone, so the list never claims a guest is here
-- who is not.
CREATE OR REPLACE FUNCTION checkin_recent_alerts(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR COALESCE(checkin_role_for_event(p_event_id) IN ('organizer', 'lead'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers and desk leads see arrival alerts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at,
             'name', btrim(concat_ws(' ', a.first_name, a.last_name)),
             'company', NULLIF(btrim(a.company), ''),
             'ticket_type', x.ticket_type,
             'desk_label', d.label,
             'still_in', a.checked_in_at IS NOT NULL) ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM leod_checkin_alerts
             WHERE event_id = p_event_id AND NOT (COALESCE(v_live, false) AND is_test)
             ORDER BY created_at DESC LIMIT 50) x
      JOIN leod_checkin_attendees a ON a.id = x.attendee_id
      LEFT JOIN leod_checkin_desks d ON d.event_id = x.event_id AND d.desk_id = x.desk_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_recent_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_recent_alerts(uuid) TO authenticated;

-- ── Go-live clears test alerts ─────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_clear_test_alerts_on_live()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.status = 'test' AND NEW.status = 'live' THEN
    DELETE FROM leod_checkin_alerts WHERE event_id = NEW.event_id AND is_test;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_clear_test_alerts_on_live() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_clear_test_alerts_on_live ON leod_checkin_entitlements;
CREATE TRIGGER trg_checkin_clear_test_alerts_on_live
  AFTER UPDATE OF status ON leod_checkin_entitlements
  FOR EACH ROW EXECUTE FUNCTION checkin_clear_test_alerts_on_live();

-- ── checkin_apply_scan: the alert insert ───────────────────────
-- <PASTE the live body of checkin_apply_scan here as CREATE OR REPLACE,
--  unchanged except: (a) DECLARE v_alert_types text[];
--  (b) in the final branch, after `v_result := 'ok';`, the block below.>
```

The `checkin_apply_scan` replacement is the 071 definition (lines 89–171 of `supabase/migrations/071_checkin_desks.sql`, `CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION`, same 10-argument signature, same REVOKE/GRANT to service_role). It has exactly two additions, each marked `-- CHANGED (085)`:

```sql
  v_alert_types text[];     -- CHANGED (085): VIP alerts
```

```sql
      v_result := 'ok';
      -- CHANGED (085): VIP alerts. Same transaction as the check-in.
      SELECT alert_ticket_types INTO v_alert_types FROM leod_checkin_entitlements WHERE event_id = p_event_id;
      IF cardinality(v_alert_types) > 0 THEN
        INSERT INTO leod_checkin_alerts (event_id, attendee_id, ticket_type, desk_id, is_test)
        SELECT p_event_id, a.id, btrim(a.ticket_type), p_desk_id, v_test
          FROM leod_checkin_attendees a
         WHERE a.id = p_attendee_id
           AND lower(btrim(a.ticket_type)) IN (SELECT lower(t) FROM unnest(v_alert_types) t);
      END IF;
```

End the file with `NOTIFY pgrst, 'reload schema';`. The executor writes the full function text into the file. The placeholder comment above is not shipped.

- [ ] **Step 5: Apply and run the probe.** `apply_migration` name `checkin_vip_alerts`, then the probe. Expected: `PROBE OK 085`. Then re-run `tests/sql/071-desks-probe.sql` and `tests/sql/072-stats-probe.sql` to confirm the scan function still passes its own probes (expected `PROBE OK 071`, `PROBE OK 072`).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(checkin): migration 085, VIP arrival alerts (applied)" -- supabase/migrations/085_checkin_vip_alerts.sql tests/sql/085-vip-alerts-probe.sql
```
(after `git add` of the same two files)

---

### Task 3: Roles and shaping

**Files:**
- Modify: `checkin-roles.js` (GRANTS), `supabase/functions/_shared/checkin-roles.ts` (GRANTS)
- Modify: `checkin-dashboard.js` (append the functions)
- Test: `tests/checkin-dashboard.spec.ts`, `tests/checkin-roles.spec.ts`

**Interfaces:**
- Produces:
  - GRANTS `company_board: LEADS`, `alerts: LEADS` in both role copies
  - `companyRows(board, filter, timeZone)`, where `filter` is `'all'|'missing'|'partly'`. Returns `[{company, expected, arrived, missing, last: string}]`. `missing` keeps the rows with `arrived === 0`; `partly` keeps `0 < arrived < expected`; the server's order is kept.
  - `alertLine(alert, timeZone)` returns a string
  - `newAlertIds(seen: Set<string>, alerts)` returns `string[]` of ids not in `seen`

- [ ] **Step 1: Write the failing tests.** Append to `tests/checkin-dashboard.spec.ts`:

```ts
describe('companyRows', () => {
  const board = [
    { company: 'Acme', expected: 3, arrived: 1, last_arrival_at: '2026-10-18T08:05:00Z' },
    { company: 'Zeta', expected: 2, arrived: 0, last_arrival_at: null },
    { company: 'Solo', expected: 1, arrived: 1, last_arrival_at: '2026-10-18T08:10:00Z' },
  ];
  it('keeps server order and computes missing', () => {
    const r = d.companyRows(board, 'all', WAW);
    expect(r.map(x => x.company)).toEqual(['Acme', 'Zeta', 'Solo']);
    expect(r[0]).toMatchObject({ missing: 2, last: '10:05' });
    expect(r[1].last).toBe('');
  });
  it('Not here yet is 0 arrived; Partly here is some but not all', () => {
    expect(d.companyRows(board, 'missing', WAW).map(x => x.company)).toEqual(['Zeta']);
    expect(d.companyRows(board, 'partly', WAW).map(x => x.company)).toEqual(['Acme']);
  });
  it('tolerates a null board', () => {
    expect(d.companyRows(null, 'all', WAW)).toEqual([]);
  });
});

describe('alertLine and newAlertIds', () => {
  const a = { id: 'a1', created_at: '2026-10-18T08:05:00Z', name: 'Ewa Sample', company: 'Contoso Demo',
              ticket_type: 'Speaker', desk_label: 'Desk 2', still_in: true };
  it('reads like the spec', () => {
    expect(d.alertLine(a, WAW)).toBe('10:05 Ewa Sample (Speaker, Contoso Demo) just checked in at Desk 2');
  });
  it('drops a missing company and desk', () => {
    expect(d.alertLine({ ...a, company: null, desk_label: null }, WAW)).toBe('10:05 Ewa Sample (Speaker) just checked in');
  });
  it('an undone check-in says so', () => {
    expect(d.alertLine({ ...a, still_in: false }, WAW)).toBe('10:05 Ewa Sample (Speaker, Contoso Demo) checked in at Desk 2, since undone');
  });
  it('a nameless guest is not an empty string', () => {
    expect(d.alertLine({ ...a, name: '' }, WAW)).toBe('10:05 A guest (Speaker, Contoso Demo) just checked in at Desk 2');
  });
  it('newAlertIds returns only unseen ids', () => {
    expect(d.newAlertIds(new Set(['a1']), [a, { ...a, id: 'a2' }])).toEqual(['a2']);
    expect(d.newAlertIds(new Set(), null)).toEqual([]);
  });
});
```

Add to `tests/checkin-roles.spec.ts`, inside the block that runs both copies (follow the file's existing table form):

```ts
it('company board and alerts are owner, organizer and lead only', () => {
  for (const perm of ['company_board', 'alerts']) {
    expect(ROLES.filter(r => can(r, perm))).toEqual(['owner', 'organizer', 'lead']);
  }
});
```

- [ ] **Step 2: Run the tests.** `npx vitest run tests/checkin-dashboard.spec.ts tests/checkin-roles.spec.ts`. Expected: FAIL (`companyRows is not a function`, and a perm with no grant).

- [ ] **Step 3: Implement.** In both role copies, add `company_board: LEADS, alerts: LEADS,` after `desk_health: LEADS,`. Append to `checkin-dashboard.js`:

```js
// Company arrival board (event-day spec, feature 4). The server sorts by
// most still missing; filters only remove rows.
export function companyRows(board, filter, timeZone) {
  return (board || [])
    .filter(b => filter === 'missing' ? b.arrived === 0
      : filter === 'partly' ? b.arrived > 0 && b.arrived < b.expected : true)
    .map(b => ({ company: b.company, expected: b.expected, arrived: b.arrived,
                 missing: b.expected - b.arrived,
                 last: b.last_arrival_at ? fmtClock(Date.parse(b.last_arrival_at), timeZone) : '' }));
}

// VIP arrival alerts (feature 5).
export function alertLine(a, timeZone) {
  const who = (a.name || '').trim() || 'A guest';
  const tag = '(' + [a.ticket_type, a.company].filter(Boolean).join(', ') + ')';
  const at = a.desk_label ? ' at ' + a.desk_label : '';
  const what = a.still_in ? ' just checked in' + at : ' checked in' + at + ', since undone';
  return fmtClock(Date.parse(a.created_at), timeZone) + ' ' + who + ' ' + tag + what;
}

export function newAlertIds(seen, alerts) {
  return (alerts || []).filter(a => !seen.has(a.id)).map(a => a.id);
}
```

- [ ] **Step 4: Run the full suite.** `npx vitest run`. Expected: all pass.

- [ ] **Step 5: Commit** `checkin-roles.js supabase/functions/_shared/checkin-roles.ts checkin-dashboard.js tests/checkin-dashboard.spec.ts tests/checkin-roles.spec.ts` with message `feat(checkin): company board and alert shaping, alert and board grants`.

---

### Task 4: Dashboard, board and alert panels

**Files:**
- Modify: `cuedeck-checkin-dashboard.html`

**Interfaces:**
- Consumes: `checkin_company_board`, `checkin_recent_alerts`, `companyRows`, `alertLine`, `can(ROLE,'company_board'|'alerts')`

- [ ] **Step 1: Markup.** After the `#ops` section, add:

```html
<section class="ops" id="alerts" hidden aria-label="Arrival alerts">
  <h2>Arrival alerts</h2>
  <ul class="gaps" id="alert-list"></ul>
  <p class="meta-line" id="alert-empty" hidden></p>
</section>
<section class="ops" id="board" hidden aria-label="Companies">
  <h2>Companies</h2>
  <div class="cb-f" role="group" aria-label="Filter companies">
    <button class="chip" data-cb="all" aria-pressed="true">All</button>
    <button class="chip" data-cb="missing" aria-pressed="false">Not here yet</button>
    <button class="chip" data-cb="partly" aria-pressed="false">Partly here</button>
  </div>
  <table class="tbl"><thead><tr><th>Company</th><th>Arrived</th><th>Still missing</th><th>Last arrival</th></tr></thead><tbody id="cb-body"></tbody></table>
  <p class="meta-line" id="cb-empty" hidden></p>
</section>
```

CSS (beside `.gaps`): `.cb-f{display:flex;gap:6px;flex-wrap:wrap}.chip{border:1px solid var(--bd2,#D2D2D7);background:#fff;border-radius:999px;padding:5px 12px;font-size:12.5px;cursor:pointer}.chip[aria-pressed="true"]{background:var(--ac);border-color:var(--ac);color:#fff}`. Check that `checkin-app.css` has no `.chip` first. If it does, reuse it and skip this rule.

- [ ] **Step 2: Script.** Import `companyRows, alertLine` and add:

```js
let CB_FILTER = 'all', BOARD = null, alertChan = null;
function renderBoard() {
  const body = $('cb-body'); body.replaceChildren();
  const rows = companyRows(BOARD, CB_FILTER, EV.timezone);
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', null, r.company), el('td', null, r.arrived + ' of ' + r.expected),
              el('td', null, String(r.missing)), el('td', null, r.last || 'None yet'));
    body.appendChild(tr);
  }
  $('cb-empty').hidden = rows.length > 0;
  $('cb-empty').textContent = !BOARD || !BOARD.length ? 'No guest on the list has a company.'
    : CB_FILTER === 'missing' ? 'Every company has someone here.' : 'No company is partly here.';
}
async function loadBoard() {
  if (!can(ROLE, 'company_board')) return;
  const { data, error } = await sb.rpc('checkin_company_board', { p_event_id: EVENT_ID });
  if (error) { $('cb-empty').hidden = false; $('cb-empty').textContent = 'Could not load companies: ' + error.message; return; }
  BOARD = data; $('board').hidden = false; renderBoard();
}
async function loadAlerts() {
  if (!can(ROLE, 'alerts')) return;
  const { data, error } = await sb.rpc('checkin_recent_alerts', { p_event_id: EVENT_ID });
  const list = $('alert-list');
  if (error) { $('alert-empty').hidden = false; $('alert-empty').textContent = 'Could not load alerts: ' + error.message; return; }
  $('alerts').hidden = false;
  list.replaceChildren(...(data || []).map(a => el('li', null, alertLine(a, EV.timezone))));
  $('alert-empty').hidden = (data || []).length > 0;
  $('alert-empty').textContent = 'No alerts yet. Choose ticket types to watch in Setup, Event details.';
}
// Realtime is the fast path; refresh() below reloads both every 30 s, so a
// dead socket costs latency, not alerts. The payload is ignored: rows
// carry no names, and the RPC re-checks the role.
function subscribeAlerts() {
  if (!can(ROLE, 'alerts') || alertChan) return;
  alertChan = sb.channel('ck-alerts-' + EVENT_ID)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leod_checkin_alerts', filter: 'event_id=eq.' + EVENT_ID },
        () => { loadAlerts(); loadBoard(); })
    .subscribe();
}
document.querySelectorAll('[data-cb]').forEach(b => b.addEventListener('click', () => {
  CB_FILTER = b.dataset.cb;
  document.querySelectorAll('[data-cb]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderBoard();
}));
```

In `refresh()`, after `renderFull(data, closed)` inside the `!CLIENT` branch, call `loadBoard(); loadAlerts();` (not awaited, so a slow board cannot hold up the tiles). In the start-up block, after `await refresh();`, call `if (!CLIENT) subscribeAlerts();`. In the `SIGNED_OUT` handler, add `if (alertChan) sb.removeChannel(alertChan);`.

- [ ] **Step 3: Test locally.** Serve with `python3 -m http.server 7230` from the worktree and use Playwright on `/cuedeck-checkin-dashboard.html?event=<IME 2026 id>`, signed in as the owner session if one is available. Otherwise defer to Task 7. Check that the board shows Acme merged and that the filters switch rows. Run `npx vitest run`.

- [ ] **Step 4: Commit** `cuedeck-checkin-dashboard.html` with message `feat(checkin): dashboard company board and arrival alerts`.

---

### Task 5: Setup, choose alert ticket types

**Files:**
- Modify: `cuedeck-checkin-setup.html`

**Interfaces:**
- Consumes: `checkin_set_alert_ticket_types`, `ATT` (loaded attendees), the entitlement row (`alert_ticket_types`). Find where Setup reads `leod_checkin_entitlements` (grep `entitlements`) and add `alert_ticket_types` to that select.

- [ ] **Step 1: Markup.** After `</form>` of `#f-det`:

```html
<div class="toggle" id="al-row" hidden style="margin-top:18px"><div><b>Arrival alerts</b>
  <p>Get an alert on the dashboard and on desk leads' screens when guests with these ticket types check in.</p>
  <div id="al-types" class="cb-f"></div><p class="small" id="al-none" hidden>Import guests with ticket types to choose from.</p></div>
  <div><button class="btn btn-s" id="al-save" type="button">Save alerts</button><span class="ok" id="al-ok"></span></div></div>
<div class="err" id="al-err"></div>
```

- [ ] **Step 2: Script.** The choices are the distinct ticket types on the guest list (trimmed, case-insensitive, first spelling wins), plus any already-saved type no longer on the list, so a saved choice never disappears silently. Each choice is a checkbox `label > input[type=checkbox][value]`, checked when a saved type matches case-insensitively. Show the row only when `can(ROLE, 'edit_details')`. Save calls `sb.rpc('checkin_set_alert_ticket_types', { p_event_id: EVENT_ID, p_types: [...checked values] })`, shows the error message on failure, and on success stores the returned array and shows `' Saved'`. Re-render the choices after every attendees load (import, add, delete).

```js
function renderAlertTypes() {
  const show = can(ROLE, 'edit_details');
  $('al-row').hidden = !show; if (!show) return;
  const saved = (ENT && ENT.alert_ticket_types) || [];
  const seen = new Map();
  for (const t of [...ATT.map(a => (a.ticket_type || '').trim()), ...saved]) {
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  const savedL = new Set(saved.map(s => s.toLowerCase()));
  const box = $('al-types'); box.replaceChildren();
  for (const [k, t] of seen) {
    const lab = el('label', 'chip'); const cb = el('input'); cb.type = 'checkbox'; cb.value = t; cb.checked = savedL.has(k);
    lab.append(cb, document.createTextNode(' ' + t)); box.appendChild(lab);
  }
  $('al-none').hidden = seen.size > 0; $('al-save').disabled = seen.size === 0;
}
$('al-save').addEventListener('click', async () => {
  $('al-err').textContent = ''; $('al-ok').textContent = ''; $('al-save').disabled = true;
  const types = [...document.querySelectorAll('#al-types input:checked')].map(i => i.value);
  const { data, error } = await sb.rpc('checkin_set_alert_ticket_types', { p_event_id: EVENT_ID, p_types: types });
  $('al-save').disabled = false;
  if (error) { $('al-err').textContent = error.message; return; }
  ENT.alert_ticket_types = data; renderAlertTypes(); $('al-ok').textContent = ' Saved';
});
```

`ENT` is the page's existing variable for the entitlement row. Use its real name (grep it). The `.chip`/`.cb-f` styles come from Setup's own CSS if it has them. Otherwise add `.cb-f{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}`.

- [ ] **Step 3: Test locally.** Run the page against the IME 2026 event, tick a type, save, reload, and confirm it stays ticked. Confirm in SQL with `select alert_ticket_types, status from leod_checkin_entitlements where event_id = 'bdd18620-1df4-4c95-b398-8a96a25f5d17'`. The status must be unchanged.

- [ ] **Step 4: Commit** `cuedeck-checkin-setup.html` with message `feat(checkin): Setup chooses alert ticket types`.

---

### Task 6: Desk, alerts for leads

**Files:**
- Modify: `cuedeck-checkin.html`

**Interfaces:**
- Consumes: `checkin_recent_alerts`, `window.CK_ROLES.can(S.role, 'alerts')`, `newAlertIds`. The desk loads `checkin-dashboard.js` only if it already does. Otherwise copy `alertLine` inline as `ckAlertLine` with a comment pointing at the tested original, matching how the page consumes `CK_ROLES` (check how `window.CK_ROLES` is attached and follow the same pattern, preferring to expose the dashboard module the same way over copying).

- [ ] **Step 1: Markup.** Inside `.ck-panel`, after `#st-status`: `<div class="ck-alerts" id="st-alerts" hidden><div class="ck-lbl">Arrival alerts</div><ul id="st-alert-list"></ul></div>`. Style it quietly (small text, newest first, max 10 shown). The newest arrival since the last render gets a 6 s highlight class. There is no sound and no modal: the scan input must keep focus (`holdFocus`).

- [ ] **Step 2: Script.** On `renderStation()`, if `can(S.role,'alerts')`: load the alerts, subscribe a channel `ck-desk-alerts-<event>` to INSERT on `leod_checkin_alerts` filtered by event (handler: reload). Add a 60 s backstop reload on the existing `refreshRosterIfIdle` timer path, skipped offline. On sign-out or switch event (the function at line ~1612 that resets `S`), remove the channel and hide the box. Track seen ids in a `Set` so only new ones get the highlight. Errors are logged with `console.warn` and are not surfaced (same rule as other desk bookkeeping): a desk volunteer must not see a red error over an optional feed.

- [ ] **Step 3: Test.** `npx vitest run`, then a local Playwright pass: the desk as owner shows the box, and focus stays in `#scan` after an alert arrives (use `document.activeElement.id === 'scan'`).

- [ ] **Step 4: Commit** `cuedeck-checkin.html` with message `feat(checkin): lead desks show arrival alerts`.

---

### Task 7: Review, ship, verify live

- [ ] **Step 1:** Run one fresh reviewer over `git diff main...HEAD` (most capable model). Fix the findings.
- [ ] **Step 2:** Merge to main in `~/AVE-Production-Console` with a pathspec-safe merge (the branch only touches the files above), push to `cuedeck` and `origin`, and confirm that the production deployment's commit equals the merge sha.
- [ ] **Step 3:** In Chrome on app.cuedeck.io, signed in as Sherif (IME 2026, test mode):
  - Setup: tick a ticket type held by a seeded attendee.
  - Desk: check that attendee in. The dashboard alert appears within seconds (Realtime) and the lead desk box shows it.
  - Undo: the line changes to "since undone" by the next refresh.
  - The company board merges the three Acme spellings and the filters work.
  - Then untick the type, undo the test check-in, and confirm the DB is back to its starting state.
- [ ] **Step 4:** Update memory `project_cuedeck_checkin_product.md` with features 4–5 live, then run `scripts/verify-no-public-internals.sh`, from a browser if the script reports BLOCKED.
