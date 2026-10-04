-- 076: fixed search_path on every SECURITY DEFINER function in public.
--
-- Guard security_definer_search_path (checkin_guard_results, 075) reported
-- 35 SECURITY DEFINER functions with no fixed search_path. A definer function
-- that resolves names through the caller's search_path can be hijacked by an
-- object the caller creates earlier on that path. pg_temp is last so a
-- temporary object can never shadow a real one. No body changes.
--
-- Safety check, done 2026-10-04 against the live database (sawekpguemzvuvvulfbc):
--   Extensions: pgcrypto, uuid-ossp, pg_stat_statements in `extensions`;
--   supabase_vault in `vault`. No body calls crypt/gen_salt/digest/hmac/
--   gen_random_bytes/uuid_generate_* or references extensions./net./vault./
--   cron./storage./graphql. No body uses EXECUTE (no dynamic SQL).
--   Every unqualified relation used (leod_users, activity_log, leod_admin_audit,
--   leod_events, email_log, leod_promo_codes, leod_subscriptions, leod_invoices,
--   leod_clock, welcome_email_trigger, cms_users) exists only in public.
--   auth.uid() and auth.users are always schema-qualified.
--
-- function                                                   | class
-- -----------------------------------------------------------+------------------------------------------
-- admin_get_activity_feed(integer,integer,text)              | public only (+ qualified auth)
-- admin_get_audit_log(integer,integer)                       | public only (+ qualified auth)
-- admin_get_dau_per_day(integer)                             | public only (+ qualified auth)
-- admin_get_email_stats()                                    | public only (+ qualified auth)
-- admin_get_promo_redemptions(text)                          | public only (+ qualified auth)
-- admin_get_recent_events(integer)                           | public only (+ qualified auth)
-- admin_get_recent_signups(integer)                          | public only (+ qualified auth)
-- admin_get_signups_per_day(integer)                         | public only (+ qualified auth)
-- admin_get_signups_with_emails(integer)                     | public only (+ qualified auth)
-- admin_get_stats()                                          | public only (+ qualified auth)
-- admin_get_tier_breakdown()                                 | public only (+ qualified auth)
-- admin_list_emails(integer,integer,text,text,text)          | public only (+ qualified auth)
-- admin_list_promo_codes(integer,integer)                    | public only (+ qualified auth)
-- admin_list_subscriptions(text,integer,integer)             | public only (+ qualified auth)
-- admin_list_users(text,text,text,integer,integer)           | public only (+ qualified auth)
-- admin_manage_promo(..., timestamptz, text) (10 args)       | public only (+ qualified auth)
-- admin_manage_promo(..., timestamptz) (9 args)              | public only (+ qualified auth)
-- admin_promote_user(uuid)                                   | public only (+ qualified auth)
-- admin_update_subscription(text,uuid,text,integer,integer)  | public only (+ qualified auth)
-- admin_update_user(text,uuid,text,text,text,boolean)        | public only (+ qualified auth)
-- get_invoice_by_id(uuid)                                    | public only (+ qualified auth)
-- get_my_profile()                                           | public only (+ qualified auth)
-- get_operators_with_last_seen()                             | public only (+ qualified auth)
-- get_server_clock()                                         | public only
-- get_user_invoices(integer,integer)                         | public only (+ qualified auth)
-- handle_first_login(uuid)                                   | public only
-- handle_new_cms_user()                                      | public only (no trigger attached)
-- is_admin()                                                 | public only (+ qualified auth)
-- log_activity(uuid,text,text,text,jsonb)                    | public only
-- log_first_login()                                          | public only (trigger on leod_users)
-- log_plan_change()                                          | public only (trigger on leod_subscriptions)
-- log_role_change()                                          | public only (trigger on leod_users)
-- log_user_signup()                                          | public only (trigger on leod_users)
-- track_user_login()                                         | public only (+ qualified auth; no trigger attached)
-- validate_event_log_role()                                  | public only (trigger on leod_event_log)
--
-- No function uses extensions unqualified; `extensions` stays on the path so
-- a future body that does keeps working.
--
-- Rollback (per function): ALTER FUNCTION public.<signature> RESET search_path;

ALTER FUNCTION public.admin_get_activity_feed(integer,integer,text) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_audit_log(integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_dau_per_day(integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_email_stats() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_promo_redemptions(text) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_recent_events(integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_recent_signups(integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_signups_per_day(integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_signups_with_emails(integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_stats() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_get_tier_breakdown() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_list_emails(integer,integer,text,text,text) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_list_promo_codes(integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_list_subscriptions(text,integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_list_users(text,text,text,integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_manage_promo(text,text,text,integer,integer,text,integer,integer,timestamp with time zone,text) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_manage_promo(text,text,text,integer,integer,text,integer,integer,timestamp with time zone) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_promote_user(uuid) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_update_subscription(text,uuid,text,integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.admin_update_user(text,uuid,text,text,text,boolean) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_invoice_by_id(uuid) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_my_profile() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_operators_with_last_seen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_server_clock() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_user_invoices(integer,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.handle_first_login(uuid) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.handle_new_cms_user() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.is_admin() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.log_activity(uuid,text,text,text,jsonb) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.log_first_login() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.log_plan_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.log_role_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.log_user_signup() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.track_user_login() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.validate_event_log_role() SET search_path = public, extensions, pg_temp;
