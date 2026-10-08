-- ============================================================
-- CueDeck Migration 130: event teams, part 1 (membership and the resolver)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §2, §3, §7, §9.1
-- Evidence: docs/superpowers/specs/2026-10-08-event-teams-inventory.md §1, §9.1
--
-- Access becomes per event: a person is a member of one event with one
-- role. The creator (leod_events.created_by) is always director and is
-- never stored as a member, so no row can demote the owner.
--
-- cuedeck_event_role(p_event_id) keeps its name, signature and grants and
-- now reads leod_event_members. The five policies that carried their own
-- copy of the old rule (leod_users.invited_by) are rewritten to call it:
-- owner_read_events, scoped_read_sessions, owner_read_reports,
-- scoped_all_displays and scoped_all_sponsors (the last two split per command).
-- Changes in who may do what, all from the spec:
--   * suspended members (active = false) lose reads too (they kept them);
--   * displays and sponsors: any member reads, director and signage write
--     (any member wrote, even av);
--   * an invited director edits the event row (name, date, venue, times,
--     brand) but never its owner, origin or active flag; only the creator
--     deletes or deactivates it (trigger leod_events_guard_member_update).
--
-- Backfill: each user with invited_by set gets one membership per event of
-- that owner, with their current role and active flag (live 2026-10-08:
-- 1 user, 1 event). leod_users.invited_by and leod_users.role stay for the
-- release, unused for access; migration 132 adds the guard that keeps it so.
--
-- Live bodies this replaces (pg_get_functiondef / pg_policies, 2026-10-08):
--   cuedeck_event_role: CASE WHEN e.created_by = auth.uid() THEN 'director'
--     ELSE (SELECT u.role FROM leod_users u WHERE u.id = auth.uid()
--           AND u.invited_by = e.created_by AND u.active IS NOT FALSE
--           AND u.role IN (6 roles)) END FROM leod_events e WHERE e.id = p_event_id
--   owner_read_events, scoped_read_sessions, owner_read_reports,
--   scoped_all_displays, scoped_all_sponsors, owner_update_events: see the
--   inventory §1c and §1d.
-- ============================================================

-- ── Table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leod_event_members (
  event_id   uuid NOT NULL REFERENCES public.leod_events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('director', 'stage', 'av', 'interp', 'reg', 'signage')),
  active     boolean NOT NULL DEFAULT true,
  invited_by uuid,               -- who added the person (audit only, never read for access)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leod_event_members_pkey PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS leod_event_members_user ON public.leod_event_members (user_id);
COMMENT ON TABLE public.leod_event_members IS
  'Event teams (130): one role per person per event. The event creator is never a row; cuedeck_event_role() is the only reader for access.';

-- Read only for clients; every write goes through invite-operator and
-- manage-operator (service role), as leod_stage_messages goes through its RPCs.
ALTER TABLE public.leod_event_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leod_event_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leod_event_members TO authenticated;
GRANT ALL ON public.leod_event_members TO service_role;

-- ── Resolver ────────────────────────────────────────────────
-- cuedeck_event_role_of: the role of any person on an event, for the
-- database itself and the service role (rpc_apply_delay checks the
-- operator an Edge Function names; validate_event_log_role stamps log rows).
-- Never callable by clients: it takes a user id.
-- The creator is director whatever their account flag (unchanged from the
-- resolver before 130); a member also needs leod_users.active not false.
CREATE OR REPLACE FUNCTION public.cuedeck_event_role_of(p_event_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN e.created_by = p_user_id THEN 'director'
           ELSE (SELECT m.role
                   FROM leod_event_members m
                  WHERE m.event_id = e.id
                    AND m.user_id = p_user_id
                    AND m.active
                    -- an account suspended by an admin (admin-manage-user
                    -- sets leod_users.active = false) has no member role on
                    -- any event; the old resolver checked the same flag
                    AND EXISTS (SELECT 1 FROM leod_users u
                                 WHERE u.id = p_user_id AND u.active IS NOT FALSE))
         END
    FROM leod_events e
   WHERE e.id = p_event_id
     AND p_user_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_role_of(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_role_of(uuid, uuid) TO service_role;

-- cuedeck_event_role: the caller's role on an event, or NULL. Same name,
-- signature and grants as before; every policy and RPC that calls it
-- follows the new model.
CREATE OR REPLACE FUNCTION public.cuedeck_event_role(p_event_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cuedeck_event_role_of(p_event_id, auth.uid())
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_role(uuid) TO authenticated, service_role;

-- ── Membership guard ────────────────────────────────────────
-- The creator is the event's director by creation and is never a member
-- (a row could otherwise be edited to demote them). A membership never
-- moves to another event or person. Migration 133 adds the seat check.
CREATE OR REPLACE FUNCTION public.leod_event_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'membership event and user cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM leod_events e WHERE e.id = NEW.event_id AND e.created_by = NEW.user_id) THEN
    RAISE EXCEPTION 'owner_not_member: the creator of an event is its director and is never a member'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_event_members_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_leod_event_members_guard ON public.leod_event_members;
CREATE TRIGGER trg_leod_event_members_guard
  BEFORE INSERT OR UPDATE ON public.leod_event_members
  FOR EACH ROW EXECUTE FUNCTION public.leod_event_members_guard();

-- ── Backfill (spec §7) ──────────────────────────────────────
-- One active membership per event of the owner, with the user's current
-- role and active flag. Nobody gains or loses anything they could do,
-- except what the spec removes: a suspended member's reads, and pending or
-- check-in-only rows that named an owner (no member role, so no row).
INSERT INTO public.leod_event_members (event_id, user_id, role, active, invited_by)
SELECT e.id, u.id, u.role, u.active IS NOT FALSE, u.invited_by
  FROM leod_users u
  JOIN leod_events e ON e.created_by = u.invited_by
  JOIN auth.users a ON a.id = u.id
 WHERE u.invited_by IS NOT NULL
   AND u.role IN ('director', 'stage', 'av', 'interp', 'reg', 'signage')
   AND e.created_by <> u.id
ON CONFLICT (event_id, user_id) DO NOTHING;

-- ── Policies: one rule for access ───────────────────────────
DROP POLICY IF EXISTS event_members_member_read ON public.leod_event_members;
CREATE POLICY event_members_member_read ON public.leod_event_members FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

-- leod_events: created_by = auth.uid() stays next to the resolver because an
-- INSERT ... RETURNING by the creator is checked against this policy in the
-- statement that inserts the row, and the resolver (a STABLE function) cannot
-- see that row yet. It is the creator half of the same rule, on the row itself.
DROP POLICY IF EXISTS owner_read_events ON public.leod_events;
CREATE POLICY owner_read_events ON public.leod_events FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR cuedeck_event_role(id) IS NOT NULL);

-- An invited director edits the event (spec §9.1); the trigger below keeps
-- the owner, the origin and the active flag to the creator.
DROP POLICY IF EXISTS owner_update_events ON public.leod_events;
DROP POLICY IF EXISTS events_director_update ON public.leod_events;
CREATE POLICY events_director_update ON public.leod_events FOR UPDATE TO authenticated
  USING (cuedeck_event_role(id) = 'director')
  WITH CHECK (cuedeck_event_role(id) = 'director');

DROP POLICY IF EXISTS scoped_read_sessions ON public.leod_sessions;
CREATE POLICY scoped_read_sessions ON public.leod_sessions FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

DROP POLICY IF EXISTS owner_read_reports ON public.leod_reports;
CREATE POLICY owner_read_reports ON public.leod_reports FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

DROP POLICY IF EXISTS scoped_all_displays ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_member_read ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_insert ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_update ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_delete ON public.leod_signage_displays;
CREATE POLICY displays_member_read ON public.leod_signage_displays FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);
CREATE POLICY displays_signage_insert ON public.leod_signage_displays FOR INSERT TO authenticated
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY displays_signage_update ON public.leod_signage_displays FOR UPDATE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'))
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY displays_signage_delete ON public.leod_signage_displays FOR DELETE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'));

DROP POLICY IF EXISTS scoped_all_sponsors ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_member_read ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_insert ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_update ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_delete ON public.leod_signage_sponsors;
CREATE POLICY sponsors_member_read ON public.leod_signage_sponsors FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);
CREATE POLICY sponsors_signage_insert ON public.leod_signage_sponsors FOR INSERT TO authenticated
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY sponsors_signage_update ON public.leod_signage_sponsors FOR UPDATE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'))
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY sponsors_signage_delete ON public.leod_signage_sponsors FOR DELETE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'));

-- ── The event row: what only the creator changes ────────────
-- events_director_update lets an invited director save the event; this
-- keeps id, created_by and created_at fixed for everyone signed in (no
-- giving an event away), and the origin and active flag (deactivating is
-- the console's delete) to the creator. The database itself, the service
-- role and admins pass, as in leod_events_guard_created_via.
CREATE OR REPLACE FUNCTION public.leod_events_guard_member_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR COALESCE(is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the owner of an event cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF auth.uid() IS DISTINCT FROM OLD.created_by
     AND (NEW.active IS DISTINCT FROM OLD.active OR NEW.created_via IS DISTINCT FROM OLD.created_via) THEN
    RAISE EXCEPTION 'only the creator of an event can deactivate it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_events_guard_member_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_leod_events_guard_member_update ON public.leod_events;
CREATE TRIGGER trg_leod_events_guard_member_update
  BEFORE UPDATE ON public.leod_events
  FOR EACH ROW EXECUTE FUNCTION public.leod_events_guard_member_update();
