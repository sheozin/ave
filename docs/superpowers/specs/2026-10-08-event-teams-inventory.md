# Event teams: inventory of the current team model

Date: 2026-10-08. Read-only inventory to ground the per-event teams spec.
Sources: live DB `sawekpguemzvuvvulfbc` (pg_proc, pg_policies, pg_trigger, information_schema; SELECT only) and repo `main`.

Current model in one line: membership = `leod_users.invited_by = leod_events.created_by` AND `leod_users.active IS NOT FALSE`; the role is the single global `leod_users.role`.

---

## 0. Counts (live, 2026-10-08)

| Measure | Value |
|---|---|
| `leod_users` rows | 22 (role: director 21, admin 1; no stage/av/interp/reg/signage/pending/checkin_staff rows) |
| with `invited_by` set | 1 (active, role `director`, has never logged in; its owner has 1 event and is on `pro/active`) |
| distinct owners with an invitee | 1 |
| nested invites (invitee of an invitee) | 0 |
| owners with at least one event | 12 |
| events total | 14 (0 with `created_by` NULL) |
| events per owner | max 2, average 1.17 |
| `leod_subscriptions` | 16 (trial/active 14, pro/active 2); 0 rows owned by an invited user |
| `leod_checkin_operators` rows | 15 |
| policies that call `cuedeck_event_role` | **11** (on 5 tables) |
| policies that read `invited_by` inline | 5 (+1 INSERT policy on `leod_users` that pins `invited_by IS NULL`) |
| functions reading `invited_by` | 9 (+ `cuedeck_event_role`) |

Migration risk from data is near zero: one invited user, never signed in. The risk is in code paths, not rows.

---

## 1. Live database objects

### 1a. The role resolver

| Object | Kind | Purpose / team-model use |
|---|---|---|
| `cuedeck_event_role(p_event_id)` | function, SQL, STABLE, SECURITY DEFINER | `'director'` if `e.created_by = auth.uid()`, else `leod_users.role` where `u.invited_by = e.created_by AND u.active IS NOT FALSE AND role IN (director,stage,av,interp,reg,signage)`. Defined in `095_event_scoped_writes.sql`. **The single seam**: rewrite this to read a per-event membership table and the 11 policies + 2 RPCs below follow automatically. |

### 1b. Policies calling `cuedeck_event_role` (11)

| Table | Policy | Cmd | Rule |
|---|---|---|---|
| leod_broadcast | broadcast_member_read | SELECT | role IS NOT NULL |
| leod_broadcast | broadcast_member_insert | INSERT | role IS NOT NULL AND id = event_id::text |
| leod_broadcast | broadcast_member_update | UPDATE | same |
| leod_broadcast | broadcast_member_delete | DELETE | role IS NOT NULL |
| leod_event_log | event_log_member_read | SELECT | role IS NOT NULL |
| leod_event_log | event_log_member_insert | INSERT | role IS NOT NULL AND operator_id IS NULL or = auth.uid() |
| leod_reports | reports_member_insert | INSERT | role IS NOT NULL AND generated_by NULL or self |
| leod_sessions | sessions_member_insert | INSERT | role = 'director' |
| leod_sessions | sessions_member_update | UPDATE | role IN (director, stage, av) |
| leod_sessions | sessions_member_delete | DELETE | role = 'director' |
| leod_stage_messages | stage_messages_member_read | SELECT | role IS NOT NULL |

### 1c. Policies that inline the `invited_by` membership (do NOT go through the resolver)

These must each be rewritten; changing `cuedeck_event_role` alone leaves them on the old model.

| Table | Policy | Cmd | Team-model use |
|---|---|---|---|
| leod_events | owner_read_events | SELECT | `created_by = uid OR created_by IN (SELECT invited_by FROM leod_users WHERE id = uid)`. **No `active` check**: a suspended member still reads the owner's events. Drives the console event list. |
| leod_sessions | scoped_read_sessions | SELECT | event in (owned OR owner's via invited_by). No `active` check (documented as intentional in `tests/sql/095-event-scoped-writes-probe.sql:151`). |
| leod_reports | owner_read_reports | SELECT | same shape, no `active` check |
| leod_signage_displays | scoped_all_displays | ALL | same shape, WITH `active IS NOT FALSE`. Any member role (even `av`) gets full write on displays. |
| leod_signage_sponsors | scoped_all_sponsors | ALL | same as displays |
| leod_users | auth_insert_own_pending | INSERT | `id = uid AND role = 'pending' AND invited_by IS NULL` (self-insert can never join a team) |

### 1d. Policies that use `created_by` as owner-only (no member access today)

| Table | Policy | Cmd | Note |
|---|---|---|---|
| leod_events | owner_insert_events / owner_update_events / owner_delete_events | INSERT/UPDATE/DELETE | Only the creator edits/deletes an event. An invited director cannot rename/close the owner's event today. Spec must decide whether "invited director manages the events they are on" includes editing the event row. |
| leod_sessions_archive | admin_read_archive | SELECT | admin OR owner only; members cannot read archive |
| leod_webhooks | owner_manage_webhooks | ALL | owner only |

Tables with `event_id` and **no** policies at all (RLS-closed, server-only): `leod_commands`, `leod_signage_pairing`. `leod_feedback` has insert-own only. Admin policies (`leod_users.role = 'admin'`) on leod_admin_audit, leod_event_log, leod_events, leod_promo_codes, leod_sessions, leod_users, leod_subscriptions are unaffected.

### 1e. Functions

| Function | Kind | Team-model use |
|---|---|---|
| `stage_message_send`, `stage_message_clear` | RPC, SECDEF | `cuedeck_event_role(event)` IN (director, stage). Follow the resolver automatically. |
| `rpc_apply_delay(session, minutes, ...)` | RPC, SECDEF | **Inlines its own copy**: owner = director, else `leod_users.role WHERE invited_by = owner AND u.active` (note: `u.active`, so NULL active is refused, unlike the resolver's `IS NOT FALSE`). Needs rewrite. |
| `display_pair_link(code, display_id)` | RPC, SECDEF | display's event must be owned by caller or by caller's `invited_by` (active). Any member role may pair. Inline copy, needs rewrite. |
| `display_rotate_secret(display_id)` | RPC, SECDEF | same inline membership as pair_link. Needs rewrite. |
| `get_operators_with_last_seen()` | RPC, SECDEF | gate: caller's **global** `leod_users.role = 'director'`; returns caller + `WHERE invited_by = caller`. An invited director sees only themselves (their invitees would be under the owner). Account-scoped, not event-scoped. Needs replacement with an event-scoped team list. |
| `get_subscription_for_user()` | RPC, SECDEF | plan owner = self if `role='director' OR invited_by IS NULL`, else `invited_by`. So an **invited director resolves to their own (absent) subscription**, not the owner's. See section 4. |
| `get_my_profile()` | RPC, SECDEF | returns `invited_by` among profile fields (no logic). |
| `leod_users_guard_privileged()` | trigger fn (BEFORE UPDATE on leod_users) | blocks non-admin, non-service changes to role, active, invited_by, org_id, email, id. A new membership table needs its own equivalent guard. |
| `log_user_signup()` | trigger fn (leod_users, trg_log_user_signup) | writes `invited_by` into activity_log metadata. Cosmetic. |
| `log_role_change()` | trigger fn (leod_users, trg_log_role_change) | audits global role changes; per-event role changes would bypass it. |
| `validate_event_log_role()` | trigger fn (leod_event_log, trg_validate_log_role) | **Overwrites `operator_role` with the user's global `leod_users.role`** whenever operator_id is set. With per-event roles this will stamp the wrong role on every log row (a person who is `stage` on event B but `director` globally is logged as director). Must look up the per-event role instead. |
| `handle_new_auth_user()` | trigger fn (auth.users, on_auth_user_created) | inserts leod_users with role `'checkin_staff'` if metadata `checkin_staff='true'`, else `'director'`. Every new account, including console invitees, starts as a director with no team. |
| `handle_first_login(p_user_id)` | RPC, SECDEF | first-login bookkeeping, queues `welcome_email_trigger` (founder welcome + sequence) for every user, invited or not. Takes a caller-supplied user id. |
| `track_user_login()` | trigger fn | defined, **not attached** to any trigger (only `on_auth_user_created` exists on auth.users). |
| `is_admin()`, `admin_*` RPCs, `admin_list_users` | RPC | admin_list_users returns `invited_by` for display; no access logic. |
| `leod_events_count_perevent_usage()` | trigger fn (leod_events, AFTER INSERT) | increments `events_used` on the **creator's** perevent subscription. |
| check-in functions (`checkin_*`) | various | use `created_by` for ownership; untouched by this feature. |

No views reference these terms. No functions outside `public` reference them.

### 1f. Triggers relevant to the model

| Table | Trigger | Function |
|---|---|---|
| auth.users | on_auth_user_created | handle_new_auth_user |
| leod_users | trg_leod_users_guard_privileged | leod_users_guard_privileged |
| leod_users | trg_log_role_change | log_role_change |
| leod_users | trg_log_user_signup | log_user_signup |
| leod_users | trg_log_first_login | log_first_login |
| leod_event_log | trg_validate_log_role | validate_event_log_role |
| leod_events | trg_checkin_auto_grant_organizer | inserts creator as check-in `organizer` (the pattern to copy) |
| leod_events | trg_leod_events_count_perevent_usage | leod_events_count_perevent_usage |
| leod_events | trg_leod_events_guard_created_via, trg_checkin_lock_live_event_date, trg_events_updated | not team-related |

---

## 2. Edge functions

| File:line | What it does with the team model |
|---|---|
| `supabase/functions/_shared/transition.ts:47-58` `eventRole()` | TS copy of the resolver: owner = director; else `leod_users.role` if `invited_by === created_by` and `active !== false`. Does **not** restrict to the 6 console roles (a `pending`/`checkin_staff` role falls through to `ROLE_WRITE[role]` undefined and is refused, so safe today). |
| `_shared/transition.ts:35-40` `ROLE_WRITE`, `ROLE_DELAY` | server copy of the console's role matrix (console `cuedeck-console.html:2986`, `:2992`). |
| `_shared/transition.ts:156` | `runTransition` calls `eventRole` -> used by **9 functions**: go-live, call-speaker, cancel-session, end-session, hold-stage, reinstate, restart-session, set-overrun, set-ready (each `index.ts:1-8`). |
| `apply-delay/index.ts:3,48` | `eventRole` + `ROLE_DELAY`. |
| `invite-operator/index.ts:66-73` | caller must have **global** `role='director'` and active. Every self-registered account is a director, so any account can invite. |
| `invite-operator/index.ts:86` | `teamOwner = callerRow.invited_by ?? user.id` (invited director invites into the owner's team). |
| `invite-operator/index.ts:89-97` | **409 if any `leod_users` row has the email** (the blocker for multi-organiser). |
| `invite-operator/index.ts:104-108` | rate limit 20/24h per `payload->>team_owner` in leod_event_log. |
| `invite-operator/index.ts:113-129` | event named in the email only if `created_by === teamOwner`; falls back to the team's single active event. `event_id` is advisory only, membership is not event-scoped. |
| `invite-operator/index.ts:133-136` | `auth.admin.generateLink({type:'invite'})` with metadata `invited_role`; Supabase sends nothing. |
| `invite-operator/index.ts:152-163` | refuses if the account is on another team (`invited_by` differs) or owns events. |
| `invite-operator/index.ts:166-173` | upserts `leod_users {role, active:true, invited_by: teamOwner}` (overwrites the trigger's `director`). |
| `invite-operator/index.ts:190-194` | `_shared/invite-email.ts` `sendInviteEmail` (product `console`). |
| `invite-operator/index.ts:206-214` | audit `OPERATOR_INVITED`, `event_id: null`. |
| `manage-operator/index.ts:56-66` | caller global `role='director'` and active. |
| `manage-operator/index.ts:100-108` | target must have `invited_by === teamOwner` (`callerRow.invited_by ?? user.id`). An invited director can suspend/remove/re-role other members of the owner's team, including other directors. |
| `manage-operator/index.ts:115-128` | suspend/reactivate = `leod_users.active` (global: suspends the person from every event they could reach). |
| `manage-operator/index.ts:130-140` | **remove = ban the auth account for 876600h, then delete the leod_users row.** Account-wide and effectively permanent. |
| `manage-operator/index.ts:144-155` | set_role = global `leod_users.role`; refused if the target owns events. |
| `ai-proxy/index.ts:53-77` | plan owner = self if `role='director' OR !invited_by`, else `invited_by`; then reads `leod_subscriptions.director_id = ownerId`. Comment says it mirrors `get_subscription_for_user`. Account-scoped, not event-scoped. |
| `redeem-code/index.ts:86-108` | same director-resolution rule, applies promo to that subscription. |
| `create-checkout-session/index.ts:45-51,70,85,99` | caller global role must be `director`; subscription keyed `director_id = user.id`. |
| `customer-portal/index.ts:45-56` | same. |
| `update-billing-details/index.ts:46-51` | same. |
| `stripe-webhook/index.ts:73-90,139,457-468,615-679` | everything keyed by `leod_subscriptions.director_id`; no team logic. |
| `checkin-create-checkout/index.ts:80` | check-in purchase keyed to caller's own `director_id`. |
| `checkin-invite-staff/index.ts:178-240` | the reference implementation for adding an **existing** account (see 7). |
| `_shared/checkin-roles.ts:104-110` | check-in ownership from `leod_events.created_by`. |
| `admin-manage-user`, `admin-promote`, `admin-manage-subscription`, `admin-manage-promo`, `send-invoice-email` | global admin role checks only; unaffected. |

---

## 3. Console (`cuedeck-console.html` unless noted)

| Area | Line(s) | Dependency |
|---|---|---|
| Event list loader `loadEvents()` | 3089-3093 | `select * from leod_events where active and created_via='console'`; **membership comes entirely from RLS** `owner_read_events`. With per-event teams, changing the policy changes the list, no client change needed for "members see only their events". |
| Boot event load | 9746-9750, 9818 | `S.events = loadEvents()`; picks `S.event`. |
| `switchEvent()` | 7132-7150 | does **not** re-resolve the role. Role is loaded once at boot. Per-event roles need a role lookup here (e.g. `rpc('cuedeck_event_role')`) and a `setRole` call. |
| `loadUserRole()` | 9138-9264 | reads `leod_users.*`; blocks `active=false` (global suspend screen), `pending`, `checkin_staff` (overlay "this login is for Check-in", 9163-9183), `admin`. Sets `S.userRole = data.role` (9218) and `setRole`. |
| Role lock | 7005-7012 `roleLocked()`, 9240-9246 `#role-lock` pill, 10271 | locked when `S.userRole !== 'director'`. Becomes per-event. |
| Director-only UI gates | 3962, 4283, 4543, 4648, 4785, 5158, 5415, 6970, 7058, 7091 (`isDirector = S.role==='director' \|\| S.userRole==='director'`), 5792, 6009/6015/6049 (signage panel), 8648, 8677 | all keyed on the global `S.userRole`. |
| Users button + pending badge | 9146, 9250-9256, 8473-8490 `loadPendingBadge()` | counts `leod_users WHERE invited_by = S.user.id` (pending and non-pending). Invited directors see 0. |
| Team/Users modal `refreshUsersModal()` | 8197-8300 | `rpc('get_operators_with_last_seen')` (8208). Account-wide list, no event filter. |
| Role change / suspend / remove from modal | 8307-8335 | `functions.invoke('manage-operator')`. |
| `inviteOperator()` | 8411-8470 | plan-limit pre-check counts `leod_users.invited_by = S.user.id` vs `S.planLimits.operators` (8421-8427); invokes `invite-operator` with `event_id: S.event?.id` (8435); maps 409 "User already exists" to "Already registered as <role>" (8446). |
| Setup wizard invite | 9650-9658 | `invite-operator` with `event_id`; **result not read** (`functions.invoke` does not throw), so a failed invite is silent. |
| Event create | 7216-7236, 9623-9625 | plan limit counts `S.events.filter(active)` (7219), which **includes events owned by others** that the user can see; inserts `created_by: S.user.id`. A member of another organiser's event on a 1-event plan would be blocked from creating their own. |
| Presence / crew | 3160-3215 (`subscribeControl`, track `{role: S.role, userId, name}` at 3211), 6579-6600 `refreshPresence`, 6933 | role per presence entry is the client's `S.role`; per-event role must feed it. `#crew-count` "Crew 0/5" at 2219. |
| Display pairing | 5970-6005 (`leod_signage_displays` insert under `scoped_all_displays`, then `rpc('display_pair_link')` at 5991), 6019-6045 `display_rotate_secret` | both depend on inline `invited_by` membership. |
| Billing / plan `loadSubscription()` | 8705-8741 | `rpc('get_subscription_for_user')`; if none and `S.userRole==='director'` -> `createTrialSubscription()` (8744-8752, inserts own 3-day trial); non-director without owner sub gets `PLAN_LIMITS.trial`. `PLAN_LIMITS` at 2996. Expired trial -> `showTrialExpiredScreen` (8790) and boot aborts. |
| First login | 9720 | `rpc('handle_first_login', {p_user_id})`. |
| Agents | `cuedeck-agent-1-incident-advisor.js:25,289` | `getRole: () => S.role`, writes operator_role. Agents 2 and 3 have no team logic (`agent-3:314` only reads operator_role from log rows). |
| `cuedeck-admin.html` | 2199-2217 | subscription admin actions by `director_id`; no `invited_by` use. |
| `cuedeck-auth.js`, `cuedeck-display.html`, `api/`, `scripts/` | none | no team-model references. |

---

## 4. Billing and plans

- Every entitlement is **per account**: `leod_subscriptions` keyed by `director_id` (columns: plan, billing_interval, status, trial_ends_at, events_purchased, events_used, current_period_*, cancel_at, stripe ids). RLS: `directors_read_own_sub`, `directors_insert_own_trial` (plan='trial' only), admin read/update.
- Limits enforced client-side only from `PLAN_LIMITS` (`cuedeck-console.html:2996`): events, operators, displays, reports, ai. Server-side: only ai-proxy (plan check) and the perevent `events_used` trigger. Operator count and display count limits are client-only.
- **Invited non-director** (stage, av, ...): `get_subscription_for_user` resolves to the owner's subscription, so they inherit the owner's plan and AI.
- **Invited director**: resolves to their **own** subscription (rule is `role='director' OR invited_by IS NULL` -> self). They have none, so the console creates a 3-day trial for them (8710-8712) and after expiry shows the trial-expired screen and aborts boot, even when the owner is on Pro. ai-proxy and redeem-code use the same rule. Live: the one invited director has never logged in, so this has not fired yet.
- Under per-event teams, "which plan applies" must become **the event owner's plan for that event**, not the viewer's account. Today the plan is resolved once at boot, not per event. The operator-count limit (`invited_by = S.user.id`) needs to become a per-event member count against the owner's plan.
- perevent credit is consumed by the creator (`leod_events_count_perevent_usage`), which stays correct since the creator remains the owner.

---

## 5. Check-in's model (reference only, owned by another session; do not modify)

- Table `leod_checkin_operators(id uuid pk, event_id uuid not null -> leod_events ON DELETE CASCADE, user_id uuid not null -> auth.users ON DELETE CASCADE, role text not null CHECK in (organizer, lead, crew, viewer, api_consumer), created_at)`; `UNIQUE(event_id, user_id)`; indexes on event_id and user_id. Defined in `supabase/migrations/045_checkin_operators.sql`.
- One RLS policy, `checkin_op_read` (SELECT, members with organizer/lead/crew/viewer see the event's roster). Writes are server-only (edge functions).
- `checkin_role_for_event(p_event_id)`: SQL STABLE SECDEF, returns `o.role` for `(event, auth.uid())` **and** requires `leod_checkin_entitlements.checkin_core = true` for the event.
- Owner: `trg_checkin_auto_grant_organizer` inserts the creator as `organizer` on event insert (`ON CONFLICT DO NOTHING`); `checkin_is_owner()` still checks `created_by` directly. `checkin-enable-event/index.ts:182-184` upserts the organizer row too.
- Reuses `leod_users` only for identity (name/email) and the global role `'checkin_staff'` set by `handle_new_auth_user` from invite metadata. Membership and per-event role never come from `leod_users`.
- **Mirror verdict: yes.** A `leod_console_members(event_id, user_id, role, active, invited_by, created_at, UNIQUE(event_id,user_id))` with an auto-grant trigger for the creator, and `cuedeck_event_role` reading it, is the same shape. Differences to design for: console needs a per-membership `active` (suspend per event), and the creator should probably be computed (`created_by`) rather than only a row, so a missing row can never demote the owner (check-in keeps both).
- Interaction to note: a `checkin_staff` account is shut out of the console entirely by `loadUserRole` (9163-9183). If one login may hold console membership on one event and check-in staff on another, the global `checkin_staff` role check must become "has no console membership".

---

## 6. Live data shape

See section 0. 22 users, 1 with `invited_by`, 12 owners with events, 14 events, max 2 / avg 1.17 events per owner. Backfill of a per-event table: for each user with `invited_by`, one row per event of the owner (today: 1 row).

---

## 7. Auth emails and the invite flow

Today, for a new console invitee:
1. `invite-operator` refuses any email already in `leod_users` (409, `index.ts:89-97`).
2. `auth.admin.generateLink({type:'invite', data:{name, invited_role}})` creates the auth user; Supabase sends no email (`:133-136`).
3. `on_auth_user_created` -> `handle_new_auth_user` inserts `leod_users` as `role='director'`, active.
4. `invite-operator` upserts `role, active, invited_by=teamOwner` over it (`:166-173`).
5. `_shared/invite-email.ts` `sendInviteEmail` sends the branded invitation naming event, inviter and role.
6. On first console boot, `handle_first_login` queues `welcome_email_trigger`; `process-welcome-triggers` sends the founder welcome and the sequence to every first-login user, invited operators included (no role filter in `process-welcome-triggers/index.ts:34-120`).

What must change so an existing account can join another organiser's event without signing up again:
- `invite-operator`: drop the 409; if the account exists, insert a membership row instead of touching `leod_users.role`/`invited_by`. Copy `checkin-invite-staff/index.ts:178-276`: existing + never signed in -> `generateLink` `invite` (unconfirmed) or `recovery`; existing + signed in -> notice email with `existingAccount: true` and a link to the console, no password step; same role already -> no-op; different role on same event -> 409 `already_on_event`.
- Remove the "owns events -> cannot be an operator" refusal (`invite-operator:158-163`, `manage-operator:144-150`): an organiser must be able to crew someone else's event.
- `handle_new_auth_user` can keep creating `role='director'` (every account may own events); per-event role lives in the membership table.
- `manage-operator` remove must delete the membership row, **not** ban the auth account or delete `leod_users`. Suspend must set membership `active`, not `leod_users.active`.
- Decide whether invited-only users should get the founder-welcome trial sequence (today they do).
- Rate limit key `payload->>team_owner` should become the event (or event owner).

---

## 8. Tests that pin the current model (will need updating)

`tests/deno/operators.test.ts` (asserts 409 on existing users, invited_by values), `tests/deno/session-auth.test.ts:130-136`, `tests/deno/restart-session.test.ts:121`, `tests/ai-proxy-plan.spec.ts` (mirrors `get_subscription_for_user`), `tests/rls.spec.ts:23`, `tests/sql/083-display-followups-probe.sql`, `093-apply-delay-probe.sql`, `095-event-scoped-writes-probe.sql`, `128-stage-messages-probe.sql`, `129-stage-messages-cancel-probe.sql`, `tests/e2e/console-boot-mock.ts:293-294`, `console-boot-harness.ts:135`, `console-pairing.spec.ts`, `billing.spec.ts:205`.

---

## 9. Riskiest dependencies (ranked)

1. **Five inline copies of the membership rule** outside the resolver: policies `owner_read_events`, `scoped_read_sessions`, `owner_read_reports`, `scoped_all_displays`, `scoped_all_sponsors`; functions `rpc_apply_delay`, `display_pair_link`, `display_rotate_secret`; TS `eventRole`. Rewriting only `cuedeck_event_role` leaves reads and pairing on the old model: a removed member keeps reading, a new member cannot see the event list.
2. **`manage-operator` remove bans the whole auth account** (`index.ts:130-140`). With shared logins, one organiser removing a crew member would lock that person out of every other organiser's events and their own.
3. **Plan resolution is per account and resolved once at boot**: invited directors get their own 3-day trial and are locked out at expiry; under multi-organiser the right plan is the event owner's, per event. Touches `get_subscription_for_user`, ai-proxy, redeem-code, `loadSubscription`, PLAN_LIMITS checks.
4. **`validate_event_log_role` trigger** rewrites `operator_role` to the global role on every log insert, so audit logs and reports would carry the wrong per-event role.
5. **Console role is global and loaded once** (`loadUserRole` 9218, ~15 `isDirector` gates, `roleLocked`, presence track). `switchEvent` (7132) never re-resolves it.

Verification: a separate read-only pass tried to refute risks 2, 3 and 4 and the `get_operators_with_last_seen` claim against the migrations. All four held. Defining migrations: `011_subscriptions.sql:75-100` (get_subscription_for_user, only search_path altered since), `039_validate_operator_role.sql:11-43` (trigger, still live), `20260316000000_isolate_operators.sql` (operators list).

Side notes found during the inventory (not part of this feature, not fixed):
- `owner_read_events`, `scoped_read_sessions`, `owner_read_reports` do not check `active`, so a suspended operator can still read the owner's events and sessions (writes are blocked).
- Setup-wizard invite (`cuedeck-console.html:9655`) ignores the `{ error }` from `functions.invoke`.
- `handle_first_login(p_user_id)` trusts a caller-supplied user id.
- `track_user_login()` exists but no trigger uses it.
