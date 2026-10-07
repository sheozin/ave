-- 109_checkin_paid_tickets.sql
-- Paid tickets on the registration page, through Stripe Connect.
--
-- The event owner connects their own Stripe account (Standard). A guest who
-- picks a paid ticket confirms their email as before (101), and is then sent
-- to Stripe Checkout, charged directly on the owner's account. CueDeck's
-- platform fee (leod_checkin_ticket_fee, 0 by default) is taken as the
-- application fee. Refunds and disputes belong to the owner's account.
--
--   ticket types   leod_checkin_ticket_types, per event, price 0 = free
--   payout account leod_checkin_payout_accounts, per owner (leod_events.created_by)
--   orders         leod_checkin_web_orders: a confirmed guest who has not paid
--                  yet holds a place until the order expires (35 minutes)
--
-- There is no Stripe webhook. checkin-register confirms the payment by
-- asking Stripe when the guest returns, and checkin-orders-sweep (cron,
-- every 5 minutes) settles the orders of guests who closed the tab.
-- Guard G16 reports an open order the sweep should have settled.
--
-- Paid tickets and approval do not mix (approve, then pay, is a separate
-- flow), and a paid ticket is never waitlisted: when the event is full it
-- is sold out. Test mode never charges: a paid ticket registers as a test
-- guest like a free one.

-- ── Tables ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leod_checkin_ticket_fee (
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  fee_bps int     NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1500),
  note    text
);
INSERT INTO leod_checkin_ticket_fee (id, fee_bps, note)
VALUES (true, 0, 'CueDeck platform fee on paid tickets, in basis points (100 = 1%). Applies to orders created after a change.')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE leod_checkin_ticket_fee ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_ticket_fee FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_payout_accounts (
  user_id           uuid        PRIMARY KEY,
  stripe_account_id text        NOT NULL UNIQUE CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]{6,64}$'),
  charges_enabled   boolean     NOT NULL DEFAULT false,
  details_submitted boolean     NOT NULL DEFAULT false,
  default_currency  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE leod_checkin_payout_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_payout_accounts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_ticket_types (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description text        CHECK (description IS NULL OR char_length(description) <= 200),
  price_cents int         NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 10000000),
  currency    text        NOT NULL DEFAULT 'eur',
  quantity    int         CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 100000),
  sort        int         NOT NULL DEFAULT 0,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_ticket_types_event ON leod_checkin_ticket_types (event_id, sort, created_at);
ALTER TABLE leod_checkin_ticket_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_ticket_types FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_web_orders (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  ticket_type_id      uuid        REFERENCES leod_checkin_ticket_types(id) ON DELETE SET NULL,
  ticket_name         text        NOT NULL,
  token_hashes        text[]      NOT NULL,
  first_name          text        NOT NULL,
  last_name           text        NOT NULL,
  email               text        NOT NULL,
  company             text,
  answers             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  amount_cents        int         NOT NULL CHECK (amount_cents > 0),
  currency            text        NOT NULL,
  fee_cents           int         NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  stripe_account_id   text        NOT NULL,
  checkout_session_id text,
  payment_intent      text,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'expired', 'paid', 'refunded')),
  attendee_id         uuid,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  refunded_at         timestamptz,
  -- Sweep fairness: the least recently checked orders go first, so one
  -- account Stripe will not answer for cannot starve the rest.
  last_checked_at     timestamptz,
  -- How many times this order has held a place; capped so an unpaid guest
  -- cannot keep a place by reopening their link forever.
  holds               int         NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_web_orders_open_email
  ON leod_checkin_web_orders (event_id, lower(email)) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_checkin_web_orders_event ON leod_checkin_web_orders (event_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkin_web_orders_tokens ON leod_checkin_web_orders USING gin (token_hashes);
ALTER TABLE leod_checkin_web_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_web_orders FROM anon, authenticated;

ALTER TABLE leod_checkin_attendees ADD COLUMN IF NOT EXISTS ticket_type_id uuid
  REFERENCES leod_checkin_ticket_types(id) ON DELETE SET NULL;
ALTER TABLE leod_checkin_web_pending ADD COLUMN IF NOT EXISTS ticket_type_id uuid;
ALTER TABLE leod_checkin_held ADD COLUMN IF NOT EXISTS ticket_type_id uuid;

-- The lowest price Stripe accepts in each offered currency, in minor units.
CREATE OR REPLACE FUNCTION checkin_ticket_min_cents(p_currency text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_currency
    WHEN 'eur' THEN 100 WHEN 'usd' THEN 100 WHEN 'gbp' THEN 100 WHEN 'chf' THEN 100
    WHEN 'cad' THEN 100 WHEN 'aud' THEN 100 WHEN 'pln' THEN 200 WHEN 'aed' THEN 200
    WHEN 'dkk' THEN 250 WHEN 'sek' THEN 300 WHEN 'nok' THEN 300 WHEN 'czk' THEN 1500
  END;
$$;

-- Places in use: guests on the list plus unexpired orders awaiting payment.
CREATE OR REPLACE FUNCTION checkin_web_places_taken(p_event_id uuid, p_test boolean)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT count(*) FROM leod_checkin_attendees WHERE event_id = p_event_id AND is_test = p_test)::int
       + CASE WHEN p_test THEN 0 ELSE
           (SELECT count(*) FROM leod_checkin_web_orders
             WHERE event_id = p_event_id AND status = 'open' AND expires_at > now())::int END;
$$;
REVOKE ALL ON FUNCTION checkin_web_places_taken(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_places_taken(uuid, boolean) TO service_role;

-- Tickets of one type in use, the same way. NULL when the type is unlimited.
CREATE OR REPLACE FUNCTION checkin_web_ticket_left(p_type_id uuid, p_test boolean)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN t.quantity IS NULL THEN NULL ELSE GREATEST(0, t.quantity
           - (SELECT count(*) FROM leod_checkin_attendees a WHERE a.ticket_type_id = t.id AND a.is_test = p_test)::int
           - CASE WHEN p_test THEN 0 ELSE
               (SELECT count(*) FROM leod_checkin_web_orders o
                 WHERE o.ticket_type_id = t.id AND o.status = 'open' AND o.expires_at > now())::int END) END
    FROM leod_checkin_ticket_types t WHERE t.id = p_type_id;
$$;
REVOKE ALL ON FUNCTION checkin_web_ticket_left(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_ticket_left(uuid, boolean) TO service_role;

-- ── Organizer: overview of tickets, payouts and the fee ────────────
CREATE OR REPLACE FUNCTION checkin_tickets_overview(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_acct  leod_checkin_payout_accounts;
  v_test  boolean;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see tickets' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT created_by INTO v_owner FROM leod_events WHERE id = p_event_id;
  SELECT * INTO v_acct FROM leod_checkin_payout_accounts WHERE user_id = v_owner;
  SELECT status IS DISTINCT FROM 'live' INTO v_test FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  v_test := COALESCE(v_test, true);
  RETURN jsonb_build_object(
    'is_owner', checkin_is_owner(p_event_id),
    'fee_bps', (SELECT fee_bps FROM leod_checkin_ticket_fee WHERE id),
    'payout', jsonb_build_object('connected', v_acct.user_id IS NOT NULL, 'charges_enabled', COALESCE(v_acct.charges_enabled, false),
                                 'details_submitted', COALESCE(v_acct.details_submitted, false)),
    'types', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', t.id, 'name', t.name, 'description', t.description, 'price_cents', t.price_cents,
                'currency', t.currency, 'quantity', t.quantity, 'sort', t.sort, 'active', t.active,
                'sold', (SELECT count(*) FROM leod_checkin_attendees a WHERE a.ticket_type_id = t.id AND a.is_test = v_test),
                'pending', (SELECT count(*) FROM leod_checkin_web_orders o WHERE o.ticket_type_id = t.id AND o.status = 'open' AND o.expires_at > now()))
                ORDER BY t.sort, t.created_at), '[]'::jsonb)
                FROM leod_checkin_ticket_types t WHERE t.event_id = p_event_id),
    'revenue', (SELECT COALESCE(jsonb_object_agg(currency, cents), '{}'::jsonb) FROM (
                  SELECT currency, sum(amount_cents) AS cents FROM leod_checkin_web_orders
                   WHERE event_id = p_event_id AND status = 'paid' GROUP BY currency) r));
END;
$$;
REVOKE ALL ON FUNCTION checkin_tickets_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_tickets_overview(uuid) TO authenticated;

-- ── Organizer: add or change a ticket type ────────────────────────
CREATE OR REPLACE FUNCTION checkin_ticket_type_save(
  p_event_id uuid, p_id uuid, p_name text, p_description text, p_price_cents int,
  p_currency text, p_quantity int, p_active boolean, p_sort int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur   text := lower(btrim(COALESCE(p_currency, 'eur')));
  v_price int  := COALESCE(p_price_cents, 0);
  v_owner uuid;
  v_row   leod_checkin_ticket_types;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change tickets' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = p_event_id) THEN
    RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002';
  END IF;
  IF char_length(btrim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Give the ticket a name of up to 60 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF checkin_ticket_min_cents(v_cur) IS NULL THEN
    RAISE EXCEPTION 'That currency is not offered' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = p_event_id AND currency <> v_cur
              AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'All tickets of an event use one currency' USING ERRCODE = 'check_violation';
  END IF;
  IF v_price < 0 OR v_price > 10000000 OR (v_price > 0 AND v_price < checkin_ticket_min_cents(v_cur)) THEN
    RAISE EXCEPTION 'That price is below what card payments allow in this currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_quantity IS NOT NULL AND p_quantity NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 100000, or empty for no limit' USING ERRCODE = 'check_violation';
  END IF;
  IF v_price > 0 THEN
    SELECT created_by INTO v_owner FROM leod_events WHERE id = p_event_id;
    IF NOT EXISTS (SELECT 1 FROM leod_checkin_payout_accounts WHERE user_id = v_owner AND charges_enabled) THEN
      RAISE EXCEPTION 'Connect a Stripe account for payouts before selling paid tickets' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = p_event_id AND registration_approval) THEN
      RAISE EXCEPTION 'Paid tickets cannot be combined with approving each registration. Turn approval off first.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO leod_checkin_ticket_types (event_id, name, description, price_cents, currency, quantity, active, sort)
    VALUES (p_event_id, btrim(p_name), NULLIF(btrim(COALESCE(p_description, '')), ''), v_price, v_cur, p_quantity,
            COALESCE(p_active, true), COALESCE(p_sort, (SELECT COALESCE(max(sort), 0) + 1 FROM leod_checkin_ticket_types WHERE event_id = p_event_id)))
    RETURNING * INTO v_row;
  ELSE
    -- The price of a type someone has already bought stays as it is: a
    -- different price is a new ticket type.
    IF EXISTS (SELECT 1 FROM leod_checkin_ticket_types t WHERE t.id = p_id AND (t.price_cents <> v_price OR t.currency <> v_cur))
       AND (EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE ticket_type_id = p_id AND status IN ('open', 'paid'))
            OR EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE ticket_type_id = p_id AND NOT is_test)) THEN
      RAISE EXCEPTION 'This ticket has been sold, so its price is fixed. Add a new ticket type for a new price.' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE leod_checkin_ticket_types
       SET name = btrim(p_name), description = NULLIF(btrim(COALESCE(p_description, '')), ''), price_cents = v_price,
           currency = v_cur, quantity = p_quantity, active = COALESCE(p_active, active), sort = COALESCE(p_sort, sort)
     WHERE id = p_id AND event_id = p_event_id
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Ticket type not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;
REVOKE ALL ON FUNCTION checkin_ticket_type_save(uuid, uuid, text, text, int, text, int, boolean, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_ticket_type_save(uuid, uuid, text, text, int, text, int, boolean, int) TO authenticated;

-- ── Organizer: remove a ticket type (hidden instead, once used) ────
CREATE OR REPLACE FUNCTION checkin_ticket_type_delete(p_event_id uuid, p_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change tickets' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE ticket_type_id = p_id AND NOT is_test)
     OR EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE ticket_type_id = p_id) THEN
    UPDATE leod_checkin_ticket_types SET active = false WHERE id = p_id AND event_id = p_event_id;
    RETURN CASE WHEN FOUND THEN 'hidden' ELSE 'not_found' END;
  END IF;
  DELETE FROM leod_checkin_ticket_types WHERE id = p_id AND event_id = p_event_id;
  RETURN CASE WHEN FOUND THEN 'deleted' ELSE 'not_found' END;
END;
$$;
REVOKE ALL ON FUNCTION checkin_ticket_type_delete(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_ticket_type_delete(uuid, uuid) TO authenticated;

-- ── Organizer: orders ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_orders_list(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see orders' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', o.id, 'first_name', o.first_name, 'last_name', o.last_name, 'email', o.email,
            'ticket_name', o.ticket_name, 'amount_cents', o.amount_cents, 'currency', o.currency,
            'fee_cents', o.fee_cents, 'status', o.status, 'created_at', o.created_at, 'paid_at', o.paid_at,
            'refunded_at', o.refunded_at) ORDER BY o.created_at DESC), '[]'::jsonb)
            FROM (SELECT * FROM leod_checkin_web_orders
                   WHERE event_id = p_event_id AND status <> 'expired'
                   ORDER BY created_at DESC LIMIT 500) o);
END;
$$;
REVOKE ALL ON FUNCTION checkin_orders_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_orders_list(uuid) TO authenticated;

-- ── Approval refuses paid tickets (the other half of the rule) ─────
CREATE OR REPLACE FUNCTION checkin_set_registration_flow(p_event_id uuid, p_waitlist boolean, p_approval boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row leod_checkin_entitlements;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(p_approval, false)
     AND EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = p_event_id AND active AND price_cents > 0) THEN
    RAISE EXCEPTION 'Approval cannot be combined with paid tickets. Hide the paid tickets first.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements
     SET registration_waitlist = COALESCE(p_waitlist, false), registration_approval = COALESCE(p_approval, false)
   WHERE event_id = p_event_id RETURNING * INTO v_row;
  IF v_row.event_id IS NULL THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('waitlist', v_row.registration_waitlist, 'approval', v_row.registration_approval);
END;
$$;

-- ── Submit, now with a ticket ─────────────────────────────────────
-- 108's body, plus: when the event has active ticket types the guest must
-- pick one; a sold-out type answers 'sold_out' for every address; capacity
-- counts orders awaiting payment; a paid ticket is never held.
DROP FUNCTION IF EXISTS checkin_web_request(text, text, text, text, text, jsonb, text);
CREATE OR REPLACE FUNCTION checkin_web_request(
  p_code text, p_first_name text, p_last_name text, p_email text, p_company text, p_answers jsonb, p_token_hash text,
  p_ticket_type_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_test_cap    CONSTANT int      := 25;
  c_resend_gap  CONSTANT interval := interval '10 minutes';
  c_mail_window CONSTANT interval := interval '24 hours';
  c_mail_event  CONSTANT int      := 3;
  c_mail_global CONSTANT int      := 10;
  c_event_hour  CONSTANT int      := 150;
  v_ent  leod_checkin_entitlements;
  v_ev   leod_events;
  v_test boolean;
  v_n    int;
  v_row  leod_checkin_attendees;
  v_pend leod_checkin_web_pending;
  v_key  text := checkin_web_email_key(p_email);
  v_full boolean;
  v_kind text;
  v_type leod_checkin_ticket_types;
  v_paid boolean := false;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF (v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at)
     OR (v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL
         AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone)) THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;

  v_test := v_ent.status IS DISTINCT FROM 'live';

  -- (109) The ticket. Without active types the page has no picker and the
  -- registration is free, as before.
  IF EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = v_ent.event_id AND active) THEN
    SELECT * INTO v_type FROM leod_checkin_ticket_types
     WHERE id = p_ticket_type_id AND event_id = v_ent.event_id AND active;
    IF v_type.id IS NULL THEN RETURN jsonb_build_object('status', 'bad_ticket'); END IF;
    IF checkin_web_ticket_left(v_type.id, v_test) = 0 THEN RETURN jsonb_build_object('status', 'sold_out'); END IF;
    v_paid := v_type.price_cents > 0;
  END IF;

  IF v_test THEN
    SELECT count(*) INTO v_n FROM leod_checkin_attendees
     WHERE event_id = v_ent.event_id AND is_test AND source = 'web';
    IF v_n >= c_test_cap THEN RETURN jsonb_build_object('status', 'test_cap'); END IF;
    -- Capacity before the duplicate check, so 'full' is the same for every address (F4).
    v_full := false;
    IF v_ent.registration_capacity IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND is_test;
      v_full := v_n >= v_ent.registration_capacity;
      IF v_full AND (NOT v_ent.registration_waitlist OR v_paid) THEN RETURN jsonb_build_object('status', 'full'); END IF;
    END IF;
    -- (108) Full with a waitlist, or approval required: the guest is held,
    -- and a listed or already held address gets the same answer (F4 again).
    IF NOT v_paid AND (v_full OR v_ent.registration_approval) THEN
      v_kind := CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END;
      IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email)))
         AND NOT EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
        INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at, ticket_type_id)
        VALUES (v_ent.event_id, v_kind, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
                COALESCE(p_answers, '{}'::jsonb), true, now(), v_type.id)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN jsonb_build_object('status', CASE WHEN v_kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END, 'test', true);
    END IF;
    IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END IF;
    BEGIN
      INSERT INTO leod_checkin_attendees
        (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
      VALUES
        (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
         replace(gen_random_uuid()::text, '-', ''), 'web', true, now(), COALESCE(p_answers, '{}'::jsonb), v_type.id, COALESCE(v_type.name, 'attendee'))
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END;
    RETURN jsonb_build_object('status', 'registered', 'test', true);
  END IF;

  -- (108) With a waitlist a full event still takes requests: the guest is
  -- waitlisted when they confirm. (109) Not for a paid ticket.
  IF v_ent.registration_capacity IS NOT NULL AND (NOT v_ent.registration_waitlist OR v_paid) THEN
    IF checkin_web_places_taken(v_ent.event_id, false) >= v_ent.registration_capacity THEN
      RETURN jsonb_build_object('status', 'full');
    END IF;
  END IF;

  SELECT * INTO v_pend FROM leod_checkin_web_pending
   WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email));
  IF FOUND AND v_pend.last_sent_at > now() - c_resend_gap THEN
    RETURN jsonb_build_object('status', 'pending', 'send', false);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_mail:' || v_key, 0));
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail
   WHERE email_key = v_key AND event_id = v_ent.event_id AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_event THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE email_key = v_key AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_global THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE event_id = v_ent.event_id AND sent_at > now() - interval '1 hour';
  IF v_n >= c_event_hour THEN
    INSERT INTO leod_checkin_web_trips (event_id) VALUES (v_ent.event_id);
    RETURN jsonb_build_object('status', 'pending', 'send', false);
  END IF;

  IF v_pend.id IS NOT NULL THEN
    UPDATE leod_checkin_web_pending
       SET prev_token_hash = token_hash, token_hash = p_token_hash, last_sent_at = now()
     WHERE id = v_pend.id;
  ELSE
    INSERT INTO leod_checkin_web_pending (event_id, first_name, last_name, email, company, answers, token_hash, ticket_type_id)
    VALUES (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
            COALESCE(p_answers, '{}'::jsonb), p_token_hash, v_type.id);
  END IF;
  INSERT INTO leod_checkin_web_mail (email_key, event_id) VALUES (v_key, v_ent.event_id);
  RETURN jsonb_build_object('status', 'pending', 'send', true, 'event_id', v_ent.event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text, uuid) TO service_role;

-- ── Confirm, now with payment ─────────────────────────────────────
-- A paid ticket becomes an order instead of a guest:
--   { status: 'payment_required', order_id }   checkin-register opens Checkout
-- A link whose request already became an order answers
--   { status: 'order', order_id }              checkin-register settles it
CREATE OR REPLACE FUNCTION checkin_web_confirm(p_code text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent   leod_checkin_entitlements;
  v_ev    leod_events;
  v_pend  leod_checkin_web_pending;
  v_row   leod_checkin_attendees;
  v_n     int;
  v_full  boolean;
  v_held  leod_checkin_held;
  v_type  leod_checkin_ticket_types;
  v_acct  text;
  v_order leod_checkin_web_orders;
  v_fee   int;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_pend FROM checkin_web_pending_by_token(p_code, p_token_hash);
  IF v_pend.id IS NULL THEN
    -- (109) The link of a request that is already an order.
    SELECT * INTO v_order FROM leod_checkin_web_orders
     WHERE event_id = v_ent.event_id AND p_token_hash = ANY (token_hashes)
     ORDER BY created_at DESC LIMIT 1;
    IF v_order.id IS NOT NULL THEN RETURN jsonb_build_object('status', 'order', 'order_id', v_order.id); END IF;
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF (v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at)
     OR (v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL
         AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone)) THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'closed');
  END IF;

  SELECT * INTO v_row FROM leod_checkin_attendees
   WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email);
  IF FOUND THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'already', 'first_name', v_row.first_name,
      'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                     'qr_token', v_row.qr_token, 'qr_email_sent_at', v_row.qr_email_sent_at));
  END IF;

  SELECT * INTO v_held FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email);
  IF v_held.id IS NOT NULL THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', CASE WHEN v_held.kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END,
                              'first_name', v_held.first_name);
  END IF;

  -- (109) A request made before the event sold tickets: tickets now exist,
  -- so it must go through the form again and pick one.
  IF v_pend.ticket_type_id IS NULL
     AND EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = v_ent.event_id AND active) THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'bad_ticket');
  END IF;
  -- (109) The ticket picked at submit time. A type hidden or removed since
  -- is refused, so nobody is charged for, or given, a ticket no longer sold.
  IF v_pend.ticket_type_id IS NOT NULL THEN
    SELECT * INTO v_type FROM leod_checkin_ticket_types
     WHERE id = v_pend.ticket_type_id AND event_id = v_ent.event_id AND active;
    IF v_type.id IS NULL THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'bad_ticket');
    END IF;
    IF checkin_web_ticket_left(v_type.id, false) = 0 THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'sold_out');
    END IF;
  END IF;

  IF v_type.price_cents > 0 THEN
    IF v_ent.registration_capacity IS NOT NULL
       AND checkin_web_places_taken(v_ent.event_id, false) >= v_ent.registration_capacity THEN
      -- An order of this same address already holds a place: reuse it below.
      IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE event_id = v_ent.event_id
                      AND lower(email) = lower(v_pend.email) AND status = 'open' AND expires_at > now()) THEN
        DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
        RETURN jsonb_build_object('status', 'full');
      END IF;
    END IF;
    SELECT stripe_account_id INTO v_acct FROM leod_checkin_payout_accounts
     WHERE user_id = v_ev.created_by AND charges_enabled;
    -- The pending row stays, so the same link works once payouts are back.
    IF v_acct IS NULL THEN RETURN jsonb_build_object('status', 'payments_unavailable'); END IF;

    SELECT * INTO v_order FROM leod_checkin_web_orders
     WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email) AND status = 'open';
    IF v_order.id IS NOT NULL THEN
      -- One open order per address: this link joins it.
      UPDATE leod_checkin_web_orders
         SET token_hashes = (SELECT array_agg(DISTINCT h) FROM unnest(token_hashes || ARRAY[v_pend.token_hash, p_token_hash]) h)
       WHERE id = v_order.id;
    ELSE
      SELECT (v_type.price_cents::bigint * fee_bps / 10000)::int INTO v_fee FROM leod_checkin_ticket_fee WHERE id;
      INSERT INTO leod_checkin_web_orders
        (event_id, ticket_type_id, ticket_name, token_hashes, first_name, last_name, email, company, answers,
         amount_cents, currency, fee_cents, stripe_account_id, expires_at)
      VALUES
        (v_ent.event_id, v_type.id, v_type.name,
         ARRAY(SELECT DISTINCT h FROM unnest(ARRAY[v_pend.token_hash, v_pend.prev_token_hash, p_token_hash]) h WHERE h IS NOT NULL),
         v_pend.first_name, v_pend.last_name, v_pend.email, v_pend.company, v_pend.answers,
         v_type.price_cents, v_type.currency, COALESCE(v_fee, 0), v_acct, now() + interval '35 minutes')
      RETURNING * INTO v_order;
    END IF;
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'payment_required', 'order_id', v_order.id, 'first_name', v_pend.first_name);
  END IF;

  v_full := false;
  IF v_ent.registration_capacity IS NOT NULL THEN
    v_full := checkin_web_places_taken(v_ent.event_id, false) >= v_ent.registration_capacity;
    IF v_full AND NOT v_ent.registration_waitlist THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'full');
    END IF;
  END IF;

  IF v_full OR v_ent.registration_approval THEN
    INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at, ticket_type_id)
    VALUES (v_ent.event_id, CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END, v_pend.first_name, v_pend.last_name,
            v_pend.email, v_pend.company, v_pend.answers, false, now(), v_type.id)
    ON CONFLICT DO NOTHING;
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    IF v_full THEN
      SELECT count(*) INTO v_n FROM leod_checkin_held WHERE event_id = v_ent.event_id AND kind = 'waitlist' AND NOT is_test;
      RETURN jsonb_build_object('status', 'waitlisted', 'first_name', v_pend.first_name, 'position', v_n);
    END IF;
    RETURN jsonb_build_object('status', 'awaiting_approval', 'first_name', v_pend.first_name);
  END IF;

  BEGIN
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
    VALUES
      (v_ent.event_id, v_pend.first_name, v_pend.last_name, v_pend.email, v_pend.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', false, now(), v_pend.answers, v_type.id, COALESCE(v_type.name, 'attendee'))
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'already', 'first_name', v_pend.first_name, 'attendee', NULL);
  END;
  DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
  RETURN jsonb_build_object('status', 'registered', 'first_name', v_row.first_name,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_confirm(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_confirm(text, text) TO service_role;

-- The emailed link of a request that became an order (paid ticket) is the
-- way back to the payment, so the page shows what it is for instead of
-- "expired".
CREATE OR REPLACE FUNCTION checkin_web_pending_preview(p_code text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_p leod_checkin_web_pending;
  v_o leod_checkin_web_orders;
BEGIN
  SELECT * INTO v_p FROM checkin_web_pending_by_token(p_code, p_token_hash);
  IF v_p.id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'first_name', v_p.first_name, 'last_name', v_p.last_name, 'company', v_p.company,
      'ticket', (SELECT jsonb_build_object('name', t.name, 'price_cents', t.price_cents, 'currency', t.currency)
                   FROM leod_checkin_ticket_types t WHERE t.id = v_p.ticket_type_id));
  END IF;
  SELECT o.* INTO v_o FROM leod_checkin_web_orders o
    JOIN leod_checkin_entitlements e ON e.event_id = o.event_id
   WHERE e.registration_code = p_code AND e.registration_enabled AND e.checkin_core AND p_token_hash = ANY (o.token_hashes)
   ORDER BY o.created_at DESC LIMIT 1;
  IF v_o.id IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  RETURN jsonb_build_object('status', 'order', 'order_status', v_o.status, 'first_name', v_o.first_name, 'last_name', v_o.last_name,
    'company', v_o.company, 'ticket', jsonb_build_object('name', v_o.ticket_name, 'price_cents', v_o.amount_cents, 'currency', v_o.currency));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_pending_preview(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_pending_preview(text, text) TO service_role;

-- A released held guest keeps the (free) ticket type they picked.
CREATE OR REPLACE FUNCTION checkin_web_release_held(p_event_id uuid, p_held_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h    leod_checkin_held;
  v_row  leod_checkin_attendees;
  v_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || p_event_id::text, 0));
  DELETE FROM leod_checkin_held WHERE id = p_held_id AND event_id = p_event_id RETURNING * INTO v_h;
  IF v_h.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT name INTO v_name FROM leod_checkin_ticket_types WHERE id = v_h.ticket_type_id;
  BEGIN
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
    VALUES
      (p_event_id, v_h.first_name, v_h.last_name, v_h.email, v_h.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', v_h.is_test, v_h.consent_at, v_h.answers,
       CASE WHEN v_name IS NULL THEN NULL ELSE v_h.ticket_type_id END, COALESCE(v_name, 'attendee'))
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already');
  END;
  RETURN jsonb_build_object('status', 'released', 'kind', v_h.kind, 'is_test', v_row.is_test,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_release_held(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_release_held(uuid, uuid) TO service_role;

-- ── Service: settle an order ──────────────────────────────────────
-- Paid: the guest joins the list whatever the capacity now says (they paid
-- while their place was held, or Stripe let them pay late). Idempotent:
-- the return path and the sweep may both arrive. 'first' is true only for
-- the call that marked the order paid, so exactly one of them sends the
-- QR email.
CREATE OR REPLACE FUNCTION checkin_web_order_paid(p_order_id uuid, p_payment_intent text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o   leod_checkin_web_orders;
  v_row   leod_checkin_attendees;
  v_first boolean := false;
BEGIN
  SELECT * INTO v_o FROM leod_checkin_web_orders WHERE id = p_order_id;
  IF v_o.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_o.event_id::text, 0));
  SELECT * INTO v_o FROM leod_checkin_web_orders WHERE id = p_order_id FOR UPDATE;
  IF v_o.status = 'refunded' THEN RETURN jsonb_build_object('status', 'refunded'); END IF;

  IF v_o.status = 'paid' THEN
    SELECT * INTO v_row FROM leod_checkin_attendees WHERE id = v_o.attendee_id;
  ELSE
    SELECT * INTO v_row FROM leod_checkin_attendees WHERE event_id = v_o.event_id AND lower(email) = lower(v_o.email);
    IF v_row.id IS NULL THEN
      INSERT INTO leod_checkin_attendees
        (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
      VALUES
        (v_o.event_id, v_o.first_name, v_o.last_name, v_o.email, v_o.company,
         replace(gen_random_uuid()::text, '-', ''), 'web', false, v_o.created_at, v_o.answers,
         (SELECT id FROM leod_checkin_ticket_types WHERE id = v_o.ticket_type_id), v_o.ticket_name)
      RETURNING * INTO v_row;
    END IF;
    v_first := true;
    UPDATE leod_checkin_web_orders
       SET status = 'paid', paid_at = now(), payment_intent = NULLIF(p_payment_intent, ''), attendee_id = v_row.id
     WHERE id = v_o.id;
  END IF;
  RETURN jsonb_build_object('status', 'paid', 'first', v_first, 'event_id', v_o.event_id,
    'attendee', CASE WHEN v_row.id IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                         'qr_token', v_row.qr_token, 'qr_email_sent_at', v_row.qr_email_sent_at) END);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_order_paid(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_order_paid(uuid, text) TO service_role;

-- Stripe says the Checkout session expired unpaid: the place is free again.
CREATE OR REPLACE FUNCTION checkin_web_order_expire(p_order_id uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE leod_checkin_web_orders SET status = 'expired' WHERE id = p_order_id AND status = 'open'
  RETURNING status;
$$;
REVOKE ALL ON FUNCTION checkin_web_order_expire(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_order_expire(uuid) TO service_role;

-- The guest came back after their order expired: hold a place again if
-- one is free, at most 3 holds per order. Answers 'open', 'paid',
-- 'refunded', 'full', 'sold_out', 'closed', 'hold_limit' or 'not_found'.
CREATE OR REPLACE FUNCTION checkin_web_order_reopen(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o   leod_checkin_web_orders;
  v_ent leod_checkin_entitlements;
  v_ev  leod_events;
BEGIN
  SELECT * INTO v_o FROM leod_checkin_web_orders WHERE id = p_order_id;
  IF v_o.id IS NULL THEN RETURN 'not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_o.event_id::text, 0));
  SELECT * INTO v_o FROM leod_checkin_web_orders WHERE id = p_order_id FOR UPDATE;
  IF v_o.status IN ('paid', 'refunded') THEN RETURN v_o.status; END IF;
  IF v_o.status = 'open' AND v_o.expires_at > now() THEN RETURN 'open'; END IF;
  SELECT * INTO v_ent FROM leod_checkin_entitlements WHERE event_id = v_o.event_id AND registration_enabled AND checkin_core;
  SELECT * INTO v_ev FROM leod_events WHERE id = v_o.event_id;
  IF v_ent.event_id IS NULL
     OR (v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at)
     OR (v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL
         AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone)) THEN
    RETURN 'closed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE id = v_o.ticket_type_id AND active) THEN RETURN 'sold_out'; END IF;
  IF v_o.holds >= 3 THEN
    UPDATE leod_checkin_web_orders SET status = 'expired' WHERE id = v_o.id AND status = 'open';
    RETURN 'hold_limit';
  END IF;
  -- This order is expired, so the counts below no longer include it.
  UPDATE leod_checkin_web_orders SET status = 'expired' WHERE id = v_o.id AND status = 'open';
  IF checkin_web_ticket_left(v_o.ticket_type_id, false) = 0 THEN RETURN 'sold_out'; END IF;
  IF v_ent.registration_capacity IS NOT NULL
     AND checkin_web_places_taken(v_o.event_id, false) >= v_ent.registration_capacity THEN
    RETURN 'full';
  END IF;
  BEGIN
    UPDATE leod_checkin_web_orders
       SET status = 'open', expires_at = now() + interval '35 minutes', checkout_session_id = NULL, holds = holds + 1
     WHERE id = v_o.id;
  EXCEPTION WHEN unique_violation THEN
    -- Another open order of the same address exists; this one stays expired.
    RETURN 'full';
  END;
  RETURN 'open';
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_order_reopen(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_order_reopen(uuid) TO service_role;

-- Refunded through CueDeck: the guest leaves the list unless they have
-- already checked in (then the organizer decides).
CREATE OR REPLACE FUNCTION checkin_web_order_refunded(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o       leod_checkin_web_orders;
  v_removed boolean := false;
BEGIN
  UPDATE leod_checkin_web_orders SET status = 'refunded', refunded_at = now()
   WHERE id = p_order_id AND status = 'paid' RETURNING * INTO v_o;
  IF v_o.id IS NULL THEN RETURN jsonb_build_object('status', 'not_paid'); END IF;
  DELETE FROM leod_checkin_attendees WHERE id = v_o.attendee_id AND checked_in_at IS NULL;
  v_removed := FOUND;
  RETURN jsonb_build_object('status', 'refunded', 'removed', v_removed);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_order_refunded(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_order_refunded(uuid) TO service_role;

-- What the sweep asks Stripe about: open orders a few minutes old (the
-- guest is most likely gone) and any open order past its expiry.
CREATE OR REPLACE FUNCTION checkin_web_orders_due()
RETURNS SETOF leod_checkin_web_orders
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM leod_checkin_web_orders
   WHERE status = 'open' AND (created_at < now() - interval '4 minutes' OR expires_at < now())
   ORDER BY last_checked_at NULLS FIRST, created_at LIMIT 100;
$$;
REVOKE ALL ON FUNCTION checkin_web_orders_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_orders_due() TO service_role;

-- ── The sweep's cron ──────────────────────────────────────────────
-- Same pattern as 089: the secret is made inside the vault and read from
-- vault.decrypted_secrets by both the cron and the function.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_orders_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                'checkin_orders_cron_secret',
                                'x-cron-secret for the checkin-orders-sweep Edge Function (109)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION checkin_orders_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
           SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'checkin_orders_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION checkin_orders_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_orders_cron_ok(text) TO service_role;

INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-orders-sweep', interval '5 minutes',
        'pg_cron -> pg_net -> Edge Function checkin-orders-sweep: settles paid-ticket orders (109)')
ON CONFLICT (job_name) DO UPDATE
  SET expected_interval = EXCLUDED.expected_interval, note = EXCLUDED.note, active = true;

DO $$
BEGIN
  PERFORM cron.unschedule('checkin-orders-sweep') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-orders-sweep');
END $$;
SELECT cron.schedule(
  'checkin-orders-sweep',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-orders-sweep',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                    WHERE name = 'checkin_orders_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $cron$);

-- ── Guard G16 ─────────────────────────────────────────────────────
-- The live checkin_guard_results (through 108) with G16 added at the end.
CREATE OR REPLACE FUNCTION public.checkin_guard_results()
 RETURNS TABLE(guard text, ok boolean, detail text, checked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_ok     BOOLEAN;
  v_detail TEXT;
  v_bad    TEXT[];
  v_roles  TEXT[];
  v_n      INT;
  v_total  INT;
  v_gf     INT;
  v_admin  UUID;
  v_fn     RECORD;
  v_noargs TEXT[];
  v_ev     UUID;   -- G10
  v_res    TEXT;   -- G10
  v_refused INT;   -- G10
BEGIN
  -- G1 (061, 064, 069): no leod_checkin_* table writable by anon. Writable
  -- = an INSERT/UPDATE/DELETE grant AND (RLS off OR a permissive write
  -- policy that applies to anon or PUBLIC). TRUNCATE is not counted:
  -- PostgREST cannot issue it, and Supabase grants it to anon by default.
  -- An empty in-scope set (prefix renamed, tables moved) is a failure: the
  -- guard must not pass by looking at nothing.
  BEGIN
    SELECT count(*),
           array_agg(c.relname::text ORDER BY c.relname) FILTER (WHERE
             has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE')
             AND (NOT c.relrowsecurity OR EXISTS (
                   SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid
                      AND p.polpermissive
                      AND p.polcmd IN ('a', 'w', 'd', '*')
                      AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles)))))
      INTO v_total, v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'leod\_checkin\_%';
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_checkin_* tables found'
                     WHEN v_n = 0 THEN '0 of ' || v_total || ' leod_checkin_* tables writable by anon'
                     ELSE v_n || ' of ' || v_total || ' leod_checkin_* tables writable by anon: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_tables_not_anon_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G2 (061, 064, 069): no table in public with RLS off.
  BEGIN
    SELECT array_agg(c.relname::text ORDER BY c.relname)
      INTO v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity;
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every table in public has RLS on'
                     ELSE 'RLS off: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'public_tables_rls_on'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G3 (069): leod_config not writable by authenticated (same definition
  -- of writable as G1).
  BEGIN
    IF to_regclass('public.leod_config') IS NULL THEN
      v_ok := false;
      v_detail := 'leod_config does not exist';
    ELSE
      SELECT NOT (has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE')
                  AND (NOT c.relrowsecurity OR EXISTS (
                        SELECT 1 FROM pg_policy p
                         WHERE p.polrelid = c.oid
                           AND p.polpermissive
                           AND p.polcmd IN ('a', 'w', 'd', '*')
                           AND (0::oid = ANY (p.polroles)
                                OR 'authenticated'::regrole::oid = ANY (p.polroles)))))
        INTO v_ok
        FROM pg_class c
       WHERE c.oid = to_regclass('public.leod_config');
      v_detail := CASE WHEN v_ok THEN 'authenticated cannot write leod_config'
                       ELSE 'authenticated can write leod_config' END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'leod_config_not_authenticated_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G4 (roles build): every leod_checkin_operators.role is allowed. Five
  -- roles once the roles build has widened the check constraint, three
  -- before it.
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.leod_checkin_operators'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%''lead''%'
                  AND pg_get_constraintdef(oid) LIKE '%''viewer''%') THEN
      v_roles := ARRAY['organizer', 'lead', 'crew', 'viewer', 'api_consumer'];
    ELSE
      v_roles := ARRAY['organizer', 'crew', 'api_consumer'];
    END IF;
    SELECT array_agg(DISTINCT coalesce(o.role, '<null>'))
      INTO v_bad
      FROM leod_checkin_operators o
     WHERE o.role IS NULL OR NOT (o.role = ANY (v_roles));
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every role is one of: ' || array_to_string(v_roles, ', ')
                     ELSE 'roles outside {' || array_to_string(v_roles, ', ') || '}: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_operator_roles_allowed'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G5 (billing invariants): no live event without a paid, unrefunded
  -- purchase unless its owner is a comp account. Rows that 059 made live
  -- when paid go-live shipped (went_live_at = created_at, created before
  -- 059 was applied at 2026-10-04 10:42:11 UTC) were enabled by hand and
  -- are grandfathered.
  BEGIN
    SELECT count(*),
           array_agg(x.event_id::text ORDER BY x.event_id) FILTER (WHERE x.unpaid AND NOT x.gf),
           count(*) FILTER (WHERE x.unpaid AND x.gf)
      INTO v_total, v_bad, v_gf
      FROM (SELECT n.event_id,
                   (NOT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                                 WHERE p.event_id = n.event_id
                                   AND p.paid_at IS NOT NULL
                                   AND p.refunded_at IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)) AS unpaid,
                   coalesce(n.went_live_at = n.created_at
                            AND n.created_at < timestamptz '2026-10-04 10:42:11+00', false) AS gf
              FROM leod_checkin_entitlements n
              JOIN leod_events e ON e.id = n.event_id
             WHERE n.status = 'live') x;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' live entitlements without a purchase (' || v_gf || ' grandfathered)'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'live_events_have_purchase'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G6 (billing invariants): no paid purchase without a matching
  -- entitlement: live while the purchase stands, any status once refunded
  -- (checkin_mark_refunded sets the entitlement back to 'test').
  BEGIN
    SELECT count(*),
           array_agg(p.id::text ORDER BY p.id) FILTER (WHERE n.event_id IS NULL
             OR (p.refunded_at IS NULL AND n.status IS DISTINCT FROM 'live'))
      INTO v_total, v_bad
      FROM leod_checkin_purchases p
      LEFT JOIN leod_checkin_entitlements n ON n.event_id = p.event_id
     WHERE p.paid_at IS NOT NULL;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' paid purchases without a matching entitlement'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'purchases_have_entitlement'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G7 (069): every SECURITY DEFINER function in public pins search_path.
  BEGIN
    SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     ORDER BY p.proname)
      INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        WHERE cfg LIKE 'search\_path=%');
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every SECURITY DEFINER function in public sets search_path'
                     ELSE cardinality(v_bad) || ' without search_path: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'security_definer_search_path'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G9 (077): every admin read RPC (public admin_get_* / admin_list_*)
  -- that can be called without arguments runs cleanly as an admin.
  -- PL/pgSQL prepares a statement only when execution reaches it, so a
  -- broken query behind the admin check is invisible to a caller without a
  -- JWT. Each call therefore impersonates an existing admin (request.jwt.claims,
  -- transaction-local) inside its own subblock, and ends by raising a private
  -- SQLSTATE so the subblock rolls back: any write the RPC made and the
  -- impersonation itself are undone. Only that private SQLSTATE is a pass.
  -- Any other error is a failure, including Forbidden/Unauthorized, which as
  -- an admin means the admin check itself is broken. No admin to test as, or
  -- no callable RPC in scope, is a failure, not an all-clear. RPCs that need
  -- arguments without defaults are listed but do not fail the guard.
  BEGIN
    v_bad := NULL;
    v_noargs := NULL;
    v_total := 0;
    SELECT u.id INTO v_admin
      FROM leod_users u
     WHERE u.role = 'admin'
     ORDER BY u.id
     LIMIT 1;
    IF v_admin IS NULL THEN
      v_ok := false;
      v_detail := 'no admin user to test as';
    ELSE
      FOR v_fn IN
        SELECT p.proname::text AS fname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.pronargs = p.pronargdefaults AS callable
          FROM pg_proc p
          JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.prokind = 'f'
           AND (p.proname LIKE 'admin\_get\_%' OR p.proname LIKE 'admin\_list\_%')
         ORDER BY 2
      LOOP
        IF NOT v_fn.callable THEN
          v_noargs := array_append(v_noargs, v_fn.sig);
          CONTINUE;
        END IF;
        v_total := v_total + 1;
        BEGIN
          PERFORM set_config('request.jwt.claims',
                             json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
          EXECUTE format('SELECT count(*) FROM public.%I()', v_fn.fname);
          RAISE EXCEPTION USING ERRCODE = 'ZZG09';
        EXCEPTION
          WHEN SQLSTATE 'ZZG09' THEN
            NULL;
          WHEN OTHERS THEN
            v_bad := array_append(v_bad, v_fn.sig || ' ' || SQLSTATE || ' ' || left(SQLERRM, 60));
        END;
      END LOOP;
      v_n := coalesce(cardinality(v_bad), 0);
      v_ok := v_total > 0 AND v_n = 0;
      v_detail := CASE WHEN v_total = 0 THEN '0 admin read RPCs callable without args found'
                       ELSE v_n || ' of ' || v_total || ' admin read RPCs fail when called as an admin'
                            || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, '; ') END END
                  || CASE WHEN v_noargs IS NULL THEN ''
                          ELSE '; not callable without args: ' || array_to_string(v_noargs, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'admin_read_rpcs_callable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G10 (078): no public admin_* function executable by anon, and none with
  -- an ACL entry for PUBLIC (grantee 0; a NULL proacl means the default
  -- PUBLIC EXECUTE, so acldefault is expanded). Written by exclusion over
  -- every admin_* function in public, all overloads. Zero admin_* functions
  -- found is a failure, not an all-clear. Supabase default privileges grant
  -- EXECUTE to anon on new functions, so a new admin_* function turns this
  -- red until it is revoked.
  BEGIN
    SELECT count(*),
           array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
             FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                        OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE a.grantee = 0))
      INTO v_total, v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname LIKE 'admin\_%';
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 admin_* functions found'
                     ELSE v_n || ' of ' || v_total || ' admin_* functions executable by anon'
                          || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'admin_rpcs_not_anon'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G10 (086): every check-in RPC a signed-in user can call with an event
  -- id refuses a stranger to that event. Written by exclusion: it covers
  -- every public function whose first argument is p_event_id uuid and that
  -- authenticated may EXECUTE, so a new RPC is checked the day it ships.
  -- The bug class it catches: `IF ... NOT (owner OR role = 'organizer')`
  -- where the role is NULL for a stranger, so the IF is NULL and the
  -- SECURITY DEFINER body runs (checkin_update_event_details and
  -- checkin_set_alert_ticket_types, both fixed in 086).
  -- Each call impersonates a random user id against a real check-in event
  -- (other arguments NULL) and ends in a private SQLSTATE so the subblock
  -- rolls back, as G9 does. Pass: 42501. A STABLE/IMMUTABLE function may
  -- instead answer NULL or false, which tells a stranger nothing
  -- (checkin_is_owner, checkin_role_for_event). A VOLATILE function that
  -- does not raise 42501 fails, whatever it returns. No event to test
  -- against, or no function in scope, is a failure, not an all-clear.
  BEGIN
    v_bad := NULL; v_total := 0; v_refused := 0;
    SELECT event_id INTO v_ev FROM leod_checkin_entitlements WHERE checkin_core ORDER BY event_id LIMIT 1;
    IF v_ev IS NULL THEN
      v_ok := false;
      v_detail := 'no check-in event to test against';
    ELSE
      FOR v_fn IN
        SELECT p.proname::text AS fname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.provolatile = 'v' AS writes,
               (SELECT string_agg(', NULL::' || format_type(t, NULL), '' ORDER BY i)
                  FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, i) WHERE i > 1) AS rest
          FROM pg_proc p
          JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.prokind = 'f'
           AND p.pronargs >= 1
           AND p.proargtypes[0] = 'uuid'::regtype
           AND (p.proargnames)[1] = 'p_event_id'
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         ORDER BY 2
      LOOP
        v_total := v_total + 1;
        BEGIN
          PERFORM set_config('request.jwt.claims',
                             json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
          EXECUTE format('SELECT public.%I(%L::uuid%s)::text', v_fn.fname, v_ev, coalesce(v_fn.rest, '')) INTO v_res;
          IF v_fn.writes OR NOT (v_res IS NULL OR v_res = 'false') THEN
            v_bad := array_append(v_bad, v_fn.sig || ' answered a stranger'
                                  || CASE WHEN v_fn.writes THEN ' (writes)' ELSE ': ' || left(v_res, 40) END);
          ELSE
            v_refused := v_refused + 1;
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'ZZG10';
        EXCEPTION
          WHEN SQLSTATE 'ZZG10' THEN
            NULL;
          WHEN insufficient_privilege THEN
            v_refused := v_refused + 1;
          WHEN OTHERS THEN
            v_bad := array_append(v_bad, v_fn.sig || ' ' || SQLSTATE || ' ' || left(SQLERRM, 60));
        END;
      END LOOP;
      v_n := coalesce(cardinality(v_bad), 0);
      v_ok := v_total > 0 AND v_n = 0;
      v_detail := CASE WHEN v_total = 0 THEN '0 event RPCs callable by authenticated found'
                       ELSE v_n || ' of ' || v_total || ' event RPCs do not refuse a stranger'
                            || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, '; ') END END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_rpcs_refuse_strangers'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G11 (092): no post-event report is parked. A report is parked after
  -- five failed sends (owner deleted, no email, address rejected); the
  -- sender stops retrying it, so without this guard the failure would go
  -- quiet after the fifth run. Event ids and the last error only.
  BEGIN
    SELECT count(*), array_agg(e.event_id::text || ': ' || left(coalesce(e.report_last_error, '?'), 80) ORDER BY e.event_id)
      INTO v_n, v_bad
      FROM leod_checkin_entitlements e
     WHERE e.status = 'live' AND e.report_sent_at IS NULL AND e.report_attempts >= 5;
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_ok THEN 'no post-event report is parked'
                     ELSE v_n || ' report(s) parked after 5 failed sends: ' || array_to_string(v_bad, '; ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_reports_not_parked'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G12 (094): leod_sessions_archive has every column leod_sessions has.
  -- The nightly archive upserts select('*') rows, so one missing column
  -- fails every run (seq did, from 004 until 094). By exclusion over the
  -- live columns of leod_sessions, so a column added tomorrow is caught.
  -- No leod_sessions columns found is a failure, not an all-clear; a
  -- missing archive table lists every column as missing.
  BEGIN
    SELECT count(*),
           array_agg(s.attname::text ORDER BY s.attnum) FILTER (WHERE a.attname IS NULL)
      INTO v_total, v_bad
      FROM pg_attribute s
      LEFT JOIN pg_attribute a
             ON a.attrelid = to_regclass('public.leod_sessions_archive')
            AND a.attname = s.attname
            AND a.attnum > 0
            AND NOT a.attisdropped
     WHERE s.attrelid = to_regclass('public.leod_sessions')
       AND s.attnum > 0
       AND NOT s.attisdropped;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_sessions columns found'
                     WHEN v_n = 0 THEN 'leod_sessions_archive has all ' || v_total || ' leod_sessions columns'
                     ELSE v_n || ' of ' || v_total || ' leod_sessions columns missing from leod_sessions_archive: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'sessions_archive_has_every_column'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G13 (095): no leod_* table has a write policy any signed-in user (or
  -- anyone) passes unconditionally. By exclusion over every permissive
  -- INSERT/UPDATE/DELETE/ALL policy on public.leod_* that applies to
  -- authenticated, anon or PUBLIC: it fails when its USING or WITH CHECK
  -- is missing where the command needs it, 'true', or only
  -- auth.role() = 'authenticated'. That is the shape that let any account
  -- write any event's log, broadcast, clock, commands and reports until
  -- 095. Also flagged: an expression that references neither a column
  -- (VAR) nor a function (FUNCEXPR), e.g. 1 = 1. No leod_* policy found
  -- is a failure.
  BEGIN
    SELECT count(*),
           array_agg(DISTINCT c.relname || '.' || p.polname) FILTER (WHERE
             (p.polcmd IN ('w', 'd', '*')
              AND (p.polqual IS NULL
                   OR pg_get_expr(p.polqual, p.polrelid) IN ('true', '(auth.role() = ''authenticated''::text)')
                   OR (p.polqual::text NOT LIKE '%{VAR %' AND p.polqual::text NOT LIKE '%{FUNCEXPR %')))
             OR (p.polcmd IN ('a', 'w', '*')
                 AND (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), 'true')
                        IN ('true', '(auth.role() = ''authenticated''::text)')
                      OR (coalesce(p.polwithcheck, p.polqual)::text NOT LIKE '%{VAR %'
                          AND coalesce(p.polwithcheck, p.polqual)::text NOT LIKE '%{FUNCEXPR %'))))
      INTO v_total, v_bad
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relname LIKE 'leod\_%'
       AND p.polpermissive
       AND p.polcmd IN ('a', 'w', 'd', '*')
       AND (0::oid = ANY (p.polroles)
            OR 'authenticated'::regrole::oid = ANY (p.polroles)
            OR 'anon'::regrole::oid = ANY (p.polroles));
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_* write policies found'
                     WHEN v_n = 0 THEN 'none of ' || v_total || ' leod_* write policies is unconditional'
                     ELSE v_n || ' unconditional leod_* write policies: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'leod_writes_not_unconditional'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
  -- G14 (101, 102): the public registration paths stay private. Written by
  -- exclusion over names, so a new checkin_web_* function or
  -- leod_checkin_web_* table is covered the day it ships: no such function
  -- may be executable by anon or authenticated, and every such table must
  -- have RLS on and no anon/authenticated privilege at all. The public caller
  -- reaches them only through the checkin-register Edge Function.
  BEGIN
    v_bad := NULL; v_total := 0;
    FOR v_fn IN
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig, p.oid
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname LIKE 'checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' executable by anon/authenticated');
      END IF;
    END LOOP;
    FOR v_fn IN
      SELECT c.relname::text AS sig, c.oid, c.relrowsecurity
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'leod\_checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF NOT v_fn.relrowsecurity THEN v_bad := array_append(v_bad, v_fn.sig || ' has RLS off'); END IF;
      IF has_table_privilege('anon', v_fn.oid, 'SELECT,INSERT,UPDATE,DELETE')
         OR has_table_privilege('authenticated', v_fn.oid, 'SELECT,INSERT,UPDATE,DELETE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' granted to anon/authenticated');
      END IF;
    END LOOP;
    -- (102) and their sequences, which a bigserial creates with its own grants.
    FOR v_fn IN
      SELECT c.relname::text AS sig, c.oid
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE 'leod\_checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF has_sequence_privilege('anon', v_fn.oid, 'USAGE,SELECT,UPDATE')
         OR has_sequence_privilege('authenticated', v_fn.oid, 'USAGE,SELECT,UPDATE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' (sequence) granted to anon/authenticated');
      END IF;
    END LOOP;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 checkin_web_* functions or tables found'
                     WHEN v_n = 0 THEN 'all ' || v_total || ' web registration functions and tables are private'
                     ELSE array_to_string(v_bad, '; ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_web_paths_private'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G15 (103): no event's registration mail cap was hit in the last 24
  -- hours. A hit means guests were told "check your email" and no email went
  -- (an attack, or a popular event outgrowing the cap); either way a person
  -- must look. Rows come from checkin_web_request.
  BEGIN
    SELECT count(*), string_agg(DISTINCT event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_web_trips WHERE at > now() - interval '24 hours';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no registration mail cap hit in 24 h'
                     ELSE v_n || ' mail cap hits in 24 h, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_web_mail_cap_not_hit'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G16 (109): no paid-ticket order is left open well past its expiry. The
  -- checkin-orders-sweep cron settles every open order with Stripe within
  -- minutes of expiry; one still open 20 minutes later means the sweep is
  -- not running or cannot reach Stripe, and a guest who paid may have no
  -- ticket. Checks every order, so a new path that creates orders is
  -- covered without changes here.
  BEGIN
    SELECT count(*), string_agg(DISTINCT event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_web_orders WHERE status = 'open' AND expires_at < now() - interval '20 minutes';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no paid-ticket order left open past its expiry'
                     ELSE v_n || ' orders still open 20 min past expiry, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_orders_settled'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$function$
;
