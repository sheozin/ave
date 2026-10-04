# CueDeck Check-in as a sellable product: design

**Date:** 2026-10-04
**Status:** awaiting review
**Repos:** `~/AVE-Production-Console` (app, Supabase `sawekpguemzvuvvulfbc`) and `cuedeck-marketing/` (cuedeck.io, its own git repo)
**Mockups:** `.superpowers/brainstorm/95488-1791107308/content/` (front-page-direction, your-events, setup, golive-and-desk, marketing-checkin). Light direction chosen.

## Goal

A CueDeck customer, or someone who has never used CueDeck, can find check-in on
cuedeck.io, sign up, create an event, import guests, invite desk staff, test the
desk for free, pay €249 to go live, and run their registration desk, without
anyone at CueDeck touching the database.

Today the desk and kiosk work, but everything before the doors open (enabling
check-in, importing guests, sending QR emails, adding staff) is reachable only
by calling Edge Functions directly. There is no price, no payment, and no
mention on cuedeck.io.

## Decisions (settled with Sherif, 2026-10-04)

| Topic | Decision |
|---|---|
| Who it is for | Sell to CueDeck customers and to people who do not use CueDeck |
| Pricing model | Per-event add-on, one flat product |
| Price | **€249 per event, excluding VAT.** Below the cheapest verified comparable (CONREGO €357 / 3-month minimum; Eventzilla ~$450 for 300 guests) |
| What it includes | Everything built: desk, kiosk, CSV import, QR emails, badge printing, offline desk, attendance export. Unbuilt flags (multi-point scanning, API, personalization, PII in API) are not sold or advertised |
| Accounts | One CueDeck account. Check-in-only customers sign up at `/checkin` and never get pushed into the console |
| Desk staff | Organizers invite anyone by email; invitees get a check-in-only login scoped to that event |
| When they pay | Set up free, pay to go live |
| Test mode | 25 test check-ins + kiosk registrations per event, TEST on badges, cleared at go-live |
| What one payment covers | One event. Real check-ins accepted from 7 days before the event date to 2 days after it. Date locked once live |
| Structure | Split by job: front page, setup page, existing desk |
| Visual direction | Light (the existing desk's look) |
| Language | English at launch (app and marketing) |
| Marketing | Full "Solutions" menu: Command Center, Stage Timer & Displays, Event Check-in. Real screenshots only, captured from the built product with a demo account |

## Non-goals

- The roaming scanner (Build A, paused). Door and session scanning stay hidden.
- Server-side enforcement of console plan limits (event counts). Noted below as an existing gap; only the per-event credit bugs on the shared billing path are fixed here.
- Translations. English only at launch.
- Attendee-count tiers, bundles, discounts or promo codes for check-in.
- The four event-day gaps from the desk memory (real printer hardware, jam detection, real company data, clock skew). They matter for running events, not for selling.

---

## Part 1: data model

All changes in new migrations starting at **059**. Every migration ships with a
verification query whose result is pasted in the PR (Live Verification Protocol).

### 1.1 Entitlement state

`leod_checkin_entitlements` gains:

| Column | Type | Meaning |
|---|---|---|
| `status` | `text not null default 'test'`, check in (`test`, `live`) | Free setup vs paid |
| `went_live_at` | `timestamptz` | Set by the payment path only |

A row still means "check-in is set up for this event"; `checkin_core = true`
keeps `checkin_role_for_event()` working unchanged. Existing rows are migrated
to `status = 'live'` so nothing in use breaks (today that is the IME 2026 test
event only; the migration's verification query lists them).

No client may write `status` or `went_live_at`: the table already has no client
write policy, and that stays.

### 1.2 Test markers

- `leod_checkin_scan_events.is_test boolean not null default false`
- `leod_checkin_attendees.is_test boolean not null default false` (only ever true for kiosk self-registrations made in test mode)
- `leod_checkin_scan_events.result` check widened with `test_cap` and `outside_window` (refusals are recorded, consistent with "corrections are recorded, never erased")

### 1.3 Purchases

New table `leod_checkin_purchases`:

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `event_id uuid not null` references `leod_events` | |
| `buyer_id uuid not null` | auth user who clicked Go live |
| `stripe_checkout_session_id text unique not null` | idempotency key |
| `stripe_payment_intent_id text` | refund lookup |
| `stripe_customer_id text` | reuse on later purchases |
| `amount_total integer`, `amount_tax integer`, `currency text` | from Stripe, in minor units |
| `paid_at timestamptz` | |
| `refunded_at timestamptz` | |
| `created_at timestamptz default now()` | |

RLS: organizers of the event may `select`; no client writes.

### 1.4 Event origin

`leod_events.created_via text not null default 'console'`, check in (`console`, `checkin`).
Used so check-in-only events never consume a console plan's event allowance or
a Pay-per-Event credit (see 3.6), and so the front page can say "from your
CueDeck console" on console events.

### 1.5 Check-in-only staff accounts

- `leod_users.role` check gains `checkin_staff`.
- `handle_new_auth_user()` (migration 015's trigger function) changes: when
  `raw_user_meta_data->>'checkin_staff' = 'true'`, insert the `leod_users` row
  with role `checkin_staff` instead of `director`. All other signups unchanged.
- The console treats `checkin_staff` like `pending` today: blocked, with a
  message "This login is for CueDeck Check-in" and a link to `/checkin`. This
  matters because the console currently treats a missing `leod_users` row as an
  implicit director.

Check-in-only *customers* (organizers who sign up at `/checkin`) stay normal
`director` rows: they own events, and if they later open the console they get
the ordinary trial. The console trial row is created by the console client, so
a check-in signup that never opens the console never gets one.

### 1.6 Date lock

Trigger on `leod_events` `before update of date`: if the event has an
entitlement with `status = 'live'`, refuse the change unless the caller is an
admin (`is_admin()`). Error text tells the organizer to contact support.

---

## Part 2: pages

All three are static single-file pages in the repo's existing style (vanilla
JS, Supabase JS, no build step), using the desk's light tokens (`--pg #F5F5F7`,
`--ac #0071E3`, system font).

### 2.1 Routes (`vercel.json`)

| Path | File |
|---|---|
| `/checkin` | `cuedeck-checkin-home.html` (new) |
| `/checkin/setup` | `cuedeck-checkin-setup.html` (new) |
| `/checkin/desk` | `cuedeck-checkin.html` (existing) |
| `/kiosk` | redirect to `/checkin/desk?mode=kiosk` |

Today's uncommitted change (rewrite `/checkin` to the desk, `/kiosk` redirect,
console header link) is superseded by this table. The console's "Check-in"
link keeps pointing at `/checkin`, which becomes the front page. The kiosk
pairing modal builds its URL from `location.pathname` and so produces
`/checkin/desk?mode=kiosk`, which is correct.

### 2.2 Front page, `/checkin` (mockups: front-page-direction A, your-events)

Signed out:
- Pitch (headline, three built capabilities, "€249 per event, excl. VAT · set up free"), link to cuedeck.io/solutions/check-in
- Sign in / Create account / Forgot password. Create account calls `auth.signUp` with `{ name, organization, signup_source: 'checkin' }` and `emailRedirectTo: <origin>/checkin`, then the same confirm-email wait the console uses

Signed in, "Your events":
- One card per event the user holds a `leod_checkin_operators` grant on, plus console events they own that have no entitlement yet (owners already hold an organizer grant via migration 045's trigger)
- Card states: **Not set up** (no entitlement row), **Test mode**, **Live**, **Ended** (live and past the window)
- Organizer actions: Set up check-in / Continue setup / Setup, Open desk / Try the desk, View attendance (ended)
- Crew see only events they are granted, and only *Open desk*. No prices, no New event
- **New event**: name, date, start time, end time, venue, timezone → insert `leod_events` with `created_via = 'checkin'` (RLS already allows `created_by = auth.uid()`), then call `checkin-enable-event`, which creates the entitlement in `test`

### 2.3 Setup, `/checkin/setup?event=<id>` (mockup: setup, golive-and-desk top)

Organizer only (page checks the role; every function re-checks server-side).
Left rail of steps with completion ticks, amber test banner with *Go live · €249*
while in test.

1. **Event details**: name, date (locked when live), times, venue, timezone
2. **Attendees**: table with search and filters (All / No email / Checked in), add one person, delete, CSV import through `checkin-import-attendees` with the dry-run preview shown before commit (create / update / skip counts and per-row reasons, which the function already returns)
3. **Desk staff**: current operators, invite by email as *Desk staff* (`crew`) or *Co-organizer* (`organizer`), remove
4. **Kiosk & badges**: `self_registration`, `kiosk_self_print`, `auto_send_qr_email` toggles (written through `checkin-enable-event`, which is the only writer of the entitlements row); link to kiosk pairing
5. **QR emails**: in test, *Send a test to myself* only; when live, *Send to everyone not yet sent* and per-person resend
6. **Go live**: what it unlocks, window dates, attendees kept, test check-ins cleared, €249 excl. VAT, *Continue to secure payment*. After return from Stripe, poll the entitlement until `live` (timeout 60 s, then "Payment received, still confirming. Refresh in a minute" and a link to support)

Plus **Attendance export** (live and ended): CSV of name, company, email, ticket, checked-in time, badge-printed time, built client-side from rows the organizer can already read.

### 2.4 Desk changes (`cuedeck-checkin.html`, mockup: golive-and-desk bottom)

Minimal, because this page has to work offline on event day:
- Open an event from `?event=<id>` (front page links), keeping the existing picker as fallback
- When the entitlement is `test`: amber banner with remaining test check-ins and *Go live*; badges render with a diagonal TEST watermark
- Badge preview panel next to the party list (approved in the mockup)
- Handle the two new refusals from `checkin-record-scans` (`test_cap`, `outside_window`) with plain messages, and keep the refused items out of the retry queue

The kiosk shows the same test banner on its staff-facing screens only; the
guest-facing screen does not mention pricing.

---

## Part 3: server

### 3.1 Changed Edge Functions

| Function | Change |
|---|---|
| `checkin-enable-event` | Creates the entitlement with `status = 'test'`; also accepts the three operational settings toggles from Setup. Never writes `status` to `live` |
| `checkin-record-scans` | Reads `status`. **Test:** mark `is_test = true`; refuse with `test_cap` once the event has 25 test check-ins (scan events `ok` + test kiosk registrations). **Live:** refuse with `outside_window` when `scanned_at` falls outside [event date − 7 days, event date + 2 days] in the event's timezone |
| `checkin-self-register` | Test: create attendee with `is_test = true`, counted against the same cap |
| `checkin-send-qr-emails` | Refuse unless `live`, except `test_to_self: true`, which sends one sample email (first attendee's QR) to the caller's own address |
| `checkin-import-attendees` | Auto-send on import only when `live` |

### 3.2 New Edge Functions

- **`checkin-invite-staff`** (organizer of the event): if the email already has an auth user, insert the operator grant and send a "you've been added" email; otherwise `auth.admin.inviteUserByEmail` with `{ checkin_staff: 'true', name }` and redirect to `/checkin`, then insert the grant. Also handles remove (delete grant; never delete the auth user). Every write's `{ error }` is checked.
- **`checkin-create-checkout`** (organizer, event in `test`): finds a Stripe customer (existing `leod_subscriptions.stripe_customer_id`, then a previous `leod_checkin_purchases.stripe_customer_id`, then create), and opens Checkout with `mode: 'payment'`, the check-in price, `automatic_tax`, `tax_id_collection`, `customer_update`, `invoice_creation: { enabled: true }`, and `metadata { product: 'checkin', event_id, buyer_id }`. Success URL `/checkin/setup?event=<id>&paid=1`.
- **`checkin-price`** (public, GET): returns `{ amount, currency, tax_behavior }` read from the Stripe price `CHECKIN_PRICE_ID`. The front page, Setup and the marketing site all read this, so €249 lives only on the Stripe price.

### 3.3 Webhook (`stripe-webhook`)

- Add the new check-in product id to `CUEDECK_PRODUCTS`.
- `checkout.session.completed` and `checkout.session.async_payment_succeeded` with `metadata.product = 'checkin'`: proceed only if `payment_status = 'paid'` and the session's line item is the check-in product (fetched with `expand: ['line_items']`). Then call **`checkin_mark_paid(...)`**, one `SECURITY DEFINER` SQL function callable only by the service role, which in one transaction:
  1. inserts the purchase (`on conflict (stripe_checkout_session_id) do nothing`, so Stripe retries are harmless)
  2. sets the entitlement `status = 'live'`, `went_live_at = now()`
  3. deletes test scan events and test kiosk attendees, and nulls `checked_in_at` / `badge_printed_at` set by test check-ins on imported attendees
- `charge.refunded` for a check-in payment intent: set the entitlement back to `test` and stamp `refunded_at`.
- Any `{ error }` from these calls returns HTTP 500 so Stripe retries. No silent catch.

Clearing test check-ins deletes rows, which departs from "corrections are
recorded, never erased". The justification: test rows never recorded a real
arrival, and the organizer is told before paying that they will be cleared.

### 3.4 Stripe setup (done once, in the plan)

Create product **"CueDeck Check-in (per event)"** with one one-off price:
€249.00 EUR, `tax_behavior: exclusive`. Store its id in the Supabase secret
`CHECKIN_PRICE_ID` and the product id in `CUEDECK_PRODUCTS`. The account is
shared with CueQuote, so nothing is keyed on metadata that CueQuote might also set.

### 3.5 Login and access

- `/checkin` pages sign in with the same Supabase auth as the console.
- Every server action re-checks the role: organizer for setup, invites, checkout; organizer or crew for the desk.

### 3.6 Existing billing bugs fixed in the same work (verified 2026-10-04)

1. `stripe-webhook` calls `increment_events_purchased`, which does not exist in production, and its `.catch` fallback never runs because supabase-js resolves errors instead of rejecting. A Pay-per-Event buyer would be charged and credited nothing. No purchases have happened (production: 14 trial, 1 pro, 0 perevent). Fix: create the function (`SECURITY DEFINER`, service role only), call it, check `{ error }`, return 500 on failure.
2. `events_used` is incremented by a client `update` on `leod_subscriptions` that RLS silently rejects (no director update policy). Fix: an `after insert` trigger on `leod_events` increments `events_used` for the creator's `perevent` subscription when `created_via = 'console'`; remove the client update.

Out of scope but recorded: console plan limits are enforced only in the browser, and the onboarding wizard path has no limit check at all.

---

## Part 4: marketing site (cuedeck.io)

### 4.1 Navigation

`components/Nav.tsx` gains a **Solutions** dropdown (desktop) and section
(mobile) with three entries, each with a one-line description:

| Entry | Page | Bought how |
|---|---|---|
| Command Center | `/solutions/command-center` | CueDeck plans |
| Stage Timer & Displays | `/solutions/stage-timer` | Included in CueDeck plans |
| Event Check-in | `/solutions/check-in` | €249 per event, on its own |

`/check-in` redirects to `/solutions/check-in`.

### 4.2 Pages

- **Event Check-in**: structure as in the `marketing-checkin` mockup (hero, how it works, six capabilities, pricing card plus "Already on CueDeck?" card, FAQ, closing CTA). Price read from `checkin-price` with ISR (revalidate hourly). If the fetch fails, the page renders "See pricing when you sign up" instead of a number; it never falls back to a hardcoded amount.
- **Command Center**: run of show, live cues, operator roles, delay cascade, AI incident advisor, post-event reports; links to `/pricing`.
- **Stage Timer & Displays**: speaker countdown, overrun warning, signage screens, display pairing; "Included in every CueDeck plan".
- **/pricing**: a Check-in section under the plans, plus JSON-LD `Offer` for the check-in price.
- Sitemap, OpenGraph images, and an `og-validator` run for each new page.

### 4.3 Real screenshots

- A demo account and demo event created for this purpose, with obviously fictional guests and company names. Never a customer's data.
- Captured by a committed Playwright script at 2× device scale, compressed (rule: JPEG q88 progressive, 4:4:4 where text matters, or optimised PNG), descriptive filenames (`checkin-desk-group-arrival.jpg`), real alt text.
- Shots: front page events list, Setup with CSV preview, desk checking in a group, badge, kiosk, Go-live step. Command Center and Stage Timer reuse `public/screenshots/` where current; recapture any that show an outdated UI.
- The marketing pages publish only after the app is live and the real screenshots exist.

### 4.4 Also in this repo

The automated security review flagged `app/blog/[slug]/page.tsx`: JSON-LD
built from CMS fields is injected with `dangerouslySetInnerHTML` unescaped.
Writers are CMS editors only, so the risk is a compromised editor account. Fix:
escape `<`, `>`, `&`, U+2028 and U+2029 in both JSON-LD strings.

---

## Testing

The repo's convention is logic-level vitest specs that mirror Edge Function
logic, plus live verification queries. Following it:

- **vitest:** test-cap counting, check-in window boundaries across timezones (an event in Cairo and one in Warsaw, scans at the window edges), entitlement state transitions, webhook routing (check-in vs Pay-per-Event vs a CueQuote session on the shared account), idempotent `checkin_mark_paid`, refund reversal, invite paths (existing user vs new user).
- **SQL verification after each migration:** constraint and column presence, trigger behaviour on a scratch event, `checkin_staff` signup creates the right `leod_users` row.
- **Stripe test mode end to end:** test-mode checkout with a test card on a throwaway account (never the owner's account), webhook delivery, event goes live, test rows cleared, refund puts it back to test.
- **Browser:** each page at desktop and phone width, signed out, as organizer, as crew, as a `checkin_staff` invitee opening the console. Screenshots at 2×.
- **Kiosk and desk regression:** an existing live event still checks in, undoes and prints exactly as before.

## Build order

Two implementation plans:

- **Plan A (app):** Part 1 migrations → Part 3 server changes and billing fixes → Part 2 pages → Stripe test-mode end to end → production.
- **Plan B (marketing):** after Plan A is live. Solutions nav and three pages → real screenshots → /pricing → SEO checks → blog JSON-LD fix.

## Open items

- **Stripe access:** creating the product and price needs either Stripe dashboard access by Sherif or an authenticated Stripe CLI in the session.
- **Support contact** for refused date changes and stuck payments: `support@cuedeck.io` is used in the console; confirm it is monitored.
