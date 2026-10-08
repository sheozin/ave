# Event Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CueDeck console access per event: a person is a member of one event with one role, one login can be on several organisers' events, an organiser can invite any email (new or existing account) to one event, and every route (screen, realtime, direct API, TVs, Edge Functions) enforces exactly that.

**Architecture:** A new table `leod_event_members(event_id, user_id, role, active, invited_by)` holds memberships; the creator of an event (`leod_events.created_by`) is always its director and is never stored. One resolver, `cuedeck_event_role(p_event_id)` (with the internal `cuedeck_event_role_of(p_event_id, p_user_id)`), answers "what is this person on this event", and every policy, RPC and the Edge Function helper `eventRole()` calls it or reads the same table the same way. Writes to memberships go only through the `invite-operator` and `manage-operator` Edge Functions, which are rewritten to work per event, enforce seats from the event owner's plan, and never ban a login. The console resolves the role and the plan per event on boot and on every event switch, groups the event switcher by organiser, and gets a per-event Team window.

**Tech Stack:** Postgres 15 on Supabase (SQL migrations, RLS, `SECURITY DEFINER` functions, rolled-back `DO` probes), Deno Edge Functions (`supabase-js` v2 from esm.sh), vanilla HTML/CSS/JS console (`cuedeck-console.html`, `cuedeck-i18n.js`), vitest 2.1 (node), deno test (run from vitest), Playwright 1.58 with system Chrome.

**Spec:** `docs/superpowers/specs/2026-10-08-event-teams-design.md` (approved 8 Oct 2026). Evidence for every dependency, with file:line: `docs/superpowers/specs/2026-10-08-event-teams-inventory.md`. Executors read both.

## Global Constraints

- **Release after GTR (12 Oct 2026).** Nothing from this plan is applied, deployed or pushed before 13 Oct. Build tasks only write and commit files.
- **Other session's files are off limits.** Never modify `cuedeck-checkin*`, `cuedeck-register*`, `supabase/functions/checkin-*`, `supabase/functions/_shared/checkin-*`, any `leod_checkin_*` table or function, `checkin_guard_results()`, or the check-in tests (`tests/checkin-*`, `tests/deno/checkin-*`, `tests/e2e/checkin-*`). `leod_checkin_operators` and `supabase/functions/checkin-invite-staff/index.ts` are reference only.
- **Migration numbers.** Reserved here: 130, 131, 132, 133, 134, 135 (129 was the latest on 8 Oct). Another session adds migrations, so right before writing each migration run `ls supabase/migrations | sort -V | tail -5` and `supabase db query --linked "select name from supabase_migrations.schema_migrations order by version desc limit 8"` (from the repo root, SELECT only). If the reserved number is taken, use the next free number and rename the migration file, the probe file, the `PROBE OK NNN` text and every reference in later tasks of this plan in the same commit.
- **Database changes are applied by the controller only**, in the release task, after a security review, with the Supabase MCP `apply_migration` (name `NNN_<file stem>`, as `128_stage_messages` was) on project `sawekpguemzvuvvulfbc`, and probes run with `execute_sql` (one statement per call: every probe is a single `DO` block). Each DB task delivers a migration file plus a probe `tests/sql/NNN-*-probe.sql` (template: `tests/sql/128-stage-messages-probe.sql`): a single `DO` block that ends in `RAISE EXCEPTION 'PROBE OK NNN: …'`, so everything it wrote rolls back. The controller runs each probe once before applying and records that it fails with the error the task states.
- **Live bodies, not old migrations.** Every function and policy this plan rewrites starts from the body fetched live on 8 Oct with `pg_get_functiondef` / `pg_policies`. Each DB task quotes the live body it starts from.
- **Since migration 079:** every new or replaced function states its grants explicitly (`REVOKE ALL … FROM PUBLIC, anon[, authenticated]` then `GRANT EXECUTE … TO …`). Every `SECURITY DEFINER` function has `SET search_path = public` (the live trigger functions that already use `public, extensions, pg_temp` keep it) and takes the caller from `auth.uid()`, never from an argument.
- **Guards.** `checkin_guard_results()` must stay green for `public_tables_rls_on`, `leod_writes_not_unconditional`, `security_definer_search_path` and `checkin_rpcs_refuse_strangers` (G10 calls every authenticated-executable public function whose first argument is `p_event_id uuid` as a stranger: a VOLATILE one must raise 42501, a STABLE one must answer NULL or false). The new console guard lives in a new function `cuedeck_guard_results()` (migration 132), not inside the check-in session's `checkin_guard_results()`.
- **Edge Functions:** Deno, `corsHeaders(req)` is a function (call it once and spread the result). Handler tests run against a stubbed Supabase under `tests/deno/*.test.ts`, started from vitest by `tests/<name>.spec.ts` (`spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', …])`). Deployment is the controller's, with `bash scripts/deploy-functions.sh <name> …` from the main checkout; it refuses uncommitted source.
- **Console:** single file `cuedeck-console.html` plus `cuedeck-i18n.js`. Redesign rules hold: colour follows the move; HOLD and END never move; End and Cancel take two presses through `armOrConfirm`; the press guard (`pressOk(event,this)`) on every new action button; `data-fk` focus keys on every re-rendered interactive element and `restoreFocus(focusKey())` around re-renders; the inspector never jumps; every new string goes through `t()` / `tf()` and exists in en, ar, pl and de under `cc.`, in sentence case, with no em-dashes (U+2014); SVG icons only (`icon('<name>')`, never emoji); colours only as tokens defined in `:root`, and `tests/console-colour-ratchet.spec.ts` `BUDGET` only goes down (lower it to the printed count in the task that removes literals); touch targets at least 44 px under `pointer: coarse`. Never name a local variable `t`.
- **Tests:**
  - Console e2e uses `tests/e2e/console-boot-mock.ts` (serves real Inter, `afterBootReread()`, `rtPush()`); the show-safety specs use `tests/e2e/console-boot-harness.ts`.
  - Serve the checkout under test on a private port and run with the console config and a global timeout: `(python3 -m http.server 7293 --bind 127.0.0.1 --directory /Users/sheriff/AVE-Production-Console-teams >/dev/null 2>&1 &)` then `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts <spec> --global-timeout=900000`. Never use port 7230.
  - The console mock pauses the page clock after boot (`freeze`); a test that awaits network work after boot (an event switch) steps the clock with `page.clock.runFor()` while it waits (helper `switchTo` in Task 3.1).
  - Tests that pin the old model (inventory §8) are updated in the task that changes the behaviour they pin, keeping what each assertion protects. An assertion is never deleted to make a test pass; where the old behaviour is gone by design (ban on remove, 409 for an existing email) the test is rewritten to assert the new rule for the same risk.
- **Git:** work in the worktree `/Users/sheriff/AVE-Production-Console-teams` on branch `feat/event-teams` (created by the controller before Task 1.1, see "Execution order"). `git status --short` first; `git add` explicit file paths only, and the same pathspec on `git commit` (`git commit -m "…" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`); never `git add -A`, `git add .`, `git add -p` or `git commit -a`. One commit per task. Never push from a build task; only the release tasks push.
- **No invented data.** Fixtures use the existing fictional demo names (Nilegate Events, Northwind Events, Atlas Live, GTR North Africa 2026). No live account, email or plan appears in a test.

## Review Focus

Five inputs the spec implies that are most likely to bite a person using this, each pinned by a named test in its owning task.

1. **A person whose global role is not their event role.** The signup trigger makes every account `director` in `leod_users.role`; a crew member invited as stage must be stage everywhere on that event: transitions, delays, the log stamp, the console lock. Tests: probe 131 check 4 (`validate_event_log_role` stamps `stage` for a global director), `tests/deno/session-auth.test.ts` case `a global director who is stage on this event cannot cancel` (Task 2.2), e2e `teams: the role follows the event, both ways` (Task 3.1).
2. **One login on two organisers' events, switching back and forth, and being removed while the console is open.** Role lock, View as, presence role and the default filter must follow each switch, and a removed event must be dropped on the next switch, not opened with a stale role. Tests: e2e `teams: the role follows the event, both ways`, `teams: presence tracks the role on the current event`, `teams: an event you were removed from is dropped on switch` (Task 3.1); probe 132 check 6.
3. **Two directors inviting into the last seat at once.** Exactly one gets it; the other is told the team is full and no orphan account or membership is left. Tests: probe 133 check 5 (the seat trigger takes an advisory lock), `tests/deno/operators.test.ts` `invite: a seat taken while inviting (23514) withdraws the new account` (Task 2.3).
4. **An existing account typed with other case or spaces** (` Theirs@Y.Test `). It must join that account, never create a second one or fail. Test: `invite: an existing email typed in another case joins that account` (Task 2.3).
5. **An organiser who downgrades below their team size.** Nobody is cut off mid-show, role changes and suspend/reactivate still work, only new invites are refused, and the Team window says so. Tests: probe 133 check 3, e2e `team: over the seat count after a downgrade` (Task 3.4).

---

## Execution order and releases

Build order is the task order below. Releases:

- **Release A (Task 4.1) ships stages 1 and 2 together.** Stage 1 alone is not safe to ship: once access reads `leod_event_members`, the old `invite-operator` (which writes only `leod_users.invited_by`) would create crew with no access at all, and the old `manage-operator` would suspend and ban through `leod_users`. The migrations go first, then the 14 functions immediately after, in one sitting. Release A is compatible with the console that is live before it: the old console sends `event_id` on invites, its team list (`get_operators_with_last_seen`) is rewritten on memberships, and `manage-operator` without `event_id` acts on every event the caller created.
- **Release B (Task 4.2) ships stage 3 (the console)**, after Release A is verified live. It cannot go first: it calls `cuedeck_my_events` and `cuedeck_event_team` from migration 133. Migration 135 (private channel policies, Task 3.5) is applied in Release B right before the console push: its policies only govern private channels, so the live console is unaffected until the push switches it.
- **Release C (Task 4.3) is Sherif turning off "Allow public access"** for Realtime, after Release B and after the check-in session has moved its two public channels to private. It is last because the setting refuses every public channel in the project.
- **Task 2.5 (daily guard run and its watch, migration 134) ships in Release A**: it only needs migration 132 and touches no console code; its Vercel half (`api/cron/health-check.ts`) deploys with Release A's push.

Before Task 1.1 the controller creates the worktree (once):

```bash
cd /Users/sheriff/AVE-Production-Console
git status --short
git fetch cuedeck && git fetch origin
git worktree add -b feat/event-teams /Users/sheriff/AVE-Production-Console-teams main
ln -s /Users/sheriff/AVE-Production-Console/node_modules /Users/sheriff/AVE-Production-Console-teams/node_modules
```

`node_modules` is a symlink and is never staged. Every build task runs in `/Users/sheriff/AVE-Production-Console-teams`.

## File map

| File | Created or changed by |
|---|---|
| `supabase/migrations/130_event_members.sql`, `tests/sql/130-event-members-probe.sql` | created 1.1 |
| `supabase/migrations/131_event_members_functions.sql`, `tests/sql/131-event-members-functions-probe.sql` | created 1.2 |
| `supabase/migrations/132_event_teams_guard.sql`, `tests/sql/132-event-teams-isolation-probe.sql` | created 1.3 |
| `supabase/migrations/133_event_teams_server.sql`, `tests/sql/133-event-teams-server-probe.sql` | created 2.1 |
| `supabase/migrations/134_cuedeck_guard_schedule.sql`, `tests/sql/134-guard-schedule-probe.sql`, `supabase/functions/cuedeck-guard-alert/index.ts`, `tests/deno/guard-alert.test.ts`, `tests/guard-alert.spec.ts`, `tests/health-check-guards.spec.ts` | created 2.5 |
| `api/cron/health-check.ts`, `scripts/deploy-functions.sh` | 2.5 |
| `supabase/migrations/135_cuedeck_realtime_private.sql`, `tests/sql/135-realtime-private-probe.sql` | created 3.5 |
| `tests/e2e/console-show-safety-boot.spec.ts` (signage topic names the event) | 3.5 |
| `scripts/check-realtime-private.mjs` | created 4.3 |
| `tests/sql/095-event-scoped-writes-probe.sql`, `tests/sql/128-stage-messages-probe.sql`, `tests/rls.spec.ts` | updated 1.1 (fixtures and model for memberships) |
| `tests/sql/083-display-followups-probe.sql`, `tests/sql/093-apply-delay-probe.sql` | updated 1.2 |
| `supabase/functions/_shared/members.ts` | created 2.2 |
| `supabase/functions/_shared/transition.ts`, `supabase/functions/apply-delay/index.ts` (comment only), `tests/deno/session-auth.test.ts` | 2.2 |
| `supabase/functions/invite-operator/index.ts`, `supabase/functions/manage-operator/index.ts`, `supabase/functions/_shared/invite-email.ts`, `tests/deno/operators.test.ts` | 2.3 |
| `supabase/functions/_shared/plan.ts`, `supabase/functions/ai-proxy/index.ts`, `supabase/functions/redeem-code/index.ts`, `tests/deno/plan-owner.test.ts`, `tests/plan-owner.spec.ts`, `tests/ai-proxy-plan.spec.ts` | 2.4 |
| `tests/e2e/console-boot-mock.ts`, `tests/e2e/console-boot-harness.ts` | extended 3.1 (my events, account role, recorded calls), 3.3 (PATCH rows), 3.4 (team) |
| `tests/e2e/console-event-teams.spec.ts` | created 3.1, extended 3.2, 3.3, 3.4 |
| `cuedeck-console.html`, `cuedeck-i18n.js` | 3.1, 3.2, 3.3, 3.4 |
| `cuedeck-agent-1-incident-advisor.js`, `cuedeck-agent-2-cue-engine.js`, `cuedeck-agent-3-report-generator.js`, `tests/console-ai-event-id.spec.ts` | 3.2 (send `event_id` to ai-proxy) |
| `tests/e2e/console-show-safety.spec.ts` (switch test answers the new RPC) | 3.1 |
| `tests/e2e/session-people.spec.ts` (SP13 states an own plan) | 3.2 |
| `tests/e2e/console-forbidden.spec.ts`, `tests/console-colour-ratchet.spec.ts`, `tests/event-teams-no-invited-by.spec.ts` | 3.4 |

Unchanged on purpose: `tests/deno/restart-session.test.ts` (its caller is the event's creator, which needs no membership), `tests/sql/129-stage-messages-cancel-probe.sql` (owner only), `tests/e2e/billing.spec.ts:205` (reads migration 011's text, which is not edited), `tests/e2e/console-pairing.spec.ts` (sets `S.userRole` directly and mocks the two RPCs; their answers keep their shape).

## Task list

| Stage | Task | One line |
|---|---|---|
| 1 | 1.1 | `leod_event_members`, resolver on it, backfill, the five inline policies rewritten, displays and sponsors narrowed, invited directors edit events (migration 130) |
| 1 | 1.2 | `rpc_apply_delay`, `display_pair_link`, `display_rotate_secret`, `validate_event_log_role`, `get_operators_with_last_seen`, `get_subscription_for_user` on the resolver (migration 131) |
| 1 | 1.3 | `cuedeck_guard_results()` with the `invited_by` guard, and the spec §8 isolation matrix probe (migration 132) |
| 2 | 2.1 | Seats from the owner's plan enforced on insert, `cuedeck_my_events`, `cuedeck_event_team`, no founder welcome for members-only (migration 133) |
| 2 | 2.2 | `eventRole()` in `_shared/transition.ts` reads memberships (9 transitions and apply-delay follow) |
| 2 | 2.3 | `invite-operator` (any email, per event, seats, owner rate limit, "added to" email) and `manage-operator` (per event, never bans) |
| 2 | 2.4 | Plan resolver: ai-proxy uses the event owner's plan, redeem-code the caller's own |
| 2 | 2.5 | `cuedeck_guard_results()` runs daily (pg_cron), every run recorded, alert on a failing guard or a missing or stale run, the watcher watched (migration 134) |
| 3 | 3.1 | Console role per event on boot and switch; check-in staff with console memberships let in |
| 3 | 3.2 | Console plans: owner's plan per event, no trial for members-only, own events only count, billing hidden, AI calls carry the event |
| 3 | 3.3 | Event switcher grouped by organiser; invited directors edit but never deactivate |
| 3 | 3.4 | Team window per event with seats, invite and manage per event, wizard invite errors read, `invited_by` code guard |
| 3 | 3.5 | Private realtime channels per event: `realtime.messages` policies, console joins private (migration 135) |
| 4 | 4.1 | Release A: stages 1 and 2 (migrations 130 to 134 with probes, 15 functions, the health-check cron) |
| 4 | 4.2 | Release B: stage 3 (console), with migration 135 |
| 4 | 4.3 | Release C: Sherif turns off public Realtime channels; controller verifies |

16 tasks: 3 in stage 1, 5 in stage 2, 5 in stage 3, 3 release tasks.

---

# Stage 1: Membership, resolver, backfill

### Task 1.1: Membership table, resolver and the five inline policies (migration 130)

Spec §2, §3 (resolver, five policies, displays and sponsors narrowed, suspended members lose reads), §7 (backfill), §9.1 (invited director edits the event, only the creator deletes or deactivates).

**Files:**
- Create: `supabase/migrations/130_event_members.sql`
- Create: `tests/sql/130-event-members-probe.sql`
- Modify: `tests/sql/095-event-scoped-writes-probe.sql` (fixture after the second event insert, around line 41; the read check at lines 151-156)
- Modify: `tests/sql/128-stage-messages-probe.sql` (fixture after the second event insert, around line 43)
- Modify: `tests/rls.spec.ts` (policy model lines 39-44, new describe block at the end)

**Interfaces:**
- Consumes: nothing from earlier tasks. Live bodies (8 Oct) it replaces:
  - `cuedeck_event_role(p_event_id uuid) RETURNS text` (SQL, STABLE, SECDEF): `'director'` if `e.created_by = auth.uid()`, else `leod_users.role` where `u.invited_by = e.created_by AND u.active IS NOT FALSE AND u.role IN (6 roles)`.
  - `owner_read_events` (SELECT): `created_by = auth.uid() OR created_by IN (SELECT invited_by FROM leod_users WHERE id = auth.uid() AND invited_by IS NOT NULL)`.
  - `scoped_read_sessions`, `owner_read_reports` (SELECT): `event_id IN (SELECT id FROM leod_events WHERE created_by = auth.uid() OR created_by IN (… invited_by …))`, no `active` check.
  - `scoped_all_displays`, `scoped_all_sponsors` (ALL): same shape with `active IS NOT FALSE`, any member role writes.
  - `owner_update_events` (UPDATE): `created_by = auth.uid()` in USING and WITH CHECK.
- Produces (later tasks rely on these exact names):
  - table `public.leod_event_members(event_id uuid, user_id uuid, role text, active boolean, invited_by uuid, created_at timestamptz, updated_at timestamptz)`, primary key `(event_id, user_id)`; role in `director, stage, av, interp, reg, signage`.
  - `public.cuedeck_event_role_of(p_event_id uuid, p_user_id uuid) RETURNS text`: internal (service_role and SQL only).
  - `public.cuedeck_event_role(p_event_id uuid) RETURNS text`: unchanged signature and grants.
  - trigger function `public.leod_event_members_guard()` (Task 2.1 replaces its body and keeps every check it has here).
  - trigger function `public.leod_events_guard_member_update()`.
  - policies `owner_read_events`, `scoped_read_sessions`, `owner_read_reports`, `events_director_update`, `displays_member_read`, `displays_signage_insert`, `displays_signage_update`, `displays_signage_delete`, `sponsors_member_read`, `sponsors_signage_insert`, `sponsors_signage_update`, `sponsors_signage_delete`, `event_members_member_read`.
  - Error contract of the membership table: a second membership for the same person and event is `23505`; a bad role, the creator as a member, or moving a row to another event or person is `23514` (`check_violation`) with a message starting `owner_not_member` or `membership event and user cannot change`.

- [ ] **Step 1: Check the migration number.** Run the two commands from Global Constraints. Expected: the highest number is 129 (or the other session's latest). If 130 is taken, renumber as Global Constraints says.

- [ ] **Step 2: Write the failing model test** in `tests/rls.spec.ts`. Append at the end of the file:

```ts
describe('130: event teams', () => {
  it('32 signage displays and sponsors are event-scoped, not open to any signed-in user', () => {
    for (const table of ['leod_signage_displays', 'leod_signage_sponsors']) {
      const p = POLICIES.find(x => x.table === table && x.role === 'authenticated')!;
      expect(p.condition).toBe('event_member');
    }
  });
  it('33 nobody client-side writes leod_event_members; members read their event roster', () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const op of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        expect(canDo(role, 'leod_event_members', op)).toBe(false);
      }
    }
    expect(canDo('anon', 'leod_event_members', 'SELECT')).toBe(false);
    expect(canDo('authenticated', 'leod_event_members', 'SELECT')).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and see it fail.**

Run: `npx vitest run tests/rls.spec.ts`
Expected: FAIL in `32` (`expected 'always' to be 'event_member'`) and `33` (`expected false to be true`).

- [ ] **Step 4: Update the model.** In `tests/rls.spec.ts` replace the four lines for displays and sponsors (lines 39-44, from `// leod_signage_displays (anon: none since 080…` to the sponsors `authenticated` entry) with:

```ts
  // leod_signage_displays (anon: none since 080; the display page reads through display_feed()).
  // authenticated (130): any member of the event reads; director and signage write
  { table: 'leod_signage_displays', role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_signage_displays', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'event_member' },
  // leod_signage_sponsors (anon: none since 083; the display reads sponsors through display_feed()).
  // authenticated (130): any member of the event reads; director and signage write
  { table: 'leod_signage_sponsors', role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_signage_sponsors', role: 'authenticated',  ops: ['SELECT','INSERT','UPDATE','DELETE'], condition: 'event_member' },
  // leod_event_members (130): members read their event's roster; writes are server-side only
  // (invite-operator, manage-operator), like leod_stage_messages
  { table: 'leod_event_members',    role: 'anon',           ops: [],                                condition: 'never' },
  { table: 'leod_event_members',    role: 'authenticated',  ops: ['SELECT'],                        condition: 'event_member' },
```

Run: `npx vitest run tests/rls.spec.ts`
Expected: PASS (all tests, including the earlier 1 to 31).

- [ ] **Step 5: Write the probe** `tests/sql/130-event-members-probe.sql`:

```sql
-- tests/sql/130-event-members-probe.sql
-- Run after 130 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 130'. Everything is rolled back by the final RAISE.
-- Before 130 is applied it fails with: relation "leod_event_members" does not exist.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();   -- creates v_ev: its director by creation
  v_dir    uuid := gen_random_uuid();   -- director member of v_ev
  v_stage  uuid := gen_random_uuid();   -- stage member of v_ev
  v_av     uuid := gen_random_uuid();   -- av member of v_ev
  v_sign   uuid := gen_random_uuid();   -- signage member of v_ev
  v_off    uuid := gen_random_uuid();   -- director member of v_ev, suspended
  v_legacy uuid := gen_random_uuid();   -- leod_users.invited_by = v_owner and no membership
  v_other  uuid := gen_random_uuid();   -- another organiser, creates v_ev2
  v_ev     uuid;
  v_ev2    uuid;
  v_ev3    uuid;
  v_sid    uuid;
  v_disp   uuid;
  v_spon   uuid;
  v_role   text;
  v_state  text;
  v_n      int;
  v_m      int;
  v_failed boolean;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_dir, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u;
  -- every account's global role is the signup default (director): roles now
  -- come from memberships. The old invited_by link is set on v_legacy only,
  -- to prove it no longer gives anything.
  INSERT INTO leod_users (id, email, role, invited_by, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', CASE WHEN u = v_legacy THEN v_owner END, true
    FROM unnest(ARRAY[v_owner, v_dir, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 130', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 130 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe session', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV') RETURNING id INTO v_disp;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'Probe sponsor') RETURNING id INTO v_spon;
  INSERT INTO leod_reports (event_id, report_data) VALUES (v_ev, '{}');
  INSERT INTO leod_event_members (event_id, user_id, role, active, invited_by) VALUES
    (v_ev, v_dir,   'director', true,  v_owner),
    (v_ev, v_stage, 'stage',    true,  v_owner),
    (v_ev, v_av,    'av',       true,  v_owner),
    (v_ev, v_sign,  'signage',  true,  v_owner),
    (v_ev, v_off,   'director', false, v_owner);

  -- 1. the resolver: the creator is director; members have their role on
  --    their event only; suspended members, the invited_by link alone and
  --    strangers have nothing; a signed-in caller with no user id has nothing
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner, v_ev, 'director'), (v_dir, v_ev, 'director'), (v_stage, v_ev, 'stage'), (v_av, v_ev, 'av'),
      (v_sign, v_ev, 'signage'), (v_off, v_ev, NULL), (v_legacy, v_ev, NULL), (v_other, v_ev, NULL),
      (v_other, v_ev2, 'director'), (v_dir, v_ev2, NULL)) AS x(uid, ev, expected)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_role := cuedeck_event_role(v_r.ev);
    RESET ROLE;
    IF v_role IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: % on % got %, expected %', v_r.uid, v_r.ev, v_role, v_r.expected;
    END IF;
    IF cuedeck_event_role_of(v_r.ev, v_r.uid) IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: cuedeck_event_role_of disagrees for %', v_r.uid;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_role := cuedeck_event_role(v_ev);
  RESET ROLE;
  IF v_role IS NOT NULL THEN RAISE EXCEPTION 'PROBE FAIL 1: no user id got %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 2. the table: one membership per person and event, six roles only, the
  --    creator never a member, event and person fixed once written
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_dir, 'stage');
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23505' THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a second membership on one event gave %', coalesce(v_state, 'no error');
  END IF;
  FOR v_r IN SELECT * FROM (VALUES ('admin'), ('pending'), ('checkin_staff'), ('')) AS x(r) LOOP
    v_state := NULL;
    BEGIN
      INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_legacy, v_r.r);
    EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: role "%" accepted', v_r.r; END IF;
  END LOOP;
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_owner, 'stage');
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: the creator was stored as a member'; END IF;
  v_state := NULL;
  BEGIN
    UPDATE leod_event_members SET user_id = v_owner WHERE event_id = v_ev AND user_id = v_stage;
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: a membership moved to another person'; END IF;
  v_state := NULL;
  BEGIN
    UPDATE leod_event_members SET event_id = v_ev2 WHERE event_id = v_ev AND user_id = v_stage;
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: a membership moved to another event'; END IF;
  IF cuedeck_event_role_of(v_ev, v_owner) IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 2: creator demoted'; END IF;
  v_checks := v_checks + 1;

  -- 3. members read their event's roster (suspended, legacy and strangers do
  --    not); nobody signed in writes it, not even the creator
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 5), (v_stage, 5), (v_off, 0), (v_legacy, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM leod_event_members WHERE event_id = v_ev;
    RESET ROLE;
    IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 3: % reads % roster rows, expected %', v_r.uid, v_n, v_r.expected; END IF;
  END LOOP;
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner, 'INSERT INTO leod_event_members (event_id, user_id, role) VALUES ($1, $2, ''stage'')'),
      (v_dir,   'UPDATE leod_event_members SET role = ''director'' WHERE event_id = $1'),
      (v_owner, 'DELETE FROM leod_event_members WHERE event_id = $1'),
      (v_stage, 'UPDATE leod_event_members SET active = true WHERE event_id = $1')) AS x(uid, stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev, v_legacy;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: a client write ran: %', v_r.stmt; END IF;
  END LOOP;
  IF (SELECT count(*) FROM leod_event_members WHERE event_id = v_ev) <> 5
     OR NOT EXISTS (SELECT 1 FROM leod_event_members WHERE event_id = v_ev AND user_id = v_off AND NOT active) THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused write changed the roster';
  END IF;
  v_checks := v_checks + 1;

  -- 4. reads follow the resolver: the event row, its sessions, reports,
  --    displays and sponsors (one row each) for every member; nothing for
  --    the suspended member, the invited_by link alone, or a stranger
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 5), (v_dir, 5), (v_stage, 5), (v_av, 5), (v_sign, 5),
                                   (v_off, 0), (v_legacy, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT (SELECT count(*) FROM leod_events WHERE id = v_ev)
         + (SELECT count(*) FROM leod_sessions WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_reports WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_signage_displays WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_signage_sponsors WHERE event_id = v_ev)
      INTO v_n;
    RESET ROLE;
    IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 4: % reads % rows, expected %', v_r.uid, v_n, v_r.expected; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 5. displays and sponsors: director and signage write; stage, av, the
  --    suspended member and strangers do not (before 130 any member could)
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 1), (v_dir, 1), (v_sign, 1), (v_stage, 0), (v_av, 0),
                                   (v_off, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE leod_signage_displays SET name = name WHERE id = v_disp;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE leod_signage_sponsors SET name = name WHERE id = v_spon;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    RESET ROLE;
    IF v_n <> v_r.expected OR v_m <> v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 5: % updated % displays and % sponsors, expected %', v_r.uid, v_n, v_m, v_r.expected;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'By signage');
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'By signage');
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES
      ('INSERT INTO leod_signage_displays (event_id, name) VALUES ($1, ''By av'')'),
      ('INSERT INTO leod_signage_sponsors (event_id, name) VALUES ($1, ''By av'')')) AS x(stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: av ran %', v_r.stmt; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_signage_displays WHERE event_id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 5: av deleted % displays', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_signage_displays WHERE event_id = v_ev AND name = 'By signage';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 5: signage deleted % displays, expected 1', v_n; END IF;
  v_checks := v_checks + 1;

  -- 6. the event row: an invited director edits its details (spec §9.1) but
  --    not its owner, origin or active flag; only the creator deletes or
  --    deactivates it; nobody gives it away; other members change nothing
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE leod_events SET name = 'Renamed by director', venue = 'Hall 2' WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 OR (SELECT name FROM leod_events WHERE id = v_ev) <> 'Renamed by director' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: the invited director could not edit the event';
  END IF;
  FOR v_r IN SELECT * FROM (VALUES
      (v_dir,   'UPDATE leod_events SET active = false WHERE id = $1'),
      (v_dir,   'UPDATE leod_events SET created_by = $2 WHERE id = $1'),
      (v_dir,   'UPDATE leod_events SET created_via = ''checkin'' WHERE id = $1'),
      (v_owner, 'UPDATE leod_events SET created_by = $2 WHERE id = $1')) AS x(uid, stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev, v_dir;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: % ran %', v_r.uid, v_r.stmt; END IF;
  END LOOP;
  FOR v_r IN SELECT * FROM (VALUES (v_stage), (v_av), (v_sign), (v_off), (v_legacy), (v_other)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE leod_events SET name = 'Hijacked' WHERE id = v_ev;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: % edited the event', v_r.uid; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_events WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: the invited director deleted the event'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE leod_events SET active = false WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE leod_events SET active = true WHERE id = v_ev;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 6: the creator could not deactivate the event'; END IF;
  v_checks := v_checks + 1;

  -- 7. a new event is readable by its creator in the statement that creates
  --    it (INSERT ... RETURNING, as the console does): the resolver cannot
  --    see a row inserted by the statement it runs in, so owner_read_events
  --    keeps created_by = auth.uid() next to it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_events (name, date, event_start, event_end, created_by)
    VALUES ('Probe 130 new', current_date + 31, '09:00', '18:00', v_other) RETURNING id INTO v_ev3;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 7: INSERT ... RETURNING of a new event refused: %', SQLERRM;
  END;
  RESET ROLE;
  IF v_ev3 IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 7: no id returned'; END IF;
  v_checks := v_checks + 1;

  -- 8. privileges, RLS, and the rewritten policies
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leod_event_members'::regclass)
     OR has_table_privilege('anon', 'public.leod_event_members', 'SELECT')
     OR has_table_privilege('anon', 'public.leod_event_members', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.leod_event_members', 'SELECT')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'INSERT')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'DELETE')
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.leod_event_members'::regclass AND polcmd <> 'r')
     OR has_function_privilege('anon', 'public.cuedeck_event_role(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_event_role(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_event_role_of(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_role_of(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.leod_event_members_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.leod_events_guard_member_update()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 8: privileges';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('owner_read_events', 'scoped_read_sessions', 'owner_read_reports', 'events_director_update',
                        'displays_member_read', 'displays_signage_insert', 'displays_signage_update', 'displays_signage_delete',
                        'sponsors_member_read', 'sponsors_signage_insert', 'sponsors_signage_update', 'sponsors_signage_delete',
                        'event_members_member_read')
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') LIKE '%cuedeck_event_role%'
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') NOT LIKE '%invited_by%';
  IF v_n <> 13 THEN RAISE EXCEPTION 'PROBE FAIL 8: % of 13 policies call the resolver without invited_by', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND policyname IN ('scoped_all_displays', 'scoped_all_sponsors', 'owner_update_events')) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: an old policy is still there';
  END IF;
  v_checks := v_checks + 1;

  -- 9. guards that must stay green
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 9: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                FROM checkin_guard_results()
                                               WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                               'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 130: % checks passed (rolled back)', v_checks;
END
$probe$;
```

- [ ] **Step 6 (controller): run the probe before the migration.** `execute_sql` on `sawekpguemzvuvvulfbc` with the whole file. Expected: error `relation "leod_event_members" does not exist`. Record it in the task notes. (The implementer does not run probes.)

- [ ] **Step 7: Write the migration** `supabase/migrations/130_event_members.sql`:

```sql
-- ============================================================
-- CueDeck Migration 130: event teams, part 1 (membership and the resolver)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §2, §3, §7, §9.1
-- Evidence: docs/superpowers/specs/2026-10-08-event-teams-inventory.md §1, §9.1
--
-- Access becomes per event: a person is a member of one event with one
-- role. The creator (leod_events.created_by) is always director and is
-- never stored as a member, so no row can demote the owner.
--
-- cuedeck_event_role(p_event_id) keeps its name, signature and grants and
-- now reads leod_event_members. The five policies that carried their own
-- copy of the old rule (leod_users.invited_by) are rewritten to call it:
-- owner_read_events, scoped_read_sessions, owner_read_reports,
-- scoped_all_displays and scoped_all_sponsors (the last two split per command).
-- Changes in who may do what, all from the spec:
--   * suspended members (active = false) lose reads too (they kept them);
--   * displays and sponsors: any member reads, director and signage write
--     (any member wrote, even av);
--   * an invited director edits the event row (name, date, venue, times,
--     brand) but never its owner, origin or active flag; only the creator
--     deletes or deactivates it (trigger leod_events_guard_member_update).
--
-- Backfill: each user with invited_by set gets one membership per event of
-- that owner, with their current role and active flag (live 2026-10-08:
-- 1 user, 1 event). leod_users.invited_by and leod_users.role stay for the
-- release, unused for access; migration 132 adds the guard that keeps it so.
--
-- Live bodies this replaces (pg_get_functiondef / pg_policies, 2026-10-08):
--   cuedeck_event_role: CASE WHEN e.created_by = auth.uid() THEN 'director'
--     ELSE (SELECT u.role FROM leod_users u WHERE u.id = auth.uid()
--           AND u.invited_by = e.created_by AND u.active IS NOT FALSE
--           AND u.role IN (6 roles)) END FROM leod_events e WHERE e.id = p_event_id
--   owner_read_events, scoped_read_sessions, owner_read_reports,
--   scoped_all_displays, scoped_all_sponsors, owner_update_events: see the
--   inventory §1c and §1d.
-- ============================================================

-- ── Table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leod_event_members (
  event_id   uuid NOT NULL REFERENCES public.leod_events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('director', 'stage', 'av', 'interp', 'reg', 'signage')),
  active     boolean NOT NULL DEFAULT true,
  invited_by uuid,               -- who added the person (audit only, never read for access)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leod_event_members_pkey PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS leod_event_members_user ON public.leod_event_members (user_id);
COMMENT ON TABLE public.leod_event_members IS
  'Event teams (130): one role per person per event. The event creator is never a row; cuedeck_event_role() is the only reader for access.';

-- Read only for clients; every write goes through invite-operator and
-- manage-operator (service role), as leod_stage_messages goes through its RPCs.
ALTER TABLE public.leod_event_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leod_event_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leod_event_members TO authenticated;
GRANT ALL ON public.leod_event_members TO service_role;

-- ── Resolver ────────────────────────────────────────────────
-- cuedeck_event_role_of: the role of any person on an event, for the
-- database itself and the service role (rpc_apply_delay checks the
-- operator an Edge Function names; validate_event_log_role stamps log rows).
-- Never callable by clients: it takes a user id.
CREATE OR REPLACE FUNCTION public.cuedeck_event_role_of(p_event_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN e.created_by = p_user_id THEN 'director'
           ELSE (SELECT m.role
                   FROM leod_event_members m
                  WHERE m.event_id = e.id
                    AND m.user_id = p_user_id
                    AND m.active)
         END
    FROM leod_events e
   WHERE e.id = p_event_id
     AND p_user_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_role_of(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_role_of(uuid, uuid) TO service_role;

-- cuedeck_event_role: the caller's role on an event, or NULL. Same name,
-- signature and grants as before; every policy and RPC that calls it
-- follows the new model.
CREATE OR REPLACE FUNCTION public.cuedeck_event_role(p_event_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cuedeck_event_role_of(p_event_id, auth.uid())
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_role(uuid) TO authenticated, service_role;

-- ── Membership guard ────────────────────────────────────────
-- The creator is the event's director by creation and is never a member
-- (a row could otherwise be edited to demote them). A membership never
-- moves to another event or person. Migration 133 adds the seat check.
CREATE OR REPLACE FUNCTION public.leod_event_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'membership event and user cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM leod_events e WHERE e.id = NEW.event_id AND e.created_by = NEW.user_id) THEN
    RAISE EXCEPTION 'owner_not_member: the creator of an event is its director and is never a member'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_event_members_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_leod_event_members_guard ON public.leod_event_members;
CREATE TRIGGER trg_leod_event_members_guard
  BEFORE INSERT OR UPDATE ON public.leod_event_members
  FOR EACH ROW EXECUTE FUNCTION public.leod_event_members_guard();

-- ── Backfill (spec §7) ──────────────────────────────────────
-- One active membership per event of the owner, with the user's current
-- role and active flag. Nobody gains or loses anything they could do,
-- except what the spec removes: a suspended member's reads, and pending or
-- check-in-only rows that named an owner (no member role, so no row).
INSERT INTO public.leod_event_members (event_id, user_id, role, active, invited_by)
SELECT e.id, u.id, u.role, u.active IS NOT FALSE, u.invited_by
  FROM leod_users u
  JOIN leod_events e ON e.created_by = u.invited_by
  JOIN auth.users a ON a.id = u.id
 WHERE u.invited_by IS NOT NULL
   AND u.role IN ('director', 'stage', 'av', 'interp', 'reg', 'signage')
   AND e.created_by <> u.id
ON CONFLICT (event_id, user_id) DO NOTHING;

-- ── Policies: one rule for access ───────────────────────────
DROP POLICY IF EXISTS event_members_member_read ON public.leod_event_members;
CREATE POLICY event_members_member_read ON public.leod_event_members FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

-- leod_events: created_by = auth.uid() stays next to the resolver because an
-- INSERT ... RETURNING by the creator is checked against this policy in the
-- statement that inserts the row, and the resolver (a STABLE function) cannot
-- see that row yet. It is the creator half of the same rule, on the row itself.
DROP POLICY IF EXISTS owner_read_events ON public.leod_events;
CREATE POLICY owner_read_events ON public.leod_events FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR cuedeck_event_role(id) IS NOT NULL);

-- An invited director edits the event (spec §9.1); the trigger below keeps
-- the owner, the origin and the active flag to the creator.
DROP POLICY IF EXISTS owner_update_events ON public.leod_events;
DROP POLICY IF EXISTS events_director_update ON public.leod_events;
CREATE POLICY events_director_update ON public.leod_events FOR UPDATE TO authenticated
  USING (cuedeck_event_role(id) = 'director')
  WITH CHECK (cuedeck_event_role(id) = 'director');

DROP POLICY IF EXISTS scoped_read_sessions ON public.leod_sessions;
CREATE POLICY scoped_read_sessions ON public.leod_sessions FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

DROP POLICY IF EXISTS owner_read_reports ON public.leod_reports;
CREATE POLICY owner_read_reports ON public.leod_reports FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

DROP POLICY IF EXISTS scoped_all_displays ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_member_read ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_insert ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_update ON public.leod_signage_displays;
DROP POLICY IF EXISTS displays_signage_delete ON public.leod_signage_displays;
CREATE POLICY displays_member_read ON public.leod_signage_displays FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);
CREATE POLICY displays_signage_insert ON public.leod_signage_displays FOR INSERT TO authenticated
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY displays_signage_update ON public.leod_signage_displays FOR UPDATE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'))
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY displays_signage_delete ON public.leod_signage_displays FOR DELETE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'));

DROP POLICY IF EXISTS scoped_all_sponsors ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_member_read ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_insert ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_update ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS sponsors_signage_delete ON public.leod_signage_sponsors;
CREATE POLICY sponsors_member_read ON public.leod_signage_sponsors FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);
CREATE POLICY sponsors_signage_insert ON public.leod_signage_sponsors FOR INSERT TO authenticated
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY sponsors_signage_update ON public.leod_signage_sponsors FOR UPDATE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'))
  WITH CHECK (cuedeck_event_role(event_id) IN ('director', 'signage'));
CREATE POLICY sponsors_signage_delete ON public.leod_signage_sponsors FOR DELETE TO authenticated
  USING (cuedeck_event_role(event_id) IN ('director', 'signage'));

-- ── The event row: what only the creator changes ────────────
-- events_director_update lets an invited director save the event; this
-- keeps id, created_by and created_at fixed for everyone signed in (no
-- giving an event away), and the origin and active flag (deactivating is
-- the console's delete) to the creator. The database itself, the service
-- role and admins pass, as in leod_events_guard_created_via.
CREATE OR REPLACE FUNCTION public.leod_events_guard_member_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR COALESCE(is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the owner of an event cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF auth.uid() IS DISTINCT FROM OLD.created_by
     AND (NEW.active IS DISTINCT FROM OLD.active OR NEW.created_via IS DISTINCT FROM OLD.created_via) THEN
    RAISE EXCEPTION 'only the creator of an event can deactivate it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_events_guard_member_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_leod_events_guard_member_update ON public.leod_events;
CREATE TRIGGER trg_leod_events_guard_member_update
  BEFORE UPDATE ON public.leod_events
  FOR EACH ROW EXECUTE FUNCTION public.leod_events_guard_member_update();
```

- [ ] **Step 8: Move the two older probes onto memberships** (they pin the old model, inventory §8; what they protect is unchanged).

In `tests/sql/095-event-scoped-writes-probe.sql`, right after the line

```sql
  VALUES ('Probe 095 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
```

insert:

```sql
  -- event teams (130): roles are per event in leod_event_members; the
  -- invited_by values above no longer give anything on their own
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_dir,   'director', true),
    (v_ev, v_av,    'av',       true),
    (v_ev, v_reg,   'reg',      true),
    (v_ev, v_dead,  'director', false),
    (v_ev, v_stage, 'stage',    true);
```

and replace

```sql
  -- reads unchanged: the stranger still sees nothing, the deactivated operator still reads (scoped_read_sessions)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_sessions WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 2: stranger reads % sessions', v_n; END IF;
```

with

```sql
  -- reads: the stranger sees nothing, and since 130 neither does the
  -- suspended member (spec §3: suspended members lose reads too)
  FOR v_r IN SELECT * FROM (VALUES (v_other), (v_dead)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM leod_sessions WHERE event_id = v_ev;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 2: % reads % sessions', v_r.uid, v_n; END IF;
  END LOOP;
```

In `tests/sql/128-stage-messages-probe.sql`, right after the line

```sql
  VALUES ('Probe 128 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
```

insert:

```sql
  -- event teams (130): roles are per event in leod_event_members
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_dir,   'director', true),
    (v_ev, v_stage, 'stage',    true),
    (v_ev, v_av,    'av',       true);
```

These two probes now fail before 130 is applied (no `leod_event_members`) and pass after; Task 4.1 re-runs them.

- [ ] **Step 9: Static check of the SQL.** Run: `grep -n "invited_by" supabase/migrations/130_event_members.sql | grep -v "^ *[0-9]*: *--"`. Expected: only the column definition, the backfill `SELECT … u.invited_by` / `JOIN … u.invited_by` / `WHERE u.invited_by IS NOT NULL` lines, and the `INSERT … invited_by)` column list. No policy or function body contains it.

- [ ] **Step 10: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/130_event_members.sql tests/sql/130-event-members-probe.sql tests/sql/095-event-scoped-writes-probe.sql tests/sql/128-stage-messages-probe.sql tests/rls.spec.ts
git commit -m "feat(db): event teams membership table and per-event resolver (migration 130)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/130_event_members.sql tests/sql/130-event-members-probe.sql tests/sql/095-event-scoped-writes-probe.sql tests/sql/128-stage-messages-probe.sql tests/rls.spec.ts
```


### Task 1.2: The functions that inlined the old rule (migration 131)

Spec §3 (`rpc_apply_delay`, `display_pair_link`, `display_rotate_secret` call the resolver; pairing and rotating are director or signage; `validate_event_log_role` stamps the per-event role), §6 (`get_subscription_for_user` is the caller's own plan; members get the owner's plan per event in Task 2.1), and the release order (the old console's team list keeps working on memberships until Release B).

**Files:**
- Create: `supabase/migrations/131_event_members_functions.sql`
- Create: `tests/sql/131-event-members-functions-probe.sql`
- Modify: `tests/sql/083-display-followups-probe.sql` (fixture after line 36)
- Modify: `tests/sql/093-apply-delay-probe.sql` (fixture after line 33)

**Interfaces:**
- Consumes (Task 1.1): `leod_event_members`, `cuedeck_event_role(uuid)`, `cuedeck_event_role_of(uuid, uuid)`.
- Live bodies it starts from (pg_get_functiondef, 8 Oct): quoted in the migration header. Grants live on 8 Oct: `rpc_apply_delay`, `display_pair_link`, `display_rotate_secret`: authenticated yes, anon no. `get_operators_with_last_seen`, `get_subscription_for_user`: authenticated yes, anon yes (anon is removed here).
- Produces (same signatures and return types as live):
  - `rpc_apply_delay(p_session_id uuid, p_minutes integer, p_operator_id uuid DEFAULT NULL, p_operator_role text DEFAULT NULL) RETURNS jsonb`: role from `cuedeck_event_role_of(event, caller)`, director or stage; errors unchanged (42501, 22023, P0002).
  - `display_pair_link(p_code text, p_display_id uuid) RETURNS text` (`linked`, `forbidden`, `not_found`, `used`, `expired`): director and signage only.
  - `display_rotate_secret(p_display_id uuid) RETURNS boolean`: director and signage only.
  - trigger `validate_event_log_role()`: `operator_role` is the operator's role on the row's event when they have one, else the account's `leod_users.role` (as before).
  - `get_operators_with_last_seen() RETURNS TABLE(id uuid, name text, email text, role text, organization text, active boolean, last_sign_in_at timestamptz)`: the caller plus every member of the events the caller directs; 42501 for someone who directs no event. Kept only for consoles older than Release B.
  - `get_subscription_for_user()`: same columns, the caller's own subscription only.

- [ ] **Step 1: Check the migration number** (Global Constraints). Expected next free: 131.

- [ ] **Step 2: Write the probe** `tests/sql/131-event-members-functions-probe.sql`:

```sql
-- tests/sql/131-event-members-functions-probe.sql
-- Run after 131 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 131'. Everything is rolled back by the final RAISE.
-- Before 130 is applied it fails with: relation "leod_event_members" does
-- not exist; after 130 and before 131 with PROBE FAIL 1 (rpc_apply_delay
-- still reads leod_users.invited_by, so the stage member is refused).
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();   -- creates v_ev
  v_stage  uuid := gen_random_uuid();   -- stage member of v_ev (global role director)
  v_av     uuid := gen_random_uuid();   -- av member of v_ev
  v_sign   uuid := gen_random_uuid();   -- signage member of v_ev
  v_off    uuid := gen_random_uuid();   -- stage member of v_ev, suspended
  v_legacy uuid := gen_random_uuid();   -- invited_by = v_owner, no membership
  v_other  uuid := gen_random_uuid();   -- creates v_ev2, has no members
  v_ev     uuid;
  v_ev2    uuid;
  v_s1     uuid;
  v_s2     uuid;
  v_disp   uuid;
  v_disp2  uuid;
  v_secret text;
  v_nonce  text := md5(random()::text) || md5(random()::text);
  v_res    text;
  v_ok     boolean;
  v_role   text;
  v_ids    uuid[];
  v_n      int;
  v_failed boolean;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u;
  INSERT INTO leod_users (id, email, role, invited_by, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', CASE WHEN u = v_legacy THEN v_owner END, true
    FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;
  INSERT INTO leod_subscriptions (director_id, plan, status) VALUES (v_owner, 'pro', 'active');

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 131', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 131 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_s1;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev2, 1, 'Probe other live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_s2;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV') RETURNING id INTO v_disp;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev2, 'Probe other TV') RETURNING id INTO v_disp2;
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_stage, 'stage',   true),
    (v_ev, v_av,    'av',      true),
    (v_ev, v_sign,  'signage', true),
    (v_ev, v_off,   'stage',   false);

  -- 1. rpc_apply_delay: the creator and the stage member delay, signed in or
  --    through the service role naming them; av, the suspended member, the
  --    invited_by link alone, a stranger and a member naming someone else
  --    are refused (42501)
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner,  NULL::uuid, 'authenticated', true),
      (v_stage,  NULL::uuid, 'authenticated', true),
      (NULL,     v_stage,    'service_role',  true),
      (v_av,     NULL::uuid, 'authenticated', false),
      (v_off,    NULL::uuid, 'authenticated', false),
      (v_legacy, NULL::uuid, 'authenticated', false),
      (v_other,  NULL::uuid, 'authenticated', false),
      (NULL,     v_av,       'service_role',  false),
      (NULL,     v_legacy,   'service_role',  false),
      (v_stage,  v_owner,    'authenticated', false)) AS x(sub, op, role, allowed)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims',
                       (CASE WHEN v_r.sub IS NULL THEN json_build_object('role', v_r.role)
                             ELSE json_build_object('sub', v_r.sub, 'role', v_r.role) END)::text, true);
    BEGIN
      IF v_r.role = 'authenticated' THEN SET LOCAL ROLE authenticated; ELSE SET LOCAL ROLE service_role; END IF;
      PERFORM rpc_apply_delay(v_s1, 1, v_r.op, 'director');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF v_failed = v_r.allowed THEN
      RAISE EXCEPTION 'PROBE FAIL 1: sub % op % as %: allowed % but refused %', v_r.sub, v_r.op, v_r.role, v_r.allowed, v_failed;
    END IF;
  END LOOP;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM rpc_apply_delay(v_s2, 1, NULL, 'director');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 1: a member delayed another organiser''s session'; END IF;
  IF (SELECT cumulative_delay FROM leod_sessions WHERE id = v_s1) <> 3 THEN
    RAISE EXCEPTION 'PROBE FAIL 1: expected 3 minutes from the 3 allowed calls, got %',
      (SELECT cumulative_delay FROM leod_sessions WHERE id = v_s1);
  END IF;
  v_checks := v_checks + 1;

  -- 2. display_pair_link: director and signage link; av, the suspended
  --    member, the invited_by link alone and a stranger get 'forbidden';
  --    a member never links another organiser's display
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_start('PRB732', v_nonce) IS DISTINCT FROM true
     OR display_pair_start('PRB733', v_nonce) IS DISTINCT FROM true
     OR display_pair_start('PRB734', v_nonce) IS DISTINCT FROM true THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 2: display_pair_start';
  END IF;
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES (v_av), (v_off), (v_legacy), (v_other)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_res := display_pair_link('PRB732', v_disp);
    RESET ROLE;
    IF v_res IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL 2: % got %', v_r.uid, v_res; END IF;
  END LOOP;
  IF (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRB732') IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a refused caller linked the code';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB732', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'PROBE FAIL 2: signage got %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB733', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'PROBE FAIL 2: the creator got %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB734', v_disp2);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL 2: signage linked another organiser''s display: %', v_res; END IF;
  v_checks := v_checks + 1;

  -- 3. display_rotate_secret: director and signage rotate; everyone else
  --    gets false and the key does not change
  SELECT display_secret INTO v_secret FROM leod_signage_displays WHERE id = v_disp;
  FOR v_r IN SELECT * FROM (VALUES (v_av), (v_off), (v_legacy), (v_other), (v_stage)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := display_rotate_secret(v_disp);
    RESET ROLE;
    IF v_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'PROBE FAIL 3: % rotated the key', v_r.uid; END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp) <> v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused rotate changed the key';
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_sign), (v_owner)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := display_rotate_secret(v_disp);
    RESET ROLE;
    IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROBE FAIL 3: % could not rotate', v_r.uid; END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp) = v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 3: the key did not change';
  END IF;
  v_checks := v_checks + 1;

  -- 4. the log stamps the role on THIS event (Review Focus 1): the stage
  --    member's global role is director and the row says stage; a row with
  --    no event keeps the account's own role, as before
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (v_ev, 'PROBE_131', v_stage, 'director');
  RESET ROLE;
  SELECT operator_role INTO v_role FROM leod_event_log WHERE event_id = v_ev AND action = 'PROBE_131';
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 4: event row stamped %', v_role; END IF;
  SELECT operator_role INTO v_role FROM leod_event_log
   WHERE event_id = v_ev AND action = 'DELAY_APPLIED' AND operator_id = v_stage ORDER BY id DESC LIMIT 1;
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 4: the delay by stage was stamped %', v_role; END IF;
  INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (NULL, 'PROBE_131_ACCOUNT', v_stage, 'stage');
  SELECT operator_role INTO v_role FROM leod_event_log WHERE action = 'PROBE_131_ACCOUNT' AND operator_id = v_stage;
  IF v_role IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 4: account-level row stamped %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 5. get_operators_with_last_seen (consoles before Release B): the creator
  --    sees themself and the event's members with their event roles, and
  --    nobody else; someone who directs no event is refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(o.id ORDER BY o.id) INTO v_ids FROM get_operators_with_last_seen() o;
  SELECT o.role INTO v_role FROM get_operators_with_last_seen() o WHERE o.id = v_stage;
  RESET ROLE;
  IF v_ids IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off]) u) THEN
    RAISE EXCEPTION 'PROBE FAIL 5: the creator sees %', v_ids;
  END IF;
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 5: role shown %', v_role; END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_stage), (v_legacy)) AS x(uid) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM * FROM get_operators_with_last_seen();
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: % (directs no event) got the list', v_r.uid; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(o.id) INTO v_ids FROM get_operators_with_last_seen() o;
  RESET ROLE;
  IF v_ids IS DISTINCT FROM ARRAY[v_other] THEN RAISE EXCEPTION 'PROBE FAIL 5: an organiser with no team sees %', v_ids; END IF;
  v_checks := v_checks + 1;

  -- 6. get_subscription_for_user: the caller's own plan only; a member never
  --    resolves to the owner's (spec §6)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM get_subscription_for_user();
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: a member got % subscription rows', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT plan INTO v_role FROM get_subscription_for_user();
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'pro' THEN RAISE EXCEPTION 'PROBE FAIL 6: the owner got %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 7. grants, and none of the six reads invited_by any more
  IF has_function_privilege('anon', 'public.rpc_apply_delay(uuid,integer,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_operators_with_last_seen()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_subscription_for_user()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_apply_delay(uuid,integer,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_operators_with_last_seen()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_subscription_for_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_event_log_role()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: grants';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('rpc_apply_delay', 'display_pair_link', 'display_rotate_secret', 'validate_event_log_role',
                                  'get_operators_with_last_seen', 'get_subscription_for_user')
                AND p.prosrc LIKE '%invited_by%') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: a rewritten function still reads invited_by';
  END IF;
  v_checks := v_checks + 1;

  -- 8. guards that must stay green
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 8: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                FROM checkin_guard_results()
                                               WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                               'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 131: % checks passed (rolled back)', v_checks;
END
$probe$;
```

- [ ] **Step 3 (controller): run the probe before the migration.** Expected while 130 is not applied: `relation "leod_event_members" does not exist`. Record it.

- [ ] **Step 4: Write the migration** `supabase/migrations/131_event_members_functions.sql`:

```sql
-- ============================================================
-- CueDeck Migration 131: event teams, part 2 (functions on the resolver)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §3, §6
-- Every function that carried its own copy of the old membership rule
-- (leod_users.invited_by) now asks the resolver from migration 130. Bodies
-- are the live ones (pg_get_functiondef, 2026-10-08) with only the
-- membership lines changed; each block says what changed.
--
-- The live lines that change:
--   rpc_apply_delay:  SELECT e.created_by INTO v_owner ...; IF v_owner = v_caller
--                     THEN 'director' ELSIF ... SELECT u.role FROM leod_users u
--                     WHERE u.id = v_caller AND u.invited_by = v_owner AND u.active
--   display_pair_link, display_rotate_secret: event owned by the caller or by
--                     the caller's invited_by (active), any member role
--   validate_event_log_role: operator_role := leod_users.role (global)
--   get_operators_with_last_seen: caller's global role = 'director'; rows
--                     u.id = caller OR u.invited_by = caller
--   get_subscription_for_user: self if role = 'director' OR invited_by IS NULL,
--                     else the inviter's subscription
-- ============================================================

-- ── rpc_apply_delay: role on the session's event ────────────
-- Changed: v_owner and the leod_users lookup become
-- cuedeck_event_role_of(v_event, v_caller). The rest is the live body.
CREATE OR REPLACE FUNCTION public.rpc_apply_delay(p_session_id uuid, p_minutes integer, p_operator_id uuid DEFAULT NULL::uuid, p_operator_role text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller   UUID;
  v_event    UUID;
  v_sort     SMALLINT;
  v_role     TEXT;
  v_stop_sort SMALLINT;
  v_stop_id  UUID;
  v_ids      UUID[];
  v_affected INT;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    IF coalesce(auth.role(), 'service_role') <> 'service_role' THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    v_caller := p_operator_id;
  ELSIF p_operator_id IS NOT NULL AND p_operator_id <> v_caller THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 240 THEN
    RAISE EXCEPTION 'minutes must be between 1 and 240, got %', p_minutes USING ERRCODE = '22023';
  END IF;

  SELECT s.event_id, s.sort_order INTO v_event, v_sort
    FROM leod_sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  -- event teams (131): the caller's role on this event, from the resolver
  v_role := cuedeck_event_role_of(v_event, v_caller);
  IF v_role IS NULL OR v_role NOT IN ('director', 'stage') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT s.sort_order, s.id INTO v_stop_sort, v_stop_id
    FROM leod_sessions s
   WHERE s.event_id = v_event
     AND (s.sort_order, s.id) > (v_sort, p_session_id)
     AND s.status NOT IN ('ENDED', 'CANCELLED')
     AND s.is_anchor
   ORDER BY s.sort_order, s.id
   LIMIT 1;

  WITH shifted AS (
    UPDATE leod_sessions s
       SET scheduled_start  = s.scheduled_start + make_interval(mins => p_minutes),
           scheduled_end    = s.scheduled_end   + make_interval(mins => p_minutes),
           cumulative_delay = s.cumulative_delay + p_minutes,
           delay_minutes    = CASE WHEN s.id = p_session_id
                                   THEN s.delay_minutes + p_minutes
                                   ELSE s.delay_minutes END,
           version          = s.version + 1
     WHERE s.event_id = v_event
       AND (s.sort_order, s.id) >= (v_sort, p_session_id)
       AND (v_stop_id IS NULL OR (s.sort_order, s.id) < (v_stop_sort, v_stop_id))
       AND s.status NOT IN ('ENDED', 'CANCELLED')
    RETURNING s.id, s.sort_order
  )
  SELECT array_agg(id ORDER BY sort_order, id), count(*)::int
    INTO v_ids, v_affected
    FROM shifted;

  INSERT INTO leod_event_log (event_id, session_id, action, operator_id, operator_role, payload, server_time_ms)
  VALUES (v_event, p_session_id, 'DELAY_APPLIED', v_caller, p_operator_role,
          jsonb_build_object('minutes', p_minutes, 'affected', v_affected,
                             'session_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb),
                             'stopped_at_anchor', v_stop_id, 'via', 'rpc'),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);

  RETURN jsonb_build_object('ok', true, 'affected', v_affected, 'minutes', p_minutes);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_apply_delay(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_apply_delay(uuid, integer, uuid, text) TO authenticated, service_role;

-- ── display_pair_link: director or signage on the display's event ──
-- Changed: the owner-or-invited_by join becomes the resolver and the roles
-- narrow to director and signage (spec §3). The rest is the live body.
CREATE OR REPLACE FUNCTION public.display_pair_link(p_code text, p_display_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event uuid;
  v_row   leod_signage_pairing%ROWTYPE;
BEGIN
  SELECT d.event_id INTO v_event FROM leod_signage_displays d WHERE d.id = p_display_id;
  IF v_uid IS NULL OR v_event IS NULL
     OR coalesce(cuedeck_event_role(v_event), '') NOT IN ('director', 'signage') THEN
    RETURN 'forbidden';
  END IF;
  UPDATE leod_signage_pairing
     SET display_id = p_display_id, event_id = v_event
   WHERE code = p_code AND display_id IS NULL AND expires_at > now()
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN 'linked';
  END IF;
  SELECT * INTO v_row FROM leod_signage_pairing WHERE code = p_code;
  IF NOT FOUND THEN
    RETURN 'not_found';
  ELSIF v_row.display_id IS NOT NULL THEN
    RETURN 'used';
  END IF;
  RETURN 'expired';
END
$function$;
REVOKE ALL ON FUNCTION public.display_pair_link(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.display_pair_link(text, uuid) TO authenticated, service_role;

-- ── display_rotate_secret: director or signage on the display's event ──
-- Changed: as display_pair_link. The rest is the live body.
CREATE OR REPLACE FUNCTION public.display_rotate_secret(p_display_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event uuid;
BEGIN
  IF v_uid IS NULL OR p_display_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT d.event_id INTO v_event FROM leod_signage_displays d WHERE d.id = p_display_id;
  IF v_event IS NULL OR coalesce(cuedeck_event_role(v_event), '') NOT IN ('director', 'signage') THEN
    RETURN false;
  END IF;
  UPDATE leod_signage_displays d
     SET display_secret = encode(extensions.gen_random_bytes(24), 'hex')
   WHERE d.id = p_display_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM leod_signage_pairing WHERE display_id = p_display_id;
  RETURN true;
END
$function$;
REVOKE ALL ON FUNCTION public.display_rotate_secret(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.display_rotate_secret(uuid) TO authenticated, service_role;

-- ── validate_event_log_role: the role on THIS event ─────────
-- Changed: a row with an event gets the operator's role on that event
-- (spec §3); with no event, or no role on it (an admin), the live
-- behaviour stays (the account's leod_users.role).
CREATE OR REPLACE FUNCTION public.validate_event_log_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actual_role TEXT;
BEGIN
  -- Skip validation for inserts with no operator (cron jobs)
  IF NEW.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.event_id IS NOT NULL THEN
    v_actual_role := cuedeck_event_role_of(NEW.event_id, NEW.operator_id);
  END IF;
  IF v_actual_role IS NULL THEN
    SELECT role INTO v_actual_role FROM leod_users WHERE id = NEW.operator_id;
  END IF;

  IF v_actual_role IS NOT NULL AND NEW.operator_role IS DISTINCT FROM v_actual_role THEN
    NEW.operator_role := v_actual_role;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_event_log_role() FROM PUBLIC, anon, authenticated;

-- ── get_operators_with_last_seen: for consoles before Release B ──
-- The console after Release B uses cuedeck_event_team (133). Until the
-- leod_users.invited_by cleanup (spec §7) this keeps the old console's team
-- list working on memberships: the caller plus every member of the events
-- the caller directs (creator, or active director member), with the role on
-- that event. Same columns as the live function.
CREATE OR REPLACE FUNCTION public.get_operators_with_last_seen()
RETURNS TABLE(id uuid, name text, email text, role text, organization text, active boolean, last_sign_in_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL OR NOT (
       EXISTS (SELECT 1 FROM leod_events e WHERE e.created_by = v_caller_id)
       OR EXISTS (SELECT 1 FROM leod_event_members m
                   WHERE m.user_id = v_caller_id AND m.active AND m.role = 'director')) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT x.id, x.name, x.email, x.role, x.organization, x.active, x.last_sign_in_at
    FROM (
      SELECT DISTINCT ON (u.id)
             u.id, u.name, u.email,
             CASE WHEN u.id = v_caller_id THEN 'director' ELSE m.role END AS role,
             u.organization,
             CASE WHEN u.id = v_caller_id THEN u.active ELSE m.active END AS active,
             a.last_sign_in_at
        FROM leod_users u
        LEFT JOIN auth.users a ON a.id = u.id
        LEFT JOIN leod_event_members m
               ON m.user_id = u.id
              AND cuedeck_event_role_of(m.event_id, v_caller_id) = 'director'
       WHERE u.id = v_caller_id OR m.user_id IS NOT NULL
       ORDER BY u.id, m.created_at
    ) x
   ORDER BY x.role, x.name;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_operators_with_last_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operators_with_last_seen() TO authenticated, service_role;

-- ── get_subscription_for_user: the caller's own plan only ───
-- Changed: no resolution to the inviter. A member's plan for an event is
-- the event owner's, returned per event by cuedeck_my_events (133).
CREATE OR REPLACE FUNCTION public.get_subscription_for_user()
RETURNS TABLE(plan text, status text, trial_ends_at timestamp with time zone, events_purchased integer, events_used integer, current_period_end timestamp with time zone, cancel_at timestamp with time zone, billing_interval text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  SELECT s.plan, s.status, s.trial_ends_at,
         s.events_purchased, s.events_used,
         s.current_period_end, s.cancel_at, s.billing_interval
    FROM leod_subscriptions s
   WHERE s.director_id = auth.uid();
END;
$function$;
REVOKE ALL ON FUNCTION public.get_subscription_for_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_subscription_for_user() TO authenticated, service_role;
```

- [ ] **Step 5: Move the two older probes onto memberships.**

In `tests/sql/083-display-followups-probe.sql`, right after

```sql
  VALUES ('Probe 083', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
```

insert:

```sql
  -- event teams (130): roles are per event in leod_event_members
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_op,   'signage', true),
    (v_ev, v_dead, 'signage', false);
```

In `tests/sql/093-apply-delay-probe.sql`, right after

```sql
  VALUES ('Probe 093', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
```

insert:

```sql
  -- event teams (130): roles are per event in leod_event_members
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_stage, 'stage',    true),
    (v_ev, v_av,    'av',       true),
    (v_ev, v_dead,  'director', false);
```

(093 line 146 already expects `operator_role = 'stage'` on the stage operator's delay; the per-event stamp keeps that.)

- [ ] **Step 6: Static check.** Run: `grep -n "invited_by" supabase/migrations/131_event_members_functions.sql | grep -v -- "--"`. Expected: no output (only comments name it).

- [ ] **Step 7: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/131_event_members_functions.sql tests/sql/131-event-members-functions-probe.sql tests/sql/083-display-followups-probe.sql tests/sql/093-apply-delay-probe.sql
git commit -m "feat(db): delay, pairing, log role and plan RPCs on the per-event resolver (migration 131)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/131_event_members_functions.sql tests/sql/131-event-members-functions-probe.sql tests/sql/083-display-followups-probe.sql tests/sql/093-apply-delay-probe.sql
```

### Task 1.3: The guard and the isolation matrix (migration 132)

Spec §3 (a guard fails if any policy or function outside `cuedeck_event_role` reads `invited_by` for access) and §8 (the live probe: for a member of event A, read and write refused on event B by every route; realtime delivers nothing of B; a suspended member reads nothing; the creator can never be demoted; one login on two organisers' events sees both and only those).

The guard is a new function `cuedeck_guard_results()` with the same shape as `checkin_guard_results()` (`guard, ok, detail, checked_at`). It is not added inside `checkin_guard_results()`: that function belongs to the check-in session, which replaces its whole body in its own migrations (126 was the last), so two sessions editing it would overwrite each other's guards.

**Files:**
- Create: `supabase/migrations/132_event_teams_guard.sql`
- Create: `tests/sql/132-event-teams-isolation-probe.sql`

**Interfaces:**
- Consumes: Task 1.1 (table, resolver, policies, trigger), Task 1.2 (rewritten functions), `stage_message_send(uuid, uuid, text)`, `stage_message_clear(uuid, uuid)`, `display_pair_start(text, text)` (live, unchanged).
- Produces: `public.cuedeck_guard_results() RETURNS TABLE(guard text, ok boolean, detail text, checked_at timestamptz)`, executable by `service_role` only, with three guards:
  - `event_access_not_via_invited_by`: by exclusion, every policy and function in `public` whose text mentions `invited_by` fails, except the named non-access readers.
  - `event_members_server_writes_only`: RLS on, no client write privilege, no write policy on `leod_event_members`.
  - `event_creator_never_member`: no membership row names its event's creator.

- [ ] **Step 1: Check the migration number** (Global Constraints). Expected next free: 132.

- [ ] **Step 2: Write the probe** `tests/sql/132-event-teams-isolation-probe.sql`:

```sql
-- tests/sql/132-event-teams-isolation-probe.sql
-- Spec §8 isolation matrix, plus the guard from 132 failing when it should.
-- Run after 132 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 132'. Everything is rolled back by the final RAISE.
-- Before 132 it fails with: function cuedeck_guard_results() does not exist
-- (or, before 130, relation "leod_event_members" does not exist).
--
-- Realtime: postgres_changes delivers a row to a subscriber only when the
-- subscriber's SELECT policy passes for that row, so the reads below (as
-- each person, through RLS) are what realtime enforces too. The session
-- transitions (9 Edge Functions) are checked in tests/deno/session-auth.test.ts.
DO $probe$
DECLARE
  v_o1 uuid := gen_random_uuid();   -- organiser of A
  v_o2 uuid := gen_random_uuid();   -- organiser of C
  v_o3 uuid := gen_random_uuid();   -- organiser of B, the event nobody here is on
  v_m  uuid := gen_random_uuid();   -- stage on A, av on C: one login, two organisers
  v_d  uuid := gen_random_uuid();   -- director on A
  v_s  uuid := gen_random_uuid();   -- director on A, suspended
  v_a  uuid; v_b uuid; v_c uuid;
  v_sa uuid; v_sb uuid; v_sc uuid;
  v_da uuid; v_db uuid;
  v_nonce text := md5(random()::text) || md5(random()::text);
  v_secret_b text;
  v_res  text;
  v_ok   boolean;
  v_n    int;
  v_failed boolean;
  v_r    record;
  v_t    record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_o1, v_o2, v_o3, v_m, v_d, v_s]) AS u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', true
    FROM unnest(ARRAY[v_o1, v_o2, v_o3, v_m, v_d, v_s]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 A', current_date + 30, '09:00', '18:00', v_o1) RETURNING id INTO v_a;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 B', current_date + 30, '09:00', '18:00', v_o3) RETURNING id INTO v_b;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 C', current_date + 30, '09:00', '18:00', v_o2) RETURNING id INTO v_c;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_a, 1, 'A live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sa;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_b, 1, 'B live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sb;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_c, 1, 'C ready', 'READY', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sc;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_a, 'A TV') RETURNING id INTO v_da;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_b, 'B TV') RETURNING id, display_secret INTO v_db, v_secret_b;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_a, 'A sponsor'), (v_b, 'B sponsor');
  INSERT INTO leod_reports (event_id, report_data) VALUES (v_a, '{}'), (v_b, '{}');
  INSERT INTO leod_broadcast (id, event_id, message, priority) VALUES (v_a::text, v_a, 'A notice', 'info'), (v_b::text, v_b, 'B notice', 'info');
  INSERT INTO leod_event_log (event_id, action) VALUES (v_a, 'PROBE_132_A'), (v_b, 'PROBE_132_B');
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_a, v_m, 'stage',    true),
    (v_c, v_m, 'av',       true),
    (v_a, v_d, 'director', true),
    (v_a, v_s, 'director', false);
  -- B's organiser sends B a message to the speaker
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o3, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_b, v_sb, 'Probe B message');
  RESET ROLE;

  -- 1. reads: nobody from A reads anything of B, in any table; B's own
  --    organiser does (so the zero is not an empty table)
  FOR v_t IN SELECT * FROM (VALUES ('leod_events', 'id'), ('leod_sessions', 'event_id'), ('leod_event_log', 'event_id'),
      ('leod_broadcast', 'event_id'), ('leod_reports', 'event_id'), ('leod_signage_displays', 'event_id'),
      ('leod_signage_sponsors', 'event_id'), ('leod_stage_messages', 'event_id')) AS y(tbl, col)
  LOOP
    FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d), (v_s), (v_o1)) AS x(uid) LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_b;
      RESET ROLE;
      IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 1: % reads % rows of B in %', v_r.uid, v_n, v_t.tbl; END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o3, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_b;
    RESET ROLE;
    IF v_n < 1 THEN RAISE EXCEPTION 'PROBE FAIL 1: B''s organiser reads nothing in % (control)', v_t.tbl; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 2. direct writes on B: every one changes no row or is refused (42501)
  FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d)) AS x(uid) LOOP
    FOR v_t IN SELECT * FROM (VALUES
        ('UPDATE leod_events SET name = ''Hijacked'' WHERE id = $1', 'rows'),
        ('DELETE FROM leod_events WHERE id = $1', 'rows'),
        ('UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_sessions WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end) VALUES ($1, 9, ''Planted'', ''10:00'', ''10:30'', ''10:00'', ''10:30'')', 'denied'),
        ('INSERT INTO leod_event_log (event_id, action) VALUES ($1, ''PROBE_PLANTED'')', 'denied'),
        ('UPDATE leod_broadcast SET message = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_broadcast WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_reports (event_id, report_data) VALUES ($1, ''{}'')', 'denied'),
        ('INSERT INTO leod_signage_displays (event_id, name) VALUES ($1, ''Planted'')', 'denied'),
        ('UPDATE leod_signage_displays SET name = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_signage_displays WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_signage_sponsors (event_id, name) VALUES ($1, ''Planted'')', 'denied'),
        ('UPDATE leod_signage_sponsors SET name = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('UPDATE leod_stage_messages SET text = ''Hijacked'' WHERE event_id = $1', 'denied'),
        ('INSERT INTO leod_event_members (event_id, user_id, role) VALUES ($1, auth.uid(), ''director'')', 'denied')) AS y(stmt, kind)
    LOOP
      v_failed := false;
      v_n := 0;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE v_t.stmt USING v_b;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
      END;
      RESET ROLE;
      IF (v_t.kind = 'denied' AND NOT v_failed) OR (v_t.kind = 'rows' AND v_n <> 0) THEN
        RAISE EXCEPTION 'PROBE FAIL 2: % ran on B (% rows): %', v_r.uid, v_n, v_t.stmt;
      END IF;
    END LOOP;
  END LOOP;
  v_checks := v_checks + 1;

  -- 3. RPCs on B: stage messages, delays, pairing, rotating, the resolver
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_start('PRB742', v_nonce) IS DISTINCT FROM true THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 3: pair_start'; END IF;
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d), (v_s)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    FOR v_t IN SELECT * FROM (VALUES
        ('SELECT stage_message_send($1, $2, ''Hijack'')'),
        ('SELECT stage_message_clear($1, $2)'),
        ('SELECT rpc_apply_delay($2, 5, NULL, ''director'')')) AS y(stmt)
    LOOP
      v_failed := false;
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE v_t.stmt USING v_b, v_sb;
      EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
      END;
      RESET ROLE;
      IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % ran on B: %', v_r.uid, v_t.stmt; END IF;
    END LOOP;
    SET LOCAL ROLE authenticated;
    v_res := display_pair_link('PRB742', v_db);
    v_ok  := display_rotate_secret(v_db);
    IF cuedeck_event_role(v_b) IS NOT NULL THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 3: % has a role on B', v_r.uid; END IF;
    RESET ROLE;
    IF v_res IS DISTINCT FROM 'forbidden' OR v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'PROBE FAIL 3: % paired (%) or rotated (%) B''s display', v_r.uid, v_res, v_ok;
    END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_db) <> v_secret_b
     OR (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRB742') IS NOT NULL
     OR (SELECT text FROM leod_stage_messages WHERE event_id = v_b AND cleared_at IS NULL) IS DISTINCT FROM 'Probe B message'
     OR (SELECT cumulative_delay FROM leod_sessions WHERE id = v_sb) <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused RPC changed B';
  END IF;
  v_checks := v_checks + 1;

  -- 4. the suspended director reads nothing of A and changes nothing there
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
  FOR v_t IN SELECT * FROM (VALUES ('leod_events', 'id'), ('leod_sessions', 'event_id'), ('leod_event_log', 'event_id'),
      ('leod_broadcast', 'event_id'), ('leod_reports', 'event_id'), ('leod_signage_displays', 'event_id'),
      ('leod_signage_sponsors', 'event_id'), ('leod_stage_messages', 'event_id'), ('leod_event_members', 'event_id')) AS y(tbl, col)
  LOOP
    SET LOCAL ROLE authenticated;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_a;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 4: the suspended director reads % rows of A in %', v_n, v_t.tbl; END IF;
  END LOOP;
  SET LOCAL ROLE authenticated;
  UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id = v_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 4: the suspended director updated A'; END IF;
  v_checks := v_checks + 1;

  -- 5. the creator can never be demoted: no membership row for them, and the
  --    resolver answers director whatever the roster says
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_a, v_o1, 'reg');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: the creator was stored as a member'; END IF;
  UPDATE leod_event_members SET role = 'reg' WHERE event_id = v_a AND user_id = v_d;
  IF cuedeck_event_role_of(v_a, v_o1) IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 5: creator demoted'; END IF;
  UPDATE leod_event_members SET role = 'director' WHERE event_id = v_a AND user_id = v_d;
  v_checks := v_checks + 1;

  -- 6. one login on two organisers' events (Review Focus 2): sees A and C,
  --    never B; stage on A and av on C; may update sessions on both, may not
  --    add one on C (director only); B is unchanged by everything above
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_m, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_events WHERE id IN (v_a, v_b, v_c);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: sees % of A, B, C (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM leod_sessions WHERE event_id IN (v_a, v_b, v_c);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: sees % sessions (expected 2)', v_n; END IF;
  IF cuedeck_event_role(v_a) IS DISTINCT FROM 'stage' OR cuedeck_event_role(v_c) IS DISTINCT FROM 'av' THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: roles % and %', cuedeck_event_role(v_a), cuedeck_event_role(v_c);
  END IF;
  UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id IN (v_a, v_c);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 2 THEN RAISE EXCEPTION 'PROBE FAIL 6: updated % sessions on A and C (expected 2)', v_n; END IF;
  v_failed := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
    VALUES (v_c, 2, 'By av', '10:00', '10:30', '10:00', '10:30');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: av on C added a session'; END IF;
  IF (SELECT name FROM leod_events WHERE id = v_b) <> 'Probe 132 B'
     OR (SELECT count(*) FROM leod_sessions WHERE event_id = v_b) <> 1
     OR (SELECT message FROM leod_broadcast WHERE id = v_b::text) <> 'B notice'
     OR (SELECT count(*) FROM leod_signage_displays WHERE event_id = v_b AND name = 'B TV') <> 1
     OR (SELECT count(*) FROM leod_event_log WHERE event_id = v_b AND action <> 'STAGE_MESSAGE') <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 6: event B changed';
  END IF;
  v_checks := v_checks + 1;

  -- 7. the guards are green now, and they ran just now
  IF (SELECT count(*) FROM cuedeck_guard_results()) <> 3
     OR EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE NOT ok OR checked_at < now() - interval '1 minute') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ') FROM cuedeck_guard_results());
  END IF;
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: check-in guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                         FROM checkin_guard_results()
                                                        WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                                        'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  -- 8. the guard fails when a new copy of the old rule appears (watch the
  --    watcher): a policy and a function that read invited_by are each named
  CREATE POLICY probe_old_rule ON leod_reports FOR SELECT TO authenticated
    USING (event_id IN (SELECT e.id FROM leod_events e
                         WHERE e.created_by IN (SELECT u.invited_by FROM leod_users u WHERE u.id = auth.uid())));
  CREATE FUNCTION public.probe_old_rule_fn() RETURNS uuid LANGUAGE sql STABLE
    AS $f$ SELECT invited_by FROM leod_users WHERE id = auth.uid() $f$;
  SELECT detail INTO v_res FROM cuedeck_guard_results() WHERE guard = 'event_access_not_via_invited_by' AND NOT ok;
  IF v_res IS NULL OR position('leod_reports.probe_old_rule' IN v_res) = 0 OR position('probe_old_rule_fn()' IN v_res) = 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the guard did not name the new copies: %', coalesce(v_res, 'guard ok');
  END IF;
  DROP POLICY probe_old_rule ON leod_reports;
  DROP FUNCTION public.probe_old_rule_fn();
  -- and when a client may write the membership table
  GRANT INSERT ON public.leod_event_members TO authenticated;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE guard = 'event_members_server_writes_only' AND ok) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the write guard stayed green with a client INSERT grant';
  END IF;
  REVOKE INSERT ON public.leod_event_members FROM authenticated;
  -- and when a creator row slips in (trigger bypassed, as by a superuser restore)
  ALTER TABLE public.leod_event_members DISABLE TRIGGER trg_leod_event_members_guard;
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_a, v_o1, 'reg');
  ALTER TABLE public.leod_event_members ENABLE TRIGGER trg_leod_event_members_guard;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE guard = 'event_creator_never_member' AND ok)
     OR cuedeck_event_role_of(v_a, v_o1) IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'PROBE FAIL 8: a creator row went unnoticed or demoted the creator';
  END IF;
  v_checks := v_checks + 1;

  -- 9. who may run the guard
  IF has_function_privilege('anon', 'public.cuedeck_guard_results()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_guard_results()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cuedeck_guard_results()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: guard grants';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 132: % checks passed (rolled back)', v_checks;
END
$probe$;
```

- [ ] **Step 3 (controller): run the probe before the migration.** Expected while 130 is not applied: `relation "leod_event_members" does not exist`. Record it.

- [ ] **Step 4: Write the migration** `supabase/migrations/132_event_teams_guard.sql`:

```sql
-- ============================================================
-- CueDeck Migration 132: event teams, part 3 (the guard)
-- ============================================================
-- Spec §3: a guard fails if any policy or function outside the resolver
-- reads invited_by for access, so a new copy of the old membership rule
-- cannot creep back in. Same shape as checkin_guard_results(); kept in its
-- own function because checkin_guard_results() belongs to the check-in
-- work, whose migrations replace its whole body.
-- Every guard is written by exclusion and fails on an empty or missing
-- input rather than passing on nothing.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cuedeck_guard_results()
RETURNS TABLE(guard text, ok boolean, detail text, checked_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_ok     boolean;
  v_detail text;
  v_bad    text[];
  v_n      int;
BEGIN
  -- T1 (132): no access path outside the resolver reads invited_by. Every
  -- policy and every function in public whose text mentions it fails,
  -- except these, none of which decides access:
  --   policy leod_users.auth_insert_own_pending  pins invited_by IS NULL on a self-insert
  --   admin_list_users             shows it on the admin screen
  --   get_my_profile               returns the caller's own profile fields
  --   leod_users_guard_privileged  refuses changes to it
  --   log_user_signup              copies it into the signup audit row
  --   cuedeck_guard_results        this function (it names the column)
  -- leod_event_members.invited_by (who added a person) is the same word and
  -- is held to the same rule: nothing reads it for access.
  BEGIN
    SELECT array_agg(c.relname || '.' || p.polname ORDER BY c.relname, p.polname) INTO v_bad
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' '
            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) LIKE '%invited_by%'
       AND NOT (c.relname = 'leod_users' AND p.polname = 'auth_insert_own_pending');
    SELECT coalesce(v_bad, '{}') || coalesce(array_agg(p.proname || '()' ORDER BY p.proname), '{}') INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosrc LIKE '%invited_by%'
       AND p.proname NOT IN ('admin_list_users', 'get_my_profile', 'leod_users_guard_privileged',
                             'log_user_signup', 'cuedeck_guard_results');
    v_n := coalesce(cardinality(v_bad), 0);
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = 'cuedeck_event_role') THEN
      v_ok := false;
      v_detail := 'cuedeck_event_role not found: the resolver this guard protects is missing';
    ELSE
      v_ok := v_n = 0;
      v_detail := CASE WHEN v_n = 0 THEN 'no policy or function outside the resolver reads invited_by'
                       ELSE v_n || ' read invited_by: ' || array_to_string(v_bad, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_access_not_via_invited_by'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- T2 (132): memberships are written only by the server (invite-operator,
  -- manage-operator). RLS on, no client INSERT/UPDATE/DELETE privilege, no
  -- write policy, anon has nothing. A missing table is a failure.
  BEGIN
    IF to_regclass('public.leod_event_members') IS NULL THEN
      v_ok := false; v_detail := 'leod_event_members not found';
    ELSE
      v_bad := ARRAY[]::text[];
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leod_event_members'::regclass) THEN
        v_bad := v_bad || 'RLS off'::text;
      END IF;
      IF has_table_privilege('authenticated', 'public.leod_event_members', 'INSERT')
         OR has_table_privilege('authenticated', 'public.leod_event_members', 'UPDATE')
         OR has_table_privilege('authenticated', 'public.leod_event_members', 'DELETE') THEN
        v_bad := v_bad || 'authenticated may write'::text;
      END IF;
      IF has_table_privilege('anon', 'public.leod_event_members', 'SELECT')
         OR has_table_privilege('anon', 'public.leod_event_members', 'INSERT')
         OR has_table_privilege('anon', 'public.leod_event_members', 'UPDATE')
         OR has_table_privilege('anon', 'public.leod_event_members', 'DELETE') THEN
        v_bad := v_bad || 'anon has a privilege'::text;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.leod_event_members'::regclass AND polcmd <> 'r') THEN
        v_bad := v_bad || 'a write policy exists'::text;
      END IF;
      v_ok := cardinality(v_bad) = 0;
      v_detail := CASE WHEN v_ok THEN 'leod_event_members is read-only for clients'
                       ELSE array_to_string(v_bad, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_members_server_writes_only'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- T3 (132): the creator of an event is never a member of it (spec §2:
  -- computed from created_by, so no row can demote them).
  BEGIN
    SELECT count(*), string_agg(m.event_id::text, ', ') INTO v_n, v_detail
      FROM leod_event_members m JOIN leod_events e ON e.id = m.event_id
     WHERE m.user_id = e.created_by;
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no event lists its creator as a member'
                     ELSE v_n || ' events list their creator as a member: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_creator_never_member'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_guard_results() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_guard_results() TO service_role;
COMMENT ON FUNCTION public.cuedeck_guard_results() IS
  'Console guards (132+): event access only through cuedeck_event_role, memberships written by the server only, creators never members. Run as service_role; every row must be ok.';
```

- [ ] **Step 5: Static check.** Run: `grep -n "SECURITY DEFINER" -A1 supabase/migrations/132_event_teams_guard.sql`. Expected: followed by `SET search_path = public`.

- [ ] **Step 6: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/132_event_teams_guard.sql tests/sql/132-event-teams-isolation-probe.sql
git commit -m "feat(db): event teams guard and the spec isolation matrix probe (migration 132)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/132_event_teams_guard.sql tests/sql/132-event-teams-isolation-probe.sql
```

---

# Stage 2: Server

### Task 2.1: Seats, my events, the event team and the welcome rule (migration 133)

Spec §5 (event switcher lists every event the person created or is an active member of, grouped by organiser; the Team window shows the current event's members with role, status and last seen, replacing the account-wide `get_operators_with_last_seen`), §6 (seats per event from the owner's plan, enforced on the server in the membership insert; a downgrade keeps existing members and blocks new invites; all limits for an event come from its owner's plan), §9.2 (members-only people get no founder welcome), §10 side note on `handle_first_login(p_user_id)` (it is rewritten here, so it must take the caller from `auth.uid()`).

**Files:**
- Create: `supabase/migrations/133_event_teams_server.sql`
- Create: `tests/sql/133-event-teams-server-probe.sql`

**Interfaces:**
- Consumes: Task 1.1 (`leod_event_members`, `cuedeck_event_role_of`, `leod_event_members_guard()` and its checks). Live body of `handle_first_login(p_user_id uuid) RETURNS jsonb` (8 Oct), quoted in the migration header.
- Produces:
  - `public.cuedeck_plan_seats(p_owner uuid) RETURNS integer`: team size per event from the owner's latest subscription. `NULL` means no limit. Pro 20, Starter 5, Per-event 5, Enterprise and running trial no limit, no subscription row no limit (the console creates an organiser's trial on first boot), ended trial or `expired`/`canceled` status 0, any other plan name 0. Internal: service_role only.
  - `public.cuedeck_event_seats_of(p_event_id uuid) RETURNS jsonb`: `{"used": <members of the event, active and suspended>, "limit": <cuedeck_plan_seats(owner) or null>}`; `NULL` for an unknown event. Internal: service_role only (invite-operator calls it).
  - `leod_event_members_guard()`: everything from Task 1.1 plus, on INSERT, a per-event advisory lock and `RAISE … 'seats_full: …' USING ERRCODE = 'check_violation'` when `used >= limit`.
  - `public.cuedeck_my_events() RETURNS TABLE(event_id uuid, role text, is_owner boolean, owner_id uuid, organiser text, plan text, plan_status text, trial_ends_at timestamptz)`: one row per event the caller created or is an active member of. `organiser` is the owner's company name, else organization, else name, else `NULL`. `plan`, `plan_status`, `trial_ends_at` are the owner's latest subscription (or `NULL`). For authenticated.
  - `public.cuedeck_event_team(p_event_id uuid) RETURNS jsonb`: for the event's directors only (creator or active director member), else `42501`. Shape:
    `{"is_owner": bool, "seats": {"used": int, "limit": int|null}, "owner": {"user_id", "name", "email", "last_sign_in_at"}, "members": [{"user_id", "name", "email", "role", "active", "last_sign_in_at", "added_at"}]}`, members ordered by `added_at`.
  - `public.handle_first_login(p_user_id uuid) RETURNS jsonb`: `42501` unless `p_user_id = auth.uid()`; queues the founder welcome only for accounts that are not members-only (members-only: at least one membership and no event of their own). Returns `{"first_login": true, "welcome_email_queued": true|false}` or `{"first_login": false, "login_count": n}`.

- [ ] **Step 1: Check the migration number** (Global Constraints). Expected next free: 133.

- [ ] **Step 2: Write the probe** `tests/sql/133-event-teams-server-probe.sql`:

```sql
-- tests/sql/133-event-teams-server-probe.sql
-- Run after 133. Expected: an error whose message starts with
-- 'PROBE OK 133'. Everything is rolled back by the final RAISE.
-- Before 133 it fails with: function cuedeck_plan_seats(uuid) does not exist.
DO $probe$
DECLARE
  v_pro      uuid := gen_random_uuid();   -- organiser on Pro, company Northwind Events
  v_start    uuid := gen_random_uuid();   -- organiser on Starter, organization Atlas Live
  v_trial    uuid := gen_random_uuid();   -- organiser on a running trial
  v_ended    uuid := gen_random_uuid();   -- organiser whose trial ended
  v_none     uuid := gen_random_uuid();   -- organiser with no subscription row
  v_canc     uuid := gen_random_uuid();   -- organiser on a canceled Pro
  v_stranger uuid := gen_random_uuid();   -- on no event
  v_p        uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 8));
  v_epro uuid; v_estart uuid; v_etrial uuid; v_eended uuid; v_enone uuid; v_ecanc uuid;
  v_res    jsonb;
  v_n      int;
  v_state  text;
  v_msg    text;
  v_failed boolean;
  v_r      record;
  v_i      int;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(v_p || ARRAY[v_pro, v_start, v_trial, v_ended, v_none, v_canc, v_stranger]) AS u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', true
    FROM unnest(v_p || ARRAY[v_pro, v_start, v_trial, v_ended, v_none, v_canc, v_stranger]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
  UPDATE leod_users SET company_name = 'Northwind Events' WHERE id = v_pro;
  UPDATE leod_users SET company_name = '', organization = 'Atlas Live' WHERE id = v_start;
  UPDATE leod_users SET company_name = NULL, organization = NULL, name = NULL WHERE id = v_trial;
  INSERT INTO leod_subscriptions (director_id, plan, status, trial_ends_at) VALUES
    (v_pro,   'pro',     'active',   NULL),
    (v_start, 'starter', 'active',   NULL),
    (v_trial, 'trial',   'active',   now() + interval '2 days'),
    (v_ended, 'trial',   'active',   now() - interval '1 hour'),
    (v_canc,  'pro',     'canceled', NULL);
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 pro', current_date + 30, '09:00', '18:00', v_pro) RETURNING id INTO v_epro;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 starter', current_date + 30, '09:00', '18:00', v_start) RETURNING id INTO v_estart;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 trial', current_date + 30, '09:00', '18:00', v_trial) RETURNING id INTO v_etrial;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 ended', current_date + 30, '09:00', '18:00', v_ended) RETURNING id INTO v_eended;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 none', current_date + 30, '09:00', '18:00', v_none) RETURNING id INTO v_enone;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 canceled', current_date + 30, '09:00', '18:00', v_canc) RETURNING id INTO v_ecanc;

  -- 1. seats per event from the owner's plan
  FOR v_r IN SELECT * FROM (VALUES (v_pro, 20), (v_start, 5), (v_trial, NULL), (v_ended, 0), (v_none, NULL), (v_canc, 0)) AS x(owner, expected) LOOP
    IF cuedeck_plan_seats(v_r.owner) IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: % seats %, expected %', v_r.owner, cuedeck_plan_seats(v_r.owner), v_r.expected;
    END IF;
  END LOOP;
  UPDATE leod_subscriptions SET plan = 'gold', status = 'active' WHERE director_id = v_canc;
  IF cuedeck_plan_seats(v_canc) IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'PROBE FAIL 1: an unknown plan seats %', cuedeck_plan_seats(v_canc); END IF;
  UPDATE leod_subscriptions SET plan = 'pro', status = 'canceled' WHERE director_id = v_canc;
  v_checks := v_checks + 1;

  -- 2. the membership insert enforces seats: Starter takes 5, the sixth is
  --    refused with seats_full; a suspended member still holds a seat
  FOR v_i IN 1..5 LOOP
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[v_i], 'av');
  END LOOP;
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[6], 'av');
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF v_state IS DISTINCT FROM '23514' OR v_msg NOT LIKE 'seats_full%' THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a sixth member on Starter gave % %', coalesce(v_state, 'no error'), v_msg;
  END IF;
  IF cuedeck_event_seats_of(v_estart) IS DISTINCT FROM '{"used": 5, "limit": 5}'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL 2: seats_of %', cuedeck_event_seats_of(v_estart);
  END IF;
  UPDATE leod_event_members SET active = false WHERE event_id = v_estart AND user_id = v_p[1];
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[6], 'av');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: a suspended member freed a seat'; END IF;
  v_checks := v_checks + 1;

  -- 3. a downgrade keeps everyone (Review Focus 5): Pro with 7 members goes
  --    to Starter; nobody loses access, role changes and suspend/reactivate
  --    still work, new members are refused until the plan fits again
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[1], 'stage');
  FOR v_i IN 2..7 LOOP
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[v_i], 'av');
  END LOOP;
  UPDATE leod_subscriptions SET plan = 'starter' WHERE director_id = v_pro;
  IF cuedeck_event_seats_of(v_epro) IS DISTINCT FROM '{"used": 7, "limit": 5}'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL 3: seats_of after the downgrade %', cuedeck_event_seats_of(v_epro);
  END IF;
  FOR v_i IN 1..7 LOOP
    IF cuedeck_event_role_of(v_epro, v_p[v_i]) IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 3: member % lost access', v_i; END IF;
  END LOOP;
  UPDATE leod_event_members SET role = 'director' WHERE event_id = v_epro AND user_id = v_p[2];
  UPDATE leod_event_members SET active = false WHERE event_id = v_epro AND user_id = v_p[3];
  UPDATE leod_event_members SET active = true WHERE event_id = v_epro AND user_id = v_p[3];
  IF cuedeck_event_role_of(v_epro, v_p[2]) IS DISTINCT FROM 'director' OR cuedeck_event_role_of(v_epro, v_p[3]) IS DISTINCT FROM 'av' THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a change on an over-full team did not apply';
  END IF;
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[8], 'av');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: a new member joined an over-full team'; END IF;
  UPDATE leod_subscriptions SET plan = 'pro' WHERE director_id = v_pro;
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[8], 'av');
  v_checks := v_checks + 1;

  -- 4. ended plans seat nobody new; no subscription row and a running trial
  --    have no limit
  FOR v_r IN SELECT * FROM (VALUES (v_ecanc, false), (v_eended, false), (v_enone, true), (v_etrial, true)) AS x(ev, allowed) LOOP
    v_failed := false;
    BEGIN
      INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_r.ev, v_p[1], 'director');
    EXCEPTION WHEN check_violation THEN v_failed := true;
    END;
    IF v_failed = v_r.allowed THEN RAISE EXCEPTION 'PROBE FAIL 4: event % allowed % refused %', v_r.ev, v_r.allowed, v_failed; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 5. two invites into the last seat wait for each other (Review Focus 3):
  --    the guard takes a per-event advisory lock before counting, and still
  --    refuses the creator as a member
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.leod_event_members_guard()'::regprocedure)) = 0
     OR position('owner_not_member' IN pg_get_functiondef('public.leod_event_members_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 5: the membership guard lost its lock or its creator check';
  END IF;
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_enone, v_none, 'stage');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: the creator was stored as a member'; END IF;
  v_checks := v_checks + 1;

  -- 6. cuedeck_my_events: every event the caller created or is an active
  --    member of, with the role, the organiser and the organiser's plan
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[1], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM cuedeck_my_events();
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x WHERE x.event_id = v_epro;
  RESET ROLE;
  -- v_p[1]: stage on pro, director on trial and none, suspended on starter (not listed)
  IF v_n <> 3 THEN RAISE EXCEPTION 'PROBE FAIL 6: member sees % events, expected 3', v_n; END IF;
  IF v_res->>'role' IS DISTINCT FROM 'stage' OR (v_res->>'is_owner')::boolean IS DISTINCT FROM false
     OR (v_res->>'owner_id')::uuid IS DISTINCT FROM v_pro OR v_res->>'organiser' IS DISTINCT FROM 'Northwind Events'
     OR v_res->>'plan' IS DISTINCT FROM 'pro' OR v_res->>'plan_status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: member row %', v_res;
  END IF;
  SET LOCAL ROLE authenticated;
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x WHERE x.event_id = v_etrial;
  RESET ROLE;
  IF v_res->>'organiser' IS NOT NULL OR v_res->>'role' IS DISTINCT FROM 'director' OR v_res->>'plan' IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: an organiser with no names shows %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_start, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x;
  RESET ROLE;
  IF v_res->>'role' IS DISTINCT FROM 'director' OR (v_res->>'is_owner')::boolean IS DISTINCT FROM true
     OR v_res->>'organiser' IS DISTINCT FROM 'Atlas Live' OR v_res->>'plan' IS DISTINCT FROM 'starter' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: own event row %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM cuedeck_my_events();
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: a stranger sees % events', v_n; END IF;
  v_checks := v_checks + 1;

  -- 7. cuedeck_event_team: the event's directors see the team and the seats;
  --    anyone else is refused with 42501
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pro, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := cuedeck_event_team(v_epro);
  RESET ROLE;
  IF (v_res->>'is_owner')::boolean IS DISTINCT FROM true
     OR v_res->'seats' IS DISTINCT FROM '{"used": 8, "limit": 20}'::jsonb
     OR (v_res->'owner'->>'user_id')::uuid IS DISTINCT FROM v_pro
     OR jsonb_array_length(v_res->'members') <> 8
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_res->'members'->0) k)
        <> ARRAY['active', 'added_at', 'email', 'last_sign_in_at', 'name', 'role', 'user_id']
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_res) k) <> ARRAY['is_owner', 'members', 'owner', 'seats'] THEN
    RAISE EXCEPTION 'PROBE FAIL 7: the creator got %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[2], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := cuedeck_event_team(v_epro);
  RESET ROLE;
  IF (v_res->>'is_owner')::boolean IS DISTINCT FROM false OR jsonb_array_length(v_res->'members') <> 8 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: an invited director got %', v_res;
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_p[1], v_epro), (v_stranger, v_epro), (v_p[1], v_estart), (v_pro, v_estart)) AS x(uid, ev) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM cuedeck_event_team(v_r.ev);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 7: % read the team of %', v_r.uid, v_r.ev; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 8. first login: no founder welcome for a members-only account; an
  --    organiser gets it; the id must be the caller's own
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[4], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := handle_first_login(v_p[4]);
  RESET ROLE;
  IF v_res IS DISTINCT FROM '{"first_login": true, "welcome_email_queued": false}'::jsonb
     OR EXISTS (SELECT 1 FROM welcome_email_trigger WHERE user_id = v_p[4])
     OR (SELECT first_login_at FROM leod_users WHERE id = v_p[4]) IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 8: members-only first login gave %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_none, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := handle_first_login(v_none);
  RESET ROLE;
  IF v_res IS DISTINCT FROM '{"first_login": true, "welcome_email_queued": true}'::jsonb
     OR NOT EXISTS (SELECT 1 FROM welcome_email_trigger WHERE user_id = v_none) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: an organiser''s first login gave %', v_res;
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (json_build_object('sub', v_p[5], 'role', 'authenticated')::text),
                                   ('{"role":"authenticated"}')) AS x(claims) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', v_r.claims, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM handle_first_login(v_pro);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 8: handle_first_login ran for someone else (%)', v_r.claims; END IF;
  END LOOP;
  IF (SELECT first_login_at FROM leod_users WHERE id = v_pro) IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the refused calls touched the organiser';
  END IF;
  v_checks := v_checks + 1;

  -- 9. grants
  IF has_function_privilege('anon', 'public.cuedeck_plan_seats(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_plan_seats(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_my_events()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_my_events()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_team(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_event_team(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.handle_first_login(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.handle_first_login(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: grants';
  END IF;
  v_checks := v_checks + 1;

  -- 10. guards: checkin_rpcs_refuse_strangers now also calls
  --     cuedeck_event_team as a stranger and must see 42501
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 10: check-in guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                          FROM checkin_guard_results()
                                                         WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                                         'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE NOT ok) THEN
    RAISE EXCEPTION 'PROBE FAIL 10: %', (SELECT string_agg(guard || ': ' || detail, '; ') FROM cuedeck_guard_results() WHERE NOT ok);
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 133: % checks passed (rolled back)', v_checks;
END
$probe$;
```

- [ ] **Step 3 (controller): run the probe before the migration.** Expected: `function cuedeck_plan_seats(uuid) does not exist` (or, while 130 is not applied, an earlier error). Record it.

- [ ] **Step 4: Write the migration** `supabase/migrations/133_event_teams_server.sql`:

```sql
-- ============================================================
-- CueDeck Migration 133: event teams, part 4 (seats, my events, team)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §5, §6, §9.2
--   * Seats per event (§6): the event owner's plan sets the team size;
--     the creator never uses a seat; active and suspended members hold one;
--     enforced here on every membership insert (and pre-checked by
--     invite-operator). A downgrade keeps everyone and only blocks new
--     members. cuedeck_plan_seats is the one place the numbers live on the
--     server; they match PLAN_LIMITS.operators in cuedeck-console.html.
--   * cuedeck_my_events (§5): the events the caller created or is an active
--     member of, with the role, the organiser (for grouping, §9.3) and the
--     organiser's plan (all limits for an event come from it, §6).
--   * cuedeck_event_team (§5): the Team window for one event, for its
--     directors; it replaces get_operators_with_last_seen in the console.
--   * handle_first_login (§9.2): no founder welcome for an account that is
--     only on other organisers' events. Rewritten, so it now takes the
--     caller from auth.uid() (rule since 079; spec §10 side note).
--
-- Live body of handle_first_login before this migration (2026-10-08):
--   reads leod_users WHERE id = p_user_id (any id, from the caller), sets
--   first/last login and login_count, and on first login always inserts
--   welcome_email_trigger and sets welcome_email_sent.
-- ============================================================

-- ── Seats ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cuedeck_plan_seats(p_owner uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- NULL = no limit. No subscription row: the console creates an
  -- organiser's trial on first boot, so this is treated as that trial.
  SELECT CASE
           WHEN s.plan IS NULL THEN NULL
           WHEN s.status IN ('expired', 'canceled') THEN 0
           WHEN s.plan = 'trial' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now() THEN 0
           WHEN s.plan IN ('trial', 'enterprise') THEN NULL
           WHEN s.plan = 'pro' THEN 20
           WHEN s.plan IN ('starter', 'perevent') THEN 5
           ELSE 0
         END
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT ss.plan, ss.status, ss.trial_ends_at
                         FROM leod_subscriptions ss
                        WHERE ss.director_id = p_owner
                        ORDER BY ss.created_at DESC
                        LIMIT 1) s ON true
$$;
REVOKE ALL ON FUNCTION public.cuedeck_plan_seats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_plan_seats(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.cuedeck_event_seats_of(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'used',  (SELECT count(*) FROM leod_event_members m WHERE m.event_id = e.id),
           'limit', cuedeck_plan_seats(e.created_by))
    FROM leod_events e
   WHERE e.id = p_event_id
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_seats_of(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_seats_of(uuid) TO service_role;

-- The membership guard from 130, plus seats on insert. Two invites for the
-- last seat take the same per-event lock, so the second one counts after
-- the first has committed and is refused (Review Focus 3).
CREATE OR REPLACE FUNCTION public.leod_event_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_limit int;
  v_used  int;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'membership event and user cannot change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.created_by INTO v_owner FROM leod_events e WHERE e.id = NEW.event_id;
  IF v_owner = NEW.user_id THEN
    RAISE EXCEPTION 'owner_not_member: the creator of an event is its director and is never a member'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('event_seats:' || NEW.event_id::text, 0));
    v_limit := cuedeck_plan_seats(v_owner);
    IF v_limit IS NOT NULL THEN
      SELECT count(*) INTO v_used FROM leod_event_members m WHERE m.event_id = NEW.event_id;
      IF v_used >= v_limit THEN
        RAISE EXCEPTION 'seats_full: % of % seats used on this event', v_used, v_limit
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leod_event_members_guard() FROM PUBLIC, anon, authenticated;

-- ── My events ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cuedeck_my_events()
RETURNS TABLE(event_id uuid, role text, is_owner boolean, owner_id uuid, organiser text,
              plan text, plan_status text, trial_ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (
    SELECT e.id, e.created_by, cuedeck_event_role_of(e.id, auth.uid()) AS my_role
      FROM leod_events e
     WHERE auth.uid() IS NOT NULL
       AND (e.created_by = auth.uid()
            OR e.id IN (SELECT m.event_id FROM leod_event_members m
                         WHERE m.user_id = auth.uid() AND m.active))
  )
  SELECT x.id, x.my_role, x.created_by = auth.uid(), x.created_by,
         coalesce(nullif(btrim(u.company_name), ''), nullif(btrim(u.organization), ''), nullif(btrim(u.name), '')),
         s.plan, s.status, s.trial_ends_at
    FROM mine x
    LEFT JOIN leod_users u ON u.id = x.created_by
    LEFT JOIN LATERAL (SELECT ss.plan, ss.status, ss.trial_ends_at
                         FROM leod_subscriptions ss
                        WHERE ss.director_id = x.created_by
                        ORDER BY ss.created_at DESC
                        LIMIT 1) s ON true
   WHERE x.my_role IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.cuedeck_my_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_my_events() TO authenticated, service_role;

-- ── The team of one event ───────────────────────────────────
-- For the event's directors (creator or active director member). VOLATILE
-- and 42501 for anyone else, so checkin_rpcs_refuse_strangers (G10) checks
-- it as a stranger from the day it ships.
CREATE OR REPLACE FUNCTION public.cuedeck_event_team(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL OR cuedeck_event_role_of(p_event_id, v_uid) IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT e.created_by INTO v_owner FROM leod_events e WHERE e.id = p_event_id;
  RETURN jsonb_build_object(
    'is_owner', v_owner = v_uid,
    'seats', cuedeck_event_seats_of(p_event_id),
    'owner', (SELECT jsonb_build_object('user_id', v_owner, 'name', u.name,
                                        'email', coalesce(u.email, a.email), 'last_sign_in_at', a.last_sign_in_at)
                FROM auth.users a LEFT JOIN leod_users u ON u.id = a.id
               WHERE a.id = v_owner),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'name', u.name, 'email', coalesce(u.email, a.email),
               'role', m.role, 'active', m.active, 'last_sign_in_at', a.last_sign_in_at,
               'added_at', m.created_at)
             ORDER BY m.created_at, m.user_id)
        FROM leod_event_members m
        LEFT JOIN leod_users u ON u.id = m.user_id
        LEFT JOIN auth.users a ON a.id = m.user_id
       WHERE m.event_id = p_event_id), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_event_team(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_event_team(uuid) TO authenticated, service_role;

-- ── First login ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_first_login(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_is_first_login boolean;
  v_user_email     text;
  v_user_name      text;
  v_members_only   boolean;
BEGIN
  -- The argument stays for the console's call shape; it must be the caller.
  IF v_uid IS NULL OR p_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT email, name, (first_login_at IS NULL)
    INTO v_user_email, v_user_name, v_is_first_login
    FROM leod_users WHERE id = v_uid;
  IF v_user_email IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  UPDATE leod_users SET
    first_login_at = COALESCE(first_login_at, now()),
    last_login_at  = now(),
    login_count    = COALESCE(login_count, 0) + 1
  WHERE id = v_uid;

  -- Someone only on other organisers' events got invite-operator's "added
  -- to" email; the founder welcome and its sequence are for organisers.
  v_members_only := EXISTS (SELECT 1 FROM leod_event_members m WHERE m.user_id = v_uid)
                    AND NOT EXISTS (SELECT 1 FROM leod_events e WHERE e.created_by = v_uid);

  IF v_is_first_login AND NOT v_members_only THEN
    INSERT INTO welcome_email_trigger (user_id, email, name)
    VALUES (v_uid, v_user_email, v_user_name)
    ON CONFLICT (user_id) DO NOTHING;
    UPDATE leod_users SET welcome_email_sent = true WHERE id = v_uid;
    RETURN jsonb_build_object('first_login', true, 'welcome_email_queued', true);
  ELSIF v_is_first_login THEN
    RETURN jsonb_build_object('first_login', true, 'welcome_email_queued', false);
  END IF;
  RETURN jsonb_build_object('first_login', false,
                            'login_count', (SELECT login_count FROM leod_users WHERE id = v_uid));
END;
$$;
REVOKE ALL ON FUNCTION public.handle_first_login(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_first_login(uuid) TO authenticated, service_role;
```

- [ ] **Step 5: Check the seat numbers against the console.** Run: `grep -n "operators:" cuedeck-console.html | head -6`. Expected: trial 999, perevent 5, starter 5, pro 20, enterprise 999, matching `cuedeck_plan_seats` (999 is the console's "no limit"). If they differ, stop and ask: the spec fixes the numbers (§6).

- [ ] **Step 6: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/133_event_teams_server.sql tests/sql/133-event-teams-server-probe.sql
git commit -m "feat(db): seats per event, my events, event team, no founder welcome for members (migration 133)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/133_event_teams_server.sql tests/sql/133-event-teams-server-probe.sql
```

### Task 2.2: `eventRole()` reads memberships (9 transitions and apply-delay)

Spec §3: the server copy `eventRole()` in `_shared/transition.ts` (used by go-live, call-speaker, cancel-session, end-session, hold-stage, reinstate, restart-session, set-overrun, set-ready through `runTransition`, and by apply-delay) follows the same rule as `cuedeck_event_role`.

**Files:**
- Create: `supabase/functions/_shared/members.ts`
- Modify: `supabase/functions/_shared/transition.ts:42-58` (comment and `eventRole`), import at line 1-2
- Modify: `supabase/functions/apply-delay/index.ts:38-41` (comment only)
- Modify: `tests/deno/session-auth.test.ts:14-25` (ids), `:123-150` (`setup`), `:153-175` (`CASES`), `:211-219` (`DELAY_CASES`)

**Interfaces:**
- Consumes: table `leod_event_members(event_id, user_id, role, active)` (Task 1.1).
- Produces:
  - `supabase/functions/_shared/members.ts`: `export const MEMBER_ROLES: Set<string>` (the six roles), `export const UUID: RegExp`. Task 2.3 adds `logMemberChange` to this file.
  - `eventRole(sb, userId: string, eventId: string): Promise<string | null>` (signature unchanged): `'director'` for the creator; else the active membership's role on this event; else `null`. Throws `Error('event lookup failed: …')` or `Error('membership lookup failed: …')` when a read fails.

- [ ] **Step 1: Write the failing tests.** In `tests/deno/session-auth.test.ts`:

Replace the id block (lines 14-25, from `const OWNER` to `const SESSION`) with:

```ts
const OWNER       = '10000000-0000-4000-8000-000000000001'
const OP_DIRECTOR = '10000000-0000-4000-8000-000000000002' // director member of EVENT
const OP_STAGE    = '10000000-0000-4000-8000-000000000003' // stage on EVENT, director on OTHER_EVENT
const OP_AV       = '10000000-0000-4000-8000-000000000004' // av member of EVENT
const OP_OFF      = '10000000-0000-4000-8000-000000000005' // director member of EVENT, suspended
const STRANGER    = '10000000-0000-4000-8000-000000000006' // creates OTHER_EVENT
const OTHER_OP    = '10000000-0000-4000-8000-000000000007' // stage member of OTHER_EVENT only
const NO_ROW      = '10000000-0000-4000-8000-000000000008' // signed in, no leod_users row
const LEGACY      = '10000000-0000-4000-8000-000000000009' // leod_users.invited_by = OWNER, no membership
const EVENT       = '33333333-3333-4333-8333-333333333333'
const OTHER_EVENT = '44444444-4444-4444-8444-444444444444'
const SESSION     = '77777777-7777-4777-8777-777777777777'
```

In `setup()`, replace the `leod_users: [ … ],` array with the following (every account's global role is the signup default, `director`, so a test only passes if the role comes from the membership):

```ts
    leod_users: [
      { id: OWNER,       role: 'director', invited_by: null,  active: true },
      { id: OP_DIRECTOR, role: 'director', invited_by: null,  active: true },
      { id: OP_STAGE,    role: 'director', invited_by: null,  active: true },
      { id: OP_AV,       role: 'director', invited_by: null,  active: true },
      { id: OP_OFF,      role: 'director', invited_by: null,  active: true },
      { id: STRANGER,    role: 'director', invited_by: null,  active: true },
      { id: OTHER_OP,    role: 'director', invited_by: null,  active: true },
      { id: LEGACY,      role: 'stage',    invited_by: OWNER, active: true },
    ],
    leod_event_members: [
      { event_id: EVENT,       user_id: OP_DIRECTOR, role: 'director', active: true },
      { event_id: EVENT,       user_id: OP_STAGE,    role: 'stage',    active: true },
      { event_id: EVENT,       user_id: OP_AV,       role: 'av',       active: true },
      { event_id: EVENT,       user_id: OP_OFF,      role: 'director', active: false },
      { event_id: OTHER_EVENT, user_id: OTHER_OP,    role: 'stage',    active: true },
      { event_id: OTHER_EVENT, user_id: OP_STAGE,    role: 'director', active: true },
    ],
```

In `CASES`, keep every existing row and add these four after `['a user with no operator row is refused','go-live', 'READY', NO_ROW, 403],`:

```ts
  ['a global director who is stage on this event cannot cancel', 'cancel-session', 'READY', OP_STAGE, 403],
  ['a suspended member is refused',          'end-session',     'LIVE',    OP_OFF,      403],
  ['the old invited_by link alone is refused', 'go-live',       'READY',   LEGACY,      403],
  ['director on another event is stage here: no reinstate', 'reinstate', 'CANCELLED', OP_STAGE, 403],
```

In `DELAY_CASES`, add after `["another owner's operator",    OTHER_OP,    403],`:

```ts
  ['the old invited_by link alone', LEGACY,     403],
```

- [ ] **Step 2: Run them and see them fail.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/session-auth.test.ts`
Expected: FAIL. The invited director, stage and av cases now get 403 (the old `eventRole` reads `leod_users.invited_by`, which is null for them), for example `cancel-session: invited active director cancels (200) … status 403`.

- [ ] **Step 3: Create** `supabase/functions/_shared/members.ts`:

```ts
// members.ts: event teams (spec docs/superpowers/specs/2026-10-08-event-teams-design.md).
// Membership is per event in leod_event_members; the event's creator is its
// director and is never a row there. Shared by transition.ts,
// invite-operator and manage-operator.

// The six console roles a membership may have (same CHECK as the table).
export const MEMBER_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
```

- [ ] **Step 4: Rewrite `eventRole`.** In `supabase/functions/_shared/transition.ts` add the import under the two existing imports:

```ts
import { MEMBER_ROLES } from './members.ts'
```

and replace the block from `// The caller's role in an event, or null when they are not part of it. The` down to the closing `}` of `eventRole` (lines 42-58) with:

```ts
// The caller's role in an event, or null when they are not part of it. Same
// rule as cuedeck_event_role (migration 130): the creator
// (leod_events.created_by) is director; anyone else needs an active row in
// leod_event_members for this event, and the role is that row's, never the
// operator_role a request claims and never the account's global role. A
// failed lookup throws, so the caller refuses instead of guessing.
// deno-lint-ignore no-explicit-any
export async function eventRole(sb: any, userId: string, eventId: string): Promise<string | null> {
  const { data: ev, error: evErr } = await sb
    .from('leod_events').select('created_by').eq('id', eventId).maybeSingle()
  if (evErr) throw new Error('event lookup failed: ' + evErr.message)
  if (!ev?.created_by) return null
  if (ev.created_by === userId) return 'director'
  const { data: m, error: mErr } = await sb
    .from('leod_event_members').select('role, active')
    .eq('event_id', eventId).eq('user_id', userId).maybeSingle()
  if (mErr) throw new Error('membership lookup failed: ' + mErr.message)
  if (!m || m.active !== true || !MEMBER_ROLES.has(m.role)) return null
  return m.role
}
```

In `supabase/functions/apply-delay/index.ts` replace the comment lines

```ts
  // Same rule as runTransition: owner, or an active operator the owner
  // invited, with a role in ROLE_DELAY. operator_role is only logged.
```

with

```ts
  // Same rule as runTransition: the event's creator, or an active member
  // of this event, with a role in ROLE_DELAY. operator_role is only logged.
```

- [ ] **Step 5: Run the tests and see them pass.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/session-auth.test.ts`
Expected: PASS, `ok | 0 failed`, with the four new transition cases and the new delay case listed.

Run: `deno test --allow-env --allow-read --no-lock tests/deno/restart-session.test.ts`
Expected: PASS (its caller is the event's creator).

Run: `npx vitest run tests/session-auth.spec.ts tests/restart-session.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/functions/_shared/members.ts supabase/functions/_shared/transition.ts supabase/functions/apply-delay/index.ts tests/deno/session-auth.test.ts
git commit -m "feat(functions): session transitions and delays check the per-event membership" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/functions/_shared/members.ts supabase/functions/_shared/transition.ts supabase/functions/apply-delay/index.ts tests/deno/session-auth.test.ts
```

### Task 2.3: Team server functions: `invite-operator` and `manage-operator`

Spec §4 (invite new and existing accounts to one event; same role: no-op; other role: change it; who may invite and manage: the creator and the event's directors; change, suspend and remove act on this event's membership only; remove never bans; "remove from all my events"; every change logged in the event's log as `MEMBER_INVITED`, `MEMBER_ROLE_CHANGED`, `MEMBER_SUSPENDED`, `MEMBER_REMOVED`; 20 invitations per organiser per 24 h, counted per event owner), §6 (seats enforced on the server in the invite function and the membership insert), §9.2 ("added to event" email).

The test file `tests/deno/operators.test.ts` pins the old model (inventory §8: 409 on an existing email, `invited_by` values, ban on remove). It is replaced as a whole. Each old test's risk keeps a test: "never takes over someone else's account" becomes "an existing account keeps its own role and other events"; "remove bans the account" becomes "remove never bans, and the person is off this event's team"; "another tenant's director cannot touch this team" stays; "a failed row write deletes only an account this request created" stays.

**Files:**
- Modify: `supabase/functions/_shared/members.ts` (add `logMemberChange`)
- Modify: `supabase/functions/_shared/invite-email.ts:51-77` (console "added to" wording)
- Replace: `supabase/functions/invite-operator/index.ts`
- Replace: `supabase/functions/manage-operator/index.ts`
- Replace: `tests/deno/operators.test.ts`
- Unchanged: `tests/operators.spec.ts` (runs the deno file)

**Interfaces:**
- Consumes: `eventRole(sb, userId, eventId)` and `MEMBER_ROLES`, `UUID` (Task 2.2); RPC `cuedeck_event_seats_of(p_event_id) → {used, limit}` and the seat trigger error `23514 'seats_full: …'` (Task 2.1); `sendInviteEmail(m: InviteEmail)` (existing).
- Produces:
  - `logMemberChange(sb, eventId: string, operatorId: string, action: string, payload: Record<string, unknown>): Promise<void>` in `_shared/members.ts`.
  - `POST /functions/v1/invite-operator` body `{ email: string, role: string, name?: string, event_id: string }`. Answers:
    - `200 { ok: true, user_id, role, result: 'invited' | 'added' | 'link_resent' | 'unchanged' | 'role_changed' }`
    - `400 { error }` (missing email, role or event; `code: 'not_console_event'` for a check-in event)
    - `403 { error }` (not a director of the event, or no such event)
    - `409 { error, code: 'seats_full', used?, limit?, is_owner: boolean }`, `409 { error, code: 'is_owner' }`, `409 { error, code: 'already_on_event' }`
    - `429 { error, code: 'invite_rate' }`, `502 { error }` (email or auth provider failed, nothing left behind), `500 { error }`
  - `POST /functions/v1/manage-operator` body `{ action: 'suspend' | 'reactivate' | 'remove' | 'set_role', user_id: string, role?: string, event_id?: string }`. Answers: `200 { ok: true, action, events: string[], role? }`, `400`, `403` (not a director of the given event), `404 { code: 'not_member' }`, `500 { error, events }`.
  - Log rows: `leod_event_log` with `event_id` = the event, `operator_id` = the caller, `action` one of `MEMBER_INVITED`, `MEMBER_ROLE_CHANGED`, `MEMBER_SUSPENDED`, `MEMBER_REACTIVATED`, `MEMBER_REMOVED`; payload `{ target_user_id, role?, from_role?, event_owner?, existing_account? }`. No email address in the payload (every member of the event reads its log).

- [ ] **Step 1: Write the failing tests.** Replace `tests/deno/operators.test.ts` with:

```ts
// tests/deno/operators.test.ts
// invite-operator and manage-operator (event teams, spec 2026-10-08 §4)
// against a stubbed Supabase. The stubbed generate_link plays the auth
// trigger handle_new_auth_user: a new address gets a leod_users row with the
// signup default role (director), which the invite must leave alone; an
// address that already has an account returns that account.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/operators.test.ts
// (tests/operators.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('RESEND_API_KEY', 're_stub_key_for_tests') // api.resend.com is stubbed below

const OWNER    = '20000000-0000-4000-8000-000000000001' // creates EV and EV_OWN2
const DIR      = '20000000-0000-4000-8000-000000000002' // director member of EV
const STAGE    = '20000000-0000-4000-8000-000000000003' // stage on EV, av on EV_OWN2
const OFF      = '20000000-0000-4000-8000-000000000004' // director member of EV, suspended
const STRANGER = '20000000-0000-4000-8000-000000000005' // another organiser, creates EV_THEIRS
const THEIR_OP = '20000000-0000-4000-8000-000000000006' // av member of EV_THEIRS
const NEW_ID   = '20000000-0000-4000-8000-0000000000aa'
const EV        = '30000000-0000-4000-8000-000000000001'
const EV_THEIRS = '30000000-0000-4000-8000-000000000002'
const EV_OWN2   = '30000000-0000-4000-8000-000000000003'
const EV_CHECKIN = '30000000-0000-4000-8000-000000000004'
const SIGNED_IN = { last_sign_in_at: '2026-10-01T09:00:00Z', email_confirmed_at: '2026-09-01T09:00:00Z' }

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let authUsers: Record<string, Row>
let links: { email: string; type: string; data: Row }[]
let emails: Row[] = []
let authAdmin: { method: string; id: string }[]
let writes: { method: string; table: string; body: unknown }[]
let seatLimit: number | null
let inviteCreatedAt: string | null = null
let failOn: Record<string, { status: number; body: Row }> = {}

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    // 'payload->>key' reads inside a json column, as PostgREST does.
    const get = (r: Row) => { const m = k.match(/^(\w+)->>(\w+)$/); return m ? (r[m[1]] as Row | undefined)?.[m[2]] : r[k] }
    if (v.startsWith('eq.')) tests.push(r => String(get(r)) === v.slice(3))
    if (v.startsWith('gte.')) tests.push(r => String(get(r) ?? '') >= v.slice(4))
  }
  return (r: Row) => tests.every(fn => fn(r))
}
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers)
  const rawBody = init?.body ?? (req ? await req.clone().text() : undefined)
  if (url.host === 'api.resend.com') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    emails.push(b)
    if (failOn['RESEND']) return reply(failOn['RESEND'].status, failOn['RESEND'].body)
    return reply(200, { id: 'email-stub' })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  const key = `${method} ${url.pathname}`
  if (failOn[key]) return reply(failOn[key].status, failOn[key].body)
  if (url.pathname === '/auth/v1/user') {
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  if (url.pathname === '/auth/v1/admin/generate_link') {
    const b = JSON.parse(String(rawBody ?? '{}'))
    links.push({ email: b.email, type: b.type, data: b.data })
    // An address with an account returns that account; a new one gets the
    // signup trigger's row (role director, no team).
    const known = tables.leod_users.find(u => u.email === b.email)
    const id = known ? String(known.id) : NEW_ID
    if (!known) tables.leod_users.push({ id, email: b.email, role: 'director', active: true, name: '' })
    return reply(200, { id, email: b.email, aud: 'authenticated',
      created_at: known ? '2026-01-01T00:00:00.000Z' : (inviteCreatedAt ?? new Date().toISOString()),
      action_link: `https://stub.local/verify?token=${b.type}&type=${b.type}` })
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/)
  if (adminUser) {
    authAdmin.push({ method, id: adminUser[1] })
    if (method === 'GET') return reply(200, { id: adminUser[1], aud: 'authenticated', ...(authUsers[adminUser[1]] ?? {}) })
    return reply(200, { id: adminUser[1] })
  }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/)
  if (rpc) {
    const b = JSON.parse(String(rawBody ?? '{}'))
    if (rpc[1] === 'cuedeck_event_seats_of') {
      return reply(200, { used: tables.leod_event_members.filter(m => m.event_id === b.p_event_id).length, limit: seatLimit })
    }
    return reply(404, { message: 'stub: no rpc ' + rpc[1] })
  }

  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  const wantRows = (headers.get('Prefer') ?? '').includes('return=representation')
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Range': `*/${rows.filter(match).length}` } })
  }
  if (method === 'GET') {
    let hit = rows.filter(match)
    const limit = url.searchParams.get('limit')
    if (limit) hit = hit.slice(0, Number(limit))
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (hit.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      return reply(200, hit[0])
    }
    return reply(200, hit)
  }
  const body = rawBody ? JSON.parse(String(rawBody)) : undefined
  writes.push({ method, table, body })
  if (method === 'POST') {
    const list: Row[] = Array.isArray(body) ? body : [body]
    for (const r of list) {
      if (table === 'leod_event_members' && rows.some(x => x.event_id === r.event_id && x.user_id === r.user_id)) {
        return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "leod_event_members_pkey"' })
      }
      rows.push({ ...r })
    }
    return wantRows ? reply(201, list) : reply(201, undefined)
  }
  if (method === 'PATCH') {
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, body))
    return wantRows ? reply(200, hit) : reply(204, undefined)
  }
  if (method === 'DELETE') {
    const hit = rows.filter(match)
    tables[table] = rows.filter(r => !hit.includes(r))
    return wantRows ? reply(200, hit) : reply(204, undefined)
  }
  return reply(405, { message: 'stub: method' })
}) as typeof fetch

const handlers: Record<string, (req: Request) => Promise<Response>> = {}
let captured: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', {
  configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { captured = h; return { finished: Promise.resolve(), shutdown: async () => {} } },
})
for (const fn of ['invite-operator', 'manage-operator']) {
  captured = null
  await import(`${FN_DIR}${fn}/index.ts`)
  if (!captured) throw new Error('no handler captured for ' + fn)
  handlers[fn] = captured
}

async function call(fn: string, as: string, body: Row): Promise<{ status: number; body: Row }> {
  const res = await handlers[fn](new Request('http://stub.local/functions/v1/' + fn, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + as, 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io' },
    body: JSON.stringify(body),
  }))
  const text = await res.text()
  let parsed: Row = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text } }
  return { status: res.status, body: parsed }
}

function setup() {
  links = []
  emails = []
  authAdmin = []
  writes = []
  seatLimit = null
  inviteCreatedAt = null
  failOn = {}
  // Every account's global role is the signup default; roles live on memberships.
  tables = {
    leod_users: [
      { id: OWNER,    email: 'owner@x.test',  role: 'director', active: true, name: 'Olga Owner' },
      { id: DIR,      email: 'dir@x.test',    role: 'director', active: true, name: 'Dana Director' },
      { id: STAGE,    email: 'stage@x.test',  role: 'director', active: true, name: 'Sami Stage' },
      { id: OFF,      email: 'off@x.test',    role: 'director', active: true, name: 'Omar Off' },
      { id: STRANGER, email: 'other@y.test',  role: 'director', active: true, name: 'Yara Other' },
      { id: THEIR_OP, email: 'theirs@y.test', role: 'director', active: true, name: 'Tarek Theirs' },
    ],
    leod_events: [
      { id: EV,         created_by: OWNER,    name: 'Gala <b>2026</b>',    date: '2026-10-18', created_via: 'console', active: true },
      { id: EV_OWN2,    created_by: OWNER,    name: 'Spring summit',       date: '2027-03-02', created_via: 'console', active: true },
      { id: EV_THEIRS,  created_by: STRANGER, name: 'Their Secret Launch', date: '2026-11-01', created_via: 'console', active: true },
      { id: EV_CHECKIN, created_by: OWNER,    name: 'Desk only',           date: '2026-12-01', created_via: 'checkin', active: true },
    ],
    leod_event_members: [
      { event_id: EV,        user_id: DIR,      role: 'director', active: true },
      { event_id: EV,        user_id: STAGE,    role: 'stage',    active: true },
      { event_id: EV_OWN2,   user_id: STAGE,    role: 'av',       active: true },
      { event_id: EV,        user_id: OFF,      role: 'director', active: false },
      { event_id: EV_THEIRS, user_id: THEIR_OP, role: 'av',       active: true },
    ],
    leod_event_log: [],
  }
  authUsers = { [OWNER]: SIGNED_IN, [DIR]: SIGNED_IN, [STAGE]: SIGNED_IN, [OFF]: SIGNED_IN, [STRANGER]: SIGNED_IN, [THEIR_OP]: SIGNED_IN }
}
const member = (ev: string, id: string) => tables.leod_event_members.find(m => m.event_id === ev && m.user_id === id)
const user = (id: string) => tables.leod_users.find(u => u.id === id)
const logs = (action: string) => tables.leod_event_log.filter(l => l.action === action) as { event_id: string; operator_id: string; payload: Row }[]

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ── invite-operator ──────────────────────────────────────────────────────────
Deno.test('invite: a new email gets an account, a membership on this event only, and the invitation', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'New.Crew@x.test', name: 'New Crew', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'invited' && r.body.user_id === NEW_ID, JSON.stringify(r))
  const m = member(EV, NEW_ID)
  assert(m?.role === 'stage' && m.active === true && m.invited_by === OWNER, 'membership ' + JSON.stringify(m))
  assert(!member(EV_OWN2, NEW_ID), 'joined another event')
  const u = user(NEW_ID)
  assert(u?.role === 'director' && !('invited_by' in u) && u.name === 'New Crew', 'leod_users row ' + JSON.stringify(u))
  assert(links.length === 1 && links[0].type === 'invite' && links[0].email === 'new.crew@x.test', JSON.stringify(links))
  const mail = emails[0] as { subject: string; html: string; to: string }
  assert(mail.to === 'new.crew@x.test' && mail.subject === "You're invited to Gala b2026/b on CueDeck", mail.subject)
  assert(mail.html.includes('Olga Owner has invited you to work on') && mail.html.includes('the Stage role'), 'body')
  assert(mail.html.includes('Gala &lt;b&gt;2026&lt;/b&gt;') && !mail.html.includes('<b>2026'), 'escaping')
  const log = logs('MEMBER_INVITED')
  assert(log.length === 1 && log[0].event_id === EV && log[0].operator_id === OWNER
    && log[0].payload.event_owner === OWNER && log[0].payload.target_user_id === NEW_ID
    && log[0].payload.existing_account === false && !JSON.stringify(log[0].payload).includes('@'), JSON.stringify(log))
})

Deno.test("invite: an existing account on another organiser's event is added with a short notice, no password step", async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added' && r.body.user_id === THEIR_OP, JSON.stringify(r))
  assert(member(EV, THEIR_OP)?.role === 'av' && member(EV_THEIRS, THEIR_OP)?.role === 'av', 'memberships ' + JSON.stringify(tables.leod_event_members))
  assert(links.length === 0, 'a link was made for a login that already works')
  const mail = emails[0] as { subject: string; html: string }
  assert(mail.subject === "You've been added to Gala b2026/b on CueDeck", mail.subject)
  assert(mail.html.includes('Olga Owner has added you to') && mail.html.includes('Open CueDeck')
    && mail.html.includes('Sign in with your existing CueDeck login.'), 'notice body')
  assert(user(THEIR_OP)?.role === 'director' && writes.every(w => w.table !== 'leod_users'), 'the account was written')
})

Deno.test("invite: an organiser of their own events can crew someone else's event", async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'other@y.test', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added' && member(EV, STRANGER)?.role === 'stage', JSON.stringify(r))
})

Deno.test('invite: an existing email typed in another case joins that account', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: '  Theirs@Y.Test ', role: 'reg', event_id: EV })
  assert(r.status === 200 && r.body.user_id === THEIR_OP && member(EV, THEIR_OP)?.role === 'reg', JSON.stringify(r))
  assert(links.length === 0 && tables.leod_users.length === 6, 'a second account was made')
})

Deno.test('invite: the same role again changes nothing and sends nothing', async () => {
  setup()
  const r = await call('invite-operator', OWNER, { email: 'stage@x.test', role: 'stage', event_id: EV })
  assert(r.status === 200 && r.body.result === 'unchanged', JSON.stringify(r))
  assert(emails.length === 0 && links.length === 0 && writes.length === 0, 'something was sent or written')
})

Deno.test('invite: another role on the same event changes the role there only, and sends nothing', async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'stage@x.test', role: 'director', event_id: EV })
  assert(r.status === 200 && r.body.result === 'role_changed', JSON.stringify(r))
  assert(member(EV, STAGE)?.role === 'director' && member(EV_OWN2, STAGE)?.role === 'av', JSON.stringify(tables.leod_event_members))
  assert(emails.length === 0, 'an email was sent')
  const log = logs('MEMBER_ROLE_CHANGED')
  assert(log.length === 1 && log[0].payload.from_role === 'stage' && log[0].payload.role === 'director' && log[0].operator_id === DIR, JSON.stringify(log))
})

Deno.test('invite: an existing account that never signed in gets a fresh invite link', async () => {
  setup()
  authUsers[THEIR_OP] = { last_sign_in_at: null, email_confirmed_at: null }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'added', JSON.stringify(r))
  assert(links.length === 1 && links[0].type === 'invite', JSON.stringify(links))
  assert((emails[0] as { html: string }).html.includes('https://stub.local/verify?token=invite&amp;type=invite'), 'link')
  // confirmed but never signed in: a password link instead
  setup()
  authUsers[THEIR_OP] = { last_sign_in_at: null, email_confirmed_at: '2026-09-01T00:00:00Z' }
  await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(links.length === 1 && links[0].type === 'recovery', JSON.stringify(links))
})

Deno.test("invite: the event's creator cannot be invited to it", async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'owner@x.test', role: 'stage', event_id: EV })
  assert(r.status === 409 && r.body.code === 'is_owner', JSON.stringify(r))
  assert(writes.length === 0 && emails.length === 0, 'something was written or sent')
})

Deno.test('invite: only the creator and active director members may invite', async () => {
  for (const who of [STAGE, OFF, STRANGER, THEIR_OP]) {
    setup()
    const r = await call('invite-operator', who, { email: 'n@x.test', role: 'av', event_id: EV })
    assert(r.status === 403, who + ' ' + JSON.stringify(r))
    assert(links.length === 0 && writes.length === 0, who + ' created something')
  }
  setup()
  const r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 200, 'invited director ' + JSON.stringify(r))
})

Deno.test('invite: an invited director invites only on events they direct', async () => {
  setup()
  const r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV_OWN2 })
  assert(r.status === 403 && links.length === 0, JSON.stringify(r))
})

Deno.test('invite: the event is required, must exist, and must be a console event', async () => {
  setup()
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av' })
  assert(r.status === 400, 'no event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: '30000000-0000-4000-8000-0000000000ff' })
  assert(r.status === 403, 'unknown event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV_CHECKIN })
  assert(r.status === 400 && r.body.code === 'not_console_event', 'check-in event ' + JSON.stringify(r))
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'admin', event_id: EV })
  assert(r.status === 400, 'admin role ' + JSON.stringify(r))
  assert(links.length === 0 && writes.length === 0, 'something was created')
})

Deno.test('invite: a full team is refused before anything is created, with who should act', async () => {
  setup()
  seatLimit = 3   // DIR, STAGE and the suspended OFF hold the three seats
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full' && r.body.is_owner === true && r.body.used === 3 && r.body.limit === 3, JSON.stringify(r))
  r = await call('invite-operator', DIR, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full' && r.body.is_owner === false, JSON.stringify(r))
  assert(links.length === 0 && emails.length === 0 && writes.length === 0, 'created or sent anyway')
  // a role change needs no seat
  r = await call('invite-operator', OWNER, { email: 'stage@x.test', role: 'av', event_id: EV })
  assert(r.status === 200 && r.body.result === 'role_changed', 'role change on a full team ' + JSON.stringify(r))
})

Deno.test('invite: a seat taken while inviting (23514) withdraws the new account', async () => {
  setup()
  failOn['POST /rest/v1/leod_event_members'] = { status: 400, body: { code: '23514', message: 'seats_full: 3 of 3 seats used on this event' } }
  const r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'seats_full', JSON.stringify(r))
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'new account kept: ' + JSON.stringify(authAdmin))
  assert(emails.length === 0, 'an email was sent')
})

Deno.test('invite: someone added the same person a moment earlier: 409, their membership stays', async () => {
  setup()
  // The read before the insert found no membership; the insert then hits the
  // row another director added in between (23505). Nothing is undone.
  failOn['POST /rest/v1/leod_event_members'] = { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "leod_event_members_pkey"' } }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 409 && r.body.code === 'already_on_event', JSON.stringify(r))
  assert(!writes.some(w => w.method === 'DELETE' && w.table === 'leod_event_members'), 'a membership was deleted')
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'an existing account was deleted')
  assert(emails.length === 0, 'an email was sent')
})

Deno.test('invite: 20 invitations per event owner per 24 hours, then 429 before anything', async () => {
  setup()
  const recent = new Date(Date.now() - 3600e3).toISOString()
  const old = new Date(Date.now() - 30 * 3600e3).toISOString()
  for (let i = 0; i < 20; i++) tables.leod_event_log.push({ id: i, action: 'MEMBER_INVITED', ts: recent, payload: { event_owner: OWNER } })
  tables.leod_event_log.push({ id: 99, action: 'MEMBER_INVITED', ts: recent, payload: { event_owner: STRANGER } })
  const r = await call('invite-operator', DIR, { email: 'one.more@x.test', role: 'av', event_id: EV })
  assert(r.status === 429 && r.body.code === 'invite_rate', JSON.stringify(r))
  assert(links.length === 0 && emails.length === 0, 'created or sent anyway')
  tables.leod_event_log.forEach(l => { if ((l.payload as Row)?.event_owner === OWNER) l.ts = old })
  const r2 = await call('invite-operator', DIR, { email: 'one.more@x.test', role: 'av', event_id: EV })
  assert(r2.status === 200, JSON.stringify(r2))
})

Deno.test('invite: a link-shaped event or inviter name is left out of the email', async () => {
  setup()
  tables.leod_events.find(e => e.id === EV)!.name = 'Account locked, verify at evil.example'
  tables.leod_users.find(u => u.id === OWNER)!.name = 'support@evil.example'
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV })
  assert(r.status === 200, JSON.stringify(r))
  const m = emails[0] as { subject: string; html: string; text: string }
  assert(!/evil\.example/.test(m.subject + m.html + m.text), 'link text sent: ' + m.subject)
  assert(m.subject === "You're invited to join a team on CueDeck" && m.html.includes('You have been invited'), m.subject)
})

Deno.test('invite: a failed invitation email withdraws the new account and the membership', async () => {
  setup()
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  const r = await call('invite-operator', OWNER, { email: 'crew@x.test', role: 'av', event_id: EV })
  assert(r.status === 502, JSON.stringify(r))
  assert(!member(EV, NEW_ID), 'membership kept')
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'account kept ' + JSON.stringify(authAdmin))
  assert(logs('MEMBER_INVITED').length === 0, 'logged as invited')
})

Deno.test('invite: a failed notice to an existing login keeps the membership', async () => {
  setup()
  failOn['RESEND'] = { status: 500, body: { message: 'provider down' } }
  const r = await call('invite-operator', OWNER, { email: 'theirs@y.test', role: 'av', event_id: EV })
  assert(r.status === 200 && member(EV, THEIR_OP)?.role === 'av', JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'an existing account was deleted')
})

Deno.test('invite: a failed membership write is a 500 and deletes only an account made by this request', async () => {
  setup()
  failOn['POST /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  let r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage', event_id: EV })
  assert(r.status === 500, JSON.stringify(r))
  assert(authAdmin.some(a => a.method === 'DELETE' && a.id === NEW_ID), 'new account kept: ' + JSON.stringify(authAdmin))
  setup()
  inviteCreatedAt = '2026-01-01T00:00:00.000Z'   // the auth account existed before this request
  failOn['POST /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  r = await call('invite-operator', OWNER, { email: 'n@x.test', role: 'stage', event_id: EV })
  assert(r.status === 500, JSON.stringify(r))
  assert(!authAdmin.some(a => a.method === 'DELETE'), 'deleted an older account: ' + JSON.stringify(authAdmin))
})

// ── manage-operator ──────────────────────────────────────────────────────────
Deno.test('manage: the creator suspends and reactivates a member on this event only', async () => {
  setup()
  let r = await call('manage-operator', OWNER, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === false && member(EV_OWN2, STAGE)?.active === true, JSON.stringify(r))
  assert(user(STAGE)?.active === true, 'the account was suspended')
  r = await call('manage-operator', OWNER, { action: 'reactivate', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === true, JSON.stringify(r))
  assert(logs('MEMBER_SUSPENDED').length === 1 && logs('MEMBER_SUSPENDED')[0].event_id === EV
    && logs('MEMBER_REACTIVATED').length === 1, JSON.stringify(tables.leod_event_log))
})

Deno.test('manage: an invited director manages a teammate on the event they direct, not elsewhere', async () => {
  setup()
  let r = await call('manage-operator', DIR, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && member(EV, STAGE)?.active === false, JSON.stringify(r))
  r = await call('manage-operator', DIR, { action: 'suspend', user_id: STAGE, event_id: EV_OWN2 })
  assert(r.status === 403 && member(EV_OWN2, STAGE)?.active === true, JSON.stringify(r))
})

Deno.test("manage: stage, suspended directors and another organiser cannot touch this event's team", async () => {
  for (const who of [STAGE, OFF, STRANGER, THEIR_OP]) {
    for (const action of ['suspend', 'remove', 'set_role']) {
      setup()
      const r = await call('manage-operator', who, { action, user_id: DIR, role: 'av', event_id: EV })
      assert(r.status === 403, `${who} ${action}: ${JSON.stringify(r)}`)
      assert(member(EV, DIR)?.role === 'director' && member(EV, DIR)?.active === true && writes.length === 0, `${who} ${action} changed the team`)
    }
  }
})

Deno.test('manage: remove takes the person off this event only: no ban, the login and other events stay', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: STAGE, event_id: EV })
  assert(r.status === 200 && JSON.stringify(r.body.events) === JSON.stringify([EV]), JSON.stringify(r))
  assert(!member(EV, STAGE) && member(EV_OWN2, STAGE)?.role === 'av', JSON.stringify(tables.leod_event_members))
  assert(authAdmin.length === 0, 'the auth account was touched: ' + JSON.stringify(authAdmin))
  assert(user(STAGE) && writes.every(w => w.table !== 'leod_users'), 'the account row was touched')
  assert(logs('MEMBER_REMOVED').length === 1 && logs('MEMBER_REMOVED')[0].payload.target_user_id === STAGE, 'not logged')
})

Deno.test("manage: without an event, remove covers every event the caller created, and nobody else's", async () => {
  setup()
  tables.leod_event_members.push({ event_id: EV_THEIRS, user_id: STAGE, role: 'reg', active: true })
  const r = await call('manage-operator', OWNER, { action: 'remove', user_id: STAGE })
  assert(r.status === 200 && (r.body.events as string[]).sort().join() === [EV, EV_OWN2].sort().join(), JSON.stringify(r))
  assert(!member(EV, STAGE) && !member(EV_OWN2, STAGE) && member(EV_THEIRS, STAGE)?.role === 'reg', JSON.stringify(tables.leod_event_members))
  assert(logs('MEMBER_REMOVED').length === 2 && authAdmin.length === 0, 'logs or a ban')
})

Deno.test('manage: without an event, an invited director reaches nobody', async () => {
  setup()
  const r = await call('manage-operator', DIR, { action: 'remove', user_id: STAGE })
  assert(r.status === 404 && r.body.code === 'not_member' && member(EV, STAGE), JSON.stringify(r))
})

Deno.test('manage: set_role changes the role on this event only', async () => {
  setup()
  const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: STAGE, role: 'director', event_id: EV })
  assert(r.status === 200 && r.body.role === 'director', JSON.stringify(r))
  assert(member(EV, STAGE)?.role === 'director' && member(EV_OWN2, STAGE)?.role === 'av' && user(STAGE)?.role === 'director', JSON.stringify(tables))
  const log = logs('MEMBER_ROLE_CHANGED')
  assert(log.length === 1 && log[0].payload.from_role === 'stage' && log[0].payload.role === 'director', JSON.stringify(log))
})

Deno.test('manage: set_role refuses admin, pending, checkin_staff and unknown roles', async () => {
  for (const role of ['admin', 'pending', 'checkin_staff', 'superuser', '']) {
    setup()
    const r = await call('manage-operator', OWNER, { action: 'set_role', user_id: STAGE, role, event_id: EV })
    assert(r.status === 400 && member(EV, STAGE)?.role === 'stage', role + ' ' + JSON.stringify(r))
  }
})

Deno.test("manage: the creator is never a target, nor yourself, nor someone not on the team", async () => {
  setup()
  let r = await call('manage-operator', DIR, { action: 'suspend', user_id: OWNER, event_id: EV })
  assert(r.status === 404 && r.body.code === 'not_member', 'creator ' + JSON.stringify(r))
  r = await call('manage-operator', DIR, { action: 'suspend', user_id: DIR, event_id: EV })
  assert(r.status === 400, 'self ' + JSON.stringify(r))
  r = await call('manage-operator', OWNER, { action: 'remove', user_id: THEIR_OP, event_id: EV })
  assert(r.status === 404 && member(EV_THEIRS, THEIR_OP), 'not a member ' + JSON.stringify(r))
  assert(writes.length === 0, 'something was written')
})

Deno.test('manage: a failed write is a 500 and logs nothing', async () => {
  setup()
  failOn['PATCH /rest/v1/leod_event_members'] = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call('manage-operator', OWNER, { action: 'suspend', user_id: STAGE, event_id: EV })
  assert(r.status === 500 && tables.leod_event_log.length === 0, JSON.stringify(r))
})
```

- [ ] **Step 2: Run them and see them fail.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/operators.test.ts`
Expected: FAIL, many tests. For example `invite: a new email gets an account…` fails with `{"status":409…"User already exists"}` or with a 200 that has no `result`, and `manage: remove takes the person off this event only…` fails because the account is banned (`authAdmin` has a `PUT`).

- [ ] **Step 3: Add `logMemberChange`** to the end of `supabase/functions/_shared/members.ts`:

```ts
// One row in that event's own log per team change (spec §4), naming who did
// it. validate_event_log_role restamps operator_role with the caller's role
// on the event. A failed log write is reported, never silent, and does not
// undo the change it describes. No email address goes in the payload: every
// member of the event reads its log.
// deno-lint-ignore no-explicit-any
export async function logMemberChange(sb: any, eventId: string, operatorId: string, action: string, payload: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from('leod_event_log').insert({
    event_id: eventId, session_id: null, action, operator_id: operatorId, operator_role: 'director',
    payload, server_time_ms: Date.now(),
  })
  if (error) console.error(`${action} log failed:`, error.message)
}
```

- [ ] **Step 4: The "added to" email for console members.** In `supabase/functions/_shared/invite-email.ts`, inside `renderInviteEmail`, replace the lines from `const subject = event` to the end of `const lead = …` (lines 58-64) with:

```ts
  // A console member who already has a login is told they were added (spec
  // §4, §9.2); check-in keeps its own wording.
  const added = !!m.existingAccount && m.product === 'console'
  const subject = event
    ? (m.product === 'checkin' ? `You're invited to ${event} check-in`
       : added ? `You've been added to ${event} on CueDeck` : `You're invited to ${event} on CueDeck`)
    : (added ? `You've been added to a team on CueDeck` : `You're invited to join a team on CueDeck`)
  const who = inviter ? `${inviter} has ${added ? 'added' : 'invited'} you` : `You have been ${added ? 'added' : 'invited'}`
  const lead = eventBody
    ? (added ? `${who} to ${eventBody} with ${m.roleText}.` : `${who} to work on ${eventBody} with ${m.roleText}.`)
    : (added ? `${who} to a CueDeck team with ${m.roleText}.` : `${who} to join their CueDeck team with ${m.roleText}.`)
```

and in the HTML template replace `Invitation · ${esc(area)}` with `${added ? 'Team update' : 'Invitation'} · ${esc(area)}`. The `product: 'checkin'` output is byte-for-byte unchanged (`added` is false for it).

- [ ] **Step 5: Replace** `supabase/functions/invite-operator/index.ts` with:

```ts
// invite-operator: a director adds a person to ONE event with ONE role
// (event teams, spec docs/superpowers/specs/2026-10-08-event-teams-design.md §4).
//  * A new email gets an account (auth.admin.generateLink, Supabase sends
//    nothing), a membership on this event, and the branded invitation that
//    names the event, the inviter and the role.
//  * An existing account (any organiser, any role) gets the membership and a
//    short "added to" email with a link to the console: no signup, no
//    password step. If it never signed in, a fresh link instead.
//  * Already on this event with the same role: nothing changes or is sent.
//    With another role: the role is changed, nothing is sent.
// Who: the event's creator and its active director members (eventRole).
// Seats: the event owner's plan (cuedeck_event_seats_of), checked before
// anything is created; the membership insert checks again in the database
// (trigger, migration 133), so two invites cannot both take the last seat.
// Rate limit: 20 invitations per event owner per 24 hours.
// The account's own leod_users role and team link are never written here.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendInviteEmail } from '../_shared/invite-email.ts'
import { eventRole } from '../_shared/transition.ts'
import { MEMBER_ROLES, UUID, logMemberChange } from '../_shared/members.ts'

const ROLE_TEXT: Record<string, string> = {
  director: 'the Director role', stage: 'the Stage role', av: 'the AV role',
  interp: 'the Interpretation role', reg: 'the Registration role', signage: 'the Signage role',
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const startedAt = Date.now()
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }

  // Ping support (deploy verification)
  if (body._ping) return json(200, { pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json(401, { error: 'Unauthorized' })
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json(401, { error: 'Unauthorized' })

  // ── Input ──────────────────────────────────────────────────────
  const email = String(body.email || '').trim().toLowerCase()
  const role  = String(body.role || '')
  const name  = String(body.name || '').trim().slice(0, 120) || null
  const eventId = typeof body.event_id === 'string' && UUID.test(body.event_id) ? body.event_id : null
  if (!email || !MEMBER_ROLES.has(role) || !eventId) {
    return json(400, { error: 'An email, a role and the event are required' })
  }

  // ── The event, and the caller's role on it ──────────────────────
  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('id, name, date, created_by, created_via').eq('id', eventId).maybeSingle()
  if (evErr) return json(500, { error: evErr.message })
  let callerRole: string | null = null
  if (ev) {
    try { callerRole = await eventRole(sb, user.id, eventId) } catch (e) { return json(500, { error: (e as Error).message }) }
  }
  // An unknown event and someone else's event answer alike.
  if (!ev || callerRole !== 'director') return json(403, { error: 'Forbidden: only the directors of this event can invite' })
  if (ev.created_via !== 'console') {
    return json(400, { error: 'Check-in events invite their staff from Check-in', code: 'not_console_event' })
  }
  const owner: string = ev.created_by
  const isOwner = owner === user.id

  // ── The person: an existing account, or none yet ───────────────
  const { data: existing, error: exErr } = await sb.from('leod_users').select('id').eq('email', email).maybeSingle()
  if (exErr) return json(500, { error: exErr.message })
  if (existing?.id === owner) {
    return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
  }
  let current: { role: string; active: boolean } | null = null
  if (existing) {
    const { data: m, error: mErr } = await sb.from('leod_event_members').select('role, active')
      .eq('event_id', eventId).eq('user_id', existing.id).maybeSingle()
    if (mErr) return json(500, { error: mErr.message })
    current = m
  }

  // ── On this event with another role: change it, send nothing ───
  if (existing && current && current.role !== role) {
    const { data: upd, error: upErr } = await sb.from('leod_event_members').update({ role })
      .eq('event_id', eventId).eq('user_id', existing.id).select('user_id')
    if (upErr) return json(500, { error: upErr.message })
    if (!upd?.length) return json(500, { error: 'No membership row updated' })
    await logMemberChange(sb, eventId, user.id, 'MEMBER_ROLE_CHANGED',
      { target_user_id: existing.id, from_role: current.role, role, event_owner: owner })
    return json(200, { ok: true, user_id: existing.id, role, result: 'role_changed' })
  }

  // ── An existing account: has it ever signed in? ─────────────────
  let signedIn = false
  let confirmed = false
  if (existing) {
    const { data: au, error: auErr } = await sb.auth.admin.getUserById(existing.id)
    if (auErr || !au?.user) {
      console.error('invite-operator: auth user lookup failed', auErr?.status ?? 'missing')
      return json(502, { error: 'Could not send the invitation' })
    }
    signedIn = !!au.user.last_sign_in_at
    confirmed = !!au.user.email_confirmed_at
    // Same role on this event, and the login works: nothing to do.
    if (current && signedIn) return json(200, { ok: true, user_id: existing.id, role, result: 'unchanged' })
  }

  // ── Rate limit: 20 invitations per event owner per 24 hours ─────
  // Counted from the event logs before anything is created or sent; a
  // failed count refuses rather than sends.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString()
  const { count: sent, error: countErr } = await sb.from('leod_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'MEMBER_INVITED').eq('payload->>event_owner', owner).gte('ts', since)
  if (countErr) {
    console.error('invite-operator: invite count failed', countErr.code)
    return json(503, { error: 'Could not send the invitation right now. Try again shortly.' })
  }
  if ((sent ?? 0) >= 20) {
    return json(429, { error: 'This organiser has sent 20 invitations in the last 24 hours. Try again later.', code: 'invite_rate' })
  }

  // ── Seats, before anything is created (a new membership only) ───
  if (!current) {
    const { data: seats, error: seatErr } = await sb.rpc('cuedeck_event_seats_of', { p_event_id: eventId })
    if (seatErr || !seats) return json(500, { error: seatErr?.message ?? 'Could not read the seats of this event' })
    const s = seats as { used: number; limit: number | null }
    if (s.limit !== null && s.used >= s.limit) {
      return json(409, { error: 'All seats on this event are taken', code: 'seats_full', used: s.used, limit: s.limit, is_owner: isOwner })
    }
  }

  // ── The account and its link ───────────────────────────────────
  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const notice = !!existing && signedIn   // a working login: a short notice, nothing to accept
  let userId: string
  let createdNow = false
  let actionLink = appUrl
  if (existing) {
    userId = existing.id
    if (!signedIn) {
      // Never signed in: a fresh link, an invite if never confirmed, else a password link.
      const { data: l, error: lErr } = await sb.auth.admin.generateLink({
        type: confirmed ? 'recovery' : 'invite', email, options: { redirectTo: appUrl },
      })
      const al = l?.properties?.action_link
      if (lErr || !al) {
        console.error('invite-operator: link failed', lErr?.status ?? 'no link')
        return json(502, { error: 'Could not send the invitation' })
      }
      actionLink = al
    }
  } else {
    const { data: l, error: lErr } = await sb.auth.admin.generateLink({
      type: 'invite', email, options: { data: { name: name || '', invited_role: role }, redirectTo: appUrl },
    })
    const al = l?.properties?.action_link
    if (lErr || !l?.user || !al) return json(500, { error: lErr?.message ?? 'Could not create the invitation' })
    userId = l.user.id
    const created = Date.parse(String(l.user.created_at ?? ''))
    createdNow = Number.isFinite(created) && created >= startedAt - 5_000
    actionLink = al
    if (userId === owner) {
      return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
    }
    // The signup trigger made the leod_users row; only the typed name is added.
    if (name && createdNow) {
      const { error: nameErr } = await sb.from('leod_users').update({ name }).eq('id', userId)
      if (nameErr) console.error('invite-operator: name not saved', nameErr.message)
    }
  }
  // Undo only an account this request made: never one that existed before.
  const removeNewAccount = async (): Promise<string | null> => {
    if (!createdNow) return null
    const { error } = await sb.auth.admin.deleteUser(userId)
    return error ? error.message : null
  }

  // ── The membership (the database checks the seats again) ────────
  if (!current) {
    const { error: insErr } = await sb.from('leod_event_members')
      .insert({ event_id: eventId, user_id: userId, role, active: true, invited_by: user.id })
    if (insErr) {
      const undoErr = await removeNewAccount()
      const msg = String(insErr.message ?? '')
      if (insErr.code === '23514' && msg.startsWith('seats_full')) {
        return json(409, { error: 'All seats on this event are taken', code: 'seats_full', is_owner: isOwner })
      }
      if (insErr.code === '23514' && msg.startsWith('owner_not_member')) {
        return json(409, { error: 'This person organises the event and is already its director', code: 'is_owner' })
      }
      // Another director added the same person a moment ago: theirs stays.
      if (insErr.code === '23505') {
        return json(409, { error: 'This person was just added to this event', code: 'already_on_event' })
      }
      return json(500, { error: `The membership was not saved (${msg})`
        + (createdNow ? (undoErr ? `; the new account could not be removed (${undoErr})` : '; the invite was withdrawn') : '') })
    }
  }

  // ── The email ──────────────────────────────────────────────────
  const { data: caller, error: callerErr } = await sb.from('leod_users').select('name, email').eq('id', user.id).maybeSingle()
  if (callerErr) console.error('invite-operator: inviter name not read', callerErr.message)
  const mail = {
    to: email, product: 'console' as const, eventName: ev.name, eventDate: ev.date ?? null,
    inviterName: caller?.name || caller?.email || null, roleText: ROLE_TEXT[role],
  }
  if (notice) {
    const { error: mailErr } = await sendInviteEmail({ ...mail, actionUrl: appUrl, actionLabel: 'Open CueDeck', existingAccount: true })
    // The membership is in place; a lost notice is logged, not failed (as check-in does).
    if (mailErr) console.error('invite-operator: added-to notice failed for event', eventId, mailErr)
  } else {
    const { error: mailErr } = await sendInviteEmail({ ...mail, actionUrl: actionLink, actionLabel: 'Accept the invitation' })
    if (mailErr) {
      // No email means no way in: take back what this request created.
      if (!current) {
        const { error: delErr } = await sb.from('leod_event_members').delete().eq('event_id', eventId).eq('user_id', userId)
        if (delErr) return json(500, { error: `The invitation email failed (${mailErr}) and the membership could not be removed (${delErr.message})` })
      }
      const undoErr = await removeNewAccount()
      if (undoErr) return json(500, { error: `The invitation email failed (${mailErr}) and the new account could not be removed (${undoErr})` })
      return json(502, { error: 'The invitation email could not be sent. Nothing was created; try again.' })
    }
  }

  await logMemberChange(sb, eventId, user.id, 'MEMBER_INVITED',
    { target_user_id: userId, role, event_owner: owner, existing_account: !!existing })
  return json(200, { ok: true, user_id: userId, role, result: existing ? (current ? 'link_resent' : 'added') : 'invited' })
})
```

- [ ] **Step 6: Replace** `supabase/functions/manage-operator/index.ts` with:

```ts
// manage-operator: a director changes one person's membership of an event
// (event teams, spec docs/superpowers/specs/2026-10-08-event-teams-design.md §4):
// set_role, suspend, reactivate, remove.
//  * With event_id: that event only; the caller must be its creator or an
//    active director member.
//  * Without event_id: every event the caller created that the person is on
//    ("remove from all my events"). Consoles from before event teams send no
//    event_id, so their suspend and role changes land here too.
// Remove deletes the membership only. The login, the leod_users row and the
// person's other events (including their own) are never touched: no ban.
// Never on yourself; never on an event's creator (they are not a member).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { eventRole } from '../_shared/transition.ts'
import { MEMBER_ROLES, UUID, logMemberChange } from '../_shared/members.ts'

const VALID_ACTIONS = new Set(['suspend', 'reactivate', 'remove', 'set_role'])
const LOG_ACTION: Record<string, string> = {
  suspend: 'MEMBER_SUSPENDED', reactivate: 'MEMBER_REACTIVATED', remove: 'MEMBER_REMOVED', set_role: 'MEMBER_ROLE_CHANGED',
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }

  // Ping support (deploy verification)
  if (body._ping) return json(200, { pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json(401, { error: 'Unauthorized' })
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json(401, { error: 'Unauthorized' })

  // ── Input ──────────────────────────────────────────────────────
  const action   = String(body.action || '').trim()
  const targetId = String(body.user_id || '').trim()
  const newRole  = String(body.role || '').trim()
  if (!VALID_ACTIONS.has(action)) return json(400, { error: 'Invalid action: must be suspend, reactivate, remove or set_role' })
  if (action === 'set_role' && !MEMBER_ROLES.has(newRole)) return json(400, { error: 'Invalid role' })
  if (!UUID.test(targetId)) return json(400, { error: 'Missing user_id' })
  if (targetId === user.id) return json(400, { error: 'Cannot perform this action on your own account' })
  const hasEvent = body.event_id !== undefined && body.event_id !== null
  if (hasEvent && !(typeof body.event_id === 'string' && UUID.test(body.event_id))) {
    return json(400, { error: 'Invalid event_id' })
  }

  // ── The events this request may touch ──────────────────────────
  let events: string[]
  if (hasEvent) {
    const eventId = body.event_id as string
    let role: string | null
    try { role = await eventRole(sb, user.id, eventId) } catch (e) { return json(500, { error: (e as Error).message }) }
    if (role !== 'director') return json(403, { error: 'Forbidden: only the directors of this event can change its team' })
    events = [eventId]
  } else {
    const { data: own, error: ownErr } = await sb.from('leod_events').select('id').eq('created_by', user.id)
    if (ownErr) return json(500, { error: ownErr.message })
    events = (own ?? []).map((e: { id: string }) => e.id)
  }

  // ── The person's memberships on them ───────────────────────────
  const targets: { event_id: string; role: string }[] = []
  for (const eventId of events) {
    const { data: m, error: mErr } = await sb.from('leod_event_members').select('event_id, role')
      .eq('event_id', eventId).eq('user_id', targetId).maybeSingle()
    if (mErr) return json(500, { error: mErr.message })
    if (m) targets.push(m)
  }
  if (!targets.length) return json(404, { error: 'This person is not on the team of this event', code: 'not_member' })

  // ── Change each membership; log each in its own event's log ────
  const done: string[] = []
  for (const m of targets) {
    const { data, error } = action === 'remove'
      ? await sb.from('leod_event_members').delete()
          .eq('event_id', m.event_id).eq('user_id', targetId).select('user_id')
      : await sb.from('leod_event_members').update(action === 'set_role' ? { role: newRole } : { active: action === 'reactivate' })
          .eq('event_id', m.event_id).eq('user_id', targetId).select('user_id')
    if (error || !data?.length) {
      const why = error?.message ?? 'no membership row changed'
      return json(500, { error: done.length ? `Changed on ${done.length} events, then failed: ${why}` : why, events: done })
    }
    done.push(m.event_id)
    await logMemberChange(sb, m.event_id, user.id, LOG_ACTION[action],
      action === 'set_role' ? { target_user_id: targetId, from_role: m.role, role: newRole } : { target_user_id: targetId })
  }
  return json(200, action === 'set_role' ? { ok: true, action, role: newRole, events: done } : { ok: true, action, events: done })
})
```

- [ ] **Step 7: Run the tests and see them pass.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/operators.test.ts`
Expected: PASS, `ok | 0 failed`, every test named above listed.

Run: `deno check supabase/functions/invite-operator/index.ts supabase/functions/manage-operator/index.ts`
Expected: no type errors.

Run: `npx vitest run tests/operators.spec.ts tests/session-auth.spec.ts`
Expected: PASS.

Run: `npx vitest run tests/checkin-function-gates.spec.ts`
Expected: PASS (it runs the check-in handler suite, which uses `_shared/invite-email.ts` with `product: 'checkin'`; its wording is unchanged).

- [ ] **Step 8: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/functions/_shared/members.ts supabase/functions/_shared/invite-email.ts supabase/functions/invite-operator/index.ts supabase/functions/manage-operator/index.ts tests/deno/operators.test.ts
git commit -m "feat(functions): invite and manage the team of one event; existing accounts, seats, no ban" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/functions/_shared/members.ts supabase/functions/_shared/invite-email.ts supabase/functions/invite-operator/index.ts supabase/functions/manage-operator/index.ts tests/deno/operators.test.ts
```

### Task 2.4: Plan resolver: ai-proxy and redeem-code

Spec §6: invited people work on the event owner's plan (AI included) and have no plan of their own; all limits for an event come from the event owner's plan; creating or paying uses your own plan. Inventory §2 and §4: `ai-proxy` and `redeem-code` resolve the plan owner from `leod_users.invited_by` today (an invited director resolves to their own, absent, subscription).

**Files:**
- Create: `supabase/functions/_shared/plan.ts`
- Replace: `supabase/functions/ai-proxy/index.ts`
- Modify: `supabase/functions/redeem-code/index.ts:83-102` (the "Resolve director ID" block)
- Create: `tests/deno/plan-owner.test.ts`, `tests/plan-owner.spec.ts`
- Modify: `tests/ai-proxy-plan.spec.ts` (import the real `aiAllowed`; the owner mirror moves to the handler test)

**Interfaces:**
- Consumes: `eventRole(sb, userId, eventId)` (Task 2.2), `UUID` (Task 2.2).
- Produces:
  - `supabase/functions/_shared/plan.ts`: `export const PAID_AI_PLANS: Set<string>`, `export type PlanRow = { plan: string; status: string; trial_ends_at: string | null } | null`, `export function aiAllowed(sub: PlanRow, now?: number): boolean`. No imports, so vitest can import it directly.
  - `POST /functions/v1/ai-proxy` body `{ model, max_tokens, messages, event_id?: string }`. With `event_id`: 403 `{ error: 'Forbidden' }` unless the caller is on that event; the plan checked is the event creator's. Without: the caller's own plan. Invalid `event_id`: 400. Otherwise unchanged (403 plan message, 400 payload, Anthropic forwarding).
  - `POST /functions/v1/redeem-code`: always applies to the caller's own subscription (`director_id = user.id`).

- [ ] **Step 1: Write the failing handler tests.** Create `tests/deno/plan-owner.test.ts`:

```ts
// tests/deno/plan-owner.test.ts
// Whose plan an AI call and a promo code use (event teams, spec 2026-10-08 §6),
// against a stubbed Supabase and a stubbed Anthropic API: AI on an event uses
// that event creator's plan; members have no plan of their own; codes apply
// to the caller's own subscription only.
//
// Run: deno test --allow-env --allow-read --no-lock tests/deno/plan-owner.test.ts
// (tests/plan-owner.spec.ts runs it from `npm test` when deno is installed.)

const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href

Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('ANTHROPIC_API_KEY', 'stub-anthropic-key')   // api.anthropic.com is stubbed below

const OWNER   = '50000000-0000-4000-8000-000000000001' // Pro, creates EV
const MEMBER  = '50000000-0000-4000-8000-000000000002' // stage on EV, no plan of their own
const ORG2    = '50000000-0000-4000-8000-000000000003' // Starter, creates EV2, av on EV
const SUSP    = '50000000-0000-4000-8000-000000000004' // stage on EV, suspended
const STRANGER = '50000000-0000-4000-8000-000000000005' // Pro of their own, on no event here
const T_OWNER = '50000000-0000-4000-8000-000000000006' // trial ended, creates EV3
const T_MEMBER = '50000000-0000-4000-8000-000000000007' // director on EV3
const EV  = '60000000-0000-4000-8000-000000000001'
const EV2 = '60000000-0000-4000-8000-000000000002'
const EV3 = '60000000-0000-4000-8000-000000000003'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let anthropicCalls: number

function rowFilter(url: URL): (r: Row) => boolean {
  const tests: ((r: Row) => boolean)[] = []
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) tests.push(r => String(r[k]) === v.slice(3))
  }
  return (r: Row) => tests.every(fn => fn(r))
}
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers)
  const rawBody = init?.body ?? (req ? await req.clone().text() : undefined)
  if (url.host === 'api.anthropic.com') {
    anthropicCalls++
    return reply(200, { content: [{ type: 'text', text: 'stub answer' }] })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected network call ' + url.host })
  if (url.pathname === '/auth/v1/user') {
    const id = (headers.get('Authorization') ?? '').replace('Bearer ', '')
    return reply(200, { id, email: id + '@stub.test', aud: 'authenticated' })
  }
  const tbl = url.pathname.match(/^\/rest\/v1\/(.+)$/)
  if (!tbl) return reply(404, { message: 'no route' })
  const table = tbl[1]
  const rows = (tables[table] ??= [])
  const match = rowFilter(url)
  if (method === 'GET') {
    let hit = rows.filter(match)
    const limit = url.searchParams.get('limit')
    if (limit) hit = hit.slice(0, Number(limit))
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (hit.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      return reply(200, hit[0])
    }
    return reply(200, hit)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(String(rawBody ?? '{}'))
    const hit = rows.filter(match)
    hit.forEach(r => Object.assign(r, patch))
    return (headers.get('Prefer') ?? '').includes('return=representation') ? reply(200, hit) : reply(204, undefined)
  }
  return reply(405, { message: 'stub: method' })
}) as typeof fetch

const handlers: Record<string, (req: Request) => Promise<Response>> = {}
let captured: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', {
  configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { captured = h; return { finished: Promise.resolve(), shutdown: async () => {} } },
})
for (const fn of ['ai-proxy', 'redeem-code']) {
  captured = null
  await import(`${FN_DIR}${fn}/index.ts`)
  if (!captured) throw new Error('no handler captured for ' + fn)
  handlers[fn] = captured
}

async function call(fn: string, as: string, body: Row): Promise<{ status: number; body: Row }> {
  const res = await handlers[fn](new Request('http://stub.local/functions/v1/' + fn, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + as, 'Content-Type': 'application/json', Origin: 'https://app.cuedeck.io' },
    body: JSON.stringify(body),
  }))
  const text = await res.text()
  let parsed: Row = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text } }
  return { status: res.status, body: parsed }
}

const AI = { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
const past = new Date(Date.now() - 3600e3).toISOString()

function setup() {
  anthropicCalls = 0
  tables = {
    // MEMBER still carries the old team link (role stage, invited_by OWNER):
    // it must no longer decide anything.
    leod_users: [OWNER, MEMBER, ORG2, SUSP, STRANGER, T_OWNER, T_MEMBER].map(id =>
      id === MEMBER ? { id, role: 'stage', invited_by: OWNER, active: true } : { id, role: 'director', active: true }),
    leod_events: [
      { id: EV,  created_by: OWNER },
      { id: EV2, created_by: ORG2 },
      { id: EV3, created_by: T_OWNER },
    ],
    leod_event_members: [
      { event_id: EV,  user_id: MEMBER,   role: 'stage',    active: true },
      { event_id: EV,  user_id: ORG2,     role: 'av',       active: true },
      { event_id: EV,  user_id: SUSP,     role: 'stage',    active: false },
      { event_id: EV3, user_id: T_MEMBER, role: 'director', active: true },
    ],
    leod_subscriptions: [
      { director_id: OWNER,    plan: 'pro',     status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: ORG2,     plan: 'starter', status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: STRANGER, plan: 'pro',     status: 'active', trial_ends_at: null, created_at: '2026-09-01T00:00:00Z' },
      { director_id: T_OWNER,  plan: 'trial',   status: 'active', trial_ends_at: past, created_at: '2026-10-01T00:00:00Z' },
    ],
    leod_promo_codes: [
      { code: 'EXTEND7', type: 'trial_extension', active: true, expires_at: null, max_uses: null, uses: 0, extra_days: 7 },
      { code: 'PROUNLOCK', type: 'plan_unlock', active: true, expires_at: null, max_uses: null, uses: 0, granted_plan: 'pro', granted_months: 1 },
    ],
  }
}
const sub = (id: string) => tables.leod_subscriptions.find(s => s.director_id === id)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// [label, caller, event_id or null, expected status]
const AI_CASES: [string, string, string | null, number][] = [
  ['a member uses the event owner\'s Pro plan',                 MEMBER,   EV,   200],
  ['a member has no plan of their own without an event',       MEMBER,   null, 403],
  ['another organiser\'s plan never opens this event',          STRANGER, EV,   403],
  ['another organiser still uses their own plan for their own', STRANGER, null, 200],
  ['a suspended member is refused',                             SUSP,     EV,   403],
  ['an organiser on Starter uses the Pro owner\'s plan there',  ORG2,     EV,   200],
  ['and their own Starter plan on their own event',             ORG2,     EV2,  403],
  ['a member of an event whose owner\'s trial ended',           T_MEMBER, EV3,  403],
  ['the owner whose trial ended',                               T_OWNER,  EV3,  403],
]
for (const [label, who, ev, expected] of AI_CASES) {
  Deno.test(`ai-proxy: ${label} (${expected})`, async () => {
    setup()
    const r = await call('ai-proxy', who, ev ? { ...AI, event_id: ev } : AI)
    assert(r.status === expected, `status ${r.status} ${JSON.stringify(r.body)}`)
    assert(anthropicCalls === (expected === 200 ? 1 : 0), 'anthropic calls ' + anthropicCalls)
  })
}

Deno.test('ai-proxy: an event_id that is not an id is a 400 and calls nothing', async () => {
  setup()
  const r = await call('ai-proxy', MEMBER, { ...AI, event_id: 'not-an-id' })
  assert(r.status === 400 && anthropicCalls === 0, JSON.stringify(r))
})

Deno.test("redeem-code: a member without a plan of their own cannot touch the organiser's", async () => {
  setup()
  const before = JSON.stringify(sub(OWNER))
  const r = await call('redeem-code', MEMBER, { code: 'PROUNLOCK' })
  assert(r.status === 400 && String(r.body.error).includes('No subscription'), JSON.stringify(r))
  assert(JSON.stringify(sub(OWNER)) === before, "the organiser's plan changed")
})

Deno.test('redeem-code: an organiser who is also a member redeems on their own plan only', async () => {
  setup()
  const before = JSON.stringify(sub(OWNER))
  const r = await call('redeem-code', ORG2, { code: 'PROUNLOCK' })
  assert(r.status === 200 && r.body.type === 'plan_unlock', JSON.stringify(r))
  assert(sub(ORG2)?.plan === 'pro' && JSON.stringify(sub(OWNER)) === before, JSON.stringify(tables.leod_subscriptions))
})
```

Create `tests/plan-owner.spec.ts`:

```ts
// tests/plan-owner.spec.ts
// Runs the plan owner suite (tests/deno/plan-owner.test.ts) under deno.
// Same rule as checkin-function-gates.spec.ts: a local machine without deno
// skips visibly, CI installs deno and must never skip.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno && !process.env.CI)('whose plan AI and codes use (deno)', () => {
  it('tests/deno/plan-owner.test.ts passes', () => {
    expect(hasDeno, 'deno is not installed; CI must install it (denoland/setup-deno)').toBe(true);
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/plan-owner.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
```

Replace `tests/ai-proxy-plan.spec.ts` with (the plan rule is now imported from the function, not mirrored; who owns the plan is tested on the real handler in `tests/deno/plan-owner.test.ts`):

```ts
// tests/ai-proxy-plan.spec.ts
// The AI plan rule used by supabase/functions/ai-proxy/index.ts, imported
// from the function itself (no mirror to keep in sync). Whose plan is
// checked (the event creator's, spec 2026-10-08 §6) is tested on the real
// handler in tests/deno/plan-owner.test.ts.
import { describe, it, expect } from 'vitest';
import { aiAllowed } from '../supabase/functions/_shared/plan.ts';

describe('aiAllowed', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('denies expired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
  });
  it('allows unexpired trial', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: '2026-10-10T00:00:00Z' }, now)).toBe(true);
  });
  it('denies a trial with no end date', () => {
    expect(aiAllowed({ plan: 'trial', status: 'active', trial_ends_at: null }, now)).toBe(false);
  });
  it('allows active pro and enterprise', () => {
    expect(aiAllowed({ plan: 'pro', status: 'active', trial_ends_at: null }, now)).toBe(true);
    expect(aiAllowed({ plan: 'enterprise', status: 'active', trial_ends_at: null }, now)).toBe(true);
  });
  it('denies past_due pro, starter and perevent', () => {
    expect(aiAllowed({ plan: 'pro', status: 'past_due', trial_ends_at: null }, now)).toBe(false);
    expect(aiAllowed({ plan: 'starter', status: 'active', trial_ends_at: null }, now)).toBe(false);
    expect(aiAllowed({ plan: 'perevent', status: 'active', trial_ends_at: null }, now)).toBe(false);
  });
  it('denies no row', () => {
    expect(aiAllowed(null, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `npx vitest run tests/ai-proxy-plan.spec.ts`
Expected: FAIL: `Failed to load url ../supabase/functions/_shared/plan.ts`.

Run: `deno test --allow-env --allow-read --no-lock tests/deno/plan-owner.test.ts`
Expected: FAIL, among others `ai-proxy: a member has no plan of their own without an event (403)` (status 200: the old code follows MEMBER's `invited_by` to the owner's Pro plan), `ai-proxy: another organiser's plan never opens this event (403)` (status 200: the old code ignores `event_id`), `ai-proxy: an organiser on Starter uses the Pro owner's plan there (200)` (status 403) and `redeem-code: a member without a plan of their own cannot touch the organiser's` (the old code unlocks the owner's plan).

- [ ] **Step 3: Create** `supabase/functions/_shared/plan.ts`:

```ts
// plan.ts: the plan rule for AI (ai-proxy). No imports, so vitest imports it too.
// Which plan is checked is decided by the caller of aiAllowed: for an event,
// the event creator's plan (event teams, spec 2026-10-08 §6).

export const PAID_AI_PLANS = new Set(['pro', 'enterprise'])

export type PlanRow = { plan: string; status: string; trial_ends_at: string | null } | null

// An active Pro or Enterprise plan, or a trial that has not ended. No row: no AI.
export function aiAllowed(sub: PlanRow, now = Date.now()): boolean {
  const plan = sub?.plan
  const paidOk = !!plan && PAID_AI_PLANS.has(plan) && sub?.status === 'active'
  const ends = sub?.trial_ends_at ? Date.parse(sub.trial_ends_at) : NaN
  const trialOk = plan === 'trial' && !Number.isNaN(ends) && ends > now
  return paidOk || trialOk
}
```

- [ ] **Step 4: Replace** `supabase/functions/ai-proxy/index.ts` with:

```ts
// ai-proxy: server-side proxy for Anthropic API calls.
// Authenticates the caller's JWT, checks the plan that governs the call,
// then forwards the request to Anthropic using the server-side API key.
// The Anthropic key never touches the browser.
// Whose plan (event teams, spec 2026-10-08 §6): with event_id, the caller
// must be on that event and the plan is the event creator's (members have no
// plan of their own); without event_id, the caller's own plan.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { eventRole } from '../_shared/transition.ts'
import { UUID } from '../_shared/members.ts'
import { aiAllowed, type PlanRow } from '../_shared/plan.ts'

const NO_AI = 'AI features are not available on your current plan. Upgrade to Pro to unlock AI.'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }

  // Ping support (deploy verification)
  if (body._ping) return json(200, { pong: true })

  // ── Auth: verify caller JWT ──────────────────────────────────────
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json(401, { error: 'Unauthorized' })
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json(401, { error: 'Unauthorized' })

  const evId = body.event_id
  if (evId !== undefined && evId !== null && !(typeof evId === 'string' && UUID.test(evId))) {
    return json(400, { error: 'Invalid event_id' })
  }

  // A suspended account (admin action) gets no AI anywhere.
  const { data: me, error: meErr } = await sb.from('leod_users').select('active').eq('id', user.id).maybeSingle()
  if (meErr) {
    console.error('ai-proxy: user lookup failed', meErr.message)
    return json(500, { error: 'Could not verify your plan' })
  }
  if (!me || me.active === false) return json(403, { error: NO_AI })

  // ── Whose plan ───────────────────────────────────────────────────
  let ownerId = user.id
  if (typeof evId === 'string') {
    let role: string | null
    try { role = await eventRole(sb, user.id, evId) } catch (e) {
      console.error('ai-proxy: role lookup failed', (e as Error).message)
      return json(500, { error: 'Could not verify your plan' })
    }
    if (!role) return json(403, { error: 'Forbidden' })
    const { data: ev, error: evErr } = await sb.from('leod_events').select('created_by').eq('id', evId).maybeSingle()
    if (evErr || !ev?.created_by) {
      console.error('ai-proxy: event lookup failed', evErr?.message ?? 'no creator')
      return json(500, { error: 'Could not verify your plan' })
    }
    ownerId = ev.created_by
  }

  const { data: subRow, error: subErr } = await sb
    .from('leod_subscriptions')
    .select('plan, status, trial_ends_at')
    .eq('director_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (subErr) {
    console.error('ai-proxy: subscription lookup failed', subErr.message)
    return json(500, { error: 'Could not verify your plan' })
  }
  if (!aiAllowed(subRow as PlanRow)) return json(403, { error: NO_AI })

  // ── Validate payload ────────────────────────────────────────────
  const model      = body.model      as string | undefined
  const max_tokens = body.max_tokens as number | undefined
  const messages   = body.messages   as unknown[] | undefined
  if (!model || !max_tokens || !Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'Invalid payload: model, max_tokens, messages required' })
  }

  // ── Forward to Anthropic ────────────────────────────────────────
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json(503, { error: 'AI service temporarily unavailable' })

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens, messages }),
  })

  const result = await anthropicRes.json()
  return new Response(JSON.stringify(result), {
    status: anthropicRes.status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 5: redeem-code uses the caller's own subscription.** In `supabase/functions/redeem-code/index.ts` replace the block from `  // ── Resolve director ID ──` down to the end of the `const directorId = … : callerRow.invited_by` statement (lines 83-102) with:

```ts
  // ── Whose subscription: always the caller's own (event teams, spec §6).
  // The plan belongs to the account that pays for it; a member of someone
  // else's event never changes that organiser's plan.
  const directorId = user.id
```

- [ ] **Step 6: Run the tests and see them pass.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/plan-owner.test.ts`
Expected: PASS (`ok | 0 failed`), 12 tests.

Run: `npx vitest run tests/ai-proxy-plan.spec.ts tests/plan-owner.spec.ts`
Expected: PASS.

Run: `deno check supabase/functions/ai-proxy/index.ts supabase/functions/redeem-code/index.ts`
Expected: no type errors.

Run: `grep -rn "invited_by" supabase/functions --include=*.ts | grep -v "^\S*: *//"`
Expected: exactly one line, `supabase/functions/invite-operator/index.ts: … invited_by: user.id })` (the membership's own "added by" column).

- [ ] **Step 7: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/functions/_shared/plan.ts supabase/functions/ai-proxy/index.ts supabase/functions/redeem-code/index.ts tests/deno/plan-owner.test.ts tests/plan-owner.spec.ts tests/ai-proxy-plan.spec.ts
git commit -m "feat(functions): AI uses the event owner's plan; codes apply to your own plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/functions/_shared/plan.ts supabase/functions/ai-proxy/index.ts supabase/functions/redeem-code/index.ts tests/deno/plan-owner.test.ts tests/plan-owner.spec.ts tests/ai-proxy-plan.spec.ts
```

### Task 2.5: Schedule the guard, and watch the watcher (migration 134)

Sherif's condition on the plan (8 Oct): `cuedeck_guard_results()` runs every day on a schedule, every run is recorded, and a person is told when a guard fails and when the run itself goes missing or stale. An absent run is a failure, never an all-clear.

Where the pieces come from, found in the repo on 8 Oct:
- **The run table.** The house job log `leod_checkin_job_runs` (migration 075) is check-in-owned: its name, its migration and its watcher (`checkin_brain_signals`, read by the AVE Brain) belong to the check-in session, so this plan creates a console table, `cuedeck_job_runs`, with the same shape plus `failing` and `alerted_at`.
- **The alert route.** The existing route that reaches a person from this project is the alert email that `stripe-webhook` sends through `_shared/resend.ts` to the `BILLING_ALERT_EMAIL` secret (Sherif's alert inbox), recording each alert in a table. This task uses that route (the same helper, the same address) from a small Edge Function; it does not add a new channel. The Brain watcher is not used because it only reads check-in tables (`checkin_brain_signals`, off limits).
- **Two independent schedulers, each watching the other.** pg_cron (installed by 089) runs the guards at 05:10 UTC; the Vercel cron `/api/cron/health-check` (already scheduled daily at 06:00 UTC in `vercel.json`) calls the alert function, which records a heartbeat. If pg_cron stops, the 06:00 call finds no fresh guard run and alerts. If the Vercel cron stops, the next 05:10 run finds no fresh heartbeat and alerts through pg_net. Both stopping at once is the one case nothing reports (named in the note to Sherif).

**Files:**
- Create: `supabase/migrations/134_cuedeck_guard_schedule.sql`
- Create: `tests/sql/134-guard-schedule-probe.sql`
- Create: `supabase/functions/cuedeck-guard-alert/index.ts`
- Create: `tests/deno/guard-alert.test.ts`, `tests/guard-alert.spec.ts`
- Modify: `api/cron/health-check.ts` (call the alert function every day)
- Create: `tests/health-check-guards.spec.ts`
- Modify: `scripts/deploy-functions.sh` (add `cuedeck-guard-alert` to `ALL_FUNCTIONS` and to the `--no-verify-jwt` case: pg_cron calls it with `x-cron-secret` and no JWT, see `tests/cron-functions-reachable.spec.ts`)

**Interfaces:**
- Consumes: `cuedeck_guard_results() → (guard, ok, detail, checked_at)` (Task 1.3); `sendEmail({ to, subject, html, text? })` from `_shared/resend.ts` (returns `{ id?, error? }`); `adminClient()`; extensions `pg_cron`, `pg_net`, `vault` (089).
- Produces:
  - table `public.cuedeck_job_runs(id bigserial, job_name text, started_at timestamptz, finished_at timestamptz, status text ('ok'|'failed'), failing text[], detail text, alerted_at timestamptz)`; job names `cuedeck-guards` (the runner), `cuedeck-guard-watch` (the Vercel heartbeat), `cuedeck-guard-alert` (each alert email).
  - `public.cuedeck_run_guards() RETURNS bigint` (the run id): runs the guards, records the run, and when `cuedeck_guard_watch()` is not ok calls the alert function through `net.http_post`. service_role only; scheduled by pg_cron job `cuedeck-guards` at `10 5 * * *`.
  - `public.cuedeck_guard_watch() RETURNS jsonb` `{ ok: boolean, problems: text[], checked_at }`. Problems, by exclusion (anything not proven fresh and green is a problem): `guard run missing`, `guard run stale: last run <UTC time>` (older than 26 h), `guards failing: <names> (<detail>)`, `guard watch missing`, `guard watch stale: last heartbeat <UTC time>` (older than 26 h). service_role only.
  - `public.cuedeck_cron_ok(p_secret text) RETURNS boolean` against vault secret `cuedeck_guard_cron_secret`. service_role only.
  - Edge Function `POST /functions/v1/cuedeck-guard-alert` body `{ caller?: 'vercel' | 'pg_cron' }`, authorised by `Authorization: Bearer <service role key>` (Vercel) or `x-cron-secret` (pg_cron). Answers `200 { ok, problems, emailed }`, `401`, `500 { error }` (no alert address, or the run could not be recorded), `502` (the email failed). Emails each distinct problem set once per UTC day. Records `cuedeck-guard-watch` only for a service-role (Vercel) call.
  - `api/cron/health-check.ts` returns `guards: 'ok' | 'failing' | 'unreachable'` and `503` unless the database and the guard watch are both fine.

- [ ] **Step 1: Check the migration number** (Global Constraints). Expected next free: 134.

- [ ] **Step 2: Write the failing tests.**

`tests/sql/134-guard-schedule-probe.sql`:

```sql
-- tests/sql/134-guard-schedule-probe.sql
-- Run after 134 (needs 132). Expected: an error whose message starts with
-- 'PROBE OK 134'. Everything is rolled back by the final RAISE, including the
-- pg_net request the runner queues (pg_net sends only committed requests).
-- Before 134 it fails with: function cuedeck_run_guards() does not exist.
DO $probe$
DECLARE
  v_run    bigint;
  v_row    cuedeck_job_runs%ROWTYPE;
  v_watch  jsonb;
  v_queued int;
  v_n      int;
  v_checks int := 0;
BEGIN
  -- start from a clean slate inside this transaction
  DELETE FROM cuedeck_job_runs;
  INSERT INTO cuedeck_job_runs (job_name, status, started_at, finished_at) VALUES ('cuedeck-guard-watch', 'ok', now(), now());

  -- 1. a green run is recorded as ok, with no failing guards, and the watch is ok
  SELECT count(*) INTO v_queued FROM net.http_request_queue WHERE url LIKE '%/cuedeck-guard-alert';
  v_run := cuedeck_run_guards();
  SELECT * INTO v_row FROM cuedeck_job_runs WHERE id = v_run;
  IF v_row.job_name IS DISTINCT FROM 'cuedeck-guards' OR v_row.status IS DISTINCT FROM 'ok'
     OR cardinality(v_row.failing) <> 0 OR v_row.finished_at IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 1: green run recorded as %', to_jsonb(v_row);
  END IF;
  v_watch := cuedeck_guard_watch();
  IF (v_watch->>'ok')::boolean IS DISTINCT FROM true OR jsonb_array_length(v_watch->'problems') <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 1: watch after a green run %', v_watch;
  END IF;
  IF (SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%/cuedeck-guard-alert') <> v_queued THEN
    RAISE EXCEPTION 'PROBE FAIL 1: a green run called the alert function';
  END IF;
  v_checks := v_checks + 1;

  -- 2. a failing guard is recorded by name, reported by the watch, and the
  --    runner calls the alert function at once
  CREATE POLICY probe_134_old_rule ON leod_reports FOR SELECT TO authenticated
    USING (event_id IN (SELECT e.id FROM leod_events e
                         WHERE e.created_by IN (SELECT u.invited_by FROM leod_users u WHERE u.id = auth.uid())));
  v_run := cuedeck_run_guards();
  SELECT * INTO v_row FROM cuedeck_job_runs WHERE id = v_run;
  IF v_row.status IS DISTINCT FROM 'failed' OR NOT ('event_access_not_via_invited_by' = ANY (v_row.failing)) THEN
    RAISE EXCEPTION 'PROBE FAIL 2: failing run recorded as %', to_jsonb(v_row);
  END IF;
  v_watch := cuedeck_guard_watch();
  IF (v_watch->>'ok')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_watch->'problems') p
                     WHERE p LIKE 'guards failing: event_access_not_via_invited_by%') THEN
    RAISE EXCEPTION 'PROBE FAIL 2: watch did not report the failing guard: %', v_watch;
  END IF;
  IF (SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%/cuedeck-guard-alert') <> v_queued + 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 2: the runner did not call the alert function';
  END IF;
  DROP POLICY probe_134_old_rule ON leod_reports;
  v_checks := v_checks + 1;

  -- 3. no run at all is a failure, not an all-clear; a run older than 26 h is stale
  DELETE FROM cuedeck_job_runs WHERE job_name = 'cuedeck-guards';
  v_watch := cuedeck_guard_watch();
  IF (v_watch->>'ok')::boolean IS DISTINCT FROM false OR NOT (v_watch->'problems' ? 'guard run missing') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a missing run was not reported: %', v_watch;
  END IF;
  INSERT INTO cuedeck_job_runs (job_name, status, started_at, finished_at)
  VALUES ('cuedeck-guards', 'ok', now() - interval '27 hours', now() - interval '27 hours');
  v_watch := cuedeck_guard_watch();
  IF (v_watch->>'ok')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_watch->'problems') p WHERE p LIKE 'guard run stale:%') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a 27 h old run was not reported stale: %', v_watch;
  END IF;
  v_checks := v_checks + 1;

  -- 4. the watcher is watched: no heartbeat, or one older than 26 h, is reported
  v_run := cuedeck_run_guards();   -- a fresh green run, so only the heartbeat is wrong
  DELETE FROM cuedeck_job_runs WHERE job_name = 'cuedeck-guard-watch';
  v_watch := cuedeck_guard_watch();
  IF NOT (v_watch->'problems' ? 'guard watch missing') THEN RAISE EXCEPTION 'PROBE FAIL 4: missing heartbeat not reported: %', v_watch; END IF;
  INSERT INTO cuedeck_job_runs (job_name, status, started_at, finished_at)
  VALUES ('cuedeck-guard-watch', 'ok', now() - interval '27 hours', now() - interval '27 hours');
  v_watch := cuedeck_guard_watch();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_watch->'problems') p WHERE p LIKE 'guard watch stale:%') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: stale heartbeat not reported: %', v_watch;
  END IF;
  v_checks := v_checks + 1;

  -- 5. a guard function that errors is a failed run, not a missing one
  ALTER FUNCTION public.cuedeck_guard_results() RENAME TO cuedeck_guard_results_probe_hidden;
  v_run := cuedeck_run_guards();
  ALTER FUNCTION public.cuedeck_guard_results_probe_hidden() RENAME TO cuedeck_guard_results;
  SELECT * INTO v_row FROM cuedeck_job_runs WHERE id = v_run;
  IF v_row.status IS DISTINCT FROM 'failed' OR NOT ('guard_error' = ANY (v_row.failing)) THEN
    RAISE EXCEPTION 'PROBE FAIL 5: an erroring guard run recorded as %', to_jsonb(v_row);
  END IF;
  v_checks := v_checks + 1;

  -- 6. the schedule, the secret and who may run what
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname = 'cuedeck-guards' AND schedule = '10 5 * * *' AND active AND command LIKE '%cuedeck_run_guards()%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 6: pg_cron job cuedeck-guards missing or wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cuedeck_guard_cron_secret')
     OR cuedeck_cron_ok('wrong-secret-wrong-secret-wrong-secret') IS DISTINCT FROM false
     OR cuedeck_cron_ok((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cuedeck_guard_cron_secret')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL 6: cron secret';
  END IF;
  IF has_function_privilege('authenticated', 'public.cuedeck_run_guards()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_run_guards()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_guard_watch()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_guard_watch()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_cron_ok(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_cron_ok(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cuedeck_guard_watch()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.cuedeck_job_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.cuedeck_job_runs', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cuedeck_job_runs'::regclass) THEN
    RAISE EXCEPTION 'PROBE FAIL 6: privileges';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 134: % checks passed (rolled back)', v_checks;
END
$probe$;
```

`tests/deno/guard-alert.test.ts`:

```ts
// tests/deno/guard-alert.test.ts
// cuedeck-guard-alert against a stubbed Supabase and Resend: who may call it,
// that problems reach the alert inbox once a day, that a missing or failed
// watch read is itself a problem, and that only the Vercel call is a heartbeat.
// Run: deno test --allow-env --allow-read --no-lock tests/deno/guard-alert.test.ts
const FN_DIR = new URL('../../supabase/functions/', import.meta.url).href
Deno.env.set('SUPABASE_URL', 'http://stub.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
Deno.env.set('RESEND_API_KEY', 're_stub_key_for_tests')
Deno.env.set('BILLING_ALERT_EMAIL', 'alerts@example.com')

type Row = Record<string, unknown>
let runs: Row[]
let emails: Row[]
let watch: { status: number; body: unknown }
let cronSecretOk: boolean
let resendFails: boolean

const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const raw = init?.body ?? (req ? await req.clone().text() : undefined)
  if (url.host === 'api.resend.com') {
    emails.push(JSON.parse(String(raw ?? '{}')))
    return resendFails ? reply(500, { message: 'provider down' }) : reply(200, { id: 'email-stub' })
  }
  if (url.host !== 'stub.local') return reply(599, { message: 'unexpected ' + url.host })
  if (url.pathname === '/rest/v1/rpc/cuedeck_cron_ok') return reply(200, cronSecretOk)
  if (url.pathname === '/rest/v1/rpc/cuedeck_guard_watch') return reply(watch.status, watch.body)
  if (url.pathname === '/rest/v1/cuedeck_job_runs') {
    if (method === 'POST') { const b = JSON.parse(String(raw)); runs.push(...(Array.isArray(b) ? b : [b])); return reply(201, undefined) }
    const want = [...url.searchParams].filter(([, v]) => v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)])
    return reply(200, runs.filter(r => want.every(([k, v]) => String(r[k]) === v)))
  }
  return reply(404, { message: 'no route ' + url.pathname })
}) as typeof fetch

let handler: ((req: Request) => Promise<Response>) | null = null
Object.defineProperty(Deno, 'serve', { configurable: true, writable: true,
  value: (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve(), shutdown: async () => {} } } })
await import(`${FN_DIR}cuedeck-guard-alert/index.ts`)
if (!handler) throw new Error('no handler captured')

const OK_WATCH = { status: 200, body: { ok: true, problems: [], checked_at: '2026-10-13T05:10:00Z' } }
const BAD_WATCH = { status: 200, body: { ok: false, problems: ['guards failing: event_access_not_via_invited_by (1 read invited_by: leod_reports.x)'] } }
function setup() { runs = []; emails = []; watch = OK_WATCH; cronSecretOk = false; resendFails = false }
async function call(headers: Record<string, string>, body: Row = {}) {
  const res = await handler!(new Request('http://stub.local/functions/v1/cuedeck-guard-alert',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json().catch(() => ({})) as Row }
}
const VERCEL = { Authorization: 'Bearer service-role-stub' }
const CRON = { 'x-cron-secret': 'a'.repeat(64) }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m) }

Deno.test('guard-alert: no or wrong credentials are refused and nothing is sent', async () => {
  setup()
  let r = await call({})
  assert(r.status === 401, JSON.stringify(r))
  r = await call(CRON)   // cuedeck_cron_ok answers false
  assert(r.status === 401 && emails.length === 0 && runs.length === 0, JSON.stringify(r))
})

Deno.test('guard-alert: the daily Vercel call records a heartbeat and sends nothing when all is well', async () => {
  setup()
  const r = await call(VERCEL, { caller: 'vercel' })
  assert(r.status === 200 && r.body.ok === true && emails.length === 0, JSON.stringify(r))
  assert(runs.some(x => x.job_name === 'cuedeck-guard-watch' && x.status === 'ok'), JSON.stringify(runs))
})

Deno.test('guard-alert: a failing guard reaches the alert inbox once a day, from pg_cron without a heartbeat', async () => {
  setup(); cronSecretOk = true; watch = BAD_WATCH
  let r = await call(CRON, { caller: 'pg_cron' })
  assert(r.status === 200 && r.body.ok === false && r.body.emailed === true, JSON.stringify(r))
  const mail = emails[0] as { to: string | string[]; subject: string; html: string }
  assert(String(mail.to).includes('alerts@example.com') && mail.subject.startsWith('CueDeck guard alert'), JSON.stringify(mail))
  assert(mail.html.includes('event_access_not_via_invited_by'), mail.html)
  assert(!runs.some(x => x.job_name === 'cuedeck-guard-watch'), 'pg_cron counted as the Vercel heartbeat')
  assert(runs.some(x => x.job_name === 'cuedeck-guard-alert' && x.status === 'ok'), JSON.stringify(runs))
  r = await call(VERCEL, { caller: 'vercel' })   // the same problem later that day
  assert(r.body.emailed === false && emails.length === 1, 'emailed twice the same day')
})

Deno.test('guard-alert: a missing run is a problem like any other', async () => {
  setup(); watch = { status: 200, body: { ok: false, problems: ['guard run missing'] } }
  const r = await call(VERCEL, { caller: 'vercel' })
  assert(r.body.ok === false && r.body.emailed === true && (emails[0] as { html: string }).html.includes('guard run missing'), JSON.stringify(r))
})

Deno.test('guard-alert: a watch that cannot be read is reported, never treated as all-clear', async () => {
  setup(); watch = { status: 500, body: { code: 'XX000', message: 'boom' } }
  const r = await call(VERCEL, { caller: 'vercel' })
  assert(r.body.ok === false && r.body.emailed === true, JSON.stringify(r))
  assert((emails[0] as { html: string }).html.includes('cuedeck_guard_watch could not be read'), 'email body')
})

Deno.test('guard-alert: a failed email is a 502 and is retried on the next call', async () => {
  setup(); watch = BAD_WATCH; resendFails = true
  let r = await call(VERCEL, { caller: 'vercel' })
  assert(r.status === 502 && runs.some(x => x.job_name === 'cuedeck-guard-alert' && x.status === 'failed'), JSON.stringify(r))
  resendFails = false
  r = await call(VERCEL, { caller: 'vercel' })
  assert(r.status === 200 && r.body.emailed === true && emails.length === 2, 'not retried')
})

Deno.test('guard-alert: no alert address is a 500, not silence', async () => {
  setup(); watch = BAD_WATCH
  Deno.env.delete('BILLING_ALERT_EMAIL')
  try {
    const r = await call(VERCEL, { caller: 'vercel' })
    assert(r.status === 500 && emails.length === 0, JSON.stringify(r))
  } finally { Deno.env.set('BILLING_ALERT_EMAIL', 'alerts@example.com') }
})
```

`tests/guard-alert.spec.ts`:

```ts
// tests/guard-alert.spec.ts
// Runs tests/deno/guard-alert.test.ts under deno (CI installs deno and must never skip).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno && !process.env.CI)('guard alert function (deno)', () => {
  it('tests/deno/guard-alert.test.ts passes', () => {
    expect(hasDeno, 'deno is not installed; CI must install it (denoland/setup-deno)').toBe(true);
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/guard-alert.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
```

`tests/health-check-guards.spec.ts`:

```ts
// tests/health-check-guards.spec.ts
// The daily Vercel health check also calls the guard watch (cuedeck-guard-alert),
// so a dead pg_cron is noticed, and reports 503 unless the guards are fine.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  dbError: null as unknown,
  invoke: { data: { ok: true, problems: [] } as unknown, error: null as unknown },
  invoked: [] as { name: string; body: unknown }[],
};
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ limit: async () => ({ error: state.dbError }) }) }),
    functions: { invoke: async (name: string, opts: { body: unknown }) => { state.invoked.push({ name, body: opts.body }); return state.invoke; } },
  }),
}));
process.env.CRON_SECRET = 'cron-test';
process.env.SUPABASE_URL = 'http://stub.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
const { default: handler } = await import('../api/cron/health-check');
const run = () => handler(new Request('http://x/api/cron/health-check', { headers: { authorization: 'Bearer cron-test' } }));

describe('health-check watches the guards', () => {
  beforeEach(() => { state.dbError = null; state.invoke = { data: { ok: true, problems: [] }, error: null }; state.invoked = []; });
  it('calls cuedeck-guard-alert as the Vercel heartbeat and is 200 when all is well', async () => {
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.guards).toBe('ok');
    expect(state.invoked).toEqual([{ name: 'cuedeck-guard-alert', body: { caller: 'vercel' } }]);
  });
  it('is 503 with the problems when a guard fails or a run is missing', async () => {
    state.invoke = { data: { ok: false, problems: ['guard run missing'] }, error: null };
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.guards).toBe('failing');
    expect(body.guard_problems).toEqual(['guard run missing']);
  });
  it('is 503 when the guard watch cannot be reached', async () => {
    state.invoke = { data: null, error: new Error('down') };
    const res = await run();
    expect(res.status).toBe(503);
    expect((await res.json()).guards).toBe('unreachable');
  });
});
```

- [ ] **Step 3: Run them and see them fail.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/guard-alert.test.ts`
Expected: FAIL: `Module not found … cuedeck-guard-alert/index.ts`.

Run: `npx vitest run tests/health-check-guards.spec.ts`
Expected: FAIL: `expected undefined to be 'ok'` (health-check has no `guards` field).

- [ ] **Step 4 (controller): run probe 134 before its migration.** Expected: `function cuedeck_run_guards() does not exist`. Record it.

- [ ] **Step 5: Write the migration** `supabase/migrations/134_cuedeck_guard_schedule.sql`:

```sql
-- ============================================================
-- CueDeck Migration 134: the console guards run every day, and are watched
-- ============================================================
-- cuedeck_guard_results() (132) is run daily by pg_cron, each run is
-- recorded in cuedeck_job_runs, and cuedeck_guard_watch() says what is
-- wrong: a failing guard, a run that is missing or older than 26 h, or a
-- watch heartbeat (the Vercel health-check) older than 26 h. Absence is a
-- failure, never an all-clear. When something is wrong the runner calls the
-- cuedeck-guard-alert Edge Function at once (pg_net), which emails the
-- existing alert inbox (BILLING_ALERT_EMAIL, as stripe-webhook does).
-- leod_checkin_job_runs is not used: it belongs to the check-in work.
-- The x-cron-secret is made inside the vault and never leaves the database
-- except in the request itself (pattern of 089).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS public.cuedeck_job_runs (
  id          bigserial   PRIMARY KEY,
  job_name    text        NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text        NOT NULL CHECK (status IN ('ok', 'failed')),
  failing     text[]      NOT NULL DEFAULT '{}',
  detail      text,
  alerted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS cuedeck_job_runs_job_idx ON public.cuedeck_job_runs (job_name, started_at DESC);
ALTER TABLE public.cuedeck_job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cuedeck_job_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.cuedeck_job_runs_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cuedeck_job_runs TO service_role;
GRANT USAGE ON SEQUENCE public.cuedeck_job_runs_id_seq TO service_role;
-- No policies: only the service role and the database read or write it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cuedeck_guard_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                'cuedeck_guard_cron_secret',
                                'x-cron-secret for the cuedeck-guard-alert Edge Function (134)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cuedeck_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
           SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'cuedeck_guard_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION public.cuedeck_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_cron_ok(text) TO service_role;

-- What is wrong right now. Everything not proven fresh and green is a problem.
CREATE OR REPLACE FUNCTION public.cuedeck_guard_watch()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run      cuedeck_job_runs%ROWTYPE;
  v_beat     timestamptz;
  v_problems text[] := '{}';
BEGIN
  SELECT * INTO v_run FROM cuedeck_job_runs
   WHERE job_name = 'cuedeck-guards' ORDER BY started_at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN
    v_problems := v_problems || 'guard run missing'::text;
  ELSE
    IF v_run.started_at < now() - interval '26 hours' THEN
      v_problems := v_problems || ('guard run stale: last run '
                                   || to_char(v_run.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC');
    END IF;
    IF v_run.status <> 'ok' THEN
      v_problems := v_problems || ('guards failing: ' || array_to_string(v_run.failing, ', ')
                                   || coalesce(' (' || left(v_run.detail, 300) || ')', ''));
    END IF;
  END IF;
  SELECT max(started_at) INTO v_beat FROM cuedeck_job_runs WHERE job_name = 'cuedeck-guard-watch';
  IF v_beat IS NULL THEN
    v_problems := v_problems || 'guard watch missing'::text;
  ELSIF v_beat < now() - interval '26 hours' THEN
    v_problems := v_problems || ('guard watch stale: last heartbeat '
                                 || to_char(v_beat AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC');
  END IF;
  RETURN jsonb_build_object('ok', cardinality(v_problems) = 0, 'problems', to_jsonb(v_problems), 'checked_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_guard_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_guard_watch() TO service_role;

-- The daily run: run the guards, record the run (an error in the guards is
-- a failed run, never a missing one), and call the alert function at once
-- when anything is wrong.
CREATE OR REPLACE FUNCTION public.cuedeck_run_guards()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started timestamptz := now();
  v_failing text[];
  v_detail  text;
  v_total   int;
  v_id      bigint;
BEGIN
  BEGIN
    SELECT coalesce(array_agg(g.guard ORDER BY g.guard) FILTER (WHERE NOT g.ok), '{}'),
           string_agg(g.guard || ': ' || g.detail, '; ' ORDER BY g.guard) FILTER (WHERE NOT g.ok),
           count(*)
      INTO v_failing, v_detail, v_total
      FROM cuedeck_guard_results() g;
    IF v_total = 0 THEN
      v_failing := ARRAY['no_guards_ran'];
      v_detail := 'cuedeck_guard_results returned no rows';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_failing := ARRAY['guard_error'];
    v_detail := SQLERRM;
  END;
  INSERT INTO cuedeck_job_runs (job_name, started_at, finished_at, status, failing, detail)
  VALUES ('cuedeck-guards', v_started, clock_timestamp(),
          CASE WHEN cardinality(v_failing) = 0 THEN 'ok' ELSE 'failed' END, v_failing, v_detail)
  RETURNING id INTO v_id;
  IF (cuedeck_guard_watch()->>'ok')::boolean IS DISTINCT FROM true THEN
    PERFORM net.http_post(
      url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/cuedeck-guard-alert',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                      WHERE name = 'cuedeck_guard_cron_secret')),
      body    := '{"caller":"pg_cron"}'::jsonb,
      timeout_milliseconds := 30000);
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_run_guards() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_run_guards() TO service_role;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cuedeck-guards';
SELECT cron.schedule('cuedeck-guards', '10 5 * * *', $cron$ SELECT public.cuedeck_run_guards(); $cron$);
```

- [ ] **Step 6: Write the Edge Function** `supabase/functions/cuedeck-guard-alert/index.ts`:

```ts
// cuedeck-guard-alert: tells a person when the console guards (migration 132)
// fail or stop running (migration 134). Called by two independent schedulers,
// so either one dying is noticed:
//  * pg_cron 'cuedeck-guards' (05:10 UTC) runs the guards and calls this at once
//    when anything is wrong (x-cron-secret, checked against the vault);
//  * the Vercel cron /api/cron/health-check (06:00 UTC) calls this every day
//    with the service-role key; that call is the 'cuedeck-guard-watch'
//    heartbeat the database checks.
// What is wrong comes from cuedeck_guard_watch(); a watch that cannot be read
// is itself a problem. Problems go to the existing alert inbox
// (BILLING_ALERT_EMAIL, as stripe-webhook's billing alerts) once per problem
// set per UTC day; a failed email is retried on the next call.
import { adminClient } from '../_shared/client.ts'
import { sendEmail } from '../_shared/resend.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

Deno.serve(async (req) => {
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  const sb = adminClient()

  // ── Who may call ─────────────────────────────────────────────
  const bearer = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const byVercel = !!serviceKey && bearer === serviceKey
  let byCron = false
  if (!byVercel) {
    const { data, error } = await sb.rpc('cuedeck_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
    if (error) return json(500, { error: 'secret check failed: ' + error.message })
    byCron = data === true
  }
  if (!byVercel && !byCron) return json(401, { error: 'Unauthorized' })

  const record = async (row: Record<string, unknown>) => {
    const { error } = await sb.from('cuedeck_job_runs').insert({ started_at: new Date().toISOString(), finished_at: new Date().toISOString(), ...row })
    if (error) console.error('cuedeck-guard-alert: run not recorded', row.job_name, error.message)
    return error
  }

  // ── The heartbeat: only the Vercel call counts as one ───────
  if (byVercel) {
    const hbErr = await record({ job_name: 'cuedeck-guard-watch', status: 'ok' })
    if (hbErr) return json(500, { error: 'heartbeat not recorded: ' + hbErr.message })
  }

  // ── What is wrong ───────────────────────────────────────────
  const { data: watch, error: watchErr } = await sb.rpc('cuedeck_guard_watch')
  const problems: string[] = watchErr || !watch
    ? ['cuedeck_guard_watch could not be read: ' + (watchErr?.message ?? 'no answer')]
    : (watch as { problems: string[] }).problems
  if (!problems.length) return json(200, { ok: true, problems, emailed: false })

  // ── Tell a person, once per problem set per UTC day ─────────
  const key = new Date().toISOString().slice(0, 10) + ' ' + problems.join(' | ')
  const { data: seen, error: seenErr } = await sb.from('cuedeck_job_runs').select('id')
    .eq('job_name', 'cuedeck-guard-alert').eq('status', 'ok').eq('detail', key).limit(1)
  if (seenErr) return json(500, { error: 'alert lookup failed: ' + seenErr.message })
  if (seen && seen.length) return json(200, { ok: false, problems, emailed: false })

  const to = Deno.env.get('BILLING_ALERT_EMAIL')
  if (!to) {
    console.error('cuedeck-guard-alert: BILLING_ALERT_EMAIL is not set; problems:', problems.join(' | '))
    await record({ job_name: 'cuedeck-guard-alert', status: 'failed', failing: problems, detail: 'no alert address' })
    return json(500, { error: 'BILLING_ALERT_EMAIL is not set', problems })
  }
  const html = `<p>CueDeck console guards need attention:</p><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
    + `<p>Check: <code>select * from cuedeck_guard_results()</code> and <code>select * from cuedeck_job_runs order by id desc limit 10</code>.</p>`
  const sent = await sendEmail({ to, subject: `CueDeck guard alert: ${problems[0].slice(0, 80)}`, html })
  if (sent.error) {
    await record({ job_name: 'cuedeck-guard-alert', status: 'failed', failing: problems, detail: 'email failed: ' + sent.error })
    return json(502, { error: 'alert email failed', problems })
  }
  await record({ job_name: 'cuedeck-guard-alert', status: 'ok', failing: problems, detail: key, alerted_at: new Date().toISOString() })
  return json(200, { ok: false, problems, emailed: true })
})
```

- [ ] **Step 7: The Vercel health check calls it every day.** In `api/cron/health-check.ts`, replace everything from `  const status = {` to the end of the handler with:

```ts
  // The daily heartbeat for the console guards (migration 134): calling the
  // alert function records 'cuedeck-guard-watch', and it emails if a guard
  // fails or the pg_cron run is missing. A watch we cannot reach is not fine.
  const { data: guards, error: guardErr } = await supabase.functions.invoke('cuedeck-guard-alert', { body: { caller: 'vercel' } });
  const guardState = guardErr || !guards ? 'unreachable' : (guards as { ok: boolean }).ok ? 'ok' : 'failing';

  const ok = !error && guardState === 'ok';
  const status = {
    ok,
    supabase: error ? "unreachable" : "healthy",
    latency_ms: latency,
    guards: guardState,
    guard_problems: guardState === 'failing' ? (guards as { problems: string[] }).problems : undefined,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(status), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 8: Deploy script.** In `scripts/deploy-functions.sh` add `cuedeck-guard-alert` at the end of `ALL_FUNCTIONS=(…)` and to the `case "$func" in …) extra=(--no-verify-jwt)` list (after `checkin-webhooks`).

- [ ] **Step 9: Run the tests and see them pass.**

Run: `deno test --allow-env --allow-read --no-lock tests/deno/guard-alert.test.ts` → PASS (7 tests).
Run: `npx vitest run tests/guard-alert.spec.ts tests/health-check-guards.spec.ts tests/cron-functions-reachable.spec.ts` → PASS.
Run: `deno check supabase/functions/cuedeck-guard-alert/index.ts` → no errors.

- [ ] **Step 10: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/134_cuedeck_guard_schedule.sql tests/sql/134-guard-schedule-probe.sql supabase/functions/cuedeck-guard-alert/index.ts tests/deno/guard-alert.test.ts tests/guard-alert.spec.ts api/cron/health-check.ts tests/health-check-guards.spec.ts scripts/deploy-functions.sh
git commit -m "feat(guards): run the console guards daily and alert on failure or a missing run (migration 134)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/134_cuedeck_guard_schedule.sql tests/sql/134-guard-schedule-probe.sql supabase/functions/cuedeck-guard-alert/index.ts tests/deno/guard-alert.test.ts tests/guard-alert.spec.ts api/cron/health-check.ts tests/health-check-guards.spec.ts scripts/deploy-functions.sh
```

---

# Stage 3: Console

Every console task runs the existing console suites at its end, so a change that breaks the redesign or show-safety behaviour is caught where it is made:

```bash
cd /Users/sheriff/AVE-Production-Console-teams
(python3 -m http.server 7293 --bind 127.0.0.1 --directory /Users/sheriff/AVE-Production-Console-teams >/dev/null 2>&1 &)
CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts --global-timeout=1800000 2>&1 | tail -8
npx vitest run 2>&1 | tail -6
```

Expected for both: `0 failed`. (Start the server once per shell session; a second start on the same port fails harmlessly.)

### Task 3.1: Role per event on boot and on every switch

Spec §5 (the role is resolved per event, on boot and on every event switch; the role lock, director-only controls, presence role, crew list and View as follow the current event's role), §7 (do not shut out a `checkin_staff` login that has console memberships), Review Focus 1 and 2.

The many director gates in the console read `S.userRole` (inventory §3: lines 3962 to 8677). Instead of touching each, `S.userRole` now means "my role on the current event" and is set by one function, `applyEventRole`, on boot and on every switch. The account's own `leod_users.role` moves to `S.accountRole` and is only used to recognise pending, check-in-only and admin accounts.

**Files:**
- Modify: `cuedeck-console.html`: state `S` (line 2941), `switchEvent` (7132-7150), `loadUserRole` (9138-9264, three edits), boot (around 9746-9822, three edits)
- Modify: `cuedeck-i18n.js` (two keys in each of en, ar, pl, de, after `'cc.menu.billing'`)
- Modify: `tests/e2e/console-boot-mock.ts` (my events, account role, Edge Function answers, recorded calls, recorded realtime sends)
- Modify: `tests/e2e/console-boot-harness.ts:135` (answer `cuedeck_my_events`)
- Modify: `tests/e2e/console-show-safety.spec.ts:212-233` (the switch test answers `cuedeck_my_events`)
- Create: `tests/e2e/console-event-teams.spec.ts`

**Interfaces:**
- Consumes: RPC `cuedeck_my_events()` → rows `{ event_id, role, is_owner, owner_id, organiser, plan, plan_status, trial_ends_at }` (Task 2.1).
- Produces (console globals later tasks use):
  - `S.myEvents: Map<string, { role: string, isOwner: boolean, ownerId: string, organiser: string, plan: string|null, planStatus: string|null, trialEndsAt: string|null }>`
  - `S.accountRole: string` (the `leod_users.role`)
  - `async function loadMyEvents(): Promise<Map>` (throws on an RPC error)
  - `function applyEventRole(eventId: string|null): boolean` (sets `S.userRole`, calls `setRole`, shows or hides View as, the role lock, the role menu, Displays and Team; `false` when the event has no role)
  - `function noteRoleForWelcome(): void`
  - `switchEvent(eventId)` re-reads `S.myEvents` before switching; an event no longer listed is dropped with the toast `cc.ev.noAccess`.
- Test helpers produced in `tests/e2e/console-boot-mock.ts`: `export const EVENT`, `export const OTHER_OWNER`, `export const PRO_SUB`, `export interface MyEvent`, `export interface Call { method: string; path: string; body: any }`; `Scenario` gains `accountRole?`, `myEvents?` (read on every request, so a test can change it), `ownSub?` (`null` = none), `fnReply?(fn, body)`; `openConsole` returns `{ ctx, page, calls }`; the fake socket records every client message in `window.__rtSent`.

- [ ] **Step 1: Extend the console mock.** In `tests/e2e/console-boot-mock.ts`:

Change `const EVENT = {` (line 128) to `export const EVENT = {`.

After the `OPERATORS` constant (line 156), add:

```ts
// Event teams (spec 2026-10-08): what cuedeck_my_events answers. Default:
// the demo event, with the scenario's role on it, owned when that role is
// director, organiser Nilegate Events on Pro.
export const OTHER_OWNER = '0e0e0e0e-0000-4000-8000-0000000000e1';
export interface MyEvent {
  id: string; name: string; role: string; isOwner: boolean;
  ownerId?: string; organiser?: string | null; plan?: string | null; planStatus?: string | null; trialEndsAt?: string | null;
}
export const PRO_SUB = { plan: 'pro', status: 'active', trial_ends_at: null, current_period_end: '2026-11-01T00:00:00Z' };
export interface Call { method: string; path: string; body: any }
```

In `interface Scenario`, add after `stageMessages?: unknown[];`:

```ts
  accountRole?: string;          // leod_users.role, the account's kind; default: role
  myEvents?: MyEvent[];          // cuedeck_my_events; read on every request, so a test may change it
  ownSub?: Record<string, unknown> | null;   // get_subscription_for_user row; null = none
  fnReply?: (fn: string, body: any) => { status: number; body: unknown } | undefined;   // Edge Function answers
```

Change the signature line of `openConsole` to:

```ts
export async function openConsole(browser: Browser, sc: Scenario = {}): Promise<{ ctx: BrowserContext; page: Page; calls: Call[] }> {
```

and right after `const broadcast = …` add:

```ts
  const myEvents = (): MyEvent[] => sc.myEvents ?? [{ id: EVENT_ID, name: EVENT.name, role, isOwner: role === 'director' }];
  const calls: Call[] = [];
```

In the fake socket, right after the line `const m = arr ? (() => { … })() : JSON.parse(raw);` (line 215), add:

```ts
        ((window as any).__rtSent ||= []).push(m);
```

Replace the Edge Function line

```ts
    if (p.startsWith('/functions/v1/')) return json(r, { ok: true, status: 'OK', version: 10 });
```

with

```ts
    if (p.startsWith('/functions/v1/')) {
      let body: any = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
      calls.push({ method: req.method(), path: p, body });
      const custom = sc.fnReply?.(p.split('/').pop()!, body);
      if (custom) return json(r, custom.body, custom.status);
      return json(r, { ok: true, status: 'OK', version: 10 });
    }
```

Replace the RPC line for `get_subscription_for_user` with:

```ts
      if (fn === 'get_subscription_for_user') return json(r, sc.ownSub === null ? [] : [sc.ownSub ?? PRO_SUB]);
      if (fn === 'cuedeck_my_events') return json(r, myEvents().map(m => ({
        event_id: m.id, role: m.role, is_owner: m.isOwner, owner_id: m.isOwner ? USER_ID : (m.ownerId ?? OTHER_OWNER),
        organiser: m.organiser === undefined ? 'Nilegate Events' : m.organiser,
        plan: m.plan === undefined ? 'pro' : m.plan, plan_status: m.planStatus === undefined ? 'active' : m.planStatus,
        trial_ends_at: m.trialEndsAt ?? null })));
```

Replace `if (req.method() !== 'GET') return json(r, [], 201);` (line 303) with:

```ts
      if (req.method() !== 'GET') {
        let body: any = null;
        try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
        calls.push({ method: req.method(), path: p + url.search, body });
        return json(r, [], 201);
      }
```

In the `rows` object, change the `leod_users` row's `role` to `role: sc.accountRole ?? role` and replace `leod_events: [EVENT]` with `leod_events: myEvents().map(m => ({ ...EVENT, id: m.id, name: m.name }))`.

Change the last line of `openConsole` from `return { ctx, page };` to `return { ctx, page, calls };`.

With no new scenario fields every existing spec gets exactly what it got before (one event, the same role, a Pro plan), so their screenshots do not change.

- [ ] **Step 2: Teach the show-safety harness the new RPC.** In `tests/e2e/console-boot-harness.ts`, after the line `if (fn === 'get_subscription_for_user') return json(r, …);` (line 135), add:

```ts
      if (fn === 'cuedeck_my_events') return json(r, [EVENT, ...(sc.extraEvents ?? [])].map((e: any) => ({
        event_id: e.id, role, is_owner: role === 'director', owner_id: role === 'director' ? USER_ID : '0e0e0e0e-0000-4000-8000-0000000000e1',
        organiser: 'Demo Events', plan: 'pro', plan_status: 'active', trial_ends_at: null })));
```

`tests/e2e/console-show-safety.spec.ts`, test `switching event clears the batch selection and its armed button`, answers every REST call with `[]`, which after this task means "you are on no event" and the switch is refused. Keep what it protects (a switch clears the selection and the armed button) by answering the new RPC: right after its `await setup(page, [live(), sess('p2', 2, { status: 'PLANNED' })]);` line add

```ts
    // event teams: switchEvent re-reads the role for each event (cuedeck_my_events)
    await page.route('**/rest/v1/rpc/cuedeck_my_events', r => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(['ev-1', 'ev-2'].map(id => ({ event_id: id, role: 'director', is_owner: true, owner_id: 'user-1',
        organiser: '', plan: 'pro', plan_status: 'active', trial_ends_at: null }))) }));
```

(A route added later wins over the spec's catch-all `**/rest/v1/**`.)

- [ ] **Step 3: Write the failing e2e tests.** Create `tests/e2e/console-event-teams.spec.ts`:

```ts
// tests/e2e/console-event-teams.spec.ts
// Event teams in the console (spec docs/superpowers/specs/2026-10-08-event-teams-design.md
// §5, §6, §9): the role, the plan and the team follow the current event.
// Mocked Supabase (console-boot-mock.ts); the page clock is paused after
// boot, so anything that waits on the network steps the clock (switchTo).
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, afterBootReread, EVENT_ID, USER_ID, OTHER_OWNER, type MyEvent } from './console-boot-mock';

const EV_B = 'b0b0b0b0-0000-4000-8000-0000000000b2';
const EV_C = 'c0c0c0c0-0000-4000-8000-0000000000c3';
const toasts = (page: Page) => page.locator('#toast-container');

// switchEvent awaits realtime replies that ride on timers; step the paused
// clock until it has finished.
async function switchTo(page: Page, id: string) {
  await evalPage(page, `window.__swDone = false; switchEvent('${id}').then(() => { window.__swDone = true; }, e => { window.__swDone = 'error: ' + (e && e.message); }); 0`);
  for (let i = 0; i < 200; i++) {
    const done = await evalPage(page, 'window.__swDone');
    if (done === true) return;
    if (typeof done === 'string') throw new Error(done);
    await page.clock.runFor(50);
  }
  throw new Error('switchEvent did not finish');
}
const lastTrackRole = (page: Page, eventId: string) => evalPage(page,
  `((window.__rtSent || []).filter(m => m.topic === 'realtime:leod-ctrl-${eventId}' && m.event === 'presence' && m.payload && m.payload.event === 'track').map(m => m.payload.payload.role).pop()) || null`);

const twoEvents = (): MyEvent[] => [
  { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage',    isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
  { id: EV_B,     name: 'Spring summit',         role: 'director', isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
];

test('teams: the role follows the event, both ways', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await expect(page.locator('#role-lock')).toBeVisible();
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.userRole')).toBe('director');
    expect(await evalPage(page, 'S.role')).toBe('director');
    await expect(page.locator('#role-lock')).toBeHidden();
    await expect(page.locator('#viewas-btn')).toBeVisible();
    await switchTo(page, EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    expect(await evalPage(page, 'F.status')).toBe('ACTIVE');   // the stage default filter came back
    // the director role from the other event does not leak: View as is refused
    await evalPage(page, `setRole('director'); 0`);
    expect(await evalPage(page, 'S.role')).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: presence tracks the role on the current event', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await switchTo(page, EV_B);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EV_B); }).toBe('director');
    await switchTo(page, EVENT_ID);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EVENT_ID); }).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: an event you were removed from is dropped on switch', async ({ browser }) => {
  const mine = twoEvents();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: mine });
  try {
    await afterBootReread(page);
    mine.splice(1, 1);   // the organiser removes this person from Spring summit
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(toasts(page)).toContainText('You are no longer on the team of this event.');
    expect(await evalPage(page, 'S.events.map(e => e.id)')).toEqual([EVENT_ID]);
    await expect(page.locator('#ev-pill-dd')).not.toContainText('Spring summit');
  } finally { await ctx.close(); }
});

test('teams: a check-in staff login that is on a console team opens the console', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {
    role: 'stage', accountRole: 'checkin_staff',
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER }],
  });
  try {
    await expect(page.locator('body')).not.toContainText('This login is for CueDeck Check-in');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(page, 'S.accountRole')).toBe('checkin_staff');
  } finally { await ctx.close(); }
});
```

(`EV_C` and `USER_ID` are used by the tests Tasks 3.2 to 3.4 add to this file.)

- [ ] **Step 4: Run them and see them fail.**

Run (server started as in the Stage 3 preamble): `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: FAIL. `the role follows the event` fails on `#role-lock` (the console reads the role from `leod_users`, which the mock gives as `stage`, then never changes it: `S.userRole` stays `stage` after the switch); the check-in test fails inside `openConsole` (boot stops at the "This login is for CueDeck Check-in" overlay, so the connection label never appears).

- [ ] **Step 5: Add the per-event role to the console.** In `cuedeck-console.html`:

(a) In the state object `S`, replace the line

```js
  userRole:        null,   // role from leod_users table
```

with

```js
  userRole:        null,   // my role on the current event (applyEventRole; event teams)
  accountRole:     null,   // leod_users.role: only pending, checkin_staff and admin mean anything now
  myEvents:        new Map(), // event id → { role, isOwner, ownerId, organiser, plan, planStatus, trialEndsAt }
```

(b) Directly above `async function loadUserRole() {` add:

```js
// ── Event teams (spec 2026-10-08 §5) ──────────────────────────────────────
// cuedeck_my_events lists every event this login created or is an active
// member of, with the role on it, its organiser and the organiser's plan.
// Read on boot and again on every switch, so a role change, a suspension or
// a removal since boot counts at once. A failed read throws: the role is
// never guessed.
async function loadMyEvents() {
  const { data, error } = await sb.rpc('cuedeck_my_events');
  if (error) throw error;
  return new Map((data || []).map(r => [r.event_id, {
    role: r.role, isOwner: !!r.is_owner, ownerId: r.owner_id, organiser: r.organiser || '',
    plan: r.plan || null, planStatus: r.plan_status || null, trialEndsAt: r.trial_ends_at || null,
  }]));
}

// The role on one event decides what the role decided before: the role lock
// or View as, the director-only controls, the presence role and the crew
// list. With no event at all, a new account directs its own (empty) account.
function applyEventRole(eventId) {
  const role = eventId ? S.myEvents.get(eventId)?.role : 'director';
  if (!role) return false;
  S.userRole = role;   // first, so setRole's role lock lets this role through
  setRole(role);
  const director = role === 'director';
  const va = document.getElementById('viewas-btn');
  if (va) va.hidden = !director;
  const lock = document.getElementById('role-lock');
  if (lock) { lock.textContent = t('role.' + role); lock.hidden = director; }
  const mmRoles = document.getElementById('mm-roles');
  if (mmRoles) mmRoles.hidden = !director;
  const disp = document.getElementById('displays-btn');
  if (disp) disp.hidden = !director;
  const users = document.getElementById('users-btn');
  if (users) users.style.display = director && eventId ? 'flex' : 'none';
  if (director) refreshDisplaysPill();
  renderUserChip();
  return true;
}

// Welcome modal or role-change toast for the role the console opens on.
function noteRoleForWelcome() {
  if (!S.user || !S.userRole) return;
  const key = 'cuedeck_last_role_' + S.user.id;
  const last = localStorage.getItem(key);
  if (last === S.userRole) return;
  if (!last || last === 'pending') S._showWelcome = S.userRole;   // first login after joining
  else S._showRoleChange = { from: last, to: S.userRole };
  localStorage.setItem(key, S.userRole);
}
```

(c) In `loadUserRole`, replace

```js
  if (!data) {
    // no leod_users row → implicit director (show users button)
    document.getElementById('users-btn').style.display = 'flex';
    loadPendingBadge();
    return;
  }
```

with

```js
  // The role is per event (event teams): it comes from cuedeck_my_events and
  // applyEventRole sets it on boot and on every switch. leod_users.role only
  // says what kind of account this is (pending, check-in staff, admin).
  S.myEvents = await loadMyEvents();
  if (!data) return;   // no leod_users row yet: an organiser account
```

(d) In `loadUserRole`, replace

```js
  // Check-in-only staff (migration 059). Without this the console would
  // treat them as an account with no plan and offer a trial.
  if (data.role === 'checkin_staff') {
```

with

```js
  // Check-in-only staff (migration 059) are sent to Check-in, unless the same
  // login is also on a console event's team (event teams §7): then the
  // console opens on those events. Without this the console would treat them
  // as an account with no plan and offer a trial.
  if (data.role === 'checkin_staff' && !S.myEvents.size) {
```

(e) In `loadUserRole`, replace everything from `  S.userRole = data.role;` down to the function's closing `}` (lines 9218-9257 on 8 Oct: the profile fields, `setRole(data.role)`, the role-change detection, the role lock and the director block that called `loadPendingBadge`) with:

```js
  S.accountRole        = data.role;
  S.userName           = data.name || '';
  S.userOrg            = data.organization || '';
  S.userPhone          = data.phone || '';
  S.userCompanyName    = data.company_name || '';
  S.userVatId          = data.vat_id || '';
  S.userBillingAddress = data.billing_address || '';
  // The role, the role lock, View as, Displays and Team are applied per event
  // by applyEventRole; the welcome check by noteRoleForWelcome (boot).
}
```

(f) In `boot()`, replace

```js
      events = await loadEvents();
      S.events = events;
```

with

```js
      events = (await loadEvents()).filter(e => S.myEvents.has(e.id));   // only events with a role here
      S.events = events;
```

(g) In `boot()`, right after `    if (!events.length) {` add:

```js
      applyEventRole(null);   // a new account directs its own, still empty, account
      noteRoleForWelcome();
```

(h) In `boot()`, replace

```js
    // 3. Select event
    const ev = events[0];
    S.event = ev;
```

with

```js
    // 3. Select event, and the role on it
    const ev = events[0];
    S.event = ev;
    applyEventRole(ev.id);
    noteRoleForWelcome();
```

(i) Replace the start of `switchEvent` (from `async function switchEvent(eventId) {` through `  S.event = ev;`) with:

```js
async function switchEvent(eventId) {
  const ev = S.events.find(e => e.id === eventId);
  if (!ev) return;
  // The role is per event (event teams §5): read again on every switch, so a
  // change, a suspension or a removal since boot counts now.
  let mine;
  try { mine = await loadMyEvents(); }
  catch (e) { pushToast(t('cc.ev.roleLoadFailed'), 'error'); return; }
  S.myEvents = mine;
  if (!mine.has(eventId)) {
    S.events = S.events.filter(x => mine.has(x.id));
    buildEvSelect(S.events);
    pushToast(t('cc.ev.noAccess'), 'warn');
    return;
  }
  S.event = ev;
  applyEventRole(eventId);
```

The rest of `switchEvent` is unchanged; its `F.status = ROLE_FILTER_DEFAULT[S.role] || ''` now reads the new event's role, and `subscribeControl` tracks presence with it.

- [ ] **Step 6: Strings.** In `cuedeck-i18n.js` add after each language's `'cc.menu.billing'` line:

en (after `      'cc.menu.billing': 'Billing',`):
```js
      'cc.ev.noAccess': 'You are no longer on the team of this event.',
      'cc.ev.roleLoadFailed': 'Could not load your role for this event. Try again.',
```
ar (after `      'cc.menu.billing': 'الفوترة',`):
```js
      'cc.ev.noAccess': 'لم تعد ضمن فريق هذا الحدث.',
      'cc.ev.roleLoadFailed': 'تعذّر تحميل دورك في هذا الحدث. حاول مرة أخرى.',
```
pl (after `      'cc.menu.billing': 'Płatności',`):
```js
      'cc.ev.noAccess': 'Nie należysz już do zespołu tego wydarzenia.',
      'cc.ev.roleLoadFailed': 'Nie udało się wczytać Twojej roli w tym wydarzeniu. Spróbuj ponownie.',
```
de (after `      'cc.menu.billing': 'Abrechnung',`):
```js
      'cc.ev.noAccess': 'Sie gehören nicht mehr zum Team dieser Veranstaltung.',
      'cc.ev.roleLoadFailed': 'Ihre Rolle für diese Veranstaltung konnte nicht geladen werden. Versuchen Sie es erneut.',
```

- [ ] **Step 7: Run the new tests and see them pass.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: 4 passed.

Run: `npx vitest run tests/console-i18n-keys.spec.ts tests/console-copy.spec.ts tests/console-colour-ratchet.spec.ts`
Expected: PASS.

- [ ] **Step 8: Run every console suite** (Stage 3 preamble). Expected: `0 failed`, screenshots unchanged (the default mock gives every existing scenario the same event, role and plan as before). If a show-safety switch test times out, check that `console-boot-harness.ts` answers `cuedeck_my_events` (Step 2).

- [ ] **Step 9: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-boot-harness.ts tests/e2e/console-show-safety.spec.ts tests/e2e/console-event-teams.spec.ts
git commit -m "feat(console): role per event on boot and on every switch; check-in staff on a console team get in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-boot-harness.ts tests/e2e/console-show-safety.spec.ts tests/e2e/console-event-teams.spec.ts
```

### Task 3.2: Plans per event, no trial for members, own events only

Spec §5 (an account that is only ever a member sees no billing, no "trial", no plan upsell), §6 (members work on the event owner's plan; no trial for someone who has only memberships, a trial starts when they create their first own event; all limits for an event come from its owner's plan; creating your own event uses your plan; events you are only a member of never count toward your own limits).

**Files:**
- Modify: `cuedeck-console.html`: state `S` (lines 2965-2966), `submitEvModal` create branch (7216-7230), `renderProfilePanel` plan section (8576-8613), `toggleProfileEdit` (8648), `saveProfileChanges` (8677), `loadSubscription` and `createTrialSubscription` (8705-8752), trial screen promo block (2167) and its CSS (after line 259), boot (no-events branch and event selection), `switchEvent`, AI agent init (9874-9879 and 9996-10000)
- Modify: `cuedeck-agent-1-incident-advisor.js` (ai-proxy body, around line 361), `cuedeck-agent-2-cue-engine.js` (state line 260, `init` 336-338, ai-proxy body around line 474), `cuedeck-agent-3-report-generator.js` (ai-proxy body, around line 432)
- Modify: `cuedeck-i18n.js` (four keys per language)
- Modify: `tests/e2e/console-event-teams.spec.ts` (four tests)
- Modify: `tests/e2e/session-people.spec.ts:331` (SP13 states an own plan)
- Create: `tests/console-ai-event-id.spec.ts`

**Interfaces:**
- Consumes: `S.myEvents`, `applyEventRole`, `loadMyEvents`, `noteRoleForWelcome` (Task 3.1); `get_subscription_for_user` returns only your own plan (Task 1.2); ai-proxy accepts `event_id` (Task 2.4).
- Produces:
  - `S.ownPlanLimits` (the `PLAN_LIMITS` entry of your own plan, or `null`); `S.planLimits` now means the current event's organiser's plan.
  - `isMembersOnlyAccount(): boolean`, `planEnded(m): boolean` (for a `S.myEvents` entry), `ownPlanEnded(): boolean`, `applyEventPlan(eventId): void`, `showPlanEndedScreen(membersOnly: boolean): void`.
  - `createTrialSubscription()` now throws when the insert fails.
  - Every ai-proxy call from the three agents carries `event_id` (the current event); `CueDeckCueEngine.init` takes `getEventId`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/e2e/console-event-teams.spec.ts`:

```ts
test('teams: a members-only account gets no trial, no plan badge and no billing', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, {
    role: 'director', ownSub: null,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }],
  });
  try {
    expect(calls.filter(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_subscriptions'))).toEqual([]);
    expect(await evalPage(page, 'S.subscription')).toBeNull();
    expect(await evalPage(page, 'S.planLimits.label')).toBe('Pro');   // the organiser's plan
    await expect(page.locator('#plan-badge')).toBeHidden();
    expect(await evalPage(page, `renderProfilePanel(); document.getElementById('pp-plan-section').style.display`)).toBe('none');
  } finally { await ctx.close(); }
});

test('teams: plan limits come from the event owner, per event', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage',    isOwner: false, ownerId: OTHER_OWNER, plan: 'starter' },
    { id: EV_B,     name: 'Spring summit',         role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' },
  ] });
  try {
    await afterBootReread(page);
    expect(await evalPage(page, 'S.planLimits.ai')).toBe(false);
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.planLimits.ai')).toBe(true);
    expect(await evalPage(page, 'S.planLimits.label')).toBe('Pro');
  } finally { await ctx.close(); }
});

test('teams: only your own events count toward your event limit', async ({ browser }) => {
  // Own plan: Starter (1 event). On someone else's Pro event only: may create one.
  const member = await openConsole(browser, {
    role: 'director', ownSub: { plan: 'starter', status: 'active', trial_ends_at: null },
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }],
  });
  try {
    await evalPage(member.page, `openEvModal('create'); document.getElementById('evm-name').value = 'Own launch'; submitEvModal(); 0`);
    await expect.poll(() => member.calls.some(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_events'))).toBe(true);
    await expect(member.page.locator('#evm-error')).not.toContainText('plan allows');
  } finally { await member.ctx.close(); }
  // The same plan with one own event already: refused, nothing sent.
  const owner = await openConsole(browser, {
    role: 'director', ownSub: { plan: 'starter', status: 'active', trial_ends_at: null },
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true, plan: 'starter' }],
  });
  try {
    await evalPage(owner.page, `openEvModal('create'); document.getElementById('evm-name').value = 'Second launch'; submitEvModal(); 0`);
    await expect(owner.page.locator('#evm-error')).toContainText('plan allows 1 active event');
    expect(owner.calls.some(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_events'))).toBe(false);
  } finally { await owner.ctx.close(); }
});

test('teams: an organiser plan that ended is refused on switch, and members see no prices', async ({ browser }) => {
  const ended = new Date(Date.parse('2026-10-06T08:40:00Z') - 3600e3).toISOString();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'trial', trialEndsAt: ended },
  ] });
  try {
    await afterBootReread(page);
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    await expect(toasts(page)).toContainText('The plan for this event has ended. Ask the organiser to renew it.');
    // At boot this screen shows inside the loading overlay; after boot the
    // overlay is gone, so read what the screen would show.
    await evalPage(page, 'showPlanEndedScreen(true); 0');
    expect(await evalPage(page, `(() => { const s = document.getElementById('trial-expired-screen');
      return { member: s.classList.contains('te-member'), shown: s.style.display,
               title: document.getElementById('te-title').textContent,
               plans: getComputedStyle(document.getElementById('te-plans')).display,
               promo: getComputedStyle(s.querySelector('.te-promo')).display }; })()`))
      .toEqual({ member: true, shown: 'flex', title: 'This event plan has ended', plans: 'none', promo: 'none' });
  } finally { await ctx.close(); }
});
```

Create `tests/console-ai-event-id.spec.ts`:

```ts
// tests/console-ai-event-id.spec.ts
// Event teams (spec 2026-10-08 §6): AI on an event runs on that event
// owner's plan, so every ai-proxy call from the console's agents names the
// event; ai-proxy refuses a caller who is not on it (tests/deno/plan-owner.test.ts).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENTS = ['cuedeck-agent-1-incident-advisor.js', 'cuedeck-agent-2-cue-engine.js', 'cuedeck-agent-3-report-generator.js'];

describe('AI calls name their event', () => {
  for (const f of AGENTS) {
    it(`${f} sends event_id with every ai-proxy call`, () => {
      const src = readFileSync(resolve(__dirname, '..', f), 'utf8');
      const callsites = src.split("functions.invoke('ai-proxy'").slice(1);
      expect(callsites.length).toBeGreaterThan(0);
      for (const c of callsites) expect(c.slice(0, 400)).toMatch(/event_id:\s*_(opts\.)?getEventId/);
    });
  }
  it('the console gives the cue engine the current event, at both init sites', () => {
    const src = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
    const inits = src.split('CueDeckCueEngine.init(').slice(1);
    expect(inits.length).toBe(2);
    for (const c of inits) expect(c.slice(0, 300)).toMatch(/getEventId:/);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: the four new tests fail (a trial is POSTed for the members-only account; `S.planLimits.ai` does not change on switch; the own-event limit counts the member event; `showPlanEndedScreen is not defined`). The four Task 3.1 tests still pass.

Run: `npx vitest run tests/console-ai-event-id.spec.ts`
Expected: FAIL (no `event_id` in the agents' bodies; one `CueDeckCueEngine.init` without `getEventId`).

- [ ] **Step 3: Plan state and helpers.** In `cuedeck-console.html`:

In `S`, replace

```js
  planLimits:      null,   // resolved PLAN_LIMITS entry
```

with

```js
  planLimits:      null,   // PLAN_LIMITS of the current event's organiser's plan (applyEventPlan)
  ownPlanLimits:   null,   // PLAN_LIMITS of my own plan: only for creating my own events
```

Replace the whole `loadSubscription` and `createTrialSubscription` functions (from `async function loadSubscription() {` to the closing `}` of `createTrialSubscription`) with:

```js
// Event teams (spec §5, §6): members work on each event organiser's plan and
// have no plan of their own. An account that is only ever a member sees no
// billing, no trial and no upsell; a trial starts with its first own event.
function isMembersOnlyAccount() {
  return S.myEvents.size > 0 && ![...S.myEvents.values()].some(m => m.isOwner) && !S.subscription;
}
// An organiser's plan has ended: canceled, expired, or a trial past its end.
function planEnded(m) {
  if (!m) return false;
  if (m.planStatus === 'expired' || m.planStatus === 'canceled') return true;
  return m.plan === 'trial' && !!m.trialEndsAt && new Date(m.trialEndsAt) <= new Date();
}
function ownPlanEnded() {
  return !!S.subscription && (S.subscription.status === 'expired' || S.subscription.status === 'canceled');
}
// The plan for one event is always its creator's: displays, reports and AI.
// No subscription row counts as a trial, as on the server (cuedeck_plan_seats).
function applyEventPlan(eventId) {
  const m = S.myEvents.get(eventId);
  S.planLimits = PLAN_LIMITS[m?.plan] || PLAN_LIMITS.trial;
}
// Every event this login can open has an ended plan. An organiser sees the
// plans, as before; a members-only account sees who to ask and no prices.
function showPlanEndedScreen(membersOnly) {
  const scr = document.getElementById('trial-expired-screen');
  scr.classList.toggle('te-member', !!membersOnly);
  if (membersOnly) {
    scr.querySelector('.te-msg').textContent = t('cc.ev.planEndedAsk');
    showTrialExpiredScreen(t('cc.ev.planEndedTitle'));
  } else {
    showTrialExpiredScreen(S.subscription?.plan === 'trial' ? undefined : 'Your subscription has ended');
  }
}

// Your own plan. Whether an ended plan blocks anything is decided per event
// (boot and switchEvent): your own plan only governs your own events.
async function loadSubscription() {
  const { data, error } = await sb.rpc('get_subscription_for_user');
  if (error) throw error;   // a failed read never creates a trial
  const sub = Array.isArray(data) ? data[0] : data;
  if (!sub) {
    if (isMembersOnlyAccount()) {
      S.subscription = null;
      S.ownPlanLimits = null;
      updatePlanBadge();
      return;
    }
    await createTrialSubscription();
    return loadSubscription();
  }
  S.subscription = sub;
  await loadStripePrices(); // must complete before expiry checks so pricing screen has price IDs
  if (sub.plan === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) <= new Date()) {
    S.subscription.status = 'expired';
  }
  S.ownPlanLimits = PLAN_LIMITS[sub.plan] || PLAN_LIMITS.trial;
  updatePlanBadge();
}

async function createTrialSubscription() {
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 3);
  const { error } = await sb.from('leod_subscriptions').insert({
    director_id: S.user.id,
    plan: 'trial',
    status: 'active',
    trial_ends_at: trialEnd.toISOString(),
  });
  if (error) throw error;   // a trial that was not saved is never reported as started
}
```

(`updatePlanBadge` already hides the badge when `S.subscription` is null, so a members-only account shows none.)

- [ ] **Step 4: Boot and switch use the event's plan.** In `boot()`:

In the no-events branch, insert before the `applyEventRole(null);` line that Task 3.1 added:

```js
      // Your own plan ended and you have no event: the plans screen, as before.
      if (ownPlanEnded()) {
        showPlanEndedScreen(false);
        throw new Error('trial_expired');
      }
```

Replace the event selection Task 3.1 wrote

```js
    // 3. Select event, and the role on it
    const ev = events[0];
    S.event = ev;
    applyEventRole(ev.id);
    noteRoleForWelcome();
```

with

```js
    // 3. Select event, its role and its plan: the first event whose
    //    organiser's plan has not ended (each event runs on its owner's plan)
    const ev = events.find(e => !planEnded(S.myEvents.get(e.id)));
    if (!ev) {
      showPlanEndedScreen(isMembersOnlyAccount());
      throw new Error('trial_expired');
    }
    S.event = ev;
    applyEventRole(ev.id);
    applyEventPlan(ev.id);
    noteRoleForWelcome();
```

In `switchEvent`, replace

```js
  S.event = ev;
  applyEventRole(eventId);
```

with

```js
  const m = mine.get(eventId);
  if (planEnded(m)) {
    pushToast(t(m.isOwner ? 'cc.ev.planEndedOwner' : 'cc.ev.planEndedAsk'), 'warn');
    return;
  }
  S.event = ev;
  applyEventRole(eventId);
  applyEventPlan(eventId);
```

- [ ] **Step 5: Creating an event uses your own plan.** In `submitEvModal`, replace

```js
    if (evModalMode === 'create') {
      // Plan limit: check active event count
      if (S.planLimits && S.planLimits.events !== 999) {
        const activeCount = S.events.filter(e => e.active).length;
        if (activeCount >= S.planLimits.events) {
          errEl.textContent = `Your ${PLAN_LIMITS[S.subscription?.plan]?.label || ''} plan allows ${S.planLimits.events} active event(s). Upgrade to create more.`;
          saveBtn.disabled = false; return;
        }
      }
```

with

```js
    if (evModalMode === 'create') {
      // Your own plan (event teams §6). A members-only account gets its trial
      // now, with its first own event; events you are only a member of never
      // count toward your limit.
      if (!S.subscription) {
        try { await createTrialSubscription(); await loadSubscription(); }
        catch (e) { errEl.textContent = e?.message || String(e); saveBtn.disabled = false; return; }
      }
      if (ownPlanEnded()) {
        errEl.textContent = t('cc.ev.ownPlanEnded');
        saveBtn.disabled = false; return;
      }
      const own = S.ownPlanLimits || PLAN_LIMITS.trial;
      if (own.events !== 999) {
        const ownCount = S.events.filter(e => e.active && S.myEvents.get(e.id)?.isOwner).length;
        if (ownCount >= own.events) {
          errEl.textContent = `Your ${PLAN_LIMITS[S.subscription?.plan]?.label || ''} plan allows ${own.events} active event(s). Upgrade to create more.`;
          saveBtn.disabled = false; return;
        }
      }
```

`tests/e2e/session-people.spec.ts` SP13 (copying sessions into a new event) set `S.subscription = null` to stand for "no limits"; with this step a missing own plan means "start a trial first", which that spec does not mock. Keep what it protects (a failed session copy says so and keeps the event) by giving the account its own plan: in SP13 replace `S.user = { id: 'u1' }; S.subscription = null; S.planLimits = null;` with `S.user = { id: 'u1' }; S.subscription = { plan: 'pro', status: 'active' }; S.planLimits = null;`.

- [ ] **Step 6: Billing only for an account with its own plan.** In `renderProfilePanel` replace

```js
  // Plan section — directors only
  const planSection = document.getElementById('pp-plan-section');
  planSection.style.display = (role === 'director') ? '' : 'none';

  if (role === 'director' && S.subscription) {
    const sub    = S.subscription;
    const limits = S.planLimits;
```

with

```js
  // Plan section: your own plan; none for a members-only account (event teams §5)
  const planSection = document.getElementById('pp-plan-section');
  planSection.style.display = S.subscription ? '' : 'none';

  if (S.subscription) {
    const sub    = S.subscription;
    const limits = S.ownPlanLimits;
```

replace

```js
    var eventsUsed = sub.plan === 'perevent' ? (sub.events_used || 0) : (S.events || []).length;
```

with

```js
    var eventsUsed = sub.plan === 'perevent' ? (sub.events_used || 0) : (S.events || []).filter(e => S.myEvents.get(e.id)?.isOwner).length;
```

and delete the line

```js
      { label:'Operators', used: S.operatorCount,         max: (limits && limits.operators < 999) ? limits.operators : 0 },
```

(team seats are per event now and are shown in the Team window, Task 3.4).

In `toggleProfileEdit` replace `    if (S.userRole === 'director') {` with `    if (S.subscription) {   // billing details belong to an account with its own plan`. In `saveProfileChanges` replace `  if (S.userRole === 'director') {` with `  if (S.subscription) {`.

- [ ] **Step 7: A members-only screen without prices.** Replace

```html
    <div style="border-top:1px solid var(--border-section);margin:16px 0;padding-top:16px">
      <div style="font-size:12px;color:var(--dim);margin-bottom:8px">Have a code?</div>
      <div style="display:flex;gap:8px;max-width:300px;margin:0 auto">
        <input id="te-promo-code"
```

with

```html
    <div class="te-promo" style="border-top:1px solid var(--border-section);margin:16px 0;padding-top:16px">
      <div style="font-size:12px;color:var(--dim);margin-bottom:8px">Have a code?</div>
      <div style="display:flex;gap:8px;max-width:300px;margin:0 auto">
        <input id="te-promo-code"
```

and after the CSS line `    #trial-expired-screen .te-msg { … }` add:

```css
    /* event teams: a members-only account is told to ask the organiser, without prices */
    #trial-expired-screen.te-member .te-toggle, #trial-expired-screen.te-member .te-plans, #trial-expired-screen.te-member .te-promo { display: none; }
```

- [ ] **Step 8: AI calls name the event.**

`cuedeck-agent-1-incident-advisor.js` and `cuedeck-agent-3-report-generator.js`: in the `functions.invoke('ai-proxy', { body: { … } })` call, replace the last body line `            messages:   [{ role: 'user', content: prompt }]` with

```js
            messages:   [{ role: 'user', content: prompt }],
            event_id:   _opts.getEventId ? _opts.getEventId() : undefined   // AI runs on this event owner's plan
```

`cuedeck-agent-2-cue-engine.js`: after `  let _supabaseClient   = null;` add `  let _getEventId       = null;   // () => current event id (event teams: AI runs on its owner's plan)`; in `init`, after `    _supabaseClient  = options.supabaseClient || null;` add `    _getEventId      = typeof options.getEventId === 'function' ? options.getEventId : null;`; and in its ai-proxy body replace `            messages:   [{ role: 'user', content: prompt }]` with

```js
            messages:   [{ role: 'user', content: prompt }],
            event_id:   _getEventId ? _getEventId() : undefined
```

`cuedeck-console.html`: in both `CueDeckCueEngine.init([], {` calls add a line after the `supabaseClient` line: in boot `        getEventId:         () => S.event?.id,` and in `ensureAgentsInited` `    getEventId:         () => S?.event?.id || null,`.

- [ ] **Step 9: Strings.** In `cuedeck-i18n.js`, after each language's `'cc.ev.roleLoadFailed'` line (Task 3.1):

en:
```js
      'cc.ev.planEndedOwner': 'Your plan for this event has ended. Renew it in Billing.',
      'cc.ev.planEndedAsk': 'The plan for this event has ended. Ask the organiser to renew it.',
      'cc.ev.planEndedTitle': 'This event plan has ended',
      'cc.ev.ownPlanEnded': 'Your plan has ended. Renew it in Billing to create events.',
```
ar:
```js
      'cc.ev.planEndedOwner': 'انتهت خطتك لهذا الحدث. جدّدها من الفوترة.',
      'cc.ev.planEndedAsk': 'انتهت خطة هذا الحدث. اطلب من المنظّم تجديدها.',
      'cc.ev.planEndedTitle': 'انتهت خطة هذا الحدث',
      'cc.ev.ownPlanEnded': 'انتهت خطتك. جدّدها من الفوترة لإنشاء أحداث.',
```
pl:
```js
      'cc.ev.planEndedOwner': 'Twój plan dla tego wydarzenia wygasł. Odnów go w Płatnościach.',
      'cc.ev.planEndedAsk': 'Plan tego wydarzenia wygasł. Poproś organizatora o odnowienie.',
      'cc.ev.planEndedTitle': 'Plan tego wydarzenia wygasł',
      'cc.ev.ownPlanEnded': 'Twój plan wygasł. Odnów go w Płatnościach, aby tworzyć wydarzenia.',
```
de:
```js
      'cc.ev.planEndedOwner': 'Ihr Plan für diese Veranstaltung ist abgelaufen. Verlängern Sie ihn unter Abrechnung.',
      'cc.ev.planEndedAsk': 'Der Plan dieser Veranstaltung ist abgelaufen. Bitten Sie den Veranstalter, ihn zu verlängern.',
      'cc.ev.planEndedTitle': 'Der Plan dieser Veranstaltung ist abgelaufen',
      'cc.ev.ownPlanEnded': 'Ihr Plan ist abgelaufen. Verlängern Sie ihn unter Abrechnung, um Veranstaltungen anzulegen.',
```

- [ ] **Step 10: Run the tests and see them pass.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: 8 passed.

Run: `npx vitest run tests/console-ai-event-id.spec.ts tests/console-i18n-keys.spec.ts tests/console-copy.spec.ts tests/console-colour-ratchet.spec.ts`
Expected: PASS. If the ratchet's "kept tight" test now fails because a literal disappeared, lower `BUDGET` to the printed count.

- [ ] **Step 11: Every console suite** (Stage 3 preamble). Expected: `0 failed`. The default scenario keeps its own Pro plan, so its badge, profile panel and screenshots are unchanged. If a screenshot that opens the profile panel as a non-director role changes (it now shows that account's own plan), check it shows the account's own plan and update that baseline with `--update-snapshots` for that one test only, naming it in the commit message.

- [ ] **Step 12: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add cuedeck-console.html cuedeck-i18n.js cuedeck-agent-1-incident-advisor.js cuedeck-agent-2-cue-engine.js cuedeck-agent-3-report-generator.js tests/e2e/console-event-teams.spec.ts tests/e2e/session-people.spec.ts tests/console-ai-event-id.spec.ts
git commit -m "feat(console): each event runs on its organiser's plan; no trial or billing for members-only accounts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js cuedeck-agent-1-incident-advisor.js cuedeck-agent-2-cue-engine.js cuedeck-agent-3-report-generator.js tests/e2e/console-event-teams.spec.ts tests/e2e/session-people.spec.ts tests/console-ai-event-id.spec.ts
```

### Task 3.3: Event switcher grouped by organiser; invited directors edit, only creators deactivate

Spec §5 and §9.3 (the switcher lists every event the person created or is an active member of, grouped under the organiser's company name: "Your events", "Northwind Events", …), §9.1 (an invited director may edit the event; only the creator may delete it), §6 (anyone may create their own event, on their own plan).

**Files:**
- Modify: `cuedeck-console.html`: `buildEvSelect` (7050-7065), CSS after line 1430, `openEvModal` edit branch (7188), `submitEvModal` edit branch (7257-7261)
- Modify: `cuedeck-i18n.js` (four keys per language)
- Modify: `tests/e2e/console-boot-mock.ts` (a PATCH answers with the row it changed)
- Modify: `tests/e2e/console-event-teams.spec.ts` (four tests)

**Interfaces:**
- Consumes: `S.myEvents` (3.1), `planEnded(m)` (3.2).
- Produces: `evGroups(events): { key: string, label: string, events: object[] }[]` ("Your events" first, then organisers by name); markup `#ev-pill-dd .ev-dd-group` (group heading, only when there is more than one group) and `.ev-dd-note` (the "Plan ended" note on an event).

- [ ] **Step 1: A PATCH in the mock answers with the row it changed** (as PostgREST does with `return=representation`). In `tests/e2e/console-boot-mock.ts`, in the non-GET branch Task 3.1 wrote, replace `        return json(r, [], 201);` with:

```ts
        if (req.method() === 'PATCH') return json(r, [{ id: (url.searchParams.get('id') || '').replace(/^eq\./, '') }]);
        return json(r, [], 201);
```

- [ ] **Step 2: Write the failing tests.** Append to `tests/e2e/console-event-teams.spec.ts`:

```ts
const groupsAndItems = (page: Page) => evalPage(page,
  `[...document.querySelectorAll('#ev-pill-dd > .ev-dd-group, #ev-pill-dd > button[role="menuitemradio"]')]
     .map(el => (el.classList.contains('ev-dd-group') ? '# ' : '') + el.textContent.trim())`);

test('teams: the switcher groups events by organiser', async ({ browser }) => {
  const NORTHWIND = '0e0e0e0e-0000-4000-8000-0000000000a1';
  const ATLAS = '0e0e0e0e-0000-4000-8000-0000000000a2';
  const EV_D = 'd0d0d0d0-0000-4000-8000-0000000000d4';
  const { ctx, page } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit',   role: 'stage',    isOwner: false, ownerId: NORTHWIND, organiser: 'Northwind Events' },
    { id: EV_C, name: 'Atlas awards',    role: 'av',       isOwner: false, ownerId: ATLAS,     organiser: 'Atlas Live' },
    { id: EV_D, name: 'Northwind forum', role: 'director', isOwner: false, ownerId: NORTHWIND, organiser: 'Northwind Events' },
  ] });
  try {
    expect(await groupsAndItems(page)).toEqual([
      '# Your events', 'GTR North Africa 2026',
      '# Atlas Live', 'Atlas awards',
      '# Northwind Events', 'Spring summit', 'Northwind forum',
    ]);
  } finally { await ctx.close(); }
});

test('teams: an organiser with only their own events sees no group headings', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {});
  try {
    expect(await groupsAndItems(page)).toEqual(['GTR North Africa 2026']);
  } finally { await ctx.close(); }
});

test('teams: an invited director edits the event but cannot deactivate it; the creator can', async ({ browser }) => {
  const invited = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  try {
    await evalPage(invited.page, `openEvModal('edit', '${EVENT_ID}'); 0`);
    await expect(invited.page.locator('#evm-deact')).toBeHidden();
    await evalPage(invited.page, `document.getElementById('evm-name').value = 'GTR North Africa 2026 (day 2)'; submitEvModal(); 0`);
    await expect.poll(() => invited.calls.some(c => c.method === 'PATCH' && c.path.startsWith('/rest/v1/leod_events'))).toBe(true);
    await expect(invited.page.locator('#ev-modal')).toBeHidden();
    await expect(invited.page.locator('#ev-pill-dd')).toContainText('Edit event');
  } finally { await invited.ctx.close(); }
  const creator = await openConsole(browser, {});
  try {
    await evalPage(creator.page, `openEvModal('edit', '${EVENT_ID}'); 0`);
    await expect(creator.page.locator('#evm-deact')).toBeVisible();
  } finally { await creator.ctx.close(); }
});

test('teams: a refused event edit says so instead of looking saved; crew see New event, not Edit', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  try {
    await expect(page.locator('#ev-pill-dd')).toContainText('New event');
    await expect(page.locator('#ev-pill-dd')).not.toContainText('Edit event');
    // Row security refuses an update by changing no row and returning no error.
    await page.route(/\/rest\/v1\/leod_events\?/, r => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'access-control-allow-origin': '*' } })
      : r.fallback());
    await evalPage(page, `openEvModal('edit', '${EVENT_ID}'); submitEvModal(); 0`);
    await expect(page.locator('#evm-error')).toHaveText('Only the directors of this event can edit it.');
    await expect(page.locator('#ev-modal')).toBeVisible();
  } finally { await ctx.close(); }
});
```

- [ ] **Step 3: Run them and see them fail.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: the four new tests fail (no `.ev-dd-group`; `#evm-deact` visible for the invited director; crew get no New event; the refused edit closes the modal as if saved). The earlier eight pass.

- [ ] **Step 4: Group the switcher.** Replace the whole `buildEvSelect` function with:

```js
// Events grouped by organiser (event teams §5, §9.3): "Your events" first,
// then each organiser by company name. With one group there are no headings,
// so an organiser with only their own events sees the switcher as before.
function evGroups(events) {
  const groups = new Map();
  for (const e of events) {
    const m = S.myEvents.get(e.id);
    const key = !m || m.isOwner ? '' : (m.ownerId || '');
    if (!groups.has(key)) {
      groups.set(key, { key, label: key ? (m.organiser || t('cc.ev.otherOrganiser')) : t('cc.ev.yourEvents'), events: [] });
    }
    groups.get(key).events.push(e);
  }
  return [...groups.values()].sort((a, b) => a.key === '' ? -1 : b.key === '' ? 1 : a.label.localeCompare(b.label));
}

function buildEvSelect(events) {
  const cur = S.event;
  const nameEl = document.getElementById('event-name');
  if (cur && nameEl) nameEl.textContent = cur.name;
  const subEl = document.getElementById('event-sub');
  if (subEl) subEl.textContent = cur ? eventSubline(cur) : '';
  const dd = document.getElementById('ev-pill-dd');
  if (!dd) return;
  const isDirector = S.userRole === 'director' || S.role === 'director';
  const item = e => `<button type="button" role="menuitemradio" aria-checked="${e.id === cur?.id}" class="${e.id === cur?.id ? 'active' : ''}" onclick="event.stopPropagation();switchEvent('${e.id}');closeEvDropdown()">${esc(e.name)}${planEnded(S.myEvents.get(e.id)) ? `<span class="ev-dd-note">${esc(t('cc.ev.planEndedShort'))}</span>` : ''}</button>`;
  const groups = evGroups(events);
  const list = groups.length > 1
    ? groups.map(g => `<div class="ev-dd-group" role="presentation">${esc(g.label)}</div>` + g.events.map(item).join('')).join('')
    : events.map(item).join('');
  // Editing is for this event's directors (§9.1); anyone may create their own
  // event, on their own plan (§6).
  dd.innerHTML = list
    + `<div class="hd-sep"></div>`
    + (cur && isDirector ? `<button type="button" role="menuitem" onclick="event.stopPropagation();closeEvDropdown();openEvModal('edit','${cur.id}')">${icon('edit')}${esc(t('cc.hdr.editEvent'))}</button>` : '')
    + `<button type="button" role="menuitem" class="ev-add-btn${events.length ? '' : ' rbtn-pulse'}" onclick="event.stopPropagation();closeEvDropdown();openEvModal('create')">${icon('plus')}${esc(t('cc.hdr.newEvent'))}</button>`;
  // Onboarding: with no event yet, the switcher itself pulses so "New event" is found.
  document.getElementById('ev-switch')?.classList.toggle('rbtn-pulse', isDirector && !events.length);
}
```

After the CSS line `    .hdr-menu button:hover, .ev-pill-dd button:hover, … { … }` (line 1430) add:

```css
    .ev-dd-group { padding: 8px 10px 4px; font: 600 var(--fs-11) var(--font-sans); letter-spacing: .06em; text-transform: uppercase; color: var(--text-tertiary); }
    .ev-dd-note { margin-inline-start: auto; font-size: var(--fs-11); color: var(--text-tertiary); }
```

- [ ] **Step 5: Only the creator deactivates; a refused edit says so.** In `openEvModal`'s edit branch replace

```js
    document.getElementById('evm-deact').style.display = '';
```

with

```js
    // Only the creator deactivates (deletes) an event (event teams §9.1).
    document.getElementById('evm-deact').style.display = S.myEvents.get(eventId)?.isOwner ? '' : 'none';
```

In `submitEvModal`'s edit branch replace

```js
      const { error } = await sb.from('leod_events')
        .update({ name, date, timezone: tz, event_start: start, event_end: end,
                  venue: venue || null })
        .eq('id', evModalId);
      if (error) { errEl.textContent = error.message; return; }
```

with

```js
      // .select: row security refuses an update by changing no row, without
      // an error; without this a refused edit looked saved.
      const { data: saved, error } = await sb.from('leod_events')
        .update({ name, date, timezone: tz, event_start: start, event_end: end,
                  venue: venue || null })
        .eq('id', evModalId)
        .select('id');
      if (error) { errEl.textContent = error.message; return; }
      if (!saved?.length) { errEl.textContent = t('cc.ev.editRefused'); return; }
```

- [ ] **Step 6: Strings.** In `cuedeck-i18n.js`, after each language's `'cc.ev.ownPlanEnded'` line (Task 3.2):

en:
```js
      'cc.ev.yourEvents': 'Your events',
      'cc.ev.otherOrganiser': 'Other organiser',
      'cc.ev.planEndedShort': 'Plan ended',
      'cc.ev.editRefused': 'Only the directors of this event can edit it.',
```
ar:
```js
      'cc.ev.yourEvents': 'أحداثك',
      'cc.ev.otherOrganiser': 'منظّم آخر',
      'cc.ev.planEndedShort': 'انتهت الخطة',
      'cc.ev.editRefused': 'لا يعدّل هذا الحدث إلا مديروه.',
```
pl:
```js
      'cc.ev.yourEvents': 'Twoje wydarzenia',
      'cc.ev.otherOrganiser': 'Inny organizator',
      'cc.ev.planEndedShort': 'Plan wygasł',
      'cc.ev.editRefused': 'Tylko reżyserzy tego wydarzenia mogą je edytować.',
```
de:
```js
      'cc.ev.yourEvents': 'Ihre Veranstaltungen',
      'cc.ev.otherOrganiser': 'Anderer Veranstalter',
      'cc.ev.planEndedShort': 'Plan abgelaufen',
      'cc.ev.editRefused': 'Nur die Regie dieser Veranstaltung kann sie bearbeiten.',
```

- [ ] **Step 7: Run the tests and see them pass.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts --global-timeout=600000`
Expected: 12 passed.

Run: `npx vitest run tests/console-i18n-keys.spec.ts tests/console-copy.spec.ts tests/console-colour-ratchet.spec.ts tests/console-no-emoji-icons.spec.ts`
Expected: PASS.

- [ ] **Step 8: Every console suite** (Stage 3 preamble). Expected: `0 failed`. The default (director, own event) switcher markup is unchanged. A crew-role scenario now shows "New event" in the open switcher: if a committed screenshot shows the open switcher for a non-director role, confirm the only difference is the separator and "New event", update that baseline alone with `--update-snapshots`, and name it in the commit message.

- [ ] **Step 9: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-event-teams.spec.ts
git commit -m "feat(console): event switcher grouped by organiser; invited directors edit, only creators deactivate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-event-teams.spec.ts
```

### Task 3.4: The Team window, per event

Spec §4 (invite new and existing accounts from inside an event; change role, suspend and remove act on this event only; remove never touches the login; "remove from all my events"), §5 (the Team window shows the current event's members with role, status and last seen, replacing the account-wide list), §6 (the Team window shows "Team 7 of 20 seats"; when full, inviting is refused with "Upgrade for more seats" for the owner and "Ask the organiser for more seats" for an invited director), §3 guard (no code path reads `invited_by`). Inventory §10 side note: the setup wizard's invite ignored its `{ error }`; its contract changes here (seats, roles), so it now reads it.

**Files:**
- Modify: `cuedeck-console.html`: CSS lines 319-344 (users modal and badge), menu button `#users-btn` (2325), the users modal markup (2587-2618), state `S` (`operatorCount`, line 2967), the Team functions (8186-8338: `openUsersModal` through `confirmRemoveUser`), `inviteOperator` and `loadPendingBadge` (8411-8490), the setup wizard invite (9650-9658)
- Modify: `cuedeck-i18n.js` (43 `cc.team.*` keys per language)
- Modify: `tests/e2e/console-boot-mock.ts` (`team` scenario field, `cuedeck_event_team` answer)
- Modify: `tests/e2e/console-event-teams.spec.ts` (six tests)
- Modify: `tests/e2e/console-forbidden.spec.ts:211-235` (the three role and remove tests call the new function)
- Modify: `tests/console-colour-ratchet.spec.ts` (`BUDGET` down)
- Create: `tests/event-teams-no-invited-by.spec.ts`

**Interfaces:**
- Consumes: RPC `cuedeck_event_team(p_event_id)` → `{ is_owner, seats: { used, limit }, owner: { user_id, name, email, last_sign_in_at }, members: [{ user_id, name, email, role, active, last_sign_in_at, added_at }] }` (Task 2.1); `invite-operator` and `manage-operator` contracts (Task 2.3); `applyEventRole` shows `#users-btn` for directors (Task 3.1).
- Produces (console): `openUsersModal()`, `closeUsersModal()`, `refreshUsersModal()`, `renderTeam(data)`, `manageMember(userId: string, action: 'suspend'|'reactivate'|'remove'|'set_role', role: string|null, all: boolean)`, `armRemoveMember(userId: string, all: boolean)`, `inviteOperator()`, `inviteErrorText(body, error): string`, `setTeamStatus(text, isError)`, `TEAM_ROLES`, `_teamData`, `_operatorsData` (array of `{ id, name }`, still read by `bcSenderName`). Removed: `renderOperatorRows`, `filterOperators`, `approveUser`, `manageOperator`, `confirmRemoveUser`, `loadPendingBadge`, `S.operatorCount`, `#users-badge`.

- [ ] **Step 1: The mock answers the team RPC.** In `tests/e2e/console-boot-mock.ts`, add to `interface Scenario`:

```ts
  team?: Record<string, unknown>;   // cuedeck_event_team answer per event id (default: defaultTeam)
```

after the `Call` interface add:

```ts
export const defaultTeam = () => ({
  is_owner: true, seats: { used: 2, limit: 20 },
  owner: { user_id: USER_ID, name: 'Nour Selim', email: 'nour@example.com', last_sign_in_at: iso(0) },
  members: [
    { user_id: 'op-1', name: 'Ahmed Fawzy', email: 'ahmed@example.com', role: 'stage', active: true,  last_sign_in_at: iso(-5), added_at: '2026-09-02T09:00:00Z' },
    { user_id: 'op-2', name: 'Mona Adel',   email: 'mona@example.com',  role: 'av',    active: false, last_sign_in_at: null,     added_at: '2026-09-03T09:00:00Z' },
  ],
});
```

and next to the other RPC answers:

```ts
      if (fn === 'cuedeck_event_team') {
        const ev = (() => { try { return JSON.parse(req.postData() || '{}').p_event_id; } catch { return null; } })();
        return json(r, (sc.team as Record<string, unknown> | undefined)?.[ev] ?? defaultTeam());
      }
```

- [ ] **Step 2: Write the failing tests.** Append to `tests/e2e/console-event-teams.spec.ts` (and add `defaultTeam` to the import from `./console-boot-mock`):

```ts
const openTeam = async (page: Page) => {
  await evalPage(page, 'openUsersModal(); 0');
  await expect(page.locator('#team-seats')).not.toBeEmpty();
};
const member = (k: number, o: Record<string, unknown> = {}) => ({ user_id: `op-${k}`, name: `Crew ${k}`, email: `crew${k}@example.com`,
  role: 'av', active: true, last_sign_in_at: null, added_at: `2026-09-0${k}T09:00:00Z`, ...o });
const inviteReply = (fn: string, body: any) => fn === 'invite-operator'
  ? { status: 200, body: { ok: true, user_id: 'op-9', role: body.role, result: String(body.email).startsWith('new') ? 'invited' : 'added' } }
  : undefined;

test("team: the window shows this event's team, its seats and who organises it", async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {});
  try {
    await openTeam(page);
    await expect(page.locator('#users-modal-title')).toHaveText('Team for GTR North Africa 2026');
    await expect(page.locator('#team-seats')).toHaveText('Team 2 of 20 seats');
    await expect(page.locator('#users-modal-body .team-row')).toHaveCount(3);
    await expect(page.locator('#users-modal-body .team-row').first()).toContainText('Organiser');
    await expect(page.locator('.team-row[data-uid="op-2"]')).toHaveClass(/is-suspended/);
    await expect(page.locator('[data-fk="team-removeall-op-1"]')).toBeVisible();   // the creator may remove from all
    await expect(page.locator('#inv-btn')).toBeEnabled();
  } finally { await ctx.close(); }
});

test('team: inviting an existing account says it was added; a new email is invited; both name this event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, { fnReply: inviteReply });
  try {
    await openTeam(page);
    await page.fill('#inv-email', 'karim@example.com');
    await page.selectOption('#inv-role', 'av');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('karim@example.com was added to this event.');
    await page.fill('#inv-email', 'new.crew@example.com');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('Invitation sent to new.crew@example.com.');
    const sent = calls.filter(c => c.path === '/functions/v1/invite-operator').map(c => c.body);
    expect(sent).toEqual([
      expect.objectContaining({ email: 'karim@example.com', role: 'av', event_id: EVENT_ID }),
      expect.objectContaining({ email: 'new.crew@example.com', event_id: EVENT_ID }),
    ]);
  } finally { await ctx.close(); }
});

test('team: a full team asks the owner to upgrade, and an invited director to ask the organiser', async ({ browser }) => {
  const full = { is_owner: true, seats: { used: 5, limit: 5 }, owner: defaultTeam().owner, members: [1, 2, 3, 4, 5].map(k => member(k)) };
  const owner = await openConsole(browser, { team: { [EVENT_ID]: full } });
  try {
    await openTeam(owner.page);
    await expect(owner.page.locator('#team-full')).toHaveText('All seats are taken. Upgrade for more seats.');
    await expect(owner.page.locator('#inv-btn')).toBeDisabled();
  } finally { await owner.ctx.close(); }
  const invited = await openConsole(browser, {
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER }],
    team: { [EVENT_ID]: { ...full, is_owner: false } },
  });
  try {
    await openTeam(invited.page);
    await expect(invited.page.locator('#team-full')).toHaveText('All seats are taken. Ask the organiser for more seats.');
    await expect(invited.page.locator('[data-fk="team-removeall-op-1"]')).toHaveCount(0);   // only the creator removes from all
  } finally { await invited.ctx.close(); }
  // The server refuses a seat the window thought was free (another director took it).
  const raced = await openConsole(browser, {
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER }],
    fnReply: (fn) => fn === 'invite-operator' ? { status: 409, body: { error: 'All seats on this event are taken', code: 'seats_full', is_owner: false } } : undefined,
  });
  try {
    await openTeam(raced.page);
    await raced.page.fill('#inv-email', 'late@example.com');
    await raced.page.locator('#inv-btn').click();
    await expect(raced.page.locator('#inv-status')).toHaveText('All seats are taken. Ask the organiser for more seats.');
  } finally { await raced.ctx.close(); }
});

test('team: over the seat count after a downgrade', async ({ browser }) => {
  const over = { is_owner: true, seats: { used: 7, limit: 5 }, owner: defaultTeam().owner, members: [1, 2, 3, 4, 5, 6, 7].map(k => member(k)) };
  const { ctx, page, calls } = await openConsole(browser, { team: { [EVENT_ID]: over } });
  try {
    await openTeam(page);
    await expect(page.locator('#team-seats')).toHaveText('Team 7 of 5 seats');
    await expect(page.locator('#inv-btn')).toBeDisabled();
    await expect(page.locator('#users-modal-body .team-row')).toHaveCount(8);   // nobody was cut off
    await expect(page.locator('[data-fk="team-role-op-3"]')).toBeEnabled();
    await page.locator('[data-fk="team-suspend-op-3"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-3', action: 'suspend', event_id: EVENT_ID }]);
  } finally { await ctx.close(); }
});

test('team: remove takes two presses and names this event only; the person stays on the other event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: true },
  ] });
  try {
    await afterBootReread(page);
    await openTeam(page);
    await page.locator('[data-fk="team-remove-op-1"]').click();
    await expect(page.locator('[data-fk="team-remove-op-1"]')).toHaveText('Press again to remove');
    expect(calls.filter(c => c.path === '/functions/v1/manage-operator')).toEqual([]);
    await page.locator('[data-fk="team-remove-op-1"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-1', action: 'remove', event_id: EVENT_ID }]);
    await expect(toasts(page)).toContainText('Ahmed Fawzy was removed from this event.');
    await evalPage(page, 'closeUsersModal(); 0');
    await switchTo(page, EV_B);
    await openTeam(page);
    await expect(page.locator('.team-row[data-uid="op-1"]')).toHaveCount(1);
    await expect(page.locator('#users-modal-title')).toHaveText('Team for Spring summit');
  } finally { await ctx.close(); }
});

test('team: remove from all my events is the creator\'s, takes two presses and sends no event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, {});
  try {
    await openTeam(page);
    await page.locator('[data-fk="team-removeall-op-1"]').click();
    await expect(page.locator('[data-fk="team-removeall-op-1"]')).toHaveText('Press again to remove from all');
    await page.locator('[data-fk="team-removeall-op-1"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-1', action: 'remove' }]);
    await expect(toasts(page)).toContainText('Ahmed Fawzy was removed from all your events.');
  } finally { await ctx.close(); }
});
```

In `tests/e2e/console-forbidden.spec.ts` replace the three tests `changing a role goes through manage-operator, not a direct write`, `a refused role change says why and does not claim success` and `a failed remove shows the server reason (e.g. the ban failed)` with:

```ts
test('changing a role goes through manage-operator for this event, not a direct write', async ({ page }) => {
  const calls = await setup(page, 200, { ok: true, action: 'set_role', role: 'av', events: ['ev-1'] });
  await evalPage(page, `S.user = { id: 'user-1' }; manageMember('u-2', 'set_role', 'av', false)`);
  await expect(toasts(page)).toContainText('Role changed to AV.');
  const c = calls.filter(x => x.fn === 'manage-operator');
  expect(c).toHaveLength(1);
  expect(c[0].body).toMatchObject({ action: 'set_role', user_id: 'u-2', role: 'av', event_id: 'ev-1' });
  expect(rest.filter(r => r.method === 'PATCH' && (r.url.includes('leod_users') || r.url.includes('leod_event_members')))).toEqual([]);
});

test('a refused role change says why and does not claim success', async ({ page }) => {
  await setup(page, 403, { error: 'Forbidden: only the directors of this event can change its team' });
  await evalPage(page, `manageMember('u-2', 'set_role', 'av', false)`);
  await expect(toasts(page)).toContainText('only the directors of this event');
  await expect(toasts(page)).not.toContainText('Role changed');
});

test('a failed remove shows the server reason and does not claim success', async ({ page }) => {
  await setup(page, 500, { error: 'Changed on 1 events, then failed: boom' });
  await evalPage(page, `manageMember('u-2', 'remove', null, true)`);
  await expect(toasts(page)).toContainText('then failed: boom');
  await expect(toasts(page)).not.toContainText('was removed');
});
```

Create `tests/event-teams-no-invited-by.spec.ts`:

```ts
// tests/event-teams-no-invited-by.spec.ts
// Event teams (spec 2026-10-08 §3, §7): access never comes from
// leod_users.invited_by. The database side is cuedeck_guard_results()
// (migration 132); this is the code side: no Edge Function, console page or
// agent reads it. The one line left is the membership row's own "added by"
// column, written by invite-operator. Comment lines are not code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const SOURCES = [
  ...walk(join(ROOT, 'supabase/functions')).filter(f => f.endsWith('.ts')),
  ...readdirSync(ROOT).filter(f => /^cuedeck-.*\.(html|js)$/.test(f)).map(f => join(ROOT, f)),
];
const ALLOWED: Record<string, RegExp> = {
  'supabase/functions/invite-operator/index.ts': /invited_by: user\.id/,
};
const COMMENT = /^\s*(\/\/|\*|\/\*|<!--|--)/;

describe('no code path reads leod_users.invited_by', () => {
  it('scans the Edge Functions and every console page', () => {
    expect(SOURCES.filter(f => f.endsWith('.ts')).length).toBeGreaterThan(30);
    expect(SOURCES.some(f => f.endsWith('cuedeck-console.html'))).toBe(true);
  });
  it('only the membership write in invite-operator names invited_by', () => {
    const bad: string[] = [];
    for (const f of SOURCES) {
      const rel = relative(ROOT, f);
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('invited_by') || COMMENT.test(line)) return;
        if (ALLOWED[rel]?.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them and see them fail.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-forbidden.spec.ts --global-timeout=900000`
Expected: the six new team tests fail (`#team-seats` does not exist; the window lists `get_operators_with_last_seen`), and the three forbidden tests fail with `manageMember is not defined`.

Run: `npx vitest run tests/event-teams-no-invited-by.spec.ts`
Expected: FAIL listing `cuedeck-console.html:<line>: .select('id', { count: 'exact', head: true })….eq('invited_by', S.user.id);` (the old operator count and pending badge).

- [ ] **Step 4: The Team window markup.** In `cuedeck-console.html`:

In the menu button `#users-btn` (line 2325) delete `<span id="users-badge"></span>` (the pending badge counted `leod_users.invited_by`; there is no pending state on a team now).

Replace the whole block from `<!-- USERS MODAL -->` to the `</div>` that closes `#users-modal` (just before `<!-- WELCOME MODAL`) with:

```html
<!-- TEAM: one event's team (event teams, spec 2026-10-08 §4, §5). openUsersModal sets every text. -->
<div id="users-modal" class="ev-modal-backdrop" style="display:none" onclick="if(event.target===this)closeUsersModal()">
  <div class="ev-modal-card team-card" role="dialog" aria-modal="true" aria-labelledby="users-modal-title">
    <div class="ev-modal-title" id="users-modal-title">Team</div>
    <div id="team-seats" class="team-seats" aria-live="polite"></div>
    <div id="team-full" class="team-status is-error" role="status" hidden></div>
    <div id="invite-section" class="team-invite">
      <div class="lbl" id="team-invite-lbl">Invite to this event</div>
      <div class="team-invite-row">
        <input id="inv-email" type="email" autocomplete="off" data-fk="team-inv-email">
        <input id="inv-name" type="text" autocomplete="off" data-fk="team-inv-name">
        <select id="inv-role" data-fk="team-inv-role">
          <option value="stage">Stage</option><option value="av">AV</option><option value="interp">Interp</option>
          <option value="reg">Reg</option><option value="signage">Signage</option><option value="director">Director</option>
        </select>
        <button type="button" id="inv-btn" class="btn sm primary" data-fk="team-inv-send" onclick="if(pressOk(event,this))inviteOperator()">Send invite</button>
      </div>
      <div id="inv-status" class="team-status" role="status"></div>
    </div>
    <input id="um-search" type="search" autocomplete="off" data-fk="team-search" oninput="renderTeam(_teamData)">
    <div id="users-modal-body"><div class="um-empty"></div></div>
    <div class="ev-modal-actions">
      <button type="button" id="team-close" onclick="closeUsersModal()">Close</button>
    </div>
  </div>
</div>
```

Replace the CSS from `    /* ── USERS MODAL ── */` through the end of the `#users-badge { … }` rule (lines 319-344) with:

```css
    /* ── TEAM: one event's team ── */
    .team-card { max-width: 560px; }
    .team-seats { font-size: var(--fs-13); color: var(--text-secondary); margin-bottom: var(--sp-2); }
    .team-seats.is-full { color: var(--danger-fg); }
    .team-invite { border-bottom: 1px solid var(--border-section); padding-bottom: var(--sp-3); margin-bottom: var(--sp-2); }
    .team-invite-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin-top: var(--sp-2); }
    .team-invite-row input[type="email"] { flex: 1; min-width: 160px; }
    .team-invite-row input[type="text"] { width: 140px; }
    .team-status { font-size: var(--fs-12); min-height: 18px; margin-top: var(--sp-1); color: var(--text-secondary); }
    .team-status.is-error { color: var(--danger-fg); }
    #um-search { width: 100%; margin: var(--sp-2) 0; }
    .team-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-divider); }
    .team-row:last-child { border-bottom: none; }
    .team-row.is-suspended .team-who { opacity: .6; }
    .team-who { flex: 1; min-width: 160px; }
    .team-name { font-size: var(--fs-13); color: var(--text-primary); }
    .team-meta { font-size: var(--fs-11); color: var(--text-tertiary); }
    .team-acts { display: flex; flex-wrap: wrap; gap: var(--sp-1); align-items: center; }
    .um-empty { font-size: var(--fs-12); color: var(--dim); text-align: center; padding: 12px 0; }
    @media (pointer: coarse) { #users-modal input, #users-modal select { min-height: 44px; } }
```

In `S`, delete the line `  operatorCount:   0,      // total non-pending leod_users; cached by loadPendingBadge`.

- [ ] **Step 5: The Team window code.** Replace everything from the line `// ── Users / approval modal (director only) ─────────────────` through the closing `}` of `function confirmRemoveUser(userId, displayName) { … }` with:

```js
// ── Team, per event (event teams, spec 2026-10-08 §4, §5) ────────────────
// The current event's team only: its organiser, every member with role,
// status and last seen, and the seats left on the organiser's plan
// ("Team 7 of 20 seats"). Invites and changes go through invite-operator and
// manage-operator with this event's id; Remove takes the person off this
// event only, and their login and other events stay. "Remove from all my
// events" (the creator's) sends no event id, so the server covers every
// event the caller created.
var _operatorsData = [];        // { id, name } of this event's team, read by bcSenderName
var _teamData = null;           // the last cuedeck_event_team answer
const TEAM_ROLES = ['stage', 'av', 'interp', 'reg', 'signage', 'director'];
const _memberRemovePending = new Map();   // 'userId:one' | 'userId:all' → timer (two presses, as Reset key)

async function openUsersModal() {
  if (!S.event) return;
  document.getElementById('users-modal').style.display = 'flex';
  document.getElementById('users-modal-title').textContent = tf('cc.team.title', { event: S.event.name });
  document.getElementById('team-invite-lbl').textContent = t('cc.team.invite');
  const em = document.getElementById('inv-email');
  em.placeholder = t('cc.team.email'); em.setAttribute('aria-label', t('cc.team.email'));
  const nm = document.getElementById('inv-name');
  nm.placeholder = t('cc.team.name'); nm.setAttribute('aria-label', t('cc.team.name'));
  const rs = document.getElementById('inv-role');
  rs.setAttribute('aria-label', t('cc.team.role'));
  rs.innerHTML = TEAM_ROLES.map(r => `<option value="${r}">${esc(t('role.' + r))}</option>`).join('');
  document.getElementById('inv-btn').textContent = t('cc.team.send');
  const q = document.getElementById('um-search');
  q.placeholder = t('cc.team.search'); q.setAttribute('aria-label', t('cc.team.search')); q.value = '';
  document.getElementById('team-close').textContent = t('cc.team.close');
  setTeamStatus('', false);
  document.getElementById('users-modal-body').innerHTML = `<div class="um-empty">${esc(t('cc.team.loading'))}</div>`;
  await refreshUsersModal();
}
function closeUsersModal() {
  document.getElementById('users-modal').style.display = 'none';
}
function setTeamStatus(text, isError) {
  const el = document.getElementById('inv-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
}

async function refreshUsersModal() {
  const ev = S.event;
  const body = document.getElementById('users-modal-body');
  if (!ev || !body) return;
  const { data, error } = await sb.rpc('cuedeck_event_team', { p_event_id: ev.id });
  if (S.event?.id !== ev.id) return;   // switched away meanwhile
  if (error || !data || !Array.isArray(data.members)) {
    _teamData = null;
    body.innerHTML = `<div class="um-empty">${esc(t('cc.team.loadFailed'))}</div>`;
    return;
  }
  _teamData = data;
  _operatorsData = [data.owner, ...data.members].filter(Boolean).map(m => ({ id: m.user_id, name: m.name || '' }));
  renderTeam(data);
}

function renderTeam(data) {
  const body = document.getElementById('users-modal-body');
  if (!body || !data) return;
  const fk = focusKey();
  const seats = data.seats || { used: data.members.length, limit: null };
  const full = seats.limit !== null && seats.limit !== undefined && seats.used >= seats.limit;
  const seatsEl = document.getElementById('team-seats');
  seatsEl.textContent = seats.limit === null || seats.limit === undefined
    ? tf('cc.team.seatsUnlimited', { used: seats.used })
    : tf('cc.team.seats', { used: seats.used, limit: seats.limit });
  seatsEl.classList.toggle('is-full', full);
  const fullEl = document.getElementById('team-full');
  fullEl.hidden = !full;
  fullEl.textContent = full ? t(data.is_owner ? 'cc.team.fullOwner' : 'cc.team.fullAsk') : '';
  document.getElementById('inv-btn').disabled = full;

  const q = (document.getElementById('um-search')?.value || '').trim().toLowerCase();
  const match = m => !q || (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q);
  const rel = new Intl.RelativeTimeFormat(CueDeckI18n.getLocale(), { numeric: 'auto' });
  const seen = ts => {
    if (!ts) return t('cc.team.never');
    const mins = Math.round((Date.parse(ts) - Date.now()) / 60000);
    if (Math.abs(mins) < 60) return rel.format(mins, 'minute');
    if (Math.abs(mins) < 1440) return rel.format(Math.round(mins / 60), 'hour');
    return rel.format(Math.round(mins / 1440), 'day');
  };
  const o = data.owner;
  const ownerRow = o && match(o)
    ? `<div class="team-row" data-uid="${esc(o.user_id)}"><div class="team-who">`
      + `<div class="team-name">${esc(o.name || o.email || '–')}</div>`
      + `<div class="team-meta">${esc(t('cc.team.owner'))} · ${esc(t('role.director'))} · ${esc(tf('cc.team.lastSeen', { when: seen(o.last_sign_in_at) }))}</div>`
      + `</div></div>`
    : '';
  const rows = data.members.filter(match).map(m => {
    const id = esc(m.user_id);
    const self = m.user_id === S.user?.id;
    const armed = _memberRemovePending.has(m.user_id + ':one');
    const armedAll = _memberRemovePending.has(m.user_id + ':all');
    const opts = TEAM_ROLES.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${esc(t('role.' + r))}</option>`).join('');
    const acts = self ? '' :
      `<select class="team-role" data-fk="team-role-${id}" aria-label="${esc(t('cc.team.role'))}" onchange="manageMember('${id}','set_role',this.value,false)">${opts}</select>`
      + (m.active
        ? `<button type="button" class="btn sm" data-fk="team-suspend-${id}" onclick="if(pressOk(event,this))manageMember('${id}','suspend',null,false)">${icon('pause')}${esc(t('cc.team.suspend'))}</button>`
        : `<button type="button" class="btn sm" data-fk="team-reactivate-${id}" onclick="if(pressOk(event,this))manageMember('${id}','reactivate',null,false)">${icon('play')}${esc(t('cc.team.reactivate'))}</button>`)
      + `<button type="button" class="btn sm danger${armed ? ' confirm-pending' : ''}" data-fk="team-remove-${id}" onclick="if(pressOk(event,this))armRemoveMember('${id}',false)">${armed ? '' : icon('trash')}${esc(t(armed ? 'cc.team.removeConfirm' : 'cc.team.remove'))}</button>`
      + (data.is_owner
        ? `<button type="button" class="btn sm ghost danger${armedAll ? ' confirm-pending' : ''}" data-fk="team-removeall-${id}" onclick="if(pressOk(event,this))armRemoveMember('${id}',true)">${esc(t(armedAll ? 'cc.team.removeAllConfirm' : 'cc.team.removeAll'))}</button>`
        : '');
    const status = m.active ? t('cc.team.active') : t('cc.team.suspended');
    return `<div class="team-row${m.active ? '' : ' is-suspended'}" data-uid="${id}"><div class="team-who">`
      + `<div class="team-name">${esc(m.name || m.email || '–')}</div>`
      + `<div class="team-meta">${esc(t('role.' + m.role))} · ${esc(status)} · ${esc(m.email || '')} · ${esc(tf('cc.team.lastSeen', { when: seen(m.last_sign_in_at) }))}</div>`
      + `</div><div class="team-acts">${acts}</div></div>`;
  }).join('');
  body.innerHTML = ownerRow + (rows || (data.members.length ? '' : `<div class="um-empty">${esc(t('cc.team.empty'))}</div>`));
  restoreFocus(fk);
}

// Remove takes two presses, as Reset key: the first arms the button for 3 s.
function armRemoveMember(userId, all) {
  const key = userId + (all ? ':all' : ':one');
  if (_memberRemovePending.has(key)) {
    clearTimeout(_memberRemovePending.get(key));
    _memberRemovePending.delete(key);
    renderTeam(_teamData);
    manageMember(userId, 'remove', null, all);
    return;
  }
  _memberRemovePending.set(key, setTimeout(() => { _memberRemovePending.delete(key); renderTeam(_teamData); }, 3000));
  announce(t(all ? 'cc.team.removeAllConfirm' : 'cc.team.removeConfirm'));
  renderTeam(_teamData);
}

// One membership change through manage-operator (service role, event-scoped).
// functions.invoke never throws: the error is read, and nothing claims success
// unless the server said so.
async function manageMember(userId, action, role, all) {
  const ev = S.event;
  if (!ev) return;
  const name = (_teamData?.members || []).find(m => m.user_id === userId)?.name || t('cc.team.member');
  const body = { user_id: userId, action };
  if (role) body.role = role;
  if (!all) body.event_id = ev.id;
  const { error } = await sb.functions.invoke('manage-operator', { body });
  if (error) {
    let why = error.message || 'Unknown error';
    try { const b = await error.context?.json?.(); if (b?.error) why = b.error; } catch (_) { /* no body */ }
    pushToast(tf('cc.team.actionFailed', { reason: why }), 'error');
    await refreshUsersModal();
    return;
  }
  if (action === 'remove') pushToast(tf(all ? 'cc.team.removedAll' : 'cc.team.removed', { name }), 'success');
  else if (action === 'set_role') pushToast(tf('cc.team.roleChanged', { role: t('role.' + role) }), 'success');
  else pushToast(t(action === 'suspend' ? 'cc.team.suspendedToast' : 'cc.team.reactivatedToast'), 'success');
  await refreshUsersModal();
}
```

Replace everything from `async function inviteOperator() {` through the closing `}` of `async function loadPendingBadge() { … }` with:

```js
async function inviteOperator() {
  const ev = S.event;
  if (!ev) return;
  const email = document.getElementById('inv-email').value.trim();
  const name  = document.getElementById('inv-name').value.trim();
  const role  = document.getElementById('inv-role').value;
  const btn   = document.getElementById('inv-btn');
  if (!email) { setTeamStatus(t('cc.team.emailRequired'), true); return; }

  btn.disabled = true;
  btn.textContent = t('cc.team.sending');
  setTeamStatus('', false);
  try {
    // Seats are checked by the server (invite-operator and the membership
    // insert), not counted here: the browser cannot see another director's invite.
    const { data, error } = await sb.functions.invoke('invite-operator', {
      body: { email, role, name: name || undefined, event_id: ev.id },
    });
    if (error) {
      let b = null;
      try { b = typeof error.context?.json === 'function' ? await error.context.json() : null; } catch (_) { /* no body */ }
      setTeamStatus(inviteErrorText(b, error), true);
    } else {
      const key = { invited: 'cc.team.invited', added: 'cc.team.added', link_resent: 'cc.team.linkResent',
                    unchanged: 'cc.team.unchanged', role_changed: 'cc.team.roleChanged' }[data?.result] || 'cc.team.invited';
      setTeamStatus(tf(key, { email, role: t('role.' + role) }), false);
      document.getElementById('inv-email').value = '';
      document.getElementById('inv-name').value = '';
      // Onboarding: mark invite step done
      const uid = S.user?.id || 'anon';
      localStorage.setItem(CK_KEY + uid + '_invited', '1');
      if (typeof refreshChecklist === 'function') refreshChecklist();
    }
  } catch (_) {
    setTeamStatus(t('cc.team.network'), true);
  }
  btn.textContent = t('cc.team.send');
  await refreshUsersModal();   // also re-enables the button unless the team is full
}

// The server's refusal of an invite, in words (Team window and setup wizard).
function inviteErrorText(b, error) {
  if (b?.code === 'seats_full') return t(b.is_owner ? 'cc.team.fullOwner' : 'cc.team.fullAsk');
  if (b?.code === 'is_owner') return t('cc.team.isOwner');
  if (b?.code === 'invite_rate') return t('cc.team.rate');
  return tf('cc.team.failed', { reason: b?.error || error?.message || '' });
}
```

(`refreshUsersModal` → `renderTeam` sets `#inv-btn.disabled` from the seats; when the team read fails, the button stays disabled, which is safe. The role options stay in the markup because `tests/e2e/auth-flows.spec.ts` test 36 reads them before any sign-in; `openUsersModal` only relabels them in the current language. `console-components.spec.ts` (inputs of `openUsersModal()`) and `console-header.spec.ts` (`#users-btn` visible for a director) keep passing unchanged.)

In the setup wizard (step 2) replace

```js
        try {
          await sb.functions.invoke('invite-operator', { body: { email, name, role, event_id: S.event?.id } });
          const uid = S.user?.id || 'anon';
          localStorage.setItem(CK_KEY + uid + '_invited', '1');
        } catch (_) { /* non-blocking — skip is fine */ }
```

with

```js
        // functions.invoke never throws: read its error (it used to be
        // ignored, so a refused invite looked sent).
        const { error } = await sb.functions.invoke('invite-operator', { body: { email, name, role, event_id: S.event?.id } });
        if (error) {
          let b = null;
          try { b = typeof error.context?.json === 'function' ? await error.context.json() : null; } catch (_) { /* no body */ }
          wizShowError(inviteErrorText(b, error));
          return;
        }
        const uid = S.user?.id || 'anon';
        localStorage.setItem(CK_KEY + uid + '_invited', '1');
```

Check nothing else calls the removed functions: `grep -n "approveUser\|manageOperator\|confirmRemoveUser\|renderOperatorRows\|filterOperators\|loadPendingBadge\|operatorCount\|users-badge" cuedeck-console.html` prints nothing.

- [ ] **Step 6: Strings.** In `cuedeck-i18n.js`, after each language's `'cc.ev.editRefused'` line (Task 3.3), add the 43 keys.

en:
```js
      'cc.team.title': 'Team for {event}',
      'cc.team.seats': 'Team {used} of {limit} seats',
      'cc.team.seatsUnlimited': 'Team {used}, no seat limit',
      'cc.team.fullOwner': 'All seats are taken. Upgrade for more seats.',
      'cc.team.fullAsk': 'All seats are taken. Ask the organiser for more seats.',
      'cc.team.invite': 'Invite to this event',
      'cc.team.email': 'Email address',
      'cc.team.name': 'Name (optional)',
      'cc.team.role': 'Role',
      'cc.team.send': 'Send invite',
      'cc.team.sending': 'Sending…',
      'cc.team.search': 'Search the team',
      'cc.team.close': 'Close',
      'cc.team.loading': 'Loading the team…',
      'cc.team.loadFailed': 'Could not load the team. Close and open Team again.',
      'cc.team.empty': 'No one else is on this event yet.',
      'cc.team.owner': 'Organiser',
      'cc.team.active': 'Active',
      'cc.team.suspended': 'Suspended',
      'cc.team.lastSeen': 'Last seen {when}',
      'cc.team.never': 'never',
      'cc.team.suspend': 'Suspend',
      'cc.team.reactivate': 'Reactivate',
      'cc.team.remove': 'Remove from this event',
      'cc.team.removeConfirm': 'Press again to remove',
      'cc.team.removeAll': 'Remove from all my events',
      'cc.team.removeAllConfirm': 'Press again to remove from all',
      'cc.team.removed': '{name} was removed from this event.',
      'cc.team.removedAll': '{name} was removed from all your events.',
      'cc.team.member': 'This person',
      'cc.team.roleChanged': 'Role changed to {role}.',
      'cc.team.suspendedToast': 'Suspended on this event.',
      'cc.team.reactivatedToast': 'Active on this event again.',
      'cc.team.actionFailed': 'Could not change the team: {reason}',
      'cc.team.emailRequired': 'Enter an email address.',
      'cc.team.invited': 'Invitation sent to {email}.',
      'cc.team.added': '{email} was added to this event.',
      'cc.team.linkResent': 'A new sign-in link was sent to {email}.',
      'cc.team.unchanged': '{email} is already on this event with this role.',
      'cc.team.isOwner': 'This person organises the event and is already its director.',
      'cc.team.rate': 'This organiser has sent 20 invitations today. Try again later.',
      'cc.team.failed': 'Could not send the invitation: {reason}',
      'cc.team.network': 'Network error. Try again.',
```

ar:
```js
      'cc.team.title': 'فريق {event}',
      'cc.team.seats': 'الفريق {used} من {limit} مقعدًا',
      'cc.team.seatsUnlimited': 'الفريق {used}، بلا حد للمقاعد',
      'cc.team.fullOwner': 'كل المقاعد مشغولة. قم بالترقية للحصول على مقاعد أكثر.',
      'cc.team.fullAsk': 'كل المقاعد مشغولة. اطلب من المنظّم مقاعد أكثر.',
      'cc.team.invite': 'دعوة إلى هذا الحدث',
      'cc.team.email': 'البريد الإلكتروني',
      'cc.team.name': 'الاسم (اختياري)',
      'cc.team.role': 'الدور',
      'cc.team.send': 'إرسال الدعوة',
      'cc.team.sending': 'جارٍ الإرسال…',
      'cc.team.search': 'ابحث في الفريق',
      'cc.team.close': 'إغلاق',
      'cc.team.loading': 'جارٍ تحميل الفريق…',
      'cc.team.loadFailed': 'تعذّر تحميل الفريق. أغلق نافذة الفريق وافتحها مجددًا.',
      'cc.team.empty': 'لا أحد غيرك في هذا الحدث بعد.',
      'cc.team.owner': 'المنظّم',
      'cc.team.active': 'نشط',
      'cc.team.suspended': 'موقوف',
      'cc.team.lastSeen': 'آخر ظهور {when}',
      'cc.team.never': 'أبدًا',
      'cc.team.suspend': 'إيقاف',
      'cc.team.reactivate': 'إعادة التفعيل',
      'cc.team.remove': 'إزالة من هذا الحدث',
      'cc.team.removeConfirm': 'اضغط مرة أخرى للإزالة',
      'cc.team.removeAll': 'إزالة من كل أحداثي',
      'cc.team.removeAllConfirm': 'اضغط مرة أخرى للإزالة من الكل',
      'cc.team.removed': 'تمت إزالة {name} من هذا الحدث.',
      'cc.team.removedAll': 'تمت إزالة {name} من كل أحداثك.',
      'cc.team.member': 'هذا الشخص',
      'cc.team.roleChanged': 'تم تغيير الدور إلى {role}.',
      'cc.team.suspendedToast': 'تم الإيقاف في هذا الحدث.',
      'cc.team.reactivatedToast': 'نشط مجددًا في هذا الحدث.',
      'cc.team.actionFailed': 'تعذّر تعديل الفريق: {reason}',
      'cc.team.emailRequired': 'أدخل عنوان البريد الإلكتروني.',
      'cc.team.invited': 'تم إرسال الدعوة إلى {email}.',
      'cc.team.added': 'تمت إضافة {email} إلى هذا الحدث.',
      'cc.team.linkResent': 'تم إرسال رابط دخول جديد إلى {email}.',
      'cc.team.unchanged': '{email} موجود في هذا الحدث بهذا الدور.',
      'cc.team.isOwner': 'هذا الشخص هو منظّم الحدث ومديره بالفعل.',
      'cc.team.rate': 'أرسل هذا المنظّم 20 دعوة اليوم. حاول لاحقًا.',
      'cc.team.failed': 'تعذّر إرسال الدعوة: {reason}',
      'cc.team.network': 'خطأ في الشبكة. حاول مرة أخرى.',
```

pl:
```js
      'cc.team.title': 'Zespół: {event}',
      'cc.team.seats': 'Zespół: {used} z {limit} miejsc',
      'cc.team.seatsUnlimited': 'Zespół: {used}, bez limitu miejsc',
      'cc.team.fullOwner': 'Wszystkie miejsca są zajęte. Zmień plan, aby mieć więcej miejsc.',
      'cc.team.fullAsk': 'Wszystkie miejsca są zajęte. Poproś organizatora o więcej miejsc.',
      'cc.team.invite': 'Zaproś do tego wydarzenia',
      'cc.team.email': 'Adres e-mail',
      'cc.team.name': 'Imię i nazwisko (opcjonalnie)',
      'cc.team.role': 'Rola',
      'cc.team.send': 'Wyślij zaproszenie',
      'cc.team.sending': 'Wysyłanie…',
      'cc.team.search': 'Szukaj w zespole',
      'cc.team.close': 'Zamknij',
      'cc.team.loading': 'Wczytywanie zespołu…',
      'cc.team.loadFailed': 'Nie udało się wczytać zespołu. Zamknij i otwórz Zespół ponownie.',
      'cc.team.empty': 'Nikogo więcej nie ma jeszcze w tym wydarzeniu.',
      'cc.team.owner': 'Organizator',
      'cc.team.active': 'Aktywny',
      'cc.team.suspended': 'Zawieszony',
      'cc.team.lastSeen': 'Ostatnio {when}',
      'cc.team.never': 'nigdy',
      'cc.team.suspend': 'Zawieś',
      'cc.team.reactivate': 'Przywróć',
      'cc.team.remove': 'Usuń z tego wydarzenia',
      'cc.team.removeConfirm': 'Naciśnij ponownie, aby usunąć',
      'cc.team.removeAll': 'Usuń ze wszystkich moich wydarzeń',
      'cc.team.removeAllConfirm': 'Naciśnij ponownie, aby usunąć ze wszystkich',
      'cc.team.removed': 'Usunięto {name} z tego wydarzenia.',
      'cc.team.removedAll': 'Usunięto {name} ze wszystkich Twoich wydarzeń.',
      'cc.team.member': 'Ta osoba',
      'cc.team.roleChanged': 'Zmieniono rolę na {role}.',
      'cc.team.suspendedToast': 'Zawieszono w tym wydarzeniu.',
      'cc.team.reactivatedToast': 'Znów aktywny w tym wydarzeniu.',
      'cc.team.actionFailed': 'Nie udało się zmienić zespołu: {reason}',
      'cc.team.emailRequired': 'Wpisz adres e-mail.',
      'cc.team.invited': 'Wysłano zaproszenie do {email}.',
      'cc.team.added': 'Dodano {email} do tego wydarzenia.',
      'cc.team.linkResent': 'Wysłano nowy link logowania do {email}.',
      'cc.team.unchanged': '{email} jest już w tym wydarzeniu z tą rolą.',
      'cc.team.isOwner': 'Ta osoba organizuje wydarzenie i już jest jego reżyserem.',
      'cc.team.rate': 'Ten organizator wysłał dziś 20 zaproszeń. Spróbuj później.',
      'cc.team.failed': 'Nie udało się wysłać zaproszenia: {reason}',
      'cc.team.network': 'Błąd sieci. Spróbuj ponownie.',
```

de:
```js
      'cc.team.title': 'Team für {event}',
      'cc.team.seats': 'Team: {used} von {limit} Plätzen',
      'cc.team.seatsUnlimited': 'Team: {used}, ohne Platzlimit',
      'cc.team.fullOwner': 'Alle Plätze sind belegt. Upgraden Sie für mehr Plätze.',
      'cc.team.fullAsk': 'Alle Plätze sind belegt. Bitten Sie den Veranstalter um mehr Plätze.',
      'cc.team.invite': 'Zu dieser Veranstaltung einladen',
      'cc.team.email': 'E-Mail-Adresse',
      'cc.team.name': 'Name (optional)',
      'cc.team.role': 'Rolle',
      'cc.team.send': 'Einladung senden',
      'cc.team.sending': 'Wird gesendet…',
      'cc.team.search': 'Team durchsuchen',
      'cc.team.close': 'Schließen',
      'cc.team.loading': 'Team wird geladen…',
      'cc.team.loadFailed': 'Das Team konnte nicht geladen werden. Schließen Sie Team und öffnen Sie es erneut.',
      'cc.team.empty': 'Noch niemand sonst ist in dieser Veranstaltung.',
      'cc.team.owner': 'Veranstalter',
      'cc.team.active': 'Aktiv',
      'cc.team.suspended': 'Gesperrt',
      'cc.team.lastSeen': 'Zuletzt gesehen {when}',
      'cc.team.never': 'nie',
      'cc.team.suspend': 'Sperren',
      'cc.team.reactivate': 'Wieder aktivieren',
      'cc.team.remove': 'Aus dieser Veranstaltung entfernen',
      'cc.team.removeConfirm': 'Zum Entfernen erneut drücken',
      'cc.team.removeAll': 'Aus allen meinen Veranstaltungen entfernen',
      'cc.team.removeAllConfirm': 'Zum Entfernen aus allen erneut drücken',
      'cc.team.removed': '{name} wurde aus dieser Veranstaltung entfernt.',
      'cc.team.removedAll': '{name} wurde aus allen Ihren Veranstaltungen entfernt.',
      'cc.team.member': 'Diese Person',
      'cc.team.roleChanged': 'Rolle geändert zu {role}.',
      'cc.team.suspendedToast': 'In dieser Veranstaltung gesperrt.',
      'cc.team.reactivatedToast': 'In dieser Veranstaltung wieder aktiv.',
      'cc.team.actionFailed': 'Das Team konnte nicht geändert werden: {reason}',
      'cc.team.emailRequired': 'Geben Sie eine E-Mail-Adresse ein.',
      'cc.team.invited': 'Einladung an {email} gesendet.',
      'cc.team.added': '{email} wurde zu dieser Veranstaltung hinzugefügt.',
      'cc.team.linkResent': 'Ein neuer Anmeldelink wurde an {email} gesendet.',
      'cc.team.unchanged': '{email} ist bereits mit dieser Rolle in dieser Veranstaltung.',
      'cc.team.isOwner': 'Diese Person veranstaltet das Event und hat bereits die Regie.',
      'cc.team.rate': 'Dieser Veranstalter hat heute 20 Einladungen gesendet. Versuchen Sie es später erneut.',
      'cc.team.failed': 'Die Einladung konnte nicht gesendet werden: {reason}',
      'cc.team.network': 'Netzwerkfehler. Versuchen Sie es erneut.',
```

- [ ] **Step 7: Run the tests and see them pass.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-forbidden.spec.ts --global-timeout=900000`
Expected: all pass (18 event-teams tests, every console-forbidden test).

Run: `npx vitest run tests/event-teams-no-invited-by.spec.ts tests/console-i18n-keys.spec.ts tests/console-copy.spec.ts tests/console-no-emoji-icons.spec.ts tests/console-colour-ratchet.spec.ts`
Expected: the first four PASS. The ratchet's "kept tight" test fails, printing the new count (the old Team window's hard-coded colours are gone): set `BUDGET` in `tests/console-colour-ratchet.spec.ts` to that printed number and run it again. Expected: PASS.

- [ ] **Step 8: Every console suite and every unit suite** (Stage 3 preamble). Expected: `0 failed`.

- [ ] **Step 9: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-forbidden.spec.ts tests/console-colour-ratchet.spec.ts tests/event-teams-no-invited-by.spec.ts
git commit -m "feat(console): Team window per event with seats, per-event invite and remove; wizard reads invite errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-boot-mock.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-forbidden.spec.ts tests/console-colour-ratchet.spec.ts tests/event-teams-no-invited-by.spec.ts
```

### Task 3.5: Private realtime channels per event (migration 135)

Sherif's condition on the plan (8 Oct): each event's realtime channel only lets members of that event join, track presence or read presence. Today `leod-ctrl-<event>` is a public channel, so any signed-in user who knows an event id can join it and read its presence list (who is online, with which role).

The mechanism, from the Supabase docs (Realtime Authorization, read 8 Oct, https://supabase.com/docs/guides/realtime/authorization and /broadcast):
- RLS policies on `realtime.messages` decide who may join a **private** channel and what they may do in it. `realtime.topic()` returns the topic the client is joining (live body: `select nullif(current_setting('realtime.topic', true), '')::text`); `realtime.messages.extension` is `'presence'` or `'broadcast'`. A SELECT policy lets a client join and receive presence and broadcast; an INSERT policy with `extension = 'presence'` lets it track presence.
- The client opts in with `sb.channel(name, { config: { private: true } })`, after `await sb.realtime.setAuth()` ("Needed for Realtime Authorization").
- "Private and public channels can subscribe to Postgres Changes"; changes are delivered only to clients allowed to read the row by the table's RLS. So the console's `postgres_changes` bindings keep working on private channels and keep their table protection (tested below by the mock socket and on live in Task 4.2).
- Public channels stay joinable until the project's Realtime setting "Allow public access" is turned off ("To enforce private channels you need to disable the 'Allow public access' setting"). A private channel and a public channel of the same name do not share presence or broadcasts, so once every member's console is private, a stranger on the public twin sees nobody; turning the setting off then closes the public twin entirely.
- Policies are checked when a client joins and when it sends a new token, and are cached for the connection: a member removed mid-session keeps the channel until they reconnect or switch event (switchEvent rejoins, Task 3.1). This is stated in the note to Sherif.

Order, so nothing breaks mid-release: (1) migration 135 adds the policies; they only apply to private channels, so the live console is unaffected (Release B, before the push); (2) the console joins private channels (Release B push); (3) Sherif turns off "Allow public access" (Release C, Task 4.3), only after every other page in the project that uses Realtime (check-in's `ck-alerts-*` and `ck-desk-alerts-*`, owned by the other session) has moved to private channels, because the setting refuses every public channel in the project.

**Files:**
- Create: `supabase/migrations/135_cuedeck_realtime_private.sql`
- Create: `tests/sql/135-realtime-private-probe.sql`
- Modify: `cuedeck-console.html`: `replaceChannel` (3142-3158), `subscribeDisplays` (5726-5727 and its options)
- Modify: `tests/e2e/console-show-safety-boot.spec.ts:64,89` (the signage channel's topic now names the event)
- Modify: `tests/e2e/console-event-teams.spec.ts` (one test)

**Interfaces:**
- Consumes: `cuedeck_event_role(uuid)` (Task 1.1); `window.__rtSent` in the console mock (Task 3.1).
- Produces:
  - `public.cuedeck_topic_event(p_topic text) RETURNS uuid`: the event id of a console topic `leod-ctrl-<uuid>` or `leod-signage-<uuid>`, else `NULL`. IMMUTABLE, executable by authenticated (the policies run as the client).
  - policies on `realtime.messages`: `cuedeck_event_channel_read` (SELECT, authenticated: a member of the topic's event) and `cuedeck_event_channel_presence` (INSERT, authenticated, `extension = 'presence'`, same rule). No policy for any other topic, so check-in's channels are untouched.
  - console channels `leod-ctrl-<eventId>` and `leod-signage-<eventId>` (was `leod-signage`), both joined with `config: { private: true }` after `sb.realtime.setAuth()`.

- [ ] **Step 1: Check the migration number** (Global Constraints). Expected next free: 135.

- [ ] **Step 2: Write the failing tests.**

`tests/sql/135-realtime-private-probe.sql` (Realtime checks a join by inserting into `realtime.messages` as the client and reading it back, then rolling back; this probe does the same):

```sql
-- tests/sql/135-realtime-private-probe.sql
-- Run after 135. Expected: an error whose message starts with 'PROBE OK 135'.
-- Everything is rolled back by the final RAISE. Before 135 it fails with:
-- function cuedeck_topic_event(text) does not exist.
-- If an insert fails with 'no partition of relation "messages"', Realtime's
-- daily partitions are missing on the project: stop and report, do not create them.
DO $probe$
DECLARE
  v_o1   uuid := gen_random_uuid();   -- creates A
  v_m    uuid := gen_random_uuid();   -- stage member of A
  v_s    uuid := gen_random_uuid();   -- member of A, suspended
  v_x    uuid := gen_random_uuid();   -- creates B, nothing on A
  v_a    uuid;
  v_b    uuid;
  v_n    int;
  v_ok   boolean;
  v_r    record;
  v_t    record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated' FROM unnest(ARRAY[v_o1, v_m, v_s, v_x]) u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', true FROM unnest(ARRAY[v_o1, v_m, v_s, v_x]) u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 135 A', current_date + 30, '09:00', '18:00', v_o1) RETURNING id INTO v_a;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 135 B', current_date + 30, '09:00', '18:00', v_x) RETURNING id INTO v_b;
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES (v_a, v_m, 'stage', true), (v_a, v_s, 'stage', false);
  -- one stored presence message per console topic of A (as the database), for the read checks
  INSERT INTO realtime.messages (topic, extension, event, payload, private)
  VALUES ('leod-ctrl-' || v_a, 'presence', 'probe', '{}', true), ('leod-signage-' || v_a, 'presence', 'probe', '{}', true);

  -- 1. the topic parser: console topics only, exact shape
  IF cuedeck_topic_event('leod-ctrl-' || v_a) IS DISTINCT FROM v_a
     OR cuedeck_topic_event('leod-signage-' || v_a) IS DISTINCT FROM v_a
     OR cuedeck_topic_event('leod-ctrl-' || v_a || 'x') IS NOT NULL
     OR cuedeck_topic_event('ck-alerts-' || v_a) IS NOT NULL
     OR cuedeck_topic_event('leod-signage') IS NOT NULL
     OR cuedeck_topic_event(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 1: topic parser';
  END IF;
  v_checks := v_checks + 1;

  -- 2. join and read presence: the creator and the member read A's topics;
  --    the suspended member and a stranger read nothing; nobody from A reads B
  FOR v_t IN SELECT * FROM (VALUES ('leod-ctrl-' || v_a), ('leod-signage-' || v_a)) AS y(topic) LOOP
    FOR v_r IN SELECT * FROM (VALUES (v_o1, 1), (v_m, 1), (v_s, 0), (v_x, 0)) AS x(uid, expected) LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('realtime.topic', v_t.topic, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_n FROM realtime.messages WHERE topic = v_t.topic AND extension = 'presence';
      RESET ROLE;
      IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 2: % reads % on %, expected %', v_r.uid, v_n, v_t.topic, v_r.expected; END IF;
    END LOOP;
  END LOOP;
  v_checks := v_checks + 1;

  -- 3. track presence: members may, the suspended member and strangers may not;
  --    a member of A may not track on B's topic; nobody may send broadcasts
  FOR v_r IN SELECT * FROM (VALUES
      (v_o1, 'leod-ctrl-' || v_a, 'presence', true),
      (v_m,  'leod-ctrl-' || v_a, 'presence', true),
      (v_m,  'leod-signage-' || v_a, 'presence', true),
      (v_s,  'leod-ctrl-' || v_a, 'presence', false),
      (v_x,  'leod-ctrl-' || v_a, 'presence', false),
      (v_m,  'leod-ctrl-' || v_b, 'presence', false),
      (v_m,  'leod-ctrl-' || v_a, 'broadcast', false),
      (v_m,  'ck-alerts-' || v_a, 'presence', false)) AS x(uid, topic, ext, allowed)
  LOOP
    v_ok := true;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('realtime.topic', v_r.topic, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES (v_r.topic, v_r.ext, 'probe', '{}', true);
    EXCEPTION WHEN insufficient_privilege THEN v_ok := false;
    END;
    RESET ROLE;
    IF v_ok IS DISTINCT FROM v_r.allowed THEN
      RAISE EXCEPTION 'PROBE FAIL 3: % % on %: allowed % but got %', v_r.uid, v_r.ext, v_r.topic, v_r.allowed, v_ok;
    END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 4. anon reads and writes nothing on a console topic
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('realtime.topic', 'leod-ctrl-' || v_a, true);
  v_ok := true;
  BEGIN
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM realtime.messages WHERE topic = 'leod-ctrl-' || v_a;
    IF v_n <> 0 THEN v_ok := false; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;   -- no grant at all is also a refusal
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'PROBE FAIL 4: anon read a console topic'; END IF;
  v_checks := v_checks + 1;

  -- 5. the policies exist as written, and RLS is on
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'realtime.messages'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages'
          AND policyname IN ('cuedeck_event_channel_read', 'cuedeck_event_channel_presence')
          AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%cuedeck_event_role%') <> 2
     OR has_function_privilege('anon', 'public.cuedeck_topic_event(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 5: policies, RLS or grants';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 135: % checks passed (rolled back)', v_checks;
END
$probe$;
```

Append to `tests/e2e/console-event-teams.spec.ts`:

```ts
test('realtime: the event channels are private and name their event, also after a switch', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit', role: 'stage', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  const joins = () => evalPage(page, `(window.__rtSent || []).filter(m => m.event === 'phx_join')
    .map(m => ({ topic: m.topic, private: !!(m.payload && m.payload.config && m.payload.config.private),
                 pc: ((m.payload && m.payload.config && m.payload.config.postgres_changes) || []).length,
                 token: typeof (m.payload && m.payload.access_token) === 'string' }))`);
  try {
    await afterBootReread(page);
    const boot = await joins();
    expect(boot).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: `realtime:leod-ctrl-${EVENT_ID}`, private: true, token: true }),
      expect.objectContaining({ topic: `realtime:leod-signage-${EVENT_ID}`, private: true, token: true }),
    ]));
    expect(boot.every((j: { private: boolean }) => j.private)).toBe(true);
    // postgres_changes still ride on the private channel
    expect(boot.find((j: { topic: string }) => j.topic === `realtime:leod-ctrl-${EVENT_ID}`).pc).toBeGreaterThan(0);
    await switchTo(page, EV_B);
    const after = await joins();
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: `realtime:leod-ctrl-${EV_B}`, private: true }),
    ]));
    expect(after.every((j: { private: boolean }) => j.private)).toBe(true);
  } finally { await ctx.close(); }
});
```

In `tests/e2e/console-show-safety-boot.spec.ts` replace `c.topic === 'realtime:leod-signage'` (line 64) with ``c.topic === `realtime:leod-signage-${ev}` `` and `'realtime:leod-signage': 1` (line 89) with ``[`realtime:leod-signage-${EVENT_ID}`]: 1``. What they protect is unchanged: one signage channel, replaced not duplicated.

- [ ] **Step 3: Run them and see them fail.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-show-safety-boot.spec.ts --global-timeout=900000`
Expected: `realtime: the event channels are private…` fails (`private: false`, and the signage topic is `realtime:leod-signage`); the two show-safety-boot tests fail on the topic name.

- [ ] **Step 4 (controller): run probe 135 before its migration.** Expected: `function cuedeck_topic_event(text) does not exist`. Record it.

- [ ] **Step 5: Write the migration** `supabase/migrations/135_cuedeck_realtime_private.sql`:

```sql
-- ============================================================
-- CueDeck Migration 135: private realtime channels per event
-- ============================================================
-- Realtime Authorization (supabase.com/docs/guides/realtime/authorization):
-- a client joining a PRIVATE channel is checked against RLS on
-- realtime.messages, with realtime.topic() = the channel's topic. The
-- console's channels are leod-ctrl-<event id> and leod-signage-<event id>:
-- only the event's creator and active members may join them, read presence
-- (and broadcast), and track presence. Nobody may send broadcasts (the
-- console sends none). Other topics get no policy here, so check-in's
-- channels are untouched.
-- These policies only govern private channels: the live console (public
-- channels) is unaffected until it switches (Release B), and public
-- channels stay joinable until "Allow public access" is turned off
-- (Release C, Sherif in the dashboard).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cuedeck_topic_event(p_topic text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_topic ~ '^leod-(ctrl|signage)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN right(p_topic, 36)::uuid
         END
$$;
REVOKE ALL ON FUNCTION public.cuedeck_topic_event(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cuedeck_topic_event(text) TO authenticated, service_role;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cuedeck_event_channel_read ON realtime.messages;
CREATE POLICY cuedeck_event_channel_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (public.cuedeck_event_role(public.cuedeck_topic_event((SELECT realtime.topic()))) IS NOT NULL);

DROP POLICY IF EXISTS cuedeck_event_channel_presence ON realtime.messages;
CREATE POLICY cuedeck_event_channel_presence ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (realtime.messages.extension = 'presence'
              AND public.cuedeck_event_role(public.cuedeck_topic_event((SELECT realtime.topic()))) IS NOT NULL);
```

- [ ] **Step 6: The console joins private channels.** In `cuedeck-console.html`:

Replace the `replaceChannel` function (and the comment block above it, from `// One live channel per name.` to its closing `}`) with:

```js
// One live channel per name. sb.channel(name) hands back an existing channel
// of that name, and adding postgres_changes callbacks to a joined or joining
// one throws. So remove it, and every channel `removeIf` matches, and wait for
// that before building the new one. Calls run one at a time (a scheduled
// reconnect and a tab refocus can land together), and what to remove or skip
// is decided when the queued step runs, not when it was asked for.
// Every console channel is private (Realtime Authorization, migration 135):
// only members of the event named in its topic may join it, track presence
// or read presence. setAuth hands Realtime the login's token first.
// postgres_changes on a private channel still pass each row through the
// table's own RLS.
let _channelQueue = Promise.resolve();
function replaceChannel(name, build, { removeIf = () => false, skipIf = () => false } = {}) {
  const run = _channelQueue.then(async () => {
    if (skipIf()) return;
    const old = sb.getChannels().filter(c => c.topic === `realtime:${name}` || removeIf(c));
    for (const c of old) await sb.removeChannel(c);
    await sb.realtime.setAuth();
    return build(sb.channel(name, { config: { private: true } }));
  });
  _channelQueue = run.catch(() => {});
  return run;
}
```

In `subscribeDisplays`, change `return replaceChannel('leod-signage', ch => ch` to ``return replaceChannel(`leod-signage-${eventId}`, ch => ch`` (the topic names the event, so the policy can check it), and give the call the same options as the control channel: replace the final `);` of the `replaceChannel(…)` call (right after the `.subscribe(st => { … })` callback closes) with

```js
  }), {
    // One signage channel at a time, and never for an event already left.
    removeIf: c => c.topic.startsWith('realtime:leod-signage-'),
    skipIf: () => !!S.event && S.event.id !== eventId,
  });
```

(Read the lines around 5755-5765 first: the `.subscribe(…)` callback's closing `})` and the call's closing `)` are where the options object goes; the build arrow returns the channel as before.)

- [ ] **Step 7: Run the tests and see them pass.**

Run: `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts tests/e2e/console-event-teams.spec.ts tests/e2e/console-show-safety-boot.spec.ts --global-timeout=900000`
Expected: all pass.

- [ ] **Step 8: Every console suite** (Stage 3 preamble). Expected: `0 failed`.

- [ ] **Step 9: Commit.**

```bash
cd /Users/sheriff/AVE-Production-Console-teams
git status --short
git add supabase/migrations/135_cuedeck_realtime_private.sql tests/sql/135-realtime-private-probe.sql cuedeck-console.html tests/e2e/console-event-teams.spec.ts tests/e2e/console-show-safety-boot.spec.ts
git commit -m "feat(realtime): event channels are private; only the event's team joins or sees presence (migration 135)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- supabase/migrations/135_cuedeck_realtime_private.sql tests/sql/135-realtime-private-probe.sql cuedeck-console.html tests/e2e/console-event-teams.spec.ts tests/e2e/console-show-safety-boot.spec.ts
```

---

# Stage 4: Release (controller only)

`$SCRATCH` below is the controller session's scratchpad directory; set it in the same command that uses it. `$W` is `/Users/sheriff/AVE-Production-Console-teams`, `$M` is `/Users/sheriff/AVE-Production-Console`.

### Task 4.1: Release A: stages 1 and 2 (database and server)

**Files:** none changed (git refs, the live database, Edge Function deployments).

**Interfaces:** Consumes the commits of Tasks 1.1 to 2.5 on `feat/event-teams`. Produces: migrations 130 to 134 applied on `sawekpguemzvuvvulfbc` with every probe `PROBE OK`; the 15 Edge Functions deployed from that source; `main` at the Task 2.5 commit (plus review fixes) pushed to `cuedeck` and `origin` (Vercel then deploys the new health-check cron).

- [ ] **Step 1: Gate.** `date`. Nothing from this plan ships before 13 Oct 2026 (GTR is 12 Oct). Then confirm no show is running anywhere, because the access rules change under every open console:

```bash
cd /Users/sheriff/AVE-Production-Console
supabase db query --linked "select count(*) from leod_sessions where status in ('LIVE','OVERRUN','HOLD','CALLING')"
```

Expected: `0`. If not 0, wait and ask Sherif; do not apply during a show.

- [ ] **Step 2: Integrate the remotes and find the stage 2 tip.**

```bash
cd $M && git status --short
git fetch cuedeck && git fetch origin
git log --oneline main..cuedeck/main; git log --oneline main..origin/main
```

If either range lists commits, `git merge --ff-only cuedeck/main` (or `origin/main`); if that refuses, stop and ask Sherif. Then rebase the feature branch and find the Task 2.4 commit:

```bash
cd $W && git rebase main
STAGE2=$(git log --format=%H -1 --grep="run the console guards daily")
git log --oneline main..$STAGE2
```

Expected: the Task 1.1 to 2.5 commits, in order, and nothing else.

- [ ] **Step 3: Review before anything is applied** (spec §8: the migration is reviewed by a security reviewer before it is applied).
  - Run the house `diff-review` skill with `{range: "main..$STAGE2", repo: "/Users/sheriff/AVE-Production-Console-teams"}`.
  - Dispatch one `security-reviewer` agent on `supabase/migrations/130_event_members.sql` to `133_event_teams_server.sql`, `supabase/functions/invite-operator/index.ts`, `manage-operator/index.ts`, `ai-proxy/index.ts`, `_shared/transition.ts`, migration 134 and `cuedeck-guard-alert/index.ts`, with the spec, the inventory and this plan's Review Focus. Ask it to try to break the §8 isolation matrix (a member of A reaching B by any route), the seat check, the creator rule, and every `SECURITY DEFINER` function's caller check.
  - Fix every finding on `feat/event-teams` (test first, new commit), recompute `STAGE2`, and re-run that task's tests. A finding outside this plan goes in the note to Sherif.

- [ ] **Step 4: Full tests at the stage 2 tip.**

```bash
git -C $M worktree add --detach /Users/sheriff/AVE-Production-Console-teamsA $STAGE2
ln -s $M/node_modules /Users/sheriff/AVE-Production-Console-teamsA/node_modules
cd /Users/sheriff/AVE-Production-Console-teamsA
npx vitest run 2>&1 | tail -6
(python3 -m http.server 7294 --bind 127.0.0.1 --directory /Users/sheriff/AVE-Production-Console-teamsA >/dev/null 2>&1 &)
CONSOLE_BASE=http://127.0.0.1:7294 npx playwright test -c playwright.console.config.ts --global-timeout=1800000 2>&1 | tail -6
```

Expected: vitest all pass (the deno suites run: `operators`, `session-auth`, `restart-session`, `plan-owner`, check-in handlers); Playwright `0 failed`. Remove the worktree after: `git -C $M worktree remove /Users/sheriff/AVE-Production-Console-teamsA`.

- [ ] **Step 5: Snapshot before applying** (all SELECTs; save the output under `$SCRATCH/pre-teams/`).
  - The live bodies of everything 130 to 133 replace, for a rollback: `pg_get_functiondef` of `cuedeck_event_role(uuid)`, `rpc_apply_delay(uuid,integer,uuid,text)`, `display_pair_link(text,uuid)`, `display_rotate_secret(uuid)`, `validate_event_log_role()`, `get_operators_with_last_seen()`, `get_subscription_for_user()`, `handle_first_login(uuid)`, one call each; and `select policyname, cmd, qual, with_check from pg_policies where tablename in ('leod_events','leod_sessions','leod_reports','leod_signage_displays','leod_signage_sponsors')`.
  - The expected backfill size: `select count(*) from leod_users u join leod_events e on e.created_by = u.invited_by join auth.users a on a.id = u.id where u.invited_by is not null and u.role in ('director','stage','av','interp','reg','signage') and e.created_by <> u.id` (8 Oct: 1). Record it as `N`.
  - Guards already red before this release: `select guard, detail from checkin_guard_results() where not ok`. Record them; only new reds count against this release.

- [ ] **Step 6: Each probe fails before its migration.** With `execute_sql`, run `tests/sql/130-event-members-probe.sql`, `131-…`, `132-…`, `133-…`, `134-…`. Expected: each errors with `relation "leod_event_members" does not exist` (133: `function cuedeck_plan_seats(uuid) does not exist`, 134: `function cuedeck_run_guards() does not exist`, or the same relation error). Any `PROBE OK` here means the probe tests nothing: stop.

- [ ] **Step 7: Apply in order, each with its probe.** Check the next free migration numbers once more (Global Constraints). Then, with the Supabase MCP on `sawekpguemzvuvvulfbc`:
  1. `apply_migration` name `130_event_members` with the file's content; `execute_sql` the 130 probe. Expected: `PROBE OK 130: 9 checks passed (rolled back)`.
  2. `apply_migration` `131_event_members_functions`; probe 131. Expected: `PROBE OK 131: 8 checks passed (rolled back)`.
  3. `apply_migration` `132_event_teams_guard`; probe 132. Expected: `PROBE OK 132: 9 checks passed (rolled back)`.
  4. `apply_migration` `133_event_teams_server`; probe 133. Expected: `PROBE OK 133: 10 checks passed (rolled back)`.
  5. `apply_migration` `134_cuedeck_guard_schedule`; probe 134. Expected: `PROBE OK 134: 6 checks passed (rolled back)`.

  Then re-run probes 130, 131, 132 (they must still pass after 133) and the older probes this plan updated or that touch these objects: `083-display-followups`, `093-apply-delay`, `095-event-scoped-writes`, `128-stage-messages`, `129-stage-messages-cancel`. Expected: `PROBE OK` for each.

  If any probe fails: do not deploy the functions. Fix forward with a corrective migration (`NNN_<name>_fix`, reviewed as in Step 3) and re-run the probe. If it cannot be fixed within 30 minutes, restore the saved bodies and policies from Step 5 in one migration, `DROP TABLE leod_event_members`, and tell Sherif.

- [ ] **Step 8: Verify the data and the guards.**

```sql
select count(*) from leod_event_members;                         -- equals N from Step 5
select guard, ok, detail, checked_at from cuedeck_guard_results(); -- 3 rows, all ok, checked_at = now
select guard, detail from checkin_guard_results() where not ok;    -- no guard that was green in Step 5
```

(One statement per `supabase db query --linked` call.) A dead check and a clean check look alike: confirm `checked_at` is this minute.

- [ ] **Step 9: Deploy the 14 Edge Functions** from the main checkout at the stage 2 tip:

```bash
cd $M && git merge --ff-only $STAGE2 && git status --short -- supabase/functions
bash scripts/deploy-functions.sh go-live end-session set-ready hold-stage call-speaker cancel-session reinstate set-overrun restart-session apply-delay invite-operator manage-operator ai-proxy redeem-code cuedeck-guard-alert
```

Expected: the status line prints nothing for `supabase/functions` (the deployer refuses uncommitted source); every function `OK … deployed` and every ping `OK`. Check that `BILLING_ALERT_EMAIL` is set on the project (`supabase secrets list --project-ref sawekpguemzvuvvulfbc` lists the name; never print its value); if it is missing, stop and ask Sherif for the alert address. The window between Step 7 and this step is the only time the old functions run on the new tables: keep it short.

- [ ] **Step 10: What will be pushed.** `git log --oneline cuedeck/main..main` and `git log --oneline origin/main..main` list only the spec and plan doc commits not yet pushed and the Task 1.1 to 2.5 commits (and review fixes). Anything else: stop and ask Sherif. Then `git push cuedeck main && git push origin main`; both range checks then print nothing. `SHA=$(git rev-parse main)`.

- [ ] **Step 11: Live check.**
  - `supabase functions list --project-ref sawekpguemzvuvvulfbc` shows the 14 functions updated after the Step 7 apply time.
  - Open https://app.cuedeck.io in Chrome (`open -a "Google Chrome" https://app.cuedeck.io`) on Sherif's signed-in session, without pressing any show control: the event list is the same as before, sessions load, Team opens and lists his crew (the live console still uses `get_operators_with_last_seen`, rewritten in 131). A JS console with no new errors.
  - The Vercel deployment for `SHA` is `READY` (the console file is unchanged in this release; `api/cron/health-check.ts` changed).
  - The guard schedule works end to end, not just on paper (absence is not all-clear): run `select public.cuedeck_run_guards()` once with `execute_sql` (a write the controller is allowed here) and confirm a `cuedeck-guards` row with `status = 'ok'`; ask Sherif to press Run on the `health-check` cron in Vercel (project `cuedeck-console`, Settings, Cron Jobs) or wait for 06:00 UTC, then confirm a `cuedeck-guard-watch` row: `select job_name, status, started_at from cuedeck_job_runs order by id desc limit 5`. `select jobname, schedule, active from cron.job where jobname = 'cuedeck-guards'` shows `10 5 * * *`, active. The next morning (after 05:10 UTC), `select status, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'cuedeck-guards') order by start_time desc limit 1` is `succeeded` and a new `cuedeck-guards` run exists.

- [ ] **Step 12: CI.** `gh workflow list -R sheozin/cuedeck-console` and `-R sheozin/ave` show which repos run `CI`; on each, `gh run list -R <repo> --commit "$SHA" --json conclusion,name` until the run exists and shows `success`. A missing run is not a pass; a failure is fixed forward, never left red.

- [ ] **Step 13: Note to Sherif** (short): "Event teams, part 1 is live: access is now per event in the database and the server (migrations 130 to 133, 14 functions), and the console guards now run every morning and email the alert inbox if a guard fails or a run goes missing (migration 134). Nothing looks different in the console yet; part 2 (the console) follows. Backfilled N membership(s); all probes and guards green." Add any review finding left for later.

### Task 4.2: Release B: stage 3 (the console)

**Files:** none changed.

**Interfaces:** Consumes Release A (verified live) and the Task 3.1 to 3.5 commits. Produces migration 135 applied and `main` with the console changes, live on app.cuedeck.io.

- [ ] **Step 1: Gate.** Release A's Step 11 passed. `date` is on or after 13 Oct 2026. No show running (Task 4.1 Step 1 query returns `0`).

- [ ] **Step 2: Integrate, review, merge.** As Task 4.1 Step 2 (remotes first), then `cd $W && git rebase main && git log --oneline main..HEAD` lists only the Task 3.1 to 3.5 commits. Run the house `diff-review` skill on `main..feat/event-teams`; fix findings on the branch first. Then `cd $M && git merge --ff-only feat/event-teams`.

- [ ] **Step 3: Full tests on the merged tip** (from `$W`, which now equals `main`): `npx vitest run` all pass; `CONSOLE_BASE=http://127.0.0.1:7293 npx playwright test -c playwright.console.config.ts --global-timeout=1800000` with `0 failed`.

- [ ] **Step 3b: Private channel policies before the console.** A `security-reviewer` agent reads migration 135 first. Then with `execute_sql` run probe 135 (expected: `function cuedeck_topic_event(text) does not exist`), `apply_migration` `135_cuedeck_realtime_private`, run probe 135 again (expected: `PROBE OK 135: 5 checks passed (rolled back)`), and re-run probe 132 (expected `PROBE OK 132`). The live console still joins public channels, which these policies do not govern, so nothing changes for it until the push.

- [ ] **Step 4: What will be pushed.** `git log --oneline cuedeck/main..main` and `origin/main..main` list only the Task 3.1 to 3.5 commits (and review fixes). Then `git push cuedeck main && git push origin main`; both ranges then empty. `SHA=$(git rev-parse main)`.

- [ ] **Step 5: Deploy is live.** The Vercel deployment for `SHA` in project `cuedeck-console` is `READY`, then:

```bash
curl -s https://app.cuedeck.io/ | grep -o "cuedeck_my_events" | head -1
```

Expected: `cuedeck_my_events`.

- [ ] **Step 6: Live check on Sherif's own session** (Chrome, hard reload, no show control pressed): the event switcher lists his events (no headings if they are all his); the Team window on one event says "Team N of M seats" with his crew and the invite form; the plan badge and Billing are as before.

- [ ] **Step 7: End-to-end with a throwaway login** (never Sherif's own account). Ask Sherif for an address he controls and a test event that is not GTR. From his console:
  1. Invite the address to the test event as Stage. The email's subject is "You're invited to <event> on CueDeck". In a private window, accept, set a password: the console shows only that event, the role lock says Stage, no plan badge, no Billing, no trial.
  2. Invite the same address to a second test event of his as AV: the email is "You've been added to <event> on CueDeck" with no password step; the login's switcher shows both events; on the second the lock says AV.
  3. Remove it from the first event: the login, after a switch, keeps the second event and loses the first ("You are no longer on the team of this event.").
  4. SQL (SELECT only): `select count(*) from leod_subscriptions where director_id = '<throwaway id>'` is `0`; `select count(*) from welcome_email_trigger where user_id = '<throwaway id>'` is `0`; `select count(*) from leod_event_members where user_id = '<throwaway id>'` is `1`.
  Then remove the throwaway from the second event too.

- [ ] **Step 8: CI** as Task 4.1 Step 12.

- [ ] **Step 9: Note to Sherif** with screenshots at 2× scale (switcher, Team window, the throwaway's members-only view): "Event teams is live: invite anyone to one event with one role, including people who already have a CueDeck login; seats per event from your plan; removing someone takes them off that event only." Also confirm on his session that the crew popover still lists who is online (presence on the private channel) and that a status change from a second tab arrives (postgres_changes on the private channel). List what remains: Release C (his Realtime setting, after check-in's channels go private), and the spec §7 cleanup (drop `leod_users.invited_by` use, the global role, and `get_operators_with_last_seen`).

### Task 4.3: Release C: refuse public realtime channels (Sherif's setting)

Turning off "Allow public access" is a project-wide security setting: from then on Realtime refuses every public channel in the project, not only the console's. Sherif changes it himself; the controller prepares, gates and verifies.

**Files:**
- Create: `scripts/check-realtime-private.mjs` (the live verification, committed before the change)

**Interfaces:** Consumes Release B (the console on private channels, migration 135 live). Produces: the project's Realtime setting "Allow public access" off, verified.

- [ ] **Step 1: Gate: nothing in the project still uses a public channel.** Every Realtime channel in every page must be private before the setting changes, or that page loses its live updates.

```bash
cd /Users/sheriff/AVE-Production-Console
grep -n -e "\.channel(" cuedeck-*.html cuedeck-*.js | grep -v "private: true"
grep -n "replaceChannel(\|sb.channel(name" cuedeck-console.html
```

Expected: the first command prints nothing (the console's own `sb.channel(name, { config: { private: true } })` line is filtered out by its `private: true`). On 8 Oct it would have printed `cuedeck-checkin-dashboard.html:339` (`ck-alerts-<event>`) and `cuedeck-checkin.html:1677` (`ck-desk-alerts-<event>`): those pages belong to the check-in session. Release C waits until that session has made them private with their own `realtime.messages` policies; send it this request through Sherif, with the Supabase docs link and migration 135 as the pattern. Do not edit those files. Also confirm with Sherif that no other app uses this Supabase project's Realtime (the marketing site and AVE Brain do not subscribe to it as of 8 Oct; ask, do not assume).

- [ ] **Step 2: Write the verification script** `scripts/check-realtime-private.mjs`:

```js
// scripts/check-realtime-private.mjs
// Live check for Release C of event teams: with "Allow public access" off,
// a public channel on a console topic is refused, and a private join with no
// login (anon) is refused too. Exit 0 only when both are refused.
// Usage: SUPABASE_ANON_KEY=<publishable key> node scripts/check-realtime-private.mjs <event-uuid>
import { createClient } from '@supabase/supabase-js';

const URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const key = process.env.SUPABASE_ANON_KEY;
const eventId = process.argv[2];
if (!key || !/^[0-9a-f-]{36}$/.test(eventId || '')) {
  console.error('usage: SUPABASE_ANON_KEY=… node scripts/check-realtime-private.mjs <event-uuid>');
  process.exit(2);
}
const sb = createClient(URL, key, { auth: { persistSession: false } });

function join(isPrivate) {
  return new Promise(resolve => {
    const ch = sb.channel(`leod-ctrl-${eventId}`, { config: { private: isPrivate } });
    const done = (status, err) => { sb.removeChannel(ch); resolve({ status, err: err?.message || '' }); };
    const timer = setTimeout(() => done('TIMED_OUT'), 15000);
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer); done(status, err);
      }
    });
  });
}

const pub = await join(false);
const priv = await join(true);
console.log('public join :', pub.status, pub.err);
console.log('private join (anon):', priv.status, priv.err);
const refused = s => s.status !== 'SUBSCRIBED';
if (refused(pub) && refused(priv)) { console.log('OK: console topics refuse public and anonymous joins'); process.exit(0); }
console.error('FAIL: ' + (!refused(pub) ? 'public channels are still allowed' : 'an anonymous private join was accepted'));
process.exit(1);
```

Commit it on `main` before the change (explicit path and pathspec, trailer as in Global Constraints).

- [ ] **Step 3: See it fail before the change.** Get the publishable key without printing it into a file: `SUPABASE_ANON_KEY=$(supabase projects api-keys --project-ref sawekpguemzvuvvulfbc -o json | python3 -c 'import json,sys;print(next(k["api_key"] for k in json.load(sys.stdin) if k.get("type")=="publishable"))') node scripts/check-realtime-private.mjs <a real console event id>`. Expected: exit 1, `FAIL: public channels are still allowed` (the anonymous private join is already refused by migration 135). If the private join is accepted, stop: migration 135's policies are not doing their job.

- [ ] **Step 4: Sherif changes the setting.** Send him exactly: "In the Supabase dashboard open project sawekpguemzvuvvulfbc (CueDeck), then Realtime, then Settings (https://supabase.com/dashboard/project/sawekpguemzvuvvulfbc/realtime/settings). Turn **Allow public access** OFF and save. Tell me when it is saved." Do not change it for him.

- [ ] **Step 5: Verify.** Run the Step 3 command again. Expected: exit 0, `OK: console topics refuse public and anonymous joins`. Then on Sherif's own session in Chrome (hard reload, no show control pressed): the header shows the connection live (not reconnecting), the crew popover lists the people online, a session status change made from a second tab of his own arrives in the first (postgres_changes on the private channel). With the Task 4.2 throwaway login, which is not on the event checked: it never appears in Sherif's crew list.

- [ ] **Step 6: If anything breaks:** Sherif turns "Allow public access" back ON (same path); nothing else needs undoing, the console keeps working on private channels either way.

- [ ] **Step 7: Note to Sherif:** "Realtime is now private: only an event's team can join its live channel or see who is online. A person removed from a team keeps the channel they already have open until they switch event or reload (Supabase checks access on join)."

---

# Self-review

## Spec coverage

| Spec | Requirement | Task(s) |
|---|---|---|
| §1 | Invite anyone (new or existing account) to one event with one role; nothing on any other event by any route (screen, realtime, direct API, TVs, Edge Functions); nothing widens on switch-over | 2.3 (invite), 1.1 to 1.3 (database routes, probe 132 matrix), 2.2 (transitions, delay), 2.4 (AI), 1.2 (TV pairing and rotating); realtime postgres_changes rides on the read policies (probe 132 header) |
| §2 | `leod_event_members` with role, active, invited_by, timestamps, one row per person and event | 1.1 |
| | Creator always director, computed, never stored | 1.1 (resolver, guard trigger), 2.1 (kept in the new trigger), 1.3 (guard `event_creator_never_member`, probe check 5 and 8) |
| | Members read their roster; all writes through server functions | 1.1 (policy, no grants), 1.3 (guard `event_members_server_writes_only`) |
| §3 | `cuedeck_event_role` per event | 1.1 |
| | Five inline policies and three functions rewritten; `eventRole()` in `_shared/transition.ts` | 1.1, 1.2, 2.2 |
| | Displays and sponsors: write director (and signage), pairing and rotating director or signage | 1.1, 1.2 |
| | Suspended members lose reads | 1.1 (policies), probes 130 check 4, 132 check 4, 095 update |
| | `validate_event_log_role` stamps the per-event role | 1.2 (probe 131 check 4) |
| | Guard: nothing outside the resolver reads `invited_by` | 1.3 (`cuedeck_guard_results`, probe 132 check 8 proves it fails), 3.4 (`tests/event-teams-no-invited-by.spec.ts` for code), 2.4 Step 6 grep |
| §4 | Invite from inside an event; new email: account, membership, branded invitation | 2.3, 3.4 |
| | Existing account: membership and "added to" email, no signup; same role no-op; other role changes | 2.3 (`invite-email.ts` console wording), 3.4 |
| | Who invites, changes, removes: creator and the event's directors; an invited director only on their events | 2.3, 2.1 (`cuedeck_event_team` for directors only) |
| | Change role, suspend, remove act on this event's membership; remove never bans; remove from all my events | 2.3, 3.4 |
| | Logged in the event's log: `MEMBER_INVITED`, `MEMBER_ROLE_CHANGED`, `MEMBER_SUSPENDED`, `MEMBER_REMOVED` (and `MEMBER_REACTIVATED`) | 2.3 |
| | 20 invitations per organiser per 24 h, per event owner | 2.3 |
| §5 | Switcher lists created and active-member events, grouped by organiser | 2.1 (`cuedeck_my_events`), 3.1, 3.3 |
| | Role per event on boot and every switch; role lock, director controls, presence role, crew list, View as follow it | 3.1 |
| | Team window per event with role, status, last seen | 2.1, 3.4 |
| | Members-only: no billing, no trial, no upsell | 3.2 |
| §6 | Invited people free, on the owner's plan, no trial, no billing, no upsell; the invited-director 3-day trial lockout ends | 1.2 (`get_subscription_for_user` own only), 2.1 (owner plan in `cuedeck_my_events`), 2.4 (AI), 3.2 |
| | Seats per event: Per-event 5, Starter 5, Pro 20, Enterprise and Trial unlimited; creator uses none; per event; active and suspended hold a seat | 2.1 (`cuedeck_plan_seats`, `cuedeck_event_seats_of`, probe 133 checks 1, 2) |
| | Enforced on the server in the invite function and the membership insert; "Team 7 of 20 seats"; owner "Upgrade for more seats", invited director "Ask the organiser for more seats" | 2.1 (trigger), 2.3 (pre-check, 23514 mapping), 3.4 |
| | Other limits (displays, reports, AI) from the event owner's plan | 3.2 (`applyEventPlan`), 2.4 |
| | Your own events use your plan; member events never count | 3.2 |
| | No trial for members-only; trial with their first own event | 3.2 |
| | Downgrade keeps members, blocks new invites | 2.1 (probe 133 check 3), 3.4 (e2e) |
| §7 | Backfill from `invited_by` | 1.1 (verified by count in 4.1 Step 8) |
| | `invited_by` and global role kept, unused for access | 1.1 to 2.4 (no reader left), 1.3 and 3.4 guards |
| | `checkin_staff` with console memberships not shut out | 3.1 |
| §8 | Security review before applying | 4.1 Step 3 |
| | Live probe: member of A refused on B for events, sessions, log, broadcasts, reports, displays, sponsors, stage messages, pairing, delays, transitions; realtime; suspended reads nothing; creator never demoted; one login on two organisers' events | 1.3 (probe 132), 2.2 (transitions) |
| | Console e2e: invite new and existing accounts, role switching on event switch, Team per event, remove keeps the login elsewhere, plan from the owner | 3.1, 3.2, 3.4 |
| | Existing suites green; old-model tests updated without weakening | 1.1 (095, 128, rls.spec), 1.2 (083, 093), 2.2 (session-auth), 2.3 (operators), 2.4 (ai-proxy-plan), 3.1 (harness, mock, show-safety switch test), 3.2 (session-people SP13), 3.4 (console-forbidden, ratchet budget) |
| §9.1 | Invited director edits the event and sessions; only the creator deletes the event and sees billing and webhooks | 1.1 (`events_director_update`, `leod_events_guard_member_update`; sessions already via the resolver; `owner_delete_events` and `owner_manage_webhooks` unchanged), 3.2 (billing for an account with its own plan), 3.3 |
| §9.2 | "Added to event" email; no founder welcome for members-only | 2.3, 2.1 (`handle_first_login`) |
| §9.3 | Switcher groups under the organiser's company name | 2.1 (`organiser`), 3.3 |
| Sherif's conditions (8 Oct) | Private channels: only an event's members join, track or read presence; postgres_changes keep working | 3.5 (migration 135, probe 135, e2e), 4.3 (setting, live script) |
| | Guard scheduled daily, runs recorded, alert on failing guard and on a missing or stale run (over 26 h), absence counts as failure, the watcher watched | 2.5 (migration 134, probe 134, `guard-alert` and `health-check-guards` tests), 4.1 Step 11 |
| §10 | Invited-director trial; suspended reads; `handle_first_login` caller id; wizard invite error | 3.2; 1.1; 2.1 (rewritten, so it takes `auth.uid()`); 3.4. `track_user_login()` (not attached) is unrelated and left alone. |

## Placeholder scan

Searched the plan for "TBD", "TODO", "implement later", "fill in", "similar to Task", "as needed", "handle edge cases" and "appropriate": none in instructions. Every code step carries the code; every test step carries the test code; every run step names the command and the expected result. Two places name a value the executor reads at run time on purpose: the new colour ratchet `BUDGET` (the printed count, Task 3.4 Step 7) and `N` (the backfill count, Task 4.1 Step 5).

## Type and name consistency

Checked across tasks:
- SQL: `leod_event_members(event_id, user_id, role, active, invited_by, created_at, updated_at)`; `cuedeck_event_role(uuid)`, `cuedeck_event_role_of(uuid, uuid)`, `leod_event_members_guard()` (1.1, replaced in 2.1 keeping its checks), `leod_events_guard_member_update()`, `cuedeck_guard_results()` with guards `event_access_not_via_invited_by`, `event_members_server_writes_only`, `event_creator_never_member`; `cuedeck_plan_seats(uuid)`, `cuedeck_event_seats_of(uuid) → {used, limit}`, `cuedeck_my_events() → (event_id, role, is_owner, owner_id, organiser, plan, plan_status, trial_ends_at)`, `cuedeck_event_team(uuid) → {is_owner, seats, owner, members[]}`; error messages `seats_full…`, `owner_not_member…` with SQLSTATE 23514. The console mock (3.1, 3.4) answers exactly these shapes; the operators stub (2.3) answers `cuedeck_event_seats_of` with `{used, limit}`.
- TypeScript: `_shared/members.ts` `MEMBER_ROLES`, `UUID` (2.2), `logMemberChange(sb, eventId, operatorId, action, payload)` (2.3); `eventRole(sb, userId, eventId)` unchanged signature (2.2) used by invite-operator, manage-operator and ai-proxy; `_shared/plan.ts` `aiAllowed(sub, now)`, `PlanRow`, `PAID_AI_PLANS` (2.4). invite-operator `result` values `invited | added | link_resent | unchanged | role_changed` and codes `seats_full | is_owner | already_on_event | invite_rate | not_console_event` match the console's `inviteOperator` and `inviteErrorText` (3.4). manage-operator `{ action, user_id, role?, event_id? }` matches `manageMember` (3.4) and the updated `console-forbidden` tests.
- Guards and realtime: `cuedeck_job_runs`, `cuedeck_run_guards()`, `cuedeck_guard_watch() → {ok, problems, checked_at}`, `cuedeck_cron_ok(text)`, job names `cuedeck-guards`, `cuedeck-guard-watch`, `cuedeck-guard-alert` (2.5, used the same way by the Edge Function, the probe and the health-check test); `cuedeck_topic_event(text)`, policies `cuedeck_event_channel_read`, `cuedeck_event_channel_presence`, topics `leod-ctrl-<id>` and `leod-signage-<id>` (3.5, matched by the console, the probe, the e2e test and `scripts/check-realtime-private.mjs`).
- Console: `S.myEvents`, `S.accountRole`, `loadMyEvents`, `applyEventRole`, `noteRoleForWelcome` (3.1); `S.ownPlanLimits`, `isMembersOnlyAccount`, `planEnded`, `ownPlanEnded`, `applyEventPlan`, `showPlanEndedScreen` (3.2); `evGroups` (3.3); `openUsersModal`, `refreshUsersModal`, `renderTeam`, `manageMember`, `armRemoveMember`, `inviteOperator`, `inviteErrorText`, `setTeamStatus`, `TEAM_ROLES`, `_teamData`, `_operatorsData` (3.4). Removed names (`loadPendingBadge`, `approveUser`, `manageOperator`, `confirmRemoveUser`, `renderOperatorRows`, `filterOperators`, `S.operatorCount`, `#users-badge`) are grepped for in 3.4 Step 5. No local variable is named `t`.
- i18n: 2 (3.1) + 4 (3.2) + 4 (3.3) + 43 (3.4) keys, each in en, ar, pl, de with the same placeholders; every test that asserts English text quotes the en value exactly.
- Test names quoted in Review Focus exist verbatim in their tasks: probe 131 check 4, `a global director who is stage on this event cannot cancel`, `teams: the role follows the event, both ways`, `teams: presence tracks the role on the current event`, `teams: an event you were removed from is dropped on switch`, probe 133 checks 3 and 5, `invite: a seat taken while inviting (23514) withdraws the new account`, `invite: an existing email typed in another case joins that account`, `team: over the seat count after a downgrade`.

## Review Focus check

For each input class the spec implies, a test exists in the owning task: global role versus event role (1.2, 2.2, 3.1); switching between organisers and removal mid-session (3.1, probe 132 check 6); the last seat raced (2.1, 2.3); existing account typed differently (2.3); downgrade below team size (2.1, 3.4). Also covered though not in the five: a check-in staff login with a console membership (3.1), an organiser plan that ended (3.2), a refused event edit that used to look saved (3.3), a removed member's other events (2.3, 3.4), a concurrent second add of the same person (2.3), the creator invited to their own event (2.3).

## Spec ambiguities resolved

1. **Release order.** Stage 1 cannot ship alone (the old invite function would create crew with no access), so Release A ships stages 1 and 2 together and Release B the console. Release A keeps the live console working: it sends `event_id` on invites, its team list is rewritten on memberships, and `manage-operator` without `event_id` acts on the caller's own events.
2. **The creator half of `owner_read_events`** stays as `created_by = auth.uid()` next to the resolver, because an `INSERT … RETURNING` of a new event is checked in the statement that inserts it, which the resolver cannot see (probe 130 check 7).
3. **Displays and sponsors reads:** any member of the event reads; director and signage write, pair and rotate (the console's signage panel is for those two roles).
4. **Invited director and the event row:** may edit details (name, date, venue, times, brand); may not change the owner, origin or active flag (the console's "delete" is deactivate); nobody may give an event away.
5. **Same email, other role on the event:** the role is changed (spec §4), unlike check-in's 409; nothing is emailed for a role change.
6. **Seats when there is no subscription row:** treated as a trial (no limit), as the console creates an organiser's trial on first boot; an ended trial, `expired` or `canceled` seats nobody new; an unknown plan name seats nobody new.
7. **An event whose organiser's plan ended:** the console opens the first event whose plan has not ended; switching to an ended one is refused with who to ask; when every event has ended, an organiser sees the plans and a members-only account sees a screen with no prices. Today a member was locked out entirely when the owner's plan ended; this keeps the lock per event.
8. **Members-only account:** at least one membership, no own event, no own subscription. An account with no event and no membership at all (a new signup, or someone removed from every team) is treated as a new organiser and gets the trial at boot, as today.
9. **"Remove from all my events"** means every event the caller created (the creator's action), and is also what an older console's call without `event_id` does.
10. **Log role for rows without an event** (account-level) keeps the account role, as before; rows with an event get the role on it.
11. **`MEMBER_REACTIVATED`** is logged too ("every change is logged"), though the spec lists four names.
12. **The profile panel's "Operators" usage bar** is removed: seats are per event and shown in the Team window.
13. **New event for everyone:** anyone signed in may create their own event (on their own plan); before, only accounts with the global director role saw the button.
14. **Console invites to check-in events** are refused (`not_console_event`): check-in has its own staff invitations (owned by the other session).
15. **The guard's home:** `cuedeck_guard_results()`, a console guard function, not `checkin_guard_results()` (owned and rewritten whole by the check-in session). Its function check is by exclusion with four named non-access readers.
16. **Realtime presence** is closed in three steps (Task 3.5, Release C): policies on `realtime.messages`, the console on private channels, then Sherif turns off "Allow public access". The last step waits for check-in's two public channels to go private, because the setting is project-wide. Policies are cached per connection (Supabase docs), so a member removed mid-session keeps an already open channel until they switch event or reload.
17. **`handle_first_login(p_user_id)`** keeps its argument for the console's call shape but now refuses any id other than the caller's, because it is rewritten here and the rule since 079 applies.
18. **The guard's schedule and alert route (Task 2.5).** `leod_checkin_job_runs` and the AVE Brain watcher (`checkin_brain_signals`) are check-in-owned, so runs go to a console table, `cuedeck_job_runs`, and alerts take the project's existing alert email route (`_shared/resend.ts` to `BILLING_ALERT_EMAIL`, as stripe-webhook's billing alerts). pg_cron and the Vercel health-check cron watch each other; both stopping together is the one case nothing reports.
