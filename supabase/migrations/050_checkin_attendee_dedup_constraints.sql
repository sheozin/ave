-- ============================================================
-- CueDeck — Migration 050: Check-in module — attendee dedup backstop
-- ============================================================
-- checkin-import-attendees dedups in application code (external_ref
-- else email, scoped to event_id) against a snapshot read at the
-- start of each request. That closes duplicates WITHIN one request
-- (migration via commit c550a98 in the check-in plan), but two
-- concurrent import requests — or a client retry racing an in-flight
-- one — can both read the same snapshot before either commits,
-- classify the same external_ref/email as 'create', and produce two
-- attendee rows for one person. Nothing at the DB layer stops this.
--
-- Add the real invariant as a constraint. Both partial/expression
-- indexes are nullable-safe (a row with neither key is unconstrained
-- by either, matching the app logic's "no dedup key" case) and
-- case-insensitive on email, matching the import function's
-- .toLowerCase() comparison.
--
-- Flagged by the final whole-increment review of the check-in Phase
-- 1a plan (migrations 044-049); confirmed no existing duplicate rows
-- before adding these constraints.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_attendees_event_ext_ref_unique
  ON leod_checkin_attendees (event_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_attendees_event_email_unique
  ON leod_checkin_attendees (event_id, lower(email))
  WHERE email IS NOT NULL;
