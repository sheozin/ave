-- ============================================================
-- CueDeck — Migration 054: Check-in — attendee column guard
-- ============================================================
-- Closes a privilege gap on leod_checkin_attendees.
--
-- THE PROBLEM
--
-- checkin_att_update is:
--
--   FOR UPDATE TO authenticated
--   USING (checkin_role_for_event(event_id) IN ('organizer','crew'))
--
-- With no WITH CHECK, Postgres applies USING to the new row as well,
-- so the row cannot be moved to an event the caller lacks rights on.
-- That part is sound. The gap is that the expression is COLUMN-BLIND:
-- it tests who the caller is, never which columns changed. A 'crew'
-- operator holding the anon key can therefore PATCH the table directly
-- and set:
--
--   checked_in_at  -> invent or erase an arrival with NO
--                     leod_checkin_scan_events row, defeating the
--                     "a correction is recorded, never erased" design
--                     that the undo path is built on
--   ticket_type    -> self-upgrade to vip
--   email          -> redirect the QR-code email to another address
--
-- checkin_lock_attendee_identity already pins event_id and qr_token.
-- This migration extends the same idea to the columns above.
--
-- WHY A TRIGGER AND NOT WITH CHECK
--
-- A WITH CHECK expression cannot see OLD, so it cannot express "this
-- column did not change". Only a trigger can compare OLD to NEW.
--
-- HOW THE TRUSTED CONTEXT IS DETECTED
--
-- Triggers fire for the service role too. Inside an Edge Function
-- auth.uid() is NULL, so checkin_role_for_event() returns NULL and a
-- naive guard would block checkin-record-scans from ever writing an
-- arrival — breaking check-in completely.
--
-- Detection is by ROLE, deliberately NOT by `auth.uid() IS NULL`:
--   'service_role' -> an Edge Function
--   NULL           -> no PostgREST request at all: direct admin SQL
--   'anon'         -> an unauthenticated PostgREST request: GUARDED
--   'authenticated'-> an end user: GUARDED
--
-- A uid-based escape would wave through every ANON request. No anon
-- policy exists on this table today, so RLS happens to block that
-- path — but the self-registration kiosk in
-- docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md is an
-- unattended screen that inserts attendee rows, and the day it gains an
-- anon policy or an anon-callable RPC, a uid-based guard would switch
-- itself off with no error and no diff. Role-based detection does not.
--
-- It is also independent of the service credential's shape. This
-- project uses the new key format (sb_publishable_… / sb_secret_…),
-- not legacy JWTs, so "the service key carries no sub claim" is not a
-- property worth depending on. Either clause alone suffices.
--
-- Stated plainly: this guard constrains CREW OPERATORS. It is not a
-- defence against someone holding the service-role key, and nothing at
-- this layer could be. Organizers also pass unconditionally.
--
-- BEHAVIOUR ON VIOLATION
--
-- This RAISES rather than silently reverting. The existing identity
-- trigger reverts quietly, which returns 200 to a caller whose write
-- did not land — a failure mode worth not repeating.
-- ============================================================

CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
  v_role   TEXT;
BEGIN
  -- See the header: role-based, not uid-based.
  IF v_caller IS NULL OR v_caller = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- OLD.event_id, never NEW. OLD is immutable in a BEFORE trigger, so
  -- no other trigger at any firing position can influence this lookup.
  -- A NULL v_role falls through to the checks below and is denied.
  v_role := checkin_role_for_event(OLD.event_id);

  IF v_role = 'organizer' THEN
    RETURN NEW;
  END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at THEN
    RAISE EXCEPTION
      'checked_in_at may only be changed by an organizer or through the check-in Edge Function'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.ticket_type IS DISTINCT FROM OLD.ticket_type THEN
    RAISE EXCEPTION 'ticket_type may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- external_ref is a dedup/identity key, not a display field.
  -- checkin-import-attendees matches on it before email, and migration
  -- 050 makes (event_id, external_ref) unique — so pointing your own
  -- row at a ref appearing in the next CSV makes that import rewrite
  -- your ticket_type and name from someone else's line. Same class as
  -- qr_token, which checkin_lock_attendee_identity already pins.
  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'external_ref may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- badge_printed_at is deliberately NOT guarded. The desk page stamps
  -- it from the operator's own JWT right after window.print(), and crew
  -- is the role that works the desk. NO Edge Function writes this
  -- column (verified: zero matches under supabase/functions/), so
  -- guarding it would 403 badge printing for its intended users.
  --
  -- first_name, last_name, company, role_title and custom_fields stay
  -- writable by crew: correcting a misspelled badge at the desk is a
  -- core part of the job, and none of them carry privilege.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_attendee_columns ON leod_checkin_attendees;

-- Postgres fires BEFORE triggers in alphabetical order by name, so this
-- runs BEFORE trg_checkin_lock_attendee_identity (g < l). That is fine:
-- the role lookup reads OLD.event_id, which the identity trigger never
-- touches — it only rewrites NEW. The two are independent.
CREATE TRIGGER trg_checkin_guard_attendee_columns
  BEFORE UPDATE ON leod_checkin_attendees
  FOR EACH ROW
  EXECUTE FUNCTION public.checkin_guard_attendee_columns();
