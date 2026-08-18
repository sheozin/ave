# Check-in Scanner Device Implementation Plan (Build A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `cuedeck-scanner.html` — a roaming camera scanner that staff carry to a door or a session room, bound to one scan point, holding no attendee names, with every feature switchable off per event.

**Architecture:** A new standalone single-file page, paired by device key exactly as the kiosk is. The camera decodes a QR to a bare token; the token is checked against a names-free local cache for an instant verdict; the scan is recorded through the existing `checkin-record-scans`, which gains device-key auth and enforces the scan-point settings. Identity is fetched per scan when online and omitted entirely when not.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step. Supabase JS v2 via CDN. A QR *decoder* via CDN — a new dependency; `qrcode-generator` encodes only. Deno Edge Functions, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-checkin-scanner-device-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/058_checkin_scan_settings.sql` | Create: per-event `entrance_scanning` / `session_scanning` settings |
| `cuedeck-scanner.html` | Create: the scanner page — pair, camera, verdict, outbox |
| `supabase/functions/checkin-record-scans/index.ts` | Modify: accept a device key; enforce scan-point settings |
| `supabase/functions/checkin-kiosk-pair/index.ts` | Modify: mint/claim a `scanner` device bound to a scan point |
| `cuedeck-checkin.html` | Modify: organizer toggles for the two settings, and scan-point selection at mint |
| `tests/checkin-scanner.spec.ts` | Create: cooldown, cache, settings gating |
| `tests/e2e/checkin-scanner.spec.ts` | Create: Playwright with a fake camera stream |
| `docs/checkin-scanner-runbook.md` | Create: permissions, lighting, battery, what staff do when it fails |

**Security note throughout:** attendee names reach this system from a public kiosk, so they are attacker-controlled. Never build DOM from them with markup-parsing sinks — `innerHTML`, `insertAdjacentHTML`, `outerHTML`, or the legacy document writer. Use `createElement` + `textContent` + `replaceChildren()` only. The device key is a credential: never logged, never rendered, never in a URL.

---

### Task 1: Migration 058 — per-event scan settings

**Files:**
- Create: `supabase/migrations/058_checkin_scan_settings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 058: Check-in — per-event scan settings
-- ============================================================
-- Not every event wants door scanning, and fewer want session
-- scanning. A small seminar checks people in at a desk and nothing
-- else. These two settings make the scanner opt-in per event.
--
-- WHY THESE ARE NOT ENTITLEMENTS
--
-- leod_checkin_entitlements already mixes two kinds of flag:
-- commercial ones the plan permits (checkin_core,
-- multi_point_scanning, integration_api) and operational ones the
-- organizer switched on (auto_send_qr_email from 052,
-- self_registration and kiosk_self_print from 053). The distinction
-- matters here:
-- multi_point_scanning answers "may they", these answer "do they want
-- it, at this event". BOTH gates must pass — an event holding the
-- entitlement with the setting off does no session scanning.
--
-- Both default FALSE. A feature that appears without being asked for
-- is one an organizer discovers at 8am on a day they did not plan for
-- it.
--
-- The three existing operational settings are deliberately NOT moved
-- here: all are live in production and read by deployed Edge
-- Functions. Tidying that is a separate change with its own risk.
-- ============================================================

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS entrance_scanning BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS session_scanning BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN leod_checkin_entitlements.entrance_scanning IS
  'Organizer setting, not an entitlement: door scanning on for this event.';

COMMENT ON COLUMN leod_checkin_entitlements.session_scanning IS
  'Organizer setting: interior scanning on. Requires multi_point_scanning (the entitlement) to also be true.';
```

- [ ] **Step 2: Confirm no write policy is needed**

Migration 055 had to extend a column guard because `leod_checkin_attendees` admits crew writes. `leod_checkin_entitlements` should have **no write policy at all** — verify rather than assume:

```sql
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'leod_checkin_entitlements';
```

Expected: one `SELECT` policy only. If that holds, no guard is needed — the table is service-role-write-only and an organizer changes these through an Edge Function. **If a write policy has appeared since, stop and report it.**

- [ ] **Step 3: Apply and verify**

Apply via the Supabase SQL editor, then:

```sql
SELECT column_name, column_default FROM information_schema.columns
 WHERE table_name = 'leod_checkin_entitlements'
   AND column_name IN ('entrance_scanning','session_scanning');
```

Expected: 2 rows, both defaulting to `false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/058_checkin_scan_settings.sql
git commit -m "feat(checkin): migration 058 — per-event scan settings"
```

---

### Task 2: Choose the QR decoder

This is a real decision, not a formality. Get it wrong and every later task rests on a library that cannot be used.

**Files:** none yet — this task produces a decision and a spike.

- [ ] **Step 1: Establish the constraints**

The repo has **no build step** (`CLAUDE.md`, Coding Rules 1–2). The decoder must be a single script tag from a CDN: no bundler, no npm install, no WASM needing a separate asset path unless that too is CDN-hosted.

It must handle continuous decode without a shutter tap, and a QR displayed on **another screen** — glare, backlight, moiré. That is the normal case, because attendees hold up phones.

- [ ] **Step 2: Spike two candidates**

Write a throwaway page in `.superpowers/` (gitignored) loading each candidate from a CDN, decoding the test QRs already at `.superpowers/qr-test-badges.html`. Test **on a phone**, not a laptop webcam — the target device is what matters.

Record for each: time to first decode, decode rate off a phone screen at arm's length, behaviour in poor light, script size, and whether torch control is reachable.

- [ ] **Step 3: Record the choice**

Write the decision and the measurements into the spec under a new "Decoder" heading. State what was rejected and why, so nobody redoes this.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-18-checkin-scanner-device-design.md
git commit -m "docs(checkin): record the QR decoder choice and its measurements"
```

---

### Task 3: Scan cooldown and cache logic

Pure functions with tests. A continuous decoder fires many times per second on the same code; without suppression one attendee generates dozens of scan events.

**Files:**
- Test: `tests/checkin-scanner.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/checkin-scanner.spec.ts
// Scanner cooldown, token cache, and settings gating. Following this
// repo's convention (see tests/checkin-import.spec.ts): Deno Edge
// Functions aren't importable into vitest, so logic is re-expressed
// here and kept in sync by hand with cuedeck-scanner.html.
import { describe, it, expect } from 'vitest';

const COOLDOWN_MS = 4000;

type Seen = Map<string, number>;

// A continuous decoder reports the same QR many times a second while it
// is in frame. Without this, one attendee holding up a phone produces
// dozens of scan events and dozens of outbox items.
function shouldAccept(seen: Seen, token: string, now: number): boolean {
  const last = seen.get(token);
  if (last !== undefined && now - last < COOLDOWN_MS) return false;
  seen.set(token, now);
  return true;
}

// The cache holds ONLY tokens. No names, emails, companies or ids — a
// roaming phone gets left on chairs.
function tokenKnown(cache: Set<string>, token: string): boolean {
  return cache.has(token.trim());
}

// Both gates must pass: the entitlement says the plan permits it, the
// setting says the organizer wants it at this event.
function scanPointAllowed(
  point: { kind: 'entrance' | 'interior' },
  ent: { multi_point_scanning: boolean; entrance_scanning: boolean; session_scanning: boolean },
): boolean {
  if (point.kind === 'entrance') return ent.entrance_scanning;
  return ent.multi_point_scanning && ent.session_scanning;
}

describe('scanner: shouldAccept', () => {
  it('accepts a token the first time it is seen', () => {
    expect(shouldAccept(new Map(), 'AAA', 1000)).toBe(true);
  });

  it('rejects the same token inside the cooldown', () => {
    const seen: Seen = new Map();
    shouldAccept(seen, 'AAA', 1000);
    expect(shouldAccept(seen, 'AAA', 1000 + COOLDOWN_MS - 1)).toBe(false);
  });

  it('accepts it again once the cooldown has passed', () => {
    const seen: Seen = new Map();
    shouldAccept(seen, 'AAA', 1000);
    expect(shouldAccept(seen, 'AAA', 1000 + COOLDOWN_MS)).toBe(true);
  });

  it('does not let one token block another', () => {
    const seen: Seen = new Map();
    shouldAccept(seen, 'AAA', 1000);
    expect(shouldAccept(seen, 'BBB', 1001)).toBe(true);
  });
});

describe('scanner: tokenKnown', () => {
  const cache = new Set(['AAA', 'BBB']);

  it('recognises a cached token', () => {
    expect(tokenKnown(cache, 'AAA')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(tokenKnown(cache, '  AAA \n')).toBe(true);
  });

  it('rejects an unknown token', () => {
    expect(tokenKnown(cache, 'ZZZ')).toBe(false);
  });
});

describe('scanner: scanPointAllowed', () => {
  const on = { multi_point_scanning: true, entrance_scanning: true, session_scanning: true };

  it('allows an entrance point when entrance scanning is on', () => {
    expect(scanPointAllowed({ kind: 'entrance' }, on)).toBe(true);
  });

  it('refuses an entrance point when the organizer switched it off', () => {
    expect(scanPointAllowed({ kind: 'entrance' }, { ...on, entrance_scanning: false })).toBe(false);
  });

  it('refuses an interior point without the entitlement, even if the setting is on', () => {
    expect(scanPointAllowed({ kind: 'interior' }, { ...on, multi_point_scanning: false })).toBe(false);
  });

  it('refuses an interior point with the entitlement but the setting off', () => {
    expect(scanPointAllowed({ kind: 'interior' }, { ...on, session_scanning: false })).toBe(false);
  });

  it('allows an interior point only when both are true', () => {
    expect(scanPointAllowed({ kind: 'interior' }, on)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-scanner.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: no regressions. Report the summary line.

- [ ] **Step 4: Commit**

```bash
git add tests/checkin-scanner.spec.ts
git commit -m "test(checkin): scanner cooldown, token cache, and settings gating"
```

---

### Task 4: Device-key auth and settings enforcement in `checkin-record-scans`

**Files:**
- Modify: `supabase/functions/checkin-record-scans/index.ts`

- [ ] **Step 1: Read the two reference implementations first**

`checkin-record-scans` currently requires an operator JWT; a roaming scanner has none. `checkin-self-register` already validates a device key — read how it hashes and looks up, and the comment explaining why an unsalted SHA-256 through the UNIQUE index is right here and a salted KDF is not.

Also read migration 057: a revoked device must be rejected, and `checkin-self-register` already does that.

- [ ] **Step 2: Accept either credential**

Add a `device_key` alternative to the JWT path. When present: hash it, look up the device, require `kind = 'scanner'`, require `revoked_at IS NULL`, and require the device's `event_id` to match the request's.

`operator_id` on the resulting scan events is then **null** — a scanner has no operator, and inventing one would falsify the audit trail migration 053 exists to keep honest.

- [ ] **Step 3: Enforce the scan-point settings**

Load the entitlements row once per request, resolve the scan point's `kind`, and apply exactly the rule from Task 3's `scanPointAllowed`. On refusal return 403 with a message naming the setting — "session scanning is switched off for this event" — not an error code. Someone at a door needs to know whether to fetch the organizer or walk to the desk.

- [ ] **Step 4: Verify**

`npm test` for regressions, then deploy and confirm the desk still works — the JWT path must be untouched.

**Deploy only after migration 058 is applied.** The function reads the new columns, and PostgREST rejects a select naming an unknown column; deploying first would 401 every desk.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/checkin-record-scans/index.ts
git commit -m "feat(checkin): device-key auth and scan-point settings in record-scans"
```

---

### Task 5: Pair a scanner to a scan point

**Files:**
- Modify: `supabase/functions/checkin-kiosk-pair/index.ts`
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Extend mint**

The mint branch creates a `kiosk` device. Add a `device_kind` of `kiosk` or `scanner`, and for a scanner require a `scan_point_id` — migration 048's CHECK enforces that a scanner must carry one, so a mint without it fails at the database with an opaque error. Reject it in the function with a clear message instead.

Validate that the scan point belongs to the event, and that its kind is switched on per Task 3's rule. Pairing a scanner to a session room at an event with session scanning off must fail at pair time, not silently at first scan.

- [ ] **Step 2: Extend the organizer UI**

In `cuedeck-checkin.html`'s mint modal, add a kiosk-or-scanner choice and, for a scanner, a scan-point picker listing this event's points with their kind. Reuse the existing modal — do not build a second one.

Add toggles for `entrance_scanning` and `session_scanning`. Grey out session scanning with an explanation when `multi_point_scanning` is false: the organizer needs to know it is a plan limit, not a bug.

- [ ] **Step 3: Verify**

Stub `sb` as previous tasks did. **Gotcha:** supabase-js exposes `functions` as a getter returning a fresh client per access, so assigning `sb.functions.invoke` silently no-ops — redefine the getter with `Object.defineProperty`. Confirm the desk and kiosk are unchanged.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/checkin-kiosk-pair/index.ts cuedeck-checkin.html
git commit -m "feat(checkin): pair a scanner device to a scan point"
```

---

### Task 6: The scanner page

**Files:**
- Create: `cuedeck-scanner.html`

- [ ] **Step 1: Shell and pairing**

Copy the kiosk's pairing screen from `cuedeck-checkin.html` — the 8-character input, the uppercase-and-strip normalisation, the claim call, the localStorage write and its ordering comment. Same light design tokens as the desk, because a lobby is bright.

Show the bound scan point's name permanently in the header. Staff carrying two scanners must tell at a glance which door this one is for.

- [ ] **Step 2: Camera**

`getUserMedia` with `facingMode: 'environment'`, requested **on first scan, not on page load**. A permission prompt before the operator has chosen to scan trains people to dismiss it.

Handle three failures explicitly, each with a next step: permission denied, no camera, and camera already in use by another app. On a shared event phone the third is common and looks like a crash if unhandled.

Add a torch control where `ImageCapture` exposes one; hide it where it does not rather than showing a dead button.

- [ ] **Step 3: The scan loop**

Decode continuously. Apply `shouldAccept` from Task 3 before anything else — that guard is what stops one attendee producing dozens of events.

On an accepted token: check `tokenKnown` against the cache for an instant local verdict, queue the scan, and if online fetch the name and ticket type to display. Offline, show the verdict alone.

- [ ] **Step 4: The verdict screen**

Readable at arm's length while walking, in a bright lobby, by someone not looking straight at it. Green admit, red not-on-this-list. Status in **words as well as colour** — the desk's rule applies here more, not less.

Include a visible cooldown indicator so staff understand why a second scan of the same code does nothing, rather than concluding the device is broken.

- [ ] **Step 5: Outbox**

Reuse the desk's `enqueue` / `replayOrder` / `markSynced` exactly, plus the `client_id` dedup from migration 053. Do NOT reinvent them — mirror them as the repo's convention requires, and say so in a comment.

The cache holds no `checked_in_at`, so offline the scanner cannot tell a first scan from a repeat. Show "on the list" and let the server decide. This is honest rather than confident, and it is why Build C exists.

- [ ] **Step 6: Verify**

Serve on 7230, open on a phone on the same network. Verify pairing, camera permission, a real decode of the test QRs, the cooldown, the offline verdict, and that no name appears offline.

Confirm the markup-sink grep returns nothing:

```bash
grep -nE "innerHTML|insertAdjacentHTML|outerHTML|document[.]write" cuedeck-scanner.html
```

- [ ] **Step 7: Commit**

```bash
git add cuedeck-scanner.html
git commit -m "feat(checkin): roaming camera scanner page"
```

---

### Task 7: Session attendance report

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Add the report**

Attendance data nobody can read is a table that grows. Add a modest organizer-only report to the desk showing per-scan-point attendance:

```sql
SELECT sp.name, sp.kind, count(DISTINCT se.attendee_id) AS attended
  FROM leod_checkin_scan_events se
  JOIN leod_checkin_scan_points sp ON sp.id = se.scan_point_id
 WHERE se.event_id = $1 AND se.result = 'ok'
 GROUP BY sp.id, sp.name, sp.kind
 ORDER BY sp.sort_order;
```

`count(DISTINCT attendee_id)` is deliberate: a person scanned twice at one point is one attendee, not two. That stays correct when Build C changes re-entry semantics.

- [ ] **Step 2: Verify and commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): per-scan-point attendance report"
```

---

### Task 8: Runbook and full verification

- [ ] **Step 1: Write `docs/checkin-scanner-runbook.md`**

Cover: pairing a scanner; granting camera permission on iOS and Android; that **HTTPS or localhost is required** for `getUserMedia` — a scanner served over plain HTTP from a venue laptop silently has no camera, and this is the single most likely deployment failure; battery expectations for continuous camera use; what staff do when a scan fails; and how to revoke a lost device.

- [ ] **Step 2: Full suite**

```bash
npm run test:all
bash scripts/verify-cuedeck.sh 7230
```

- [ ] **Step 3: Live verification per CLAUDE.md**

Scan a real QR with a real phone, screenshot the verdict, and confirm the `scan_events` row landed with the right `scan_point_id` and a null `operator_id`.

- [ ] **Step 4: Commit and push**

---

## Self-Review

**Spec coverage:** per-event optionality → Tasks 1, 4, 5; decoder → Task 2; cooldown and cache → Tasks 3, 6; device-key auth → Task 4; scan-point binding → Task 5; the page → Task 6; session attendance → Task 7; runbook → Task 8.

**Type consistency:** `shouldAccept`, `tokenKnown` and `scanPointAllowed` are defined once in Task 3 and referenced by name thereafter.

**Deliberate gaps:** access control (Build B) and re-entry semantics (Build C) are out of scope and named as such. Offline identity display is excluded by the spec's cache decision, not by omission.

**Known risk:** Task 2 is the one task that could invalidate the rest. If no CDN-only decoder performs adequately on a phone reading another phone's screen, the camera premise fails and this becomes a hardware-gun device instead. Do Task 2 early and report honestly.
