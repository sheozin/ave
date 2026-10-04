# Check-in as a Sellable Product (Plan A: app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone sign up at app.cuedeck.io/checkin, create an event, import guests, invite desk staff, test the desk free, pay €249 excl. VAT to go live, and run check-in, with no manual database work.

**Architecture:** Three static single-file pages (front page, setup, existing desk) over the existing Supabase project. Event state (`test` / `live`) lives on `leod_checkin_entitlements` and is enforced in the Edge Functions and in Postgres, never only in the browser. Payment is a Stripe Checkout one-off whose webhook flips the event live in one SQL transaction.

**Tech Stack:** Vanilla HTML/JS + supabase-js v2 (CDN), Supabase Postgres + Deno Edge Functions, Stripe API 2024-04-10 (esm.sh stripe@14), vitest (logic mirrors), Vercel static hosting.

**Spec:** `docs/superpowers/specs/2026-10-04-checkin-product-design.md` (read it first; this plan argues from it).

## Global Constraints

- Supabase project ref: `sawekpguemzvuvvulfbc`. Migrations start at **059**. Apply with `apply_migration` (DDL) and verify with single-statement `execute_sql` queries (the `sql-one-statement.py` hook blocks multi-statement queries).
- Price: **€249.00 EUR, `tax_behavior: exclusive`**, one Stripe price, id in secret `CHECKIN_PRICE_ID`. No amount is hardcoded in any page or function.
- Test cap: **25** (test check-ins with result `ok` + test kiosk registrations, per event).
- Check-in window for a live event: **from 00:00 on (event date − 7 days) to 00:00 on (event date + 3 days), in the event's `timezone`** (that is, through the end of date + 2).
- Visual tokens (light): `--pg #F5F5F7 --sf #FFFFFF --wm #FBFBFD --t1 #1D1D1F --t2 #6E6E73 --t3 #A1A1A6 --bd #E8E8ED --bd2 #D2D2D7 --ac #0071E3 --acsf #EAF3FE --gn #1D8348 --gnsf #E8F6EE --am #9A5B00 --amsf #FEF6E7 --ambd #F5D9A8 --rd #B3261E --rdsf #FDECEA`. Copy exact markup and CSS from the approved mockups in `.superpowers/brainstorm/95488-1791107308/content/` (`front-page-direction.html` option A, `your-events.html`, `setup.html`, `golive-and-desk.html`).
- Copy rules: no em-dashes in user-facing text; no emoji icons (inline SVG only); English only.
- Every supabase-js write destructures `{ error }` and handles it. Never `.catch()` on a supabase-js call (errors resolve, they do not reject).
- Edge Functions that must run without a JWT (`stripe-webhook`, `checkin-price`) are deployed with `--no-verify-jwt`, and `supabase/config.toml` records it (Task 1 step 7). Deploying them through `scripts/deploy-functions.sh` without that would turn JWT verification on and break Stripe.
- Commit before deploying any Edge Function (`claim-guards.py` blocks deploys with uncommitted source). Stage explicit file paths only; never `git add .` or a directory.
- Never trigger auth emails or test payments on the owner's own account (`sherif.mka@gmail.com`). Use a throwaway address on a domain you control.
- New pages load supabase-js pinned to an exact version with Subresource Integrity. Before writing Task 8, read the current exact version from `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/package.json` and compute the hash with `curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<ver>/dist/umd/supabase.js | openssl dgst -sha384 -binary | openssl base64 -A`; the tag is `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<ver>/dist/umd/supabase.js" integrity="sha384-<hash>" crossorigin="anonymous"></script>`. Use it in place of the `@2` tag shown in Tasks 8 and 9. (The existing desk keeps its tag; changing it is outside this plan.)
- `/checkin-app.css`, `/checkin-window.js` and `/checkin-csv.js` are served from the repo root, referenced with absolute paths, because the pages live at `/checkin/...` and relative paths would resolve under `/checkin/`.

## Review Focus

1. **Offline desk in test mode past the cap.** A desk offline for 10 minutes queues 30 check-ins; on reconnect the server refuses the 6 over the cap. Expected: the desk shows which people were refused and why, their rows return to "not checked in", and the queue does not retry them forever. Pinned in Task 9 (`test_cap` refusal handling) and Task 3 (server verdict).
2. **Event in a timezone far from UTC.** A Cairo (UTC+3) or Los Angeles (UTC−7) event scanned at 23:30 local on the last valid day must be accepted; at 00:10 local the next day refused. Pinned in Task 2 tests.
3. **Stripe retries and duplicate deliveries.** The same `checkout.session.completed` delivered twice must leave exactly one purchase row and must not wipe check-ins that happened after the first delivery. Pinned in Task 1 (`ON CONFLICT DO NOTHING` + early return) and Task 6 tests.
4. **A CueQuote payment on the shared Stripe account.** A CueQuote `checkout.session.completed` or `charge.refunded` must change nothing in CueDeck. Pinned in Task 6 routing tests.
5. **Organizer edits around the paywall.** An organizer writing `checked_in_at` or `is_test` straight to the table with their own JWT, or moving a live event's date, must be refused. Pinned in Task 1 verification queries.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/059_checkin_product_schema.sql` | Create | Columns, constraints, purchases table, roles, guards, date lock |
| `supabase/migrations/060_checkin_product_functions.sql` | Create | `checkin_test_usage`, `checkin_mark_paid`, `checkin_mark_refunded`, `increment_events_purchased`, per-event usage trigger |
| `supabase/config.toml` | Modify | Record `verify_jwt = false` for `stripe-webhook`, `checkin-price` |
| `supabase/functions/_shared/checkin-policy.ts` | Create | Pure: window, cap, checkout routing |
| `tests/checkin-policy.spec.ts` | Create | Mirror of the above + tests |
| `supabase/functions/checkin-record-scans/index.ts` | Modify | Test marking, cap, window |
| `supabase/functions/checkin-self-register/index.ts` | Modify | Test marking, cap |
| `supabase/functions/_shared/qr-email.ts` | Modify | Optional `overrideTo` / `recordSent` |
| `supabase/functions/checkin-send-qr-emails/index.ts` | Modify | Live-only, `test_to_self` |
| `supabase/functions/checkin-import-attendees/index.ts` | Modify | Auto-send only when live |
| `supabase/functions/checkin-enable-event/index.ts` | Modify | Create in `test`, operational settings, commercial flags admin-only |
| `supabase/functions/checkin-invite-staff/index.ts` | Create | Invite / remove desk staff |
| `supabase/functions/checkin-price/index.ts` | Create | Public price read |
| `supabase/functions/checkin-create-checkout/index.ts` | Create | Stripe Checkout for go-live |
| `supabase/functions/stripe-webhook/index.ts` | Modify | Check-in paid/refund, Pay-per-Event fix |
| `scripts/deploy-functions.sh` | Modify | Add new functions; no-verify list |
| `cuedeck-console.html` | Modify | `checkin_staff` block, `created_via` filter, drop client `events_used` write, keep header link |
| `vercel.json` | Modify | `/checkin`, `/checkin/setup`, `/checkin/desk`, `/kiosk` |
| `checkin-app.css` | Create | Shared light styles for the front page and Setup |
| `checkin-window.js`, `tests/checkin-window.spec.ts` | Create | Browser copy of the check-in window rule + test |
| `checkin-csv.js`, `tests/checkin-csv.spec.ts` | Create | Guest-list CSV parsing + test |
| `tests/checkin-staff.spec.ts` | Create | Staff removal rule + invite email normalisation |
| `cuedeck-checkin-home.html` | Create | Front page |
| `cuedeck-checkin-setup.html` | Create | Setup |
| `cuedeck-checkin.html` | Modify | `?event=`, test banner, watermark, badge preview, refusals |
| `docs/checkin-desk-runbook.md`, `deploy.md` | Modify | New URLs, test mode, go-live |

---

### Task 1: Database schema and SQL functions (migrations 059, 060)

**Files:**
- Create: `supabase/migrations/059_checkin_product_schema.sql`
- Create: `supabase/migrations/060_checkin_product_functions.sql`
- Modify: `supabase/config.toml`

**Interfaces:**
- Produces (columns): `leod_checkin_entitlements.status text ('test'|'live')`, `.went_live_at timestamptz`; `leod_checkin_scan_events.is_test bool`; `leod_checkin_attendees.is_test bool`; `leod_events.created_via text ('console'|'checkin')`; `leod_users.role` may be `'checkin_staff'`; table `leod_checkin_purchases`.
- Produces (SQL functions):
  - `checkin_test_usage(p_event_id uuid) returns integer` (callable by organizer/crew of the event; service role)
  - `checkin_mark_paid(p_event_id uuid, p_buyer_id uuid, p_session_id text, p_payment_intent text, p_customer text, p_amount_total integer, p_amount_tax integer, p_currency text) returns text` → `'live'` | `'already_processed'` (service role only)
  - `checkin_mark_refunded(p_payment_intent text) returns text` → `'test'` | `'not_found'` | `'already_refunded'` (service role only)
  - `increment_events_purchased(p_director_id uuid) returns integer` (service role only)
- Produces (scan results): `'test_cap'`, `'outside_window'` allowed in `leod_checkin_scan_events.result`.

- [ ] **Step 1: Confirm the constraint and function names this migration replaces**

Run each as its own `execute_sql`:
```sql
select conname from pg_constraint where conrelid = 'leod_users'::regclass and contype = 'c';
```
Expected: includes `leod_users_role_check`.
```sql
select conname from pg_constraint where conrelid = 'leod_checkin_scan_events'::regclass and contype = 'c';
```
Expected: includes `leod_checkin_scan_events_result_check`.
```sql
select count(*) from leod_checkin_entitlements;
```
Expected: `1` (the IME 2026 test event). Write the number down; Step 4 checks it.

- [ ] **Step 2: Write migration 059**

```sql
-- ============================================================
-- CueDeck — Migration 059: Check-in as a product — schema
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-04-checkin-product-design.md
-- Adds test/live state, test markers, purchases, check-in-only staff
-- accounts, event origin, and closes the organizer write path to
-- checked_in_at / is_test so the paywall cannot be stepped around with
-- a direct table write.
-- ============================================================

-- 1. Test / live state ----------------------------------------
ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS went_live_at TIMESTAMPTZ;

ALTER TABLE leod_checkin_entitlements DROP CONSTRAINT IF EXISTS leod_checkin_entitlements_status_check;
ALTER TABLE leod_checkin_entitlements
  ADD CONSTRAINT leod_checkin_entitlements_status_check CHECK (status IN ('test', 'live'));

-- Rows that existed before paid go-live keep working: they were
-- enabled by hand and are already in use.
UPDATE leod_checkin_entitlements
   SET status = 'live', went_live_at = created_at
 WHERE went_live_at IS NULL;

-- 2. Test markers ---------------------------------------------
ALTER TABLE leod_checkin_scan_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leod_checkin_attendees   ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_scan_events DROP CONSTRAINT IF EXISTS leod_checkin_scan_events_result_check;
ALTER TABLE leod_checkin_scan_events ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo', 'test_cap', 'outside_window'));

-- 3. Purchases ------------------------------------------------
CREATE TABLE IF NOT EXISTS leod_checkin_purchases (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                    UUID        NOT NULL REFERENCES leod_events(id) ON DELETE RESTRICT,
  buyer_id                    UUID        NOT NULL,
  stripe_checkout_session_id  TEXT        NOT NULL UNIQUE,
  stripe_payment_intent_id    TEXT,
  stripe_customer_id          TEXT,
  amount_total                INTEGER,
  amount_tax                  INTEGER,
  currency                    TEXT,
  paid_at                     TIMESTAMPTZ,
  refunded_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_purchases_event_idx ON leod_checkin_purchases(event_id);
CREATE INDEX IF NOT EXISTS leod_checkin_purchases_pi_idx    ON leod_checkin_purchases(stripe_payment_intent_id);

ALTER TABLE leod_checkin_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkin_purchase_read ON leod_checkin_purchases;
CREATE POLICY checkin_purchase_read ON leod_checkin_purchases
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');
-- No write policy: only checkin_mark_paid / checkin_mark_refunded write.

-- 4. Event origin ---------------------------------------------
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'console';
ALTER TABLE leod_events DROP CONSTRAINT IF EXISTS leod_events_created_via_check;
ALTER TABLE leod_events ADD CONSTRAINT leod_events_created_via_check CHECK (created_via IN ('console', 'checkin'));

-- 5. Check-in-only staff accounts -----------------------------
ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
  CHECK (role IN ('admin', 'director', 'stage', 'av', 'interp', 'reg', 'signage', 'pending', 'checkin_staff'));

-- Invited desk staff must never become directors: the console treats a
-- director as an account owner and starts a trial for them. A client
-- could set checkin_staff on its own signUp, but that only downgrades
-- itself, so trusting the metadata here is safe.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.leod_users (id, email, role, name, organization, active)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.raw_user_meta_data->>'checkin_staff' = 'true' THEN 'checkin_staff' ELSE 'director' END,
    COALESCE(NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'organization', ''),
    true
  )
  ON CONFLICT (id) DO NOTHING;  -- invited users already have their row, skip

  RETURN NEW;
END;
$function$;

-- 6. Attendee column guard: checked_in_at and is_test --------
-- Before 059 an organizer could write checked_in_at directly. With a
-- paid go-live that is a way round the paywall, so only the service
-- role (the Edge Functions) may change either column now, for every
-- role including organizer. Everything else is unchanged from 054.
CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
  v_role   TEXT;
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at THEN
    RAISE EXCEPTION 'checked_in_at may only be changed through the check-in desk' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'is_test may only be changed by CueDeck' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_role := checkin_role_for_event(OLD.event_id);
  IF v_role = 'organizer' THEN RETURN NEW; END IF;

  IF NEW.ticket_type IS DISTINCT FROM OLD.ticket_type THEN
    RAISE EXCEPTION 'ticket_type may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'external_ref may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'consent_at may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'source may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

-- Inserts from a client (organizer "Add person", CSV goes through the
-- service role) must not arrive already checked in or marked as test.
CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.checked_in_at IS NOT NULL OR NEW.badge_printed_at IS NOT NULL OR NEW.is_test THEN
    RAISE EXCEPTION 'new attendees start not checked in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_attendee_insert ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_guard_attendee_insert
  BEFORE INSERT ON leod_checkin_attendees
  FOR EACH ROW EXECUTE FUNCTION public.checkin_guard_attendee_insert();

-- 7. Date lock for live events -------------------------------
CREATE OR REPLACE FUNCTION public.checkin_lock_live_event_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NEW.date IS NOT DISTINCT FROM OLD.date THEN RETURN NEW; END IF;
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = OLD.id AND status = 'live') THEN
    RAISE EXCEPTION 'This event is live for check-in, so its date is locked. Contact support@cuedeck.io to move it.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_lock_live_event_date ON leod_events;
CREATE TRIGGER trg_checkin_lock_live_event_date
  BEFORE UPDATE OF date ON leod_events
  FOR EACH ROW EXECUTE FUNCTION public.checkin_lock_live_event_date();
```

- [ ] **Step 3: Write migration 060**

```sql
-- ============================================================
-- CueDeck — Migration 060: Check-in as a product — functions
-- ============================================================

-- Test usage: check-ins accepted in test + kiosk registrations in test.
CREATE OR REPLACE FUNCTION public.checkin_test_usage(p_event_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NOT (v_caller IS NULL OR v_caller = 'service_role')
     AND checkin_role_for_event(p_event_id) IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT count(*) FROM leod_checkin_scan_events
           WHERE event_id = p_event_id AND is_test AND result = 'ok')
       + (SELECT count(*) FROM leod_checkin_attendees
           WHERE event_id = p_event_id AND is_test);
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_test_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkin_test_usage(UUID) TO authenticated, service_role;

-- Go-live. One transaction: purchase row, state flip, test data cleared.
-- Idempotent on the Checkout Session id: a Stripe retry inserts nothing
-- and returns before touching any check-in made since the first delivery.
CREATE OR REPLACE FUNCTION public.checkin_mark_paid(
  p_event_id UUID, p_buyer_id UUID, p_session_id TEXT, p_payment_intent TEXT,
  p_customer TEXT, p_amount_total INTEGER, p_amount_tax INTEGER, p_currency TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id,
    stripe_payment_intent_id, stripe_customer_id, amount_total, amount_tax, currency, paid_at)
  VALUES (p_event_id, p_buyer_id, p_session_id, p_payment_intent, p_customer,
    p_amount_total, p_amount_tax, p_currency, now())
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN 'already_processed'; END IF;

  UPDATE leod_checkin_entitlements
     SET status = 'live', went_live_at = now()
   WHERE event_id = p_event_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'checkin_mark_paid: no entitlement row for event %', p_event_id;
  END IF;

  -- Test rows never recorded a real arrival; the organizer was told
  -- before paying that they would be cleared. Only check-ins that came
  -- from a TEST scan are reset: an event that was live, refunded back to
  -- test, and paid again keeps the real check-ins from its first live
  -- period. Must run before the test scan events are deleted.
  UPDATE leod_checkin_attendees
     SET checked_in_at = NULL, badge_printed_at = NULL
   WHERE event_id = p_event_id
     AND id IN (SELECT attendee_id FROM leod_checkin_scan_events
                 WHERE event_id = p_event_id AND is_test AND result = 'ok' AND attendee_id IS NOT NULL);
  DELETE FROM leod_checkin_print_jobs
   WHERE attendee_id IN (SELECT id FROM leod_checkin_attendees WHERE event_id = p_event_id AND is_test);
  DELETE FROM leod_checkin_scan_events WHERE event_id = p_event_id AND is_test;
  DELETE FROM leod_checkin_attendees   WHERE event_id = p_event_id AND is_test;

  RETURN 'live';
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_mark_paid(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_paid(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.checkin_mark_refunded(p_payment_intent TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event UUID;
  v_refunded TIMESTAMPTZ;
BEGIN
  SELECT event_id, refunded_at INTO v_event, v_refunded
    FROM leod_checkin_purchases WHERE stripe_payment_intent_id = p_payment_intent;
  IF v_event IS NULL THEN RETURN 'not_found'; END IF;
  IF v_refunded IS NOT NULL THEN RETURN 'already_refunded'; END IF;

  UPDATE leod_checkin_purchases SET refunded_at = now() WHERE stripe_payment_intent_id = p_payment_intent;
  UPDATE leod_checkin_entitlements SET status = 'test' WHERE event_id = v_event;
  RETURN 'test';
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_mark_refunded(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_refunded(TEXT) TO service_role;

-- Pay-per-Event credit. stripe-webhook has called this since the billing
-- integration landed, but it never existed (verified 2026-10-04).
CREATE OR REPLACE FUNCTION public.increment_events_purchased(p_director_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new INTEGER;
BEGIN
  UPDATE leod_subscriptions
     SET events_purchased = events_purchased + 1, plan = 'perevent', status = 'active', updated_at = now()
   WHERE director_id = p_director_id
  RETURNING events_purchased INTO v_new;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'increment_events_purchased: no subscription row for %', p_director_id;
  END IF;
  RETURN v_new;
END;
$function$;
REVOKE ALL ON FUNCTION public.increment_events_purchased(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_events_purchased(UUID) TO service_role;

-- Per-event usage counted on the server. The console's client update
-- was silently rejected by RLS (no director UPDATE policy).
CREATE OR REPLACE FUNCTION public.leod_events_count_perevent_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.created_via = 'console' AND NEW.created_by IS NOT NULL THEN
    UPDATE leod_subscriptions
       SET events_used = events_used + 1, updated_at = now()
     WHERE director_id = NEW.created_by AND plan = 'perevent';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leod_events_count_perevent_usage ON leod_events;
CREATE TRIGGER trg_leod_events_count_perevent_usage
  AFTER INSERT ON leod_events
  FOR EACH ROW EXECUTE FUNCTION public.leod_events_count_perevent_usage();
```

- [ ] **Step 4: Apply both migrations**

Use `apply_migration` with name `059_checkin_product_schema` and the file body, then `060_checkin_product_functions`.
Expected: both succeed. If 059 fails on a constraint name, re-run Step 1 and fix the name; do not use `CASCADE`.

- [ ] **Step 5: Verify the schema (paste every result into the PR)**

Each as its own `execute_sql`:
```sql
select event_id, status, went_live_at is not null as has_live_at from leod_checkin_entitlements;
```
Expected: the same row count as Step 1, every row `live`, `true`.
```sql
select column_name from information_schema.columns where table_schema='public' and ((table_name='leod_checkin_scan_events' and column_name='is_test') or (table_name='leod_checkin_attendees' and column_name='is_test') or (table_name='leod_events' and column_name='created_via')) order by 1;
```
Expected: 3 rows (`created_via`, `is_test`, `is_test`).
```sql
select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('checkin_test_usage','checkin_mark_paid','checkin_mark_refunded','increment_events_purchased','leod_events_count_perevent_usage','checkin_guard_attendee_insert','checkin_lock_live_event_date') order by 1;
```
Expected: 7 rows.
```sql
select has_function_privilege('authenticated', 'public.checkin_mark_paid(uuid,uuid,text,text,text,integer,integer,text)', 'execute') as auth_can_mark_paid;
```
Expected: `false`.

- [ ] **Step 6: Verify the guards behave (Review Focus 5)**

Run as a simulated organizer JWT. Use the IME 2026 event `bdd18620-1df4-4c95-b398-8a96a25f5d17` and the organizer grant held by `28230d43-5524-493d-8e23-684836934b53`. One statement:
```sql
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub','28230d43-5524-493d-8e23-684836934b53','role','authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update leod_checkin_attendees set checked_in_at = now()
     where id = (select id from leod_checkin_attendees where event_id='bdd18620-1df4-4c95-b398-8a96a25f5d17' and checked_in_at is null limit 1);
    raise exception 'GUARD_FAILED: organizer wrote checked_in_at';
  exception when insufficient_privilege then
    raise notice 'GUARD_OK: checked_in_at refused';
  end;
end $$;
```
Expected: notice `GUARD_OK: checked_in_at refused`; no `GUARD_FAILED`. The block runs inside one statement, so nothing persists.

Then the date lock, same pattern:
```sql
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub','28230d43-5524-493d-8e23-684836934b53','role','authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update leod_events set date = date + 1 where id = 'bdd18620-1df4-4c95-b398-8a96a25f5d17';
    raise exception 'GUARD_FAILED: live event date moved';
  exception when insufficient_privilege then
    raise notice 'GUARD_OK: date locked';
  end;
end $$;
```
Expected: `GUARD_OK: date locked`. If `role` cannot be switched in this environment, run the same two writes from the browser console of the desk page while signed in as the organizer and record the error text.

- [ ] **Step 7: Record JWT settings in config.toml**

Replace `supabase/config.toml` with:
```toml
project_id = "sawekpguemzvuvvulfbc"

# These run without a user JWT. Production already has verify_jwt = false
# for stripe-webhook (checked 2026-10-04); recording it here stops a CLI
# deploy from silently turning verification back on and breaking Stripe.
[functions.stripe-webhook]
verify_jwt = false

[functions.checkin-price]
verify_jwt = false

[functions.create-checkout-session]
verify_jwt = false

[functions.customer-portal]
verify_jwt = false

[functions.send-invoice-email]
verify_jwt = false

[functions.ai-proxy]
verify_jwt = false
```
The last four mirror production's current `verify_jwt: false` for those functions (from `list_edge_functions`), so a future CLI deploy keeps them as they are.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/059_checkin_product_schema.sql supabase/migrations/060_checkin_product_functions.sql supabase/config.toml
git commit -m "feat(checkin): migrations 059-060, test/live state, purchases, guards" -- supabase/migrations/059_checkin_product_schema.sql supabase/migrations/060_checkin_product_functions.sql supabase/config.toml
```

---

### Task 2: Pure policy module (window, cap, checkout routing)

**Files:**
- Create: `supabase/functions/_shared/checkin-policy.ts`
- Test: `tests/checkin-policy.spec.ts`

**Interfaces:**
- Produces:
  - `TEST_CAP: 25`
  - `checkinWindow(eventDate: string, timeZone: string): { opensAt: Date; closesAt: Date }`
  - `isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean`
  - `routeCheckoutSession(s: { metadata?: Record<string,string>|null; payment_status?: string }, lineItemProductIds: string[], checkinProductId: string): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string }`

- [ ] **Step 1: Write the failing test**

`tests/checkin-policy.spec.ts`:
```ts
// tests/checkin-policy.spec.ts
// Mirrors supabase/functions/_shared/checkin-policy.ts. Deno Edge
// Functions are not importable into vitest (see checkin-scan.spec.ts),
// so the logic is re-expressed here and kept in sync by hand.
import { describe, it, expect } from 'vitest';

const TEST_CAP = 25;

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function checkinWindow(eventDate: string, timeZone: string) {
  return { opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
           closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone) };
}

function isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean {
  const t = Date.parse(scannedAtIso);
  if (Number.isNaN(t)) return false;
  const w = checkinWindow(eventDate, timeZone);
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}

function routeCheckoutSession(
  s: { metadata?: Record<string, string> | null; payment_status?: string },
  lineItemProductIds: string[], checkinProductId: string,
): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string } {
  const md = s.metadata || {};
  if (md.product === 'checkin') {
    if (!md.event_id || !md.buyer_id) return { route: 'ignore', reason: 'checkin session missing event_id or buyer_id' };
    if (!lineItemProductIds.includes(checkinProductId)) return { route: 'ignore', reason: 'checkin metadata but line item is not the check-in product' };
    if (s.payment_status !== 'paid') return { route: 'ignore', reason: `payment_status ${s.payment_status}` };
    return { route: 'checkin' };
  }
  if (md.plan === 'perevent') return { route: 'perevent' };
  return { route: 'ignore', reason: 'not a CueDeck check-in or Pay-per-Event session' };
}

describe('checkinWindow', () => {
  it('opens at local midnight 7 days before, Warsaw summer (UTC+2)', () => {
    expect(checkinWindow('2026-06-20', 'Europe/Warsaw').opensAt.toISOString()).toBe('2026-06-12T22:00:00.000Z');
  });
  it('closes at local midnight starting date+3, Warsaw summer', () => {
    expect(checkinWindow('2026-06-20', 'Europe/Warsaw').closesAt.toISOString()).toBe('2026-06-22T22:00:00.000Z');
  });
  it('handles a DST change inside the window (Warsaw, Oct 25 2026)', () => {
    const w = checkinWindow('2026-10-26', 'Europe/Warsaw');
    expect(w.opensAt.toISOString()).toBe('2026-10-18T22:00:00.000Z'); // still CEST
    expect(w.closesAt.toISOString()).toBe('2026-10-28T23:00:00.000Z'); // CET
  });
});

describe('isWithinWindow', () => {
  it('Cairo: 23:30 local on date+2 is inside', () => {
    // 2026-11-12 is the event; date+2 = 2026-11-14; Cairo is UTC+2 in November.
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(true);
  });
  it('Cairo: 00:10 local on date+3 is outside', () => {
    expect(isWithinWindow('2026-11-14T22:10:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(false);
  });
  it('Los Angeles: 23:59 local on date-8 is outside, 00:00 on date-7 is inside', () => {
    // event 2026-11-20; date-7 = 2026-11-13; LA is UTC-8 in November.
    expect(isWithinWindow('2026-11-13T07:59:00.000Z', '2026-11-20', 'America/Los_Angeles')).toBe(false);
    expect(isWithinWindow('2026-11-13T08:00:00.000Z', '2026-11-20', 'America/Los_Angeles')).toBe(true);
  });
  it('garbage timestamp is outside', () => {
    expect(isWithinWindow('not-a-date', '2026-11-20', 'UTC')).toBe(false);
  });
});

describe('routeCheckoutSession', () => {
  const P = 'prod_checkin';
  it('routes a paid check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, [P], P).route).toBe('checkin');
  });
  it('ignores an unpaid (async) check-in session', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'unpaid' }, [P], P).route).toBe('ignore');
  });
  it('ignores check-in metadata on a different product (forged or CueQuote)', () => {
    expect(routeCheckoutSession({ metadata: { product: 'checkin', event_id: 'e', buyer_id: 'b' }, payment_status: 'paid' }, ['prod_other'], P).route).toBe('ignore');
  });
  it('routes Pay-per-Event', () => {
    expect(routeCheckoutSession({ metadata: { plan: 'perevent' }, payment_status: 'paid' }, ['prod_U7KZqMU9oG4QWD'], P).route).toBe('perevent');
  });
  it('ignores a CueQuote session with no CueDeck metadata', () => {
    expect(routeCheckoutSession({ metadata: { company_id: 'x' }, payment_status: 'paid' }, ['prod_cq'], P).route).toBe('ignore');
  });
  it('TEST_CAP is 25', () => { expect(TEST_CAP).toBe(25); });
});
```

- [ ] **Step 2: Run it to see the DST expectation hold or fail honestly**

Run: `npx vitest run tests/checkin-policy.spec.ts`
Expected: PASS for all (the logic is in the test file by convention). If the DST case fails, the offset helper is wrong; fix the helper in the test first, then mirror it.

- [ ] **Step 3: Write the Deno module, identical logic**

`supabase/functions/_shared/checkin-policy.ts`:
```ts
// supabase/functions/_shared/checkin-policy.ts
// Pure rules for check-in as a product: test cap, live check-in window,
// and which Stripe Checkout sessions belong to whom. Mirrored by
// tests/checkin-policy.spec.ts; keep the two in sync by hand.

export const TEST_CAP = 25

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Midnight at the start of `ymd` in `timeZone`, as a UTC instant. The
// second offset read handles a DST change between UTC midnight and
// local midnight.
function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const off1 = tzOffsetMs(new Date(guess), timeZone)
  let t = guess - off1
  const off2 = tzOffsetMs(new Date(t), timeZone)
  if (off2 !== off1) t = guess - off2
  return new Date(t)
}

// From the start of (date - 7) to the start of (date + 3), local time.
export function checkinWindow(eventDate: string, timeZone: string): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
    closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone),
  }
}

export function isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean {
  const t = Date.parse(scannedAtIso)
  if (Number.isNaN(t)) return false
  const w = checkinWindow(eventDate, timeZone)
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime()
}

export function routeCheckoutSession(
  s: { metadata?: Record<string, string> | null; payment_status?: string },
  lineItemProductIds: string[],
  checkinProductId: string,
): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string } {
  const md = s.metadata || {}
  if (md.product === 'checkin') {
    if (!md.event_id || !md.buyer_id) return { route: 'ignore', reason: 'checkin session missing event_id or buyer_id' }
    if (!lineItemProductIds.includes(checkinProductId)) return { route: 'ignore', reason: 'checkin metadata but line item is not the check-in product' }
    if (s.payment_status !== 'paid') return { route: 'ignore', reason: `payment_status ${s.payment_status}` }
    return { route: 'checkin' }
  }
  if (md.plan === 'perevent') return { route: 'perevent' }
  return { route: 'ignore', reason: 'not a CueDeck check-in or Pay-per-Event session' }
}
```

- [ ] **Step 4: Diff the two copies**

Run: `diff <(sed -n '/^function tzOffsetMs/,/^}/p' tests/checkin-policy.spec.ts | tr -d ';') <(sed -n '/^function tzOffsetMs/,/^}/p' supabase/functions/_shared/checkin-policy.ts)`
Expected: no output (semicolons are the only difference and are stripped).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/checkin-policy.ts tests/checkin-policy.spec.ts
git commit -m "feat(checkin): policy module for test cap, check-in window, checkout routing" -- supabase/functions/_shared/checkin-policy.ts tests/checkin-policy.spec.ts
```

---

### Task 3: `checkin-record-scans` enforces test cap and live window

**Files:**
- Modify: `supabase/functions/checkin-record-scans/index.ts`
- Test: `tests/checkin-policy.spec.ts` (append the verdict-order tests below)

**Interfaces:**
- Consumes: `TEST_CAP`, `isWithinWindow` (Task 2); `checkin_test_usage` (Task 1).
- Produces: per-item verdicts may now be `'test_cap'` or `'outside_window'`; every inserted scan event carries `is_test`.

- [ ] **Step 1: Write the failing verdict-order test**

Append to `tests/checkin-policy.spec.ts`:
```ts
// Mirrors the verdict order inside checkin-record-scans for a 'checkin'
// item whose attendee belongs to the event.
function checkinVerdict(o: { alreadyIn: boolean; isTest: boolean; testUsed: number; inWindow: boolean }):
  'duplicate' | 'test_cap' | 'outside_window' | 'apply' {
  if (o.alreadyIn) return 'duplicate';
  if (o.isTest && o.testUsed >= TEST_CAP) return 'test_cap';
  if (!o.isTest && !o.inWindow) return 'outside_window';
  return 'apply';
}

describe('checkinVerdict', () => {
  it('a duplicate never consumes the test cap', () => {
    expect(checkinVerdict({ alreadyIn: true, isTest: true, testUsed: 25, inWindow: true })).toBe('duplicate');
  });
  it('the 26th test check-in is refused', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 25, inWindow: true })).toBe('test_cap');
  });
  it('the 25th test check-in is applied', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 24, inWindow: true })).toBe('apply');
  });
  it('test mode ignores the live window', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: true, testUsed: 0, inWindow: false })).toBe('apply');
  });
  it('live outside the window is refused', () => {
    expect(checkinVerdict({ alreadyIn: false, isTest: false, testUsed: 0, inWindow: false })).toBe('outside_window');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-policy.spec.ts`
Expected: PASS. (The function under test is the mirror; Step 3 makes the Deno code follow the same order.)

- [ ] **Step 3: Import the policy module**

After line 12 (`import { corsHeaders }  from '../_shared/cors.ts'`) add:
```ts
import { TEST_CAP, isWithinWindow } from '../_shared/checkin-policy.ts'
```

- [ ] **Step 4: Read status, event date and test usage once per request**

Replace the entitlement block (the `const { data: entRow } = await sb.from('leod_checkin_entitlements')` statement and its `if (!entRow?.checkin_core)` return) with:
```ts
  const { data: entRow, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status').eq('event_id', event_id).maybeSingle()
  if (entErr) {
    return new Response(JSON.stringify({ error: entErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!entRow?.checkin_core) {
    return new Response(JSON.stringify({ error: 'Check-in is not enabled for this event' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const isTest = entRow.status !== 'live'

  // The live window is a calendar rule in the event's own timezone.
  const { data: evRow, error: evErr } = await sb.from('leod_events')
    .select('date, timezone').eq('id', event_id).single()
  if (evErr || !evRow) {
    return new Response(JSON.stringify({ error: evErr?.message || 'Event not found' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Read once and counted forward locally, so a batch of 30 cannot all
  // pass a cap check that each one read as 24. Two desks flushing at the
  // same instant can still overshoot by a few; the cap is a commercial
  // limit, not a safety one, and that is accepted.
  let testUsed = 0
  if (isTest) {
    const { data: used, error: usedErr } = await sb.rpc('checkin_test_usage', { p_event_id: event_id })
    if (usedErr || typeof used !== 'number') {
      return new Response(JSON.stringify({ error: usedErr?.message || 'Could not read test usage' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    testUsed = used
  }
```

- [ ] **Step 5: Apply the verdict order inside the loop**

Replace:
```ts
      } else if (att.checked_in_at) {
        result = 'duplicate'
      } else {
```
with:
```ts
      } else if (att.checked_in_at) {
        result = 'duplicate'
      } else if (isTest && testUsed >= TEST_CAP) {
        result = 'test_cap'
      } else if (!isTest && !isWithinWindow(it.scanned_at, evRow.date, evRow.timezone)) {
        result = 'outside_window'
      } else {
```
Then directly after `result = updated && updated.length > 0 ? 'ok' : 'duplicate'` add:
```ts
        if (isTest && result === 'ok') testUsed++
```

- [ ] **Step 6: Mark the audit row**

In the `leod_checkin_scan_events` insert object, after `result,` add:
```ts
        is_test: isTest,
```

- [ ] **Step 7: Type-check**

Run: `deno check supabase/functions/checkin-record-scans/index.ts`
Expected: no errors. (If `deno` is not installed: `brew install deno`.)

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/checkin-record-scans/index.ts tests/checkin-policy.spec.ts
git commit -m "feat(checkin): record-scans enforces test cap and live check-in window" -- supabase/functions/checkin-record-scans/index.ts tests/checkin-policy.spec.ts
```

---

### Task 4: Kiosk, QR emails and import respect test/live

**Files:**
- Modify: `supabase/functions/checkin-self-register/index.ts:280-283, 352-361`
- Modify: `supabase/functions/_shared/qr-email.ts` (`sendQrEmailsForAttendees` signature)
- Modify: `supabase/functions/checkin-send-qr-emails/index.ts`
- Modify: `supabase/functions/checkin-import-attendees/index.ts:96-97, 216`
- Test: `tests/checkin-qr-email.spec.ts` (append)

**Interfaces:**
- Consumes: `TEST_CAP` (Task 2), `checkin_test_usage` (Task 1).
- Produces:
  - `sendQrEmailsForAttendees(sb, event, attendees, opts?: { overrideTo?: string; recordSent?: boolean })`
  - `checkin-send-qr-emails` body `{ event_id, attendee_ids?, test_to_self?: boolean }`; when not live and not `test_to_self` → HTTP 403 `{ error, code: 'not_live' }`
  - `checkin-self-register` in test: attendee `is_test = true`; over cap → HTTP 403 `{ error, code: 'test_cap' }`; success adds `test: boolean`

- [ ] **Step 1: Write the failing test for the send gate**

Append to `tests/checkin-qr-email.spec.ts`:
```ts
// Mirrors the gate at the top of checkin-send-qr-emails after 059.
function qrSendGate(status: 'test' | 'live', testToSelf: boolean): 'send_all' | 'send_self' | 'refuse' {
  if (testToSelf) return 'send_self';
  return status === 'live' ? 'send_all' : 'refuse';
}

describe('qrSendGate', () => {
  it('test mode refuses a real send', () => { expect(qrSendGate('test', false)).toBe('refuse'); });
  it('test mode allows send-to-self', () => { expect(qrSendGate('test', true)).toBe('send_self'); });
  it('live sends', () => { expect(qrSendGate('live', false)).toBe('send_all'); });
  it('live send-to-self still only goes to self', () => { expect(qrSendGate('live', true)).toBe('send_self'); });
});
```
(The file already imports `describe, it, expect` from vitest.)

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-qr-email.spec.ts`
Expected: PASS.

- [ ] **Step 3: Extend `sendQrEmailsForAttendees`**

In `supabase/functions/_shared/qr-email.ts`, change the signature and the two lines that use the recipient and record the send:
```ts
export async function sendQrEmailsForAttendees(
  sb: ReturnType<typeof import('./client.ts').adminClient>,
  event: QrEmailEvent,
  attendees: QrEmailAttendee[],
  // overrideTo: deliver to this address instead (the organizer's own
  // "send a test to myself"). recordSent false: do not stamp
  // qr_email_sent_at, because the guest has not been emailed.
  opts: { overrideTo?: string; recordSent?: boolean } = {},
): Promise<QrEmailResult[]> {
```
Inside the loop, replace `if (!attendee.email) {` with:
```ts
    const to = opts.overrideTo ?? attendee.email
    if (!to) {
```
Replace `to: attendee.email,` with `to,`.
Wrap the `qr_email_sent_at` update so it only runs when `opts.recordSent !== false`:
```ts
      if (opts.recordSent !== false) {
        const { error: updateErr } = await sb.from('leod_checkin_attendees')
          .update({ qr_email_sent_at: new Date().toISOString() })
          .eq('id', attendee.id)
        if (updateErr) {
          console.error('sendQrEmailsForAttendees: qr_email_sent_at update failed for', attendee.id, updateErr.message)
        }
      }
```
(keep the original comment above it).

- [ ] **Step 4: Gate `checkin-send-qr-emails`**

Change the entitlement select to `.select('checkin_core, status')`. After the `if (!entRow?.checkin_core)` block add:
```ts
  const testToSelf = body.test_to_self === true
  if (!testToSelf && entRow.status !== 'live') {
    return new Response(JSON.stringify({ error: 'Go live to send QR emails to your guests', code: 'not_live' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```
After the `event` fetch, before `let attendeesQuery`, add the send-to-self path:
```ts
  if (testToSelf) {
    if (!user.email) {
      return new Response(JSON.stringify({ error: 'Your account has no email address' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const { data: sample, error: sampleErr } = await sb.from('leod_checkin_attendees')
      .select('id, first_name, email, qr_token')
      .eq('event_id', event_id).order('created_at', { ascending: true }).limit(1)
    if (sampleErr) {
      return new Response(JSON.stringify({ error: sampleErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (!sample || !sample.length) {
      return new Response(JSON.stringify({ error: 'Add at least one attendee first' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const res = await sendQrEmailsForAttendees(sb, event, sample, { overrideTo: user.email, recordSent: false })
    const failed = res.find(r => r.status === 'error')
    return new Response(JSON.stringify(failed
      ? { ok: false, error: failed.error }
      : { ok: true, sent_to: user.email }), {
      status: failed ? 502 : 200, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

- [ ] **Step 5: Gate auto-send on import**

In `checkin-import-attendees/index.ts` line 97 change the select to `.select('checkin_core, auto_send_qr_email, status')`. Line 216 becomes:
```ts
  if (entRow.auto_send_qr_email && entRow.status === 'live' && insertedAttendees.length) {
```

- [ ] **Step 6: Test-mark and cap kiosk registrations**

At the top of `checkin-self-register/index.ts` add `import { TEST_CAP } from '../_shared/checkin-policy.ts'`. Line 280 select becomes `.select('checkin_core, self_registration, status')`. Directly before `const qr_token = makeQrToken()` add:
```ts
  const isTest = entRow.status !== 'live'
  if (isTest) {
    const { data: used, error: usedErr } = await sb.rpc('checkin_test_usage', { p_event_id: event_id })
    if (usedErr || typeof used !== 'number') {
      console.error('checkin-self-register: test usage read failed, device', device.id, usedErr?.code)
      return json({ error: 'Registration failed' }, 500)
    }
    if (used >= TEST_CAP) {
      return json({ error: 'This event is in test mode and has used its test registrations. Please see the desk.', code: 'test_cap' }, 403)
    }
  }
```
In the insert object add `is_test: isTest,` after `source: 'kiosk',`. Change the final return to:
```ts
  return json({ status: 'registered', code: shortCode(created.qr_token), test: isTest })
```

- [ ] **Step 7: Type-check all four**

Run: `deno check supabase/functions/checkin-self-register/index.ts supabase/functions/checkin-send-qr-emails/index.ts supabase/functions/checkin-import-attendees/index.ts supabase/functions/_shared/qr-email.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/checkin-self-register/index.ts supabase/functions/_shared/qr-email.ts supabase/functions/checkin-send-qr-emails/index.ts supabase/functions/checkin-import-attendees/index.ts tests/checkin-qr-email.spec.ts
git commit -m "feat(checkin): kiosk, QR email and import follow test/live state" -- supabase/functions/checkin-self-register/index.ts supabase/functions/_shared/qr-email.ts supabase/functions/checkin-send-qr-emails/index.ts supabase/functions/checkin-import-attendees/index.ts tests/checkin-qr-email.spec.ts
```

---

### Task 5: `checkin-enable-event` creates in test; `checkin-invite-staff`

**Files:**
- Modify: `supabase/functions/checkin-enable-event/index.ts:79-96`
- Create: `supabase/functions/checkin-invite-staff/index.ts`
- Test: `tests/checkin-staff.spec.ts`

**Interfaces:**
- Produces:
  - `checkin-enable-event` body `{ event_id, settings?: { self_registration?: boolean; kiosk_self_print?: boolean; auto_send_qr_email?: boolean }, entitlements?: {...} }` → `{ ok: true, event_id, status }`. `entitlements` (commercial flags) honoured for admins only.
  - `checkin-invite-staff` body `{ event_id, action: 'invite', email, name?, role: 'crew' | 'organizer' }` → `{ ok: true, user_id, invited: boolean }`; `{ event_id, action: 'remove', user_id }` → `{ ok: true }`. Errors: 400 bad input, 403 not organizer, 409 `{ code: 'last_organizer' | 'event_owner' }`.

- [ ] **Step 1: Write the failing removal-rule test**

`tests/checkin-staff.spec.ts`:
```ts
// tests/checkin-staff.spec.ts
// Mirrors the removal rule in supabase/functions/checkin-invite-staff.
import { describe, it, expect } from 'vitest';

type Op = { user_id: string; role: 'organizer' | 'crew' };

function canRemove(target: string, ownerId: string | null, ops: Op[]): { ok: true } | { ok: false; code: 'event_owner' | 'last_organizer' | 'not_found' } {
  const row = ops.find(o => o.user_id === target);
  if (!row) return { ok: false, code: 'not_found' };
  if (target === ownerId) return { ok: false, code: 'event_owner' };
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) return { ok: false, code: 'last_organizer' };
  return { ok: true };
}

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

describe('canRemove', () => {
  const ops: Op[] = [{ user_id: 'owner', role: 'organizer' }, { user_id: 'co', role: 'organizer' }, { user_id: 'crew1', role: 'crew' }];
  it('never removes the event owner', () => { expect(canRemove('owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' }); });
  it('removes crew', () => { expect(canRemove('crew1', 'owner', ops)).toEqual({ ok: true }); });
  it('removes a co-organizer when another organizer remains', () => { expect(canRemove('co', 'owner', ops)).toEqual({ ok: true }); });
  it('keeps the last organizer', () => {
    expect(canRemove('co', null, [{ user_id: 'co', role: 'organizer' }])).toEqual({ ok: false, code: 'last_organizer' });
  });
});

describe('normalizeInviteEmail', () => {
  it('lowercases and trims', () => { expect(normalizeInviteEmail('  Ana@Example.COM ')).toBe('ana@example.com'); });
  it('rejects garbage', () => { expect(normalizeInviteEmail('not an email')).toBeNull(); });
  it('rejects non-strings', () => { expect(normalizeInviteEmail(42)).toBeNull(); });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-staff.spec.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite the entitlement write in `checkin-enable-event`**

Replace the block from `const opts = (body.entitlements as Record<string, boolean>) || {}` through the `if (upsertErr) { ... }` return with:
```ts
  // Create in test. ON CONFLICT DO NOTHING: an existing row keeps its
  // status (this function must never move an event to or from live;
  // only checkin_mark_paid / checkin_mark_refunded do that).
  const { error: insErr } = await sb.from('leod_checkin_entitlements')
    .upsert({ event_id, checkin_core: true, status: 'test' }, { onConflict: 'event_id', ignoreDuplicates: true })
  if (insErr) {
    return new Response(JSON.stringify({ error: insErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Operational settings: what the organizer chose for this event.
  const s = (body.settings as Record<string, unknown>) || {}
  const patch: Record<string, boolean> = {}
  for (const k of ['self_registration', 'kiosk_self_print', 'auto_send_qr_email']) {
    if (typeof s[k] === 'boolean') patch[k] = s[k] as boolean
  }
  // Commercial entitlements: what was bought. Admin only. Before this
  // change any event owner could switch these on for themselves.
  const ent = (body.entitlements as Record<string, unknown>) || {}
  if (isAdmin) {
    for (const k of ['multi_point_scanning', 'integration_api', 'personalization_station', 'pii_in_api']) {
      if (typeof ent[k] === 'boolean') patch[k] = ent[k] as boolean
    }
  }
  if (Object.keys(patch).length) {
    const { error: patchErr } = await sb.from('leod_checkin_entitlements').update(patch).eq('event_id', event_id)
    if (patchErr) {
      return new Response(JSON.stringify({ error: patchErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  const { data: after, error: readErr } = await sb.from('leod_checkin_entitlements')
    .select('status').eq('event_id', event_id).single()
  if (readErr || !after) {
    return new Response(JSON.stringify({ error: readErr?.message || 'Entitlement missing after write' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```
and change the final response body to `JSON.stringify({ ok: true, event_id, status: after.status })`.

Also change the organizer-grant failure from a `console.error` only to a returned 500, because a front-page event the creator cannot open is a dead end:
```ts
    if (grantErr) {
      return new Response(JSON.stringify({ error: 'Could not grant organizer: ' + grantErr.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
```

- [ ] **Step 4: Write `checkin-invite-staff`**

`supabase/functions/checkin-invite-staff/index.ts`:
```ts
// supabase/functions/checkin-invite-staff/index.ts
// Organizer adds or removes desk staff for one event. A new address gets
// a Supabase invite carrying checkin_staff = 'true', which migration
// 059's signup trigger turns into a check-in-only leod_users row (never
// a director). An existing CueDeck user just gets the grant and a short
// notice email. Removing deletes the grant only; the login is theirs.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const event_id = String(body.event_id || '')
  const action = String(body.action || '')
  if (!event_id || (action !== 'invite' && action !== 'remove')) return json({ error: 'event_id and action required' }, 400)

  const { data: me, error: meErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).maybeSingle()
  if (meErr) return json({ error: meErr.message }, 500)
  if (me?.role !== 'organizer') return json({ error: 'Forbidden, organizers only' }, 403)

  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('name, created_by').eq('id', event_id).single()
  if (evErr || !ev) return json({ error: evErr?.message || 'Event not found' }, 404)

  if (action === 'remove') {
    const target = String(body.user_id || '')
    if (!target) return json({ error: 'user_id required' }, 400)
    const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
      .select('user_id, role').eq('event_id', event_id).in('role', ['organizer', 'crew'])
    if (opsErr) return json({ error: opsErr.message }, 500)
    const row = (ops || []).find(o => o.user_id === target)
    if (!row) return json({ error: 'Not on this event' }, 404)
    if (target === ev.created_by) return json({ error: 'The event owner cannot be removed', code: 'event_owner' }, 409)
    if (row.role === 'organizer' && (ops || []).filter(o => o.role === 'organizer').length <= 1) {
      return json({ error: 'An event needs at least one organizer', code: 'last_organizer' }, 409)
    }
    const { error: delErr } = await sb.from('leod_checkin_operators').delete().eq('event_id', event_id).eq('user_id', target)
    if (delErr) return json({ error: delErr.message }, 500)
    return json({ ok: true })
  }

  const email = normalizeInviteEmail(body.email)
  const role = body.role === 'organizer' ? 'organizer' : body.role === 'crew' ? 'crew' : null
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (!email || !role) return json({ error: 'A valid email and role are required' }, 400)

  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const { data: existing, error: exErr } = await sb.from('leod_users')
    .select('id').ilike('email', email).maybeSingle()
  if (exErr) return json({ error: exErr.message }, 500)

  let userId: string
  let invited = false
  if (existing) {
    userId = existing.id
  } else {
    const { data: inv, error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { checkin_staff: 'true', name },
      redirectTo: `${appUrl}/checkin`,
    })
    if (invErr || !inv?.user) return json({ error: invErr?.message || 'Invite failed' }, 502)
    userId = inv.user.id
    invited = true
  }

  const { error: grantErr } = await sb.from('leod_checkin_operators')
    .upsert({ event_id, user_id: userId, role }, { onConflict: 'event_id,user_id' })
  if (grantErr) return json({ error: grantErr.message }, 500)

  if (!invited) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added to ${ev.name} check-in`,
      html: `<p>You can now open the check-in desk for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${appUrl}/checkin">Open CueDeck Check-in</a> and sign in with your CueDeck login.</p>`,
      fromName: 'CueDeck Check-in',
    })
    // The grant is in place; a lost notice is not worth failing the
    // request over, but it must be visible.
    if (mailErr) console.error('checkin-invite-staff: notice email failed for event', event_id, mailErr)
  }

  return json({ ok: true, user_id: userId, invited })
})
```
Keep `normalizeInviteEmail` and the removal rule identical to the mirror in `tests/checkin-staff.spec.ts`.

- [ ] **Step 5: Add both to the deploy list**

In `scripts/deploy-functions.sh` line 8, append `checkin-invite-staff checkin-price checkin-create-checkout` to `ALL_FUNCTIONS`. After the `if supabase functions deploy` line, the deploy call must pass `--no-verify-jwt` for the two public functions. Replace line 29 with:
```bash
  extra=()
  case "$func" in stripe-webhook|checkin-price|create-checkout-session|customer-portal|send-invoice-email|ai-proxy) extra=(--no-verify-jwt) ;; esac
  if supabase functions deploy "$func" --project-ref "sawekpguemzvuvvulfbc" --workdir "$PROJ" "${extra[@]}" 2>&1; then
```

- [ ] **Step 6: Type-check**

Run: `deno check supabase/functions/checkin-enable-event/index.ts supabase/functions/checkin-invite-staff/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/checkin-enable-event/index.ts supabase/functions/checkin-invite-staff/index.ts tests/checkin-staff.spec.ts scripts/deploy-functions.sh
git commit -m "feat(checkin): enable-event creates in test, staff invites, admin-only commercial flags" -- supabase/functions/checkin-enable-event/index.ts supabase/functions/checkin-invite-staff/index.ts tests/checkin-staff.spec.ts scripts/deploy-functions.sh
```

---

### Task 6: Stripe product, price, checkout and webhook

**Files:**
- Create: `supabase/functions/checkin-price/index.ts`
- Create: `supabase/functions/checkin-create-checkout/index.ts`
- Modify: `supabase/functions/stripe-webhook/index.ts:26-30, 239-270`, plus new cases
- Test: `tests/checkin-policy.spec.ts` (routing tests already written in Task 2)

**Interfaces:**
- Consumes: `routeCheckoutSession` (Task 2); `checkin_mark_paid`, `checkin_mark_refunded`, `increment_events_purchased` (Task 1).
- Produces:
  - `checkin-price` GET or POST → `{ amount: number /* minor units */, currency: 'eur', tax_behavior: 'exclusive' }`
  - `checkin-create-checkout` body `{ event_id }` → `{ url }`; 409 `{ code: 'already_live' }` if live
  - Supabase secrets: `CHECKIN_PRICE_ID`, `CHECKIN_PRODUCT_ID`

- [ ] **Step 1: Create the Stripe product and price (needs Stripe access)**

**Blocked until Sherif provides access** (dashboard or `stripe login` in this session). With the Stripe CLI:
```bash
stripe products create --name "CueDeck Check-in (per event)" --description "Event check-in for one event: unlimited attendees and desks, QR emails, badge printing, self-registration kiosk, offline desk, attendance export." --tax-code txcd_10103001
stripe prices create --product <prod_id_from_above> --currency eur --unit-amount 24900 --tax-behavior exclusive
```
Expected: a `prod_...` and a `price_...`. Record both in the PR. `txcd_10103001` is Stripe's "Software as a service (SaaS) - business use" tax code; confirm it matches the existing CueDeck products with `stripe products retrieve prod_U7KgJwoWMsbmzN` and use the same code if it differs.

Then:
```bash
supabase secrets set CHECKIN_PRICE_ID=<price_id> CHECKIN_PRODUCT_ID=<prod_id> --project-ref sawekpguemzvuvvulfbc
```

In the Stripe dashboard webhook endpoint for `https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/stripe-webhook`, add the events `checkout.session.async_payment_succeeded` and `charge.refunded` (keep the existing ones). Also confirm **Settings → Customer emails → Successful payments** is on, so the buyer gets the invoice.

- [ ] **Step 2: Write `checkin-price`**

`supabase/functions/checkin-price/index.ts`:
```ts
// supabase/functions/checkin-price/index.ts
// Public read of the check-in price. The Stripe price is the single
// source of the amount; pages and cuedeck.io read it here.
// Deployed with --no-verify-jwt (see supabase/config.toml).

import { corsHeaders } from '../_shared/cors.ts'
import { stripe }      from '../_shared/stripe.ts'

let cache: { at: number; body: string } | null = null
const TTL_MS = 10 * 60 * 1000

Deno.serve(async (req) => {
  const cors = { ...corsHeaders(req), 'Access-Control-Allow-Origin': '*' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  if (cache && Date.now() - cache.at < TTL_MS) {
    return new Response(cache.body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })
  }

  const priceId = Deno.env.get('CHECKIN_PRICE_ID')
  if (!priceId) return new Response(JSON.stringify({ error: 'Not configured' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    const p = await stripe().prices.retrieve(priceId)
    if (!p.active || p.unit_amount == null) throw new Error('price inactive or has no unit_amount')
    const body = JSON.stringify({ amount: p.unit_amount, currency: p.currency, tax_behavior: p.tax_behavior })
    cache = { at: Date.now(), body }
    return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })
  } catch (e) {
    console.error('checkin-price: stripe read failed', (e as Error).message)
    return new Response(JSON.stringify({ error: 'Price unavailable' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
```
The price is public information, so `Access-Control-Allow-Origin: *` is intended here and only here.

- [ ] **Step 3: Write `checkin-create-checkout`**

`supabase/functions/checkin-create-checkout/index.ts`:
```ts
// supabase/functions/checkin-create-checkout/index.ts
// Opens Stripe Checkout for one event's go-live. The webhook, not this
// function and not the success redirect, is what makes the event live.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { stripe }       from '../_shared/stripe.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const event_id = String(body.event_id || '')
  if (!event_id) return json({ error: 'event_id required' }, 400)

  const { data: op, error: opErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).maybeSingle()
  if (opErr) return json({ error: opErr.message }, 500)
  if (op?.role !== 'organizer') return json({ error: 'Forbidden, organizers only' }, 403)

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('status').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent) return json({ error: 'Set up check-in for this event first' }, 409)
  if (ent.status === 'live') return json({ error: 'This event is already live', code: 'already_live' }, 409)

  const { data: ev, error: evErr } = await sb.from('leod_events').select('name').eq('id', event_id).single()
  if (evErr || !ev) return json({ error: evErr?.message || 'Event not found' }, 404)

  const priceId = Deno.env.get('CHECKIN_PRICE_ID')
  if (!priceId) return json({ error: 'Check-in payments are not configured' }, 503)

  const st = stripe()

  // Customer reuse: CueDeck subscription first, then an earlier check-in
  // purchase, else a new customer. Check-in-only buyers have no
  // leod_subscriptions row, which create-checkout-session assumes.
  let customerId: string | null = null
  const { data: sub, error: subErr } = await sb.from('leod_subscriptions')
    .select('stripe_customer_id').eq('director_id', user.id).maybeSingle()
  if (subErr) return json({ error: subErr.message }, 500)
  customerId = sub?.stripe_customer_id ?? null
  if (!customerId) {
    const { data: prev, error: prevErr } = await sb.from('leod_checkin_purchases')
      .select('stripe_customer_id').eq('buyer_id', user.id).not('stripe_customer_id', 'is', null)
      .order('created_at', { ascending: false }).limit(1)
    if (prevErr) return json({ error: prevErr.message }, 500)
    customerId = prev?.[0]?.stripe_customer_id ?? null
  }

  try {
    if (!customerId) {
      const c = await st.customers.create({ email: user.email ?? undefined, metadata: { cuedeck_user_id: user.id } })
      customerId = c.id
    }
    const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
    const session = await st.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      invoice_creation: { enabled: true, invoice_data: { description: `CueDeck Check-in: ${ev.name}`, metadata: { event_id } } },
      client_reference_id: user.id,
      metadata: { product: 'checkin', event_id, buyer_id: user.id },
      payment_intent_data: { metadata: { product: 'checkin', event_id } },
      success_url: `${appUrl}/checkin/setup?event=${event_id}&paid=1`,
      cancel_url: `${appUrl}/checkin/setup?event=${event_id}&step=golive`,
      locale: 'auto',
    })
    return json({ url: session.url })
  } catch (e) {
    console.error('checkin-create-checkout: stripe error for event', event_id, (e as Error).message)
    return json({ error: 'Could not start payment. Please try again.' }, 502)
  }
})
```

- [ ] **Step 4: Webhook: register the product and route check-in sessions**

In `stripe-webhook/index.ts`:

(a) Add the import: `import { routeCheckoutSession } from '../_shared/checkin-policy.ts'`.

(b) Add the product to the set, read from the secret so no id is hardcoded twice:
```ts
const CHECKIN_PRODUCT_ID = Deno.env.get('CHECKIN_PRODUCT_ID') || ''
if (CHECKIN_PRODUCT_ID) CUEDECK_PRODUCTS.add(CHECKIN_PRODUCT_ID)
```
directly after the `CUEDECK_PRODUCTS` declaration.

(c) Add a helper above `Deno.serve`:
```ts
// Returns a Response only when the webhook must answer non-200 so Stripe
// retries. null means handled (or deliberately ignored).
async function handleCheckinPaid(sb: SupabaseClient, st: StripeClient, session: Record<string, unknown>): Promise<Response | null> {
  const items = await st.checkout.sessions.listLineItems(session.id as string, { limit: 10, expand: ['data.price.product'] })
  const productIds = items.data.map((li: Record<string, any>) =>
    typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id).filter(Boolean)
  const r = routeCheckoutSession(session as any, productIds, CHECKIN_PRODUCT_ID)
  if (r.route !== 'checkin') { console.log('stripe-webhook: check-in session ignored:', r.reason); return null }

  const md = session.metadata as Record<string, string>
  const details = session.total_details as Record<string, number> | undefined
  const { data, error } = await sb.rpc('checkin_mark_paid', {
    p_event_id: md.event_id,
    p_buyer_id: md.buyer_id,
    p_session_id: session.id as string,
    p_payment_intent: (session.payment_intent as string) ?? null,
    p_customer: (session.customer as string) ?? null,
    p_amount_total: (session.amount_total as number) ?? null,
    p_amount_tax: details?.amount_tax ?? null,
    p_currency: (session.currency as string) ?? null,
  })
  if (error) {
    console.error('stripe-webhook: checkin_mark_paid failed for', session.id, error.message)
    return new Response(JSON.stringify({ error: 'checkin_mark_paid failed' }), { status: 500 })
  }
  console.log('stripe-webhook: check-in', md.event_id, '->', data)
  return null
}
```

(d) Replace the whole `case 'checkout.session.completed': { ... }` block with:
```ts
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object
        if (session.metadata?.product === 'checkin') {
          // The outer catch answers 200 to stop retries. A paid check-in
          // that failed to go live must be retried, so exceptions here
          // (a Stripe line-item fetch, a network blip) become a 500.
          try {
            const res = await handleCheckinPaid(sb, st, session)
            if (res) return res
          } catch (e) {
            console.error('stripe-webhook: check-in handling threw for', session.id, (e as Error).message)
            return new Response(JSON.stringify({ error: 'check-in handling failed' }), { status: 500 })
          }
          break
        }
        if (event.type !== 'checkout.session.completed') break

        const directorId = session.client_reference_id || session.metadata?.director_id
        if (!directorId || session.metadata?.plan !== 'perevent') break

        // increment_events_purchased exists from migration 060. supabase-js
        // resolves errors, it never rejects, so the old .catch fallback
        // could not run; an error now fails the delivery so Stripe retries.
        const { error: incErr } = await sb.rpc('increment_events_purchased', { p_director_id: directorId })
        if (incErr) {
          console.error('stripe-webhook: increment_events_purchased failed for', directorId, incErr.message)
          return new Response(JSON.stringify({ error: 'credit not recorded' }), { status: 500 })
        }

        const { error: logErr } = await sb.rpc('log_activity', {
          p_user_id: directorId,
          p_action: 'event_purchased',
          p_category: 'billing',
          p_description: 'Purchased per-event credit',
          p_metadata: { plan: 'perevent', checkout_session_id: session.id },
        })
        if (logErr) console.error('stripe-webhook: log_activity failed', logErr.message)
        break
      }

      case 'charge.refunded': {
        const charge = event.data.object
        const pi = charge.payment_intent as string | null
        if (!pi) break
        const isCheckin = charge.metadata?.product === 'checkin' || (await isCheckinPaymentIntent(sb, pi))
        if (!isCheckin) break
        // Partial refunds keep the event live; only a full refund reverts it.
        if (charge.amount_refunded < charge.amount) break
        const { data, error } = await sb.rpc('checkin_mark_refunded', { p_payment_intent: pi })
        if (error) {
          console.error('stripe-webhook: checkin_mark_refunded failed for', pi, error.message)
          return new Response(JSON.stringify({ error: 'refund not recorded' }), { status: 500 })
        }
        console.log('stripe-webhook: check-in refund', pi, '->', data)
        break
      }
```
and add above `Deno.serve`:
```ts
async function isCheckinPaymentIntent(sb: SupabaseClient, pi: string): Promise<boolean> {
  const { data, error } = await sb.from('leod_checkin_purchases').select('id').eq('stripe_payment_intent_id', pi).maybeSingle()
  if (error) { console.error('stripe-webhook: purchase lookup failed', error.message); return false }
  return !!data
}
```
Charges do not inherit Checkout Session metadata, which is why `payment_intent_data.metadata` was set in Step 3 and the lookup is the fallback. A CueQuote refund matches neither and is ignored (Review Focus 4).

- [ ] **Step 5: Type-check**

Run: `deno check supabase/functions/checkin-price/index.ts supabase/functions/checkin-create-checkout/index.ts supabase/functions/stripe-webhook/index.ts`
Expected: no errors. (`any` in the line-item map is deliberate: the esm.sh Stripe types do not narrow `expand`.)

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: all specs pass, including the existing ones.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/checkin-price/index.ts supabase/functions/checkin-create-checkout/index.ts supabase/functions/stripe-webhook/index.ts
git commit -m "feat(checkin): Stripe go-live checkout, price endpoint, webhook paid/refund; fix Pay-per-Event credit" -- supabase/functions/checkin-price/index.ts supabase/functions/checkin-create-checkout/index.ts supabase/functions/stripe-webhook/index.ts
```

- [ ] **Step 8: Deploy the server side**

Run (each must print "deployed"):
```bash
bash scripts/deploy-functions.sh checkin-enable-event
bash scripts/deploy-functions.sh checkin-record-scans
bash scripts/deploy-functions.sh checkin-self-register
bash scripts/deploy-functions.sh checkin-send-qr-emails
bash scripts/deploy-functions.sh checkin-import-attendees
bash scripts/deploy-functions.sh checkin-invite-staff
bash scripts/deploy-functions.sh checkin-price
bash scripts/deploy-functions.sh checkin-create-checkout
bash scripts/deploy-functions.sh stripe-webhook
```
Then confirm with `list_edge_functions`: `stripe-webhook` and `checkin-price` show `verify_jwt: false`; the others `true`. Then:
```bash
curl -sS https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-price
```
Expected: `{"amount":24900,"currency":"eur","tax_behavior":"exclusive"}`.
```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/stripe-webhook -H 'Content-Type: application/json' -d '{"_ping":true}'
```
Expected: `200` (not `401`).

---

### Task 7: Console and routing

**Files:**
- Modify: `cuedeck-console.html:2656` (event list), `:5299-5304` (client `events_used` write), boot role checks near `:7029`
- Modify: `vercel.json`
- Keep: the console header "Check-in" link and mobile-menu entry already in the working tree (they point at `/checkin`, which becomes the front page)

**Interfaces:**
- Consumes: `leod_events.created_via`, `leod_users.role = 'checkin_staff'` (Task 1).
- Produces: routes `/checkin` → `cuedeck-checkin-home.html`, `/checkin/setup` → `cuedeck-checkin-setup.html`, `/checkin/desk` → `cuedeck-checkin.html`, `/kiosk` → 307 to `/checkin/desk?mode=kiosk`.

- [ ] **Step 1: Console shows only console events**

Line 2656 becomes:
```js
    .from('leod_events').select('*').eq('active', true).eq('created_via', 'console').order('date', { ascending: false });
```
Events created on the check-in front page are check-in-only. Listing them in the console would count them against the console plan's active-event limit.

- [ ] **Step 2: Remove the client `events_used` write**

Replace lines 5299-5304 (`// Track per-event credit usage` through `S.subscription.events_used = ...`) with:
```js
      // Per-event usage is counted by trg_leod_events_count_perevent_usage
      // (migration 060). The client update this replaced was silently
      // rejected by RLS. Mirror it locally so the badge is right now.
      if (S.subscription?.plan === 'perevent') {
        S.subscription.events_used = (S.subscription.events_used || 0) + 1;
      }
```

- [ ] **Step 3: Turn check-in-only staff away from the console**

Directly after the `if (data.role === 'pending') { ... }` block (around line 7029), add:
```js
  // Check-in-only staff (migration 059). Without this the console would
  // treat them as an account with no plan and offer a trial.
  if (data.role === 'checkin_staff') {
    document.getElementById('load-spinner').style.display = 'none';
    document.getElementById('load-step').style.display = 'none';
    var ckOverlay = document.createElement('div');
    ckOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg);display:flex;align-items:center;justify-content:center';
    var ckInner = document.createElement('div');
    ckInner.style.cssText = 'text-align:center;max-width:380px;padding:40px';
    var ckTitle = document.createElement('div');
    ckTitle.style.cssText = 'font-size:18px;font-weight:700;color:#fff;margin-bottom:8px';
    ckTitle.textContent = 'This login is for CueDeck Check-in';
    var ckMsg = document.createElement('div');
    ckMsg.style.cssText = 'font-size:13px;color:var(--dim);line-height:1.6;margin-bottom:24px';
    ckMsg.textContent = 'You were invited to work a registration desk. Open Check-in to see your events.';
    var ckLink = document.createElement('a');
    ckLink.href = '/checkin';
    ckLink.style.cssText = 'display:inline-block;background:#3b82f6;color:#fff;border-radius:8px;padding:10px 24px;font-size:13px;font-weight:600;text-decoration:none';
    ckLink.textContent = 'Open Check-in';
    ckInner.appendChild(ckTitle); ckInner.appendChild(ckMsg); ckInner.appendChild(ckLink);
    ckOverlay.appendChild(ckInner);
    document.body.appendChild(ckOverlay);
    throw new Error('checkin_staff'); // abort boot()
  }
```

- [ ] **Step 4: Routes**

Replace the `rewrites` array and the `redirects` array in `vercel.json` with:
```json
  "rewrites": [
    { "source": "/admin",         "destination": "/cuedeck-admin.html" },
    { "source": "/",              "destination": "/cuedeck-console.html" },
    { "source": "/d",             "destination": "/cuedeck-display.html" },
    { "source": "/display",       "destination": "/cuedeck-display.html" },
    { "source": "/checkin",       "destination": "/cuedeck-checkin-home.html" },
    { "source": "/checkin/setup", "destination": "/cuedeck-checkin-setup.html" },
    { "source": "/checkin/desk",  "destination": "/cuedeck-checkin.html" }
  ],
  "redirects": [
    { "source": "/kiosk", "destination": "/checkin/desk?mode=kiosk", "permanent": false }
  ],
```
Kiosks already paired keep their device key in `localStorage` on the same origin, so the path change does not unpair them.

- [ ] **Step 5: Update deploy.md routes**

In `deploy.md`, the two route lines added earlier become:
```markdown
- `/checkin` → `cuedeck-checkin-home.html` (check-in front page)
- `/checkin/setup` → `cuedeck-checkin-setup.html` (organizer setup)
- `/checkin/desk` → `cuedeck-checkin.html` (registration desk)
- `/kiosk` → redirects to `/checkin/desk?mode=kiosk` (self-registration kiosk)
```

- [ ] **Step 6: Commit**

```bash
git add cuedeck-console.html vercel.json deploy.md
git commit -m "feat(checkin): routes, console link, console hides check-in-only events and staff" -- cuedeck-console.html vercel.json deploy.md
```

---

### Task 8: Front page `cuedeck-checkin-home.html`

**Files:**
- Create: `cuedeck-checkin-home.html`
- Create: `checkin-window.js` (shared browser copy of the window rule)
- Test: `tests/checkin-window.spec.ts`

**Interfaces:**
- Consumes: `checkin_my_events()` (Task 1, migration 060 addendum below), `checkin-enable-event`, `checkin-price`.
- Produces: `checkin-window.js` exporting `checkinWindow(eventDate, timeZone)` and `isWithinWindow(iso, eventDate, timeZone)` as an ES module at `/checkin-window.js`, identical to Task 2's logic. Used by this page, Setup and the desk.

- [ ] **Step 1: Add `checkin_my_events()` to migration 060 and apply it**

Append to `supabase/migrations/060_checkin_product_functions.sql` and apply as a new migration named `060b_checkin_my_events`:
```sql
-- One read for every check-in page. leod_events RLS is owner-scoped, so
-- invited desk staff and co-organizers cannot read the event row; this
-- returns what they need for events they hold a role on.
CREATE OR REPLACE FUNCTION public.checkin_my_events()
RETURNS TABLE (
  event_id UUID, name TEXT, date DATE, venue TEXT, timezone TEXT,
  event_start TIME, event_end TIME, created_via TEXT, is_owner BOOLEAN,
  role TEXT, status TEXT, attendees INTEGER, arrived INTEGER, test_used INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT o.event_id, o.role FROM leod_checkin_operators o
     WHERE o.user_id = auth.uid() AND o.role IN ('organizer', 'crew')
    UNION
    SELECT e.id, 'organizer' FROM leod_events e WHERE e.created_by = auth.uid()
  ), best AS (
    SELECT DISTINCT ON (event_id) event_id, role FROM mine
     ORDER BY event_id, (role = 'organizer') DESC
  )
  SELECT b.event_id, e.name, e.date, e.venue, e.timezone, e.event_start, e.event_end,
         e.created_via, (e.created_by = auth.uid()), b.role, ent.status,
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id),
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.checked_in_at IS NOT NULL),
         (SELECT count(*)::int FROM leod_checkin_scan_events s WHERE s.event_id = b.event_id AND s.is_test AND s.result = 'ok')
           + (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.is_test)
    FROM best b
    JOIN leod_events e ON e.id = b.event_id AND e.active
    LEFT JOIN leod_checkin_entitlements ent ON ent.event_id = b.event_id
   WHERE ent.event_id IS NOT NULL OR e.created_by = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public.checkin_my_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkin_my_events() TO authenticated;
```
Verify with one `execute_sql`:
```sql
select count(*) from pg_proc where proname = 'checkin_my_events';
```
Expected: `1`. Commit the migration file change on its own:
```bash
git add supabase/migrations/060_checkin_product_functions.sql
git commit -m "feat(checkin): checkin_my_events() for staff and co-organizers" -- supabase/migrations/060_checkin_product_functions.sql
```

- [ ] **Step 2: Write the failing browser-module test**

`tests/checkin-window.spec.ts`:
```ts
// The browser copy of the window rule must agree with the server copy
// (supabase/functions/_shared/checkin-policy.ts, mirrored in
// tests/checkin-policy.spec.ts). Same cases, imported for real.
import { describe, it, expect } from 'vitest';
import { checkinWindow, isWithinWindow } from '../checkin-window.js';

describe('checkin-window.js', () => {
  it('matches the server on Warsaw DST', () => {
    const w = checkinWindow('2026-10-26', 'Europe/Warsaw');
    expect(w.opensAt.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(w.closesAt.toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
  it('matches the server on Cairo edges', () => {
    expect(isWithinWindow('2026-11-14T21:30:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(true);
    expect(isWithinWindow('2026-11-14T22:10:00.000Z', '2026-11-12', 'Africa/Cairo')).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/checkin-window.spec.ts`
Expected: FAIL, cannot resolve `../checkin-window.js`.

- [ ] **Step 4: Write `checkin-window.js`**

```js
// checkin-window.js — browser copy of the live check-in window rule.
// Server copy: supabase/functions/_shared/checkin-policy.ts. The server
// decides; the pages use this only to explain and to refuse early.

function tzOffsetMs(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function zonedMidnightUtc(ymd, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export const TEST_CAP = 25;

export function checkinWindow(eventDate, timeZone) {
  return {
    opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
    closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone),
  };
}

export function isWithinWindow(iso, eventDate, timeZone) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const w = checkinWindow(eventDate, timeZone);
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/checkin-window.spec.ts`
Expected: PASS.

- [ ] **Step 6: Write the page**

`cuedeck-checkin-home.html`. Markup and CSS follow `front-page-direction.html` (option A) for signed out and `your-events.html` for signed in.

**Stylesheet split:** everything between `<style>` and `</style>` in the file below goes into a new file `checkin-app.css` (Setup links the same file), and the page's `<style>…</style>` element is replaced by `<link rel="stylesheet" href="/checkin-app.css">`. It is shown inline here so the page can be read in one piece. Full file:
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CueDeck Check-in</title>
<meta name="description" content="Run your event registration desk: import guests, send QR codes, print badges as people arrive. Set up free.">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
:root{
  --pg:#F5F5F7;--sf:#FFFFFF;--wm:#FBFBFD;--t1:#1D1D1F;--t2:#6E6E73;--t3:#A1A1A6;
  --bd:#E8E8ED;--bd2:#D2D2D7;--ac:#0071E3;--acsf:#EAF3FE;--gn:#1D8348;--gnsf:#E8F6EE;
  --am:#9A5B00;--amsf:#FEF6E7;--ambd:#F5D9A8;--rd:#B3261E;--rdsf:#FDECEA;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--pg);color:var(--t1)}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
[hidden]{display:none!important}
.nav{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;background:rgba(255,255,255,.75);border-bottom:1px solid var(--bd);position:sticky;top:0;backdrop-filter:saturate(180%) blur(12px);z-index:5}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:17px;letter-spacing:-.4px;color:var(--t1);text-decoration:none}
.logo .mk{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--ac)}
.logo .tag{font-weight:500;font-size:13px;letter-spacing:0;color:var(--t2);border-left:1px solid var(--bd2);padding-left:10px;margin-left:2px}
.nav-r{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--t2)}
.av{width:30px;height:30px;border-radius:50%;background:var(--acsf);color:var(--ac);display:grid;place-items:center;font-weight:700;font-size:12px}
.link{background:none;border:0;color:var(--ac);font-weight:500;font-size:13px;cursor:pointer;padding:0;text-decoration:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 16px;border-radius:10px;font-weight:600;font-size:13.5px;border:0;cursor:pointer;white-space:nowrap;text-decoration:none}
.btn-p{background:var(--ac);color:#fff}.btn-s{background:#fff;color:var(--t1);border:1px solid var(--bd2)}.btn-g{background:var(--pg);color:var(--ac)}
.btn:disabled{opacity:.55;cursor:default}
.wrap{max-width:1060px;margin:0 auto;padding:36px 28px 48px}
/* signed out */
.hero{display:grid;grid-template-columns:1.15fr 1fr;gap:40px;align-items:start}
.eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ac)}
.hero h1{font-size:40px;line-height:1.08;letter-spacing:-1.2px;margin:12px 0 14px}
.lead{font-size:15.5px;line-height:1.55;margin:0 0 22px;color:var(--t2)}
.ticks{list-style:none;padding:0;margin:0 0 24px;display:grid;gap:11px}
.ticks li{display:flex;gap:11px;font-size:14px;line-height:1.45}
.ticks svg{flex:none;margin-top:1px;color:var(--gn)}
.price{display:inline-flex;align-items:baseline;gap:8px;padding:10px 14px;border-radius:12px;font-size:13px;background:#fff;border:1px solid var(--bd);color:var(--t2)}
.price b{font-size:20px;letter-spacing:-.5px;color:var(--t1)}
.card{background:#fff;border-radius:18px;padding:24px;box-shadow:var(--shadow)}
.card h3{margin:0 0 4px;font-size:17px;letter-spacing:-.3px}
.card .s{margin:0 0 18px;font-size:13px;color:var(--t2)}
.tabs{display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:10px;margin-bottom:16px;background:var(--pg)}
.tabs button{border:0;background:none;padding:7px 4px;border-radius:8px;font-size:12.5px;font-weight:600;color:var(--t2);cursor:pointer;white-space:nowrap}
.tabs button[aria-selected="true"]{background:#fff;color:var(--t1);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.field{margin-bottom:11px}
.field label{display:block;font-size:12px;font-weight:600;margin-bottom:5px}
.field input,.field select{width:100%;height:38px;border-radius:10px;padding:0 12px;border:1px solid var(--bd2);background:var(--wm);font-size:14px}
.field input:focus,.field select:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--acsf)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.err{color:var(--rd);font-size:13px;min-height:18px;margin-top:8px}
.ok{color:var(--gn);font-size:13px;margin-top:8px}
.fine{font-size:12px;text-align:center;margin-top:12px;color:var(--t2)}
.full{width:100%;height:40px}
/* signed in */
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}
.head h1{font-size:28px;letter-spacing:-.8px;margin:0 0 4px}
.head p{margin:0;color:var(--t2);font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.ev{background:#fff;border-radius:18px;padding:20px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:14px}
.ev-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.ev h3{margin:0 0 3px;font-size:16.5px;letter-spacing:-.3px;overflow-wrap:anywhere}
.meta{font-size:12.5px;color:var(--t2)}
.pill{font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:999px;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.pill i{width:6px;height:6px;border-radius:50%;display:inline-block}
.p-none,.p-end{background:var(--pg);color:var(--t2)}.p-none i{background:var(--t3)}.p-end i{background:var(--bd2)}
.p-test{background:var(--amsf);color:var(--am)}.p-test i{background:#E8A33D}
.p-live{background:var(--gnsf);color:var(--gn)}.p-live i{background:var(--gn);box-shadow:0 0 0 3px rgba(29,131,72,.18)}
.stats{display:flex;gap:22px}
.stat b{display:block;font-size:20px;letter-spacing:-.5px}.stat span{font-size:12px;color:var(--t2)}
.bar{height:6px;border-radius:6px;background:#F0F0F3;overflow:hidden}.bar div{height:100%;border-radius:6px}
.note{font-size:12.5px;color:var(--t2);line-height:1.45}
.acts{display:flex;gap:8px;margin-top:auto;flex-wrap:wrap}
.empty{background:#fff;border-radius:18px;padding:36px;text-align:center;box-shadow:var(--shadow);color:var(--t2)}
dialog{border:0;border-radius:18px;padding:24px;width:min(460px,calc(100vw - 32px));box-shadow:0 30px 80px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(0,0,0,.3)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:820px){.hero,.grid{grid-template-columns:1fr}.hero h1{font-size:32px}.wrap{padding:24px 16px 40px}.nav{padding:14px 16px}.head{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<nav class="nav">
  <a class="logo" href="/checkin"><span class="mk"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M16 6a7 7 0 1 0 0 12"/></svg></span>CueDeck<span class="tag">Check-in</span></a>
  <div class="nav-r" id="nav-r"><a class="link" href="https://cuedeck.io/solutions/check-in">How it works</a></div>
</nav>

<!-- SIGNED OUT -->
<main class="wrap" id="v-out" hidden>
  <div class="hero">
    <div>
      <div class="eyebrow">Event check-in</div>
      <h1>Every guest through the door in seconds.</h1>
      <p class="lead">Import your guest list, send each person a QR code, and run the registration desk from any laptop or tablet. Badges print as people arrive.</p>
      <ul class="ticks">
        <li><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>One scan brings up the whole company, so a group checks in together</span></li>
        <li><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Self-registration kiosk for walk-ins</span></li>
        <li><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Keeps working when the venue Wi-Fi drops</span></li>
      </ul>
      <div class="price" data-price-line hidden><b data-price></b> per event, excl. VAT · set up free</div>
    </div>
    <div class="card">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" id="t-in" aria-selected="true">Sign in</button>
        <button type="button" role="tab" id="t-up" aria-selected="false">Create account</button>
      </div>
      <form id="f-in">
        <h3>Welcome back</h3><p class="s">Use your CueDeck login.</p>
        <div class="field"><label for="in-email">Email</label><input id="in-email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="in-pass">Password</label><input id="in-pass" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-p full" id="in-btn">Sign in</button>
        <div class="err" id="in-err"></div>
        <div class="fine"><button type="button" class="link" id="go-forgot">Forgot password?</button></div>
      </form>
      <form id="f-up" hidden>
        <h3>Create your account</h3><p class="s">Free to set up. You only pay when an event goes live.</p>
        <div class="field"><label for="up-name">Your name</label><input id="up-name" autocomplete="name" required maxlength="120"></div>
        <div class="field"><label for="up-org">Company</label><input id="up-org" autocomplete="organization" maxlength="120"></div>
        <div class="field"><label for="up-email">Work email</label><input id="up-email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="up-pass">Password</label><input id="up-pass" type="password" autocomplete="new-password" minlength="8" required></div>
        <div class="hp" aria-hidden="true"><label for="up-website">Website</label><input id="up-website" tabindex="-1" autocomplete="off"></div>
        <button class="btn btn-p full" id="up-btn">Create account</button>
        <div class="err" id="up-err"></div>
      </form>
      <div id="up-done" hidden><h3>Check your inbox</h3><p class="s" id="up-done-t"></p></div>
      <form id="f-forgot" hidden>
        <h3>Reset your password</h3><p class="s">We'll email you a link.</p>
        <div class="field"><label for="fg-email">Email</label><input id="fg-email" type="email" autocomplete="email" required></div>
        <button class="btn btn-p full" id="fg-btn">Send reset link</button>
        <div class="err" id="fg-err"></div><div class="ok" id="fg-ok"></div>
        <div class="fine"><button type="button" class="link" id="back-in">Back to sign in</button></div>
      </form>
    </div>
  </div>
</main>

<!-- SET PASSWORD (invite or recovery link) -->
<main class="wrap" id="v-pass" hidden>
  <form class="card" id="f-pass" style="max-width:420px;margin:40px auto">
    <h3>Choose a password</h3><p class="s">You'll use it to sign in to CueDeck Check-in.</p>
    <div class="field"><label for="pw-1">New password</label><input id="pw-1" type="password" autocomplete="new-password" minlength="8" required></div>
    <button class="btn btn-p full" id="pw-btn">Save and continue</button>
    <div class="err" id="pw-err"></div>
  </form>
</main>

<!-- SIGNED IN -->
<main class="wrap" id="v-in" hidden>
  <div class="head">
    <div><h1>Your events</h1><p id="head-sub">Set up for free. <span data-price-line hidden>Go live for <span data-price></span> per event when you're ready.</span></p></div>
    <button class="btn btn-p" id="new-btn" hidden><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New event</button>
  </div>
  <div class="err" id="ev-err"></div>
  <div class="grid" id="ev-grid"></div>
  <div class="empty" id="ev-empty" hidden></div>
</main>

<dialog id="dlg-new">
  <form id="f-new" method="dialog">
    <h3 style="margin:0 0 4px">New event</h3><p class="s" style="margin:0 0 16px;color:var(--t2);font-size:13px">Starts in free test mode.</p>
    <div class="field"><label for="ne-name">Event name</label><input id="ne-name" required maxlength="160"></div>
    <div class="field"><label for="ne-date">Date</label><input id="ne-date" type="date" required></div>
    <div class="row2">
      <div class="field"><label for="ne-start">Starts</label><input id="ne-start" type="time" value="09:00" required></div>
      <div class="field"><label for="ne-end">Ends</label><input id="ne-end" type="time" value="18:00" required></div>
    </div>
    <div class="field"><label for="ne-venue">Venue</label><input id="ne-venue" maxlength="160"></div>
    <div class="field"><label for="ne-tz">Timezone</label><select id="ne-tz"></select></div>
    <div class="err" id="ne-err"></div>
    <div class="acts" style="justify-content:flex-end;margin-top:8px">
      <button type="button" class="btn btn-s" id="ne-cancel">Cancel</button>
      <button type="submit" class="btn btn-p" id="ne-save">Create event</button>
    </div>
  </form>
</dialog>

<script type="module">
import { checkinWindow, TEST_CAP } from '/checkin-window.js';

const SUPABASE_URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
// Read before createClient: supabase-js consumes and clears the hash.
const NEEDS_PASSWORD = /type=(invite|recovery)/.test(location.hash);
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
let ME = null, MY_ROLE = null;

function show(view) { for (const v of ['v-out', 'v-pass', 'v-in']) $(v).hidden = v !== view; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }
function fmtDate(ymd) { return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }

async function loadPrice() {
  try {
    const r = await fetch(SUPABASE_URL + '/functions/v1/checkin-price');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = await r.json();
    const s = new Intl.NumberFormat('en-IE', { style: 'currency', currency: p.currency.toUpperCase(),
      minimumFractionDigits: p.amount % 100 ? 2 : 0 }).format(p.amount / 100);
    document.querySelectorAll('[data-price]').forEach(n => n.textContent = s);
    document.querySelectorAll('[data-price-line]').forEach(n => n.hidden = false);
  } catch (e) {
    // No number is better than a wrong one: the lines stay hidden.
    console.error('checkin home: price unavailable', e);
  }
}

// ── auth views ──────────────────────────────────────────
function tab(which) {
  $('t-in').setAttribute('aria-selected', String(which === 'in'));
  $('t-up').setAttribute('aria-selected', String(which === 'up'));
  $('f-in').hidden = which !== 'in';
  $('f-up').hidden = which !== 'up';
  $('f-forgot').hidden = which !== 'forgot';
  $('up-done').hidden = true;
}
$('t-in').onclick = () => tab('in');
$('t-up').onclick = () => tab('up');
$('go-forgot').onclick = () => tab('forgot');
$('back-in').onclick = () => tab('in');

$('f-in').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('in-btn'), true, 'Signing in…'); $('in-err').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email: $('in-email').value.trim(), password: $('in-pass').value });
  busy($('in-btn'), false, 'Sign in');
  if (error) { $('in-err').textContent = error.message; return; }
  $('in-pass').value = '';
  await enter(data.user);
});

$('f-up').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('up-website').value) return;           // honeypot: a bot filled the hidden field
  busy($('up-btn'), true, 'Creating…'); $('up-err').textContent = '';
  const email = $('up-email').value.trim();
  const { error } = await sb.auth.signUp({
    email, password: $('up-pass').value,
    options: {
      data: { name: $('up-name').value.trim(), organization: $('up-org').value.trim(), signup_source: 'checkin' },
      emailRedirectTo: location.origin + '/checkin',
    },
  });
  busy($('up-btn'), false, 'Create account');
  if (error) { $('up-err').textContent = error.message; return; }
  $('f-up').hidden = true; $('up-done').hidden = false;
  $('up-done-t').textContent = 'We sent a confirmation link to ' + email + '. Open it on this device and you will land back here, signed in.';
});

$('f-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('fg-btn'), true, 'Sending…'); $('fg-err').textContent = ''; $('fg-ok').textContent = '';
  const { error } = await sb.auth.resetPasswordForEmail($('fg-email').value.trim(), { redirectTo: location.origin + '/checkin' });
  busy($('fg-btn'), false, 'Send reset link');
  if (error) { $('fg-err').textContent = error.message; return; }
  $('fg-ok').textContent = 'If that address has an account, a reset link is on its way.';
});

$('f-pass').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('pw-btn'), true, 'Saving…'); $('pw-err').textContent = '';
  const { data, error } = await sb.auth.updateUser({ password: $('pw-1').value });
  busy($('pw-btn'), false, 'Save and continue');
  if (error) { $('pw-err').textContent = error.message; return; }
  history.replaceState(null, '', '/checkin');
  await enter(data.user);
});

// ── signed in ───────────────────────────────────────────
async function enter(user) {
  ME = user;
  const { data: me, error } = await sb.from('leod_users').select('role, name').eq('id', user.id).maybeSingle();
  if (error) console.error('checkin home: profile read failed', error.message);
  MY_ROLE = me?.role || 'director';
  const nav = $('nav-r'); nav.replaceChildren();
  nav.appendChild(el('span', null, me?.name || user.email));
  const out = el('button', 'link', 'Sign out');
  out.onclick = async () => { await sb.auth.signOut(); location.href = '/checkin'; };
  nav.appendChild(out);
  $('new-btn').hidden = MY_ROLE === 'checkin_staff';
  show('v-in');
  await loadEvents();
}

function stateOf(r) {
  if (!r.status) return 'none';
  if (r.status === 'test') return 'test';
  return Date.now() >= checkinWindow(r.date, r.timezone).closesAt.getTime() ? 'ended' : 'live';
}

const PILL = { none: ['p-none', 'Not set up'], test: ['p-test', 'Test mode'], live: ['p-live', 'Live'], ended: ['p-end', 'Ended'] };
const ORDER = { live: 0, test: 1, none: 2, ended: 3 };

async function loadEvents() {
  $('ev-err').textContent = '';
  const { data, error } = await sb.rpc('checkin_my_events');
  if (error) { $('ev-err').textContent = 'Could not load your events: ' + error.message; return; }
  const rows = (data || []).map(r => ({ ...r, state: stateOf(r) }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.date.localeCompare(b.date));
  const grid = $('ev-grid'); grid.replaceChildren();
  $('ev-empty').hidden = rows.length > 0;
  if (!rows.length) {
    $('ev-empty').textContent = MY_ROLE === 'checkin_staff'
      ? 'You have not been added to an event yet. Ask the organizer to invite you.'
      : 'No events yet. Create one to import guests and try the desk for free.';
    return;
  }
  for (const r of rows) grid.appendChild(card(r));
}

function card(r) {
  const c = el('div', 'ev');
  const top = el('div', 'ev-top');
  const left = el('div');
  left.appendChild(el('h3', null, r.name));
  const where = [fmtDate(r.date), r.venue || (r.state === 'none' && r.created_via === 'console' ? 'from your CueDeck console' : null)].filter(Boolean).join(' · ');
  left.appendChild(el('div', 'meta', where));
  const [pc, pt] = PILL[r.state];
  const pill = el('span', 'pill ' + pc); pill.appendChild(el('i')); pill.appendChild(document.createTextNode(pt));
  top.append(left, pill); c.appendChild(top);

  const org = r.role === 'organizer';
  if (r.state === 'live' || r.state === 'ended') {
    const st = el('div', 'stats');
    for (const [n, l] of [[r.arrived, 'checked in'], [r.attendees, 'attendees']]) { const s = el('div', 'stat'); s.append(el('b', null, String(n)), el('span', null, l)); st.appendChild(s); }
    if (r.state === 'ended' && r.attendees) { const s = el('div', 'stat'); s.append(el('b', null, Math.round(100 * r.arrived / r.attendees) + '%'), el('span', null, 'turnout')); st.appendChild(s); }
    c.appendChild(st);
    if (r.state === 'live') { const bar = el('div', 'bar'); const f = el('div'); f.style.width = (r.attendees ? 100 * r.arrived / r.attendees : 0) + '%'; f.style.background = 'var(--gn)'; bar.appendChild(f); c.appendChild(bar); }
  } else if (r.state === 'test') {
    c.appendChild(el('div', 'note', r.attendees + ' attendees imported. ' + r.test_used + ' of ' + TEST_CAP + ' test check-ins used.'));
  } else {
    c.appendChild(el('div', 'note', 'Add check-in to import guests and run the desk.'));
  }

  const acts = el('div', 'acts');
  const go = (label, cls, href) => { const a = el('a', 'btn ' + cls, label); a.href = href; acts.appendChild(a); };
  const setup = '/checkin/setup?event=' + r.event_id, desk = '/checkin/desk?event=' + r.event_id;
  if (r.state === 'none' && org) {
    const b = el('button', 'btn btn-g', 'Set up check-in');
    b.onclick = async () => {
      busy(b, true, 'Setting up…');
      const { error } = await sb.functions.invoke('checkin-enable-event', { body: { event_id: r.event_id } });
      if (error) { busy(b, false, 'Set up check-in'); $('ev-err').textContent = 'Could not set up check-in: ' + error.message; return; }
      location.href = setup;
    };
    acts.appendChild(b);
  } else if (r.state === 'test') {
    if (org) go('Continue setup', 'btn-p', setup);
    go(org ? 'Try the desk' : 'Open desk (test)', org ? 'btn-s' : 'btn-p', desk);
  } else if (r.state === 'live') {
    go('Open desk', 'btn-p', desk);
    if (org) go('Setup', 'btn-s', setup);
  } else if (r.state === 'ended' && org) {
    go('View attendance', 'btn-s', setup + '&step=attendees');
  }
  c.appendChild(acts);
  return c;
}

// ── new event ───────────────────────────────────────────
function fillTimezones() {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [here];
  const sel = $('ne-tz'); sel.replaceChildren();
  for (const z of zones) { const o = el('option', null, z.replace(/_/g, ' ')); o.value = z; if (z === here) o.selected = true; sel.appendChild(o); }
}
$('new-btn').onclick = () => { fillTimezones(); $('ne-err').textContent = ''; $('dlg-new').showModal(); };
$('ne-cancel').onclick = () => $('dlg-new').close();
$('f-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('ne-save'), true, 'Creating…'); $('ne-err').textContent = '';
  const { data: ev, error } = await sb.from('leod_events').insert({
    name: $('ne-name').value.trim(), date: $('ne-date').value,
    event_start: $('ne-start').value, event_end: $('ne-end').value,
    venue: $('ne-venue').value.trim() || null, timezone: $('ne-tz').value,
    active: true, created_by: ME.id, created_via: 'checkin',
  }).select('id').single();
  if (error) { busy($('ne-save'), false, 'Create event'); $('ne-err').textContent = error.message; return; }
  const { error: enErr } = await sb.functions.invoke('checkin-enable-event', { body: { event_id: ev.id } });
  if (enErr) { busy($('ne-save'), false, 'Create event'); $('ne-err').textContent = 'Event created, but check-in could not be set up: ' + enErr.message; return; }
  location.href = '/checkin/setup?event=' + ev.id;
});

// ── boot ────────────────────────────────────────────────
loadPrice();
const { data: { session } } = await sb.auth.getSession();
if (session && NEEDS_PASSWORD) { show('v-pass'); $('pw-1').focus(); }
else if (session) await enter(session.user);
else { show('v-out'); tab('in'); }
</script>
</body>
</html>
```

- [ ] **Step 7: Check it in a browser**

Serve: `python3 -m http.server 7230` from the repo root, open `http://127.0.0.1:7230/cuedeck-checkin-home.html` in Chrome.
Expected: signed-out view matches `front-page-direction.html` option A at 1440 px and has no horizontal scroll at 390 px; the price line shows `€249 per event, excl. VAT · set up free` once Task 6 is deployed (before that it stays hidden, which is correct). Sign in with a throwaway organizer account: the IME 2026 event shows as **Live**. Screenshot both views at 2× into the PR.

- [ ] **Step 8: Commit**

```bash
git add cuedeck-checkin-home.html checkin-app.css checkin-window.js tests/checkin-window.spec.ts
git commit -m "feat(checkin): front page with sign-up, events and new event" -- cuedeck-checkin-home.html checkin-app.css checkin-window.js tests/checkin-window.spec.ts
```

---

### Task 9: Setup page `cuedeck-checkin-setup.html`

**Files:**
- Create: `checkin-csv.js` (CSV parse + header mapping, ES module)
- Test: `tests/checkin-csv.spec.ts`
- Create: `cuedeck-checkin-setup.html`
- Modify: `supabase/functions/checkin-invite-staff/index.ts` (add `list`)

**Interfaces:**
- Consumes: `checkin_my_events()`, `checkin-enable-event` (settings), `checkin-import-attendees` (dry run then commit), `checkin-invite-staff`, `checkin-send-qr-emails`, `checkin-create-checkout`, `checkin-price`, `/checkin-window.js`.
- Produces:
  - `checkin-csv.js`: `parseCsv(text: string): string[][]`, `mapRows(table: string[][]): { rows: ImportRow[]; unmapped: string[]; missing: string[] }`
  - `checkin-invite-staff` action `list` → `{ ok: true, staff: [{ user_id, role, email, name, is_owner }] }`

- [ ] **Step 1: Add `list` to `checkin-invite-staff`**

Change the action check to accept `'list'`:
```ts
  if (!event_id || !['invite', 'remove', 'list'].includes(action)) return json({ error: 'event_id and action required' }, 400)
```
After the `ev` fetch, add:
```ts
  if (action === 'list') {
    const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
      .select('user_id, role').eq('event_id', event_id).in('role', ['organizer', 'crew'])
    if (opsErr) return json({ error: opsErr.message }, 500)
    const ids = (ops || []).map(o => o.user_id)
    const { data: people, error: pErr } = ids.length
      ? await sb.from('leod_users').select('id, email, name').in('id', ids)
      : { data: [], error: null }
    if (pErr) return json({ error: pErr.message }, 500)
    const byId = new Map((people || []).map(p => [p.id, p]))
    return json({ ok: true, staff: (ops || []).map(o => ({
      user_id: o.user_id, role: o.role,
      email: byId.get(o.user_id)?.email ?? null, name: byId.get(o.user_id)?.name ?? null,
      is_owner: o.user_id === ev.created_by,
    })) })
  }
```
Also, in the existing-user lookup, escape LIKE wildcards so `a_b@x.com` cannot match `axb@x.com`:
```ts
  const likeSafe = email.replace(/[\\%_]/g, (m) => '\\' + m)
  const { data: existing, error: exErr } = await sb.from('leod_users')
    .select('id').ilike('email', likeSafe).maybeSingle()
```
Run `deno check supabase/functions/checkin-invite-staff/index.ts`; expected no errors.

- [ ] **Step 2: Write the failing CSV test**

`tests/checkin-csv.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCsv, mapRows } from '../checkin-csv.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('strips a UTF-8 BOM and skips blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('detects semicolon CSV from Excel in PL/DE locales', () => {
    expect(parseCsv('first name;last name\nAna;Nowak\n')).toEqual([['first name', 'last name'], ['Ana', 'Nowak']]);
  });
});

describe('mapRows', () => {
  it('maps common header spellings', () => {
    const r = mapRows([['First Name', 'Surname', 'E-mail', 'Organisation', 'Job title', 'Ticket', 'ID'],
                       ['Ana', 'Nowak', 'ana@x.pl', 'Acme', 'CTO', 'VIP', '17']]);
    expect(r.rows).toEqual([{ first_name: 'Ana', last_name: 'Nowak', email: 'ana@x.pl', company: 'Acme', role_title: 'CTO', ticket_type: 'VIP', external_ref: '17' }]);
    expect(r.missing).toEqual([]);
  });
  it('reports missing required columns', () => {
    expect(mapRows([['Email'], ['a@b.c']]).missing).toEqual(['first_name', 'last_name']);
  });
  it('lists columns it ignored', () => {
    expect(mapRows([['first name', 'last name', 'Diet'], ['A', 'B', 'vegan']]).unmapped).toEqual(['Diet']);
  });
  it('drops rows that are entirely empty', () => {
    expect(mapRows([['first name', 'last name'], ['', ''], ['A', 'B']]).rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/checkin-csv.spec.ts`
Expected: FAIL, cannot resolve `../checkin-csv.js`.

- [ ] **Step 4: Write `checkin-csv.js`**

```js
// checkin-csv.js — guest-list CSV parsing for the setup page.
// Validation of each row happens server-side in checkin-import-attendees
// (dry run first); this only turns a spreadsheet export into rows.

export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const out = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) out.push(row);
  return out;
}

const ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'given name', 'forename', 'imie', 'imię', 'vorname', 'prenom', 'prénom'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name', 'nazwisko', 'nachname', 'nom'],
  email: ['email', 'e-mail', 'email address', 'mail', 'adres email'],
  company: ['company', 'organisation', 'organization', 'org', 'firma', 'employer', 'unternehmen', 'societe', 'société'],
  role_title: ['title', 'job title', 'role', 'position', 'stanowisko', 'job'],
  ticket_type: ['ticket', 'ticket type', 'type', 'category', 'pass', 'badge type'],
  external_ref: ['id', 'external id', 'ref', 'reference', 'registration id', 'order id'],
};

function norm(h) { return h.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' '); }

export function mapRows(table) {
  if (!table.length) return { rows: [], unmapped: [], missing: ['first_name', 'last_name'] };
  const header = table[0];
  const colFor = {};
  const unmapped = [];
  header.forEach((h, i) => {
    const n = norm(h);
    const key = Object.keys(ALIASES).find(k => k === n.replace(/ /g, '_') || ALIASES[k].includes(n));
    if (key && colFor[key] === undefined) colFor[key] = i; else unmapped.push(h);
  });
  const missing = ['first_name', 'last_name'].filter(k => colFor[k] === undefined);
  const rows = [];
  for (const r of table.slice(1)) {
    if (!r.some(f => f.trim() !== '')) continue;
    const o = {};
    for (const [k, i] of Object.entries(colFor)) { const v = (r[i] ?? '').trim(); if (v) o[k] = v; }
    rows.push(o);
  }
  return { rows, unmapped, missing };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/checkin-csv.spec.ts`
Expected: PASS. Note `mapRows` with header `['first name','last name','Diet']` maps the first two through the `k === n.replace(/ /g,'_')` branch.

- [ ] **Step 6: Write the page**

`cuedeck-checkin-setup.html`. Layout and CSS from `setup.html` and the top half of `golive-and-desk.html`; reuse the `:root` tokens, `.nav`, `.btn*`, `.field`, `.pill`, `.err`, `.ok`, `dialog` rules from Task 8 verbatim. Full file:
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check-in Setup</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<link rel="stylesheet" href="/checkin-app.css">
<style>
.crumb{font-weight:500;font-size:13px;color:var(--t2);border-left:1px solid var(--bd2);padding-left:10px;margin-left:2px}
.crumb a{color:var(--t2);text-decoration:none}.crumb b{color:var(--t1);font-weight:600}
.banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 28px 0;padding:12px 16px;border-radius:12px;background:var(--amsf);border:1px solid var(--ambd);color:var(--am);font-size:13px}
.banner b{color:#7A4700}
.layout{display:grid;grid-template-columns:240px 1fr;gap:22px;padding:20px 28px 40px;max-width:1240px;margin:0 auto}
.steps{background:#fff;border-radius:18px;padding:10px;box-shadow:var(--shadow);align-self:start;position:sticky;top:76px}
.steps .ttl{padding:10px 12px 6px}.steps .ttl h3{margin:0;font-size:15px;letter-spacing:-.2px;overflow-wrap:anywhere}.steps .ttl p{margin:2px 0 0;font-size:12px;color:var(--t2)}
.st{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:11px;font-size:13.5px;font-weight:500;border:0;background:none;width:100%;text-align:left;cursor:pointer;color:var(--t2)}
.st .dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:11px;font-weight:700;border:1.5px solid var(--bd2);color:var(--t3)}
.st.done{color:var(--t1)}.st.done .dot{border:0;background:var(--gnsf);color:var(--gn)}
.st[aria-current="step"]{background:var(--acsf);color:var(--ac);font-weight:600}.st[aria-current="step"] .dot{border:0;background:var(--ac);color:#fff}
.st small{margin-left:auto;font-size:11.5px;color:var(--t3);font-weight:500}
.st.golive{margin-top:6px;border-top:1px solid #F0F0F3;border-radius:0 0 11px 11px;padding-top:14px;color:var(--t1)}
.st.golive .dot{border:0;background:var(--t1);color:#fff}
.panel{background:#fff;border-radius:18px;padding:24px;box-shadow:var(--shadow);min-width:0}
.ph{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.ph h2{margin:0 0 4px;font-size:22px;letter-spacing:-.6px}.ph p{margin:0;font-size:13.5px;color:var(--t2)}
.tools{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.search{flex:1;min-width:200px;height:36px;border:1px solid var(--bd2);border-radius:10px;background:var(--wm);padding:0 12px;font-size:13px}
.chip{height:36px;padding:0 12px;border-radius:10px;font-size:12.5px;font-weight:600;border:0;background:var(--pg);color:var(--t2);cursor:pointer}
.chip[aria-pressed="true"]{background:var(--t1);color:#fff}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-size:11.5px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;padding:10px;border-bottom:1px solid #F0F0F3}
.tbl td{padding:12px 10px;border-bottom:1px solid #F5F5F7;vertical-align:top}
.nm{font-weight:600}.em{color:var(--t2);font-size:12px;overflow-wrap:anywhere}
.tag{font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;white-space:nowrap}
.t-sent{background:var(--acsf);color:var(--ac)}.t-wait{background:var(--pg);color:var(--t2)}.t-in{background:var(--gnsf);color:var(--gn)}.t-test{background:var(--amsf);color:var(--am)}
.foot{display:flex;justify-content:space-between;gap:12px;margin-top:14px;font-size:12.5px;color:var(--t2);flex-wrap:wrap}
.drop{margin-top:18px;border:1.5px dashed var(--bd2);border-radius:14px;padding:18px;display:flex;align-items:center;gap:14px;background:var(--wm);cursor:pointer}
.drop.over{border-color:var(--ac);background:var(--acsf)}
.drop b{font-size:13.5px}.drop p{margin:2px 0 0;font-size:12.5px;color:var(--t2)}
.preview{margin-top:16px;border:1px solid var(--bd);border-radius:14px;padding:16px}
.preview .sum{display:flex;gap:18px;font-size:13px;margin-bottom:10px;flex-wrap:wrap}
.toggle{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 0;border-bottom:1px solid #F5F5F7}
.toggle b{font-size:14px}.toggle p{margin:3px 0 0;font-size:12.5px;color:var(--t2);max-width:520px}
.sw{position:relative;width:44px;height:26px;flex:none}
.sw input{opacity:0;width:0;height:0}
.sw span{position:absolute;inset:0;border-radius:26px;background:var(--bd2);transition:.15s;cursor:pointer}
.sw span::after{content:"";position:absolute;width:22px;height:22px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:.15s}
.sw input:checked + span{background:var(--gn)}.sw input:checked + span::after{transform:translateX(18px)}
.gl{display:grid;grid-template-columns:1.25fr 1fr;gap:18px}
.inc{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:18px 0 20px}
.inc div{display:flex;gap:9px;font-size:13px;line-height:1.4}.inc svg{flex:none;color:var(--gn);margin-top:1px}
.facts{border:1px solid var(--bd);border-radius:14px;overflow:hidden;font-size:13px}
.facts .r{display:flex;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid #F0F0F3}.facts .r:last-child{border:0}
.facts .r span:first-child{color:var(--t2)}.facts .r b{font-weight:600;text-align:right}
.bigprice{display:flex;align-items:baseline;gap:8px;margin:4px 0}.bigprice b{font-size:34px;letter-spacing:-1px}.bigprice span{color:var(--t2);font-size:13px}
.fine{font-size:12px;color:var(--t2);line-height:1.5}
.center{text-align:center}
@media (max-width:900px){.layout{grid-template-columns:1fr;padding:16px}.steps{position:static}.gl,.inc{grid-template-columns:1fr}.banner{margin:16px 16px 0}.tbl .hide-sm{display:none}}
</style>
</head>
<body>
<nav class="nav">
  <div class="logo"><a class="mk" href="/checkin" style="display:grid"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M16 6a7 7 0 1 0 0 12"/></svg></a>CueDeck<span class="crumb"><a href="/checkin">Your events</a> / <b id="crumb-ev"></b></span></div>
  <div class="nav-r"><a class="btn btn-s" id="desk-link" href="#">Try the desk</a></div>
</nav>
<div class="banner" id="banner" hidden><span id="banner-t"></span><button class="btn btn-p" id="banner-go" style="height:32px">Go live</button></div>
<div class="err" id="page-err" style="margin:16px 28px"></div>

<div class="layout" id="layout" hidden>
  <aside class="steps">
    <div class="ttl"><h3 id="side-name"></h3><p id="side-meta"></p></div>
    <button class="st" data-step="details"><span class="dot">1</span>Event details</button>
    <button class="st" data-step="attendees"><span class="dot">2</span>Attendees<small id="n-att"></small></button>
    <button class="st" data-step="staff"><span class="dot">3</span>Desk staff<small id="n-staff"></small></button>
    <button class="st" data-step="kiosk"><span class="dot">4</span>Kiosk &amp; badges</button>
    <button class="st" data-step="qr"><span class="dot">5</span>QR emails</button>
    <button class="st golive" data-step="golive"><span class="dot"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>Go live<small data-price></small></button>
  </aside>

  <section class="panel" id="p-details" hidden>
    <div class="ph"><div><h2>Event details</h2><p id="det-note">Shown on the desk, the kiosk and in QR emails.</p></div></div>
    <form id="f-det">
      <div class="field"><label for="d-name">Event name</label><input id="d-name" required maxlength="160"></div>
      <div class="row2">
        <div class="field"><label for="d-date">Date</label><input id="d-date" type="date" required></div>
        <div class="field"><label for="d-tz">Timezone</label><select id="d-tz"></select></div>
      </div>
      <div class="row2">
        <div class="field"><label for="d-start">Starts</label><input id="d-start" type="time" required></div>
        <div class="field"><label for="d-end">Ends</label><input id="d-end" type="time" required></div>
      </div>
      <div class="field"><label for="d-venue">Venue</label><input id="d-venue" maxlength="160"></div>
      <button class="btn btn-p" id="d-save">Save</button><span class="ok" id="d-ok"></span>
      <div class="err" id="d-err"></div>
    </form>
  </section>

  <section class="panel" id="p-attendees" hidden>
    <div class="ph">
      <div><h2>Attendees</h2><p id="att-sub"></p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-s" id="att-export">Export CSV</button><button class="btn btn-s" id="att-add">Add person</button><button class="btn btn-p" id="att-import">Import CSV</button></div>
    </div>
    <div class="tools">
      <input class="search" id="att-q" placeholder="Search name, email or company" autocomplete="off">
      <button class="chip" data-f="all" aria-pressed="true">All</button>
      <button class="chip" data-f="noemail" aria-pressed="false">No email</button>
      <button class="chip" data-f="in" aria-pressed="false">Checked in</button>
    </div>
    <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Name</th><th class="hide-sm">Company</th><th class="hide-sm">Ticket</th><th>QR email</th><th>Status</th><th></th></tr></thead><tbody id="att-body"></tbody></table></div>
    <div class="foot"><span id="att-count"></span></div>
    <label class="drop" id="drop"><input type="file" id="csv-file" accept=".csv,text/csv" hidden>
      <div><b>Drop a CSV to add people</b><p>You'll see who will be added, updated or skipped before anything is saved. Columns: first name, last name, email, company, ticket type.</p></div></label>
    <div class="preview" id="imp-prev" hidden></div>
    <div class="err" id="att-err"></div>
  </section>

  <section class="panel" id="p-staff" hidden>
    <div class="ph"><div><h2>Desk staff</h2><p>Desk staff can check people in and print badges. Co-organizers can also change setup.</p></div></div>
    <form id="f-inv" class="row2" style="align-items:end;grid-template-columns:2fr 1fr auto;gap:10px">
      <div class="field"><label for="inv-email">Email</label><input id="inv-email" type="email" required></div>
      <div class="field"><label for="inv-role">Role</label><select id="inv-role"><option value="crew">Desk staff</option><option value="organizer">Co-organizer</option></select></div>
      <div class="field"><button class="btn btn-p" id="inv-btn">Invite</button></div>
    </form>
    <div class="err" id="inv-err"></div><div class="ok" id="inv-ok"></div>
    <table class="tbl" style="margin-top:12px"><thead><tr><th>Person</th><th>Role</th><th></th></tr></thead><tbody id="staff-body"></tbody></table>
  </section>

  <section class="panel" id="p-kiosk" hidden>
    <div class="ph"><div><h2>Kiosk &amp; badges</h2><p>How walk-ins and badges work at this event.</p></div></div>
    <div class="toggle"><div><b>Self-registration kiosk</b><p>Walk-ins can register themselves on a paired tablet. Pair one from the desk with "Set up a kiosk".</p></div><label class="sw"><input type="checkbox" data-set="self_registration"><span></span></label></div>
    <div class="toggle"><div><b>Kiosk prints badges</b><p>Print a badge straight after a walk-in registers at the kiosk.</p></div><label class="sw"><input type="checkbox" data-set="kiosk_self_print"><span></span></label></div>
    <div class="toggle"><div><b>Email QR codes on import</b><p>New guests get their QR code as soon as they are imported. Only once the event is live.</p></div><label class="sw"><input type="checkbox" data-set="auto_send_qr_email"><span></span></label></div>
    <div class="err" id="set-err"></div>
  </section>

  <section class="panel" id="p-qr" hidden>
    <div class="ph"><div><h2>QR emails</h2><p id="qr-sub"></p></div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-s" id="qr-self">Send a test to myself</button><button class="btn btn-p" id="qr-all" hidden></button></div>
    <div class="ok" id="qr-ok"></div><div class="err" id="qr-err"></div>
  </section>

  <section id="p-golive" hidden>
    <div class="gl">
      <div class="panel">
        <h2 style="margin:0 0 4px;font-size:22px;letter-spacing:-.6px">Go live</h2>
        <p style="margin:0;color:var(--t2);font-size:13.5px" id="gl-sub"></p>
        <div class="inc">
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Unlimited attendees and desks</div>
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>QR code email to every guest</div>
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Badge printing at the desk</div>
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Self-registration kiosk</div>
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Works offline at the venue</div>
          <div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Attendance export afterwards</div>
        </div>
        <div class="facts" id="gl-facts"></div>
      </div>
      <div class="panel" id="gl-pay">
        <div class="bigprice"><b data-price></b><span>one payment, this event</span></div>
        <p class="fine" style="margin:0 0 16px">Excl. VAT. Tax is calculated at checkout from your billing address, and you can add a VAT ID. You'll get an invoice by email.</p>
        <button class="btn btn-p" style="width:100%;height:42px" id="gl-btn">Continue to secure payment</button>
        <p class="fine center" style="margin-top:10px">Payment handled by Stripe</p>
        <div class="err" id="gl-err"></div>
      </div>
      <div class="panel center" id="gl-wait" hidden><h3 style="margin:8px 0">Confirming your payment…</h3><p class="fine" id="gl-wait-t">This usually takes a few seconds.</p></div>
      <div class="panel center" id="gl-done" hidden>
        <div style="width:58px;height:58px;border-radius:50%;background:var(--gnsf);display:grid;place-items:center;margin:0 auto 14px;color:var(--gn)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
        <h3 style="margin:0 0 6px">You're live</h3>
        <p class="fine" id="gl-done-t"></p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:14px"><button class="btn btn-p" id="gl-qr">Send QR emails</button><a class="btn btn-s" id="gl-desk" href="#">Open desk</a></div>
      </div>
    </div>
  </section>
</div>

<dialog id="dlg-add">
  <form id="f-add" method="dialog">
    <h3 style="margin:0 0 14px">Add a person</h3>
    <div class="row2"><div class="field"><label for="a-first">First name</label><input id="a-first" required></div><div class="field"><label for="a-last">Last name</label><input id="a-last" required></div></div>
    <div class="field"><label for="a-email">Email</label><input id="a-email" type="email"></div>
    <div class="row2"><div class="field"><label for="a-co">Company</label><input id="a-co"></div><div class="field"><label for="a-tt">Ticket type</label><input id="a-tt" placeholder="attendee"></div></div>
    <div class="err" id="a-err"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button type="button" class="btn btn-s" id="a-cancel">Cancel</button><button class="btn btn-p" id="a-save">Add</button></div>
  </form>
</dialog>

<script type="module">
import { checkinWindow, TEST_CAP } from '/checkin-window.js';
import { parseCsv, mapRows } from '/checkin-csv.js';

const SUPABASE_URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const params = new URLSearchParams(location.search);
const EVENT_ID = params.get('event');
let EV = null, ENT = null, ATT = [], STAFF = [], PRICE = null, FILTER = 'all', PENDING_IMPORT = null;

const fmtDate = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (d, tz) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz });
const isLive = () => ENT?.status === 'live';
async function fnError(error) {
  // supabase-js puts the Response on error.context for non-2xx replies.
  try { const b = await error.context.json(); if (b?.error) return b.error; } catch (_) { /* unreadable body */ }
  return error.message;
}

// ── loading ──────────────────────────────────────────────
async function loadEvent() {
  const { data, error } = await sb.rpc('checkin_my_events');
  if (error) throw new Error(error.message);
  EV = (data || []).find(r => r.event_id === EVENT_ID) || null;
  if (!EV) throw new Error('This event is not in your check-in events.');
  if (EV.role !== 'organizer') { location.replace('/checkin/desk?event=' + EVENT_ID); return false; }
  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements').select('*').eq('event_id', EVENT_ID).maybeSingle();
  if (entErr) throw new Error(entErr.message);
  if (!ent) { location.replace('/checkin'); return false; }
  ENT = ent;
  return true;
}

async function loadAttendees() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('leod_checkin_attendees')
      .select('id,first_name,last_name,email,company,ticket_type,checked_in_at,badge_printed_at,qr_email_sent_at,is_test,source,created_at')
      .eq('event_id', EVENT_ID).order('last_name').order('first_name').range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }
  ATT = all;
}

async function loadStaff() {
  const { data, error } = await sb.functions.invoke('checkin-invite-staff', { body: { event_id: EVENT_ID, action: 'list' } });
  if (error) throw new Error(await fnError(error));
  STAFF = data.staff || [];
}

async function loadPrice() {
  try {
    const r = await fetch(SUPABASE_URL + '/functions/v1/checkin-price');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = await r.json();
    PRICE = new Intl.NumberFormat('en-IE', { style: 'currency', currency: p.currency.toUpperCase(), minimumFractionDigits: p.amount % 100 ? 2 : 0 }).format(p.amount / 100);
    document.querySelectorAll('[data-price]').forEach(n => n.textContent = PRICE);
  } catch (e) { console.error('setup: price unavailable', e); }
}

// ── chrome: banner, rail, header ─────────────────────────
function renderChrome() {
  $('crumb-ev').textContent = EV.name; $('side-name').textContent = EV.name;
  $('side-meta').textContent = fmtDate(EV.date) + ' · ' + (isLive() ? 'Live' : 'Test mode');
  $('desk-link').href = '/checkin/desk?event=' + EVENT_ID;
  $('desk-link').textContent = isLive() ? 'Open desk' : 'Try the desk';
  $('banner').hidden = isLive();
  $('banner-t').replaceChildren(el('b', null, 'Test mode. '),
    document.createTextNode('Everything works, but check-ins are capped at ' + TEST_CAP + ' and cleared when you go live. ' + EV.test_used + ' of ' + TEST_CAP + ' used.'));
  $('banner-go').textContent = PRICE ? 'Go live · ' + PRICE : 'Go live';
  $('n-att').textContent = ATT.length || '';
  $('n-staff').textContent = STAFF.filter(s => !s.is_owner).length || '';
  const done = {
    details: true,
    attendees: ATT.length > 0,
    staff: STAFF.some(s => !s.is_owner),
    kiosk: ENT.self_registration || ENT.kiosk_self_print || ENT.auto_send_qr_email,
    qr: ATT.some(a => a.qr_email_sent_at),
    golive: isLive(),
  };
  document.querySelectorAll('.st').forEach(b => b.classList.toggle('done', !!done[b.dataset.step] && b.dataset.step !== 'golive'));
}

function go(step) {
  for (const s of ['details', 'attendees', 'staff', 'kiosk', 'qr', 'golive']) $('p-' + s).hidden = s !== step;
  document.querySelectorAll('.st').forEach(b => { if (b.dataset.step === step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
  ({ details: renderDetails, attendees: renderAttendees, staff: renderStaff, kiosk: renderKiosk, qr: renderQr, golive: renderGolive })[step]();
  const u = new URL(location.href); u.searchParams.set('step', step); history.replaceState(null, '', u);
}
document.querySelectorAll('.st').forEach(b => b.addEventListener('click', () => go(b.dataset.step)));
$('banner-go').onclick = () => go('golive');

// ── 1. details ───────────────────────────────────────────
function renderDetails() {
  $('d-name').value = EV.name; $('d-date').value = EV.date; $('d-venue').value = EV.venue || '';
  $('d-start').value = (EV.event_start || '09:00').slice(0, 5); $('d-end').value = (EV.event_end || '18:00').slice(0, 5);
  const sel = $('d-tz'); sel.replaceChildren();
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [EV.timezone];
  if (!zones.includes(EV.timezone)) zones.unshift(EV.timezone);
  for (const z of zones) { const o = el('option', null, z.replace(/_/g, ' ')); o.value = z; o.selected = z === EV.timezone; sel.appendChild(o); }
  const owner = EV.is_owner;
  for (const id of ['d-name', 'd-date', 'd-tz', 'd-start', 'd-end', 'd-venue', 'd-save']) $(id).disabled = !owner;
  if (isLive()) $('d-date').disabled = true;
  $('det-note').textContent = !owner ? 'Only the event owner can change these details.'
    : isLive() ? 'The date is locked now the event is live. Contact support@cuedeck.io to move it.'
    : 'Shown on the desk, the kiosk and in QR emails.';
}
$('f-det').addEventListener('submit', async (e) => {
  e.preventDefault(); $('d-err').textContent = ''; $('d-ok').textContent = ''; $('d-save').disabled = true;
  const patch = { name: $('d-name').value.trim(), venue: $('d-venue').value.trim() || null, timezone: $('d-tz').value,
                  event_start: $('d-start').value, event_end: $('d-end').value };
  if (!isLive()) patch.date = $('d-date').value;
  const { error } = await sb.from('leod_events').update(patch).eq('id', EVENT_ID);
  $('d-save').disabled = false;
  if (error) { $('d-err').textContent = error.message; return; }
  await loadEvent(); renderChrome(); $('d-ok').textContent = ' Saved';
});

// ── 2. attendees ─────────────────────────────────────────
function statusTag(a) {
  if (a.checked_in_at) return el('span', 'tag ' + (isLive() ? 't-in' : 't-test'), isLive() ? 'Checked in' : 'Test check-in');
  return el('span', 'em', 'Expected');
}
function renderAttendees() {
  const q = $('att-q').value.trim().toLowerCase();
  const rows = ATT.filter(a => (FILTER === 'all' || (FILTER === 'noemail' && !a.email) || (FILTER === 'in' && a.checked_in_at)) &&
    (!q || `${a.first_name} ${a.last_name} ${a.email || ''} ${a.company || ''}`.toLowerCase().includes(q)));
  $('att-sub').textContent = ATT.length + ' people. People from the same company check in together with one scan.';
  document.querySelectorAll('.chip').forEach(c => {
    const n = c.dataset.f === 'all' ? ATT.length : c.dataset.f === 'noemail' ? ATT.filter(a => !a.email).length : ATT.filter(a => a.checked_in_at).length;
    c.textContent = ({ all: 'All', noemail: 'No email', in: 'Checked in' })[c.dataset.f] + ' ' + n;
  });
  const body = $('att-body'); body.replaceChildren();
  for (const a of rows.slice(0, 200)) {
    const tr = el('tr');
    const n = el('td'); n.append(el('div', 'nm', a.first_name + ' ' + a.last_name), el('div', 'em', a.email || 'No email'));
    if (!a.email) n.lastChild.style.color = 'var(--rd)';
    const qr = el('td'); qr.appendChild(a.email ? el('span', 'tag ' + (a.qr_email_sent_at ? 't-sent' : 't-wait'), a.qr_email_sent_at ? 'Sent' : 'Not sent') : el('span', 'em', 'n/a'));
    const st = el('td'); st.appendChild(statusTag(a));
    const del = el('td'); const b = el('button', 'link', 'Remove'); b.onclick = () => removeAttendee(a); del.appendChild(b);
    tr.append(n, el('td', 'hide-sm', a.company || ''), el('td', 'hide-sm', a.ticket_type || ''), qr, st, del);
    body.appendChild(tr);
  }
  $('att-count').textContent = 'Showing ' + Math.min(rows.length, 200) + ' of ' + rows.length + (rows.length > 200 ? '. Search to narrow the list.' : '');
}
$('att-q').addEventListener('input', renderAttendees);
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
  FILTER = c.dataset.f; document.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === c))); renderAttendees();
}));

async function removeAttendee(a) {
  $('att-err').textContent = '';
  if (!confirm('Remove ' + a.first_name + ' ' + a.last_name + ' from the guest list?')) return;
  const { error } = await sb.from('leod_checkin_attendees').delete().eq('id', a.id);
  if (error) { $('att-err').textContent = error.code === '23503' ? 'This person has check-in history, so they cannot be removed.' : error.message; return; }
  ATT = ATT.filter(x => x.id !== a.id); renderAttendees(); renderChrome();
}

$('att-add').onclick = () => { $('a-err').textContent = ''; $('f-add').reset(); $('dlg-add').showModal(); };
$('a-cancel').onclick = () => $('dlg-add').close();
$('f-add').addEventListener('submit', async (e) => {
  e.preventDefault(); $('a-save').disabled = true;
  const row = { first_name: $('a-first').value.trim(), last_name: $('a-last').value.trim() };
  for (const [k, id] of [['email', 'a-email'], ['company', 'a-co'], ['ticket_type', 'a-tt']]) { const v = $(id).value.trim(); if (v) row[k] = v; }
  const { data, error } = await sb.functions.invoke('checkin-import-attendees', { body: { event_id: EVENT_ID, rows: [row], dry_run: false } });
  $('a-save').disabled = false;
  if (error) { $('a-err').textContent = await fnError(error); return; }
  const r = data.results?.[0];
  if (r?.action === 'skip') { $('a-err').textContent = r.reason || 'Not added'; return; }
  $('dlg-add').close(); await loadAttendees(); renderAttendees(); renderChrome();
});

$('att-import').onclick = () => $('csv-file').click();
$('csv-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) previewImport(f); e.target.value = ''; });
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) previewImport(f); });

async function previewImport(file) {
  $('att-err').textContent = ''; const box = $('imp-prev'); box.hidden = false; box.replaceChildren(el('div', 'fine', 'Reading ' + file.name + '…'));
  const { rows, unmapped, missing } = mapRows(parseCsv(await file.text()));
  if (missing.length) { box.replaceChildren(el('div', 'err', 'This file has no ' + missing.join(' or ').replace(/_/g, ' ') + ' column. Add it and try again.')); return; }
  if (!rows.length) { box.replaceChildren(el('div', 'err', 'No people found in this file.')); return; }
  const { data, error } = await sb.functions.invoke('checkin-import-attendees', { body: { event_id: EVENT_ID, rows, dry_run: true } });
  if (error) { box.replaceChildren(el('div', 'err', await fnError(error))); return; }
  PENDING_IMPORT = rows;
  const s = data.summary;
  const sum = el('div', 'sum');
  sum.append(el('b', null, s.to_create + ' to add'), el('span', null, s.to_update + ' to update'), el('span', null, s.to_skip + ' skipped'));
  box.replaceChildren(sum);
  if (unmapped.length) box.appendChild(el('div', 'fine', 'Ignored columns: ' + unmapped.join(', ')));
  const skips = data.results.filter(r => r.action === 'skip').slice(0, 10);
  for (const r of skips) box.appendChild(el('div', 'fine', (r.row.first_name || '?') + ' ' + (r.row.last_name || '') + ': ' + r.reason));
  const acts = el('div'); acts.style.cssText = 'display:flex;gap:8px;margin-top:12px';
  const ok = el('button', 'btn btn-p', 'Import ' + (s.to_create + s.to_update) + ' people');
  ok.disabled = s.to_create + s.to_update === 0;
  const no = el('button', 'btn btn-s', 'Cancel');
  no.onclick = () => { PENDING_IMPORT = null; box.hidden = true; };
  ok.onclick = async () => {
    ok.disabled = true; ok.textContent = 'Importing…';
    const { data: done, error: e2 } = await sb.functions.invoke('checkin-import-attendees', { body: { event_id: EVENT_ID, rows: PENDING_IMPORT, dry_run: false } });
    if (e2) { ok.disabled = false; ok.textContent = 'Try again'; box.appendChild(el('div', 'err', await fnError(e2))); return; }
    PENDING_IMPORT = null;
    box.replaceChildren(el('div', 'ok', 'Imported. ' + done.summary.to_create + ' added, ' + done.summary.to_update + ' updated.'));
    if (done.update_errors?.length) box.appendChild(el('div', 'err', done.update_errors.length + ' updates failed. See the browser console for names.'));
    await loadAttendees(); renderAttendees(); renderChrome();
  };
  acts.append(ok, no); box.appendChild(acts);
}

$('att-export').onclick = () => {
  const head = ['First name', 'Last name', 'Email', 'Company', 'Ticket', 'Checked in at', 'Badge printed at'];
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head, ...ATT.map(a => [a.first_name, a.last_name, a.email, a.company, a.ticket_type, a.checked_in_at, a.badge_printed_at])]
    .map(r => r.map(cell).join(','));
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = el('a'); a.href = url; a.download = EV.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '-attendance.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

// ── 3. staff ─────────────────────────────────────────────
function renderStaff() {
  const body = $('staff-body'); body.replaceChildren();
  for (const s of STAFF) {
    const tr = el('tr');
    const p = el('td'); p.append(el('div', 'nm', s.name || s.email || 'Invited user'), el('div', 'em', s.email || ''));
    const r = el('td', null, s.is_owner ? 'Owner' : s.role === 'organizer' ? 'Co-organizer' : 'Desk staff');
    const x = el('td');
    if (!s.is_owner) { const b = el('button', 'link', 'Remove'); b.onclick = () => removeStaff(s); x.appendChild(b); }
    tr.append(p, r, x); body.appendChild(tr);
  }
}
$('f-inv').addEventListener('submit', async (e) => {
  e.preventDefault(); $('inv-err').textContent = ''; $('inv-ok').textContent = ''; $('inv-btn').disabled = true;
  const { data, error } = await sb.functions.invoke('checkin-invite-staff', { body: { event_id: EVENT_ID, action: 'invite', email: $('inv-email').value, role: $('inv-role').value } });
  $('inv-btn').disabled = false;
  if (error) { $('inv-err').textContent = await fnError(error); return; }
  $('inv-ok').textContent = data.invited ? 'Invitation sent.' : 'Added. They already had a CueDeck login and have been emailed.';
  $('inv-email').value = ''; await loadStaff(); renderStaff(); renderChrome();
});
async function removeStaff(s) {
  $('inv-err').textContent = '';
  const { error } = await sb.functions.invoke('checkin-invite-staff', { body: { event_id: EVENT_ID, action: 'remove', user_id: s.user_id } });
  if (error) { $('inv-err').textContent = await fnError(error); return; }
  await loadStaff(); renderStaff(); renderChrome();
}

// ── 4. kiosk & badges ────────────────────────────────────
function renderKiosk() { document.querySelectorAll('[data-set]').forEach(i => i.checked = !!ENT[i.dataset.set]); }
document.querySelectorAll('[data-set]').forEach(i => i.addEventListener('change', async () => {
  $('set-err').textContent = ''; i.disabled = true;
  const { error } = await sb.functions.invoke('checkin-enable-event', { body: { event_id: EVENT_ID, settings: { [i.dataset.set]: i.checked } } });
  i.disabled = false;
  if (error) { i.checked = !i.checked; $('set-err').textContent = await fnError(error); return; }
  ENT[i.dataset.set] = i.checked; renderChrome();
}));

// ── 5. QR emails ─────────────────────────────────────────
function renderQr() {
  const unsent = ATT.filter(a => a.email && !a.qr_email_sent_at).length;
  $('qr-sub').textContent = isLive()
    ? unsent + ' guests with an email address have not been sent their QR code yet.'
    : 'Send yourself a sample to see what guests receive. Sending to guests unlocks when you go live.';
  $('qr-all').hidden = !isLive();
  $('qr-all').textContent = 'Send to ' + unsent + ' guests';
  $('qr-all').disabled = unsent === 0;
}
$('qr-self').onclick = async () => {
  $('qr-ok').textContent = ''; $('qr-err').textContent = ''; $('qr-self').disabled = true;
  const { data, error } = await sb.functions.invoke('checkin-send-qr-emails', { body: { event_id: EVENT_ID, test_to_self: true } });
  $('qr-self').disabled = false;
  if (error) { $('qr-err').textContent = await fnError(error); return; }
  $('qr-ok').textContent = 'Sample sent to ' + data.sent_to + '.';
};
async function sendAll(btn, msgEl, errEl) {
  errEl.textContent = ''; btn.disabled = true;
  const { data, error } = await sb.functions.invoke('checkin-send-qr-emails', { body: { event_id: EVENT_ID } });
  btn.disabled = false;
  if (error) { errEl.textContent = await fnError(error); return; }
  const s = data.summary;
  msgEl.textContent = s.sent + ' sent' + (s.skipped_no_email ? ', ' + s.skipped_no_email + ' without email' : '') + (s.errored ? ', ' + s.errored + ' failed' : '') + '.';
  await loadAttendees(); renderChrome(); if (!$('p-qr').hidden) renderQr();
}
$('qr-all').onclick = () => sendAll($('qr-all'), $('qr-ok'), $('qr-err'));

// ── 6. go live ───────────────────────────────────────────
function renderGolive() {
  const w = checkinWindow(EV.date, EV.timezone);
  const closesShown = new Date(w.closesAt.getTime() - 1);
  $('gl-sub').textContent = isLive() ? EV.name + ' is live.' : EV.name + ' is ready. Going live turns on real check-ins and QR emails for this event.';
  const facts = $('gl-facts'); facts.replaceChildren();
  for (const [k, v] of [['Check-in window', fmtDay(w.opensAt, EV.timezone) + ' to ' + fmtDay(closesShown, EV.timezone)],
                        ['Attendees kept', 'All ' + ATT.filter(a => !a.is_test).length],
                        ['Test check-ins', EV.test_used + ', cleared on go-live'],
                        ['Event date', 'Locked once live']]) {
    const r = el('div', 'r'); r.append(el('span', null, k), el('b', null, v)); facts.appendChild(r);
  }
  $('gl-pay').hidden = isLive(); $('gl-done').hidden = !isLive(); $('gl-wait').hidden = true;
  $('gl-done-t').textContent = 'Check-ins now count for real' + (ATT.length ? ', and you can send QR emails to your ' + ATT.length + ' attendees.' : '.');
  $('gl-desk').href = '/checkin/desk?event=' + EVENT_ID;
}
$('gl-btn').onclick = async () => {
  $('gl-err').textContent = ''; $('gl-btn').disabled = true; $('gl-btn').textContent = 'Opening payment…';
  const { data, error } = await sb.functions.invoke('checkin-create-checkout', { body: { event_id: EVENT_ID } });
  if (error || !data?.url) { $('gl-btn').disabled = false; $('gl-btn').textContent = 'Continue to secure payment'; $('gl-err').textContent = error ? await fnError(error) : 'Could not start payment.'; return; }
  location.href = data.url;
};
$('gl-qr').onclick = () => go('qr');

async function waitForLive() {
  go('golive'); $('gl-pay').hidden = true; $('gl-wait').hidden = false;
  for (let i = 0; i < 30; i++) {
    const { data, error } = await sb.from('leod_checkin_entitlements').select('status').eq('event_id', EVENT_ID).single();
    if (!error && data.status === 'live') {
      await loadEvent(); await loadAttendees(); renderChrome(); renderGolive();
      history.replaceState(null, '', '/checkin/setup?event=' + EVENT_ID + '&step=golive');
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  $('gl-wait-t').textContent = 'Payment received, still confirming. Refresh in a minute. If this page still says test mode after that, email support@cuedeck.io.';
}

// ── boot ─────────────────────────────────────────────────
(async () => {
  if (!EVENT_ID) { location.replace('/checkin'); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('/checkin'); return; }
  try {
    loadPrice();
    if (!(await loadEvent())) return;
    await Promise.all([loadAttendees(), loadStaff()]);
  } catch (e) { $('page-err').textContent = 'Could not load this event: ' + e.message; return; }
  $('layout').hidden = false; renderChrome();
  if (params.get('paid') === '1' && !isLive()) { await waitForLive(); return; }
  const step = params.get('step');
  go(['details', 'attendees', 'staff', 'kiosk', 'qr', 'golive'].includes(step) ? step
     : !ATT.length ? 'attendees' : isLive() ? 'attendees' : 'golive');
})();
</script>
</body>
</html>
```
The shared rules (tokens, nav, buttons, fields, pills, dialog) come from `/checkin-app.css`, created in Task 8.

- [ ] **Step 7: Browser check**

Serve `python3 -m http.server 7230`, sign in at `http://127.0.0.1:7230/cuedeck-checkin-home.html` as a throwaway organizer, create a test event, then open `http://127.0.0.1:7230/cuedeck-checkin-setup.html?event=<id>`.
Expected, each with a 2× screenshot in the PR:
1. Attendees: import a 30-row CSV with one semicolon-separated file and one with a `Diet` column; the preview shows add/update/skip counts and "Ignored columns: Diet"; confirm imports them.
2. Staff: invite a second throwaway address as Desk staff; it appears in the table; removing the owner is not offered.
3. Kiosk & badges: toggling persists across reload.
4. QR emails: "Send a test to myself" arrives at the organizer's throwaway inbox; the guest's `qr_email_sent_at` stays empty.
5. Go live: the window reads "7 days before to 2 days after" in event-local dates; the price shows €249.
6. Phone width (390 px): no horizontal scroll; the rail stacks above the panel.

- [ ] **Step 8: Commit**

```bash
git add checkin-csv.js tests/checkin-csv.spec.ts cuedeck-checkin-setup.html supabase/functions/checkin-invite-staff/index.ts
git commit -m "feat(checkin): setup page with import preview, staff, settings, QR emails and go-live" -- checkin-csv.js tests/checkin-csv.spec.ts cuedeck-checkin-setup.html supabase/functions/checkin-invite-staff/index.ts
```

---

### Task 10: Desk test mode, refusals, badge preview

**Files:**
- Modify: `cuedeck-checkin.html` (picker, `openEvent`, `renderStation`, `badgeNode`, `commitTicked`, `flushOutbox`, kiosk result, CSS)

**Interfaces:**
- Consumes: `checkin_my_events()`, `/checkin-window.js`, verdicts `'test_cap'` / `'outside_window'` (Task 3), kiosk response `test` and 403 `code: 'test_cap'` (Task 4).
- Produces: `S.status: 'test' | 'live'`, `S.testUsed: number`, `S.eventDate`, `S.eventTz`.

- [ ] **Step 1: Load the window helper**

The desk script is a classic script. Add before it:
```html
<script type="module">
  import { checkinWindow, isWithinWindow, TEST_CAP } from '/checkin-window.js';
  window.CK_POLICY = { checkinWindow, isWithinWindow, TEST_CAP };
</script>
```
Module scripts run after classic ones, so any code using `window.CK_POLICY` runs inside event handlers (after load), never at parse time.

- [ ] **Step 2: Picker reads `checkin_my_events()`**

In `showPicker()`, replace the grants query, the `leod_events` lookup and the `grants.forEach` loop with:
```js
  const { data: mine, error } = await sb.rpc('checkin_my_events');
  if (error) {
    note.textContent = 'Could not load your events: ' + error.message;
    note.style.display = 'block';
    showScreen('picker');
    return;
  }
  // Only events with check-in set up; "Not set up" events belong to the
  // front page, where the organizer can set them up.
  const rows = (mine || []).filter(r => r.status);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'ck-empty';
    empty.textContent = 'You have no check-in events yet.';
    list.appendChild(empty);
    showScreen('picker');
    return;
  }

  const wanted = new URLSearchParams(location.search).get('event');
  const direct = wanted && rows.find(r => r.event_id === wanted);
  if (direct) { openEvent(direct.event_id, direct, direct.role); return; }

  rows.forEach(r => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ck-ev';
    const main = document.createElement('div');
    main.className = 'ck-ev-main';
    const name = document.createElement('div');
    name.className = 'ck-ev-name';
    name.textContent = r.name;
    const meta = document.createElement('div');
    meta.className = 'ck-ev-meta';
    meta.textContent = r.date + (r.status === 'test' ? ' · Test mode' : '');
    main.appendChild(name);
    main.appendChild(meta);
    const pill = document.createElement('span');
    pill.className = 'ck-pill';
    pill.textContent = r.role;
    btn.appendChild(main);
    btn.appendChild(pill);
    btn.addEventListener('click', () => openEvent(r.event_id, r, r.role));
    list.appendChild(btn);
  });
```

- [ ] **Step 3: `openEvent` records state**

In `openEvent`, change the entitlement select to `.select('checkin_core, status')` and after `S.role = role;` add:
```js
  S.status   = ent.status === 'live' ? 'live' : 'test';
  S.testUsed = ev && typeof ev.test_used === 'number' ? ev.test_used : 0;
  S.eventDate = ev ? ev.date : null;
  S.eventTz   = ev ? ev.timezone : null;
```
`S.event` stays `{ id, name, date }` built from `ev` as today.

- [ ] **Step 4: Test banner in the station**

In the station markup, directly after `<div id="station">`, add:
```html
  <div class="ck-test" id="st-test" hidden></div>
```
CSS (with the other `.ck-` rules):
```css
.ck-test{background:var(--amsf);border-bottom:1px solid var(--ambd);color:var(--am);font-size:13px;padding:10px 24px;display:flex;justify-content:space-between;gap:12px}
.ck-test b{color:#7A4700}
.ck-test a{color:var(--am);font-weight:600}
```
At the end of `renderStation()` add a call `renderTestBanner();` and define:
```js
function renderTestBanner() {
  const box = document.getElementById('st-test');
  box.hidden = S.status !== 'test';
  if (box.hidden) return;
  const cap = window.CK_POLICY ? window.CK_POLICY.TEST_CAP : 25;
  const left = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = 'Test mode. ';
  left.appendChild(b);
  left.appendChild(document.createTextNode('Check-ins here are cleared when you go live. ' + S.testUsed + ' of ' + cap + ' used.'));
  box.replaceChildren(left);
  if (S.role === 'organizer') {
    const a = document.createElement('a');
    a.href = '/checkin/setup?event=' + S.event.id + '&step=golive';
    a.textContent = 'Go live';
    box.appendChild(a);
  }
}
```

- [ ] **Step 5: Refuse early, before anything is queued**

At the top of `commitTicked(opts)`, after `if (!S.party) return;` and the `picked` line, add:
```js
  const block = deskBlockReason(picked.length);
  if (block) { showDeskBlock(block); return; }
```
Define:
```js
// The server is the authority (checkin-record-scans refuses the same
// cases), but refusing here keeps a person from seeing "checked in" on
// screen and then losing it on the next sync.
function deskBlockReason(n) {
  const P = window.CK_POLICY;
  if (!P) return null;
  if (S.status === 'test' && S.testUsed + n > P.TEST_CAP) {
    return { title: 'Test check-ins used up',
             text: 'This event is in test mode and has ' + Math.max(0, P.TEST_CAP - S.testUsed) + ' of ' + P.TEST_CAP + ' test check-ins left. Go live to keep checking people in.' };
  }
  if (S.status === 'live' && S.eventDate && S.eventTz && !P.isWithinWindow(new Date().toISOString(), S.eventDate, S.eventTz)) {
    const w = P.checkinWindow(S.eventDate, S.eventTz);
    const f = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: S.eventTz });
    return { title: 'Check-in is closed for this event',
             text: 'Check-in runs from ' + f(w.opensAt) + ' to ' + f(new Date(w.closesAt.getTime() - 1)) + '. Contact support@cuedeck.io if the event date is wrong.' };
  }
  return null;
}

function showDeskBlock(block) {
  const box = document.createElement('div');
  box.className = 'ck-vd ck-vd-dup';
  const h = document.createElement('div');
  h.className = 'ck-vd-h';
  h.textContent = block.title;
  const t = document.createElement('div');
  t.className = 'ck-vd-t';
  t.textContent = block.text;
  box.append(h, t);
  document.getElementById('verdict').replaceChildren(box);
}
```
In `commitParty`, after the loop that queues items, add `if (S.status === 'test') { S.testUsed += attendees.length; renderTestBanner(); }`.

- [ ] **Step 6: Handle refusals that arrive on sync (Review Focus 1)**

In `flushOutbox`, next to `const refusedUndos = [];` add `const refusedPaywall = [];`. After the `settled.forEach(p => { if (p.action === 'undo' ...` line add:
```js
      settled.forEach(p => { if (p.result === 'test_cap' || p.result === 'outside_window') refusedPaywall.push(p); });
```
These items are settled (they carry a real verdict), so they leave the queue and are never retried. After `if (refusedUndos.length) showRefusedUndo(refusedUndos);` add:
```js
      if (refusedPaywall.length) showRefusedPaywall(refusedPaywall);
```
Define:
```js
function showRefusedPaywall(items) {
  const names = items.map(p => S.roster.find(x => x.id === p.attendee_id)).filter(Boolean).map(fullName);
  const cap = items.some(p => p.result === 'test_cap');
  showDeskBlock({
    title: (names.length === 1 ? '1 check-in was' : names.length + ' check-ins were') + ' not saved',
    text: (cap ? 'The test limit was reached while this desk was offline. ' : 'These were made outside the check-in window. ')
          + 'Not checked in: ' + names.join(', ') + '.',
  });
}
```
The `reconcileRoster()` that already runs before this restores their rows to "not checked in".

- [ ] **Step 7: TEST watermark and badge preview**

In `badgeNode(attendee)`, before `return badge;` add:
```js
  if (S.status === 'test') {
    const wm = document.createElement('div');
    wm.className = 'wm';
    wm.textContent = 'TEST';
    badge.appendChild(wm);
  }
```
Inside the `@media print` block add:
```css
  .badge { position: relative; }
  .badge .wm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
               font-size: 64pt; font-weight: 900; letter-spacing: 6pt; color: rgba(179,38,30,.28);
               transform: rotate(-18deg); pointer-events: none; }
```
Badge preview: inside `.ck-panel`, directly after `<div id="party"></div>`, add `<div class="ck-preview" id="preview" hidden></div>`, and CSS outside the print block:
```css
.ck-preview{margin-top:16px;border:1px solid var(--bd);border-radius:var(--radius);padding:14px;background:var(--wm)}
.ck-preview .lbl{font-size:12.5px;font-weight:600;color:var(--t2);margin-bottom:8px}
.ck-preview .badge{width:100%;max-width:340px;aspect-ratio:10/7;margin:0 auto;background:#fff;border:1px solid var(--bd);border-radius:12px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 18px;position:relative;overflow:hidden}
.ck-preview .badge .nm{font-weight:700;letter-spacing:-.5px;overflow-wrap:anywhere;font-size:24px!important}
.ck-preview .badge .co{font-size:14px;color:var(--t2);margin-top:4px}
.ck-preview .badge .tt{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--ac);margin-top:6px}
.ck-preview .badge .wm{position:absolute;inset:0;display:grid;place-items:center;font-size:76px;font-weight:900;color:rgba(179,38,30,.22);transform:rotate(-18deg)}
```
At the end of `renderParty()` add:
```js
  const pv = document.getElementById('preview');
  const first = S.party && S.party.members.find(m => S.party.ticked.has(m.id));
  pv.hidden = !first;
  if (first) {
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = 'Badge preview';
    pv.replaceChildren(lbl, badgeNode(first));
  }
```

- [ ] **Step 8: Kiosk labels a test registration**

In `kioskSubmit`, change the last line to `kioskResult(data.status, typeof data.code === 'string' ? data.code : '', data.test === true);` and give `kioskResult` a third parameter `isTest`. In its `status === 'registered'` branch, after the code element is appended:
```js
    if (isTest) {
      const t = document.createElement('div');
      t.className = 'kk-p';
      t.textContent = 'Test registration. This event is still being set up.';
      body.appendChild(t);
    }
```

- [ ] **Step 9: Browser check (desk)**

With the test event from Task 9 (30 imported guests), open `http://127.0.0.1:7230/cuedeck-checkin.html?event=<id>`:
1. The amber banner shows "0 of 25 used"; check in a party of 3, banner shows 3.
2. Print preview (Cmd+P) shows TEST across the badge; the on-screen preview shows it too.
3. Check in until 25; the 26th is refused on screen with "Test check-ins used up" and nothing is queued (outbox count unchanged).
4. Review Focus 1: set `S.testUsed = 0` in the console to simulate a stale desk, go offline (DevTools Network: Offline), check in 3 more, go online. Expected: the sync reports "3 check-ins were not saved", the three rows read "not checked in", and the outbox count returns to 0.
5. The IME 2026 live event opens with no banner and prints clean badges.
Record screenshots at 2×.

- [ ] **Step 10: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): desk test mode, paywall refusals, TEST badges and badge preview" -- cuedeck-checkin.html
```

---

### Task 11: End to end with real payment, docs, release

**Files:**
- Modify: `docs/checkin-desk-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-04-checkin-product-design.md` (status line only)

- [ ] **Step 1: Deploy the pages**

The working tree must be clean apart from this task. Push to the `cuedeck` remote (auto-deploys production on Vercel):
```bash
git push cuedeck main
```
Then confirm the deployment is newer than the last commit with `list_deployments` for project `prj_yxtJHa9k9jO7ZEPjaYRr3BaBxuLz` (do not grep bundles). Then:
```bash
for p in /checkin /checkin/setup /checkin/desk /checkin-window.js /checkin-csv.js; do printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" https://app.cuedeck.io$p; done
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://app.cuedeck.io/kiosk
```
Expected: five `200`s, then `307 https://app.cuedeck.io/checkin/desk?mode=kiosk`.

- [ ] **Step 2: Full journey with a real payment and refund**

Uses a throwaway account, never the owner's. The card is Sherif's; he completes Stripe Checkout himself.
1. Sign up at app.cuedeck.io/checkin with a throwaway address; confirm the email; land on Your events.
2. New event dated 5 days from today; import a 10-row CSV; invite a second throwaway address as Desk staff.
3. As the staff account (separate browser profile): accept the invite, set a password, see only that event, only "Open desk". Open app.cuedeck.io (console) as staff: the "This login is for CueDeck Check-in" screen appears.
4. As organizer: check in 2 people at the desk (test), then Go live. **Sherif pays €249 + VAT** in Checkout.
5. Back on Setup: "Confirming…" then "You're live" within 60 s.
6. Verify in SQL, one query each:
   ```sql
   select status, went_live_at from leod_checkin_entitlements where event_id = '<id>';
   ```
   expected `live`, a timestamp.
   ```sql
   select count(*) filter (where is_test) as test_rows, count(*) as all_rows from leod_checkin_scan_events where event_id = '<id>';
   ```
   expected `0, 0`.
   ```sql
   select count(*) from leod_checkin_purchases where event_id = '<id>';
   ```
   expected `1`.
7. Stripe dashboard → the event's webhook delivery: resend `checkout.session.completed`. Re-run the purchase count: still `1` (Review Focus 3).
8. Send QR emails to all; one arrives at a throwaway guest address. Check one guest in at the desk; the badge prints with no TEST mark.
9. Refund the payment in full from the Stripe dashboard. Within a minute:
   ```sql
   select status from leod_checkin_entitlements where event_id = '<id>';
   ```
   expected `test`, and the desk shows the test banner after a reload. Stripe fees on the refunded charge are the cost of this test; say so in the PR.

- [ ] **Step 3: Update the runbook**

In `docs/checkin-desk-runbook.md`: change every `http://<host>/cuedeck-checkin.html` to `https://app.cuedeck.io/checkin/desk` and add a section:
```markdown
## Test mode and going live

New events start in test mode: up to 25 check-ins and kiosk registrations, badges print with TEST across them, and nothing is emailed to guests. The organizer goes live from Setup → Go live (€249 per event, excl. VAT). Going live clears every test check-in and test kiosk registration; imported guests stay. A live event accepts check-ins from 7 days before its date until 2 days after, in the event's timezone, and its date is locked. A full refund in Stripe puts the event back into test mode.
```

- [ ] **Step 4: Mark the spec implemented and commit**

Change the spec's `**Status:** awaiting review` to `**Status:** implemented (Plan A); Plan B (marketing) pending`.
```bash
git add docs/checkin-desk-runbook.md docs/superpowers/specs/2026-10-04-checkin-product-design.md
git commit -m "docs(checkin): runbook for test mode and go-live; spec status" -- docs/checkin-desk-runbook.md docs/superpowers/specs/2026-10-04-checkin-product-design.md
git push cuedeck main
```

- [ ] **Step 5: Clean up**

Delete the throwaway accounts' events and the test purchase rows only after Sherif confirms the PR evidence. Remove the test data listed in memory `project_cuedeck_checkin_scanner` (Acme companies on IME 2026, the organizer grant for `28230d43-…`, Piotr Nowak's `badge_printed_at`) once Sherif agrees; ask first, it is his event.
