# Check-in event roles

Date: 2026-10-04. Status: design approved by Sherif in chat (5 roles, permission table below).

## Goal

Each person on a check-in event has one of five roles. The owner alone handles money, office roles set the event up, onsite roles see only the desk, and a viewer sees only numbers. Platforms that do this: Eventbrite (Owner, Admin, check-in only roles), zkipster (Administrator, Event Host, Collaborator, Check-in, Viewer, Executive), Swoogo (job-based roles).

## Roles

| Role | Stored as | Who |
|---|---|---|
| Owner | `leod_events.created_by` (unchanged), plus their existing `organizer` operator row | The person who created the event and pays for it |
| Organizer | `leod_checkin_operators.role = 'organizer'` | Office team |
| Desk lead | `role = 'lead'` (new) | Onsite supervisor |
| Desk staff | `role = 'crew'` (unchanged, shown as "Desk staff") | Onsite check-in |
| Viewer | `role = 'viewer'` (new) | Client, executive, sponsor contact |

There is no `owner` value in the operators table. Ownership stays a single fact in `created_by`, so it can never disagree with a second copy. Existing data needs no migration: every current organizer stays Organizer, every crew member stays Desk staff, every creator stays Owner.

## Permissions (approved)

| | Owner | Organizer | Desk lead | Desk staff | Viewer |
|---|---|---|---|---|---|
| Pay to go live, see purchases and invoices | ✓ | | | | |
| Transfer ownership, delete event | ✓ | | | | |
| Edit details, import guests, send QR emails | ✓ | ✓ | | | |
| Invite and remove people | ✓ | ✓ (never the owner) | Desk staff only | | |
| Pair kiosks, add walk-ins, undo anyone's check-in | ✓ | ✓ | ✓ | | |
| Search, check in, print badges, undo own check-in | ✓ | ✓ | ✓ | ✓ | |
| Live arrivals count and dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export the attendee list | ✓ | ✓ | | | |

## Rulings (decided while writing; each is cheap to change)

1. **Go live is owner only, paid or complimentary.** A comp account's "Set up check-in" makes the event live, which is the same act as paying, so it follows the same rule. Putting an existing console event into free test mode stays organizer-level.
2. **Delete means archive, and only while in test mode.** Owner-only "Delete event" sets `leod_events.active = false` (every check-in list already filters on `active`). A live event holds a purchase record and attendance, so it cannot be deleted from the check-in app; the owner contacts support.
3. **Transfer ownership: check-in events only, to an existing organizer.** It changes `created_by` for events with `created_via = 'checkin'`. Console events are owned by the console account that created them and are not transferable here. The old owner becomes an Organizer. Complimentary status follows the owner (it is read from `created_by`), so the confirm dialog says so when it changes.
4. **Export is a screen permission, not a data wall.** The desk works offline, so desk roles must hold the full guest list on the device, and the database lets them read it. Hiding Export from desk roles stops casual export; it does not stop a determined desk user. This is the same trade-off the existing desk already makes, now written down.
5. **Viewers read numbers, never people.** No attendee, scan or device row is readable by a viewer. They see counts through `checkin_my_events` (already SECURITY DEFINER and returning only counts) and a new `checkin_event_stats(event_id)` function that returns arrivals by hour and by ticket type, no names.
6. **The desk lead invites from a cut-down Setup.** Setup opens for a lead showing only the Desk staff step, where they can invite and remove Desk staff. Every other step and the Go live panel are hidden for them, and the server refuses them anyway.
7. **Walk-ins.** The desk gets an "Add walk-in" form for leads and above (name, email, company, ticket type). The row is written with `source = 'walk_in'`; in test mode it is `is_test` and counts toward the 25.
8. **Undo own check-in** is enforced in `checkin_apply_scan`: for a `crew` caller, an undo is accepted only when the latest `ok` scan for that attendee was recorded by the same operator. Otherwise it is recorded with result `forbidden` and the desk says "Ask a desk lead to undo this check-in."
9. **Account role.** Lead and viewer invitees who have no CueDeck account get the account-level `checkin_staff` role, exactly like desk staff today, so the console keeps turning them away.

## Server changes

Database (one migration):
- `leod_checkin_operators.role` CHECK widened to `organizer, lead, crew, viewer, api_consumer`.
- `leod_checkin_attendees.source` CHECK widened from `import, kiosk` to add `walk_in`.
- `leod_checkin_scan_events.result` CHECK widened to add `forbidden` (ruling 8).
- Helper `checkin_is_owner(event_id) boolean` (SECURITY DEFINER, `auth.uid()` only).
- Policies: attendee read and update to `organizer, lead, crew`; attendee insert to `organizer` plus `lead` for `source = 'walk_in'` rows; device and scan point write to `organizer, lead`; scan event insert to `organizer, lead, crew`; purchases read to owner only; entitlements and operators read to all five; scan event read to `organizer, lead, crew` (today it is any role, which would include viewers).
- `checkin_my_events` returns the five roles (owner shown as `owner`), so every screen reads one value.
- `checkin_apply_scan` gains the undo-own rule (ruling 8).
- New `checkin_event_stats(event_id)` for viewers and the dashboard (ruling 5).

Edge Functions:
- `checkin-create-checkout`: owner only.
- `checkin-enable-event`: comp go-live owner only; test-mode setup organizer.
- `checkin-import-attendees`, `checkin-send-qr-emails`: organizer or owner (unchanged in effect).
- `checkin-invite-staff`: accepts roles `organizer, lead, crew, viewer`; organizers invite any of them; leads invite and remove `crew` only; nobody removes the owner (already enforced); new owner-only actions `transfer_owner` and `archive_event`.
- `checkin-kiosk-pair`: organizer or lead.
- `checkin-record-scans`: organizer, lead or crew.

## Screens

- Front page cards: role label on each card; viewer cards show counts and a "View dashboard" button only.
- Setup: Desk staff step lists roles with plain descriptions; Go live panel shows the owner's name to non-owners ("Only the event owner, <name>, can go live"); owner sees Transfer ownership and Delete event under Event details.
- Desk: Add walk-in and "undo anyone" for leads and above; staff see Undo only on their own check-ins; Set up a kiosk for leads and above.
- Dashboard: a read-only page `/checkin/dashboard?event=` with arrivals, turnout, arrivals by hour and by ticket type, refreshing every 30 seconds. Open to every role.

## Tests

- `tests/checkin-rls.spec.ts` policy matrix extended to five roles, including that a viewer reads zero attendee, scan and device rows.
- Function tests for each Edge Function role gate, one allow and one deny per role boundary.
- `checkin_apply_scan`: crew undo of own check-in accepted, of another's refused, lead undo of anyone's accepted.
- Browser: one run per role on a test event confirming hidden controls and server refusals.

## Out of scope

Custom roles, per-permission toggles, account-wide roles across events, and role changes in place (remove and re-invite instead).
