# Check-in: event-day intelligence

Date: 2026-10-04. Status: approved by Sherif in chat ("build what others didn't do"; six features approved, build order approved).
Builds on: `2026-10-04-checkin-roles-design.md` (roles, dashboard page, `checkin_event_stats`).

## Why

The competitors checked (Cvent OnArrival, Bizzabo, zkipster, Eventbrite) show live counts, no-shows and peak times. None of them, in what we could find, runs staffing advice live, proves offline desks lost nothing, tracks arrivals by company, or sends the organizer a finished report. CueDeck already has the pieces that make these possible: offline desks that record both device time and server time, group check-in by company, and kiosks that report `last_seen_at`.

## Ground rule

Every number shown is measured from this event's own rows. No industry averages, no invented show-up rates. When there is not enough data yet, the screen says so ("Pace appears after the first 10 check-ins") instead of guessing.

## 1. Desk health (dashboard)

Today a browser desk is anonymous: scans carry `operator_id` but nothing says which laptop. Added:
- Each desk creates a stable `desk_id` (UUID in localStorage) and a label ("Desk 1", editable).
- `leod_checkin_scan_events.desk_id uuid null` (kiosks keep `device_id`).
- `leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)`, written only through `checkin_desk_heartbeat(event_id, desk_id, label, pending_count)` (SECURITY DEFINER, caller must be lead or crew or organizer on the event). The desk calls it every 30 seconds when online and once on reconnect.

Dashboard panel, organizer and lead only (desk labels and operator names are people data):
- Each desk and kiosk: **Online** (seen in the last 90 s), **Offline since 11:02**, or **Syncing, 14 waiting**.
- **Offline gaps proven:** for each desk, scans where `received_at - scanned_at > 60 s` are grouped into gaps: "Desk 2 offline 11:02 to 11:09, 23 check-ins synced late, 0 lost." "0 lost" is only claimed when that desk's latest heartbeat reports `pending_count = 0`; otherwise it says "14 still on the device".

## 2. Pace and staffing (dashboard)

Measured inputs only:
- **Arrival rate:** `ok` check-ins per minute over the last 15 minutes.
- **Desk speed:** for each desk, check-ins per minute in its busiest 15 minutes so far.
- **Capacity:** sum of desk speeds of desks online now.

Messages:
- Rate above 90% of capacity for 10 minutes: "Arrivals (12/min) are close to what your 2 desks clear (13/min). Consider opening another desk."
- Before the event starts: "86 still expected. At your desks' measured speed that is about 11 minutes of check-in."
- Fewer than 10 check-ins or no desk with 5 minutes of activity: "Pace appears after the first 10 check-ins."

Shown to organizer and lead. Viewers see the arrival rate only.

## 3. Client view (viewer)

`/checkin/dashboard?event=<id>&view=client`: full-screen, large type, auto-refresh, no navigation. Registered, checked in, turnout, arrivals over time, peak. Numbers only; never names, companies or desk details. Every role can open it; it is the only dashboard view a Viewer gets.

## 4. Company arrival board (dashboard)

Organizer and lead only. Table of companies: expected, arrived, last arrival time. Filters: **Not here yet** (0 arrived) and **Partly here**. Sorted by largest still missing. No new data; read through a new `checkin_company_board(event_id)` (SECURITY DEFINER, organizer, owner or lead).

## 5. VIP arrival alerts

- Setup, Event details: "Alert me when these ticket types arrive" (multi-select from the event's ticket types). Stored in `leod_checkin_entitlements.alert_ticket_types text[] default '{}'`, organizer-editable.
- When `checkin_apply_scan` records an `ok` scan for an attendee whose ticket type is in the list, it inserts `leod_checkin_alerts (event_id, attendee_id, ticket_type, created_at, is_test)` in the same transaction.
- Dashboard (organizer, lead) and the desk of every lead subscribe through Realtime and show "Ewa Sample (Speaker, Contoso Demo) just checked in at Desk 2", kept in a list for the day. Desk staff and viewers do not receive them.
- The CueDeck console is out of scope for this round: console users who also run check-in see alerts on the dashboard.

## 6. Post-event report

- Page `/checkin/report?event=<id>` for owner, organizer and viewer (viewer version omits companies). Turnout, no-shows by ticket type, peak 15 minutes, walk-ins, offline gaps, desk count and speed, time from first to last arrival.
- Email to the owner two hours after the check-in window closes: the headline numbers plus a link to the report. Never attendee names or companies in the email body (rule: outbound messages reference account state, not customer content). Sent once: `leod_checkin_entitlements.report_sent_at`.
- Delivered by a pg_cron job every 15 minutes calling an Edge Function `checkin-post-event-report`, which reads the webhook secret from `vault.decrypted_secrets` (not `current_setting`), records each run in `leod_checkin_job_runs (job, started_at, finished_at, ok, detail)` so the brain can tell a dead job from a quiet one.
- Test-mode events never send a report.

## Build order

1. Roles + dashboard core (roles spec) + features 1, 2, 3.
2. Features 4 and 5.
3. Feature 6.

## Tests

- `checkin_event_stats` and `checkin_company_board`: role matrix (viewer allowed and denied respectively), counts against a seeded event, undo excluded.
- Heartbeat: role check, pending count stored, offline detection boundary (89 s online, 91 s offline).
- Gap detection: synthetic scans with `received_at` lag, grouped correctly; "0 lost" only with `pending_count = 0`.
- Pace messages: each threshold, and the "not enough data" path.
- VIP alert: inserted with the `ok` scan in the same transaction, not for duplicates or undos, not for unlisted ticket types; staff and viewer cannot read alerts.
- Report job: runs once per event, never for test events, records a job run row on success and on failure.
