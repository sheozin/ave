-- tests/sql/109-paid-tickets-probe.sql: ticket types, orders, payouts, G16. Ends in 'PROBE OK 109'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_n    int;
  v_free uuid;
  v_paid uuid;
  v_one  uuid;
  v_ord  uuid;
  v_ok   boolean;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  DELETE FROM leod_checkin_payout_accounts WHERE user_id = v_own;
  UPDATE leod_checkin_entitlements SET status = 'test', registration_approval = false, registration_waitlist = false WHERE event_id = E;

  -- ── strangers ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_tickets_overview(E); RAISE EXCEPTION 'stranger overview'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_ticket_type_save(E, NULL, 'X', NULL, 0, 'eur', NULL, true, NULL); RAISE EXCEPTION 'stranger save'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_ticket_type_delete(E, gen_random_uuid()); RAISE EXCEPTION 'stranger delete'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_orders_list(E); RAISE EXCEPTION 'stranger orders'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- ── owner: types ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  v_free := (checkin_ticket_type_save(E, NULL, 'Community', NULL, 0, 'eur', NULL, true, NULL))->>'id';
  BEGIN PERFORM checkin_ticket_type_save(E, NULL, 'Standard', NULL, 4900, 'eur', NULL, true, NULL); RAISE EXCEPTION 'paid without payouts';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO leod_checkin_payout_accounts (user_id, stripe_account_id, charges_enabled, details_submitted)
  VALUES (v_own, 'acct_PROBE109test', true, true);
  v_paid := (checkin_ticket_type_save(E, NULL, 'Standard', 'Full access', 4900, 'EUR', NULL, true, NULL))->>'id';
  BEGIN PERFORM checkin_ticket_type_save(E, NULL, 'Dollar', NULL, 4900, 'usd', NULL, true, NULL); RAISE EXCEPTION 'mixed currency';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_ticket_type_save(E, NULL, 'Cheap', NULL, 40, 'eur', NULL, true, NULL); RAISE EXCEPTION 'below minimum';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_ticket_type_save(E, NULL, 'Bad', NULL, 500, 'xyz', NULL, true, NULL); RAISE EXCEPTION 'unknown currency';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_set_registration_flow(E, false, true); RAISE EXCEPTION 'approval with paid tickets';
  EXCEPTION WHEN check_violation THEN NULL; END;
  v_res := checkin_tickets_overview(E);
  IF jsonb_array_length(v_res->'types') <> 2 OR (v_res->'payout'->>'charges_enabled')::boolean IS NOT TRUE OR (v_res->>'is_owner')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'overview: %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── test mode: a ticket is required, a paid one is never charged ──
  IF checkin_web_request(v_code, 'No', 'Ticket', 'no.ticket@example.invalid', NULL, '{}', repeat('a', 64))->>'status' <> 'bad_ticket' THEN RAISE EXCEPTION 'ticket not required'; END IF;
  IF checkin_web_request(v_code, 'Other', 'Event', 'other.event@example.invalid', NULL, '{}', repeat('a', 64), gen_random_uuid())->>'status' <> 'bad_ticket' THEN RAISE EXCEPTION 'foreign ticket accepted'; END IF;
  v_res := checkin_web_request(v_code, 'Test', 'Paid', 'test.paid@example.invalid', NULL, '{}', repeat('a', 64), v_paid);
  IF v_res->>'status' <> 'registered' THEN RAISE EXCEPTION 'test paid: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND is_test AND ticket_type_id = v_paid AND ticket_type = 'Standard') THEN RAISE EXCEPTION 'test ticket not recorded'; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE event_id = E) THEN RAISE EXCEPTION 'test mode made an order'; END IF;

  -- ── live ──
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  DELETE FROM leod_checkin_web_pending WHERE event_id = E;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n + 1, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE leod_checkin_ticket_fee SET fee_bps = 250 WHERE id;

  v_res := checkin_web_request(v_code, 'Pay', 'Er', 'pay.er@example.invalid', NULL, '{}', repeat('b', 64), v_paid);
  IF v_res->>'status' <> 'pending' OR v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'live paid request: %', v_res; END IF;
  v_res := checkin_web_confirm(v_code, repeat('b', 64));
  IF v_res->>'status' <> 'payment_required' THEN RAISE EXCEPTION 'confirm paid: %', v_res; END IF;
  v_ord := v_res->>'order_id';
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE id = v_ord AND status = 'open' AND amount_cents = 4900
                   AND fee_cents = 122 AND currency = 'eur' AND stripe_account_id = 'acct_PROBE109test') THEN
    RAISE EXCEPTION 'order row: %', (SELECT to_jsonb(o) FROM leod_checkin_web_orders o WHERE id = v_ord);
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'pay.er@example.invalid') THEN RAISE EXCEPTION 'listed before paying'; END IF;
  -- The same link again finds the order.
  v_res := checkin_web_confirm(v_code, repeat('b', 64));
  IF v_res->>'status' <> 'order' OR (v_res->>'order_id')::uuid <> v_ord THEN RAISE EXCEPTION 'link after order: %', v_res; END IF;
  v_res := checkin_web_pending_preview(v_code, repeat('b', 64));
  IF v_res->>'status' <> 'order' OR v_res->>'order_status' <> 'open' OR (v_res->'ticket'->>'price_cents')::int <> 4900 THEN RAISE EXCEPTION 'order preview: %', v_res; END IF;
  -- The open order holds the last place.
  IF checkin_web_request(v_code, 'Late', 'Comer', 'late.comer@example.invalid', NULL, '{}', repeat('c', 64), v_paid)->>'status' <> 'full' THEN RAISE EXCEPTION 'open order did not hold the place'; END IF;
  IF checkin_web_request(v_code, 'Late', 'Free', 'late.free@example.invalid', NULL, '{}', repeat('c', 64), v_free)->>'status' <> 'full' THEN RAISE EXCEPTION 'open order did not hold the place (free)'; END IF;

  -- Paid: listed with the ticket, idempotently.
  v_res := checkin_web_order_paid(v_ord, 'pi_probe');
  IF v_res->>'status' <> 'paid' OR (v_res->>'first')::boolean IS NOT TRUE OR v_res->'attendee'->>'qr_token' IS NULL THEN RAISE EXCEPTION 'paid: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'pay.er@example.invalid' AND ticket_type_id = v_paid AND NOT is_test) THEN RAISE EXCEPTION 'paid guest missing'; END IF;
  v_res := checkin_web_order_paid(v_ord, 'pi_probe');
  IF v_res->>'status' <> 'paid' OR (v_res->>'first')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'paid twice: %', v_res; END IF;
  IF checkin_web_order_reopen(v_ord) <> 'paid' THEN RAISE EXCEPTION 'reopen of paid'; END IF;
  -- A sold ticket keeps its price.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_ticket_type_save(E, v_paid, 'Standard', NULL, 5900, 'eur', NULL, true, NULL); RAISE EXCEPTION 'repriced a sold ticket';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF checkin_ticket_type_delete(E, v_paid) <> 'hidden' THEN RAISE EXCEPTION 'sold type deleted'; END IF;
  PERFORM checkin_ticket_type_save(E, v_paid, 'Standard', NULL, 4900, 'eur', NULL, true, NULL);
  IF jsonb_array_length(checkin_orders_list(E)) < 1 THEN RAISE EXCEPTION 'orders list'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- Refund: the guest leaves the list.
  v_res := checkin_web_order_refunded(v_ord);
  IF v_res->>'status' <> 'refunded' OR (v_res->>'removed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'refund: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'pay.er@example.invalid') THEN RAISE EXCEPTION 'refunded guest still listed'; END IF;
  IF checkin_web_order_paid(v_ord, 'pi_probe')->>'status' <> 'refunded' THEN RAISE EXCEPTION 'refunded order paid again'; END IF;

  -- Expiry frees the place; reopen holds it again.
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  IF checkin_web_request(v_code, 'Slow', 'Payer', 'slow.payer@example.invalid', NULL, '{}', repeat('d', 64), v_paid)->>'send' <> 'true' THEN RAISE EXCEPTION 'slow request'; END IF;
  v_ord := checkin_web_confirm(v_code, repeat('d', 64))->>'order_id';
  UPDATE leod_checkin_web_orders SET expires_at = now() - interval '1 minute' WHERE id = v_ord;
  IF NOT EXISTS (SELECT 1 FROM checkin_web_orders_due() WHERE id = v_ord) THEN RAISE EXCEPTION 'expired order not due'; END IF;
  -- G16 sees an order the sweep left behind.
  UPDATE leod_checkin_web_orders SET expires_at = now() - interval '1 hour' WHERE id = v_ord;
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_orders_settled') THEN RAISE EXCEPTION 'G16 missed a stuck order'; END IF;
  IF checkin_web_order_expire(v_ord) <> 'expired' THEN RAISE EXCEPTION 'expire'; END IF;
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_orders_settled') THEN RAISE EXCEPTION 'G16 after expiry'; END IF;
  IF checkin_web_order_reopen(v_ord) <> 'open' THEN RAISE EXCEPTION 'reopen'; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE id = v_ord AND status = 'open' AND expires_at > now() + interval '30 minutes' AND checkout_session_id IS NULL) THEN RAISE EXCEPTION 'reopened row'; END IF;

  -- At most 3 holds per order.
  UPDATE leod_checkin_web_orders SET expires_at = now() - interval '1 minute' WHERE id = v_ord;
  IF checkin_web_order_reopen(v_ord) <> 'open' THEN RAISE EXCEPTION 'second reopen'; END IF;
  UPDATE leod_checkin_web_orders SET expires_at = now() - interval '1 minute' WHERE id = v_ord;
  IF checkin_web_order_reopen(v_ord) <> 'hold_limit' THEN RAISE EXCEPTION 'hold limit: %', (SELECT holds FROM leod_checkin_web_orders WHERE id = v_ord); END IF;

  -- Payouts off: the link waits instead of failing.
  UPDATE leod_checkin_web_orders SET status = 'expired' WHERE id = v_ord;
  UPDATE leod_checkin_payout_accounts SET charges_enabled = false WHERE user_id = v_own;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Wait', 'Ing', 'wait.ing@example.invalid', NULL, '{}', repeat('e', 64), v_paid);
  IF checkin_web_confirm(v_code, repeat('e', 64))->>'status' <> 'payments_unavailable' THEN RAISE EXCEPTION 'payouts off'; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_pending WHERE event_id = E AND lower(email) = 'wait.ing@example.invalid') THEN RAISE EXCEPTION 'pending dropped'; END IF;
  UPDATE leod_checkin_payout_accounts SET charges_enabled = true WHERE user_id = v_own;

  -- A request from before the event sold tickets cannot confirm into a free place.
  INSERT INTO leod_checkin_web_pending (event_id, first_name, last_name, email, token_hash)
  VALUES (E, 'Early', 'Bird', 'early.bird@example.invalid', repeat('7', 64));
  IF checkin_web_confirm(v_code, repeat('7', 64))->>'status' <> 'bad_ticket' THEN RAISE EXCEPTION 'untyped pending got a ticket'; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'early.bird@example.invalid') THEN RAISE EXCEPTION 'early bird listed'; END IF;

  -- A limited type sells out for every address.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, NULL, NULL, '[]');
  v_one := (checkin_ticket_type_save(E, NULL, 'Workshop', NULL, 0, 'eur', 1, true, NULL))->>'id';
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Work', 'Shop', 'work.shop@example.invalid', NULL, '{}', repeat('f', 64), v_one);
  v_res := checkin_web_confirm(v_code, repeat('f', 64));
  IF v_res->>'status' <> 'registered' THEN RAISE EXCEPTION 'free limited: %', v_res; END IF;
  IF checkin_web_request(v_code, 'Too', 'Late', 'too.late@example.invalid', NULL, '{}', repeat('9', 64), v_one)->>'status' <> 'sold_out' THEN RAISE EXCEPTION 'not sold out'; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'work.shop@example.invalid' AND ticket_type = 'Workshop') THEN RAISE EXCEPTION 'free ticket name'; END IF;

  SELECT bool_and(ok) INTO v_ok FROM checkin_guard_results()
   WHERE guard IN ('checkin_rpcs_refuse_strangers', 'checkin_web_paths_private', 'admin_rpcs_not_anon', 'public_tables_rls_on',
                   'checkin_tables_not_anon_writable', 'security_definer_search_path');
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok AND guard <> 'live_events_have_purchase'); END IF;
  RAISE EXCEPTION 'PROBE OK 109';
END;
$probe$;
