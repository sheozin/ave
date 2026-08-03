# Check-in Module — Station UI & Self-Registration — Design Spec

## What this is

The second sub-project of Plan 1b, following QR/email delivery (shipped 2026-08-03,
migration 052 + `checkin-send-qr-emails`). Attendees can now receive a QR code but
there is nothing to scan it with. This spec covers the **registration desk UI** and
the **self-registration kiosk** that feeds it.

It does **not** cover the door scanner (`scanner`-kind devices bound to a scan point),
or the organizer dashboard — separate specs. Badge printing, previously scoped as a
separate "print agent" sub-project, is folded into this build (see below).

## Why this shape

Four things happen at an AVE registration desk, confirmed with the user:

1. A guest shows a QR code and is scanned in
2. A guest gives their name and is looked up (most people don't have the email ready)
3. Their badge is printed there and then
4. Several people arrive together from one company

Desks are staffed by **mixed crews** — some experienced, some volunteers briefed that
morning — across **several stations** at one event.

The consequence: **the unit of work is an arrival, not a scan.** An arrival is one to
five people from the same company standing at the desk together. A lone attendee is a
party of one — same screen, no special case. Earlier one-person-per-scan layouts were
rejected for this reason.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Which device first | `checkin_station` (desk) | Badge printing happens here, and it prints directly from this page |
| Connectivity | Offline-capable, local queue | Venue wifi fails at 9am when 300 people arrive |
| Duplicate scans | Effect de-duplicated, record kept | First scan wins on `checked_in_at`; duplicate row retained for audit |
| Location | New `cuedeck-checkin.html` | Desk staff must not reach *go live* / *hold stage* / *cancel session* |
| Visual direction | Light, Apple/Airbnb finish | Lobbies are bright; dark UI washes out. Soft radii, warm neutrals, one accent |
| Walk-up code delivery | On screen **and** by email | Screen code for the 3-metre walk to the desk; email as the durable re-entry copy |
| Badge printing | Per-event setting | Self-print for free/open events, staff-print for paid or vetted ones |

## Architecture

A new standalone page, `cuedeck-checkin.html` — vanilla HTML/JS with the Supabase JS
client, no build step, matching `cuedeck-display.html`. It serves two modes from one file:

- **Desk mode** — operator signed in, full arrival handling
- **Kiosk mode** — unattended touch screen, self-registration only

Authorization reuses `checkin_role_for_event()` from migration 045. No new auth system.
Kiosk mode runs under a restricted path that can only create attendees, never read the
roster.

### Offline model

On opening an event, the station downloads that event's attendee list into IndexedDB.
Scans and lookups resolve against the local copy, so the verdict is instant regardless
of connectivity. Each action appends to a local outbox that survives a page reload.
The outbox flushes whenever the connection returns; a header pill shows the pending count.

`scan_events.scanned_at` holds the true door time, `received_at` the catch-up time —
the two-clock split already present in migration 049.

### Server authority

A new Edge Function `checkin-record-scans` accepts a batch and, per attendee, sets
`checked_in_at` **only if currently null**. This is what makes first-scan-wins hold when
two desks sync out of order. The `scan_events` row is written either way with `result`
of `ok` or `duplicate`. `device_id` stays null in this build — the column is nullable.

## Desk UI

One screen. A search field that accepts both scanner input (keyboard-wedge: the gun types
the token and presses Enter) and typed names — the field holds focus permanently, so no
mouse is needed for the common path.

A scan or lookup resolves to the person **and their company group**. Staff tick whoever
else is standing there and commit the whole party at once.

**One primary button, stating exactly what will happen:** `Check in 2 · Print 2 badges`.
A secondary `Check in only` covers a jammed printer. Volunteers should never have to
choose between similar-looking options.

Rules:

- **Names are editable before printing.** A misspelled badge is permanent and embarrassing.
- **Status is words, not colour alone** — "arrived 08:51", "not here yet". Survives poor
  lobby lighting and colour-blind staff.
- **Errors say what to do next.** "That code isn't for this event → Search their name
  instead." No error codes; written for a volunteer.

### Undo — requires migration 053

Mistakes must be correctable at the desk, not via a database call mid-event. Corrections
are **recorded, not erased**, consistent with the duplicate decision.

Two schema gaps block this today:

- `scan_events.result` has no value for an undo
- `scan_events` has no operator column, so "who undid this" is unattributable

Migration 053 adds `'undo'` to the result CHECK and a nullable `operator_id`. Undo then
sets `checked_in_at` back to null and writes a **new** row naming who did it. The timeline
reads forward, nothing is deleted, and redo is simply another check-in.

Undo reaches any attendee checked in today, via search — not only the most recent.

## Self-registration kiosk

A touch screen for people who never registered, sited either before the desk as a
queue-buster or on the desk itself.

**Three screens.** Arrive → details → consent and code.

The welcome screen offers **two doors**: "I didn't register" and "I can't find my email."
Merging them is what produces duplicate records at real events.

**Four fields, two optional** — first name, last name, company, email. Every extra field
is a person occupying a screen while a queue builds. Email is required *only* when code
delivery by email is on, which is the default.

**GDPR consent is mandatory.** A Polish company collecting personal data from EU citizens
at an unattended screen needs an explicit tick — never pre-checked — with a privacy notice link.

**The already-registered case comes free.** Migration 050's unique index on
`(event_id, email)` makes the duplicate insert fail; the kiosk catches the collision and
shows the existing record and its code instead of an error. This is the most common kiosk
problem at real events and the schema already solves it.

On success the kiosk shows a short code **and** triggers the existing
`checkin-send-qr-emails` function for that attendee — no new sending code.

### Per-event settings — requires migration 053

Two flags added to `leod_checkin_entitlements`, which already holds per-event config:

- `self_registration` — is the kiosk enabled for this event
- `kiosk_self_print` — does the kiosk print badges directly, or issue a code for staff to print

**Staff-print is the approval gate.** On paid or vetted events, the human at the desk
printing the badge *is* the check that this person should be admitted — no separate
approval queue is needed. On self-print events, registration is open by design.

## Testing

Pure-function tests following the existing `tests/checkin-import.spec.ts` convention —
no live DB:

- local token → attendee matching
- duplicate detection and first-scan-wins ordering
- outbox merge and replay ordering after reconnect
- party assembly (grouping an attendee's company colleagues)
- kiosk field validation and the already-registered collision path

## Badge printing — no print agent needed

The original build order listed a "print agent" as a separate sub-project. It is not
required. A badge is an HTML element with a `@page` rule; Chrome launched with
`--kiosk-printing` sends `window.print()` straight to the default printer with **no
dialog and no preview**. This is the standard approach for kiosk receipt and ticket
printing.

So badge printing is **in scope for this build**:

- A hidden badge template in `cuedeck-checkin.html`, styled with `@page { size: ... }`
  to the venue's badge stock
- `window.print()` fired after a successful check-in
- Printing a party prints each badge in sequence
- `badge_printed_at` on the attendee is stamped on success — the column already exists
  in migration 047

**Setup, not code.** Each desk machine needs Chrome launched once with:

```
chrome --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"
```

and its default printer set to the badge printer. This belongs in the operator runbook,
not the application.

**Honest limits.** Driver- or OS-level prompts can still interrupt "silent" printing —
paper size selection, tray choice, secure-release PIN, accounting codes. These are printer
configuration issues, not application ones, but they must be tested against the actual
badge printer before an event. The `Check in only` button exists precisely for when
printing misbehaves mid-event.

## Out of scope

- The door scanner (`scanner` devices, camera scanning)
- The organizer dashboard and the duplicate-attempts report
- Device registration and API keys — `device_id` stays null
- Service worker / installable app. Worth adding after the desk is proven at one event;
  a service worker caching the wrong asset is a bad failure mode to debug mid-event.
