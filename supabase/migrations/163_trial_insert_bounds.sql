-- ============================================================
-- CueDeck Migration 163: a browser can start one 3-day trial, nothing more
-- ============================================================
-- createTrialSubscription() in cuedeck-console.html inserts the trial row
-- from the browser, under RLS policy directors_insert_own_trial, which checks
-- only director_id = auth.uid() AND plan = 'trial'. The 3 days were set by
-- the page, so anyone could insert a trial ending in 2099, and because
-- ai-proxy and the console read the NEWEST row, insert a fresh trial
-- whenever the last one ran out. Trial passes aiAllowed(), so that was
-- endless paid features and AI. Live data on 2026-11-10 was clean: longest
-- trial 12 days (admin extensions), none past 30 days, nobody with two rows.
--
-- For inserts made by a signed-in user (not the service role: stripe-webhook,
-- admin-manage-subscription and checkin-create-checkout insert as service
-- role and are untouched):
--   * trial_ends_at is at most 3 days from now, status is 'active';
--   * an account that already has a subscription row cannot insert another.
-- Admin extensions are UPDATEs through admin RPCs and are not affected.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bound_client_trial_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM leod_subscriptions WHERE director_id = NEW.director_id) THEN
    RAISE EXCEPTION 'This account already has a subscription' USING ERRCODE = '23505';
  END IF;

  NEW.status := 'active';
  NEW.trial_ends_at := least(coalesce(NEW.trial_ends_at, now() + interval '3 days'),
                             now() + interval '3 days');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bound_client_trial_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bound_client_trial_insert ON public.leod_subscriptions;
CREATE TRIGGER trg_bound_client_trial_insert
  BEFORE INSERT ON public.leod_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.bound_client_trial_insert();
