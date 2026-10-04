# Check-in Roles, Dashboard and Event-Day Intelligence (features 1-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every person on a check-in event one of five roles (Owner, Organizer, Desk lead, Desk staff, Viewer) enforced in Postgres and the Edge Functions, add a live read-only check-in dashboard with five charts, and add desk health, pace and staffing advice, and a full-screen client view.

**Architecture:** Roles live in two existing places only: `leod_events.created_by` (owner) and `leod_checkin_operators.role` (widened to `organizer, lead, crew, viewer, api_consumer`). One permission table, written once as a pure module (`supabase/functions/_shared/checkin-roles.ts`, browser copy `/checkin-roles.js`, parity-tested), decides every server gate and every hidden control. All dashboard numbers come from one SECURITY DEFINER function, `checkin_event_stats(event_id)`, that returns counts and labels only; desks report through `checkin_desk_heartbeat`. Pure shaping (tiles, chart data, pace, desk state, gap text) lives in `/checkin-dashboard.js` and is unit-tested; pages only render it.

**Tech Stack:** Vanilla HTML/JS, supabase-js v2 via CDN (pinned 2.117.2 with SRI on new pages), Chart.js 4.5.1 (pinned, SRI), Supabase Postgres + Deno Edge Functions, vitest (`npm test`), Playwright with mocked Supabase (`npx playwright test`), `deno check`.

**Spec:** `docs/superpowers/specs/2026-10-04-checkin-roles-design.md` (all of it) and `docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md` (features 1, 2 and 3 only; features 4, 5 and 6 are out of scope for this plan). Executors read both before starting a task.

## Global Constraints

- Supabase project ref `sawekpguemzvuvvulfbc`. The live database is the source of truth; `supabase/migrations/` cannot rebuild it. Migrations in this plan are **070, 071, 072, 073** only. Never use 074 to 079 (075+ belong to a parallel plan).
- Each migration is applied by the executor of the task that writes it, with the Supabase MCP `apply_migration` (name without the number prefix, e.g. `checkin_roles`), and then verified with its probe file run through `execute_sql`. `execute_sql` accepts ONE statement per call (the `sql-one-statement.py` hook blocks more); every probe is a single `DO` block.
- Probes end in `RAISE EXCEPTION 'PROBE OK ...'` so that everything they inserted rolls back. Expected result of a probe run is an error whose message starts with `PROBE OK`. Any message starting `PROBE FAIL`, or any other error, is a failed task.
- SECURITY DEFINER functions: identity from `auth.uid()` only, never a caller-supplied user id; `SET search_path = public`; `REVOKE ALL ... FROM PUBLIC, anon` then `GRANT EXECUTE ... TO authenticated` (or `TO service_role` only, where a task says so).
- supabase-js never throws: every call destructures `{ data, error }` (or `{ error }`) and handles `error`. Never `.catch()` a supabase-js call.
- Edge Functions: `corsHeaders(req)` is a function; call it once and spread the result. The service-role client bypasses RLS, so every function re-checks the caller's role with `loadCallerRole()` + `can()` from `_shared/checkin-roles.ts` and re-checks the entitlement.
- Commit before deploying an Edge Function (`claim-guards.py` blocks deploys with uncommitted source). Deploy with `bash scripts/deploy-functions.sh <name...>`.
- Stage explicit file paths only. Never `git add .`, `git add -A` or a directory. Other sessions share this repo.
- Do not push to any remote until Task 15. The `cuedeck` remote auto-deploys the pages to production.
- Copy rules for anything a user reads: no em-dashes, no emoji, English only, sentence case. Data reaches the DOM through `textContent` / `createElement`, never `innerHTML`.
- No invented numbers on screen. Pace, rate and staffing lines appear only when measured; below the threshold the screen says `Pace appears after the first 10 check-ins.`
- Chart.js tag, exactly: `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>`. Never a floating `@4`.
- supabase-js tag on new pages, exactly as the home and setup pages use it: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js" integrity="sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok" crossorigin="anonymous"></script>`.
- Every new static file the browser loads is added to `.vercelignore` as `!/<file>` and to `MUST_200` in `scripts/verify-no-public-internals.sh`; every new page also gets a rewrite in `vercel.json`.
- Browser modules are referenced with absolute paths (`/checkin-roles.js`) from pages, because pages live under `/checkin/...`. Modules import each other with relative paths (`./checkin-window.js`) so vitest can import them too.
- Role names on screen: `Owner`, `Organizer`, `Desk lead`, `Desk staff`, `Viewer` (from `roleLabel()`).
- Thresholds (from the event-day spec): desk online = seen within the last **90 s** (89 online, 91 offline); late sync = `received_at - scanned_at > 60 s`; pace needs **10** check-ins and a desk with **5** active minutes; staffing warning when the 15-minute arrival rate is above **90%** of capacity for **10** consecutive minutes; dashboard refresh **30 s**; desk heartbeat **30 s**.
- Never trigger auth emails on the owner's account (`sherif.mka@gmail.com`). Live checks use throwaway accounts on `cuedeck-test.io`, created without email (Task 15).

## Review Focus

1. **A shared desk laptop changes hands.** Crew member A checks people in, signs out; crew member B signs in on the same laptop. B must not see Undo on A's check-ins, and if B somehow sends one the server records `forbidden`. Pinned in Task 1 (`ownCheckins` only counts the signed-in user's outbox items) and Task 3 (probe: crew undo of another operator's check-in is `forbidden`).
2. **A test-mode event whose test check-ins are spread over days before the event.** The arrivals chart must not try to draw hundreds of empty 15-minute bars. Pinned in Task 8 (`arrivalSeries` keeps the latest 96 buckets and carries the earlier total into the cumulative line).
3. **An event with nobody on the list yet.** Turnout must not divide by zero or show `NaN%`; tiles read `0` and `No guests yet`. Pinned in Task 8 (`tiles` with `registered = 0`) and Task 9 (the page reads `No guests yet` and never `NaN`).
4. **A viewer who types the desk or setup URL.** They land on the dashboard client view, and the server refuses them anyway (no attendee rows, heartbeat refused). Pinned in Task 2 probe (viewer reads zero attendee, scan, device rows), Task 3 probe (viewer heartbeat refused), Task 12 and Task 13 browser checks (redirects).
5. **Ownership transfer while the event is complimentary, or to a complimentary account.** The confirm text must say the complimentary status moves with the owner. Pinned in Task 1 (`transferNote` cases) and Task 12 (owner tools render the note).

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `supabase/functions/_shared/checkin-roles.ts` | Create | Five roles, permission table, `can`, `effectiveRole`, `invitableRoles`, `removeVerdict`, `loadCallerRole`, `isUuid` |
| `checkin-roles.js` | Create | Browser copy of the above (no `loadCallerRole`) plus `ROLE_HELP`, `mayUndo`, `ownCheckins`, `transferNote` |
| `tests/checkin-roles.spec.ts` | Create | Permission table, parity between the two copies, gate helpers |
| `supabase/migrations/070_checkin_roles.sql` | Create | CHECK widening, `checkin_is_owner`, 13 policy rewrites, `checkin_my_events` (five roles), `checkin_update_event_details` |
| `supabase/migrations/071_checkin_desks.sql` | Create | `scan_events.desk_id`, `leod_checkin_desks`, `checkin_desk_heartbeat`, `checkin_apply_scan` (undo-own, desk id) |
| `supabase/migrations/072_checkin_event_stats.sql` | Create | `checkin_event_stats(event_id)` |
| `supabase/migrations/073_checkin_my_events_owner.sql` | Create | `checkin_my_events` reports the owner as `owner` |
| `tests/sql/070-roles-probe.sql`, `071-desks-probe.sql`, `072-stats-probe.sql`, `073-owner-probe.sql` | Create | Rolled-back DO-block probes, run through `execute_sql` |
| `tests/checkin-rls.spec.ts` | Modify | Policy model extended to lead and viewer |
| `supabase/functions/checkin-create-checkout/index.ts` | Modify | Owner only |
| `supabase/functions/checkin-enable-event/index.ts` | Modify | Test setup owner or organizer; comp go-live owner only |
| `supabase/functions/checkin-import-attendees/index.ts` | Modify | `manage_guests` gate |
| `supabase/functions/checkin-send-qr-emails/index.ts` | Modify | `manage_guests` gate |
| `supabase/functions/checkin-kiosk-pair/index.ts` | Modify | Organizer or lead |
| `supabase/functions/checkin-record-scans/index.ts` | Modify | Organizer, lead or crew; passes `desk_id` |
| `supabase/functions/checkin-invite-staff/index.ts` | Rewrite | Five roles, lead limits, `transfer_owner`, `archive_event` |
| `supabase/functions/_shared/checkin-walk-in.ts` | Create | Pure walk-in validation |
| `supabase/functions/checkin-add-walk-in/index.ts` | Create | Desk walk-ins (`source = 'walk_in'`) |
| `tests/checkin-function-gates.spec.ts` | Create | Each function gates through the shared module |
| `tests/checkin-staff.spec.ts` | Modify | Uses the shared `removeVerdict` |
| `tests/checkin-walk-in.spec.ts` | Create | Walk-in validation |
| `scripts/deploy-functions.sh` | Modify | Adds `checkin-add-walk-in` |
| `checkin-dashboard.js` | Create | Pure: tiles, chart data, rate, pace messages, desk state, gap lines, event start |
| `tests/checkin-dashboard.spec.ts` | Create | Unit tests for the above |
| `cuedeck-checkin-dashboard.html` | Create | `/checkin/dashboard`: tiles, five charts, client view, desk panel |
| `tests/e2e/checkin-mock.ts` | Create | Playwright helpers: fake session, mocked RPC, table and function routes |
| `tests/e2e/checkin-dashboard.spec.ts`, `checkin-home-roles.spec.ts`, `checkin-setup-roles.spec.ts`, `checkin-desk-roles.spec.ts` | Create | Mocked-browser checks per page |
| `cuedeck-checkin-home.html` | Modify | Role label, viewer cards, Dashboard links |
| `cuedeck-checkin-setup.html` | Modify | Role-aware steps, staff roles, owner tools, go-live owner rule, details via RPC |
| `cuedeck-checkin.html` | Modify | Role helpers, undo-own, walk-ins, kiosk for leads, desk id, heartbeat, `forbidden` handling |
| `checkin-app.css` | Modify | `.role-l` card label |
| `vercel.json`, `.vercelignore`, `scripts/verify-no-public-internals.sh` | Modify | New page and modules served |
| `scripts/seed-checkin-roles.mjs` | Create | Task 15 live check: five throwaway accounts on one test event, and cleanup |

## Shared facts every task relies on

- `checkin_role_for_event(event_id)` returns the caller's operator role only while the event has `leod_checkin_entitlements.checkin_core = true`. It is used by RLS and SQL functions. Edge Functions use `loadCallerRole()` instead (the service-role connection has no `auth.uid()`).
- The owner always also holds an `organizer` operator row (trigger `checkin_auto_grant_organizer`). `effectiveRole(opRole, isOwner)` turns that into `owner`.
- `checkin_my_events()` returns `(event_id, name, date, venue, timezone, event_start, event_end, created_via, is_owner, role, status, attendees, arrived, test_used, is_comp)`. Pages always compute the role as `effectiveRole(row.role, row.is_owner)`, so they work before and after migration 073 changes `role` to `owner` for owners.
- Check-in window: `checkinWindow(date, tz)` in `/checkin-window.js` (date minus 7 days to date plus 3 days, local midnight). `isWindowClosed(date, tz)` switches the dashboard from "Still expected" to "No-shows".
- Local test server for Playwright: from the repo root, `python3 -m http.server 7230 --bind 127.0.0.1` (run it in the background once; `playwright.config.ts` does not start it). Pages are opened by file name (`/cuedeck-checkin-dashboard.html?event=...`) because the Python server has no rewrites.

---
## Controller rulings (2026-10-04; these override task text where they conflict)

1. **Comp go-live is owner only, admins included** (roles spec ruling 1 taken literally). An admin who needs a comp event live asks the owner. Cost if wrong: one extra step for support.
2. **No scripted sign-ins on production.** Task 15's live role check does NOT sign in throwaway accounts on app.cuedeck.io (signing in with passwords on a live site is outside what the controller may do, and Turnstile will block it). Instead: (a) database role behaviour is proven by rolled-back SQL probes that impersonate each role via `set_config('request.jwt.claims', ...)` + `SET LOCAL ROLE authenticated`; (b) Edge Function gates by their deno/vitest tests; (c) one browser pass per role is offered to Sherif, signed in by him. Task 15 creates no accounts.
3. **Pushes are Sherif's.** Wherever Task 15 says push, the executor stops and asks Sherif to run `! git -C ~/AVE-Production-Console push cuedeck main` and `push origin main`, then verifies serving from a browser (scripted curl is challenged by Vercel; `scripts/verify-no-public-internals.sh` exits 2 when blocked).
4. **Worktree:** the plan executes in `/Users/sheriff/AVE-Production-Console-roles` on branch `feat/checkin-roles-dashboard` cut from `main`; Task 15 merges it into `main` only after the final review, before the push.
5. **Edge Function deploys (Tasks 5-7) happen from the worktree** after commit, and must stay compatible with the pages currently live (old pages send `role` values `organizer`/`crew` only). The plan's 070-keeps-owner-as-organizer sequencing is kept for the same reason.

### Task 1: The role and permission module (server and browser copies)

**Files:**
- Create: `supabase/functions/_shared/checkin-roles.ts`
- Create: `checkin-roles.js`
- Create: `tests/checkin-roles.spec.ts`
- Modify: `.vercelignore` (allow `/checkin-roles.js`)
- Modify: `scripts/verify-no-public-internals.sh` (`MUST_200` gains `/checkin-roles.js`)

**Interfaces:**
- Consumes: nothing.
- Produces (both copies unless marked):
  - `type CheckinRole = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer'`; `type GrantRole = 'organizer' | 'lead' | 'crew' | 'viewer'`
  - `type Permission = 'go_live' | 'transfer_owner' | 'archive_event' | 'edit_details' | 'manage_guests' | 'test_setup' | 'export' | 'invite_any' | 'invite_crew' | 'kiosk' | 'walk_in' | 'undo_any' | 'desk_health' | 'desk' | 'dashboard'`
  - `ROLES: CheckinRole[]`, `GRANT_ROLES: GrantRole[]`, `GRANTS: Record<Permission, CheckinRole[]>`
  - `effectiveRole(opRole: string | null | undefined, isOwner: boolean): CheckinRole | null`
  - `can(role: CheckinRole | null | undefined, perm: Permission): boolean`
  - `invitableRoles(role): GrantRole[]`
  - `removeVerdict(caller, targetId: string, ownerId: string | null, ops: {user_id: string, role: string}[]): { ok: true } | { ok: false, code: 'forbidden' | 'not_found' | 'event_owner' | 'last_organizer' }`
  - `roleLabel(role): string`
  - `isUuid(v: unknown): boolean`
  - server only: `loadCallerRole(sb, eventId: string, userId: string): Promise<{ role: CheckinRole | null; ownerId: string | null; error: string | null }>`
  - browser only: `ROLE_HELP: Record<GrantRole, string>`, `ownCheckins(outbox, userId, eventId): Map<attendeeId, scannedAtIso>`, `mayUndo(role, attendee, own: Map): boolean`, `transferNote(eventIsComp: boolean, targetIsComp: boolean, isLive: boolean): string`

- [ ] **Step 1: Write the failing test**

Create `tests/checkin-roles.spec.ts`:

```ts
// tests/checkin-roles.spec.ts
// The approved permission table (docs/superpowers/specs/2026-10-04-checkin-roles-design.md)
// and parity between the server copy (supabase/functions/_shared/checkin-roles.ts)
// and the browser copy (/checkin-roles.js). Both are imported for real.
import { describe, it, expect } from 'vitest';
import * as server from '../supabase/functions/_shared/checkin-roles.ts';
import * as browser from '../checkin-roles.js';

type Role = server.CheckinRole;
const ROLES: Role[] = ['owner', 'organizer', 'lead', 'crew', 'viewer'];

// One row per line of the approved table, plus the three screen-only permissions.
const TABLE: [server.Permission, Role[]][] = [
  ['go_live',        ['owner']],
  ['transfer_owner', ['owner']],
  ['archive_event',  ['owner']],
  ['edit_details',   ['owner', 'organizer']],
  ['manage_guests',  ['owner', 'organizer']],
  ['test_setup',     ['owner', 'organizer']],
  ['export',         ['owner', 'organizer']],
  ['invite_any',     ['owner', 'organizer']],
  ['invite_crew',    ['owner', 'organizer', 'lead']],
  ['kiosk',          ['owner', 'organizer', 'lead']],
  ['walk_in',        ['owner', 'organizer', 'lead']],
  ['undo_any',       ['owner', 'organizer', 'lead']],
  ['desk_health',    ['owner', 'organizer', 'lead']],
  ['desk',           ['owner', 'organizer', 'lead', 'crew']],
  ['dashboard',      ['owner', 'organizer', 'lead', 'crew', 'viewer']],
];

describe('permission table', () => {
  it('covers every permission exactly once', () => {
    expect(TABLE.map(r => r[0]).sort()).toEqual(Object.keys(server.GRANTS).sort());
  });
  for (const [perm, allowed] of TABLE) {
    for (const role of ROLES) {
      it(`${role} ${allowed.includes(role) ? 'may' : 'may not'} ${perm}`, () => {
        expect(server.can(role, perm)).toBe(allowed.includes(role));
      });
    }
    it(`nobody without a role may ${perm}`, () => {
      expect(server.can(null, perm)).toBe(false);
      expect(server.can(undefined, perm)).toBe(false);
      expect(server.can('api_consumer' as Role, perm)).toBe(false);
    });
  }
});

describe('browser copy agrees with the server', () => {
  for (const [perm] of TABLE) {
    for (const role of [...ROLES, null, 'api_consumer']) {
      it(`can(${role}, ${perm})`, () => {
        expect(browser.can(role, perm)).toBe(server.can(role as Role, perm));
      });
    }
  }
  it.each([
    ['organizer', true], ['organizer', false], ['lead', false], ['crew', false], ['viewer', false],
    ['api_consumer', false], [null, true], [null, false], ['owner', false],
  ] as [string | null, boolean][])('effectiveRole(%s, %s)', (op, owner) => {
    expect(browser.effectiveRole(op, owner)).toBe(server.effectiveRole(op, owner));
  });
  it.each(ROLES)('invitableRoles(%s) and roleLabel(%s)', (r) => {
    expect(browser.invitableRoles(r)).toEqual(server.invitableRoles(r));
    expect(browser.roleLabel(r)).toBe(server.roleLabel(r));
  });
});

describe('effectiveRole', () => {
  it('the owner is owner whatever their operator row says', () => {
    expect(server.effectiveRole('organizer', true)).toBe('owner');
    expect(server.effectiveRole(null, true)).toBe('owner');
  });
  it('accepts the owner value migration 073 reports', () => {
    expect(server.effectiveRole('owner', false)).toBe('owner');
  });
  it('keeps the four grant roles and drops anything else', () => {
    for (const r of ['organizer', 'lead', 'crew', 'viewer']) expect(server.effectiveRole(r, false)).toBe(r);
    expect(server.effectiveRole('api_consumer', false)).toBeNull();
    expect(server.effectiveRole('', false)).toBeNull();
    expect(server.effectiveRole(undefined, false)).toBeNull();
  });
});

describe('invitableRoles', () => {
  it('office roles invite any grant role', () => {
    expect(server.invitableRoles('owner')).toEqual(['organizer', 'lead', 'crew', 'viewer']);
    expect(server.invitableRoles('organizer')).toEqual(['organizer', 'lead', 'crew', 'viewer']);
  });
  it('a desk lead invites desk staff only', () => { expect(server.invitableRoles('lead')).toEqual(['crew']); });
  it('desk staff and viewers invite nobody', () => {
    expect(server.invitableRoles('crew')).toEqual([]);
    expect(server.invitableRoles('viewer')).toEqual([]);
    expect(server.invitableRoles(null)).toEqual([]);
  });
});

describe('removeVerdict', () => {
  const ops = [
    { user_id: 'owner', role: 'organizer' }, { user_id: 'co', role: 'organizer' },
    { user_id: 'lead1', role: 'lead' }, { user_id: 'crew1', role: 'crew' }, { user_id: 'view1', role: 'viewer' },
  ];
  it('nobody removes the owner', () => {
    expect(server.removeVerdict('organizer', 'owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' });
    expect(server.removeVerdict('owner', 'owner', 'owner', ops)).toEqual({ ok: false, code: 'event_owner' });
  });
  it('an organizer removes another organizer while one remains', () => {
    expect(server.removeVerdict('organizer', 'co', 'owner', ops)).toEqual({ ok: true });
  });
  it('keeps the last organizer', () => {
    expect(server.removeVerdict('owner', 'co', null, [{ user_id: 'co', role: 'organizer' }])).toEqual({ ok: false, code: 'last_organizer' });
  });
  it('a lead removes desk staff and nobody else', () => {
    expect(server.removeVerdict('lead', 'crew1', 'owner', ops)).toEqual({ ok: true });
    expect(server.removeVerdict('lead', 'co', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('lead', 'view1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('lead', 'lead1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
  });
  it('desk staff and viewers remove nobody', () => {
    expect(server.removeVerdict('crew', 'crew1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
    expect(server.removeVerdict('viewer', 'crew1', 'owner', ops)).toEqual({ ok: false, code: 'forbidden' });
  });
  it('reports a person who is not on the event', () => {
    expect(server.removeVerdict('organizer', 'ghost', 'owner', ops)).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('roleLabel', () => {
  it('uses the approved names', () => {
    expect(ROLES.map(r => server.roleLabel(r))).toEqual(['Owner', 'Organizer', 'Desk lead', 'Desk staff', 'Viewer']);
    expect(server.roleLabel(null)).toBe('No access');
  });
});

// A fake supabase-js client: from(table).select().eq().eq().maybeSingle()
function fakeSb(rows: Record<string, { data: unknown; error: { message: string } | null }>) {
  return {
    from(t: string) {
      const r = rows[t] ?? { data: null, error: null };
      const q = { select: () => q, eq: () => q, maybeSingle: async () => r };
      return q;
    },
  };
}
const EV = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

describe('loadCallerRole', () => {
  it('the creator is owner', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: ME }, error: null }, leod_checkin_operators: { data: { role: 'organizer' }, error: null } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: 'owner', ownerId: ME, error: null });
  });
  it('an operator row gives its role', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: 'someone' }, error: null }, leod_checkin_operators: { data: { role: 'lead' }, error: null } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: 'lead', ownerId: 'someone', error: null });
  });
  it('no row means no role', async () => {
    const sb = fakeSb({ leod_events: { data: { created_by: 'someone' }, error: null } });
    expect((await server.loadCallerRole(sb, EV, ME)).role).toBeNull();
  });
  it('an unknown event means no role', async () => {
    expect((await server.loadCallerRole(fakeSb({}), EV, ME)).role).toBeNull();
  });
  it('a malformed event id is refused before any query', async () => {
    const sb = { from() { throw new Error('must not query'); } };
    expect(await server.loadCallerRole(sb, 'not-a-uuid', ME)).toEqual({ role: null, ownerId: null, error: null });
  });
  it('a database error is reported, never read as "no role"', async () => {
    const sb = fakeSb({ leod_events: { data: null, error: { message: 'boom' } } });
    expect(await server.loadCallerRole(sb, EV, ME)).toEqual({ role: null, ownerId: null, error: 'boom' });
  });
});

describe('ownCheckins and mayUndo (desk, ruling 8)', () => {
  const T = '2026-10-18T08:00:00.000Z';
  const outbox = [
    { client_id: 'a', event_id: 'E', attendee_id: 'p1', action: 'checkin', scanned_at: T, operator_id: 'me', synced: true, result: 'ok' },
    { client_id: 'b', event_id: 'E', attendee_id: 'p2', action: 'checkin', scanned_at: T, operator_id: 'other', synced: true, result: 'ok' },
    { client_id: 'c', event_id: 'X', attendee_id: 'p3', action: 'checkin', scanned_at: T, operator_id: 'me', synced: false },
    { client_id: 'd', event_id: 'E', attendee_id: 'p4', action: 'checkin', scanned_at: T, operator_id: 'me', synced: true, result: 'duplicate' },
    { client_id: 'e', event_id: 'E', attendee_id: 'p5', action: 'checkin', scanned_at: T, synced: false },
  ];
  const own = browser.ownCheckins(outbox, 'me', 'E');
  it('counts only this user, this event, and check-ins the server did not refuse', () => {
    expect([...own.keys()]).toEqual(['p1']);
  });
  it('an item queued before operator ids existed belongs to nobody', () => {
    expect(own.has('p5')).toBe(false);
  });
  it('keeps the latest check-in per person', () => {
    const later = '2026-10-18T09:00:00.000Z';
    const m = browser.ownCheckins([...outbox, { client_id: 'f', event_id: 'E', attendee_id: 'p1', action: 'checkin', scanned_at: later, operator_id: 'me', synced: false }], 'me', 'E');
    expect(m.get('p1')).toBe(later);
  });
  it('desk staff undo their own check-in only', () => {
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: T }, own)).toBe(true);
    expect(browser.mayUndo('crew', { id: 'p2', checked_in_at: T }, own)).toBe(false);
  });
  it('desk staff cannot undo once someone else checked the person in again', () => {
    expect(browser.mayUndo('crew', { id: 'p1', checked_in_at: '2026-10-18T10:00:00.000Z' }, own)).toBe(false);
  });
  it('leads and above undo anyone', () => {
    for (const r of ['owner', 'organizer', 'lead']) expect(browser.mayUndo(r, { id: 'p2', checked_in_at: T }, own)).toBe(true);
  });
  it('nobody undoes a person who is not checked in, and viewers undo nothing', () => {
    expect(browser.mayUndo('lead', { id: 'p2', checked_in_at: null }, own)).toBe(false);
    expect(browser.mayUndo('viewer', { id: 'p1', checked_in_at: T }, own)).toBe(false);
  });
});

describe('transferNote (ruling 3)', () => {
  it('says nothing when complimentary status does not change, or the event is live', () => {
    expect(browser.transferNote(false, false, false)).toBe('');
    expect(browser.transferNote(true, true, false)).toBe('');
    expect(browser.transferNote(true, false, true)).toBe('');
  });
  it('warns when the event stops being complimentary', () => {
    expect(browser.transferNote(true, false, false)).toBe(' This event is complimentary because your account is. After the transfer it will need paying for before it can go live.');
  });
  it('says when the event becomes complimentary', () => {
    expect(browser.transferNote(false, true, false)).toBe(' This event will become complimentary, because their account is.');
  });
});

describe('ROLE_HELP', () => {
  it('describes every grant role in plain words without dashes', () => {
    for (const r of ['organizer', 'lead', 'crew', 'viewer']) {
      expect(browser.ROLE_HELP[r]).toMatch(/^[A-Z].*\.$/);
      expect(browser.ROLE_HELP[r]).not.toMatch(/[–—]/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/checkin-roles.spec.ts`
Expected: FAIL, `Failed to resolve import "../supabase/functions/_shared/checkin-roles.ts"`.

- [ ] **Step 3: Write the server module**

Create `supabase/functions/_shared/checkin-roles.ts`:

```ts
// supabase/functions/_shared/checkin-roles.ts
// The five check-in roles and what each may do. Server copy; the browser
// copy is /checkin-roles.js and tests/checkin-roles.spec.ts runs both over
// the same table, so drift fails there.
// Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md
//
// Ownership is never an operator row: it is leod_events.created_by. The
// owner also holds an 'organizer' row (trigger checkin_auto_grant_organizer),
// which effectiveRole() turns into 'owner'.

export type CheckinRole = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer'
export type GrantRole = 'organizer' | 'lead' | 'crew' | 'viewer'
export type Permission =
  | 'go_live' | 'transfer_owner' | 'archive_event'
  | 'edit_details' | 'manage_guests' | 'test_setup' | 'export' | 'invite_any'
  | 'invite_crew' | 'kiosk' | 'walk_in' | 'undo_any' | 'desk_health'
  | 'desk' | 'dashboard'

export const ROLES: CheckinRole[] = ['owner', 'organizer', 'lead', 'crew', 'viewer']
export const GRANT_ROLES: GrantRole[] = ['organizer', 'lead', 'crew', 'viewer']

const OFFICE: CheckinRole[] = ['owner', 'organizer']
const LEADS: CheckinRole[] = ['owner', 'organizer', 'lead']

export const GRANTS: Record<Permission, CheckinRole[]> = {
  go_live: ['owner'],            // pay or comp go-live, purchases and invoices
  transfer_owner: ['owner'],
  archive_event: ['owner'],      // "Delete event" (ruling 2)
  edit_details: OFFICE,
  manage_guests: OFFICE,         // import guests, send QR emails
  test_setup: OFFICE,            // enable test mode, event settings, Setup page
  export: OFFICE,                // attendee CSV (ruling 4: a screen permission)
  invite_any: OFFICE,
  invite_crew: LEADS,            // leads invite and remove desk staff only
  kiosk: LEADS,
  walk_in: LEADS,
  undo_any: LEADS,
  desk_health: LEADS,            // desk panel and staffing advice (people data)
  desk: ['owner', 'organizer', 'lead', 'crew'],
  dashboard: ['owner', 'organizer', 'lead', 'crew', 'viewer'],
}

export function effectiveRole(opRole: string | null | undefined, isOwner: boolean): CheckinRole | null {
  if (isOwner || opRole === 'owner') return 'owner'
  return opRole === 'organizer' || opRole === 'lead' || opRole === 'crew' || opRole === 'viewer' ? opRole : null
}

export function can(role: CheckinRole | null | undefined, perm: Permission): boolean {
  return !!role && (GRANTS[perm] ?? []).includes(role)
}

export function invitableRoles(role: CheckinRole | null | undefined): GrantRole[] {
  if (can(role, 'invite_any')) return [...GRANT_ROLES]
  if (can(role, 'invite_crew')) return ['crew']
  return []
}

export type RemoveVerdict =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'not_found' | 'event_owner' | 'last_organizer' }

export function removeVerdict(
  caller: CheckinRole | null | undefined,
  targetId: string,
  ownerId: string | null,
  ops: { user_id: string; role: string }[],
): RemoveVerdict {
  if (!can(caller, 'invite_crew')) return { ok: false, code: 'forbidden' }
  const row = ops.find(o => o.user_id === targetId)
  if (!row) return { ok: false, code: 'not_found' }
  if (targetId === ownerId) return { ok: false, code: 'event_owner' }
  if (!can(caller, 'invite_any') && row.role !== 'crew') return { ok: false, code: 'forbidden' }
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) {
    return { ok: false, code: 'last_organizer' }
  }
  return { ok: true }
}

const LABELS: Record<CheckinRole, string> = {
  owner: 'Owner', organizer: 'Organizer', lead: 'Desk lead', crew: 'Desk staff', viewer: 'Viewer',
}
export function roleLabel(role: CheckinRole | null | undefined): string {
  return role ? LABELS[role] : 'No access'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export type CallerRole = { role: CheckinRole | null; ownerId: string | null; error: string | null }

// Reads the caller's role with the service-role client. A database error is
// returned as `error`, never folded into "no role", so a 500 is not reported
// to the caller as a 403.
// deno-lint-ignore no-explicit-any
export async function loadCallerRole(sb: any, eventId: string, userId: string): Promise<CallerRole> {
  if (!isUuid(eventId)) return { role: null, ownerId: null, error: null }
  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('created_by').eq('id', eventId).maybeSingle()
  if (evErr) return { role: null, ownerId: null, error: evErr.message }
  if (!ev) return { role: null, ownerId: null, error: null }
  const { data: op, error: opErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', eventId).eq('user_id', userId).maybeSingle()
  if (opErr) return { role: null, ownerId: null, error: opErr.message }
  const ownerId: string | null = ev.created_by ?? null
  return { role: effectiveRole(op?.role ?? null, ownerId !== null && ownerId === userId), ownerId, error: null }
}
```

- [ ] **Step 4: Write the browser module**

Create `checkin-roles.js`:

```js
// checkin-roles.js: browser copy of the check-in role table.
// Server copy: supabase/functions/_shared/checkin-roles.ts. The server
// decides; pages use this only to hide controls a role cannot use.
// tests/checkin-roles.spec.ts runs both copies over the same table.

export const ROLES = ['owner', 'organizer', 'lead', 'crew', 'viewer'];
export const GRANT_ROLES = ['organizer', 'lead', 'crew', 'viewer'];

const OFFICE = ['owner', 'organizer'];
const LEADS = ['owner', 'organizer', 'lead'];

export const GRANTS = {
  go_live: ['owner'],
  transfer_owner: ['owner'],
  archive_event: ['owner'],
  edit_details: OFFICE,
  manage_guests: OFFICE,
  test_setup: OFFICE,
  export: OFFICE,
  invite_any: OFFICE,
  invite_crew: LEADS,
  kiosk: LEADS,
  walk_in: LEADS,
  undo_any: LEADS,
  desk_health: LEADS,
  desk: ['owner', 'organizer', 'lead', 'crew'],
  dashboard: ['owner', 'organizer', 'lead', 'crew', 'viewer'],
};

export function effectiveRole(opRole, isOwner) {
  if (isOwner || opRole === 'owner') return 'owner';
  return opRole === 'organizer' || opRole === 'lead' || opRole === 'crew' || opRole === 'viewer' ? opRole : null;
}

export function can(role, perm) {
  return !!role && (GRANTS[perm] || []).includes(role);
}

export function invitableRoles(role) {
  if (can(role, 'invite_any')) return [...GRANT_ROLES];
  if (can(role, 'invite_crew')) return ['crew'];
  return [];
}

const LABELS = { owner: 'Owner', organizer: 'Organizer', lead: 'Desk lead', crew: 'Desk staff', viewer: 'Viewer' };
export function roleLabel(role) { return role ? LABELS[role] : 'No access'; }

export const ROLE_HELP = {
  organizer: 'Edits the event, imports guests, sends QR emails and invites people.',
  lead: 'Runs the desk on the day: kiosks, walk-ins, undoing any check-in, and inviting desk staff.',
  crew: 'Searches, checks people in, prints badges and undoes their own check-ins.',
  viewer: 'Sees the live numbers on the dashboard. Never sees names.',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Check-ins this signed-in person made on this device for this event, as
// attendee id -> scanned_at. Built from the desk's outbox, whose items carry
// operator_id from this plan on. An item the server refused (any result
// other than 'ok') was never a check-in.
export function ownCheckins(outbox, userId, eventId) {
  const own = new Map();
  if (!userId) return own;
  for (const p of outbox || []) {
    if (p.action !== 'checkin' || p.event_id !== eventId || p.operator_id !== userId) continue;
    if (p.result && p.result !== 'ok') continue;
    const prev = own.get(p.attendee_id);
    if (!prev || prev < p.scanned_at) own.set(p.attendee_id, p.scanned_at);
  }
  return own;
}

// Ruling 8 on the screen: leads and above undo anyone; desk staff only a
// check-in they made, and only while it is still the current one. The
// server applies the same rule in checkin_apply_scan.
export function mayUndo(role, attendee, own) {
  if (!attendee || !attendee.checked_in_at) return false;
  if (can(role, 'undo_any')) return true;
  return can(role, 'desk') && !!own && own.get(attendee.id) === attendee.checked_in_at;
}

// Complimentary status is read from the owner's account (ruling 3), so a
// transfer in test mode can switch it. Live events are already paid for.
export function transferNote(eventIsComp, targetIsComp, isLive) {
  if (isLive || !!eventIsComp === !!targetIsComp) return '';
  return targetIsComp
    ? ' This event will become complimentary, because their account is.'
    : ' This event is complimentary because your account is. After the transfer it will need paying for before it can go live.';
}
```

- [ ] **Step 5: Serve the module**

In `.vercelignore`, add after the line `!/checkin-csv.js`:

```
!/checkin-roles.js
```

In `scripts/verify-no-public-internals.sh`, change the `MUST_200` block to:

```bash
MUST_200=(
  / /admin /display /checkin /checkin/desk /cuedeck-console.html /cuedeck-i18n.js
  /favicon.svg /console-manifest.json /console-sw.js /checkin-window.js
  /checkin/setup /checkin-app.css /checkin-csv.js /cuedeck-auth.js
  /checkin-roles.js
)
```

- [ ] **Step 6: Run the tests and type check**

Run: `npx vitest run tests/checkin-roles.spec.ts`
Expected: PASS (all cases).

Run: `deno check supabase/functions/_shared/checkin-roles.ts`
Expected: no errors.

Run: `npm test`
Expected: PASS, no previously passing spec fails.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/checkin-roles.ts checkin-roles.js tests/checkin-roles.spec.ts .vercelignore scripts/verify-no-public-internals.sh
git commit -m "feat(checkin): five-role permission table, server and browser copies"
```

---

### Task 2: Migration 070, roles in the database

**Files:**
- Create: `supabase/migrations/070_checkin_roles.sql`
- Create: `tests/sql/070-roles-probe.sql`
- Modify: `tests/checkin-rls.spec.ts`

**Interfaces:**
- Consumes: the live definitions read on 2026-10-04 (quoted in the migration comments).
- Produces:
  - `leod_checkin_operators.role` accepts `organizer, lead, crew, viewer, api_consumer`; `leod_checkin_attendees.source` accepts `import, kiosk, walk_in`; `leod_checkin_scan_events.result` also accepts `forbidden`.
  - `checkin_is_owner(p_event_id uuid) returns boolean` (authenticated).
  - `checkin_my_events()` returns rows for roles `organizer, lead, crew, viewer` (owner still reported as `organizer` with `is_owner = true` until Task 15).
  - `checkin_update_event_details(p_event_id uuid, p_name text, p_venue text, p_date date, p_timezone text, p_event_start time, p_event_end time) returns void` (authenticated; owner or organizer).

This task applies a migration to production. Apply it only after Step 4 passes locally (the model test) and the SQL has been read twice.

- [ ] **Step 1: Write the failing model test**

In `tests/checkin-rls.spec.ts`:

Change the role type line

```ts
type CheckinRole = 'organizer' | 'crew' | 'api_consumer' | 'none';
```

to

```ts
type CheckinRole = 'organizer' | 'lead' | 'crew' | 'viewer' | 'api_consumer' | 'none';
```

Then append at the end of the file:

```ts
// ════════════════════════════════════════════════════════════════
// PART D: five roles (migration 070). Lead and viewer rows mirror
// supabase/migrations/070_checkin_roles.sql; tests/sql/070-roles-probe.sql
// checks the same facts against the live database.
// ════════════════════════════════════════════════════════════════
const POLICIES_070: Policy[] = [
  { table: 'leod_checkin_operators',    role: 'lead',   ops: ['SELECT'] },
  { table: 'leod_checkin_operators',    role: 'viewer', ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', role: 'lead',   ops: ['SELECT'] },
  { table: 'leod_checkin_entitlements', role: 'viewer', ops: ['SELECT'] },
  { table: 'leod_checkin_attendees',    role: 'lead',   ops: ['SELECT', 'UPDATE'] },
  { table: 'leod_checkin_attendees',    role: 'viewer', ops: [] },
  { table: 'leod_checkin_scan_points',  role: 'lead',   ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_scan_points',  role: 'viewer', ops: [] },
  { table: 'leod_checkin_devices',      role: 'lead',   ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_devices',      role: 'viewer', ops: [] },
  { table: 'leod_checkin_scan_events',  role: 'lead',   ops: ['SELECT', 'INSERT'] },
  { table: 'leod_checkin_scan_events',  role: 'viewer', ops: [] },
  { table: 'leod_checkin_print_jobs',   role: 'lead',   ops: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'leod_checkin_print_jobs',   role: 'viewer', ops: [] },
];
POLICIES.push(...POLICIES_070);

describe('Checkin RLS: five roles (070)', () => {
  const PEOPLE_TABLES = ['leod_checkin_attendees', 'leod_checkin_scan_events', 'leod_checkin_devices', 'leod_checkin_scan_points', 'leod_checkin_print_jobs'];
  it('70.1 a viewer reads no attendee, scan, device, scan point or print job row (ruling 5)', () => {
    for (const t of PEOPLE_TABLES) for (const op of ALL_OPS) expect(canDo('viewer', t, op)).toBe(false);
  });
  it('70.2 a viewer reads the entitlement and the operator list, nothing else', () => {
    expect(canDo('viewer', 'leod_checkin_entitlements', 'SELECT')).toBe(true);
    expect(canDo('viewer', 'leod_checkin_operators', 'SELECT')).toBe(true);
  });
  it('70.3 a desk lead works the desk like crew and also manages devices and scan points', () => {
    expect(canDo('lead', 'leod_checkin_attendees', 'SELECT')).toBe(true);
    expect(canDo('lead', 'leod_checkin_attendees', 'UPDATE')).toBe(true);
    expect(canDo('lead', 'leod_checkin_attendees', 'INSERT')).toBe(false);
    expect(canDo('lead', 'leod_checkin_attendees', 'DELETE')).toBe(false);
    for (const op of ALL_OPS) {
      expect(canDo('lead', 'leod_checkin_devices', op)).toBe(true);
      expect(canDo('lead', 'leod_checkin_scan_points', op)).toBe(true);
    }
  });
  it('70.4 crew still cannot manage devices or scan points', () => {
    expect(canDo('crew', 'leod_checkin_devices', 'INSERT')).toBe(false);
    expect(canDo('crew', 'leod_checkin_scan_points', 'INSERT')).toBe(false);
  });
  it('70.5 every table has a lead and a viewer row', () => {
    for (const t of ALL_TABLES.filter(x => x !== 'leod_organizations')) {
      expect(POLICIES.some(p => p.table === t && p.role === 'lead')).toBe(true);
      expect(POLICIES.some(p => p.table === t && p.role === 'viewer')).toBe(true);
    }
  });
});
```

`POLICIES` is declared with `const` as an array, so `push` is allowed. If the file declares it `as const` or `readonly`, change that declaration to `const POLICIES: Policy[] = [` first.

- [ ] **Step 2: Run the model test**

Run: `npx vitest run tests/checkin-rls.spec.ts`
Expected: PASS (the model is the specification; it documents what the migration must produce). If a pre-existing case fails, the edit broke the file; fix the edit, not the case.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/070_checkin_roles.sql`:

```sql
-- 070_checkin_roles.sql
-- Five check-in roles: owner (leod_events.created_by), organizer, lead,
-- crew (shown as "Desk staff") and viewer.
-- Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md
--
-- Existing data needs no change: every organizer stays Organizer, every
-- crew member stays Desk staff, every creator stays Owner.

-- ── CHECK constraints ─────────────────────────────────────────────
-- Live 2026-10-04: role IN (organizer, crew, api_consumer).
ALTER TABLE leod_checkin_operators DROP CONSTRAINT leod_checkin_operators_role_check;
ALTER TABLE leod_checkin_operators ADD CONSTRAINT leod_checkin_operators_role_check
  CHECK (role IN ('organizer', 'lead', 'crew', 'viewer', 'api_consumer'));

-- Live: source IN (import, kiosk). Ruling 7 adds desk walk-ins.
ALTER TABLE leod_checkin_attendees DROP CONSTRAINT leod_checkin_attendees_source_check;
ALTER TABLE leod_checkin_attendees ADD CONSTRAINT leod_checkin_attendees_source_check
  CHECK (source IN ('import', 'kiosk', 'walk_in'));

-- Live: result IN (ok, duplicate, unknown_token, wrong_event, revoked, undo,
-- test_cap, outside_window). Ruling 8 adds 'forbidden' (crew undo of a
-- check-in someone else made).
ALTER TABLE leod_checkin_scan_events DROP CONSTRAINT leod_checkin_scan_events_result_check;
ALTER TABLE leod_checkin_scan_events ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo',
                    'test_cap', 'outside_window', 'forbidden'));

-- ── Owner helper ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_is_owner(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION checkin_is_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_is_owner(uuid) TO authenticated;

-- ── Policies ──────────────────────────────────────────────────────
-- ALTER POLICY keeps each policy's command and role list; only the
-- expressions change. checkin_att_write (INSERT, organizer) and
-- checkin_att_delete (organizer) are deliberately unchanged: desk
-- walk-ins arrive through the checkin-add-walk-in Edge Function
-- (service role), because checkin_guard_attendee_insert refuses
-- is_test from any JWT caller and a test-mode walk-in must be is_test.

-- attendees: read and update to organizer, lead, crew (was organizer, crew)
ALTER POLICY checkin_att_read ON leod_checkin_attendees
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_att_update ON leod_checkin_attendees
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));

-- devices: read organizer, lead, crew; write organizer, lead (kiosks are a lead job)
ALTER POLICY checkin_dev_read ON leod_checkin_devices
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_dev_write ON leod_checkin_devices
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]))
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]));

-- entitlements and operators: readable by all four grant roles (the owner holds an organizer row)
ALTER POLICY checkin_ent_read ON leod_checkin_entitlements
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'viewer']::text[]));
ALTER POLICY checkin_op_read ON leod_checkin_operators
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'viewer']::text[]));

-- print jobs: organizer, lead, crew (via the attendee's event)
ALTER POLICY checkin_pj_read ON leod_checkin_print_jobs
  USING (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])));
ALTER POLICY checkin_pj_write ON leod_checkin_print_jobs
  USING (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])))
  WITH CHECK (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])));

-- purchases: the owner alone (was any organizer)
ALTER POLICY checkin_purchase_read ON leod_checkin_purchases
  USING (checkin_is_owner(event_id));

-- scan events: read organizer, lead, crew (was any role, which would have
-- included viewers). api_consumer keeps its read: migration 051 scoped that
-- role to exactly this table. No api_consumer rows exist on 2026-10-04.
ALTER POLICY checkin_se_read ON leod_checkin_scan_events
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'api_consumer']::text[]));
ALTER POLICY checkin_se_write ON leod_checkin_scan_events
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));

-- scan points: read organizer, lead, crew; write organizer, lead
ALTER POLICY checkin_sp_read ON leod_checkin_scan_points
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_sp_write ON leod_checkin_scan_points
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]))
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]));

-- ── checkin_my_events: all four grant roles ───────────────────────
-- Same signature and body as live, with lead and viewer added. The owner
-- is still reported as 'organizer' (is_owner = true) so the pages deployed
-- today keep working; migration 073 switches it to 'owner' after the
-- pages that read is_owner are live.
CREATE OR REPLACE FUNCTION checkin_my_events()
 RETURNS TABLE(event_id uuid, name text, date date, venue text, timezone text,
               event_start time without time zone, event_end time without time zone,
               created_via text, is_owner boolean, role text, status text,
               attendees integer, arrived integer, test_used integer, is_comp boolean)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = public
AS $function$
  WITH mine AS (
    SELECT o.event_id, o.role FROM leod_checkin_operators o
     WHERE o.user_id = auth.uid() AND o.role IN ('organizer', 'lead', 'crew', 'viewer')
    UNION
    SELECT e.id, 'organizer' FROM leod_events e WHERE e.created_by = auth.uid()
  ), best AS (
    SELECT DISTINCT ON (event_id) event_id, role FROM mine
     ORDER BY event_id, array_position(ARRAY['organizer', 'lead', 'crew', 'viewer'], role)
  )
  SELECT b.event_id, e.name, e.date, e.venue, e.timezone, e.event_start, e.event_end,
         e.created_via, (e.created_by = auth.uid()), b.role, ent.status,
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id),
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.checked_in_at IS NOT NULL),
         (SELECT count(*)::int FROM leod_checkin_scan_events s WHERE s.event_id = b.event_id AND s.is_test AND s.result = 'ok')
           + (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.is_test),
         EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)
    FROM best b
    JOIN leod_events e ON e.id = b.event_id AND e.active
    LEFT JOIN leod_checkin_entitlements ent ON ent.event_id = b.event_id
   WHERE ent.event_id IS NOT NULL OR e.created_by = auth.uid();
$function$;

-- ── Event details for organizers ──────────────────────────────────
-- leod_events UPDATE is owner-only by RLS (owner_update_events), and the
-- table is shared with the console (branding, created_by, active). Widening
-- that policy would let an organizer change created_by or active, so
-- organizers edit the six detail columns through this function instead.
-- The live-date lock (trigger checkin_lock_live_event_date) still applies:
-- auth.role() is 'authenticated' inside this function.
CREATE OR REPLACE FUNCTION checkin_update_event_details(
  p_event_id uuid, p_name text, p_venue text, p_date date, p_timezone text,
  p_event_start time, p_event_end time)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_venue text := NULLIF(btrim(regexp_replace(coalesce(p_venue, ''), '\s+', ' ', 'g')), '');
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer') THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change event details'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name = '' OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'The event name is required, at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF v_venue IS NOT NULL AND length(v_venue) > 160 THEN
    RAISE EXCEPTION 'The venue is at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone %', p_timezone USING ERRCODE = '22023';
  END IF;
  UPDATE leod_events
     SET name = v_name,
         venue = v_venue,
         date = COALESCE(p_date, date),
         timezone = COALESCE(p_timezone, timezone),
         event_start = COALESCE(p_event_start, event_start),
         event_end = COALESCE(p_event_end, event_end)
   WHERE id = p_event_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) TO authenticated;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Write the probe**

Create `tests/sql/070-roles-probe.sql`:

```sql
-- tests/sql/070-roles-probe.sql
-- Run with the Supabase MCP execute_sql (one statement). Everything it
-- inserts is rolled back by the final RAISE. Expected: an error whose
-- message starts with 'PROBE OK 070'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_att   uuid := gen_random_uuid();
  v_n     int := 0;
  v_c     int;
  v_role  text;
  v_bool  boolean;
  v_name  text;
BEGIN
  -- Fixture (as the migration owner).
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_view, v_out]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 070', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token, source)
  VALUES (v_att, v_ev, 'Ana', 'Probe', 'probe' || replace(gen_random_uuid()::text, '-', ''), 'walk_in');
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash)
  VALUES (v_ev, 'Probe kiosk', 'kiosk', 'probe' || gen_random_uuid());
  INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Main', 'MAIN', 'entrance');
  INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, result, client_id)
  VALUES (gen_random_uuid(), v_ev, v_att, now(), 'forbidden', gen_random_uuid());
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id)
  VALUES (v_ev, v_owner, 'cs_probe_' || gen_random_uuid());
  v_n := v_n + 3;   -- lead/viewer roles, walk_in source and forbidden result were accepted

  BEGIN
    INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (v_ev, v_out, 'owner');
    RAISE EXCEPTION 'PROBE FAIL: owner accepted as an operator role';
  EXCEPTION WHEN check_violation THEN v_n := v_n + 1;
  END;

  -- ── viewer ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % attendee rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % scan rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_devices WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % device rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_points WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % scan point rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % purchase rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_entitlements WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % entitlement rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_operators WHERE event_id = v_ev;
  IF v_c < 5 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % operator rows, want 5', v_c; END IF;
  SELECT role INTO v_role FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'viewer' THEN RAISE EXCEPTION 'PROBE FAIL: my_events gave viewer %', v_role; END IF;
  v_n := v_n + 8;
  BEGIN
    INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, result, client_id)
    VALUES (gen_random_uuid(), v_ev, v_att, now(), 'ok', gen_random_uuid());
    RAISE EXCEPTION 'PROBE FAIL: viewer inserted a scan event';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Renamed', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: viewer edited event details';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── lead ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % attendee rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % scan rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_devices WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % device rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % purchase rows', v_c; END IF;
  INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Side', 'SIDE', 'entrance');
  SELECT role INTO v_role FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'lead' THEN RAISE EXCEPTION 'PROBE FAIL: my_events gave lead %', v_role; END IF;
  v_n := v_n + 6;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Renamed', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: lead edited event details';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── crew ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: crew read % attendee rows, want 1', v_c; END IF;
  v_n := v_n + 1;
  BEGIN
    INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Crew', 'CREW', 'entrance');
    RAISE EXCEPTION 'PROBE FAIL: crew wrote a scan point';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── organizer (not the owner) ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: organizer read % purchase rows', v_c; END IF;
  PERFORM checkin_update_event_details(v_ev, '  Probe   renamed ', 'Hall B', NULL, NULL, '10:00', '17:00');
  v_n := v_n + 2;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Probe', NULL, NULL, 'Not/AZone', NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: unknown timezone accepted';
  EXCEPTION WHEN invalid_parameter_value THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  SELECT name INTO v_name FROM leod_events WHERE id = v_ev;
  IF v_name IS DISTINCT FROM 'Probe renamed' THEN RAISE EXCEPTION 'PROBE FAIL: name is %', v_name; END IF;
  v_n := v_n + 1;

  -- ── owner ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: owner read % purchase rows, want 1', v_c; END IF;
  IF NOT checkin_is_owner(v_ev) THEN RAISE EXCEPTION 'PROBE FAIL: owner is not owner'; END IF;
  SELECT role, is_owner INTO v_role, v_bool FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'organizer' OR v_bool IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL: owner row is (%, %), want (organizer, true) until 073', v_role, v_bool;
  END IF;
  v_n := v_n + 3;
  RESET ROLE;

  -- ── outsider ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF checkin_is_owner(v_ev) THEN RAISE EXCEPTION 'PROBE FAIL: outsider is owner'; END IF;
  SELECT count(*) INTO v_c FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: outsider sees the event'; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_entitlements WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: outsider read the entitlement'; END IF;
  v_n := v_n + 3;
  RESET ROLE;

  -- ── anon cannot call the owner helper at all ──
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM checkin_is_owner(v_ev);
    RAISE EXCEPTION 'PROBE FAIL: anon called checkin_is_owner';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  RAISE EXCEPTION 'PROBE OK 070: % checks passed (rolled back)', v_n;
END
$probe$;
```

- [ ] **Step 5: Apply the migration**

Apply with the Supabase MCP: `apply_migration(project_id: "sawekpguemzvuvvulfbc", name: "checkin_roles", query: <contents of 070_checkin_roles.sql>)`.
Expected: success.

- [ ] **Step 6: Run the probe**

Run the whole contents of `tests/sql/070-roles-probe.sql` with `execute_sql`.
Expected: error `PROBE OK 070: 34 checks passed (rolled back)`. Any `PROBE FAIL` means stop: correct the statement in `070_checkin_roles.sql`, apply only the corrected statements with `apply_migration` (name `checkin_roles_fix`), and re-run the probe until it reports `PROBE OK`.

- [ ] **Step 7: Confirm the live policy text**

Run with `execute_sql`:

```sql
select policyname, qual, with_check from pg_policies where schemaname = 'public' and tablename like 'leod_checkin%' and (qual like '%lead%' or with_check like '%lead%' or qual like '%checkin_is_owner%') order by policyname
```

Expected: 13 rows: `checkin_att_read, checkin_att_update, checkin_dev_read, checkin_dev_write, checkin_ent_read, checkin_op_read, checkin_pj_read, checkin_pj_write, checkin_purchase_read, checkin_se_read, checkin_se_write, checkin_sp_read, checkin_sp_write`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/070_checkin_roles.sql tests/sql/070-roles-probe.sql tests/checkin-rls.spec.ts
git commit -m "feat(checkin): migration 070, five roles in constraints, policies and checkin_my_events"
```

---
### Task 3: Migration 071, desks, heartbeat and undo-own

**Files:**
- Create: `supabase/migrations/071_checkin_desks.sql`
- Create: `tests/sql/071-desks-probe.sql`

**Interfaces:**
- Consumes: `checkin_role_for_event`, the live `checkin_apply_scan` (migrations 062/063, read on 2026-10-04 with `pg_get_functiondef`), Task 2's `forbidden` result value.
- Produces:
  - `leod_checkin_scan_events.desk_id uuid null`.
  - Table `leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)`, PK `(event_id, desk_id)`, no client access (read only through `checkin_event_stats`, Task 4).
  - `checkin_desk_heartbeat(p_event_id uuid, p_desk_id uuid, p_label text, p_pending_count integer) returns text` (the desk's label; `NULL` label keeps the stored one, or assigns `Desk N` for a new desk). Authenticated; organizer, lead or crew.
  - `checkin_apply_scan(p_event_id, p_client_id, p_attendee_id, p_scanned_at, p_action, p_prev_checked_in_at, p_operator_id, p_scan_point_id, p_live_time_ok, p_desk_id uuid DEFAULT NULL) returns text`, service role only. New result `forbidden` for a crew undo of a check-in another operator made. The default keeps the deployed `checkin-record-scans` (which does not send `p_desk_id`) working until Task 5 deploys.

This task applies a migration to production.

- [ ] **Step 1: Write the probe (the failing test)**

Create `tests/sql/071-desks-probe.sql`:

```sql
-- tests/sql/071-desks-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 071'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_crew2 uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_a1    uuid := gen_random_uuid();
  v_a2    uuid := gen_random_uuid();
  v_a3    uuid := gen_random_uuid();
  v_d1    uuid := gen_random_uuid();
  v_d2    uuid := gen_random_uuid();
  v_t1    timestamptz := date_trunc('second', now()) - interval '10 minutes';
  v_t2    timestamptz := date_trunc('second', now()) - interval '9 minutes';
  v_t3    timestamptz := date_trunc('second', now()) - interval '8 minutes';
  v_r     text;
  v_label text;
  v_n     int := 0;
  v_c     int;
  v_ts    timestamptz;
  v_pend  int;
  v_op    uuid;
  v_test  boolean;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_crew2, v_view, v_out]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 071', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'),
         (v_ev, v_crew2, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token)
  VALUES (v_a1, v_ev, 'One', 'Probe', 'p1' || replace(gen_random_uuid()::text, '-', '')),
         (v_a2, v_ev, 'Two', 'Probe', 'p2' || replace(gen_random_uuid()::text, '-', '')),
         (v_a3, v_ev, 'Three', 'Probe', 'p3' || replace(gen_random_uuid()::text, '-', ''));

  -- ── heartbeat as desk staff ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, NULL, 3);
  IF v_label IS DISTINCT FROM 'Desk 1' THEN RAISE EXCEPTION 'PROBE FAIL: first desk is %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d2, NULL, 0);
  IF v_label IS DISTINCT FROM 'Desk 2' THEN RAISE EXCEPTION 'PROBE FAIL: second desk is %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, '  Front   desk ', 0);
  IF v_label IS DISTINCT FROM 'Front desk' THEN RAISE EXCEPTION 'PROBE FAIL: rename gave %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, NULL, 2);
  IF v_label IS DISTINCT FROM 'Front desk' THEN RAISE EXCEPTION 'PROBE FAIL: label not kept, %', v_label; END IF;
  v_n := v_n + 4;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, v_d1, NULL, -1);
    RAISE EXCEPTION 'PROBE FAIL: negative pending count accepted';
  EXCEPTION WHEN invalid_parameter_value THEN v_n := v_n + 1;
  END;
  BEGIN
    SELECT count(*) INTO v_c FROM leod_checkin_desks;
    RAISE EXCEPTION 'PROBE FAIL: authenticated read leod_checkin_desks directly';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  BEGIN
    PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1, 'checkin', NULL, v_crew, NULL, true, v_d1);
    RAISE EXCEPTION 'PROBE FAIL: authenticated called checkin_apply_scan';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  SELECT pending_count, operator_id, is_test INTO v_pend, v_op, v_test
    FROM leod_checkin_desks WHERE event_id = v_ev AND desk_id = v_d1;
  IF v_pend <> 2 OR v_op <> v_crew OR v_test IS NOT TRUE THEN
    RAISE EXCEPTION 'PROBE FAIL: desk row is (%, %, %)', v_pend, v_op, v_test;
  END IF;
  v_n := v_n + 1;

  -- ── viewer and outsider cannot report a desk ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, gen_random_uuid(), NULL, 0);
    RAISE EXCEPTION 'PROBE FAIL: viewer reported a desk';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, gen_random_uuid(), NULL, 0);
    RAISE EXCEPTION 'PROBE FAIL: outsider reported a desk';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── checkin_apply_scan, as the service role would call it ──
  PERFORM set_config('request.jwt.claims', '', true);
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1, 'checkin', NULL, v_crew, NULL, true, v_d1);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: crew check-in gave %', v_r; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev AND desk_id = v_d1;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: desk_id not stored (% rows)', v_c; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1 + interval '30 seconds', 'undo', v_t1, v_crew, NULL, true, v_d1);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of own gave %', v_r; END IF;
  v_n := v_n + 3;

  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2, 'checkin', NULL, v_org, NULL, true, NULL);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: organizer check-in gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2 + interval '30 seconds', 'undo', v_t2, v_crew, NULL, true, v_d1);
  IF v_r <> 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of organizer check-in gave %', v_r; END IF;
  SELECT checked_in_at INTO v_ts FROM leod_checkin_attendees WHERE id = v_a2;
  IF v_ts IS DISTINCT FROM v_t2 THEN RAISE EXCEPTION 'PROBE FAIL: forbidden undo changed checked_in_at to %', v_ts; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE attendee_id = v_a2 AND result = 'forbidden';
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: forbidden undo not recorded (% rows)', v_c; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2 + interval '40 seconds', 'undo', v_t2, v_lead, NULL, true, NULL);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: lead undo of anyone gave %', v_r; END IF;
  v_n := v_n + 5;

  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3, 'checkin', NULL, v_crew2, NULL, true, v_d2);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: second crew check-in gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3 + interval '30 seconds', 'undo', v_t3, v_crew, NULL, true, v_d1);
  IF v_r <> 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of another crew gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3 + interval '40 seconds', 'undo', v_t3, v_owner, NULL, true, NULL);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: owner undo gave %', v_r; END IF;
  v_n := v_n + 3;

  -- The call shape the deployed checkin-record-scans still uses (no p_desk_id).
  SELECT checkin_apply_scan(p_event_id => v_ev, p_client_id => gen_random_uuid(), p_attendee_id => v_a1,
                            p_scanned_at => v_t1 + interval '5 minutes', p_action => 'checkin',
                            p_prev_checked_in_at => NULL, p_operator_id => v_crew, p_scan_point_id => NULL,
                            p_live_time_ok => true) INTO v_r;
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: old call shape gave %', v_r; END IF;
  v_n := v_n + 1;

  RAISE EXCEPTION 'PROBE OK 071: % checks passed (rolled back)', v_n;
END
$probe$;
```

- [ ] **Step 2: Run the probe to confirm it fails before the migration**

Run the probe with `execute_sql`.
Expected: an error mentioning `function checkin_desk_heartbeat(uuid, uuid, unknown, integer) does not exist` (anything but `PROBE OK`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/071_checkin_desks.sql`:

```sql
-- 071_checkin_desks.sql
-- Desk health (event-day spec, feature 1) and undo-own (roles ruling 8).
-- Design: docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md
--         docs/superpowers/specs/2026-10-04-checkin-roles-design.md

-- ── Which laptop recorded a scan ──────────────────────────────────
-- Browser desks send a stable desk_id; kiosks keep device_id.
ALTER TABLE leod_checkin_scan_events ADD COLUMN IF NOT EXISTS desk_id uuid;
CREATE INDEX IF NOT EXISTS leod_checkin_scan_events_desk_idx
  ON leod_checkin_scan_events (event_id, desk_id, scanned_at) WHERE desk_id IS NOT NULL;

-- ── Desks ─────────────────────────────────────────────────────────
-- Written only by checkin_desk_heartbeat, read only by checkin_event_stats.
-- Labels and operators are people data (organizer and lead only), so no
-- client role may read the table directly.
CREATE TABLE IF NOT EXISTS leod_checkin_desks (
  event_id      uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  desk_id       uuid NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  operator_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  is_test       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, desk_id)
);
ALTER TABLE leod_checkin_desks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_desks FROM PUBLIC, anon, authenticated;

-- ── Heartbeat ─────────────────────────────────────────────────────
-- Called by the desk every 30 s while online and once on reconnect.
-- p_label NULL keeps the stored label, or names a new desk "Desk N".
-- Returns the label so the desk can show it.
CREATE OR REPLACE FUNCTION checkin_desk_heartbeat(
  p_event_id uuid, p_desk_id uuid, p_label text, p_pending_count integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text := checkin_role_for_event(p_event_id);
  v_status text;
  v_label  text := NULLIF(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')), '');
  v_count  integer;
  v_exists boolean;
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can report a desk' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_desk_id IS NULL THEN
    RAISE EXCEPTION 'desk_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_pending_count IS NULL OR p_pending_count < 0 OR p_pending_count > 100000 THEN
    RAISE EXCEPTION 'pending_count must be between 0 and 100000' USING ERRCODE = '22023';
  END IF;
  IF v_label IS NOT NULL THEN v_label := left(v_label, 40); END IF;

  -- Serialise per event so two new desks cannot both become "Desk 2".
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_desk:' || p_event_id::text, 0));
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  SELECT EXISTS (SELECT 1 FROM leod_checkin_desks WHERE event_id = p_event_id AND desk_id = p_desk_id) INTO v_exists;
  IF NOT v_exists THEN
    SELECT count(*) INTO v_count FROM leod_checkin_desks WHERE event_id = p_event_id;
    IF v_count >= 50 THEN
      RAISE EXCEPTION 'This event already has 50 desks' USING ERRCODE = '54000';
    END IF;
    IF v_label IS NULL THEN v_label := 'Desk ' || (v_count + 1); END IF;
  ELSIF v_label IS NULL THEN
    SELECT label INTO v_label FROM leod_checkin_desks WHERE event_id = p_event_id AND desk_id = p_desk_id;
  END IF;

  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)
  VALUES (p_event_id, p_desk_id, v_label, auth.uid(), now(), p_pending_count, v_status IS DISTINCT FROM 'live')
  ON CONFLICT (event_id, desk_id) DO UPDATE
    SET label = EXCLUDED.label, operator_id = EXCLUDED.operator_id, last_seen_at = EXCLUDED.last_seen_at,
        pending_count = EXCLUDED.pending_count, is_test = EXCLUDED.is_test;
  RETURN v_label;
END;
$$;
REVOKE ALL ON FUNCTION checkin_desk_heartbeat(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_desk_heartbeat(uuid, uuid, text, integer) TO authenticated;

-- ── checkin_apply_scan: desk id and undo-own ──────────────────────
-- Body is the live definition (migrations 062/063) with two changes,
-- marked CHANGED. Dropped and recreated because a new parameter changes
-- the signature; p_desk_id has a default so the deployed
-- checkin-record-scans, which does not send it yet, keeps working.
DROP FUNCTION IF EXISTS checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean);

CREATE FUNCTION checkin_apply_scan(
  p_event_id uuid, p_client_id uuid, p_attendee_id uuid, p_scanned_at timestamptz,
  p_action text, p_prev_checked_in_at timestamptz, p_operator_id uuid,
  p_scan_point_id uuid, p_live_time_ok boolean, p_desk_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prior  TEXT;
  v_prior_event UUID;
  v_status TEXT;
  v_test   BOOLEAN;
  v_att_event UUID;
  v_att_in    TIMESTAMPTZ;
  v_found  BOOLEAN;
  v_result TEXT;
  v_audit_attendee UUID := NULL;
  v_rows   INTEGER;
  v_op_role TEXT;           -- CHANGED: undo-own
  v_may_undo_any BOOLEAN;   -- CHANGED: undo-own
  v_last_op UUID;           -- CHANGED: undo-own
BEGIN
  IF p_action NOT IN ('checkin', 'undo') THEN RAISE EXCEPTION 'unknown action %', p_action; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

  SELECT result, event_id INTO v_prior, v_prior_event FROM leod_checkin_scan_events WHERE client_id = p_client_id;
  IF FOUND THEN
    IF v_prior_event <> p_event_id THEN
      RAISE EXCEPTION 'client_id already used for another event' USING ERRCODE = 'CK001';
    END IF;
    RETURN v_prior;
  END IF;

  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'check-in is not enabled for event %', p_event_id; END IF;
  v_test := v_status IS DISTINCT FROM 'live';

  SELECT event_id, checked_in_at, true INTO v_att_event, v_att_in, v_found
    FROM leod_checkin_attendees WHERE id = p_attendee_id FOR UPDATE;

  IF NOT COALESCE(v_found, false) THEN
    v_result := 'unknown_token';
  ELSIF v_att_event <> p_event_id THEN
    v_result := 'wrong_event';
  ELSE
    v_audit_attendee := p_attendee_id;
    IF p_action = 'undo' THEN
      -- CHANGED (ruling 8): desk staff may undo only the check-in they
      -- made themselves, i.e. the 'ok' scan that set the current
      -- checked_in_at. Leads, organizers and the owner undo anyone.
      SELECT role INTO v_op_role FROM leod_checkin_operators
       WHERE event_id = p_event_id AND user_id = p_operator_id;
      v_may_undo_any := COALESCE(v_op_role IN ('organizer', 'lead'), false)
        OR EXISTS (SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = p_operator_id);
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL THEN
        SELECT operator_id INTO v_last_op FROM leod_checkin_scan_events
         WHERE event_id = p_event_id AND attendee_id = p_attendee_id
           AND result = 'ok' AND scanned_at = v_att_in
         ORDER BY received_at DESC LIMIT 1;
      END IF;
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL AND v_last_op IS DISTINCT FROM p_operator_id THEN
        v_result := 'forbidden';
      ELSE
        UPDATE leod_checkin_attendees SET checked_in_at = NULL
         WHERE id = p_attendee_id AND checked_in_at = p_prev_checked_in_at;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_result := CASE WHEN v_rows > 0 THEN 'undo' ELSE 'duplicate' END;
      END IF;
    ELSIF v_att_in IS NOT NULL THEN
      v_result := 'duplicate';
    ELSIF v_test AND COALESCE(checkin_test_usage(p_event_id), 25) >= 25 THEN
      v_result := 'test_cap';
    ELSIF NOT v_test AND NOT COALESCE(p_live_time_ok, false) THEN
      v_result := 'outside_window';
    ELSE
      UPDATE leod_checkin_attendees SET checked_in_at = p_scanned_at
       WHERE id = p_attendee_id AND checked_in_at IS NULL;
      v_result := 'ok';
    END IF;
  END IF;

  INSERT INTO leod_checkin_scan_events
    (id, event_id, client_id, attendee_id, scan_point_id, device_id, operator_id, scanned_at, result, is_test, desk_id)
  VALUES
    (gen_random_uuid(), p_event_id, p_client_id, v_audit_attendee, p_scan_point_id, NULL, p_operator_id,
     p_scanned_at, v_result, v_test, p_desk_id);   -- CHANGED: desk_id

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Apply the migration**

`apply_migration(project_id: "sawekpguemzvuvvulfbc", name: "checkin_desks", query: <contents of 071_checkin_desks.sql>)`.
Expected: success.

- [ ] **Step 5: Run the probe**

Run `tests/sql/071-desks-probe.sql` with `execute_sql`.
Expected: error `PROBE OK 071: 22 checks passed (rolled back)`.

- [ ] **Step 6: Confirm the live desk still ingests**

Run with `execute_sql`:

```sql
select pg_get_function_identity_arguments(p.oid) as args, array_to_string(p.proacl, ',') as acl from pg_proc p where p.proname = 'checkin_apply_scan' and p.pronamespace = 'public'::regnamespace
```

Expected: exactly one row; `args` ends with `p_desk_id uuid`; `acl` contains `service_role=X` and does not contain `authenticated=X` or `anon=X`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/071_checkin_desks.sql tests/sql/071-desks-probe.sql
git commit -m "feat(checkin): migration 071, desk heartbeat, scan desk_id and undo-own"
```

---

### Task 4: Migration 072, `checkin_event_stats`

**Files:**
- Create: `supabase/migrations/072_checkin_event_stats.sql`
- Create: `tests/sql/072-stats-probe.sql`

**Interfaces:**
- Consumes: `checkin_role_for_event`, `checkin_is_owner` (Task 2), `leod_checkin_desks` and `scan_events.desk_id` (Task 3).
- Produces: `checkin_event_stats(p_event_id uuid) returns jsonb`, authenticated, any of the five roles. Shape (every count an integer):

```json
{
  "role": "owner | organizer | lead | crew | viewer",
  "status": "test | live",
  "generated_at": "2026-10-18T09:00:00+00:00",
  "registered": 120, "checked_in": 45, "walk_ins": 6,
  "by_source": { "import": 114, "kiosk": 4, "walk_in": 2 },
  "qr": { "sent": 100, "not_sent": 15, "no_email": 5 },
  "by_ticket": [ { "ticket_type": "attendee", "registered": 100, "checked_in": 40 } ],
  "arrivals": [ { "t": 1792310400, "n": 10 } ],
  "last_25_min": [0, 0, 1, "... 25 integers, oldest first, last = current minute"],
  "ops": null
}
```

`arrivals[].t` is the bucket start as Unix seconds, a multiple of 900; buckets are ordered by `t` and only non-empty buckets are listed. `ops` is `null` for crew and viewers; for owner, organizer and lead it is:

```json
{
  "desks":  [ { "desk_id": "uuid", "label": "Desk 1", "operator": "Ewa Sample", "last_seen_at": "iso", "seconds_since_seen": 30, "pending_count": 0 } ],
  "kiosks": [ { "label": "Lobby kiosk", "last_seen_at": "iso or null", "seconds_since_seen": 12 } ],
  "speeds": [ { "desk_id": "uuid", "busiest_15": 18, "active_minutes": 12, "first_at": "iso", "last_at": "iso" } ],
  "gaps":   [ { "desk_id": "uuid", "start_at": "iso", "end_at": "iso", "synced_ok": 23 } ]
}
```

Counts and labels only, never attendee names, emails or companies (ruling 5). Undone check-ins do not count and a re-check-in counts once at its latest time, because arrivals are read from `leod_checkin_attendees.checked_in_at`.

This task applies a migration to production.

- [ ] **Step 1: Write the probe**

Create `tests/sql/072-stats-probe.sql`:

```sql
-- tests/sql/072-stats-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 072'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_a1    uuid := gen_random_uuid();
  v_d     uuid := gen_random_uuid();
  v_t0    timestamptz := to_timestamp(floor(extract(epoch FROM now() - interval '2 hours') / 900) * 900);
  v_t1    timestamptz := date_trunc('minute', now()) - interval '60 minutes';
  v_s     jsonb;
  v_n     int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_lead, v_crew, v_view, v_out]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 072', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'live');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  -- Five guests. Names, companies and emails are unique strings so the
  -- probe can prove none of them reaches a viewer.
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, company, email, ticket_type, source, qr_token, qr_email_sent_at, checked_in_at) VALUES
    (v_a1, v_ev, 'Zelda', 'Uniquename', 'Zcorp Probe', 'zelda.probe@example.invalid', 'attendee', 'import', 'z1' || replace(gen_random_uuid()::text, '-', ''), now(), v_t0 + interval '1 minute'),
    (gen_random_uuid(), v_ev, 'Yann', 'Uniquename', NULL, 'yann.probe@example.invalid', 'attendee', 'import', 'z2' || replace(gen_random_uuid()::text, '-', ''), NULL, v_t0 + interval '16 minutes'),
    (gen_random_uuid(), v_ev, 'Xena', 'Uniquename', NULL, NULL, 'VIP', 'kiosk', 'z3' || replace(gen_random_uuid()::text, '-', ''), NULL, NULL),
    (gen_random_uuid(), v_ev, 'Will', 'Uniquename', NULL, 'will.probe@example.invalid', 'VIP', 'walk_in', 'z4' || replace(gen_random_uuid()::text, '-', ''), NULL, NULL),
    (gen_random_uuid(), v_ev, 'Vera', 'Uniquename', NULL, 'vera.probe@example.invalid', 'attendee', 'import', 'z5' || replace(gen_random_uuid()::text, '-', ''), NULL, date_trunc('minute', now()) - interval '2 minutes');
  -- One desk, one kiosk, and a desk history with two offline gaps:
  -- on time, 3 late (ok, ok, duplicate), on time, 1 late (ok).
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count)
  VALUES (v_ev, v_d, 'Desk 1', v_lead, now() - interval '30 seconds', 0);
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash, last_seen_at)
  VALUES (v_ev, 'Lobby kiosk', 'kiosk', 'probe' || gen_random_uuid(), now() - interval '12 seconds');
  INSERT INTO leod_checkin_scan_events (id, event_id, client_id, attendee_id, scanned_at, received_at, result, desk_id) VALUES
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1,                         v_t1,                                          'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '1 minute',  v_t1 + interval '6 minutes',                  'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '2 minutes', v_t1 + interval '6 minutes',                  'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '3 minutes', v_t1 + interval '6 minutes',                  'duplicate', v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '4 minutes', v_t1 + interval '4 minutes 10 seconds',       'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '5 minutes', v_t1 + interval '9 minutes',                  'ok',        v_d);

  -- ── viewer: counts only ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'viewer' THEN RAISE EXCEPTION 'PROBE FAIL: role %', v_s->>'role'; END IF;
  IF (v_s->>'registered')::int <> 5 THEN RAISE EXCEPTION 'PROBE FAIL: registered %', v_s->>'registered'; END IF;
  IF (v_s->>'checked_in')::int <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: checked_in %', v_s->>'checked_in'; END IF;
  IF (v_s->>'walk_ins')::int <> 2 THEN RAISE EXCEPTION 'PROBE FAIL: walk_ins %', v_s->>'walk_ins'; END IF;
  IF v_s->'by_source' <> '{"import":3,"kiosk":1,"walk_in":1}'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: by_source %', v_s->'by_source'; END IF;
  IF v_s->'qr' <> '{"sent":1,"not_sent":3,"no_email":1}'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: qr %', v_s->'qr'; END IF;
  IF v_s->'by_ticket' <> '[{"ticket_type":"attendee","registered":3,"checked_in":3},{"ticket_type":"VIP","registered":2,"checked_in":0}]'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL: by_ticket %', v_s->'by_ticket'; END IF;
  IF jsonb_array_length(v_s->'arrivals') <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: arrivals %', v_s->'arrivals'; END IF;
  IF (v_s->'arrivals'->0->>'t')::bigint % 900 <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: bucket not on 15 minutes'; END IF;
  IF jsonb_array_length(v_s->'last_25_min') <> 25 THEN RAISE EXCEPTION 'PROBE FAIL: last_25_min length'; END IF;
  IF (v_s->'last_25_min'->>22)::int <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: last_25_min %', v_s->'last_25_min'; END IF;
  IF v_s->'ops' <> 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: viewer got ops'; END IF;
  IF v_s::text ~ '(Uniquename|Zelda|Zcorp|probe@example)' THEN RAISE EXCEPTION 'PROBE FAIL: people data reached a viewer'; END IF;
  v_n := v_n + 14;

  -- ── crew: no desk panel ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->'ops' <> 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: crew got ops'; END IF;
  v_n := v_n + 1;

  -- ── lead: desk panel ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->'ops' = 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: lead got no ops'; END IF;
  IF jsonb_array_length(v_s->'ops'->'desks') <> 1 OR v_s->'ops'->'desks'->0->>'label' <> 'Desk 1' THEN
    RAISE EXCEPTION 'PROBE FAIL: desks %', v_s->'ops'->'desks'; END IF;
  IF (v_s->'ops'->'desks'->0->>'seconds_since_seen')::int NOT BETWEEN 25 AND 40 THEN
    RAISE EXCEPTION 'PROBE FAIL: seconds_since_seen %', v_s->'ops'->'desks'->0->>'seconds_since_seen'; END IF;
  IF v_s->'ops'->'desks'->0->>'operator' NOT LIKE 'probe-%' THEN
    RAISE EXCEPTION 'PROBE FAIL: operator %', v_s->'ops'->'desks'->0->>'operator'; END IF;
  IF jsonb_array_length(v_s->'ops'->'kiosks') <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: kiosks %', v_s->'ops'->'kiosks'; END IF;
  IF jsonb_array_length(v_s->'ops'->'gaps') <> 2 THEN RAISE EXCEPTION 'PROBE FAIL: gaps %', v_s->'ops'->'gaps'; END IF;
  IF (v_s->'ops'->'gaps'->0->>'synced_ok')::int <> 1 OR (v_s->'ops'->'gaps'->1->>'synced_ok')::int <> 2 THEN
    RAISE EXCEPTION 'PROBE FAIL: gap counts %', v_s->'ops'->'gaps'; END IF;
  IF (v_s->'ops'->'gaps'->1->>'start_at')::timestamptz <> v_t1 + interval '1 minute'
     OR (v_s->'ops'->'gaps'->1->>'end_at')::timestamptz <> v_t1 + interval '3 minutes' THEN
    RAISE EXCEPTION 'PROBE FAIL: gap bounds %', v_s->'ops'->'gaps'->1; END IF;
  IF (v_s->'ops'->'speeds'->0->>'busiest_15')::int <> 5 OR (v_s->'ops'->'speeds'->0->>'active_minutes')::int <> 5 THEN
    RAISE EXCEPTION 'PROBE FAIL: speeds %', v_s->'ops'->'speeds'; END IF;
  v_n := v_n + 9;

  -- ── owner ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'owner' OR v_s->'ops' = 'null'::jsonb OR v_s->>'status' <> 'live' THEN
    RAISE EXCEPTION 'PROBE FAIL: owner got % / % / %', v_s->>'role', v_s->'ops', v_s->>'status'; END IF;
  v_n := v_n + 1;

  -- ── outsider ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_s := checkin_event_stats(v_ev);
    RAISE EXCEPTION 'PROBE FAIL: outsider read stats';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  RAISE EXCEPTION 'PROBE OK 072: % checks passed (rolled back)', v_n;
END
$probe$;
```

- [ ] **Step 2: Run the probe to confirm it fails before the migration**

Run it with `execute_sql`.
Expected: an error mentioning `function checkin_event_stats(uuid) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/072_checkin_event_stats.sql`:

```sql
-- 072_checkin_event_stats.sql
-- One call for the check-in dashboard: tile numbers, five breakdowns,
-- and (owner, organizer, lead only) desk health, desk speeds and offline
-- gaps. Counts and labels only, never names, emails or companies, which
-- is what lets a viewer use it (roles ruling 5).
-- Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md (Check-in dashboard)
--         docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md (features 1, 2)
CREATE OR REPLACE FUNCTION checkin_event_stats(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text := checkin_role_for_event(p_event_id);
  v_eff    text;
  v_status text;
  v_out    jsonb;
  v_ops    jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role NOT IN ('organizer', 'lead', 'crew', 'viewer') THEN
    RAISE EXCEPTION 'Not on this event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_eff := CASE WHEN checkin_is_owner(p_event_id) THEN 'owner' ELSE v_role END;
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;

  SELECT jsonb_build_object(
    'registered', count(*)::int,
    'checked_in', (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int,
    'walk_ins',   (count(*) FILTER (WHERE source IN ('kiosk', 'walk_in')))::int,
    'by_source',  jsonb_build_object(
                    'import',  (count(*) FILTER (WHERE source = 'import'))::int,
                    'kiosk',   (count(*) FILTER (WHERE source = 'kiosk'))::int,
                    'walk_in', (count(*) FILTER (WHERE source = 'walk_in'))::int),
    'qr',         jsonb_build_object(
                    'sent',     (count(*) FILTER (WHERE qr_email_sent_at IS NOT NULL))::int,
                    'not_sent', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NOT NULL))::int,
                    'no_email', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NULL))::int)
  ) INTO v_out
  FROM leod_checkin_attendees WHERE event_id = p_event_id;

  v_out := v_out || jsonb_build_object(
    'role', v_eff,
    'status', COALESCE(v_status, 'test'),
    'generated_at', now(),
    'by_ticket', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('ticket_type', ticket_type, 'registered', reg, 'checked_in', arr)
                                ORDER BY reg DESC, ticket_type), '[]'::jsonb)
        FROM (SELECT ticket_type, count(*)::int AS reg,
                     (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arr
                FROM leod_checkin_attendees WHERE event_id = p_event_id GROUP BY ticket_type) t),
    'arrivals', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('t', b, 'n', n) ORDER BY b), '[]'::jsonb)
        FROM (SELECT (floor(extract(epoch FROM checked_in_at) / 900) * 900)::bigint AS b, count(*)::int AS n
                FROM leod_checkin_attendees
               WHERE event_id = p_event_id AND checked_in_at IS NOT NULL
               GROUP BY 1) x),
    'last_25_min', (
      SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY m.i DESC)
        FROM generate_series(0, 24) AS m(i)
        LEFT JOIN (SELECT date_trunc('minute', checked_in_at) AS mm, count(*)::int AS n
                     FROM leod_checkin_attendees
                    WHERE event_id = p_event_id
                      AND checked_in_at >= date_trunc('minute', now()) - interval '24 minutes'
                    GROUP BY 1) c
          ON c.mm = date_trunc('minute', now()) - make_interval(mins => m.i))
  );

  IF v_eff IN ('owner', 'organizer', 'lead') THEN
    v_ops := jsonb_build_object(
      'desks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'desk_id', d.desk_id, 'label', d.label,
                 'operator', COALESCE(NULLIF(btrim(u.name), ''), u.email),
                 'last_seen_at', d.last_seen_at,
                 'seconds_since_seen', floor(extract(epoch FROM now() - d.last_seen_at))::int,
                 'pending_count', d.pending_count) ORDER BY d.label), '[]'::jsonb)
          FROM leod_checkin_desks d
          LEFT JOIN leod_users u ON u.id = d.operator_id
         WHERE d.event_id = p_event_id),
      'kiosks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', k.label, 'last_seen_at', k.last_seen_at,
                 'seconds_since_seen', CASE WHEN k.last_seen_at IS NULL THEN NULL
                                            ELSE floor(extract(epoch FROM now() - k.last_seen_at))::int END)
                 ORDER BY k.label), '[]'::jsonb)
          FROM leod_checkin_devices k
         WHERE k.event_id = p_event_id AND k.kind = 'kiosk' AND k.revoked_at IS NULL),
      -- Busiest 15 minutes per desk: for every 'ok' scan, the 'ok' scans of
      -- the same desk in the 15 minutes from it; the maximum is the busiest window.
      'speeds', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'desk_id', desk_id, 'busiest_15', busiest, 'active_minutes', active_minutes,
                 'first_at', first_at, 'last_at', last_at)), '[]'::jsonb)
          FROM (SELECT desk_id, max(c)::int AS busiest,
                       count(DISTINCT date_trunc('minute', scanned_at))::int AS active_minutes,
                       min(scanned_at) AS first_at, max(scanned_at) AS last_at
                  FROM (SELECT desk_id, scanned_at,
                               count(*) OVER (PARTITION BY desk_id ORDER BY scanned_at
                                              RANGE BETWEEN CURRENT ROW AND INTERVAL '15 minutes' FOLLOWING) AS c
                          FROM leod_checkin_scan_events
                         WHERE event_id = p_event_id AND desk_id IS NOT NULL AND result = 'ok') w
                 GROUP BY desk_id) s),
      -- Offline gaps proven: per desk, in scanned_at order, a run of scans
      -- that reached the server more than 60 s after they were made
      -- (gaps-and-islands). Latest 50 gaps, newest first.
      'gaps', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'desk_id', desk_id, 'start_at', start_at, 'end_at', end_at, 'synced_ok', synced_ok)
                 ORDER BY start_at DESC), '[]'::jsonb)
          FROM (SELECT desk_id, min(scanned_at) AS start_at, max(scanned_at) AS end_at,
                       (count(*) FILTER (WHERE result = 'ok'))::int AS synced_ok
                  FROM (SELECT desk_id, scanned_at, result, late,
                               row_number() OVER (PARTITION BY desk_id ORDER BY scanned_at, id)
                             - row_number() OVER (PARTITION BY desk_id, late ORDER BY scanned_at, id) AS grp
                          FROM (SELECT desk_id, scanned_at, result, id,
                                       (received_at - scanned_at) > interval '60 seconds' AS late
                                  FROM leod_checkin_scan_events
                                 WHERE event_id = p_event_id AND desk_id IS NOT NULL) a) b
                 WHERE late
                 GROUP BY desk_id, grp
                 ORDER BY min(scanned_at) DESC
                 LIMIT 50) g)
    );
  END IF;

  RETURN v_out || jsonb_build_object('ops', v_ops);
END;
$$;
REVOKE ALL ON FUNCTION checkin_event_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_event_stats(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Apply the migration**

`apply_migration(project_id: "sawekpguemzvuvvulfbc", name: "checkin_event_stats", query: <contents of 072_checkin_event_stats.sql>)`.
Expected: success.

- [ ] **Step 5: Run the probe**

Run `tests/sql/072-stats-probe.sql` with `execute_sql`.
Expected: error `PROBE OK 072: 25 checks passed (rolled back)`.

- [ ] **Step 6: Time it on the largest real event**

Run with `execute_sql` (one DO block; it reads only, and raises its result):

```sql
DO $t$
DECLARE v_ev uuid; v_owner uuid; v_start timestamptz; v_s jsonb;
BEGIN
  SELECT a.event_id, e.created_by INTO v_ev, v_owner
    FROM leod_checkin_attendees a
    JOIN leod_events e ON e.id = a.event_id
    JOIN leod_checkin_entitlements ent ON ent.event_id = a.event_id AND ent.checkin_core
   GROUP BY a.event_id, e.created_by ORDER BY count(*) DESC LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_start := clock_timestamp();
  v_s := checkin_event_stats(v_ev);
  RAISE EXCEPTION 'TIMING % ms for % registered', round(extract(epoch FROM clock_timestamp() - v_start) * 1000), v_s->>'registered';
END $t$;
```

Expected: `TIMING <n> ms ...` with n under 300. If it is slower, append `CREATE INDEX IF NOT EXISTS leod_checkin_attendees_event_checked_idx ON leod_checkin_attendees (event_id, checked_in_at);` to `072_checkin_event_stats.sql`, apply that one statement with `apply_migration` (name `checkin_event_stats_index`), and time it again.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/072_checkin_event_stats.sql tests/sql/072-stats-probe.sql
git commit -m "feat(checkin): migration 072, checkin_event_stats for the dashboard"
```

---
### Task 5: Role gates in six Edge Functions

**Files:**
- Modify: `supabase/functions/checkin-create-checkout/index.ts:5-8,34-37`
- Modify: `supabase/functions/checkin-enable-event/index.ts:16-17,73-83,110-119`
- Modify: `supabase/functions/checkin-import-attendees/index.ts:10-12,101-108`
- Modify: `supabase/functions/checkin-send-qr-emails/index.ts:10-12,54-60`
- Modify: `supabase/functions/checkin-kiosk-pair/index.ts:41-42,166-170`
- Modify: `supabase/functions/checkin-record-scans/index.ts:14-16,93-95,117-123,203-213`
- Create: `tests/checkin-function-gates.spec.ts`

**Interfaces:**
- Consumes: `can`, `loadCallerRole`, `isUuid` from `supabase/functions/_shared/checkin-roles.ts` (Task 1); `checkin_apply_scan(..., p_desk_id)` (Task 3).
- Produces: deployed functions whose gates are: create-checkout `go_live`; enable-event `test_setup` (or CueDeck admin) and comp go-live only with `go_live`; import-attendees and send-qr-emails `manage_guests`; kiosk-pair mint `kiosk`; record-scans `desk`, and record-scans accepts an optional top-level `desk_id` (UUID) and stores it on every scan.

- [ ] **Step 1: Write the failing test**

Create `tests/checkin-function-gates.spec.ts`:

```ts
// tests/checkin-function-gates.spec.ts
// Every check-in Edge Function decides who may call it through
// supabase/functions/_shared/checkin-roles.ts, so the permission table
// tested in tests/checkin-roles.spec.ts is the one the server enforces.
// This pins each function to its permission and forbids the old
// hand-written operator-role comparisons from coming back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');

const GATES: [string, string][] = [
  ['checkin-create-checkout',  "can(role, 'go_live')"],
  ['checkin-enable-event',     "can(role, 'test_setup')"],
  ['checkin-enable-event',     "can(role, 'go_live')"],
  ['checkin-import-attendees', "can(role, 'manage_guests')"],
  ['checkin-send-qr-emails',   "can(role, 'manage_guests')"],
  ['checkin-kiosk-pair',       "can(role, 'kiosk')"],
  ['checkin-record-scans',     "can(role, 'desk')"],
];
const FUNCTIONS = [...new Set(GATES.map(g => g[0]))];

describe('Edge Function role gates', () => {
  it.each(GATES)('%s gates on %s', (fn, gate) => {
    expect(src(fn)).toContain(gate);
  });
  it.each(FUNCTIONS)('%s imports the shared role module', (fn) => {
    expect(src(fn)).toContain("from '../_shared/checkin-roles.ts'");
    expect(src(fn)).toContain('loadCallerRole(sb, event_id, user.id)');
  });
  it.each(FUNCTIONS)('%s no longer compares an operator row by hand', (fn) => {
    expect(src(fn)).not.toMatch(/\b(opRow|op|me)\?\.role\b/);
  });
  it('record-scans passes the desk id to checkin_apply_scan', () => {
    expect(src('checkin-record-scans')).toContain('p_desk_id: desk_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/checkin-function-gates.spec.ts`
Expected: FAIL on every `gates on` and `imports` case.

- [ ] **Step 3: checkin-create-checkout (owner only)**

Add after the line `import { isWindowClosed } from '../_shared/checkin-policy.ts'`:

```ts
import { can, loadCallerRole } from '../_shared/checkin-roles.ts'
```

Replace:

```ts
  const { data: op, error: opErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).maybeSingle()
  if (opErr) return json({ error: opErr.message }, 500)
  if (op?.role !== 'organizer') return json({ error: 'Forbidden, organizers only' }, 403)
```

with:

```ts
  // Going live is the owner's act alone, paid or complimentary (roles ruling 1).
  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) return json({ error: roleErr }, 500)
  if (!can(role, 'go_live')) return json({ error: 'Only the event owner can go live', code: 'not_owner' }, 403)
```

- [ ] **Step 4: checkin-enable-event (test setup for office roles, comp go-live for the owner)**

Add after the line `import { corsHeaders }  from '../_shared/cors.ts'`:

```ts
import { can, loadCallerRole } from '../_shared/checkin-roles.ts'
```

Replace the block from `const { data: opRow } = await sb.from('leod_checkin_operators')` through the closing `}` of `if (!isOwner && !isAdmin && !isOrganizer) { ... }` with:

```ts
  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) {
    return new Response(JSON.stringify({ error: roleErr }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  const isAdmin = callerRow?.role === 'admin'
  // Test mode and event settings: the owner, an organizer, or a CueDeck admin.
  if (!isAdmin && !can(role, 'test_setup')) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

Replace:

```ts
  if (isComp) {
    const { error: liveErr } = await sb.rpc('checkin_mark_comp_live', { p_event_id: event_id })
```

with:

```ts
  // A complimentary go-live is the same act as paying, so it is the
  // owner's alone (roles ruling 1). An organizer saving settings on a
  // complimentary event leaves it in test mode.
  if (isComp && can(role, 'go_live')) {
    const { error: liveErr } = await sb.rpc('checkin_mark_comp_live', { p_event_id: event_id })
```

Update the header comment's second paragraph (lines 5-14) to read:

```ts
// Provisions the check-in module for an event: creates the
// entitlements row (idempotent via upsert) and makes sure the event's
// creator holds an organizer grant (covers events created before
// migration 045's auto-grant trigger existed). Caller must be the
// owner, an organizer (checkin-roles.ts 'test_setup'), or a CueDeck
// admin. A complimentary owner's call also takes the event live;
// nobody else's does (roles ruling 1).
```

- [ ] **Step 5: checkin-import-attendees and checkin-send-qr-emails (organizer or owner)**

In both files add after the line `import { corsHeaders }  from '../_shared/cors.ts'`:

```ts
import { can, loadCallerRole } from '../_shared/checkin-roles.ts'
```

In `checkin-import-attendees/index.ts` replace:

```ts
  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

with:

```ts
  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) {
    return new Response(JSON.stringify({ error: roleErr }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!can(role, 'manage_guests')) {
    return new Response(JSON.stringify({ error: 'Forbidden, organizers only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

In `checkin-send-qr-emails/index.ts` replace the identical `opRow` block (lines 54-60, same text as above) with the same replacement.

- [ ] **Step 6: checkin-kiosk-pair (organizer or lead)**

Add after the line `import { corsHeaders }  from '../_shared/cors.ts'`:

```ts
import { can, loadCallerRole } from '../_shared/checkin-roles.ts'
```

Inside the `mint` branch replace:

```ts
    const { data: opRow } = await sb.from('leod_checkin_operators')
      .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
    if (opRow?.role !== 'organizer') {
      return json({ error: 'Forbidden — organizers only' }, 403)
    }
```

with:

```ts
    const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
    if (roleErr) return json({ error: roleErr }, 500)
    // The desk maps a 403 whose message contains 'organizer' to its
    // "who can set up a kiosk" note, so keep that word in the message.
    if (!can(role, 'kiosk')) {
      return json({ error: 'Forbidden, organizers and desk leads only' }, 403)
    }
```

- [ ] **Step 7: checkin-record-scans (desk roles, desk id)**

Add after the line `import { isWithinWindow } from '../_shared/checkin-policy.ts'`:

```ts
import { can, isUuid, loadCallerRole } from '../_shared/checkin-roles.ts'
```

After the line `const scan_point_id = body.scan_point_id ? String(body.scan_point_id) : null` add:

```ts
  // Which browser desk sent this batch (event-day spec, feature 1). A
  // missing or malformed value is stored as NULL rather than failing the
  // batch: the scans matter more than the label.
  const desk_id       = isUuid(body.desk_id) ? body.desk_id : null
```

Replace:

```ts
  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer' && opRow?.role !== 'crew') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers and crew only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

with:

```ts
  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) {
    return new Response(JSON.stringify({ error: roleErr }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!can(role, 'desk')) {
    return new Response(JSON.stringify({ error: 'Forbidden, desk roles only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
```

In the `sb.rpc('checkin_apply_scan', { ... })` call, after `p_live_time_ok,` add:

```ts
      p_desk_id: desk_id,
```

Also update the comment above the replaced block (the lines beginning `// This client uses the service-role key`) to:

```ts
  // This client uses the service-role key, which bypasses RLS entirely.
  // checkin_role_for_event() cannot be used here (auth.uid() is NULL on a
  // service-role connection), so the caller's role is read with
  // loadCallerRole() from _shared/checkin-roles.ts.
```

- [ ] **Step 8: Run the tests and type checks**

Run: `npx vitest run tests/checkin-function-gates.spec.ts tests/checkin-roles.spec.ts`
Expected: PASS.

Run: `deno check supabase/functions/checkin-create-checkout/index.ts supabase/functions/checkin-enable-event/index.ts supabase/functions/checkin-import-attendees/index.ts supabase/functions/checkin-send-qr-emails/index.ts supabase/functions/checkin-kiosk-pair/index.ts supabase/functions/checkin-record-scans/index.ts`
Expected: no errors. (If `body.desk_id` narrows to `unknown`, write `const desk_id = isUuid(body.desk_id) ? String(body.desk_id) : null`.)

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/checkin-create-checkout/index.ts supabase/functions/checkin-enable-event/index.ts supabase/functions/checkin-import-attendees/index.ts supabase/functions/checkin-send-qr-emails/index.ts supabase/functions/checkin-kiosk-pair/index.ts supabase/functions/checkin-record-scans/index.ts tests/checkin-function-gates.spec.ts
git commit -m "feat(checkin): Edge Function gates use the five-role table; record-scans stores desk_id"
```

- [ ] **Step 10: Deploy**

Migration 071 (Task 3) must already be applied, or record-scans would send `p_desk_id` to a function without it.

Run: `bash scripts/deploy-functions.sh checkin-create-checkout checkin-enable-event checkin-import-attendees checkin-send-qr-emails checkin-kiosk-pair checkin-record-scans`
Expected: six `OK ... deployed` lines and six ping lines with `pong`. Then check with the Supabase MCP `query_logs` (Edge Function logs, last 10 minutes) that none of the six returned a 5xx.

---

### Task 6: checkin-invite-staff for five roles, transfer and archive

**Files:**
- Rewrite: `supabase/functions/checkin-invite-staff/index.ts`
- Modify: `tests/checkin-staff.spec.ts:5-13,24-33`
- Modify: `tests/checkin-function-gates.spec.ts` (GATES array)

**Interfaces:**
- Consumes: `can`, `invitableRoles`, `removeVerdict`, `loadCallerRole`, `isUuid`, `GRANT_ROLES`, `GrantRole` (Task 1).
- Produces: `POST /functions/v1/checkin-invite-staff` with body `{ event_id, action }`:
  - `list` (owner, organizer, lead): `{ ok: true, staff: [{ user_id, role, email, name, is_owner, is_comp? }] }`; `role` is one of `organizer, lead, crew, viewer`; `is_comp` is present only when the caller is the owner.
  - `invite` `{ email, role, name? }`: owner and organizer invite any of the four; a lead invites `crew` only (`403 role_not_allowed` otherwise).
  - `remove` `{ user_id }`: codes `forbidden` (403), `not_found` (404), `event_owner`, `last_organizer` (409).
  - `transfer_owner` `{ user_id }` (owner only): target must be an organizer on a `created_via = 'checkin'` event; codes `not_owner` (403), `console_event`, `not_organizer`, `owner_changed` (409), `bad_target` (400).
  - `archive_event` (owner only): sets `leod_events.active = false` on a `checkin` event that is not live; codes `not_owner` (403), `console_event`, `live_event` (409).

- [ ] **Step 1: Point the staff test at the shared rule (failing)**

In `tests/checkin-staff.spec.ts` replace the top of the file through the end of the local `canRemove` function:

```ts
// tests/checkin-staff.spec.ts
// Mirrors the removal rule in supabase/functions/checkin-invite-staff.
import { describe, it, expect } from 'vitest';

type Op = { user_id: string; role: 'organizer' | 'crew' };

function canRemove(target: string, ownerId: string | null, ops: Op[]): { ok: true } | { ok: false; code: 'event_owner' | 'last_organizer' | 'not_found' } {
  const row = ops.find(o => o.user_id === target);
  if (!row) return { ok: false, code: 'not_found' };
  if (target === ownerId) return { ok: false, code: 'event_owner' };
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) return { ok: false, code: 'last_organizer' };
  return { ok: true };
}
```

with:

```ts
// tests/checkin-staff.spec.ts
// checkin-invite-staff removes people through removeVerdict() in
// supabase/functions/_shared/checkin-roles.ts; these are its organizer cases.
import { describe, it, expect } from 'vitest';
import { removeVerdict } from '../supabase/functions/_shared/checkin-roles.ts';

type Op = { user_id: string; role: 'organizer' | 'lead' | 'crew' | 'viewer' };

const canRemove = (target: string, ownerId: string | null, ops: Op[]) => removeVerdict('organizer', target, ownerId, ops);
```

Leave the existing `describe('canRemove', ...)` cases unchanged; they must still pass through the shared rule. Then, in `tests/checkin-function-gates.spec.ts`, replace the `GATES` array with:

```ts
const GATES: [string, string][] = [
  ['checkin-create-checkout',  "can(role, 'go_live')"],
  ['checkin-enable-event',     "can(role, 'test_setup')"],
  ['checkin-enable-event',     "can(role, 'go_live')"],
  ['checkin-import-attendees', "can(role, 'manage_guests')"],
  ['checkin-send-qr-emails',   "can(role, 'manage_guests')"],
  ['checkin-kiosk-pair',       "can(role, 'kiosk')"],
  ['checkin-record-scans',     "can(role, 'desk')"],
  ['checkin-invite-staff',     "can(role, 'invite_crew')"],
  ['checkin-invite-staff',     "can(role, 'transfer_owner')"],
  ['checkin-invite-staff',     "can(role, 'archive_event')"],
  ['checkin-invite-staff',     'invitableRoles(role).includes(want)'],
  ['checkin-invite-staff',     'removeVerdict(role, target, ev.created_by, team)'],
];
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/checkin-staff.spec.ts tests/checkin-function-gates.spec.ts`
Expected: `checkin-staff.spec.ts` PASS (the shared rule already exists); `checkin-function-gates.spec.ts` FAIL on the five invite-staff gates and on `checkin-invite-staff no longer compares an operator row by hand` (`me?.role`).

- [ ] **Step 3: Rewrite the function**

Replace the whole of `supabase/functions/checkin-invite-staff/index.ts` with:

```ts
// supabase/functions/checkin-invite-staff/index.ts
// People on one check-in event: list, invite and remove them, plus two
// owner-only actions, transfer_owner and archive_event. Who may do what
// comes from _shared/checkin-roles.ts (design:
// docs/superpowers/specs/2026-10-04-checkin-roles-design.md).
//
// A new address gets a Supabase invite carrying checkin_staff = 'true',
// which handle_new_auth_user turns into a check-in-only leod_users row
// (never a director) for every role, lead and viewer included (ruling 9).
// An existing CueDeck user just gets the grant and a short notice email,
// unless they have never signed in: then the first invite was lost or
// expired, so they get a fresh invite (or set-password) link, also when
// re-invited with the role they already hold. Removing deletes the grant
// only; the login is theirs.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'
import {
  can, invitableRoles, isUuid, loadCallerRole, removeVerdict, GRANT_ROLES, type GrantRole,
} from '../_shared/checkin-roles.ts'

function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const ACTIONS = ['list', 'invite', 'remove', 'transfer_owner', 'archive_event']

const REMOVE_ERRORS: Record<string, [string, number]> = {
  forbidden: ['Desk leads can remove desk staff only', 403],
  not_found: ['Not on this event', 404],
  event_owner: ['The event owner cannot be removed', 409],
  last_organizer: ['An event needs at least one organizer', 409],
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: caller, error: callerErr } = await sb.from('leod_users')
    .select('active').eq('id', user.id).maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 500)
  if (!caller || caller.active === false) return json({ error: 'Account inactive' }, 403)

  const event_id = String(body.event_id || '')
  const action = String(body.action || '')
  if (!isUuid(event_id) || !ACTIONS.includes(action)) return json({ error: 'event_id and action required' }, 400)

  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) return json({ error: roleErr }, 500)
  if (!can(role, 'invite_crew')) return json({ error: 'Forbidden, organizers and desk leads only' }, 403)

  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('name, created_by, created_via').eq('id', event_id).single()
  if (evErr || !ev) return json({ error: evErr?.message || 'Event not found' }, 404)

  const { data: ops, error: opsErr } = await sb.from('leod_checkin_operators')
    .select('user_id, role').eq('event_id', event_id).in('role', GRANT_ROLES)
  if (opsErr) return json({ error: opsErr.message }, 500)
  const team: { user_id: string; role: string }[] = ops || []

  if (action === 'list') {
    const ids = team.map(o => o.user_id)
    const { data: people, error: pErr } = ids.length
      ? await sb.from('leod_users').select('id, email, name').in('id', ids)
      : { data: [], error: null }
    if (pErr) return json({ error: pErr.message }, 500)
    // Complimentary status follows the owner (ruling 3), so the owner's
    // transfer dialog needs it for each organizer. Nobody else sees it.
    let comp = new Set<string>()
    if (role === 'owner' && ids.length) {
      const { data: comps, error: cErr } = await sb.from('leod_checkin_comp_accounts').select('user_id').in('user_id', ids)
      if (cErr) return json({ error: cErr.message }, 500)
      comp = new Set((comps || []).map((c: { user_id: string }) => c.user_id))
    }
    const byId = new Map((people || []).map((p: { id: string; email: string | null; name: string | null }) => [p.id, p]))
    return json({ ok: true, staff: team.map(o => ({
      user_id: o.user_id, role: o.role,
      email: byId.get(o.user_id)?.email ?? null, name: byId.get(o.user_id)?.name ?? null,
      is_owner: o.user_id === ev.created_by,
      ...(role === 'owner' ? { is_comp: comp.has(o.user_id) } : {}),
    })) })
  }

  if (action === 'remove') {
    const target = String(body.user_id || '')
    if (!isUuid(target)) return json({ error: 'user_id required' }, 400)
    const verdict = removeVerdict(role, target, ev.created_by, team)
    if (!verdict.ok) {
      const [msg, status] = REMOVE_ERRORS[verdict.code]
      return json({ error: msg, code: verdict.code }, status)
    }
    const { error: delErr } = await sb.from('leod_checkin_operators').delete().eq('event_id', event_id).eq('user_id', target)
    if (delErr) return json({ error: delErr.message }, 500)
    return json({ ok: true })
  }

  if (action === 'transfer_owner') {
    if (!can(role, 'transfer_owner')) return json({ error: 'Only the event owner can transfer ownership', code: 'not_owner' }, 403)
    // Console events belong to the console account that created them (ruling 3).
    if (ev.created_via !== 'checkin') {
      return json({ error: 'This event belongs to a CueDeck console account and cannot be transferred here', code: 'console_event' }, 409)
    }
    const target = String(body.user_id || '')
    if (!isUuid(target) || target === user.id) return json({ error: 'Choose another organizer', code: 'bad_target' }, 400)
    const row = team.find(o => o.user_id === target)
    if (!row || row.role !== 'organizer') {
      return json({ error: 'Ownership can only go to an organizer on this event', code: 'not_organizer' }, 409)
    }
    // The old owner stays on as an organizer. Their row normally exists
    // (auto-grant trigger); create it if not, never change an existing one.
    const { error: keepErr } = await sb.from('leod_checkin_operators')
      .upsert({ event_id, user_id: user.id, role: 'organizer' }, { onConflict: 'event_id,user_id', ignoreDuplicates: true })
    if (keepErr) return json({ error: keepErr.message }, 500)
    // Compare-and-set on created_by: two tabs transferring at once cannot both win.
    const { data: moved, error: mvErr } = await sb.from('leod_events')
      .update({ created_by: target }).eq('id', event_id).eq('created_by', user.id).select('id')
    if (mvErr) return json({ error: mvErr.message }, 500)
    if (!moved || moved.length === 0) return json({ error: 'Ownership has already changed. Reload the page.', code: 'owner_changed' }, 409)
    return json({ ok: true })
  }

  if (action === 'archive_event') {
    if (!can(role, 'archive_event')) return json({ error: 'Only the event owner can delete this event', code: 'not_owner' }, 403)
    if (ev.created_via !== 'checkin') {
      return json({ error: 'This event belongs to a CueDeck console account and cannot be deleted here', code: 'console_event' }, 409)
    }
    // Ruling 2: delete means archive, and only while in test mode. A live
    // event holds a purchase and attendance.
    const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
      .select('status').eq('event_id', event_id).maybeSingle()
    if (entErr) return json({ error: entErr.message }, 500)
    if (ent?.status === 'live') {
      return json({ error: 'A live event cannot be deleted here. Email support@cuedeck.io and we will help.', code: 'live_event' }, 409)
    }
    const { data: gone, error: arErr } = await sb.from('leod_events')
      .update({ active: false }).eq('id', event_id).eq('created_by', user.id).select('id')
    if (arErr) return json({ error: arErr.message }, 500)
    if (!gone || gone.length === 0) return json({ error: 'Ownership has changed. Reload the page.', code: 'owner_changed' }, 409)
    return json({ ok: true })
  }

  // ── invite ──
  const email = normalizeInviteEmail(body.email)
  const want: GrantRole | null = typeof body.role === 'string' && (GRANT_ROLES as string[]).includes(body.role)
    ? body.role as GrantRole : null
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (!email || !want) return json({ error: 'A valid email and role are required' }, 400)
  if (!invitableRoles(role).includes(want)) {
    return json({ error: 'Desk leads can invite desk staff only', code: 'role_not_allowed' }, 403)
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: eventCount, error: ecErr } = await sb.from('leod_checkin_invite_log')
    .select('id', { count: 'exact', head: true }).eq('event_id', event_id).gte('created_at', since)
  if (ecErr) return json({ error: ecErr.message }, 500)
  const { count: inviterCount, error: icErr } = await sb.from('leod_checkin_invite_log')
    .select('id', { count: 'exact', head: true }).eq('inviter_id', user.id).gte('created_at', since)
  if (icErr) return json({ error: icErr.message }, 500)
  if ((eventCount ?? 0) >= 50 || (inviterCount ?? 0) >= 100) {
    return json({ error: 'Invite limit reached for today', code: 'invite_rate' }, 429)
  }

  const appUrl = Deno.env.get('ALLOWED_ORIGIN') || 'https://app.cuedeck.io'
  const likeSafe = email.replace(/[\\%_]/g, (m) => '\\' + m)
  const { data: existing, error: exErr } = await sb.from('leod_users')
    .select('id').ilike('email', likeSafe).maybeSingle()
  if (exErr) return json({ error: exErr.message }, 500)

  // What the invitee is being let into, in the email's words.
  const what = want === 'viewer' ? 'the live check-in dashboard' : 'the check-in desk'

  let userId: string
  let isNew = false
  let needsLink = false        // existing account that has never signed in
  let unconfirmed = false
  let alreadyGranted = false
  if (existing) {
    userId = existing.id
    const { data: cur, error: curErr } = await sb.from('leod_checkin_operators')
      .select('role').eq('event_id', event_id).eq('user_id', userId).maybeSingle()
    if (curErr) return json({ error: curErr.message }, 500)
    if (cur && cur.role !== want) {
      return json({ error: 'This person is already on this event with another role', code: 'already_on_event' }, 409)
    }
    const { data: au, error: auErr } = await sb.auth.admin.getUserById(userId)
    if (auErr || !au?.user) {
      console.error('checkin-invite-staff: auth user lookup failed', auErr?.code ?? auErr?.status ?? 'missing')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    needsLink = !au.user.last_sign_in_at
    unconfirmed = !au.user.email_confirmed_at
    alreadyGranted = !!cur
    if (alreadyGranted && !needsLink) return json({ ok: true })
  } else {
    const { data: inv, error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { checkin_staff: 'true', name },
      redirectTo: `${appUrl}/checkin`,
    })
    if (invErr || !inv?.user) {
      console.error('checkin-invite-staff: invite failed', invErr?.code ?? invErr?.status ?? 'unknown')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    userId = inv.user.id
    isNew = true
  }

  if (!alreadyGranted) {
    const { error: grantErr } = await sb.from('leod_checkin_operators')
      .insert({ event_id, user_id: userId, role: want })
    if (grantErr) return json({ error: grantErr.message }, 500)
  }

  if (needsLink) {
    const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
      type: unconfirmed ? 'invite' : 'recovery',
      email,
      options: { redirectTo: `${appUrl}/checkin` },
    })
    const actionLink = link?.properties?.action_link
    if (linkErr || !actionLink) {
      console.error('checkin-invite-staff: invite link failed', linkErr?.code ?? linkErr?.status ?? 'no link')
      return json({ error: 'Could not send the invitation' }, 502)
    }
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: 'Your CueDeck Check-in invitation',
      html: `<p>You have been invited to ${what} for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${escapeHtml(actionLink)}">Accept the invitation and set your password</a></p>` +
            `<p>This link works once. If it has expired, ask the organizer to invite you again.</p>`,
      fromName: 'CueDeck Check-in',
    })
    if (mailErr) {
      console.error('checkin-invite-staff: invite link email failed for event', event_id, mailErr)
      return json({ error: 'Could not send the invitation' }, 502)
    }
  } else if (!isNew) {
    const safeName = ev.name.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 80)
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added to ${safeName} check-in`,
      html: `<p>You can now open ${what} for <b>${escapeHtml(ev.name)}</b>.</p>` +
            `<p><a href="${appUrl}/checkin">Open CueDeck Check-in</a> and sign in with your CueDeck login.</p>`,
      fromName: 'CueDeck Check-in',
    })
    // The grant is in place; a lost notice is not worth failing the
    // request over, but it must be visible.
    if (mailErr) console.error('checkin-invite-staff: notice email failed for event', event_id, mailErr)
  }

  const { error: logErr } = await sb.from('leod_checkin_invite_log').insert({ event_id, inviter_id: user.id })
  if (logErr) console.error('checkin-invite-staff: invite log insert failed', logErr.message)

  return json({ ok: true })
})
```

- [ ] **Step 4: Run tests and type check**

Run: `npx vitest run tests/checkin-staff.spec.ts tests/checkin-function-gates.spec.ts tests/checkin-roles.spec.ts`
Expected: PASS.

Run: `deno check supabase/functions/checkin-invite-staff/index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/checkin-invite-staff/index.ts tests/checkin-staff.spec.ts tests/checkin-function-gates.spec.ts
git commit -m "feat(checkin): invite-staff handles five roles, lead limits, ownership transfer and archive"
```

- [ ] **Step 6: Deploy and smoke-test the gate**

Run: `bash scripts/deploy-functions.sh checkin-invite-staff`
Expected: `OK  checkin-invite-staff deployed` and a `pong`.

Then, unauthenticated (expected 401, proving the JWT gate runs before anything else):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-invite-staff -H 'Content-Type: application/json' -d '{"event_id":"11111111-1111-4111-8111-111111111111","action":"list"}'
```

Expected: `401`.

---

### Task 7: Desk walk-ins (`checkin-add-walk-in`)

**Files:**
- Create: `supabase/functions/_shared/checkin-walk-in.ts`
- Create: `supabase/functions/checkin-add-walk-in/index.ts`
- Create: `tests/checkin-walk-in.spec.ts`
- Modify: `tests/checkin-function-gates.spec.ts` (GATES array)
- Modify: `scripts/deploy-functions.sh:8` (`ALL_FUNCTIONS`)

**Interfaces:**
- Consumes: `can`, `isUuid`, `loadCallerRole` (Task 1); `TEST_CAP` from `_shared/checkin-policy.ts`; `source = 'walk_in'` (Task 2).
- Produces:
  - `normalizeWalkIn(body: Record<string, unknown>): { ok: true; row: WalkIn } | { ok: false; error: string }` with `WalkIn = { first_name, last_name, email: string | null, company: string | null, ticket_type: string }`.
  - `POST /functions/v1/checkin-add-walk-in` `{ event_id, first_name, last_name, email?, company?, ticket_type? }` returns `{ ok: true, attendee: { id, event_id, first_name, last_name, email, company, ticket_type, qr_token, checked_in_at, badge_printed_at } }`. Errors: 400 `invalid`, 403 `forbidden` / `test_cap`, 409 `already_registered`.

- [ ] **Step 1: Write the failing test**

Create `tests/checkin-walk-in.spec.ts`:

```ts
// tests/checkin-walk-in.spec.ts
import { describe, it, expect } from 'vitest';
import { normalizeWalkIn } from '../supabase/functions/_shared/checkin-walk-in.ts';

describe('normalizeWalkIn', () => {
  it('trims and collapses spaces, defaults the ticket type', () => {
    expect(normalizeWalkIn({ first_name: '  Ewa ', last_name: 'Sample  Two', company: ' Contoso  Demo ' })).toEqual({
      ok: true, row: { first_name: 'Ewa', last_name: 'Sample Two', email: null, company: 'Contoso Demo', ticket_type: 'attendee' },
    });
  });
  it('keeps the email as typed after trimming', () => {
    const r = normalizeWalkIn({ first_name: 'A', last_name: 'B', email: ' Ewa@Example.com ' });
    expect(r).toEqual({ ok: true, row: { first_name: 'A', last_name: 'B', email: 'Ewa@Example.com', company: null, ticket_type: 'attendee' } });
  });
  it('requires both names', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: '  ' })).toEqual({ ok: false, error: 'First and last name are required' });
    expect(normalizeWalkIn({})).toEqual({ ok: false, error: 'First and last name are required' });
  });
  it('rejects a malformed email', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: 'not an email' })).toEqual({ ok: false, error: 'That email address does not look right' });
  });
  it('rejects over-long fields', () => {
    expect(normalizeWalkIn({ first_name: 'x'.repeat(121), last_name: 'B' })).toEqual({ ok: false, error: 'A name is too long' });
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', company: 'x'.repeat(201) })).toEqual({ ok: false, error: 'The company name is too long' });
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', ticket_type: 'x'.repeat(61) })).toEqual({ ok: false, error: 'The ticket type is too long' });
  });
  it('ignores non-string values', () => {
    expect(normalizeWalkIn({ first_name: 'A', last_name: 'B', email: 42, company: ['x'] })).toEqual({
      ok: true, row: { first_name: 'A', last_name: 'B', email: null, company: null, ticket_type: 'attendee' },
    });
  });
});
```

In `tests/checkin-function-gates.spec.ts`, add this line as the last entry of the `GATES` array:

```ts
  ['checkin-add-walk-in',      "can(role, 'walk_in')"],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/checkin-walk-in.spec.ts tests/checkin-function-gates.spec.ts`
Expected: FAIL (`checkin-walk-in.ts` not found; `ENOENT ... checkin-add-walk-in/index.ts`).

- [ ] **Step 3: Write the validation module**

Create `supabase/functions/_shared/checkin-walk-in.ts`:

```ts
// supabase/functions/_shared/checkin-walk-in.ts
// Validation for a desk walk-in (roles ruling 7). Pure, so vitest can
// import it; tests/checkin-walk-in.spec.ts.

export type WalkIn = {
  first_name: string
  last_name: string
  email: string | null
  company: string | null
  ticket_type: string
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

export function normalizeWalkIn(body: Record<string, unknown>): { ok: true; row: WalkIn } | { ok: false; error: string } {
  const first = clean(body.first_name)
  const last = clean(body.last_name)
  if (!first || !last) return { ok: false, error: 'First and last name are required' }
  if (first.length > 120 || last.length > 120) return { ok: false, error: 'A name is too long' }
  const email = clean(body.email)
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return { ok: false, error: 'That email address does not look right' }
  }
  const company = clean(body.company)
  if (company.length > 200) return { ok: false, error: 'The company name is too long' }
  const ticket = clean(body.ticket_type) || 'attendee'
  if (ticket.length > 60) return { ok: false, error: 'The ticket type is too long' }
  return { ok: true, row: { first_name: first, last_name: last, email: email || null, company: company || null, ticket_type: ticket } }
}
```

- [ ] **Step 4: Write the function**

Create `supabase/functions/checkin-add-walk-in/index.ts`:

```ts
// supabase/functions/checkin-add-walk-in/index.ts
// A desk lead or above adds a person who is standing at the desk (roles
// ruling 7). Service role, because checkin_guard_attendee_insert refuses
// is_test from any JWT caller, and a test-mode walk-in must be is_test so
// it counts toward the test cap and is cleared at go-live.
// The desk then checks the person in through the normal outbox.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { TEST_CAP } from '../_shared/checkin-policy.ts'
import { can, isUuid, loadCallerRole } from '../_shared/checkin-roles.ts'
import { normalizeWalkIn } from '../_shared/checkin-walk-in.ts'

const COLS = 'id,event_id,first_name,last_name,email,company,ticket_type,qr_token,checked_in_at,badge_printed_at'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: caller, error: callerErr } = await sb.from('leod_users')
    .select('active').eq('id', user.id).maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 500)
  if (!caller || caller.active === false) return json({ error: 'Account inactive' }, 403)

  const event_id = String(body.event_id || '')
  if (!isUuid(event_id)) return json({ error: 'event_id required' }, 400)

  const { role, error: roleErr } = await loadCallerRole(sb, event_id, user.id)
  if (roleErr) return json({ error: roleErr }, 500)
  if (!can(role, 'walk_in')) {
    return json({ error: 'Only an organizer or a desk lead can add a walk-in', code: 'forbidden' }, 403)
  }

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, status').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent?.checkin_core) return json({ error: 'Check-in is not enabled for this event', code: 'forbidden' }, 403)

  const parsed = normalizeWalkIn(body)
  if (!parsed.ok) return json({ error: parsed.error, code: 'invalid' }, 400)

  const isTest = ent.status !== 'live'
  if (isTest) {
    const { data: used, error: usedErr } = await sb.rpc('checkin_test_usage', { p_event_id: event_id })
    if (usedErr || typeof used !== 'number') {
      console.error('checkin-add-walk-in: test usage read failed for event', event_id, usedErr?.code)
      return json({ error: 'The walk-in was not added' }, 500)
    }
    if (used >= TEST_CAP) {
      return json({ error: 'This event is in test mode and has used its ' + TEST_CAP + ' test check-ins. Go live to keep adding people.', code: 'test_cap' }, 403)
    }
  }

  const { data: created, error: insErr } = await sb.from('leod_checkin_attendees')
    .insert({
      event_id,
      ...parsed.row,
      qr_token: crypto.randomUUID().replace(/-/g, ''),
      source: 'walk_in',
      is_test: isTest,
    })
    .select(COLS)
    .single()
  if (insErr) {
    // Migration 050's unique index on (event_id, lower(email)).
    if (insErr.code === '23505') {
      return json({ error: 'Someone with this email is already on the list. Search for them instead.', code: 'already_registered' }, 409)
    }
    console.error('checkin-add-walk-in: insert failed for event', event_id, insErr.code)
    return json({ error: 'The walk-in was not added' }, 500)
  }
  return json({ ok: true, attendee: created })
})
```

- [ ] **Step 5: Register the function for deploys**

In `scripts/deploy-functions.sh`, change line 8 to end with `checkin-create-checkout checkin-add-walk-in)`:

```bash
ALL_FUNCTIONS=(go-live end-session set-ready hold-stage call-speaker cancel-session reinstate apply-delay set-overrun invite-operator create-checkout-session stripe-webhook customer-portal checkin-enable-event checkin-import-attendees checkin-send-qr-emails checkin-record-scans checkin-self-register checkin-kiosk-pair checkin-invite-staff checkin-price checkin-create-checkout checkin-add-walk-in)
```

- [ ] **Step 6: Run tests and type check**

Run: `npx vitest run tests/checkin-walk-in.spec.ts tests/checkin-function-gates.spec.ts`
Expected: PASS.

Run: `deno check supabase/functions/checkin-add-walk-in/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/checkin-walk-in.ts supabase/functions/checkin-add-walk-in/index.ts tests/checkin-walk-in.spec.ts tests/checkin-function-gates.spec.ts scripts/deploy-functions.sh
git commit -m "feat(checkin): desk walk-ins through checkin-add-walk-in"
```

- [ ] **Step 8: Deploy**

Run: `bash scripts/deploy-functions.sh checkin-add-walk-in`
Expected: `OK  checkin-add-walk-in deployed` and a `pong`. Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-add-walk-in -H 'Content-Type: application/json' -d '{"event_id":"11111111-1111-4111-8111-111111111111","first_name":"A","last_name":"B"}'
```

Expected: `401`.

---
### Task 8: Dashboard logic module (`checkin-dashboard.js`)

**Files:**
- Create: `checkin-dashboard.js`
- Create: `tests/checkin-dashboard.spec.ts`
- Modify: `.vercelignore`, `scripts/verify-no-public-internals.sh`

**Interfaces:**
- Consumes: `checkinWindow` from `./checkin-window.js`; the `checkin_event_stats` JSON shape (Task 4).
- Produces (all pure, all exported):
  - constants `BUCKET_S = 900`, `MAX_BUCKETS = 96`, `ONLINE_WITHIN_S = 90`, `PACE_MIN_CHECKINS = 10`, `PACE_MIN_ACTIVE_MINUTES = 5`
  - `fmtClock(ms, timeZone): string` (`HH:MM`, 24 h)
  - `pct(n, d): number | null`
  - `peakBucket(arrivals): { t, n } | null`
  - `tiles(stats, windowClosed): { registered, checkedIn, turnout: number | null, expectedLabel: 'Still expected' | 'No-shows', expected, walkIns, peak }`
  - `arrivalSeries(arrivals, timeZone): { labels: string[], bars: number[], cumulative: number[] }`
  - `statusDoughnut(stats, windowClosed): { labels, data }`, `ticketBars(stats): { labels, registered, checkedIn }`, `sourceBars(stats): { labels, data }`, `qrBars(stats): { labels, data }`
  - `rateAt(last25, minutesAgo): number | null`, `arrivalRate(last25): number | null`, `fmtRate(r): string`
  - `clientView(stats): { registered, checkedIn, turnout, peak, rate: number | null }`
  - `deskState(desk, timeZone): { kind: 'online' | 'syncing' | 'offline', text }`
  - `deskSpeed(speedRow): number` (check-ins per minute)
  - `deskRows(ops, timeZone): { label, who, state }[]`
  - `gapLines(ops, timeZone): string[]`
  - `paceMessages({ stats, nowMs, eventStartMs }): { tone: 'info' | 'warn', text }[]`
  - `eventStartUtc(eventDate, startTime, timeZone): Date | null`

- [ ] **Step 1: Write the failing test**

Create `tests/checkin-dashboard.spec.ts`:

```ts
// tests/checkin-dashboard.spec.ts
// Pure shaping for /checkin/dashboard. Every number the page shows comes
// through these functions, so the event-day rules are pinned here:
// 90 s online, 10 check-ins before pace, 5 active minutes per desk,
// 90% of capacity for 10 minutes before the staffing warning.
import { describe, it, expect } from 'vitest';
import * as d from '../checkin-dashboard.js';

const T0 = 1792310400; // 2026-10-18T08:00:00Z, 10:00 in Warsaw
const WAW = 'Europe/Warsaw';
const stats = (over: Record<string, unknown> = {}) => ({
  role: 'organizer', status: 'live', registered: 120, checked_in: 45, walk_ins: 6,
  by_source: { import: 114, kiosk: 4, walk_in: 2 }, qr: { sent: 100, not_sent: 15, no_email: 5 },
  by_ticket: [{ ticket_type: 'attendee', registered: 100, checked_in: 40 }, { ticket_type: 'VIP', registered: 20, checked_in: 5 }],
  arrivals: [{ t: T0, n: 10 }, { t: T0 + 900, n: 25 }, { t: T0 + 1800, n: 10 }],
  last_25_min: Array(25).fill(0), ops: null, ...over,
});

describe('fmtClock and pct', () => {
  it('formats in the event timezone, 24 hour', () => {
    expect(d.fmtClock(T0 * 1000, WAW)).toBe('10:00');
    expect(d.fmtClock(T0 * 1000, 'Asia/Kolkata')).toBe('13:30');
  });
  it('never divides by zero', () => {
    expect(d.pct(45, 120)).toBe(38);
    expect(d.pct(0, 0)).toBeNull();
  });
});

describe('tiles', () => {
  it('reads the stats', () => {
    expect(d.tiles(stats(), false)).toEqual({
      registered: 120, checkedIn: 45, turnout: 38, expectedLabel: 'Still expected', expected: 75, walkIns: 6,
      peak: { t: T0 + 900, n: 25 },
    });
  });
  it('becomes No-shows once the window closes', () => {
    expect(d.tiles(stats(), true).expectedLabel).toBe('No-shows');
  });
  it('an empty list has no turnout and no peak', () => {
    const t = d.tiles(stats({ registered: 0, checked_in: 0, walk_ins: 0, arrivals: [] }), false);
    expect(t.turnout).toBeNull();
    expect(t.expected).toBe(0);
    expect(t.peak).toBeNull();
  });
});

describe('peakBucket', () => {
  it('takes the earliest of equal peaks', () => {
    expect(d.peakBucket([{ t: T0, n: 5 }, { t: T0 + 900, n: 5 }])).toEqual({ t: T0, n: 5 });
  });
  it('is null with no arrivals', () => { expect(d.peakBucket([])).toBeNull(); });
});

describe('arrivalSeries', () => {
  it('fills empty 15-minute buckets and runs a cumulative total', () => {
    const s = d.arrivalSeries([{ t: T0, n: 2 }, { t: T0 + 1800, n: 3 }], WAW);
    expect(s).toEqual({ labels: ['10:00', '10:15', '10:30'], bars: [2, 0, 3], cumulative: [2, 2, 5] });
  });
  it('keeps the latest 96 buckets and carries earlier arrivals into the total', () => {
    const s = d.arrivalSeries([{ t: T0, n: 2 }, { t: T0 + 200 * 900, n: 3 }], WAW);
    expect(s.labels).toHaveLength(96);
    expect(s.cumulative[0]).toBe(2);
    expect(s.cumulative[95]).toBe(5);
    expect(s.bars[95]).toBe(3);
  });
  it('is empty with no arrivals', () => {
    expect(d.arrivalSeries([], WAW)).toEqual({ labels: [], bars: [], cumulative: [] });
  });
});

describe('chart data', () => {
  it('status doughnut', () => {
    expect(d.statusDoughnut(stats(), false)).toEqual({ labels: ['Checked in', 'Still expected'], data: [45, 75] });
    expect(d.statusDoughnut(stats(), true).labels[1]).toBe('No-show');
  });
  it('ticket bars carry turnout in the label', () => {
    expect(d.ticketBars(stats())).toEqual({ labels: ['attendee · 40%', 'VIP · 25%'], registered: [100, 20], checkedIn: [40, 5] });
  });
  it('sources and QR status', () => {
    expect(d.sourceBars(stats())).toEqual({ labels: ['Imported', 'Kiosk', 'Walk-in'], data: [114, 4, 2] });
    expect(d.qrBars(stats())).toEqual({ labels: ['Sent', 'Not sent', 'No email address'], data: [100, 15, 5] });
  });
});

describe('rates', () => {
  const last = [...Array(10).fill(0), ...Array(15).fill(2)];
  it('arrival rate is the last 15 minutes per minute', () => {
    expect(d.arrivalRate(last)).toBe(2);
  });
  it('rateAt looks further back', () => {
    expect(d.rateAt(last, 10)).toBeCloseTo((5 * 2) / 15);
    expect(d.rateAt(last, 11)).toBeNull();
  });
  it('formats', () => {
    expect(d.fmtRate(12.4)).toBe('12');
    expect(d.fmtRate(2.25)).toBe('2.3');
    expect(d.fmtRate(2)).toBe('2');
  });
});

describe('clientView', () => {
  it('hides the rate until 10 check-ins', () => {
    expect(d.clientView(stats({ checked_in: 9 })).rate).toBeNull();
    expect(d.clientView(stats({ last_25_min: [...Array(10).fill(0), ...Array(15).fill(1)] })).rate).toBe(1);
  });
  it('numbers only', () => {
    expect(Object.keys(d.clientView(stats())).sort()).toEqual(['checkedIn', 'peak', 'rate', 'registered', 'turnout']);
  });
});

describe('deskState (90 s rule)', () => {
  it('89 and 90 seconds are online, 91 is offline', () => {
    expect(d.deskState({ seconds_since_seen: 89, pending_count: 0 }, WAW)).toEqual({ kind: 'online', text: 'Online' });
    expect(d.deskState({ seconds_since_seen: 90, pending_count: 0 }, WAW).kind).toBe('online');
    expect(d.deskState({ seconds_since_seen: 91, pending_count: 0, last_seen_at: '2026-10-18T09:02:00Z' }, WAW))
      .toEqual({ kind: 'offline', text: 'Offline since 11:02' });
  });
  it('online with a queue is syncing', () => {
    expect(d.deskState({ seconds_since_seen: 10, pending_count: 14 }, WAW)).toEqual({ kind: 'syncing', text: 'Syncing, 14 waiting' });
  });
  it('a kiosk never seen is not connected yet', () => {
    expect(d.deskState({ seconds_since_seen: null, last_seen_at: null }, WAW)).toEqual({ kind: 'offline', text: 'Not connected yet' });
  });
});

describe('deskSpeed', () => {
  const sp = (busiest: number, minutes: number) => ({
    desk_id: 'd', busiest_15: busiest, active_minutes: 10,
    first_at: '2026-10-18T08:00:00Z', last_at: new Date(Date.parse('2026-10-18T08:00:00Z') + minutes * 60000).toISOString(),
  });
  it('a long-running desk divides its busiest window by 15', () => { expect(d.deskSpeed(sp(30, 120))).toBe(2); });
  it('a desk open 6 minutes divides by 6, not 15', () => { expect(d.deskSpeed(sp(30, 6))).toBe(5); });
  it('never divides by less than 5 minutes', () => { expect(d.deskSpeed(sp(10, 1))).toBe(2); });
  it('zero without scans', () => { expect(d.deskSpeed(null)).toBe(0); });
});

describe('deskRows and gapLines', () => {
  const ops = {
    desks: [{ desk_id: 'a', label: 'Desk 2', operator: 'Ewa Sample', seconds_since_seen: 20, pending_count: 0, last_seen_at: '2026-10-18T09:10:00Z' },
            { desk_id: 'b', label: 'Desk 3', operator: null, seconds_since_seen: 300, pending_count: 14, last_seen_at: '2026-10-18T09:05:00Z' }],
    kiosks: [{ label: 'Lobby kiosk', seconds_since_seen: 5, last_seen_at: '2026-10-18T09:12:00Z' }],
    speeds: [], gaps: [
      { desk_id: 'a', start_at: '2026-10-18T09:02:00Z', end_at: '2026-10-18T09:09:00Z', synced_ok: 23 },
      { desk_id: 'b', start_at: '2026-10-18T08:30:00Z', end_at: '2026-10-18T08:31:00Z', synced_ok: 1 },
      { desk_id: 'z', start_at: '2026-10-18T08:00:00Z', end_at: '2026-10-18T08:05:00Z', synced_ok: 2 },
    ],
  };
  it('lists desks then kiosks', () => {
    expect(d.deskRows(ops, WAW)).toEqual([
      { label: 'Desk 2', who: 'Ewa Sample', state: { kind: 'online', text: 'Online' } },
      { label: 'Desk 3', who: '', state: { kind: 'offline', text: 'Offline since 11:05' } },
      { label: 'Lobby kiosk', who: 'Kiosk', state: { kind: 'online', text: 'Online' } },
    ]);
  });
  it('claims "0 lost" only when the desk reports an empty queue', () => {
    expect(d.gapLines(ops, WAW)).toEqual([
      'Desk 2 offline 11:02 to 11:09, 23 check-ins synced late, 0 lost.',
      'Desk 3 offline 10:30 to 10:31, 1 check-in synced late, 14 still on the device.',
      'A desk offline 10:00 to 10:05, 2 check-ins synced late, no report from that desk yet.',
    ]);
  });
});

describe('paceMessages', () => {
  const NOW = Date.parse('2026-10-18T07:30:00Z');
  const START = Date.parse('2026-10-18T07:00:00Z');
  const desk = (id: string, since = 10) => ({ desk_id: id, label: id, seconds_since_seen: since, pending_count: 0, last_seen_at: '2026-10-18T07:29:00Z' });
  const speed = (id: string, busiest: number, active = 10) => ({ desk_id: id, busiest_15: busiest, active_minutes: active, first_at: '2026-10-18T06:00:00Z', last_at: '2026-10-18T07:29:00Z' });
  const ops = (over: Record<string, unknown> = {}) => ({ desks: [desk('a'), desk('b')], kiosks: [], gaps: [], speeds: [speed('a', 90), speed('b', 105)], ...over });

  it('nothing for roles without the desk panel', () => {
    expect(d.paceMessages({ stats: stats({ ops: null }), nowMs: NOW, eventStartMs: START })).toEqual([]);
  });
  it('waits for 10 check-ins', () => {
    expect(d.paceMessages({ stats: stats({ checked_in: 9, ops: ops() }), nowMs: NOW, eventStartMs: START }))
      .toEqual([{ tone: 'info', text: 'Pace appears after the first 10 check-ins.' }]);
  });
  it('waits for a desk with 5 active minutes', () => {
    expect(d.paceMessages({ stats: stats({ ops: ops({ speeds: [speed('a', 90, 4)] }) }), nowMs: NOW, eventStartMs: START }))
      .toEqual([{ tone: 'info', text: 'Desk speed appears once a desk has checked people in for 5 minutes.' }]);
  });
  it('warns when arrivals stay above 90% of capacity for 10 minutes', () => {
    // capacity 6 + 7 = 13/min; 12 per minute for the last 25 minutes.
    const s = stats({ ops: ops(), last_25_min: Array(25).fill(12) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })).toEqual([
      { tone: 'warn', text: 'Arrivals (12/min) are close to what your 2 desks clear (13/min). Consider opening another desk.' },
    ]);
  });
  it('does not warn when one of the last 10 minutes was below the line', () => {
    const last = Array(25).fill(12); last[0] = 0; last[1] = 0; last[2] = 0; last[3] = 0; last[4] = 0; last[5] = 0;
    // rateAt(k = 9) covers indexes 1..15: 5 quiet minutes pull it to 8/min, under 11.7.
    expect(d.paceMessages({ stats: stats({ ops: ops(), last_25_min: last }), nowMs: NOW, eventStartMs: START })).toEqual([]);
  });
  it('an offline desk adds no capacity', () => {
    const s = stats({ ops: ops({ desks: [desk('a'), desk('b', 200)] }), last_25_min: Array(25).fill(6) });
    expect(d.paceMessages({ stats: s, nowMs: NOW, eventStartMs: START })[0].text)
      .toBe('Arrivals (6/min) are close to what your desk clears (6/min). Consider opening another desk.');
  });
  it('before the start, says how long the rest will take at measured speed', () => {
    const s = stats({ registered: 131, checked_in: 45, ops: ops() });
    expect(d.paceMessages({ stats: s, nowMs: START - 60000, eventStartMs: START })).toEqual([
      { tone: 'info', text: "86 still expected. At your desks' measured speed that is about 7 minutes of check-in." },
    ]);
  });
});

describe('eventStartUtc', () => {
  it('is DST-correct', () => {
    expect(d.eventStartUtc('2026-10-26', '09:00:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(d.eventStartUtc('2026-11-12', '18:30', 'Africa/Cairo')!.toISOString()).toBe('2026-11-12T16:30:00.000Z');
    expect(d.eventStartUtc('2026-11-20', '09:15', 'Asia/Kolkata')!.toISOString()).toBe('2026-11-20T03:45:00.000Z');
  });
  it('null for anything it cannot read', () => {
    expect(d.eventStartUtc('2026-02-31', '09:00', 'Europe/Warsaw')).toBeNull();
    expect(d.eventStartUtc('2026-10-26', 'nine', 'Europe/Warsaw')).toBeNull();
    expect(d.eventStartUtc('2026-10-26', '09:00', 'Not/AZone')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/checkin-dashboard.spec.ts`
Expected: FAIL, `Failed to resolve import "../checkin-dashboard.js"`.

- [ ] **Step 3: Write the module**

Create `checkin-dashboard.js`:

```js
// checkin-dashboard.js: pure shaping for /checkin/dashboard.
// Input is the JSON from checkin_event_stats (migration 072). Nothing here
// invents a number: when there is not enough measured data the functions
// return null or a "not yet" message. tests/checkin-dashboard.spec.ts.
// Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md (dashboard)
//         docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md (features 1-3)
import { checkinWindow } from './checkin-window.js';

export const BUCKET_S = 900;
export const MAX_BUCKETS = 96;              // one day of 15-minute bars
export const ONLINE_WITHIN_S = 90;
export const PACE_MIN_CHECKINS = 10;
export const PACE_MIN_ACTIVE_MINUTES = 5;
const PACE_WINDOW_MIN = 15;
const SUSTAIN_MIN = 10;
const CLOSE_SHARE = 0.9;

export function fmtClock(ms, timeZone) {
  const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(new Date(ms)); }
  catch { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms)); }
}

export function pct(n, d) { return d > 0 ? Math.round((100 * n) / d) : null; }

export function peakBucket(arrivals) {
  let best = null;
  for (const b of arrivals || []) if (!best || b.n > best.n) best = b;
  return best && best.n > 0 ? { t: best.t, n: best.n } : null;
}

export function tiles(s, windowClosed) {
  return {
    registered: s.registered,
    checkedIn: s.checked_in,
    turnout: pct(s.checked_in, s.registered),
    expectedLabel: windowClosed ? 'No-shows' : 'Still expected',
    expected: Math.max(0, s.registered - s.checked_in),
    walkIns: s.walk_ins,
    peak: peakBucket(s.arrivals),
  };
}

// Bars per 15 minutes with every empty bucket filled in, plus a running
// total. A test event can collect check-ins over days, so only the latest
// MAX_BUCKETS are drawn; arrivals before them still count in the total.
export function arrivalSeries(arrivals, timeZone) {
  const list = arrivals || [];
  if (!list.length) return { labels: [], bars: [], cumulative: [] };
  const byT = new Map(list.map(b => [b.t, b.n]));
  const last = list[list.length - 1].t;
  const start = Math.max(list[0].t, last - (MAX_BUCKETS - 1) * BUCKET_S);
  let run = list.filter(b => b.t < start).reduce((a, b) => a + b.n, 0);
  const labels = [], bars = [], cumulative = [];
  for (let t = start; t <= last; t += BUCKET_S) {
    const n = byT.get(t) || 0;
    run += n;
    labels.push(fmtClock(t * 1000, timeZone));
    bars.push(n);
    cumulative.push(run);
  }
  return { labels, bars, cumulative };
}

export function statusDoughnut(s, windowClosed) {
  return { labels: ['Checked in', windowClosed ? 'No-show' : 'Still expected'],
           data: [s.checked_in, Math.max(0, s.registered - s.checked_in)] };
}

export function ticketBars(s) {
  const rows = s.by_ticket || [];
  return {
    labels: rows.map(r => r.ticket_type + ' · ' + (pct(r.checked_in, r.registered) ?? 0) + '%'),
    registered: rows.map(r => r.registered),
    checkedIn: rows.map(r => r.checked_in),
  };
}

export function sourceBars(s) {
  const b = s.by_source || {};
  return { labels: ['Imported', 'Kiosk', 'Walk-in'], data: [b.import || 0, b.kiosk || 0, b.walk_in || 0] };
}

export function qrBars(s) {
  const q = s.qr || {};
  return { labels: ['Sent', 'Not sent', 'No email address'], data: [q.sent || 0, q.not_sent || 0, q.no_email || 0] };
}

// Check-ins per minute over the 15 minutes ending `minutesAgo` minutes
// before the current minute. last25 is oldest first, current minute last.
export function rateAt(last25, minutesAgo) {
  if (!Array.isArray(last25)) return null;
  const end = last25.length - minutesAgo;
  const begin = end - PACE_WINDOW_MIN;
  if (begin < 0 || end > last25.length) return null;
  return last25.slice(begin, end).reduce((a, b) => a + b, 0) / PACE_WINDOW_MIN;
}
export function arrivalRate(last25) { return rateAt(last25, 0); }

export function fmtRate(r) {
  return String(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10);
}

// The client view (feature 3): numbers only.
export function clientView(s) {
  return {
    registered: s.registered,
    checkedIn: s.checked_in,
    turnout: pct(s.checked_in, s.registered),
    peak: peakBucket(s.arrivals),
    rate: s.checked_in >= PACE_MIN_CHECKINS ? arrivalRate(s.last_25_min) : null,
  };
}

export function deskState(desk, timeZone) {
  const since = desk && typeof desk.seconds_since_seen === 'number' ? desk.seconds_since_seen : null;
  if (since !== null && since <= ONLINE_WITHIN_S) {
    const n = desk.pending_count || 0;
    return n > 0 ? { kind: 'syncing', text: 'Syncing, ' + n + ' waiting' } : { kind: 'online', text: 'Online' };
  }
  if (desk && desk.last_seen_at) return { kind: 'offline', text: 'Offline since ' + fmtClock(Date.parse(desk.last_seen_at), timeZone) };
  return { kind: 'offline', text: 'Not connected yet' };
}

// Check-ins per minute in the desk's busiest 15 minutes. A desk that has
// only worked a few minutes is divided by the minutes it has worked (at
// least 5), not by 15, or its speed would read three times too slow.
export function deskSpeed(sp) {
  if (!sp || !(sp.busiest_15 > 0)) return 0;
  const span = (Date.parse(sp.last_at) - Date.parse(sp.first_at)) / 60000;
  const minutes = Math.min(PACE_WINDOW_MIN, Math.max(PACE_MIN_ACTIVE_MINUTES, Number.isFinite(span) ? span : 0));
  return sp.busiest_15 / minutes;
}

export function deskRows(ops, timeZone) {
  if (!ops) return [];
  return [
    ...(ops.desks || []).map(x => ({ label: x.label, who: x.operator || '', state: deskState(x, timeZone) })),
    ...(ops.kiosks || []).map(k => ({ label: k.label, who: 'Kiosk', state: deskState({ ...k, pending_count: 0 }, timeZone) })),
  ];
}

// "0 lost" is claimed only when that desk's latest heartbeat reported an
// empty queue (event-day spec, feature 1).
export function gapLines(ops, timeZone) {
  if (!ops) return [];
  const desks = new Map((ops.desks || []).map(x => [x.desk_id, x]));
  return (ops.gaps || []).map(g => {
    const desk = desks.get(g.desk_id);
    const n = g.synced_ok || 0;
    const tail = !desk ? 'no report from that desk yet.'
      : desk.pending_count === 0 ? '0 lost.'
      : desk.pending_count + ' still on the device.';
    return (desk ? desk.label : 'A desk') + ' offline ' + fmtClock(Date.parse(g.start_at), timeZone)
      + ' to ' + fmtClock(Date.parse(g.end_at), timeZone) + ', ' + n + (n === 1 ? ' check-in' : ' check-ins')
      + ' synced late, ' + tail;
  });
}

// Staffing advice (feature 2) from measured inputs only.
export function paceMessages({ stats, nowMs, eventStartMs }) {
  const ops = stats && stats.ops;
  if (!ops) return [];
  if ((stats.checked_in || 0) < PACE_MIN_CHECKINS) {
    return [{ tone: 'info', text: 'Pace appears after the first 10 check-ins.' }];
  }
  const measured = (ops.speeds || []).filter(sp => (sp.active_minutes || 0) >= PACE_MIN_ACTIVE_MINUTES);
  if (!measured.length) {
    return [{ tone: 'info', text: 'Desk speed appears once a desk has checked people in for 5 minutes.' }];
  }
  const online = new Set((ops.desks || []).filter(x => deskState(x).kind !== 'offline').map(x => x.desk_id));
  const live = measured.filter(sp => online.has(sp.desk_id));
  const capacity = live.reduce((sum, sp) => sum + deskSpeed(sp), 0);
  const out = [];
  if (capacity <= 0) return out;

  let sustained = true;
  for (let k = 0; k < SUSTAIN_MIN; k++) {
    const r = rateAt(stats.last_25_min, k);
    if (r === null || r <= CLOSE_SHARE * capacity) { sustained = false; break; }
  }
  if (sustained) {
    const who = live.length === 1 ? 'your desk clears' : 'your ' + live.length + ' desks clear';
    out.push({ tone: 'warn', text: 'Arrivals (' + fmtRate(arrivalRate(stats.last_25_min)) + '/min) are close to what '
      + who + ' (' + fmtRate(capacity) + '/min). Consider opening another desk.' });
  }

  const expected = Math.max(0, (stats.registered || 0) - (stats.checked_in || 0));
  if (eventStartMs != null && nowMs < eventStartMs && expected > 0) {
    const mins = Math.max(1, Math.ceil(expected / capacity));
    out.push({ tone: 'info', text: expected + " still expected. At your desks' measured speed that is about "
      + mins + (mins === 1 ? ' minute' : ' minutes') + ' of check-in.' });
  }
  return out;
}

function addDays(ymd, n) {
  const [y, m, dd] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}

// The event's start as a UTC instant. checkinWindow(d, tz).opensAt is local
// midnight of d minus 7 days, so asking for d plus 7 gives midnight of d,
// with the same DST handling the check-in window already has.
export function eventStartUtc(eventDate, startTime, timeZone) {
  const m = /^(\d{2}):(\d{2})/.exec(String(startTime || ''));
  if (!m || typeof eventDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  if (addDays(eventDate, 0) !== eventDate) return null;
  const w = checkinWindow(addDays(eventDate, 7), timeZone);
  if (!w) return null;
  return new Date(w.opensAt.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
}
```

- [ ] **Step 4: Serve the module**

In `.vercelignore`, add after `!/checkin-roles.js`:

```
!/checkin-dashboard.js
```

In `scripts/verify-no-public-internals.sh`, change the last `MUST_200` line `/checkin-roles.js` to:

```bash
  /checkin-roles.js /checkin-dashboard.js
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/checkin-dashboard.spec.ts`
Expected: PASS. Check the two hand-computed cases if they fail: in "warns", capacity is 90/15 + 105/15 = 13 and 12 > 11.7 for k = 0..9; in "before the start", 86 / 13 = 6.6, so 7 minutes.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add checkin-dashboard.js tests/checkin-dashboard.spec.ts .vercelignore scripts/verify-no-public-internals.sh
git commit -m "feat(checkin): dashboard shaping module with pace, desk state and gap rules"
```

---
### Task 9: Dashboard page with tiles, five charts and the client view

**Files:**
- Create: `cuedeck-checkin-dashboard.html`
- Create: `tests/e2e/checkin-mock.ts`
- Create: `tests/e2e/checkin-dashboard.spec.ts`
- Modify: `vercel.json` (rewrite), `.vercelignore`, `scripts/verify-no-public-internals.sh`

**Interfaces:**
- Consumes: `checkin_my_events` (Task 2), `checkin_event_stats` (Task 4), `/checkin-roles.js` (Task 1), `/checkin-dashboard.js` (Task 8), `/checkin-window.js`.
- Produces:
  - Page `/checkin/dashboard?event=<id>` (full view: five tiles, rate line, five charts, links to Client view, Setup, Desk) and `/checkin/dashboard?event=<id>&view=client` (client view). Viewers always get the client view. Refreshes every 30 s while the tab is visible.
  - Element ids and functions Task 10 edits: `#rate` (the desk panel goes right after it), `renderFull(s, closed)` (gains a `renderOps(s)` call), `loadEvent()` (gains the event start computation).
  - Test helpers in `tests/e2e/checkin-mock.ts`: `signedIn(page, userId?, email?)`, `rpc(page, name, body | fn, status?)`, `table(page, name, rows)`, `fn(page, name, handler)`, `myEventsRow(over)`, constants `SB`, `EVENT_ID`, `USER_ID`, `FIXED_NOW`. Tasks 11 to 14 use them.

Playwright needs the static server: from the repo root run `python3 -m http.server 7230 --bind 127.0.0.1` in the background once. If Playwright reports a missing browser executable, run `npx playwright install chromium` once.

- [ ] **Step 1: Write the mock helper**

Create `tests/e2e/checkin-mock.ts`:

```ts
// tests/e2e/checkin-mock.ts
// Mocked Supabase for the check-in pages, so a page can be checked in a
// real browser without a database or an account. Every Supabase URL that
// a test does not mock answers 404 "unmocked", so a missing mock fails
// loudly instead of reaching production.
import type { Page, Route } from '@playwright/test';

export const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A stored supabase-js session that is valid until 2031, so a page clock
// fixed to any 2026 date never tries to refresh it.
export async function signedIn(page: Page, userId = USER_ID, email = 'probe@cuedeck-test.io') {
  const exp = 1924992000;
  const token = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: userId, role: 'authenticated', exp, email }) + '.c2ln';
  const session = {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'probe-refresh',
    user: { id: userId, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
  };
  await page.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, ['sb-sawekpguemzvuvvulfbc-auth-token', JSON.stringify(session)]);
  await page.route(new RegExp('^' + esc(SB) + '/'), (r: Route) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"unmocked"}' }));
}

// POST /rest/v1/rpc/<name>. `body` may be a function of the JSON arguments.
export async function rpc(page: Page, name: string, body: unknown | ((args: Record<string, unknown>) => unknown), status = 200) {
  await page.route(new RegExp('^' + esc(SB + '/rest/v1/rpc/' + name) + '(\\?|$)'), async (r: Route) => {
    let args: Record<string, unknown> = {};
    try { args = r.request().postDataJSON() ?? {}; } catch { /* no body */ }
    const out = typeof body === 'function' ? (body as (a: Record<string, unknown>) => unknown)(args) : body;
    await r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

// GET /rest/v1/<table>?... A .single()/.maybeSingle() read asks for one
// object (Accept: application/vnd.pgrst.object+json); anything else gets the array.
export async function table(page: Page, name: string, rows: unknown[]) {
  await page.route(new RegExp('^' + esc(SB + '/rest/v1/' + name) + '(\\?|$)'), async (r: Route) => {
    const one = /vnd\.pgrst\.object/.test(r.request().headers()['accept'] || '');
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(one ? (rows[0] ?? null) : rows) });
  });
}

// /functions/v1/<name>. The handler gets the parsed JSON body (or {} for GET).
export async function fn(page: Page, name: string, handler: (body: Record<string, unknown>) => { status?: number; body: unknown }) {
  await page.route(new RegExp('^' + esc(SB + '/functions/v1/' + name) + '(\\?|$)'), async (r: Route) => {
    if (r.request().method() === 'OPTIONS') { await r.fulfill({ status: 200, body: 'ok' }); return; }
    let body: Record<string, unknown> = {};
    try { body = r.request().postDataJSON() ?? {}; } catch { /* GET */ }
    const out = handler(body);
    await r.fulfill({ status: out.status ?? 200, contentType: 'application/json', body: JSON.stringify(out.body) });
  });
}

export function myEventsRow(over: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID, name: 'Probe Summit', date: '2026-10-18', venue: 'Hall A', timezone: 'Europe/Warsaw',
    event_start: '09:00:00', event_end: '18:00:00', created_via: 'checkin', is_owner: false, role: 'organizer',
    status: 'live', attendees: 120, arrived: 45, test_used: 0, is_comp: false, ...over,
  };
}

// 2026-10-18 11:00 in Warsaw: inside the check-in window of a 2026-10-18 event.
export const FIXED_NOW = new Date('2026-10-18T09:00:00Z');
```

- [ ] **Step 2: Write the failing browser test**

Create `tests/e2e/checkin-dashboard.spec.ts`:

```ts
// tests/e2e/checkin-dashboard.spec.ts
// /checkin/dashboard with Supabase mocked (tests/e2e/checkin-mock.ts).
// Needs the static server: python3 -m http.server 7230 --bind 127.0.0.1
// Chart.js loads from jsdelivr, so this needs network access.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, myEventsRow, EVENT_ID, FIXED_NOW } from './checkin-mock';

const T0 = 1792310400; // 10:00 Warsaw on 2026-10-18
const STATS = (over: Record<string, unknown> = {}) => ({
  role: 'organizer', status: 'live', generated_at: '2026-10-18T09:00:00Z',
  registered: 120, checked_in: 45, walk_ins: 6,
  by_source: { import: 114, kiosk: 4, walk_in: 2 }, qr: { sent: 100, not_sent: 15, no_email: 5 },
  by_ticket: [{ ticket_type: 'attendee', registered: 100, checked_in: 40 }, { ticket_type: 'VIP', registered: 20, checked_in: 5 }],
  arrivals: [{ t: T0, n: 10 }, { t: T0 + 900, n: 25 }, { t: T0 + 1800, n: 10 }],
  last_25_min: [...Array(10).fill(0), ...Array(15).fill(2)], ops: null, ...over,
});
const URL_ = '/cuedeck-checkin-dashboard.html?event=' + EVENT_ID;

async function open(page, role: string, statsOver: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}, url = URL_) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role, ...rowOver })]);
  await rpc(page, 'checkin_event_stats', STATS({ role, ...statsOver }));
  await page.goto(url);
}

test('organizer sees five tiles and five charts', async ({ page }) => {
  await open(page, 'organizer');
  await expect(page.locator('#full')).toBeVisible();
  await expect(page.locator('#t-reg')).toHaveText('120');
  await expect(page.locator('#t-in')).toHaveText('45');
  await expect(page.locator('#t-turn')).toHaveText('38% turnout');
  await expect(page.locator('#t-exp-l')).toHaveText('Still expected');
  await expect(page.locator('#t-exp')).toHaveText('75');
  await expect(page.locator('#t-walk')).toHaveText('6');
  await expect(page.locator('#t-peak')).toHaveText('25');
  await expect(page.locator('#t-peak-s')).toHaveText('10:15 to 10:30');
  await expect(page.locator('#rate')).toHaveText('Arriving now: 2 per minute over the last 15 minutes.');
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(5);
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#setup-link')).toBeVisible();
  await expect(page.locator('#desk-link')).toBeVisible();
});

test('test mode shows the amber banner', async ({ page }) => {
  await open(page, 'organizer', { status: 'test' }, { status: 'test' });
  await expect(page.locator('#banner')).toBeVisible();
});

test('after the window closes, still expected becomes no-shows', async ({ page }) => {
  await open(page, 'organizer', {}, { date: '2026-10-01' });
  await expect(page.locator('#t-exp-l')).toHaveText('No-shows');
  await expect(page.locator('#t-exp-s')).toHaveText('did not arrive');
});

test('below 10 check-ins the rate line waits', async ({ page }) => {
  await open(page, 'crew', { checked_in: 4 });
  await expect(page.locator('#rate')).toHaveText('Pace appears after the first 10 check-ins.');
  await expect(page.locator('#setup-link')).toBeHidden();
  await expect(page.locator('#desk-link')).toBeVisible();
});

test('an empty list reads No guests yet, never NaN', async ({ page }) => {
  await open(page, 'organizer', { registered: 0, checked_in: 0, walk_ins: 0, arrivals: [], by_ticket: [],
    by_source: { import: 0, kiosk: 0, walk_in: 0 }, qr: { sent: 0, not_sent: 0, no_email: 0 } });
  await expect(page.locator('#t-turn')).toHaveText('No guests yet');
  await expect(page.locator('#t-peak-s')).toHaveText('No arrivals yet');
  await expect(page.locator('body')).not.toContainText('NaN');
});

test('a viewer only ever gets the client view, numbers only', async ({ page }) => {
  await open(page, 'viewer');
  await expect(page.locator('#client')).toBeVisible();
  await expect(page.locator('#full')).toBeHidden();
  await expect(page.locator('#cl-name')).toHaveText('Probe Summit');
  await expect(page.locator('#cl-in')).toHaveText('45');
  await expect(page.locator('#cl-reg')).toHaveText('120');
  await expect(page.locator('#cl-turn')).toHaveText('38%');
  await expect(page.locator('#cl-foot')).toHaveText('Busiest 15 minutes: 25 arrived from 10:15. Arriving now: 2 per minute.');
  await expect(page.locator('a:visible')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).Chart.instances).length)).toBe(1);
});

test('anyone can open the client view with view=client', async ({ page }) => {
  await open(page, 'organizer', {}, {}, URL_ + '&view=client');
  await expect(page.locator('#client')).toBeVisible();
  await expect(page.locator('#full')).toBeHidden();
});

test('an event not in my list shows a plain error', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', []);
  await page.goto(URL_);
  await expect(page.locator('#page-err')).toHaveText('Could not open this dashboard: This event is not in your check-in events.');
});

test('refreshes every 30 seconds', async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: FIXED_NOW });
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow()]);
  await rpc(page, 'checkin_event_stats', () => { calls++; return STATS({ checked_in: 45 + calls }); });
  await page.goto(URL_);
  await expect(page.locator('#t-in')).toHaveText('46');
  await page.clock.runFor(30000);
  await expect(page.locator('#t-in')).toHaveText('47');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx playwright test tests/e2e/checkin-dashboard.spec.ts`
Expected: FAIL on every test (the page is a 404 on the static server).

- [ ] **Step 4: Write the page**

Create `cuedeck-checkin-dashboard.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check-in Dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js" integrity="sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>
<link rel="stylesheet" href="/checkin-app.css">
<style>
.crumb{font-weight:500;font-size:13px;color:var(--t2);border-left:1px solid var(--bd2);padding-left:10px;margin-left:2px}
.crumb a{color:var(--t2);text-decoration:none}.crumb b{color:var(--t1);font-weight:600}
.banner{margin:20px 28px 0;padding:12px 16px;border-radius:12px;background:var(--amsf);border:1px solid var(--ambd);color:var(--am);font-size:13px}
.banner b{color:#7A4700}
.dash{max-width:1240px;margin:0 auto;padding:20px 28px 40px}
.meta-line{font-size:13px;color:var(--t2);margin:0 0 14px}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-bottom:14px}
.tile{background:#fff;border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);min-width:0}
.tile span{display:block;font-size:11.5px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.05em}
.tile b{display:block;font-size:30px;letter-spacing:-1px;margin-top:6px}
.tile small{display:block;font-size:12.5px;color:var(--t2);margin-top:2px}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.chart{background:#fff;border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);min-width:0}
.chart.wide{grid-column:1 / -1}
.chart h2{margin:0 0 10px;font-size:15px;letter-spacing:-.2px}
.cv{position:relative;height:240px}
.cl{min-height:100vh;display:flex;flex-direction:column;padding:4vh 5vw;background:#fff}
.cl-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cl h1{margin:0;font-size:clamp(26px,3.6vw,52px);letter-spacing:-1px;overflow-wrap:anywhere}
.cl-test{font-size:clamp(14px,1.4vw,20px);font-weight:600;color:var(--am);background:var(--amsf);border:1px solid var(--ambd);border-radius:999px;padding:6px 14px;white-space:nowrap}
.big{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3vw;margin-top:4vh}
.big b{display:block;font-size:clamp(48px,9vw,140px);letter-spacing:-3px;line-height:1}
.big span{display:block;font-size:clamp(16px,1.8vw,26px);color:var(--t2);margin-top:1vh}
.cl .cv{flex:1;min-height:30vh;height:auto;margin-top:4vh}
.cl-foot{font-size:clamp(14px,1.5vw,22px);color:var(--t2);margin:2vh 0 0}
#page-err:empty,#err:empty,#cl-err:empty{display:none}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.charts{grid-template-columns:1fr}.dash{padding:16px}.banner{margin:16px 16px 0}.nav{padding:14px 16px}.crumb{display:none}}
</style>
</head>
<body>
<p class="small" id="page-loading" style="margin:40px auto;text-align:center">Loading the dashboard…</p>
<div class="err" id="page-err" style="margin:16px 28px"></div>

<div id="full" hidden>
  <nav class="nav">
    <div class="logo"><a class="mk" href="/checkin" style="display:grid"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M16 6a7 7 0 1 0 0 12"/></svg></a>CueDeck<span class="crumb"><a href="/checkin">Your events</a> / <b id="crumb-ev"></b></span></div>
    <div class="nav-r">
      <a class="btn btn-s" id="client-link" href="#">Client view</a>
      <a class="btn btn-s" id="setup-link" href="#" hidden>Setup</a>
      <a class="btn btn-s" id="desk-link" href="#" hidden>Desk</a>
    </div>
  </nav>
  <div class="banner" id="banner" hidden><b>Test mode.</b> These numbers include test check-ins and are cleared when the event goes live.</div>
  <main class="dash">
    <p class="meta-line" id="meta"></p>
    <div class="err" id="err"></div>
    <section class="tiles" aria-label="Totals">
      <div class="tile"><span>Registered</span><b id="t-reg"></b><small>on the guest list</small></div>
      <div class="tile"><span>Checked in</span><b id="t-in"></b><small id="t-turn"></small></div>
      <div class="tile"><span id="t-exp-l">Still expected</span><b id="t-exp"></b><small id="t-exp-s"></small></div>
      <div class="tile"><span>Walk-ins</span><b id="t-walk"></b><small>kiosk and desk</small></div>
      <div class="tile"><span>Peak arrivals</span><b id="t-peak"></b><small id="t-peak-s"></small></div>
    </section>
    <p class="meta-line" id="rate"></p>
    <section class="charts">
      <div class="chart wide"><h2>Arrivals over time</h2><div class="cv"><canvas id="c-arrivals" role="img" aria-label="Arrivals per 15 minutes and the running total"></canvas></div></div>
      <div class="chart"><h2>Registration status</h2><div class="cv"><canvas id="c-status" role="img" aria-label="Checked in against still expected"></canvas></div></div>
      <div class="chart"><h2>By ticket type</h2><div class="cv"><canvas id="c-ticket" role="img" aria-label="Registered and checked in per ticket type"></canvas></div></div>
      <div class="chart"><h2>How people registered</h2><div class="cv"><canvas id="c-source" role="img" aria-label="Imported, kiosk and walk-in registrations"></canvas></div></div>
      <div class="chart"><h2>QR email status</h2><div class="cv"><canvas id="c-qr" role="img" aria-label="QR emails sent, not sent and without an email address"></canvas></div></div>
    </section>
    <p class="meta-line" id="updated" style="margin-top:14px"></p>
  </main>
</div>

<div id="client" class="cl" hidden>
  <div class="cl-top"><h1 id="cl-name"></h1><span class="cl-test" id="cl-test" hidden>Test mode</span></div>
  <div class="err" id="cl-err"></div>
  <div class="big">
    <div><b id="cl-in"></b><span>checked in</span></div>
    <div><b id="cl-reg"></b><span>registered</span></div>
    <div><b id="cl-turn"></b><span>turnout</span></div>
  </div>
  <div class="cv"><canvas id="c-client" role="img" aria-label="Arrivals per 15 minutes and the running total"></canvas></div>
  <p class="cl-foot" id="cl-foot"></p>
  <p class="cl-foot" id="cl-upd"></p>
</div>

<script type="module">
import { isWindowClosed } from '/checkin-window.js';
import { effectiveRole, can } from '/checkin-roles.js';
import {
  tiles, arrivalSeries, statusDoughnut, ticketBars, sourceBars, qrBars,
  arrivalRate, fmtRate, clientView, fmtClock, BUCKET_S, PACE_MIN_CHECKINS,
} from '/checkin-dashboard.js';

const SUPABASE_URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const EVENT_ID = params.get('event');
const REFRESH_MS = 30000;
// The checkin-app.css tokens, for the canvas (Chart.js cannot read CSS variables).
const C = { ac: '#0071E3', gn: '#1D8348', am: '#9A5B00', bd2: '#D2D2D7' };
let EV = null, ROLE = null, CLIENT = false, busy = false;
const charts = {};

const fmtDate = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const BASE = { responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { boxWidth: 12, font: { size: 12 } } } } };

// One Chart per canvas for the life of the page; a refresh swaps the data.
function upsertChart(id, config) {
  const prev = charts[id];
  if (prev) {
    prev.data.labels = config.data.labels;
    prev.data.datasets.forEach((ds, i) => { ds.data = config.data.datasets[i].data; });
    prev.update('none');
    return;
  }
  charts[id] = new Chart($(id), config);
}

function arrivalsConfig(series) {
  return { type: 'bar', data: { labels: series.labels, datasets: [
    { type: 'bar', label: 'Arrived in these 15 minutes', data: series.bars, backgroundColor: C.ac, borderRadius: 4, yAxisID: 'y' },
    { type: 'line', label: 'Checked in so far', data: series.cumulative, borderColor: C.gn, backgroundColor: C.gn, pointRadius: 0, tension: 0.25, yAxisID: 'y2' },
  ] }, options: { ...BASE, scales: {
    y: { beginAtZero: true, ticks: { precision: 0 } },
    y2: { position: 'right', beginAtZero: true, ticks: { precision: 0 }, grid: { drawOnChartArea: false } },
  } } };
}
function statusConfig(d) {
  return { type: 'doughnut', data: { labels: d.labels, datasets: [{ data: d.data, backgroundColor: [C.gn, C.bd2], borderWidth: 0 }] },
           options: { ...BASE, cutout: '62%' } };
}
function ticketConfig(t) {
  return { type: 'bar', data: { labels: t.labels, datasets: [
    { label: 'Registered', data: t.registered, backgroundColor: C.bd2, borderRadius: 4 },
    { label: 'Checked in', data: t.checkedIn, backgroundColor: C.ac, borderRadius: 4 },
  ] }, options: { ...BASE, indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } } };
}
function barsConfig(b, colors) {
  return { type: 'bar', data: { labels: b.labels, datasets: [{ label: 'People', data: b.data, backgroundColor: colors, borderRadius: 4 }] },
           options: { ...BASE, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } };
}

async function loadEvent() {
  const { data, error } = await sb.rpc('checkin_my_events');
  if (error) throw new Error(error.message);
  EV = (data || []).find(r => r.event_id === EVENT_ID) || null;
  if (!EV || !EV.status) throw new Error('This event is not in your check-in events.');
  ROLE = effectiveRole(EV.role, EV.is_owner);
  if (!can(ROLE, 'dashboard')) throw new Error('You do not have access to this dashboard.');
  // A viewer only ever gets the client view (event-day spec, feature 3).
  CLIENT = ROLE === 'viewer' || params.get('view') === 'client';
}

function renderFull(s, closed) {
  const t = tiles(s, closed);
  $('banner').hidden = s.status !== 'test';
  $('t-reg').textContent = String(t.registered);
  $('t-in').textContent = String(t.checkedIn);
  $('t-turn').textContent = t.turnout === null ? 'No guests yet' : t.turnout + '% turnout';
  $('t-exp-l').textContent = t.expectedLabel;
  $('t-exp').textContent = String(t.expected);
  $('t-exp-s').textContent = closed ? 'did not arrive' : 'not here yet';
  $('t-walk').textContent = String(t.walkIns);
  $('t-peak').textContent = t.peak ? String(t.peak.n) : '0';
  $('t-peak-s').textContent = t.peak
    ? fmtClock(t.peak.t * 1000, EV.timezone) + ' to ' + fmtClock((t.peak.t + BUCKET_S) * 1000, EV.timezone)
    : 'No arrivals yet';
  const r = arrivalRate(s.last_25_min);
  $('rate').textContent = s.checked_in >= PACE_MIN_CHECKINS && r !== null
    ? 'Arriving now: ' + fmtRate(r) + ' per minute over the last 15 minutes.'
    : 'Pace appears after the first 10 check-ins.';
  upsertChart('c-arrivals', arrivalsConfig(arrivalSeries(s.arrivals, EV.timezone)));
  upsertChart('c-status', statusConfig(statusDoughnut(s, closed)));
  upsertChart('c-ticket', ticketConfig(ticketBars(s)));
  upsertChart('c-source', barsConfig(sourceBars(s), C.ac));
  upsertChart('c-qr', barsConfig(qrBars(s), [C.gn, C.am, C.bd2]));
}

function renderClient(s) {
  const v = clientView(s);
  $('cl-test').hidden = s.status !== 'test';
  $('cl-in').textContent = String(v.checkedIn);
  $('cl-reg').textContent = String(v.registered);
  $('cl-turn').textContent = (v.turnout ?? 0) + '%';
  const bits = [];
  if (v.peak) bits.push('Busiest 15 minutes: ' + v.peak.n + ' arrived from ' + fmtClock(v.peak.t * 1000, EV.timezone) + '.');
  bits.push(v.rate === null ? 'Pace appears after the first 10 check-ins.' : 'Arriving now: ' + fmtRate(v.rate) + ' per minute.');
  $('cl-foot').textContent = bits.join(' ');
  upsertChart('c-client', arrivalsConfig(arrivalSeries(s.arrivals, EV.timezone)));
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const errEl = CLIENT ? $('cl-err') : $('err');
    const { data, error } = await sb.rpc('checkin_event_stats', { p_event_id: EVENT_ID });
    if (error) { errEl.textContent = 'Could not refresh the numbers: ' + error.message; return; }
    errEl.textContent = '';
    const closed = isWindowClosed(EV.date, EV.timezone);
    if (CLIENT) renderClient(data); else renderFull(data, closed);
    $(CLIENT ? 'cl-upd' : 'updated').textContent = 'Updated ' + fmtClock(Date.now(), EV.timezone) + '. Refreshes every 30 seconds.';
  } finally {
    busy = false;
  }
}

(async () => {
  if (!EVENT_ID) { location.replace('/checkin'); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('/checkin'); return; }
  try { await loadEvent(); }
  catch (e) { $('page-loading').hidden = true; $('page-err').textContent = 'Could not open this dashboard: ' + e.message; return; }
  $('page-loading').hidden = true;
  const q = encodeURIComponent(EVENT_ID);
  if (CLIENT) {
    $('client').hidden = false;
    $('cl-name').textContent = EV.name;
    document.title = EV.name + ' arrivals';
  } else {
    $('full').hidden = false;
    $('crumb-ev').textContent = EV.name;
    $('meta').textContent = [fmtDate(EV.date), EV.venue, EV.timezone.replace(/_/g, ' ')].filter(Boolean).join(' · ');
    $('client-link').href = '/checkin/dashboard?event=' + q + '&view=client';
    $('setup-link').hidden = !(can(ROLE, 'test_setup') || can(ROLE, 'invite_crew'));
    $('setup-link').href = '/checkin/setup?event=' + q;
    $('desk-link').hidden = !can(ROLE, 'desk');
    $('desk-link').href = '/checkin/desk?event=' + q;
  }
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>
```

- [ ] **Step 5: Route and serve it**

In `vercel.json`, replace the last rewrite line

```json
    { "source": "/checkin/desk",  "destination": "/cuedeck-checkin.html" }
```

with:

```json
    { "source": "/checkin/desk",  "destination": "/cuedeck-checkin.html" },
    { "source": "/checkin/dashboard", "destination": "/cuedeck-checkin-dashboard.html" }
```

In `.vercelignore`, add after `!/cuedeck-checkin-setup.html`:

```
!/cuedeck-checkin-dashboard.html
```

In `scripts/verify-no-public-internals.sh`, change the last `MUST_200` line to:

```bash
  /checkin-roles.js /checkin-dashboard.js /checkin/dashboard
```

- [ ] **Step 6: Run the browser test and the JSON check**

Run: `npx playwright test tests/e2e/checkin-dashboard.spec.ts`
Expected: 9 passed.

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))" && npm test`
Expected: no output from the JSON check, then vitest PASS.

- [ ] **Step 7: Look at it**

Temporarily add, at the end of the first test, `await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });` and the same at `{ width: 390, height: 844 }` to `dashboard-phone.png`, run the test once with `--project chromium`, and read both images. Expected: tiles in one row on desktop and two columns on the phone, no horizontal scroll, charts legible, no dash characters in any copy. Remove the temporary lines before committing.

- [ ] **Step 8: Commit**

```bash
git add cuedeck-checkin-dashboard.html tests/e2e/checkin-mock.ts tests/e2e/checkin-dashboard.spec.ts vercel.json .vercelignore scripts/verify-no-public-internals.sh
git commit -m "feat(checkin): check-in dashboard page with five charts and a client view"
```

---

### Task 10: Desk health and pace panel on the dashboard

**Files:**
- Modify: `cuedeck-checkin-dashboard.html`
- Modify: `tests/e2e/checkin-dashboard.spec.ts`

**Interfaces:**
- Consumes: `deskRows`, `gapLines`, `paceMessages`, `eventStartUtc` (Task 8); `stats.ops` (Task 4); `can(ROLE, 'desk_health')` (Task 1).
- Produces: `#ops` panel (`#pace`, `#desk-body`, `#desk-empty`, `#gaps`, `#gaps-empty`), shown to owner, organizer and lead only.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/checkin-dashboard.spec.ts`:

```ts
const OPS = {
  desks: [
    { desk_id: 'a', label: 'Desk 1', operator: 'Ewa Sample', last_seen_at: '2026-10-18T08:59:40Z', seconds_since_seen: 20, pending_count: 0 },
    { desk_id: 'b', label: 'Desk 2', operator: 'Jan Probe', last_seen_at: '2026-10-18T08:55:00Z', seconds_since_seen: 300, pending_count: 3 },
  ],
  kiosks: [{ label: 'Lobby kiosk', last_seen_at: null, seconds_since_seen: null }],
  speeds: [{ desk_id: 'a', busiest_15: 90, active_minutes: 30, first_at: '2026-10-18T07:00:00Z', last_at: '2026-10-18T08:59:00Z' }],
  gaps: [{ desk_id: 'b', start_at: '2026-10-18T08:02:00Z', end_at: '2026-10-18T08:09:00Z', synced_ok: 23 }],
};

test('a desk lead sees desk health, offline gaps and staffing advice', async ({ page }) => {
  await open(page, 'lead', { ops: OPS, last_25_min: Array(25).fill(12) });
  await expect(page.locator('#ops')).toBeVisible();
  await expect(page.locator('#desk-body tr')).toHaveCount(3);
  await expect(page.locator('#desk-body tr').nth(0)).toHaveText('Desk 1Ewa SampleOnline');
  await expect(page.locator('#desk-body tr').nth(1)).toHaveText('Desk 2Jan ProbeOffline since 10:55');
  await expect(page.locator('#desk-body tr').nth(2)).toHaveText('Lobby kioskKioskNot connected yet');
  await expect(page.locator('#gaps li')).toHaveText(['Desk 2 offline 10:02 to 10:09, 23 check-ins synced late, 3 still on the device.']);
  await expect(page.locator('#pace .msg.warn')).toHaveText('Arrivals (12/min) are close to what your desk clears (6/min). Consider opening another desk.');
});

test('the desk panel waits for 10 check-ins', async ({ page }) => {
  await open(page, 'organizer', { ops: { ...OPS, gaps: [] }, checked_in: 5 });
  await expect(page.locator('#pace')).toHaveText('Pace appears after the first 10 check-ins.');
  await expect(page.locator('#gaps-empty')).toBeVisible();
});

test('desk staff never see the desk panel', async ({ page }) => {
  await open(page, 'crew', { ops: null });
  await expect(page.locator('#ops')).toBeHidden();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx playwright test tests/e2e/checkin-dashboard.spec.ts`
Expected: the first two new tests FAIL (`#ops` not found); the crew test passes trivially; the 9 earlier tests still pass.

- [ ] **Step 3: Add the panel styles**

In `cuedeck-checkin-dashboard.html`, replace the line

```css
#page-err:empty,#err:empty,#cl-err:empty{display:none}
```

with:

```css
#page-err:empty,#err:empty,#cl-err:empty{display:none}
.ops{background:#fff;border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);margin-bottom:14px}
.ops h2{margin:0 0 10px;font-size:15px;letter-spacing:-.2px}.ops h3{margin:18px 0 6px;font-size:13.5px}
.tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.tbl th{text-align:left;font-size:11.5px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid #F0F0F3}
.tbl td{padding:10px;border-bottom:1px solid #F5F5F7;overflow-wrap:anywhere}
.s-online{color:var(--gn);font-weight:600}.s-syncing{color:var(--am);font-weight:600}.s-offline{color:var(--rd);font-weight:600}
.msg{padding:10px 12px;border-radius:10px;font-size:13.5px;margin-bottom:8px;background:var(--acsf);color:var(--ac)}
.msg.warn{background:var(--amsf);color:var(--am)}
.gaps{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
```

- [ ] **Step 4: Add the panel markup**

Replace the line

```html
    <p class="meta-line" id="rate"></p>
```

with:

```html
    <p class="meta-line" id="rate"></p>
    <section class="ops" id="ops" hidden aria-label="Desks and pace">
      <h2>Desks and pace</h2>
      <div id="pace"></div>
      <table class="tbl"><thead><tr><th>Desk</th><th>Who</th><th>Status</th></tr></thead><tbody id="desk-body"></tbody></table>
      <p class="meta-line" id="desk-empty" hidden>No desk has reported in yet. A desk appears here once it opens this event.</p>
      <h3>Offline gaps</h3>
      <ul class="gaps" id="gaps"></ul>
      <p class="meta-line" id="gaps-empty" hidden>No desk has synced check-ins late.</p>
    </section>
```

- [ ] **Step 5: Add the panel code**

Replace

```js
  arrivalRate, fmtRate, clientView, fmtClock, BUCKET_S, PACE_MIN_CHECKINS,
} from '/checkin-dashboard.js';
```

with:

```js
  arrivalRate, fmtRate, clientView, fmtClock, BUCKET_S, PACE_MIN_CHECKINS,
  deskRows, gapLines, paceMessages, eventStartUtc,
} from '/checkin-dashboard.js';
```

Replace `const $ = (id) => document.getElementById(id);` with:

```js
const $ = (id) => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
```

Replace `let EV = null, ROLE = null, CLIENT = false, busy = false;` with:

```js
let EV = null, ROLE = null, CLIENT = false, busy = false, START_MS = null;
```

At the end of `loadEvent()`, replace

```js
  CLIENT = ROLE === 'viewer' || params.get('view') === 'client';
}
```

with:

```js
  CLIENT = ROLE === 'viewer' || params.get('view') === 'client';
  const start = eventStartUtc(EV.date, EV.event_start, EV.timezone);
  START_MS = start ? start.getTime() : null;
}

// Desk health and staffing (event-day spec, features 1 and 2): owner,
// organizer and lead only. The server sends ops only to those roles; the
// role test here keeps the panel hidden even if it ever did not.
function renderOps(s) {
  const show = can(ROLE, 'desk_health') && !!s.ops;
  $('ops').hidden = !show;
  if (!show) return;
  const pace = $('pace'); pace.replaceChildren();
  for (const m of paceMessages({ stats: s, nowMs: Date.now(), eventStartMs: START_MS })) {
    pace.appendChild(el('div', 'msg' + (m.tone === 'warn' ? ' warn' : ''), m.text));
  }
  const body = $('desk-body'); body.replaceChildren();
  const rows = deskRows(s.ops, EV.timezone);
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', null, r.label), el('td', null, r.who), el('td', 's-' + r.state.kind, r.state.text));
    body.appendChild(tr);
  }
  $('desk-empty').hidden = rows.length > 0;
  const list = $('gaps'); list.replaceChildren();
  const lines = gapLines(s.ops, EV.timezone);
  for (const line of lines) list.appendChild(el('li', null, line));
  $('gaps-empty').hidden = lines.length > 0;
}
```

At the end of `renderFull`, replace

```js
  upsertChart('c-qr', barsConfig(qrBars(s), [C.gn, C.am, C.bd2]));
}
```

with:

```js
  upsertChart('c-qr', barsConfig(qrBars(s), [C.gn, C.am, C.bd2]));
  renderOps(s);
}
```

- [ ] **Step 6: Run the browser tests**

Run: `npx playwright test tests/e2e/checkin-dashboard.spec.ts`
Expected: 12 passed.

- [ ] **Step 7: Commit**

```bash
git add cuedeck-checkin-dashboard.html tests/e2e/checkin-dashboard.spec.ts
git commit -m "feat(checkin): dashboard desk health, offline gaps and staffing advice"
```

---
### Task 11: Front page cards by role

**Files:**
- Modify: `cuedeck-checkin-home.html` (module script: import, `card()`)
- Modify: `checkin-app.css` (append `.role-l`)
- Create: `tests/e2e/checkin-home-roles.spec.ts`

**Interfaces:**
- Consumes: `effectiveRole`, `can`, `roleLabel` from `/checkin-roles.js` (Task 1); test helpers from `tests/e2e/checkin-mock.ts` (Task 9).
- Produces: each event card shows the role label (`.role-l`); viewer cards show counts and one `View dashboard` button; every set-up card gets a `Dashboard` button; desk lead cards get `Desk staff` (Setup, staff step).

- [ ] **Step 1: Write the failing browser test**

Create `tests/e2e/checkin-home-roles.spec.ts`:

```ts
// tests/e2e/checkin-home-roles.spec.ts
// Event cards on /checkin for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, FIXED_NOW } from './checkin-mock';

const ROWS = [
  myEventsRow({ event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Viewer event', role: 'viewer' }),
  myEventsRow({ event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Lead event', role: 'lead' }),
  myEventsRow({ event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Owned event', role: 'organizer', is_owner: true, status: 'test', test_used: 3 }),
  myEventsRow({ event_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Viewer test event', role: 'viewer', status: 'test', attendees: 30, arrived: 2 }),
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await table(page, 'leod_users', [{ role: 'checkin_staff', name: 'Probe Person' }]);
  await rpc(page, 'checkin_account_is_comp', false);
  await rpc(page, 'checkin_my_events', ROWS);
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-home.html');
});

const card = (page, name: string) => page.locator('.ev', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });

test('a viewer card shows counts and one dashboard button', async ({ page }) => {
  const c = card(page, 'Viewer event');
  await expect(c.locator('.role-l')).toHaveText('Viewer');
  await expect(c.locator('.stats')).toContainText('45');
  await expect(c.locator('.acts a')).toHaveText(['View dashboard']);
  await expect(c.locator('.acts a')).toHaveAttribute('href', '/checkin/dashboard?event=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('a viewer card in test mode still shows counts, never a desk button', async ({ page }) => {
  const c = card(page, 'Viewer test event');
  await expect(c.locator('.stats')).toContainText('30');
  await expect(c.locator('.acts a')).toHaveText(['View dashboard']);
});

test('a desk lead card opens the desk, desk staff and the dashboard', async ({ page }) => {
  const c = card(page, 'Lead event');
  await expect(c.locator('.role-l')).toHaveText('Desk lead');
  await expect(c.locator('.acts a')).toHaveText(['Open desk', 'Desk staff', 'Dashboard']);
});

test('the owner card says Owner and keeps setup', async ({ page }) => {
  const c = card(page, 'Owned event');
  await expect(c.locator('.role-l')).toHaveText('Owner');
  await expect(c.locator('.acts a')).toHaveText(['Continue setup', 'Try the desk', 'Dashboard']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/checkin-home-roles.spec.ts`
Expected: 4 FAIL (`.role-l` not found, no `View dashboard` link).

- [ ] **Step 3: Edit the page**

1. In `cuedeck-checkin-home.html`, replace (exactly once in the file):

```
import { checkinWindow, TEST_CAP } from '/checkin-window.js';
```

with:

```
import { checkinWindow, TEST_CAP } from '/checkin-window.js';
import { effectiveRole, can, roleLabel } from '/checkin-roles.js';
```

2. In `cuedeck-checkin-home.html`, replace (exactly once in the file):

```
  left.appendChild(el('div', 'meta', where));
```

with:

```
  left.appendChild(el('div', 'meta', where));
  const role = effectiveRole(r.role, r.is_owner);
  left.appendChild(el('div', 'role-l', roleLabel(role)));
```

3. In `cuedeck-checkin-home.html`, replace (exactly once in the file):

```
  const org = r.role === 'organizer';
  if (r.state === 'live' || r.state === 'ended') {
```

with:

```
  const org = can(role, 'test_setup');
  // A viewer's card shows the counts in every state (roles spec, Screens).
  if (r.state === 'live' || r.state === 'ended' || (role === 'viewer' && r.state === 'test')) {
```

4. In `cuedeck-checkin-home.html`, replace (exactly once in the file):

```
  const setup = '/checkin/setup?event=' + r.event_id, desk = '/checkin/desk?event=' + r.event_id;
  if (r.state === 'none' && org) {
```

with:

```
  const setup = '/checkin/setup?event=' + r.event_id, desk = '/checkin/desk?event=' + r.event_id;
  const dash = '/checkin/dashboard?event=' + r.event_id;
  // Viewers read numbers only: one button, to the dashboard.
  if (role === 'viewer') {
    if (r.state !== 'none') go('View dashboard', 'btn-p', dash);
    c.appendChild(acts);
    return c;
  }
  if (r.state === 'none' && org) {
```

5. In `cuedeck-checkin-home.html`, replace (exactly once in the file):

```
  } else if (r.state === 'ended' && org) {
    go('View attendance', 'btn-s', setup + '&step=attendees');
  }
  c.appendChild(acts);
```

with:

```
  } else if (r.state === 'ended' && org) {
    go('View attendance', 'btn-s', setup + '&step=attendees');
  }
  if (r.state !== 'none') {
    if (role === 'lead') go('Desk staff', 'btn-s', setup + '&step=staff');
    go('Dashboard', 'btn-s', dash);
  }
  c.appendChild(acts);
```

Then append to the end of `checkin-app.css`:

```
/* role label on an event card (cuedeck-checkin-home.html) */
.role-l{font-size:12px;font-weight:600;color:var(--t2);margin-top:4px}
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/e2e/checkin-home-roles.spec.ts`
Expected: 4 passed.

Run: `grep -n "r.role === 'organizer'" cuedeck-checkin-home.html`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin-home.html checkin-app.css tests/e2e/checkin-home-roles.spec.ts
git commit -m "feat(checkin): event cards show the role, viewer cards lead to the dashboard"
```

---

### Task 12: Setup by role (staff roles, owner tools, go-live rule, details for organizers)

**Files:**
- Modify: `cuedeck-checkin-setup.html`
- Create: `tests/e2e/checkin-setup-roles.spec.ts`

**Interfaces:**
- Consumes: `effectiveRole`, `can`, `invitableRoles`, `roleLabel`, `ROLE_HELP`, `transferNote` (Task 1); `checkin_update_event_details` (Task 2); `checkin-invite-staff` actions `list`, `transfer_owner`, `archive_event` and `is_comp` on list rows for the owner (Task 6).
- Produces: Setup for a desk lead shows only the Desk staff step (ruling 6); Desk staff step lists roles with descriptions and offers only the roles the caller may invite; the owner sees Transfer ownership and Delete event under Event details; non-owners see `Only the event owner, <name>, can go live.`; organizers edit event details; Export CSV only for owner and organizer; a Dashboard link in the nav.

- [ ] **Step 1: Write the failing browser test**

Create `tests/e2e/checkin-setup-roles.spec.ts`:

```ts
// tests/e2e/checkin-setup-roles.spec.ts
// /checkin/setup for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, FIXED_NOW } from './checkin-mock';

const STAFF = [
  { user_id: 'o0000000-0000-4000-8000-000000000001', role: 'organizer', name: 'Olga Owner', email: 'olga@cuedeck-test.io', is_owner: true },
  { user_id: 'o0000000-0000-4000-8000-000000000002', role: 'organizer', name: 'Oscar Org', email: 'oscar@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000003', role: 'lead', name: 'Lena Lead', email: 'lena@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000004', role: 'crew', name: 'Cris Crew', email: 'cris@cuedeck-test.io', is_owner: false },
  { user_id: 'o0000000-0000-4000-8000-000000000005', role: 'viewer', name: 'Vic Viewer', email: 'vic@cuedeck-test.io', is_owner: false },
];

async function open(page, row: Record<string, unknown>, step = '', staff = STAFF) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ status: 'test', ...row })]);
  await table(page, 'leod_checkin_entitlements', [{ event_id: EVENT_ID, checkin_core: true, status: 'test', self_registration: false, kiosk_self_print: false, auto_send_qr_email: false }]);
  await table(page, 'leod_checkin_attendees', []);
  await fn(page, 'checkin-invite-staff', () => ({ body: { ok: true, staff } }));
  await fn(page, 'checkin-price', () => ({ body: { amount: 24900, currency: 'eur' } }));
  await page.goto('/cuedeck-checkin-setup.html?event=' + EVENT_ID + (step ? '&step=' + step : ''));
}

test('a desk lead sees the Desk staff step only and invites desk staff only', async ({ page }) => {
  await open(page, { role: 'lead' }, 'golive');
  await expect(page.locator('#p-staff')).toBeVisible();
  await expect(page.locator('#p-golive')).toBeHidden();
  await expect(page.locator('.st:visible')).toHaveCount(1);
  await expect(page.locator('#inv-role option')).toHaveText(['Desk staff']);
  await expect(page.locator('#role-help li')).toHaveCount(1);
  await expect(page.locator('#staff-body button')).toHaveCount(1);
  await expect(page.locator('#staff-body tr', { hasText: 'Cris Crew' }).locator('button')).toHaveText('Remove');
  await expect(page.locator('#banner')).toBeHidden();
});

test('an organizer invites any role and sees role labels', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'staff');
  await expect(page.locator('#inv-role option')).toHaveText(['Organizer', 'Desk lead', 'Desk staff', 'Viewer']);
  await expect(page.locator('#inv-role')).toHaveValue('crew');
  await expect(page.locator('#staff-body tr').nth(0)).toContainText('Owner');
  await expect(page.locator('#staff-body tr').nth(2)).toContainText('Desk lead');
  await expect(page.locator('#staff-body button')).toHaveCount(4);
});

test('an organizer who is not the owner is told who can go live', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'golive');
  await expect(page.locator('#gl-owner-t')).toHaveText('Only the event owner, Olga Owner, can go live.');
  await expect(page.locator('#gl-pay')).toBeHidden();
});

test('an organizer edits details; the owner tools stay hidden', async ({ page }) => {
  await open(page, { role: 'organizer' }, 'details');
  await expect(page.locator('#d-name')).toBeEnabled();
  await expect(page.locator('#owner-tools')).toBeHidden();
});

test('the owner gets transfer and delete, and the transfer warns about complimentary status', async ({ page }) => {
  const staff = STAFF.map(s => ({ ...s, is_comp: s.name === 'Oscar Org' }));
  await open(page, { role: 'organizer', is_owner: true }, 'details', staff);
  await expect(page.locator('#owner-tools')).toBeVisible();
  await expect(page.locator('#ot-target option')).toHaveText(['Oscar Org']);
  let message = '';
  page.once('dialog', d => { message = d.message(); d.dismiss(); });
  await page.locator('#ot-transfer').click();
  await expect.poll(() => message).toBe('Make Oscar Org the owner of Probe Summit? You will stay on as an organizer. This event will become complimentary, because their account is.');
  await expect(page.locator('#ot-del-row')).toBeVisible();
});

test('desk staff are sent to the desk', async ({ page }) => {
  await open(page, { role: 'crew' });
  await page.waitForURL(/\/checkin\/desk\?event=/);
});

test('viewers are sent to the dashboard', async ({ page }) => {
  await open(page, { role: 'viewer' });
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/checkin-setup-roles.spec.ts`
Expected: FAIL on the lead, organizer, owner and viewer tests (today a lead and a viewer are both sent to the desk, and the role list is fixed).

- [ ] **Step 3: Edit the page**

1. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
import { parseCsv, mapRows, toCsv } from '/checkin-csv.js';
```

with:

```
import { parseCsv, mapRows, toCsv } from '/checkin-csv.js';
import { effectiveRole, can, invitableRoles, roleLabel, ROLE_HELP, transferNote } from '/checkin-roles.js';
```

2. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
let EV = null, ENT = null, ATT = [], STAFF = [], PRICE = null, FILTER = 'all', PENDING_IMPORT = null;
```

with:

```
let EV = null, ENT = null, ATT = [], STAFF = [], PRICE = null, FILTER = 'all', PENDING_IMPORT = null, ROLE = null;
```

3. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  if (EV.role !== 'organizer') { location.replace('/checkin/desk?event=' + EVENT_ID); return false; }
```

with:

```
  ROLE = effectiveRole(EV.role, EV.is_owner);
  // Setup is for the office roles. A desk lead gets the Desk staff step
  // only (roles ruling 6); desk staff go to the desk, viewers to the dashboard.
  if (!can(ROLE, 'test_setup') && !can(ROLE, 'invite_crew')) {
    location.replace((can(ROLE, 'desk') ? '/checkin/desk?event=' : '/checkin/dashboard?event=') + EVENT_ID);
    return false;
  }
```

4. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  <div class="nav-r"><a class="btn btn-s" id="desk-link" href="#">Try the desk</a></div>
```

with:

```
  <div class="nav-r"><a class="btn btn-s" id="dash-link" href="#">Dashboard</a><a class="btn btn-s" id="desk-link" href="#">Try the desk</a></div>
```

5. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  $('desk-link').href = '/checkin/desk?event=' + EVENT_ID;
```

with:

```
  $('desk-link').href = '/checkin/desk?event=' + EVENT_ID;
  $('dash-link').href = '/checkin/dashboard?event=' + EVENT_ID;
```

6. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  $('banner').hidden = isLive() || isComp();
```

with:

```
  const office = can(ROLE, 'test_setup');
  $('banner').hidden = isLive() || isComp() || !office;
  // A desk lead sees the Desk staff step only (ruling 6).
  document.querySelectorAll('.st').forEach(b => { b.hidden = !office && b.dataset.step !== 'staff'; });
```

7. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
function go(step) {
```

with:

```
function go(step) {
  if (!can(ROLE, 'test_setup')) step = 'staff';
```

8. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
#page-err:empty{display:none}
```

with:

```
#page-err:empty{display:none}
.roles{margin:0 0 16px;padding:0;list-style:none;display:grid;gap:6px;font-size:13px;color:var(--t2)}.roles b{color:var(--t1);font-weight:600}
```

9. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
    <div class="ph"><div><h2>Desk staff</h2><p>Desk staff can check people in and print badges. Co-organizers can also change setup.</p></div></div>
```

with:

```
    <div class="ph"><div><h2>Desk staff</h2><p>Everyone who works on this event, and what each role can do.</p></div></div>
    <ul class="roles" id="role-help"></ul>
```

10. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
<select id="inv-role"><option value="crew">Desk staff</option><option value="organizer">Co-organizer</option></select>
```

with:

```
<select id="inv-role"></select>
```

11. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
function renderStaff() {
  const body = $('staff-body'); body.replaceChildren();
  for (const s of STAFF) {
    const tr = el('tr');
    const p = el('td'); p.append(el('div', 'nm', s.name || s.email || 'Invited user')); if (s.name && s.email) p.appendChild(el('div', 'em', s.email));
    const r = el('td', null, s.is_owner ? 'Owner' : s.role === 'organizer' ? 'Co-organizer' : 'Desk staff');
    const x = el('td');
    if (!s.is_owner) { const b = el('button', 'link', 'Remove'); b.onclick = () => removeStaff(s); x.appendChild(b); }
    tr.append(p, r, x); body.appendChild(tr);
  }
}
```

with:

```
function renderStaff() {
  const roles = invitableRoles(ROLE);
  const help = $('role-help'); help.replaceChildren();
  for (const r of roles) { const li = el('li'); li.append(el('b', null, roleLabel(r) + '. '), document.createTextNode(ROLE_HELP[r])); help.appendChild(li); }
  const sel = $('inv-role'); const keep = sel.value; sel.replaceChildren();
  for (const r of roles) { const o = el('option', null, roleLabel(r)); o.value = r; sel.appendChild(o); }
  sel.value = roles.includes(keep) ? keep : roles.includes('crew') ? 'crew' : roles[0];
  const body = $('staff-body'); body.replaceChildren();
  for (const s of STAFF) {
    const tr = el('tr');
    const p = el('td'); p.append(el('div', 'nm', s.name || s.email || 'Invited user')); if (s.name && s.email) p.appendChild(el('div', 'em', s.email));
    const r = el('td', null, roleLabel(s.is_owner ? 'owner' : s.role));
    const x = el('td');
    // The server's rule (removeVerdict): never the owner; a desk lead removes desk staff only.
    const mayRemove = !s.is_owner && (can(ROLE, 'invite_any') || (can(ROLE, 'invite_crew') && s.role === 'crew'));
    if (mayRemove) { const b = el('button', 'link', 'Remove'); b.onclick = () => removeStaff(s); x.appendChild(b); }
    tr.append(p, r, x); body.appendChild(tr);
  }
}
```

12. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  const owner = EV.is_owner;
  for (const id of ['d-name', 'd-date', 'd-tz', 'd-start', 'd-end', 'd-venue', 'd-save']) $(id).disabled = !owner;
  const dateLocked = isLive() && !isComp();
  if (dateLocked) { $('d-date').disabled = true; $('d-tz').disabled = true; }
  $('det-note').textContent = !owner ? 'Only the event owner can change these details.'
```

with:

```
  const editable = can(ROLE, 'edit_details');
  for (const id of ['d-name', 'd-date', 'd-tz', 'd-start', 'd-end', 'd-venue', 'd-save']) $(id).disabled = !editable;
  const dateLocked = isLive() && !isComp();
  if (dateLocked) { $('d-date').disabled = true; $('d-tz').disabled = true; }
  renderOwnerTools();
  $('det-note').textContent = !editable ? 'Only the event owner or an organizer can change these details.'
```

13. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  const patch = { name: $('d-name').value.trim(), venue: $('d-venue').value.trim() || null,
                  event_start: $('d-start').value, event_end: $('d-end').value };
  // Migration 069 locks timezone with the date on a live, paid event.
  if (!isLive() || isComp()) { patch.date = $('d-date').value; patch.timezone = $('d-tz').value; }
  const { error } = await sb.from('leod_events').update(patch).eq('id', EVENT_ID);
```

with:

```
  // Organizers save through checkin_update_event_details (migration 070),
  // because leod_events UPDATE is owner-only by RLS. Migration 069 locks
  // the date and timezone of a live, paid event, so those go as null (kept).
  const lockDate = isLive() && !isComp();
  const { error } = await sb.rpc('checkin_update_event_details', {
    p_event_id: EVENT_ID, p_name: $('d-name').value.trim(), p_venue: $('d-venue').value.trim() || null,
    p_date: lockDate ? null : $('d-date').value, p_timezone: lockDate ? null : $('d-tz').value,
    p_event_start: $('d-start').value, p_event_end: $('d-end').value,
  });
```

14. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
      <div class="err" id="d-err"></div>
    </form>
  </section>
```

with:

```
      <div class="err" id="d-err"></div>
    </form>
    <div id="owner-tools" hidden style="margin-top:18px">
      <div class="toggle"><div><b>Transfer ownership</b><p>Hand this event to another organizer. You stay on as an organizer, and only the new owner can go live, transfer or delete it.</p></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="ot-target" class="search" style="flex:none;min-width:200px" aria-label="New owner"></select><button class="btn btn-s" id="ot-transfer" type="button">Transfer</button></div></div>
      <div class="toggle" id="ot-del-row"><div><b>Delete event</b><p>Removes this event from your events. Possible only while it is in test mode.</p></div><button class="btn btn-s" id="ot-delete" type="button" style="color:var(--rd)">Delete event</button></div>
      <div class="err" id="ot-err"></div>
    </div>
  </section>
```

15. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
// ── 2. attendees ─────────────────────────────────────────
```

with:

```
// ── owner tools (rulings 2 and 3) ────────────────────────
function ownerName() {
  const o = STAFF.find(s => s.is_owner);
  return (o && (o.name || o.email)) || 'the event owner';
}
function renderOwnerTools() {
  const show = can(ROLE, 'transfer_owner') && EV.created_via === 'checkin';
  $('owner-tools').hidden = !show;
  if (!show) return;
  $('ot-err').textContent = '';
  const sel = $('ot-target'); sel.replaceChildren();
  const orgs = STAFF.filter(s => !s.is_owner && s.role === 'organizer');
  if (!orgs.length) sel.appendChild(el('option', null, 'Invite an organizer first'));
  for (const s of orgs) { const o = el('option', null, s.name || s.email || 'Invited user'); o.value = s.user_id; sel.appendChild(o); }
  sel.disabled = !orgs.length; $('ot-transfer').disabled = !orgs.length;
  $('ot-del-row').hidden = isLive();
}
$('ot-transfer').onclick = async () => {
  $('ot-err').textContent = '';
  const t = STAFF.find(s => s.user_id === $('ot-target').value);
  if (!t) return;
  const who = t.name || t.email || 'this organizer';
  if (!confirm('Make ' + who + ' the owner of ' + EV.name + '? You will stay on as an organizer.' + transferNote(EV.is_comp, t.is_comp, isLive()))) return;
  $('ot-transfer').disabled = true;
  const { error } = await sb.functions.invoke('checkin-invite-staff', { body: { event_id: EVENT_ID, action: 'transfer_owner', user_id: t.user_id } });
  $('ot-transfer').disabled = false;
  if (error) { $('ot-err').textContent = await fnError(error); return; }
  location.reload();
};
$('ot-delete').onclick = async () => {
  $('ot-err').textContent = '';
  if (!confirm('Delete ' + EV.name + '? It will disappear from your events. Email support@cuedeck.io if you need it back.')) return;
  $('ot-delete').disabled = true;
  const { error } = await sb.functions.invoke('checkin-invite-staff', { body: { event_id: EVENT_ID, action: 'archive_event' } });
  $('ot-delete').disabled = false;
  if (error) { $('ot-err').textContent = await fnError(error); return; }
  location.href = '/checkin';
};

// ── 2. attendees ─────────────────────────────────────────
```

16. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
      <div class="panel center" id="gl-wait" hidden>
```

with:

```
      <div class="panel center" id="gl-owner" hidden><h3 style="margin:8px 0">Owner only</h3><p class="fine center" id="gl-owner-t"></p></div>
      <div class="panel center" id="gl-wait" hidden>
```

17. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
  $('gl-btn').disabled = closed;
  $('gl-err').textContent = closed ? 'Check-in for this event has already closed. Change the event date before going live.' : '';
}
```

with:

```
  $('gl-btn').disabled = closed;
  $('gl-err').textContent = closed ? 'Check-in for this event has already closed. Change the event date before going live.' : '';
  // Going live is the owner's alone, paid or complimentary (ruling 1).
  const mayGoLive = can(ROLE, 'go_live');
  if (!mayGoLive) { $('gl-pay').hidden = true; $('gl-comp-btn').hidden = true; }
  $('gl-owner').hidden = mayGoLive || isLive();
  $('gl-owner-t').textContent = 'Only the event owner, ' + ownerName() + ', can go live.';
}
```

18. In `cuedeck-checkin-setup.html`, replace (exactly once in the file):

```
function renderAttendees() {
```

with:

```
function renderAttendees() {
  $('att-export').hidden = !can(ROLE, 'export');
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/e2e/checkin-setup-roles.spec.ts tests/e2e/checkin-home-roles.spec.ts tests/e2e/checkin-dashboard.spec.ts`
Expected: all passed (7 + 4 + 12).

Run: `grep -n "EV.role !== 'organizer'\|Co-organizer\|from('leod_events').update" cuedeck-checkin-setup.html`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin-setup.html tests/e2e/checkin-setup-roles.spec.ts
git commit -m "feat(checkin): Setup by role, owner tools, go-live owner rule, organizer details"
```

---

### Task 13: Desk by role, undo-own and walk-ins

**Files:**
- Modify: `cuedeck-checkin.html`
- Create: `tests/e2e/checkin-desk-roles.spec.ts`

**Interfaces:**
- Consumes: `effectiveRole`, `can`, `mayUndo`, `ownCheckins`, `roleLabel` (Task 1); `checkin-add-walk-in` (Task 7); `forbidden` scan result (Task 3); helpers from `tests/e2e/checkin-mock.ts`.
- Produces: `window.CK_ROLES`; `S.own` (Map of this user's own check-ins on this desk); outbox items carry `operator_id`; Add walk-in (`#st-walkin`, modal `#walkin`) for leads and above; Set up a kiosk for leads and above; Undo shown only where `mayUndo` allows; `forbidden` results explained (`Ask a desk lead to undo this check-in.`); viewers are sent to the dashboard; `#st-dash` link. Functions Task 14 relies on: `showScreen`, `openEvent`, `flushOutbox`, the header button `#st-walkin`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/e2e/checkin-desk-roles.spec.ts`:

```ts
// tests/e2e/checkin-desk-roles.spec.ts
// The check-in desk for each role, Supabase mocked.
import { test, expect } from '@playwright/test';
import { signedIn, rpc, table, fn, myEventsRow, EVENT_ID, USER_ID, FIXED_NOW } from './checkin-mock';

const ANA = { id: 'a0000000-0000-4000-8000-000000000001', event_id: EVENT_ID, first_name: 'Ana', last_name: 'Probe', email: 'ana@cuedeck-test.io',
  company: 'Contoso Demo', ticket_type: 'attendee', qr_token: 'tok-ana', checked_in_at: '2026-10-18T08:30:00.000Z', badge_printed_at: null };
const BEN = { ...ANA, id: 'a0000000-0000-4000-8000-000000000002', first_name: 'Ben', email: 'ben@cuedeck-test.io', company: 'Fabrikam Demo', qr_token: 'tok-ben', checked_in_at: null };

type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[] };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN] }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role })]);
  await table(page, 'leod_checkin_entitlements', [{ checkin_core: true, status: 'live' }]);
  await table(page, 'leod_checkin_attendees', roster);
  await fn(page, 'checkin-record-scans', (b) => ({ body: {
    ok: true, errors: [],
    results: Object.fromEntries((b.items as { client_id: string; action: string }[]).map(i => [i.client_id, scanResult(i)])),
  } }));
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await expect(page.locator('#station')).toBeVisible();
}

async function search(page, text: string) {
  await page.locator('#scan').fill(text);
}

test('desk staff see no kiosk or walk-in button and cannot undo a colleague', async ({ page }) => {
  await open(page, { role: 'crew' });
  await expect(page.locator('#st-walkin')).toBeHidden();
  await expect(page.locator('#st-kiosk')).toBeHidden();
  await search(page, 'Ana');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' })).toBeVisible();
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveCount(0);
});

test('desk staff can undo their own check-in', async ({ page }) => {
  await open(page, { role: 'crew' });
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await expect(page.locator('#verdict .ck-undo')).toHaveText('Undo check-in');
});

test('a desk lead adds walk-ins, pairs kiosks and undoes anyone', async ({ page }) => {
  await open(page, { role: 'lead' });
  await expect(page.locator('#st-walkin')).toBeVisible();
  await expect(page.locator('#st-kiosk')).toBeVisible();
  await expect(page.locator('#st-dash')).toHaveAttribute('href', '/checkin/dashboard?event=' + EVENT_ID);
  await search(page, 'Ana');
  await expect(page.locator('.ck-res-row', { hasText: 'Ana Probe' }).locator('.ck-undo')).toHaveText('Undo check-in');
});

test('a walk-in is added and opened at the desk', async ({ page }) => {
  let sent: Record<string, unknown> = {};
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', (b) => { sent = b; return { body: { ok: true, attendee: {
    id: 'a0000000-0000-4000-8000-000000000009', event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', email: null,
    company: 'Northwind Demo', ticket_type: 'attendee', qr_token: 'tok-walt', checked_in_at: null, badge_printed_at: null } } }; });
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Walt');
  await page.locator('#wi-last').fill('Walkin');
  await page.locator('#wi-company').fill('Northwind Demo');
  await page.locator('#wi-save').click();
  await expect(page.locator('#walkin')).toBeHidden();
  await expect(page.locator('#party')).toContainText('Walt Walkin');
  expect(sent).toMatchObject({ event_id: EVENT_ID, first_name: 'Walt', last_name: 'Walkin', company: 'Northwind Demo' });
});

test('a walk-in refused by the server shows its reason in the form', async ({ page }) => {
  await open(page, { role: 'lead' });
  await fn(page, 'checkin-add-walk-in', () => ({ status: 409, body: { error: 'Someone with this email is already on the list. Search for them instead.', code: 'already_registered' } }));
  await page.locator('#st-walkin').click();
  await page.locator('#wi-first').fill('Ana');
  await page.locator('#wi-last').fill('Probe');
  await page.locator('#wi-save').click();
  await expect(page.locator('#wi-err')).toHaveText('Someone with this email is already on the list. Search for them instead.');
});

test('an undo the server refuses as forbidden says who can do it', async ({ page }) => {
  // The server records the check-in, so the roster the desk re-reads after
  // the sync shows Ben checked in at the desk's own time; then it refuses the undo.
  const roster = [ANA, { ...BEN }];
  await open(page, { role: 'crew', roster, scanResult: (i) => {
    if (i.action === 'checkin') { roster[1].checked_in_at = FIXED_NOW.toISOString(); return 'ok'; }
    return 'forbidden';
  } });
  const synced = page.waitForResponse(r => r.url().includes('/functions/v1/checkin-record-scans'));
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await synced;
  await page.locator('#verdict .ck-undo').click();
  await expect(page.locator('#verdict')).toContainText('Ask a desk lead to undo this check-in.');
});

test('a viewer sent to the desk lands on the dashboard', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'viewer' })]);
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
});

test('outbox items carry the operator id', async ({ page }) => {
  await open(page, { role: 'crew' });
  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  await req;
  const items = await page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open('cuedeck-checkin', 1);
    open.onsuccess = () => { const q = open.result.transaction('outbox').objectStore('outbox').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); };
    open.onerror = () => reject(open.error);
  }));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ action: 'checkin', operator_id: USER_ID });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/checkin-desk-roles.spec.ts`
Expected: FAIL on every test except possibly the first (`#st-walkin` does not exist; viewers stay on the desk; items have no `operator_id`).

- [ ] **Step 3: Edit the page**

The desk is a classic script; the role table reaches it through `window.CK_ROLES`, set by the module script at the bottom of the page (module scripts run before `DOMContentLoaded`, which is when the desk boots).

1. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
<script type="module">
  import { checkinWindow, isWithinWindow, TEST_CAP } from '/checkin-window.js';
  window.CK_POLICY = { checkinWindow, isWithinWindow, TEST_CAP };
</script>
```

with:

```
<script type="module">
  import { checkinWindow, isWithinWindow, TEST_CAP } from '/checkin-window.js';
  import { effectiveRole, can, mayUndo, ownCheckins, roleLabel } from '/checkin-roles.js';
  window.CK_POLICY = { checkinWindow, isWithinWindow, TEST_CAP };
  // The five-role table for the classic script below (tests/checkin-roles.spec.ts).
  window.CK_ROLES = { effectiveRole, can, mayUndo, ownCheckins, roleLabel };
</script>
```

2. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
var S = { user: null, event: null, role: null, roster: [], party: null, scanPointId: null, editing: null };
```

with:

```
var S = { user: null, event: null, role: null, roster: [], party: null, scanPointId: null, editing: null, own: new Map() };
```

3. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
</style>
```

with:

```
.wi-form .ck-input{margin-bottom:12px}
.wi-err{color:var(--rd);font-size:13px;min-height:18px;margin:0 0 10px}
a.ck-quiet{text-decoration:none}a.ck-quiet:hover{text-decoration:underline}
</style>
```

4. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      <!-- Organizer only, and hidden until renderStation() says otherwise.
```

with:

```
      <!-- Organizer or desk lead, hidden until renderStation() says otherwise.
```

5. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      <button class="ck-quiet" type="button" id="st-kiosk" style="display:none">Set up a kiosk</button>
      <button class="ck-quiet" type="button" id="st-switch">Switch event</button>
```

with:

```
      <button class="ck-quiet" type="button" id="st-walkin" style="display:none">Add walk-in</button>
      <button class="ck-quiet" type="button" id="st-kiosk" style="display:none">Set up a kiosk</button>
      <a class="ck-quiet" id="st-dash" href="#">Dashboard</a>
      <button class="ck-quiet" type="button" id="st-switch">Switch event</button>
```

6. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
<!-- ── LOADING ─────────────────────────────────── -->
```

with:

```
<!-- ── WALK-IN ─────────────────────────────────────
     Organizer or desk lead (roles ruling 7). Same modal frame as the
     kiosk setup above; the desk's keyboard machinery stands down while
     it is open (stationVisible).                                   -->
<div id="walkin" class="ck-modal" style="display:none">
  <div class="ck-modal-card" role="dialog" aria-modal="true" aria-labelledby="wi-title">
    <div class="ks-top">
      <div class="ks-top-main">
        <div class="ks-eyebrow">Walk-in</div>
        <div class="ks-h" id="wi-title">Add a walk-in</div>
      </div>
      <button class="ks-x" type="button" id="wi-close" aria-label="Close">&times;</button>
    </div>
    <form id="wi-form" class="wi-form" novalidate>
      <label class="ck-lbl" for="wi-first">First name</label><input class="ck-input" id="wi-first" maxlength="120" autocomplete="off">
      <label class="ck-lbl" for="wi-last">Last name</label><input class="ck-input" id="wi-last" maxlength="120" autocomplete="off">
      <label class="ck-lbl" for="wi-email">Email (optional)</label><input class="ck-input" id="wi-email" type="email" maxlength="254" autocomplete="off">
      <label class="ck-lbl" for="wi-company">Company (optional)</label><input class="ck-input" id="wi-company" maxlength="200" autocomplete="off">
      <label class="ck-lbl" for="wi-tt">Ticket type</label><input class="ck-input" id="wi-tt" maxlength="60" list="wi-tt-list" placeholder="attendee" autocomplete="off"><datalist id="wi-tt-list"></datalist>
      <div class="wi-err" id="wi-err" role="alert"></div>
      <button class="ck-btn" type="submit" id="wi-save">Add to the list</button>
    </form>
  </div>
</div>

<!-- ── LOADING ─────────────────────────────────── -->
```

7. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (document.getElementById('kiosk-setup').style.display !== 'none') return false;
```

with:

```
  if (document.getElementById('kiosk-setup').style.display !== 'none') return false;
  if (document.getElementById('walkin').style.display !== 'none') return false;
```

8. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  document.getElementById('st-kiosk').addEventListener('click', openKioskSetup);
```

with:

```
  document.getElementById('st-kiosk').addEventListener('click', openKioskSetup);
  document.getElementById('st-walkin').addEventListener('click', openWalkIn);
  document.getElementById('wi-close').addEventListener('click', closeWalkIn);
  document.getElementById('wi-form').addEventListener('submit', submitWalkIn);
  document.getElementById('walkin').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWalkIn(); });
```

9. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    if (e.key === 'Escape') closeKioskSetup();
```

with:

```
    if (e.key === 'Escape') { closeKioskSetup(); closeWalkIn(); }
```

10. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  else { stopFocusBackstop(); stopRosterRefresh(); closeKioskSetup(); }
```

with:

```
  else { stopFocusBackstop(); stopRosterRefresh(); closeKioskSetup(); closeWalkIn(); }
```

11. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  S.user = null; S.event = null; S.role = null; S.roster = []; S.party = null;
```

with:

```
  S.user = null; S.event = null; S.role = null; S.roster = []; S.party = null; S.own = new Map();
```

12. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  // Only events with check-in set up; "Not set up" events belong to the
  // front page, where the organizer can set them up.
  const rows = (mine || []).filter(r => r.status);
```

with:

```
  // Only events with check-in set up; "Not set up" events belong to the
  // front page, where the organizer can set them up. Viewers never work a
  // desk: a viewer sent here for an event lands on its dashboard instead.
  const R = window.CK_ROLES;
  const wantedNow = new URLSearchParams(location.search).get('event');
  const asViewer = (mine || []).find(r => r.event_id === wantedNow && r.status && R.effectiveRole(r.role, r.is_owner) === 'viewer');
  if (asViewer) { location.replace('/checkin/dashboard?event=' + encodeURIComponent(asViewer.event_id)); return; }
  const rows = (mine || []).filter(r => r.status && R.can(R.effectiveRole(r.role, r.is_owner), 'desk'));
```

13. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    pill.textContent = r.role;
```

with:

```
    pill.textContent = R.roleLabel(R.effectiveRole(r.role, r.is_owner));
```

14. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  S.role  = role;
```

with:

```
  S.role  = window.CK_ROLES.effectiveRole(role, !!(ev && ev.is_owner));
```

15. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  await pruneOutbox();
  await loadRoster(eventId);
```

with:

```
  await pruneOutbox();
  // Check-ins this person made on this desk: desk staff may undo only these.
  S.own = window.CK_ROLES.ownCheckins(await idbGetAll(STORE_OUTBOX), S.user && S.user.id, eventId);
  await loadRoster(eventId);
```

16. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  document.getElementById('st-kiosk').style.display = S.role === 'organizer' ? '' : 'none';
```

with:

```
  const R = window.CK_ROLES;
  document.getElementById('st-kiosk').style.display = R.can(S.role, 'kiosk') ? '' : 'none';
  document.getElementById('st-walkin').style.display = R.can(S.role, 'walk_in') ? '' : 'none';
  document.getElementById('st-dash').href = '/checkin/dashboard?event=' + encodeURIComponent(S.event.id);
```

17. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (S.role === 'organizer') {
    const a = document.createElement('a');
```

with:

```
  if (window.CK_ROLES.can(S.role, 'test_setup')) {
    const a = document.createElement('a');
```

18. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (S.role !== 'organizer') return;
  ksAsk('', '');
```

with:

```
  if (!window.CK_ROLES.can(S.role, 'kiosk')) return;
  ksAsk('', '');
```

19. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (S.role !== 'organizer' || !S.event) return;
```

with:

```
  if (!window.CK_ROLES.can(S.role, 'kiosk') || !S.event) return;
```

20. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    return 'Only an organizer can set up a kiosk. Ask whoever owns this event to create the code, or to make you an organizer on it.';
```

with:

```
    return 'Only an organizer or a desk lead can set up a kiosk. Ask the event owner to change your role.';
```

21. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      prev_checked_in_at: null,
      synced: false,
    };
    await idbPutAll(STORE_OUTBOX, [item]);
    a.checked_in_at = now;
```

with:

```
      prev_checked_in_at: null,
      // Who made it, so this desk knows which check-ins desk staff may
      // undo (roles ruling 8). The server checks it again.
      operator_id: S.user ? S.user.id : null,
      synced: false,
    };
    await idbPutAll(STORE_OUTBOX, [item]);
    a.checked_in_at = now;
    S.own.set(a.id, now);
```

22. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    action: 'undo',
    prev_checked_in_at: prev,
    synced: false,
```

with:

```
    action: 'undo',
    prev_checked_in_at: prev,
    operator_id: S.user ? S.user.id : null,
    synced: false,
```

23. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  people.forEach(p => box.appendChild(undoButton(p,
    people.length === 1 ? 'Undo check-in' : 'Undo check-in · ' + fullName(p))));
```

with:

```
  people.forEach(p => { if (mayUndoHere(p)) box.appendChild(undoButton(p,
    people.length === 1 ? 'Undo check-in' : 'Undo check-in · ' + fullName(p))); });
```

24. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    if (a.checked_in_at) row.appendChild(undoButton(a, 'Undo check-in'));
```

with:

```
    if (mayUndoHere(a)) row.appendChild(undoButton(a, 'Undo check-in'));
```

25. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (attendee.checked_in_at) row.appendChild(undoButton(attendee, 'Undo check-in'));
```

with:

```
  if (mayUndoHere(attendee)) row.appendChild(undoButton(attendee, 'Undo check-in'));
```

26. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
function undoButton(attendee, label) {
```

with:

```
// Ruling 8 on screen: leads and above undo anyone; desk staff only what
// they checked in themselves on this desk. checkin_apply_scan enforces it.
function mayUndoHere(a) { return window.CK_ROLES.mayUndo(S.role, a, S.own); }

function undoButton(attendee, label) {
```

27. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    const refusedPaywall = [];
```

with:

```
    const refusedPaywall = [];
    // Desk staff undoing a check-in someone else made (roles ruling 8).
    const refusedForbidden = [];
```

28. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      settled.forEach(p => { if (p.result === 'test_cap' || p.result === 'outside_window') refusedPaywall.push(p); });
```

with:

```
      settled.forEach(p => { if (p.result === 'test_cap' || p.result === 'outside_window') refusedPaywall.push(p); });
      settled.forEach(p => { if (p.result === 'forbidden') refusedForbidden.push(p); });
```

29. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      if (refusedPaywall.length) showRefusedPaywall(refusedPaywall);
```

with:

```
      if (refusedPaywall.length) showRefusedPaywall(refusedPaywall);
      if (refusedForbidden.length) showRefusedForbidden(refusedForbidden);
```

30. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
function showRefusedUndo(items) {
```

with:

```
// The server kept a check-in that desk staff tried to undo because someone
// else made it. The reconcile has already put it back on the row.
function showRefusedForbidden(items) {
  const names = items.map(p => S.roster.find(x => x.id === p.attendee_id)).filter(Boolean).map(fullName);
  showDeskBlock({
    title: items.length === 1 ? 'That undo was not applied' : items.length + ' undos were not applied',
    text: 'Ask a desk lead to undo this check-in.' + (names.length ? ' Still checked in: ' + names.join(', ') + '.' : ''),
  });
}

function showRefusedUndo(items) {
```

31. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
function openKioskSetup() {
```

with:

```
// ═══════════════════════════════════════════════════
// WALK-INS (roles ruling 7)
// A desk lead or above adds a person who is standing at the desk. Needs a
// connection: checkin-add-walk-in creates the row (test-mode rows must be
// is_test, which only the service role may set), then the desk checks
// them in through the normal outbox like anyone else.
// ═══════════════════════════════════════════════════
function openWalkIn() {
  if (!window.CK_ROLES.can(S.role, 'walk_in') || !S.event) return;
  document.getElementById('wi-form').reset();
  document.getElementById('wi-err').textContent = '';
  const list = document.getElementById('wi-tt-list');
  list.replaceChildren();
  [...new Set(S.roster.map(a => a.ticket_type).filter(Boolean))].sort().forEach(t => {
    const o = document.createElement('option');
    o.value = t;
    list.appendChild(o);
  });
  document.getElementById('walkin').style.display = 'flex';
  document.getElementById('wi-first').focus();
}

function closeWalkIn() {
  document.getElementById('walkin').style.display = 'none';
}

async function submitWalkIn(e) {
  e.preventDefault();
  const err = document.getElementById('wi-err');
  const btn = document.getElementById('wi-save');
  err.textContent = '';
  if (!navigator.onLine) {
    err.textContent = 'Adding a walk-in needs a connection. Try again when the desk is back online.';
    return;
  }
  const v = (id) => document.getElementById(id).value.trim();
  const body = { event_id: S.event.id, first_name: v('wi-first'), last_name: v('wi-last'),
                 email: v('wi-email'), company: v('wi-company'), ticket_type: v('wi-tt') };
  if (!body.first_name || !body.last_name) { err.textContent = 'First and last name are needed.'; return; }
  btn.disabled = true;
  btn.textContent = 'Adding…';
  const { data, error } = await sb.functions.invoke('checkin-add-walk-in', { body });
  btn.disabled = false;
  btn.textContent = 'Add to the list';
  if (error) {
    let msg = error.message;
    try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) { /* unreadable body */ }
    err.textContent = msg;
    return;
  }
  const a = data && data.attendee;
  if (!a) { err.textContent = 'The walk-in was not added. Try again.'; return; }
  S.roster.push(a);
  await idbPutAll(STORE_ROSTER, [a]);
  renderCount();
  closeWalkIn();
  showParty(a);
  scanInput.focus();
}

function openKioskSetup() {
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/e2e/checkin-desk-roles.spec.ts`
Expected: 8 passed.

Run: `npm test`
Expected: PASS (the desk's mirrored helpers in `tests/checkin-outbox.spec.ts` and `tests/checkin-scan.spec.ts` are unchanged; `pendingCount` and `replayOrder` still match character for character).

Run: `grep -n "S.role === 'organizer'\|S.role !== 'organizer'" cuedeck-checkin.html`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html tests/e2e/checkin-desk-roles.spec.ts
git commit -m "feat(checkin): desk by role, undo own check-ins only, walk-ins for leads"
```

---

### Task 14: Desk identity and heartbeat

**Files:**
- Modify: `cuedeck-checkin.html`
- Modify: `tests/e2e/checkin-desk-roles.spec.ts`

**Interfaces:**
- Consumes: `checkin_desk_heartbeat(p_event_id, p_desk_id, p_label, p_pending_count) returns text` (Task 3); `checkin-record-scans` reads top-level `desk_id` (Task 5); Task 13's desk edits.
- Produces: `localStorage['ck_desk_id']` (stable UUID per browser); `deskId()`, `sendHeartbeat(label?)`, `startHeartbeat()`, `stopHeartbeat()`, `renameDesk()`; header button `#st-desk` showing the label; every `checkin-record-scans` request carries `desk_id`; a heartbeat every 30 s while the station is open, on reconnect, and right after a flush that settled items.

- [ ] **Step 1: Write the failing tests**

In `tests/e2e/checkin-desk-roles.spec.ts`, replace:

```
type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[] };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN] }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
```

with:

```
type Opts = { role: string; scanResult?: (item: { action: string }) => string; roster?: Record<string, unknown>[];
  heartbeat?: (args: Record<string, unknown>) => unknown };
async function open(page, { role, scanResult = () => 'ok', roster = [ANA, BEN], heartbeat = () => 'Desk 1' }: Opts) {
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_desk_heartbeat', heartbeat);
```

Then append:

```ts
test('the desk reports in with a stable desk id and shows its label', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'crew', heartbeat: (args) => { beats.push(args); return 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1');
  const deskId = await page.evaluate(() => localStorage.getItem('ck_desk_id'));
  expect(deskId).toMatch(/^[0-9a-f-]{36}$/);
  expect(beats[0]).toEqual({ p_event_id: EVENT_ID, p_desk_id: deskId, p_label: null, p_pending_count: 0 });

  const req = page.waitForRequest(r => r.url().includes('/functions/v1/checkin-record-scans') && r.method() === 'POST');
  await search(page, 'Ben');
  await page.locator('.ck-res-row', { hasText: 'Ben Probe' }).locator('.ck-res-btn').click();
  await page.locator('#secondary').click();
  expect((await req).postDataJSON().desk_id).toBe(deskId);
});

test('renaming the desk sends the new label', async ({ page }) => {
  const beats: Record<string, unknown>[] = [];
  await open(page, { role: 'lead', heartbeat: (args) => { beats.push(args); return (args.p_label as string) || 'Desk 1'; } });
  await expect(page.locator('#st-desk')).toHaveText('Desk 1');
  page.once('dialog', d => d.accept('VIP desk'));
  await page.locator('#st-desk').click();
  await expect(page.locator('#st-desk')).toHaveText('VIP desk');
  expect(beats.some(b => b.p_label === 'VIP desk')).toBe(true);
});

test('a viewer never sends a heartbeat', async ({ page }) => {
  let beats = 0;
  await page.clock.setFixedTime(FIXED_NOW);
  await signedIn(page);
  await rpc(page, 'checkin_my_events', [myEventsRow({ role: 'viewer' })]);
  await rpc(page, 'checkin_desk_heartbeat', () => { beats++; return 'Desk 1'; });
  await page.goto('/cuedeck-checkin.html?event=' + EVENT_ID);
  await page.waitForURL(/\/checkin\/dashboard\?event=/);
  expect(beats).toBe(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx playwright test tests/e2e/checkin-desk-roles.spec.ts`
Expected: the three new tests FAIL (`#st-desk` not found, no heartbeat sent); the viewer heartbeat test may pass already; the 8 earlier tests pass.

- [ ] **Step 3: Edit the page**

1. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
var S = { user: null, event: null, role: null, roster: [], party: null, scanPointId: null, editing: null, own: new Map() };
```

with:

```
var S = { user: null, event: null, role: null, roster: [], party: null, scanPointId: null, editing: null, own: new Map(), deskId: null, deskLabel: null };
```

2. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
      <button class="ck-quiet" type="button" id="st-walkin" style="display:none">Add walk-in</button>
```

with:

```
      <button class="ck-quiet" type="button" id="st-desk" title="Rename this desk">This desk</button>
      <button class="ck-quiet" type="button" id="st-walkin" style="display:none">Add walk-in</button>
```

3. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
if (!KIOSK) scheduleFlush();
```

with:

```
if (!KIOSK) scheduleFlush();

// ═══════════════════════════════════════════════════
// DESK IDENTITY AND HEARTBEAT (event-day spec, feature 1)
// A browser desk is otherwise anonymous: scans carry the operator, not
// the laptop. Each desk keeps one random id in localStorage, sends it
// with every batch, and reports in every 30 s (and on reconnect) with the
// size of its queue, so the dashboard can say Online, Offline since, or
// Syncing, and prove that an offline gap lost nothing.
// ═══════════════════════════════════════════════════
const DESK_KEY = 'ck_desk_id';
const HEARTBEAT_EVERY = 30000;
let heartbeatTimer = null;

function deskId() {
  if (S.deskId) return S.deskId;
  let id = null;
  try { id = localStorage.getItem(DESK_KEY); } catch (_) { /* storage blocked: one id for this page load */ }
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    id = crypto.randomUUID();
    try { localStorage.setItem(DESK_KEY, id); } catch (_) { /* as above */ }
  }
  S.deskId = id;
  return id;
}

function renderDeskLabel() {
  document.getElementById('st-desk').textContent = S.deskLabel || 'This desk';
}

// True when the server took the report. A missed heartbeat only makes the
// dashboard say "Offline since", which is then true, so it never throws.
async function sendHeartbeat(label) {
  if (!navigator.onLine || !S.event || !window.CK_ROLES.can(S.role, 'desk')) return false;
  const pending = (await idbGetAll(STORE_OUTBOX)).filter(p => !p.synced && p.event_id === S.event.id).length;
  const { data, error } = await sb.rpc('checkin_desk_heartbeat', {
    p_event_id: S.event.id, p_desk_id: deskId(), p_label: label || null, p_pending_count: pending,
  });
  if (error) { console.error('checkin: heartbeat failed', error.message); return false; }
  if (typeof data === 'string' && data) { S.deskLabel = data; renderDeskLabel(); }
  return true;
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  sendHeartbeat();
  heartbeatTimer = setInterval(() => { sendHeartbeat(); }, HEARTBEAT_EVERY);
}
function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function renameDesk() {
  const typed = window.prompt('Name this desk, for example "Desk 2" or "VIP desk".', S.deskLabel || '');
  if (typed == null) return;
  const name = typed.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return;
  if (!navigator.onLine) { showVerdict('dup', 'Renaming needs a connection', 'Try again when the desk is back online.'); return; }
  if (!(await sendHeartbeat(name))) showVerdict('bad', 'The desk name was not saved', 'Try again in a moment.');
}
```

4. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  if (name === 'station') { startFocusBackstop(); startRosterRefresh(); holdFocus(); }
```

with:

```
  if (name === 'station') { startFocusBackstop(); startRosterRefresh(); startHeartbeat(); holdFocus(); }
```

5. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  else { stopFocusBackstop(); stopRosterRefresh(); closeKioskSetup(); closeWalkIn(); }
```

with:

```
  else { stopFocusBackstop(); stopRosterRefresh(); closeKioskSetup(); closeWalkIn(); stopHeartbeat(); }
```

6. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
window.addEventListener('online',  () => { renderPendingCount(); flushOutbox(); });
```

with:

```
window.addEventListener('online',  () => { renderPendingCount(); flushOutbox(); sendHeartbeat(); });
```

7. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
          event_id: chunk.eventId,
          scan_point_id: S.scanPointId ?? null,
```

with:

```
          event_id: chunk.eventId,
          scan_point_id: S.scanPointId ?? null,
          desk_id: deskId(),
```

8. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
    if (settledAny && navigator.onLine && S.event) {
      await reconcileRoster();
```

with:

```
    if (settledAny && navigator.onLine && S.event) {
      await reconcileRoster();
      sendHeartbeat();   // report the emptied queue now, not in up to 30 s
```

9. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  document.getElementById('st-walkin').addEventListener('click', openWalkIn);
```

with:

```
  document.getElementById('st-walkin').addEventListener('click', openWalkIn);
  document.getElementById('st-desk').addEventListener('click', renameDesk);
```

10. In `cuedeck-checkin.html`, replace (exactly once in the file):

```
  S.role  = window.CK_ROLES.effectiveRole(role, !!(ev && ev.is_owner));
```

with:

```
  S.role  = window.CK_ROLES.effectiveRole(role, !!(ev && ev.is_owner));
  S.deskLabel = null;   // a label belongs to (event, desk); the next heartbeat fills it
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/e2e/checkin-desk-roles.spec.ts tests/e2e/checkin-setup-roles.spec.ts tests/e2e/checkin-home-roles.spec.ts tests/e2e/checkin-dashboard.spec.ts`
Expected: 11 + 7 + 4 + 12 passed.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html tests/e2e/checkin-desk-roles.spec.ts
git commit -m "feat(checkin): desks report in with a stable id, label and queue size"
```

---
### Task 15: Release: pages live, migration 073, live check per role

**Files:**
- Create: `supabase/migrations/073_checkin_my_events_owner.sql`
- Create: `tests/sql/073-owner-probe.sql`
- Create: `scripts/seed-checkin-roles.mjs`

**Interfaces:**
- Consumes: everything above. Pages already read the role with `effectiveRole(row.role, row.is_owner)`, so they work before and after 073.
- Produces: `checkin_my_events().role` is `owner` for the event's creator (roles spec, Server changes); production serving every page and module from this plan; a recorded live check per role.

This task pushes to production, applies a migration to production and creates (then deletes) five throwaway accounts. Never use `sherif.mka@gmail.com` for any of it.

- [ ] **Step 1: Everything green locally**

Run: `npm test`
Expected: PASS.

Run (static server on 7230 running): `npx playwright test tests/e2e/checkin-dashboard.spec.ts tests/e2e/checkin-home-roles.spec.ts tests/e2e/checkin-setup-roles.spec.ts tests/e2e/checkin-desk-roles.spec.ts`
Expected: 34 passed.

Run: `deno check supabase/functions/checkin-*/index.ts`
Expected: no errors.

Run: `git status --short`
Expected: no modified or untracked file from this plan left uncommitted.

- [ ] **Step 2: Push the pages**

```bash
git log --oneline cuedeck/main..HEAD
git push cuedeck main
git push origin main
```

Expected: the log lists this plan's commits; both pushes succeed. If either push is rejected because the remote moved (other sessions share this repo), `git pull --rebase <remote> main`, re-run Step 1, and push again. Never force-push.

- [ ] **Step 3: Verify the deploy is serving the new files**

Wait for the Vercel deployment of `HEAD` on project `cuedeck-console` to show `Ready` (Vercel MCP `list_deployments`, newest first, `meta.githubCommitSha` equals `git rev-parse HEAD`). Then:

```bash
curl -sL "https://app.cuedeck.io/checkin/dashboard?cb=$RANDOM" | grep -q "checkin_event_stats" && echo "dashboard served"
curl -sL "https://app.cuedeck.io/checkin-roles.js?cb=$RANDOM" | grep -q "desk_health" && echo "roles module served"
curl -sL "https://app.cuedeck.io/checkin/desk?cb=$RANDOM" | grep -q "checkin_desk_heartbeat" && echo "desk served"
bash scripts/verify-no-public-internals.sh https://app.cuedeck.io
```

Expected: `dashboard served`, `roles module served`, `desk served`; the verify script ends with `PASS` (it now also requires `/checkin-roles.js`, `/checkin-dashboard.js` and `/checkin/dashboard` to return 200).

- [ ] **Step 4: Write the owner migration and its probe**

Create `supabase/migrations/073_checkin_my_events_owner.sql`:

```sql
-- 073_checkin_my_events_owner.sql
-- checkin_my_events reports the event's creator as 'owner' (roles spec,
-- Server changes), so every screen reads one value. Shipped after the
-- pages that compute the role from is_owner were live (Task 15), because
-- the pages deployed before this plan treated only 'organizer' as an
-- organizer. Body otherwise identical to migration 070.
CREATE OR REPLACE FUNCTION checkin_my_events()
 RETURNS TABLE(event_id uuid, name text, date date, venue text, timezone text,
               event_start time without time zone, event_end time without time zone,
               created_via text, is_owner boolean, role text, status text,
               attendees integer, arrived integer, test_used integer, is_comp boolean)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = public
AS $function$
  WITH mine AS (
    SELECT o.event_id, o.role FROM leod_checkin_operators o
     WHERE o.user_id = auth.uid() AND o.role IN ('organizer', 'lead', 'crew', 'viewer')
    UNION
    SELECT e.id, 'organizer' FROM leod_events e WHERE e.created_by = auth.uid()
  ), best AS (
    SELECT DISTINCT ON (event_id) event_id, role FROM mine
     ORDER BY event_id, array_position(ARRAY['organizer', 'lead', 'crew', 'viewer'], role)
  )
  SELECT b.event_id, e.name, e.date, e.venue, e.timezone, e.event_start, e.event_end,
         e.created_via, (e.created_by = auth.uid()),
         CASE WHEN e.created_by = auth.uid() THEN 'owner' ELSE b.role END,
         ent.status,
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id),
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.checked_in_at IS NOT NULL),
         (SELECT count(*)::int FROM leod_checkin_scan_events s WHERE s.event_id = b.event_id AND s.is_test AND s.result = 'ok')
           + (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.is_test),
         EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)
    FROM best b
    JOIN leod_events e ON e.id = b.event_id AND e.active
    LEFT JOIN leod_checkin_entitlements ent ON ent.event_id = b.event_id
   WHERE ent.event_id IS NOT NULL OR e.created_by = auth.uid();
$function$;
```

Create `tests/sql/073-owner-probe.sql`:

```sql
-- tests/sql/073-owner-probe.sql
-- Expected: an error whose message starts with 'PROBE OK 073'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_ev    uuid;
  v_role  text;
  v_own   boolean;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 073', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (v_ev, v_org, 'organizer');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT role, is_owner INTO v_role, v_own FROM checkin_my_events() WHERE event_id = v_ev;
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'owner' OR v_own IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL: owner row is (%, %)', v_role, v_own;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT role, is_owner INTO v_role, v_own FROM checkin_my_events() WHERE event_id = v_ev;
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'organizer' OR v_own IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PROBE FAIL: organizer row is (%, %)', v_role, v_own;
  END IF;

  RAISE EXCEPTION 'PROBE OK 073: 2 checks passed (rolled back)';
END
$probe$;
```

- [ ] **Step 5: Apply 073 (only after Step 3 passed) and run its probe**

`apply_migration(project_id: "sawekpguemzvuvvulfbc", name: "checkin_my_events_owner", query: <contents of 073>)`.
Expected: success.

Run `tests/sql/073-owner-probe.sql` with `execute_sql`.
Expected: `PROBE OK 073: 2 checks passed (rolled back)`.

Re-run the 070 probe: it now expects `organizer` for the owner and must fail with `PROBE FAIL: owner row is (owner, t), want (organizer, true) until 073`. That failure is the expected proof that 073 is live; edit `tests/sql/070-roles-probe.sql` so the owner block expects `owner`:

```sql
  IF v_role IS DISTINCT FROM 'owner' OR v_bool IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL: owner row is (%, %), want (owner, true)', v_role, v_bool;
  END IF;
```

and re-run it. Expected: `PROBE OK 070: 34 checks passed (rolled back)`.

- [ ] **Step 6: Write the live-check seed script**

Create `scripts/seed-checkin-roles.mjs`:

```js
#!/usr/bin/env node
/**
 * seed-checkin-roles.mjs
 * One throwaway test-mode check-in event with five accounts, one per role,
 * for the live role check in docs/superpowers/plans/2026-10-04-checkin-roles-dashboard.md
 * (Task 15). No email is sent: accounts are created confirmed through the
 * admin API on the cuedeck-test.io domain.
 *
 * Usage:
 *   SUPABASE_SERVICE_KEY=... node scripts/seed-checkin-roles.mjs > /tmp/<scratch>/roles.json
 *   SUPABASE_SERVICE_KEY=... node scripts/seed-checkin-roles.mjs --cleanup <stamp>
 *
 * The JSON printed holds passwords: write it to a scratch file, never to the repo.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

const URL = process.env.SUPABASE_URL || 'https://sawekpguemzvuvvulfbc.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
if (!KEY) { console.error('SUPABASE_SERVICE_KEY is required.'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const ROLES = ['owner', 'organizer', 'lead', 'crew', 'viewer'];
const emailFor = (stamp, role) => `ck-roles-${stamp}-${role}@cuedeck-test.io`;

async function must(label, p) {
  const { data, error } = await p;
  if (error) { console.error(label + ' failed: ' + error.message); process.exit(1); }
  return data;
}

async function cleanup(stamp) {
  const { data: { users }, error } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (error) { console.error('listUsers failed: ' + error.message); process.exit(1); }
  const mine = users.filter(u => (u.email || '').startsWith(`ck-roles-${stamp}-`));
  const owner = mine.find(u => u.email === emailFor(stamp, 'owner'));
  if (owner) {
    // Cascades to entitlements, operators, attendees, scans and desks.
    await must('delete event', sb.from('leod_events').delete().eq('created_by', owner.id).eq('created_via', 'checkin'));
  }
  for (const u of mine) await must('delete ' + u.email, sb.auth.admin.deleteUser(u.id));
  console.log(JSON.stringify({ cleaned: mine.map(u => u.email) }, null, 2));
}

async function seed() {
  const stamp = Date.now().toString(36);
  const people = {};
  for (const role of ROLES) {
    const password = randomBytes(12).toString('base64url');
    const meta = role === 'owner' ? { name: 'Probe Owner', signup_source: 'checkin' } : { name: 'Probe ' + role, checkin_staff: 'true' };
    const data = await must('create ' + role, sb.auth.admin.createUser({ email: emailFor(stamp, role), password, email_confirm: true, user_metadata: meta }));
    people[role] = { id: data.user.id, email: emailFor(stamp, role), password };
  }
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const ev = await must('create event', sb.from('leod_events').insert({
    name: 'Roles check ' + stamp, date, event_start: '09:00', event_end: '18:00', timezone: 'Europe/Warsaw',
    venue: 'Test venue', created_by: people.owner.id, created_via: 'checkin', active: true,
  }).select('id').single());
  await must('entitlement', sb.from('leod_checkin_entitlements').insert({ event_id: ev.id, checkin_core: true, status: 'test' }));
  await must('operators', sb.from('leod_checkin_operators').upsert([
    { event_id: ev.id, user_id: people.owner.id, role: 'organizer' },
    { event_id: ev.id, user_id: people.organizer.id, role: 'organizer' },
    { event_id: ev.id, user_id: people.lead.id, role: 'lead' },
    { event_id: ev.id, user_id: people.crew.id, role: 'crew' },
    { event_id: ev.id, user_id: people.viewer.id, role: 'viewer' },
  ], { onConflict: 'event_id,user_id' }));
  await must('attendees', sb.from('leod_checkin_attendees').insert([
    { event_id: ev.id, first_name: 'Ana', last_name: 'Sample', email: `ana-${stamp}@cuedeck-test.io`, company: 'Contoso Demo', ticket_type: 'attendee', qr_token: randomBytes(16).toString('hex') },
    { event_id: ev.id, first_name: 'Ben', last_name: 'Sample', email: `ben-${stamp}@cuedeck-test.io`, company: 'Contoso Demo', ticket_type: 'VIP', qr_token: randomBytes(16).toString('hex') },
    { event_id: ev.id, first_name: 'Cleo', last_name: 'Sample', email: null, company: 'Fabrikam Demo', ticket_type: 'attendee', qr_token: randomBytes(16).toString('hex') },
  ]));
  console.log(JSON.stringify({ stamp, event_id: ev.id, people }, null, 2));
}

if (process.argv[2] === '--cleanup') await cleanup(process.argv[3] || '');
else await seed();
```

Run: `node --check scripts/seed-checkin-roles.mjs`
Expected: no output.

Commit:

```bash
git add supabase/migrations/073_checkin_my_events_owner.sql tests/sql/073-owner-probe.sql tests/sql/070-roles-probe.sql scripts/seed-checkin-roles.mjs
git commit -m "feat(checkin): migration 073 reports the owner role; live role-check seed script"
```

- [ ] **Step 7: Live check, one run per role**

`SUPABASE_SERVICE_KEY` lives in the repo's `.env` (never print it). Seed into the scratchpad, not the repo:

```bash
set -a; source .env; set +a
node scripts/seed-checkin-roles.mjs > <your scratchpad directory>/roles.json
```

Then, in Chrome (claude-in-chrome), sign in at `https://app.cuedeck.io/checkin` as each account from `roles.json` in turn, in a fresh incognito-like session per role (sign out between roles). Turnstile protects sign-in; if it blocks the automated sign-in, stop and ask Sherif to sign in to that one account, nothing else. For each role, check exactly the list below and take a 2x screenshot of each screen named in it. To test a server refusal, run this in the page's DevTools console (it uses the signed-in session from localStorage):

```js
const s = JSON.parse(localStorage.getItem('sb-sawekpguemzvuvvulfbc-auth-token'));
const call = (fn, body) => fetch('https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/' + fn, { method: 'POST',
  headers: { Authorization: 'Bearer ' + s.access_token, apikey: 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB', 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async r => [r.status, await r.json()]);
```

Owner:
- `/checkin`: card label `Owner`, buttons Continue setup, Try the desk, Dashboard.
- Setup, Event details: Transfer ownership and Delete event visible; Go live: the pay panel is visible (do not pay).
- Dashboard: five tiles, five charts, TEST banner; Desks and pace panel visible.

Organizer:
- Setup, Go live: `Only the event owner, Probe Owner, can go live.`; no pay button.
- Console: `await call('checkin-create-checkout', { event_id: '<event_id>' })` returns `[403, { error: 'Only the event owner can go live', code: 'not_owner' }]`.
- Event details: rename the event to `Roles check renamed`, Save shows `Saved`.

Desk lead:
- Setup opens on Desk staff only; role list offers Desk staff only.
- Desk: Add walk-in and Set up a kiosk visible; add walk-in `Walt Walkin`, check him in without printing; Undo visible on Ana after the crew account checks her in (do the crew run first, then come back).
- Dashboard: Desks and pace panel lists this desk as `Online`.

Desk staff:
- Desk: no Add walk-in, no Set up a kiosk; check in Ana; Undo visible on Ana; search Walt (checked in by the lead): no Undo.
- Console: `await call('checkin-add-walk-in', { event_id: '<event_id>', first_name: 'X', last_name: 'Y' })` returns `[403, ...code: 'forbidden']`.
- Dashboard: no Desks and pace panel.

Viewer:
- `/checkin`: card label `Viewer`, counts, one `View dashboard` button.
- `/checkin/desk?event=<event_id>` lands on `/checkin/dashboard?event=<event_id>` showing the client view only.
- Console: `await fetch('https://sawekpguemzvuvvulfbc.supabase.co/rest/v1/leod_checkin_attendees?select=id&event_id=eq.<event_id>', { headers: { Authorization: 'Bearer ' + s.access_token, apikey: 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB' } }).then(r => r.json())` returns `[]`.

Record each result as pass or fail with its screenshot path. Any fail stops the task: fix it in the owning task's files, commit, push, re-verify (Step 3), and re-run that role.

- [ ] **Step 8: Clean up**

```bash
node scripts/seed-checkin-roles.mjs --cleanup <stamp from roles.json>
```

Expected: `cleaned` lists the five addresses. Then confirm with `execute_sql`:

```sql
select count(*) from auth.users where email like 'ck-roles-<stamp>-%'
```

Expected: `0`. Delete `roles.json` from the scratchpad.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Five roles, owner in `created_by` only, no data migration | 2 (CHECK), 1 (`effectiveRole`) |
| Permission table | 1 (table + tests), 5, 6, 7 (server), 11 to 14 (screens) |
| Ruling 1, go live owner only, comp included; test setup organizer | 5 (create-checkout, enable-event), 12 (Go live panel) |
| Ruling 2, delete means archive, test mode only | 6 (`archive_event`), 12 (Delete event) |
| Ruling 3, transfer to an organizer, checkin events, comp note | 6 (`transfer_owner`), 1 (`transferNote`), 12 |
| Ruling 4, export is a screen permission | 1 (`export`), 12 (Export CSV hidden) |
| Ruling 5, viewers read numbers only | 2 (policies + probe), 4 (stats has no people data, probe) |
| Ruling 6, cut-down Setup for leads | 12 |
| Ruling 7, walk-ins with `source = 'walk_in'`, test rows count | 2 (CHECK), 7 (function), 13 (desk form) |
| Ruling 8, undo own, `forbidden` | 2 (CHECK), 3 (`checkin_apply_scan`), 1 (`mayUndo`), 13 |
| Ruling 9, `checkin_staff` account role for lead and viewer | 6 (invite metadata unchanged for all roles) |
| Server changes: CHECKs, `checkin_is_owner`, policies, `checkin_my_events`, `checkin_apply_scan`, `checkin_event_stats` | 2, 3, 4, 15 (owner value) |
| Edge Functions (seven) | 5, 6, 7 |
| Screens: cards, Setup, desk | 11, 12, 13, 14 |
| Dashboard page, tiles, five charts, 30 s refresh, TEST banner, links from cards and Setup | 9, 11, 12, 13 (desk link) |
| Event-day 1, desk health, `desk_id`, `leod_checkin_desks`, heartbeat, gaps, "0 lost" rule | 3, 4, 8, 10, 14 |
| Event-day 2, pace and staffing, measured only | 4 (`last_25_min`, `speeds`), 8, 10 |
| Event-day 3, client view | 8 (`clientView`), 9 |
| Tests: RLS matrix five roles, function gates, apply_scan undo, browser per role | 2, 5 to 7, 3, 9 to 15 |
