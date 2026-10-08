# Event teams: per-event access, one login across organisers

Status: draft for Sherif's review (8 Oct 2026). Build and release after GTR (12 Oct).
Evidence: `2026-10-08-event-teams-inventory.md` (same folder): every object, policy, function and screen named below is listed there with file:line.

## 1. Goal and decisions

Today an invited person belongs to one organiser's account and gets one role on **all** of that organiser's events, and an email that already has a CueDeck account cannot be invited at all.

Owner decisions (8 Oct):
1. Access is **per event**: a person is a member of an event with a role on that event.
2. **One login, several organisers**: the same person can be on events of different organisers.
3. This is an app feature for every organiser, not a GTR fix. **Release after GTR.**

Success: an organiser invites anyone (new or existing account) to one event with one role; that person sees and can do exactly what the role allows on that event and nothing on any other event, by any route (screen, realtime, direct API, TVs, edge functions). Nothing anyone can do today breaks or widens on switch-over.

## 2. Model

- New table `leod_event_members(event_id → leod_events ON DELETE CASCADE, user_id → auth.users ON DELETE CASCADE, role ∈ {director, stage, av, interp, reg, signage}, active boolean default true, invited_by uuid, created_at, updated_at, UNIQUE(event_id, user_id))`. Same shape as check-in's `leod_checkin_operators`, plus a per-membership `active`.
- **The creator is always director**, computed from `leod_events.created_by` (never from a row), so a missing or edited row can never demote the owner. The creator is not stored as a member.
- One role per person per event. Different events can give the same person different roles.
- RLS: members read their own event's roster; all writes go through server functions (no direct client writes), like the stage-message table.

## 3. One rule for access

- `cuedeck_event_role(event_id)` becomes: `'director'` if the caller created the event, else the caller's active membership role for that event, else NULL.
- Every place that carries its own copy of the old rule is rewritten to call it (inventory §9.1):
  - policies `owner_read_events`, `scoped_read_sessions`, `owner_read_reports`, `scoped_all_displays`, `scoped_all_sponsors`;
  - functions `rpc_apply_delay`, `display_pair_link`, `display_rotate_secret`;
  - the server copy `eventRole()` in `_shared/transition.ts` (used by the 9 session-transition functions and apply-delay).
- Displays and sponsors: write access narrows from "any member" to director (and signage for pairing/rotating), matching the console's role matrix.
- Suspended members (membership `active = false`) lose **read** access too (today they keep reading; inventory side note).
- `validate_event_log_role` stamps the caller's **per-event** role, not a global one.
- A guard query (added to `checkin_guard_results()` or a console equivalent) fails if any policy or function outside `cuedeck_event_role` reads `invited_by` for access, so a new copy of the old rule cannot creep back in.

## 4. Inviting and managing

Inviting happens from inside an event ("Team for GTR North Africa 2026"):
- New email: account created, membership row added, branded invitation naming event, organiser and role (as today).
- **Existing account** (any organiser, any role): membership row added, a short "you've been added to <event>" email with a link; no new signup, no password step. Same role already: no-op. Different role on that event: change role instead. (Pattern: `checkin-invite-staff` §7.)
- Who can invite / change / remove on an event: its creator and its members with role director. An invited director manages **only the events they are on** and never sees the organiser's other events or billing.
- Change role, suspend, remove act on the **membership for this event only**. Remove never bans the login or deletes the account (today it bans the whole login: inventory §9.2). A "remove from all my events" action loops over the organiser's events.
- Every change is logged in that event's log (`MEMBER_INVITED`, `MEMBER_ROLE_CHANGED`, `MEMBER_SUSPENDED`, `MEMBER_REMOVED`) with who did it.
- Rate limit: 20 invitations per organiser per 24 h (as today), counted per event owner.

## 5. What each person sees

- Event switcher lists every event the person created or is an active member of, grouped by organiser ("Your events", "Northwind Events", …).
- The role is resolved **per event**, on boot and on every event switch (today once at boot: inventory §9.5). The role lock, director-only controls, presence role, crew list and View as follow the current event's role.
- Team window shows the current event's members with role, status and last seen (replaces the account-wide `get_operators_with_last_seen`).
- An account that is only ever a member (never created an event) sees no billing, no "trial", no plan upsell.

## 6. Plans and billing

- Limits come from the **event owner's** plan, for that event (displays, operators per event, reports, AI). Today they come from the viewer's own account, which gives an invited director a 3-day trial and then locks them out even when the owner is on Pro (inventory §4).
- Creating your own event uses your own plan; events you are only a member of do not count toward your event limit.
- No trial is created for someone who has only memberships; a trial starts when they create their first own event.

## 7. Switch-over

- Backfill: for each user with `invited_by` set, one active membership per event of that owner, with their current role (live today: 1 user, 1 event). Nobody gains or loses access.
- `leod_users.invited_by` and the global `leod_users.role` stay for compatibility during the release, unused for access; removed in a later cleanup once the guard in §3 is green.
- Check-in keeps its own `leod_checkin_operators` (another session owns it). The console must stop shutting out a login just because its global role is `checkin_staff` if it has console memberships.

## 8. Safety and tests

- Migration reviewed by a security reviewer before it is applied; a live probe proves, for a member of event A: read and write refused on event B's events, sessions, log, broadcasts, reports, displays, sponsors, stage messages, pairing, delays and every transition; realtime delivers nothing of B; suspended member reads nothing; creator can never be demoted; one login on two organisers' events sees both and only those.
- Console e2e: invite new and existing accounts, per-event role switching on event switch, Team window per event, remove keeps the login working elsewhere, plan from the owner.
- All existing suites green; tests that pin the old model (inventory §8) updated without weakening what they protect.

## 9. Open points for Sherif

1. Can an invited **director** edit the event itself (name, date, rooms) and delete sessions? Proposed: yes to editing and sessions; **no** to deleting the event, billing, and webhooks (creator only).
2. Should people who only join other organisers' events receive the founder welcome email sequence? Proposed: **no**, only an "added to event" email.
3. Grouping in the event switcher by organiser name: OK to show the organiser's company name to members?

## 10. Found during the inventory, separate from this feature

- Invited directors get their own 3-day trial and are locked out when it ends (fix in this feature, §6; can be fixed alone earlier if an invited director is needed for GTR).
- Suspended members can still read (fixed by §3).
- `handle_first_login(p_user_id)` takes a user id from the caller: to be verified and fixed separately.
- Setup-wizard invite ignores its error result; `track_user_login()` is not attached to any trigger.
