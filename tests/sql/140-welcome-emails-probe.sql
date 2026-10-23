DO $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'welcome-emails' AND active) THEN RAISE EXCEPTION 'PROBE FAIL 1: no cron job'; END IF;
  IF has_function_privilege('anon', 'public.welcome_emails_cron_ok(text)', 'execute')
     OR has_function_privilege('authenticated', 'public.welcome_emails_cron_ok(text)', 'execute') THEN RAISE EXCEPTION 'PROBE FAIL 2: secret check callable by clients'; END IF;
  IF welcome_emails_cron_ok('') OR welcome_emails_cron_ok(repeat('a', 64)) THEN RAISE EXCEPTION 'PROBE FAIL 3: a wrong secret passes'; END IF;
  IF NOT welcome_emails_cron_ok((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'welcome_emails_cron_secret')) THEN RAISE EXCEPTION 'PROBE FAIL 4: the real secret fails'; END IF;
  SELECT count(*) INTO n FROM welcome_email_trigger WHERE NOT processed AND triggered_at < now() - interval '7 days';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 5: % old rows still waiting', n; END IF;
  SELECT count(*) INTO n FROM welcome_email_trigger WHERE NOT processed;
  RAISE EXCEPTION 'PROBE OK 140 (% recent accounts waiting for their welcome)', n;
END $$;
