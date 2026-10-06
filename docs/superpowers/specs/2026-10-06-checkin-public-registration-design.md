# Check-in: public registration page

Date: 2026-10-06. Status: approved to build ("yes start with the registration page").

## Problem

Guests reach the check-in list in three ways: CSV import, the organizer's
Add person, or the paired kiosk at the venue. There is no link an organizer
can share so guests sign themselves up before the event. Without it, check-in
only works for events that already have a guest list somewhere else.

## What it is

A public page at `app.cuedeck.io/r/<code>` where a guest enters their name,
email, optional company and up to five organizer-defined questions, ticks
consent, and is added to the event's guest list. Their QR code arrives by
email. The organizer turns it on in Setup, gets the link (with copy button
and a printable QR of the link), and can set a capacity, a closing time and
the questions.

Included in the per-event price. No separate charge.

## Decisions

1. **Link code, not event id.** `registration_code` is a random 10-character
   code from the unambiguous alphabet (no 0, 1, I, O). Regenerating it kills
   the old link, which is the organizer's answer to a leaked or spammed link.
2. **Email proves ownership.** In live mode the page never shows the QR code
   or short code; it says "Check your email". Anyone can type any address, so
   showing the code would let a stranger obtain a badge in someone else's name
   without their inbox.
3. **Already registered reveals nothing.** Same response as a new
   registration ("Check your email"); the QR is re-sent to the address on file,
   at most once per 10 minutes per attendee. Both branches padded to the same
   response time (same reasoning as checkin-self-register).
4. **Test mode.** Registrations are `is_test`, count against the existing
   25-row test cap, are cleared at go-live like every test row, and send no
   email (otherwise test mode becomes free QR delivery). The page shows a
   "Test mode" banner and the short code on screen so the organizer can try it.
5. **Abuse controls, all fail closed:**
   - Cloudflare Turnstile token verified server-side (`TURNSTILE_SECRET_KEY`
     Edge Function secret; same site key as CueDeck sign-in). If the secret is
     not set, the function refuses every registration.
   - Rate limits: per IP (SHA-256, never stored raw) 5 per 10 minutes; per
     event 300 per hour; per attendee re-send 1 per 10 minutes.
   - Honeypot field; a filled honeypot gets the normal success response and
     writes nothing.
   - The public form sends email only to the address typed, once, so the
     worst case per IP is 5 emails per 10 minutes from our domain.
6. **Capacity** counts non-test attendees of every source (import, kiosk,
   walk-in, web). Full means the page says so; the desk can still add people.
7. **Closing time**: optional; defaults to none. Registration also closes when
   the check-in window closes (end of day +2), whatever the setting.
8. **Questions**: up to 5, each `{id, label, type: text|choice, required,
   options[]}`; answers stored in the existing `custom_fields` jsonb keyed by
   question id, shown on the attendee row and included in the CSV export.
   Labels are kept with the answers so a later edit to a question does not
   re-label old answers.
9. **Source** `web` is added to the source check constraint, so the dashboard
   and report can tell web registrations apart.
10. **Consent** required, never pre-ticked; `consent_at` recorded.

## Pieces

- Migration 100: registration columns on `leod_checkin_entitlements`
  (`registration_enabled`, `registration_code` unique, `registration_capacity`,
  `registration_closes_at`, `registration_questions` jsonb), `source` adds
  `web`, a `leod_checkin_web_attempts` table plus
  `checkin_web_rate_check(p_event_id, p_ip_hash)` (service role only), and
  `checkin_set_registration(...)` for organizers (owner/organizer only, refuses
  strangers with the COALESCE pattern).
- Edge Function `checkin-register` (no JWT): `GET ?code=` returns the public
  form config (event name, date, venue, questions, state: open, full, closed,
  test); `POST` registers.
- Page `cuedeck-register.html`, rewrite `/r/:code`.
- Setup: "Registration page" panel.
- Dashboard: `web` shown as "Registration page" in sources.
- CSV export includes custom answers.

## Out of scope

Paid tickets, waitlists, email verification links, editing a registration,
Eventbrite/Ticket Tailor import.

## Revision after the security review (same day, migration 101)

The review of migration 100 found that the single-step form would email a
QR code carrying submitter-typed text (the first name) from our domain to any
address, with no proof its owner asked: the shape of the September
invoice-phishing incident on CueQuote. It also found a client-controlled IP
in the rate limit, a membership leak at capacity, an email pattern that let
`x<victim@y>` through, a per-IP limit that would lock out a venue's shared
Wi-Fi, and consent recorded for people who never gave it. Decisions 2, 3 and
5 are replaced by:

- **Double opt-in for live events.** Submitting stores a pending request
  (`leod_checkin_web_pending`) and sends one fixed-text confirmation email
  that contains nothing the submitter typed. The attendee is created, with
  `consent_at`, only when the address owner opens the link AND presses
  Confirm (a mail scanner opening the link registers nobody). Links work once,
  for 48 hours; a daily cron deletes unconfirmed requests (job registered in
  `leod_checkin_jobs`).
- **One answer for everyone.** Every live submission answers "check your
  email", for a new, pending or already listed address. Capacity answers
  "full" for everyone. An already listed owner who confirms gets their QR
  again (at most every 10 minutes).
- **Mail budget.** At most one confirmation per pending request per 10
  minutes, and 3 per address per 24 hours across all events, with plus-tags
  folded (`victim+1@x` and `victim+2@x` share one budget).
- **Rate limit** per (event, IP), 20 per 10 minutes, plus 300 per event per
  hour. The IP comes from `cf-connecting-ip`, else the right-most
  `X-Forwarded-For` entry; a request with neither is refused.
- **Turnstile** tokens must carry `action: 'register'`, so a sign-in token
  is not accepted.
- **Field rules.** Emails must be a plain addr-spec (no `<>()[]\,;:"`); names
  may not contain `@`, `/` or a domain-like `word.tld`.
- **CSP** on `/r/*`: no inline script, and only Cloudflare Turnstile and the
  Supabase function origin besides self.
- **Guard G14** (`checkin_web_paths_private`): no `checkin_web_*` function
  executable by anon/authenticated, and every `leod_checkin_web_*` table has RLS
  on and no grants. The guard is written by name pattern, so new ones are
  covered.

Test mode is unchanged: immediate, no email of any kind, 25 rows, code on
screen, cleared at go-live.
