-- ============================================================
-- CueDeck Migration 133: event teams, part 4 (seats, my events, team)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §5, §6, §9.2
--   * Seats per event (§6): the event owner's plan sets the team size;
--     the creator never uses a seat; active and suspended members hold one;
--     enforced here on every membership insert (and pre-checked by
--     invite-operator). A downgrade keeps everyone and only blocks new
--     members. cuedeck_plan_seats is the one place the numbers live on the
--     server; they match PLAN_LIMITS.operators in cuedeck-console.html.
--   * cuedeck_my_events (§5): the events the caller created or is an active
--     member of, with the role, the organiser (for grouping, §9.3) and the
--     organiser's plan (all limits for an event come from it, §6).
--   * cuedeck_event_team (§5): the Team window for one event, for its
--     directors; it replaces get_operators_with_last_seen in the console.
--   * handle_first_login (§9.2): no founder welcome for an account that is
--     only on other organisers' events. Rewritten, so it now takes the
--     caller from auth.uid() (rule since 079; spec §10 side note).
--   * event_log_member_insert (security review of 130-132, fix 2): a direct
--     client insert into leod_event_log must name the caller as operator.
--     Live (095): (operator_id IS NULL OR operator_id = auth.uid()), so a
--     member could add an anonymous row with any action and role.
--
-- Live body of handle_first_login before this migration (2026-10-08):
--   reads leod_users WHERE id = p_user_id (any id, from the caller), sets
--   first/last login and login_count, and on first login always inserts
--   welcome_email_trigger and sets welcome_email_sent.
-- ============================================================

-- ── Seats ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cuedeck_plan_seats(p_owner uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- NULL = no limit. No subscription row: the console creates an
  -- organiser's trial on first boot, so this is treated as that trial.
  SELECT CASE
           WHEN s.plan IS NULL THEN NULL
           WHEN s.status IN ('expired', 'canceled') THEN 0
           WHEN s.plan = 'trial' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now() THEN 0
           WHEN s.plan IN ('trial', 'enterprise') THEN NULL
           WHEN s.plan = 'pro' THEN 20
           WHEN s.plan IN ('starter', 'perevent') THEN 5
           ELSE 0
         END
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT ss.plan, ss.status, ss.trial_ends_at
                         FROM leod_subscriptions ss
                        WHERE ss.director_id = p_owner
                        ORDER BY ss.created_at DESC
                        LIMIT 1) s ON true
$$;
REVOKE ALL ON FUNCTION public.cuedeck_plan_seats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_plan_seats(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.cuedeck_event_seats_of(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'used',  (SELECT count(*) FROM leod_event_members m WHERE m.event_id = e.id),
           'limit', cuedeck_plan_seats(e.created_by))
    FROM leod_events e
   WHERE e.id = p_event_id
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_seats_of(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_seats_of(uuid) TO service_role;

-- The membership guard from 130, plus seats on insert. Two invites for the
-- last seat take the same per-event lock, so the second one counts after
-- the first has committed and is refused (Review Focus 3).
CREATE OR REPLACE FUNCTION public.leod_event_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_limit int;
  v_used  int;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'membership event and user cannot change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.created_by INTO v_owner FROM leod_events e WHERE e.id = NEW.event_id;
  IF v_owner = NEW.user_id THEN
    RAISE EXCEPTION 'owner_not_member: the creator of an event is its director and is never a member'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('event_seats:' || NEW.event_id::text, 0));
    v_limit := cuedeck_plan_seats(v_owner);
    IF v_limit IS NOT NULL THEN
      SELECT count(*) INTO v_used FROM leod_event_members m WHERE m.event_id = NEW.event_id;
      IF v_used >= v_limit THEN
        RAISE EXCEPTION 'seats_full: % of % seats used on this event', v_used, v_limit
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_event_members_guard() FROM PUBLIC, anon, authenticated;

-- ── My events ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cuedeck_my_events()
RETURNS TABLE(event_id uuid, role text, is_owner boolean, owner_id uuid, organiser text,
              plan text, plan_status text, trial_ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (
    SELECT e.id, e.created_by, cuedeck_event_role_of(e.id, auth.uid()) AS my_role
      FROM leod_events e
     WHERE auth.uid() IS NOT NULL
       AND (e.created_by = auth.uid()
            OR e.id IN (SELECT m.event_id FROM leod_event_members m
                         WHERE m.user_id = auth.uid() AND m.active))
  )
  SELECT x.id, x.my_role, x.created_by = auth.uid(), x.created_by,
         coalesce(nullif(btrim(u.company_name), ''), nullif(btrim(u.organization), ''), nullif(btrim(u.name), '')),
         s.plan, s.status, s.trial_ends_at
    FROM mine x
    LEFT JOIN leod_users u ON u.id = x.created_by
    LEFT JOIN LATERAL (SELECT ss.plan, ss.status, ss.trial_ends_at
                         FROM leod_subscriptions ss
                        WHERE ss.director_id = x.created_by
                        ORDER BY ss.created_at DESC
                        LIMIT 1) s ON true
   WHERE x.my_role IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.cuedeck_my_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_my_events() TO authenticated, service_role;

-- ── The team of one event ───────────────────────────────────
-- For the event's directors (creator or active director member). VOLATILE
-- and 42501 for anyone else, so checkin_rpcs_refuse_strangers (G10) checks
-- it as a stranger from the day it ships.
CREATE OR REPLACE FUNCTION public.cuedeck_event_team(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL OR cuedeck_event_role_of(p_event_id, v_uid) IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT e.created_by INTO v_owner FROM leod_events e WHERE e.id = p_event_id;
  RETURN jsonb_build_object(
    'is_owner', v_owner = v_uid,
    'seats', cuedeck_event_seats_of(p_event_id),
    'owner', (SELECT jsonb_build_object('user_id', v_owner, 'name', u.name,
                                        'email', coalesce(u.email, a.email), 'last_sign_in_at', a.last_sign_in_at)
                FROM auth.users a LEFT JOIN leod_users u ON u.id = a.id
               WHERE a.id = v_owner),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'name', u.name, 'email', coalesce(u.email, a.email),
               'role', m.role, 'active', m.active, 'last_sign_in_at', a.last_sign_in_at,
               'added_at', m.created_at)
             ORDER BY m.created_at, m.user_id)
        FROM leod_event_members m
        LEFT JOIN leod_users u ON u.id = m.user_id
        LEFT JOIN auth.users a ON a.id = m.user_id
       WHERE m.event_id = p_event_id), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_team(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_team(uuid) TO authenticated, service_role;

-- ── First login ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_first_login(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_is_first_login boolean;
  v_user_email     text;
  v_user_name      text;
  v_members_only   boolean;
BEGIN
  -- The argument stays for the console's call shape; it must be the caller.
  IF v_uid IS NULL OR p_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT email, name, (first_login_at IS NULL)
    INTO v_user_email, v_user_name, v_is_first_login
    FROM leod_users WHERE id = v_uid;
  IF v_user_email IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  UPDATE leod_users SET
    first_login_at = COALESCE(first_login_at, now()),
    last_login_at  = now(),
    login_count    = COALESCE(login_count, 0) + 1
  WHERE id = v_uid;

  -- Someone only on other organisers' events got invite-operator's "added
  -- to" email; the founder welcome and its sequence are for organisers.
  v_members_only := EXISTS (SELECT 1 FROM leod_event_members m WHERE m.user_id = v_uid)
                    AND NOT EXISTS (SELECT 1 FROM leod_events e WHERE e.created_by = v_uid);

  IF v_is_first_login AND NOT v_members_only THEN
    INSERT INTO welcome_email_trigger (user_id, email, name)
    VALUES (v_uid, v_user_email, v_user_name)
    ON CONFLICT (user_id) DO NOTHING;
    UPDATE leod_users SET welcome_email_sent = true WHERE id = v_uid;
    RETURN jsonb_build_object('first_login', true, 'welcome_email_queued', true);
  ELSIF v_is_first_login THEN
    RETURN jsonb_build_object('first_login', true, 'welcome_email_queued', false);
  END IF;
  RETURN jsonb_build_object('first_login', false,
                            'login_count', (SELECT login_count FROM leod_users WHERE id = v_uid));
END;
$$;
REVOKE ALL ON FUNCTION public.handle_first_login(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_first_login(uuid) TO authenticated, service_role;

-- ── Direct log inserts name the caller ──────────────────────
-- Replaces 095's policy: same event check, but operator_id must be the
-- caller; NULL is no longer accepted from a client. Rows the database
-- writes itself with no operator (checkin_speaker_arrival, SECURITY DEFINER,
-- owned by postgres) are not subject to RLS: leod_event_log does not FORCE
-- row level security (checked on live 2026-10-08: relforcerowsecurity false,
-- owner postgres, rolbypassrls true). validate_event_log_role (131) then
-- stamps the caller's role on the event.
DROP POLICY IF EXISTS event_log_member_insert ON public.leod_event_log;
CREATE POLICY event_log_member_insert ON public.leod_event_log FOR INSERT TO authenticated
  WITH CHECK (cuedeck_event_role(event_id) IS NOT NULL AND operator_id = auth.uid());

-- ── Index for the invite rate limit ─────────────────────────
-- invite-operator counts MEMBER_INVITED rows of one event owner in the last
-- 24 hours before every invite (20 per owner per day). Same shape as 105's
-- idx_log_operator_invited, which served the old OPERATOR_INVITED count and
-- goes in the invited_by cleanup.
CREATE INDEX IF NOT EXISTS idx_log_member_invited
  ON leod_event_log ((payload->>'event_owner'), ts DESC)
  WHERE action = 'MEMBER_INVITED';
