# Check-in Station UI & Self-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `cuedeck-checkin.html` — an offline-capable registration desk that scans QR codes, looks people up by name, checks in a whole company party at once, prints badges, corrects mistakes, and runs a self-registration kiosk for walk-ups.

**Architecture:** One standalone vanilla HTML/JS page serving two modes (desk and kiosk), backed by a new `checkin-record-scans` Edge Function that holds final authority over `checked_in_at`. The attendee roster is cached in IndexedDB so scans resolve instantly offline; actions queue in a local outbox and flush on reconnect. Badges print directly from the page via `window.print()` under Chrome's `--kiosk-printing` flag — no print agent.

**Tech Stack:** Vanilla HTML/CSS/JS (no build step), Supabase JS v2 via CDN, Deno Edge Functions, vitest for unit tests, Playwright for e2e, IndexedDB for local state.

**Spec:** `docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/053_checkin_station_support.sql` | Create: `'undo'` result value, `operator_id`, `client_id` dedup index, two entitlement flags |
| `supabase/functions/checkin-record-scans/index.ts` | Create: batch scan ingest, first-scan-wins authority |
| `supabase/functions/checkin-self-register/index.ts` | Create: kiosk walk-up registration, device-key gated |
| `supabase/migrations/055_checkin_kiosk_support.sql` | Create: `consent_at`, kiosk device key plumbing, rate limiting |
| `supabase/functions/_shared/checkin-scan.ts` | Create: pure resolve/classify logic shared by function and tests |
| `cuedeck-checkin.html` | Create: the desk + kiosk page (single file, repo convention) |
| `tests/checkin-scan.spec.ts` | Create: scan resolution, first-wins, party assembly |
| `tests/checkin-outbox.spec.ts` | Create: outbox queue, merge, replay ordering |
| `tests/checkin-kiosk.spec.ts` | Create: kiosk field validation, already-registered path |
| `tests/e2e/checkin-desk.spec.ts` | Create: Playwright desk flow |
| `scripts/deploy-functions.sh` | Modify: add `checkin-record-scans` to `ALL_FUNCTIONS` |
| `docs/checkin-desk-runbook.md` | Create: Chrome launch flags, printer setup |

**Note on the single-file convention:** `CLAUDE.md` mandates single-file pages (`cuedeck-console.html` is ~7800 lines). `cuedeck-checkin.html` follows that. Pure logic that needs unit testing lives in `_shared/checkin-scan.ts` and is mirrored in the test files, per the convention documented at the top of `tests/checkin-import.spec.ts`.

**Security note that applies throughout:** attendee names, companies, and emails are user-supplied — a kiosk lets a stranger type them. Never build DOM from them with `innerHTML` or template-string HTML. Every task below constructs elements with `createElement` and assigns text via `textContent`, which cannot execute markup.

---

### Task 1: Migration 053 — schema support for undo and kiosk settings

**Files:**
- Create: `supabase/migrations/053_checkin_station_support.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 053: Check-in module — station support
-- ============================================================
-- Four changes supporting the check-in station UI (see
-- docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md):
--
-- 1. 'undo' added to leod_checkin_scan_events.result. Undoing a
--    mistaken check-in writes a NEW row rather than deleting the
--    original, so the timeline reads forward and a correction is
--    always attributable. Deleting would also make the existing
--    'duplicate' value unreachable in audit terms.
--
-- 2. operator_id on scan_events. The table had device_id but no
--    person, so "who undid this" was unrecordable. Nullable because
--    pre-existing rows have no operator, and ON DELETE SET NULL so
--    removing a user never destroys the scan history.
--
-- 3. self_registration / kiosk_self_print on entitlements. Per-event
--    config lives in this table already (personalization_station).
--    Both default FALSE: a kiosk that lets anyone issue themselves a
--    badge must be switched on deliberately, never inherited.
--
-- 4. client_id on scan_events, with a unique index. The station queues
--    actions locally and retries on reconnect, so if a flush response
--    is lost the same item is sent again. The unique index makes that
--    at-most-once at the DATABASE, which is the only place it can be
--    guaranteed: the client's own dedup is in-memory and cannot
--    survive the outbox pruning that a multi-day event requires.
--    Nullable with a partial index because rows written by other paths
--    (CSV import, the future door scanner) carry no client_id.
-- ============================================================

ALTER TABLE leod_checkin_scan_events
  DROP CONSTRAINT IF EXISTS leod_checkin_scan_events_result_check;

ALTER TABLE leod_checkin_scan_events
  ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo'));

ALTER TABLE leod_checkin_scan_events
  ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_attendee
  ON leod_checkin_scan_events (attendee_id, scanned_at DESC);

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS self_registration BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS kiosk_self_print BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_scan_events
  ADD COLUMN IF NOT EXISTS client_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_scan_events_client_id_unique
  ON leod_checkin_scan_events (client_id) WHERE client_id IS NOT NULL;
```

- [ ] **Step 2: Apply it**

Open the Supabase SQL editor for project `sawekpguemzvuvvulfbc` and run the file contents.

- [ ] **Step 3: Verify live**

Run in the SQL editor:

```sql
SELECT pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname = 'leod_checkin_scan_events_result_check';
```

Expected: the definition contains `'undo'`.

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'leod_checkin_entitlements'
   AND column_name IN ('self_registration','kiosk_self_print');
```

Expected: 2 rows.

```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'leod_checkin_scan_events'
   AND indexname = 'idx_checkin_scan_events_client_id_unique';
```

Expected: 1 row. This index is what makes retried flushes at-most-once.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/053_checkin_station_support.sql
git commit -m "feat(checkin): migration 053 — undo result, operator_id, kiosk flags"
```

---

### Task 2: Scan resolution logic

Resolving a scanned token or typed name against the cached roster. Pure functions, no DB.

**Files:**
- Create: `supabase/functions/_shared/checkin-scan.ts`
- Test: `tests/checkin-scan.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/checkin-scan.spec.ts
// Check-in station scan resolution and party assembly. Following this
// repo's convention (see tests/checkin-import.spec.ts): Deno Edge
// Functions aren't importable into vitest, so the logic is re-expressed
// here and kept in sync by a human diffing it against
// supabase/functions/_shared/checkin-scan.ts.
import { describe, it, expect } from 'vitest';

type Attendee = {
  id: string; event_id: string; first_name: string; last_name: string;
  email: string | null; company: string | null; ticket_type: string;
  qr_token: string; checked_in_at: string | null;
};

type ScanResult =
  | { kind: 'ok'; attendee: Attendee }
  | { kind: 'duplicate'; attendee: Attendee; since: string }
  | { kind: 'unknown_token' };

function resolveToken(token: string, roster: Attendee[]): ScanResult {
  const t = token.trim();
  const found = roster.find(a => a.qr_token === t);
  if (!found) return { kind: 'unknown_token' };
  if (found.checked_in_at) return { kind: 'duplicate', attendee: found, since: found.checked_in_at };
  return { kind: 'ok', attendee: found };
}

function searchByName(query: string, roster: Attendee[]): Attendee[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return roster.filter(a =>
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
    (a.email ?? '').toLowerCase().includes(q) ||
    (a.company ?? '').toLowerCase().includes(q)
  );
}

function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  if (!anchor.company) return [anchor];
  const mates = roster.filter(a =>
    a.id !== anchor.id &&
    a.company !== null &&
    a.company.toLowerCase() === anchor.company!.toLowerCase()
  );
  return [anchor, ...mates];
}

const mk = (o: Partial<Attendee> & { id: string }): Attendee => ({
  event_id: 'e1', first_name: 'A', last_name: 'B', email: null, company: null,
  ticket_type: 'attendee', qr_token: 'tok-' + o.id, checked_in_at: null, ...o,
});

describe('checkin-scan: resolveToken', () => {
  const roster = [
    mk({ id: '1', qr_token: 'AAA', first_name: 'Anna', last_name: 'Kowalska' }),
    mk({ id: '2', qr_token: 'BBB', checked_in_at: '2026-08-03T09:02:00Z' }),
  ];

  it('returns ok for a valid unused token', () => {
    expect(resolveToken('AAA', roster).kind).toBe('ok');
  });

  it('trims surrounding whitespace from scanner input', () => {
    expect(resolveToken('  AAA \n', roster).kind).toBe('ok');
  });

  it('returns duplicate with the original time when already checked in', () => {
    const r = resolveToken('BBB', roster);
    expect(r.kind).toBe('duplicate');
    if (r.kind === 'duplicate') expect(r.since).toBe('2026-08-03T09:02:00Z');
  });

  it('returns unknown_token for a code not on this roster', () => {
    expect(resolveToken('ZZZ', roster).kind).toBe('unknown_token');
  });
});

describe('checkin-scan: searchByName', () => {
  const roster = [
    mk({ id: '1', first_name: 'Anna', last_name: 'Kowalska', company: 'Acme', email: 'anna@acme.pl' }),
    mk({ id: '2', first_name: 'Adam', last_name: 'Kowal', company: 'Rivo' }),
  ];

  it('ignores queries shorter than two characters', () => {
    expect(searchByName('a', roster)).toHaveLength(0);
  });

  it('matches on partial surname, case-insensitively', () => {
    expect(searchByName('kowal', roster)).toHaveLength(2);
  });

  it('matches on email and company too', () => {
    expect(searchByName('acme', roster)).toHaveLength(1);
    expect(searchByName('anna@', roster)).toHaveLength(1);
  });
});

describe('checkin-scan: assembleParty', () => {
  const roster = [
    mk({ id: '1', company: 'Acme' }),
    mk({ id: '2', company: 'acme' }),
    mk({ id: '3', company: 'Rivo' }),
    mk({ id: '4', company: null }),
  ];

  it('groups colleagues case-insensitively, anchor first', () => {
    expect(assembleParty(roster[0], roster).map(a => a.id)).toEqual(['1', '2']);
  });

  it('returns a party of one when the attendee has no company', () => {
    expect(assembleParty(roster[3], roster).map(a => a.id)).toEqual(['4']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-scan.spec.ts`
Expected: PASS, 9 tests. This file IS the specification for the shared module.

- [ ] **Step 3: Write the shared module mirroring it**

```ts
// supabase/functions/_shared/checkin-scan.ts
// Pure scan-resolution logic for the check-in station. Mirrored by
// tests/checkin-scan.spec.ts — keep the two in sync by hand.

export type Attendee = {
  id: string; event_id: string; first_name: string; last_name: string;
  email: string | null; company: string | null; ticket_type: string;
  qr_token: string; checked_in_at: string | null;
};

export type ScanResult =
  | { kind: 'ok'; attendee: Attendee }
  | { kind: 'duplicate'; attendee: Attendee; since: string }
  | { kind: 'unknown_token' };

export function resolveToken(token: string, roster: Attendee[]): ScanResult {
  const t = token.trim();
  const found = roster.find(a => a.qr_token === t);
  if (!found) return { kind: 'unknown_token' };
  if (found.checked_in_at) return { kind: 'duplicate', attendee: found, since: found.checked_in_at };
  return { kind: 'ok', attendee: found };
}

export function searchByName(query: string, roster: Attendee[]): Attendee[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return roster.filter(a =>
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
    (a.email ?? '').toLowerCase().includes(q) ||
    (a.company ?? '').toLowerCase().includes(q)
  );
}

export function assembleParty(anchor: Attendee, roster: Attendee[]): Attendee[] {
  if (!anchor.company) return [anchor];
  const mates = roster.filter(a =>
    a.id !== anchor.id &&
    a.company !== null &&
    a.company.toLowerCase() === anchor.company!.toLowerCase()
  );
  return [anchor, ...mates];
}
```

- [ ] **Step 4: Re-run tests**

Run: `npx vitest run tests/checkin-scan.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/checkin-scan.ts tests/checkin-scan.spec.ts
git commit -m "feat(checkin): scan resolution and party assembly logic"
```

---

### Task 3: Offline outbox logic

**Files:**
- Test: `tests/checkin-outbox.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/checkin-outbox.spec.ts
// Offline outbox for the check-in station: queueing, ordering, and
// replay after reconnect. Mirrored in cuedeck-checkin.html.
// Both are replayed in scanned_at order and the server applies them
// sequentially, so a checkin followed by an undo nets out correctly
// without any client-side collapsing.
import { describe, it, expect } from 'vitest';

type Pending = {
  client_id: string; attendee_id: string;
  // scanned_at MUST be canonical UTC ISO-8601 from Date#toISOString()
  // (always 'Z', fixed width). Ordering compares these as strings, so a
  // mixed offset like +02:00 would sort wrong.
  scanned_at: string;
  action: 'checkin' | 'undo'; synced: boolean;
};

function enqueue(outbox: Pending[], item: Omit<Pending, 'synced'>): Pending[] {
  if (outbox.some(p => p.client_id === item.client_id)) return outbox;
  return [...outbox, { ...item, synced: false }];
}

function pendingCount(outbox: Pending[]): number {
  return outbox.filter(p => !p.synced).length;
}

function replayOrder(outbox: Pending[]): Pending[] {
  return outbox
    .filter(p => !p.synced)
    .slice()
    .sort((a, b) => (a.scanned_at < b.scanned_at ? -1 : a.scanned_at > b.scanned_at ? 1 : 0));
}

function markSynced(outbox: Pending[], ids: string[]): Pending[] {
  const s = new Set(ids);
  return outbox.map(p => (s.has(p.client_id) ? { ...p, synced: true } : p));
}

const mk = (o: Partial<Pending> & { client_id: string }): Pending => ({
  attendee_id: 'a1', scanned_at: '2026-08-03T09:00:00Z',
  action: 'checkin', synced: false, ...o,
});

describe('checkin-outbox', () => {
  it('ignores a re-enqueued client_id so a double tap queues once', () => {
    let ob: Pending[] = [];
    ob = enqueue(ob, mk({ client_id: 'c1' }));
    ob = enqueue(ob, mk({ client_id: 'c1' }));
    expect(ob).toHaveLength(1);
  });

  it('counts only unsynced items', () => {
    const ob = [mk({ client_id: 'c1', synced: true }), mk({ client_id: 'c2' })];
    expect(pendingCount(ob)).toBe(1);
  });

  it('replays in scanned_at order, not insertion order', () => {
    const ob = [
      mk({ client_id: 'late', scanned_at: '2026-08-03T09:05:00Z' }),
      mk({ client_id: 'early', scanned_at: '2026-08-03T09:01:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['early', 'late']);
  });

  it('survives a partial sync — unsynced items remain queued', () => {
    let ob = [mk({ client_id: 'c1' }), mk({ client_id: 'c2' })];
    ob = markSynced(ob, ['c1']);
    expect(pendingCount(ob)).toBe(1);
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['c2']);
  });

  it('orders across different attendees, not just one', () => {
    const ob = [
      mk({ client_id: 'b', attendee_id: 'a2', scanned_at: '2026-08-03T09:05:00Z' }),
      mk({ client_id: 'a', attendee_id: 'a1', scanned_at: '2026-08-03T09:01:00Z' }),
      mk({ client_id: 'c', attendee_id: 'a3', scanned_at: '2026-08-03T09:09:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.client_id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a checkin and its later undo in order for replay', () => {
    const ob = [
      mk({ client_id: 'c2', action: 'undo', scanned_at: '2026-08-03T09:01:00Z' }),
      mk({ client_id: 'c1', action: 'checkin', scanned_at: '2026-08-03T09:00:00Z' }),
    ];
    expect(replayOrder(ob).map(p => p.action)).toEqual(['checkin', 'undo']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-outbox.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/checkin-outbox.spec.ts
git commit -m "test(checkin): offline outbox queue, ordering, and replay"
```

---

### Task 4: `checkin-record-scans` Edge Function

**Files:**
- Create: `supabase/functions/checkin-record-scans/index.ts`
- Modify: `scripts/deploy-functions.sh` (the `ALL_FUNCTIONS` array)

- [ ] **Step 1: Write the function**

The implemented function lives at `supabase/functions/checkin-record-scans/index.ts`.
It was rewritten during implementation after review found six defects in the original
draft in this plan. Read the file rather than any code that was here — it is the
source of truth. What it does:

- **CORS:** `const cors = corsHeaders(req)` — `corsHeaders` is a FUNCTION in this repo,
  not an object. Spreading it directly yields `{}` and silently strips every CORS header.
  `curl` and the deploy ping do not catch this because they send no `Origin`.
- **Auth:** JWT → `getUser` → 401; operator grant read from `leod_checkin_operators`
  (not `checkin_role_for_event`, which is SECURITY DEFINER over `auth.uid()` and returns
  NULL on a service-role connection) → 403; explicit `checkin_core` re-check → 403.
- **`operator_id` comes from the JWT**, never the request body, or attribution is forgeable.
- **Undo is a compare-and-set** on `prev_checked_in_at`. A stale undo queued offline must
  not clear a newer check-in made at another desk; on a 0-row match it records `duplicate`
  and changes nothing.
- **Errors are never swallowed.** Both updates and the insert check `error`; failures
  surface as `results[client_id] = 'error'` plus an `errors[]` array in the response.
  A failed update must never be reported as `'duplicate'`.
- **`unknown_token` and `wrong_event` are recorded**, both with `attendee_id: null` —
  the migration 049 trigger rejects a mismatched attendee/event pair.
- **Batch capped at 200** items; the client must chunk. Uncapped batches livelock a desk
  that was offline for hours.
- **Batch sorted by `scanned_at` server-side** — the server does not trust client ordering.

The `.is("checked_in_at", null)` guard on the update — not the earlier read — is what makes first-wins atomic. Two desks syncing simultaneously cannot both succeed.

- [ ] **Step 2: Register it in the deployer**

In `scripts/deploy-functions.sh`, append `checkin-record-scans` to the `ALL_FUNCTIONS` array (it currently ends with `checkin-send-qr-emails`).

- [ ] **Step 3: Deploy**

```bash
bash scripts/deploy-functions.sh checkin-record-scans
```

- [ ] **Step 4: Verify live**

```bash
curl -s -X POST \
  "https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-record-scans" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{"_ping":true}'
```

Expected: `{"pong":true}`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/checkin-record-scans/index.ts scripts/deploy-functions.sh
git commit -m "feat(checkin): checkin-record-scans batch ingest with first-scan-wins"
```

---

### Task 5: Page skeleton — auth, event picker, roster cache

**Files:**
- Create: `cuedeck-checkin.html`

- [ ] **Step 1: Create the page shell**

Copy the `<head>`, Supabase CDN script tag, and auth bootstrap from `cuedeck-display.html` so client setup matches the repo. Add the light design tokens from the approved mockup:

```css
:root {
  --pg:#F5F5F7; --sf:#FFFFFF; --wm:#FBFBFD;
  --t1:#1D1D1F; --t2:#6E6E73; --t3:#A1A1A6;
  --bd:#E8E8ED; --bd2:#D2D2D7;
  --ac:#0071E3; --acsf:#EAF3FE;
  --gn:#1D8348; --gnsf:#E8F6EE; --gnbd:#B7E4C9;
  --am:#9A5B00; --amsf:#FEF6E7; --ambd:#F5D9A8;
  --radius:16px; --radius-lg:22px;
  --shadow:0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
}
```

- [ ] **Step 2: Add the IndexedDB helpers**

```js
const DB_NAME = 'cuedeck-checkin';
const STORE_ROSTER = 'roster';
const STORE_OUTBOX = 'outbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ROSTER)) db.createObjectStore(STORE_ROSTER, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: 'client_id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutAll(store, rows) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    rows.forEach(r => tx.objectStore(store).put(r));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 3: Load the roster with a cache fallback**

```js
async function loadRoster(eventId) {
  const { data, error } = await sb
    .from('leod_checkin_attendees')
    .select('id,event_id,first_name,last_name,email,company,ticket_type,qr_token,checked_in_at,badge_printed_at')
    .eq('event_id', eventId);
  if (error) { S.roster = await idbGetAll(STORE_ROSTER); return; }
  S.roster = data;
  await idbPutAll(STORE_ROSTER, data);
}
```

The `error` branch is deliberate: if the fetch fails the station falls back to the cached copy rather than showing an empty desk.

- [ ] **Step 4: Verify locally**

```bash
python3 -m http.server 7230
```

Open `http://127.0.0.1:7230/cuedeck-checkin.html`, sign in, pick an event. In DevTools → Application → IndexedDB, confirm `cuedeck-checkin › roster` is populated.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): station page shell with auth and IndexedDB roster cache"
```

---

### Task 6: Desk UI — search field, party card, primary action

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Build the always-focused input**

```js
const scanInput = document.getElementById('scan');
function holdFocus() { if (document.activeElement !== scanInput) scanInput.focus(); }
document.addEventListener('click', holdFocus);
setInterval(holdFocus, 400);

scanInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const raw = scanInput.value;
  scanInput.value = '';
  handleScan(raw);
});

scanInput.addEventListener('input', () => {
  const q = scanInput.value;
  if (q.length >= 2) renderSearchResults(searchByName(q, S.roster));
});
```

A USB scanner types the token then sends Enter, so Enter is the scan path and typing is the search path. One field serves both, as the spec requires.

- [ ] **Step 2: Render a party row with safe DOM**

Attendee text is user-supplied. Build nodes, never markup strings:

```js
function partyRow(attendee, ticked, onToggle) {
  const row = document.createElement('div');
  row.className = 'prow';

  const tick = document.createElement('button');
  tick.className = attendee.checked_in_at ? 'tick done' : (ticked ? 'tick on' : 'tick');
  tick.textContent = (attendee.checked_in_at || ticked) ? '✓' : '';
  tick.disabled = !!attendee.checked_in_at;
  tick.addEventListener('click', () => onToggle(attendee));
  row.appendChild(tick);

  const who = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'pn';
  name.textContent = `${attendee.first_name} ${attendee.last_name}`;
  const meta = document.createElement('div');
  meta.className = 'pm';
  meta.textContent = attendee.ticket_type;
  who.append(name, meta);
  row.appendChild(who);

  const status = document.createElement('span');
  status.className = attendee.checked_in_at ? 'pill-in' : 'pill-un';
  status.textContent = attendee.checked_in_at
    ? `arrived ${new Date(attendee.checked_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'not here yet';
  row.appendChild(status);

  return row;
}
```

`textContent` cannot execute markup, so a name like `<img onerror=...>` renders as literal text. Use `container.replaceChildren(...rows)` to swap the list, never `innerHTML`.

- [ ] **Step 3: Render the primary action**

`handleScan()` calls `resolveToken()`, then `assembleParty(attendee, S.roster)`. The anchor is pre-ticked, colleagues unticked, already-arrived rows disabled. The button label is computed from tick state:

```js
function renderPrimary(count) {
  const btn = document.getElementById('primary');
  btn.textContent = count === 1
    ? 'Check in 1 · Print 1 badge'
    : `Check in ${count} · Print ${count} badges`;
  btn.disabled = count === 0;
}
```

The secondary `Check in only` button calls the same handler with `{ print: false }`.

- [ ] **Step 4: Verify locally**

```bash
node scripts/seed-checkin-test-event.mjs
```

Type `Kowalska`. Expected: Anna appears with her Acme colleagues beneath, only Anna ticked, button reading `Check in 1 · Print 1 badge`.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): desk search field, party card, and primary action"
```

---

### Task 7: Offline outbox and sync

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Queue actions locally first**

```js
async function commitParty(attendees, opts) {
  const now = new Date().toISOString();
  for (const a of attendees) {
    const item = {
      client_id: crypto.randomUUID(),
      attendee_id: a.id,
      scanned_at: now,
      action: 'checkin',
      synced: false,
    };
    await idbPutAll(STORE_OUTBOX, [item]);
    a.checked_in_at = now;                 // optimistic local state
    await idbPutAll(STORE_ROSTER, [a]);
  }
  renderPendingCount();
  if (opts.print) await printBadges(attendees);
  flushOutbox();
}
```

The local roster updates optimistically, so a second scan of the same person shows `duplicate` immediately, even offline.

- [ ] **Step 2: Flush on reconnect**

```js
let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const all = await idbGetAll(STORE_OUTBOX);
    const pending = all.filter(p => !p.synced)
                       .sort((a, b) => (a.scanned_at < b.scanned_at ? -1
                                      : a.scanned_at > b.scanned_at ? 1 : 0));
    if (!pending.length) return;
    const { data, error } = await sb.functions.invoke('checkin-record-scans', {
      body: {
        event_id: S.eventId,
        operator_id: S.userId,
        scan_point_id: S.scanPointId ?? null,
        items: pending.map(({ client_id, attendee_id, scanned_at, action }) =>
          ({ client_id, attendee_id, scanned_at, action })),
      },
    });
    if (error) return;
    const done = pending
      .filter(p => data.results[p.client_id])
      .map(p => ({ ...p, synced: true }));
    await idbPutAll(STORE_OUTBOX, done);
    renderPendingCount();
  } finally {
    flushing = false;
  }
}

window.addEventListener('online', flushOutbox);
setInterval(flushOutbox, 15000);
```

**Three contract requirements from the Edge Function — the flush fails without them:**

1. **Chunk at 200 items.** The server rejects a larger batch with a 400. Slice `pending`
   into chunks of 200 and invoke once per chunk, or a desk offline through a keynote
   livelocks: the oversized batch is rejected every time and never drains.
2. **Send `prev_checked_in_at` on every undo** (see Task 8). The server needs it for the
   compare-and-set; an undo without it is a validation error.
3. **Read `errors[]`, not just `results`.** A value of `'error'` in `results` is a
   FAILURE, not a scan verdict — do not mark those items synced, or the action is lost.
   Only mark synced the client_ids whose result is a real verdict.

The `flushing` guard prevents the interval and the `online` event from double-sending the same batch.

- [ ] **Step 3: Verify offline behaviour**

In DevTools → Network, set Offline. Check someone in. Expected: green verdict immediately, header pill shows `1 waiting to sync`. Set back to Online. Expected: within 15 seconds the pill clears and a `leod_checkin_scan_events` row exists with `result = 'ok'`.

- [ ] **Step 4: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): offline outbox with reconnect flush and pending indicator"
```

---

### Task 8: Undo

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Add the undo handler**

```js
async function undoCheckin(attendee) {
  const item = {
    client_id: crypto.randomUUID(),
    attendee_id: attendee.id,
    scanned_at: new Date().toISOString(),
    action: 'undo',
    synced: false,
  };
  await idbPutAll(STORE_OUTBOX, [item]);
  attendee.checked_in_at = null;
  await idbPutAll(STORE_ROSTER, [attendee]);
  renderPendingCount();
  flushOutbox();
}
```

- [ ] **Step 2: Surface undo in two places**

On the verdict panel immediately after a check-in, and on every arrived row in the party card. Per the spec, undo reaches anyone checked in today via search, so any arrived attendee found by name also shows the control. Build the button with `createElement` and `textContent`, as in Task 6.

- [ ] **Step 3: Verify live**

Check someone in, press Undo, then query:

```sql
SELECT result, operator_id, scanned_at
  FROM leod_checkin_scan_events
 WHERE attendee_id = '<id>' ORDER BY scanned_at;
```

Expected: two rows — `ok` then `undo`, the second carrying your `operator_id`. The attendee's `checked_in_at` is back to NULL.

- [ ] **Step 4: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): undo a check-in, recorded as a new scan event"
```

---

### Task 9: Name correction before printing

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Add the inline edit**

`Fix a name` swaps the party row into two text inputs with Save and Cancel:

```js
async function saveName(attendee, firstName, lastName) {
  const first = firstName.trim(), last = lastName.trim();
  if (!first || !last) return { ok: false, error: 'Both names are required' };
  const { error } = await sb
    .from('leod_checkin_attendees')
    .update({ first_name: first, last_name: last })
    .eq('id', attendee.id);
  if (error) return { ok: false, error: error.message };
  attendee.first_name = first;
  attendee.last_name = last;
  await idbPutAll(STORE_ROSTER, [attendee]);
  return { ok: true };
}
```

This path requires connectivity. A name change is deliberately not queued offline: printing a badge from an unsynced edit would produce a badge that disagrees with the database. When offline, disable the control and show `Reconnect to fix a name`.

- [ ] **Step 2: Verify**

Edit a name, reload the page, confirm it persisted. Print a badge and confirm the corrected name appears.

- [ ] **Step 3: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): correct an attendee name before badge printing"
```

---

### Task 10: Badge printing

**Files:**
- Modify: `cuedeck-checkin.html`
- Create: `docs/checkin-desk-runbook.md`

- [ ] **Step 1: Add the badge print CSS**

```css
#badge-sheet { display: none; }

@media print {
  body > *:not(#badge-sheet) { display: none !important; }
  #badge-sheet { display: block !important; }
  @page { size: 100mm 70mm; margin: 0; }
  .badge {
    width: 100mm; height: 70mm; page-break-after: always;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center;
    font-family: -apple-system, system-ui;
  }
  .badge .nm { font-size: 30pt; font-weight: 700; letter-spacing: -0.5pt; }
  .badge .co { font-size: 13pt; margin-top: 3mm; }
  .badge .tt { font-size: 10pt; text-transform: uppercase; letter-spacing: 1pt; margin-top: 2mm; }
}
```

Change `size: 100mm 70mm` to match the venue's badge stock.

- [ ] **Step 2: Build badges with safe DOM**

Attendee names come from a kiosk a stranger typed into. Build elements and set `textContent`; never assign `innerHTML`:

```js
function badgeNode(attendee) {
  const badge = document.createElement('div');
  badge.className = 'badge';

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = `${attendee.first_name} ${attendee.last_name}`;

  const co = document.createElement('div');
  co.className = 'co';
  co.textContent = attendee.company ?? '';

  const tt = document.createElement('div');
  tt.className = 'tt';
  tt.textContent = attendee.ticket_type;

  badge.append(nm, co, tt);
  return badge;
}

async function printBadges(attendees) {
  const sheet = document.getElementById('badge-sheet');
  sheet.replaceChildren(...attendees.map(badgeNode));
  window.print();
  const now = new Date().toISOString();
  for (const a of attendees) {
    a.badge_printed_at = now;
    await idbPutAll(STORE_ROSTER, [a]);
    sb.from('leod_checkin_attendees')
      .update({ badge_printed_at: now }).eq('id', a.id);
  }
}
```

`replaceChildren` clears and repopulates in one call without parsing markup.

- [ ] **Step 3: Write the runbook**

Create `docs/checkin-desk-runbook.md` covering the launch command, the default-printer requirement, and the driver-prompt caveats from the spec:

```
chrome --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"
```

- [ ] **Step 4: Verify with the real printer**

Launch Chrome with those flags and check someone in with printing on. Expected: a badge prints with no dialog. Test against the actual badge printer before an event — driver prompts for tray or paper size break silent printing, and that is a printer configuration problem, not an application one.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html docs/checkin-desk-runbook.md
git commit -m "feat(checkin): direct badge printing via kiosk-printing, plus runbook"
```

---

### Task 11: Kiosk validation logic

**Files:**
- Test: `tests/checkin-kiosk.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/checkin-kiosk.spec.ts
// Self-registration kiosk: field validation and the already-registered
// collision path. Mirrored in cuedeck-checkin.html.
import { describe, it, expect } from 'vitest';

type KioskForm = {
  first_name: string; last_name: string;
  company: string; email: string; consent: boolean;
};

function validateKiosk(f: KioskForm, emailRequired: boolean): string[] {
  const errors: string[] = [];
  if (!f.first_name.trim()) errors.push('first_name');
  if (!f.last_name.trim()) errors.push('last_name');
  if (!f.consent) errors.push('consent');
  if (emailRequired && !f.email.trim()) errors.push('email');
  if (f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) errors.push('email_format');
  return errors;
}

function isDuplicateEmail(err: { code?: string; message?: string }): boolean {
  return err.code === '23505' || /duplicate key|unique constraint/i.test(err.message ?? '');
}

function shortCode(token: string): string {
  return token.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4);
}

const base: KioskForm = {
  first_name: 'Ewa', last_name: 'Mazur', company: '', email: '', consent: true,
};

describe('kiosk: validateKiosk', () => {
  it('accepts the minimum — both names plus consent', () => {
    expect(validateKiosk(base, false)).toEqual([]);
  });

  it('rejects a missing surname', () => {
    expect(validateKiosk({ ...base, last_name: '  ' }, false)).toContain('last_name');
  });

  it('always requires consent — GDPR, never pre-checked', () => {
    expect(validateKiosk({ ...base, consent: false }, false)).toContain('consent');
  });

  it('requires email only when email delivery is on', () => {
    expect(validateKiosk(base, false)).not.toContain('email');
    expect(validateKiosk(base, true)).toContain('email');
  });

  it('rejects a malformed email even when optional', () => {
    expect(validateKiosk({ ...base, email: 'not-an-email' }, false)).toContain('email_format');
  });
});

describe('kiosk: already-registered detection', () => {
  it('recognises the unique-index violation from migration 050', () => {
    expect(isDuplicateEmail({ code: '23505' })).toBe(true);
    expect(isDuplicateEmail({ message: 'duplicate key value violates unique constraint' })).toBe(true);
  });

  it('does not mistake an unrelated error for a duplicate', () => {
    expect(isDuplicateEmail({ code: '42501', message: 'permission denied' })).toBe(false);
  });
});

describe('kiosk: shortCode', () => {
  it('takes four alphanumeric characters, uppercased', () => {
    expect(shortCode('b4k2-xyz')).toBe('B4K2');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/checkin-kiosk.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/checkin-kiosk.spec.ts
git commit -m "test(checkin): kiosk validation and already-registered detection"
```

---

### Task 12: Kiosk mode UI

**Files:**
- Modify: `cuedeck-checkin.html`

- [ ] **Step 1: Gate kiosk mode on the entitlement**

Kiosk mode activates via `?mode=kiosk`, and only when `self_registration` is true:

```js
const { data: ent } = await sb
  .from('leod_checkin_entitlements')
  .select('self_registration, kiosk_self_print')
  .eq('event_id', S.eventId).maybeSingle();
S.kioskAllowed = !!ent?.self_registration;
S.kioskSelfPrint = !!ent?.kiosk_self_print;
```

If `?mode=kiosk` is set but `self_registration` is false, show `Self-registration is not enabled for this event` and stop.

- [ ] **Step 2: Build the three screens**

Screen 1 — two buttons: `I didn't register` and `I can't find my email`. The second runs a name search and, on a match, shows that person's existing code instead of creating a record.

Screen 2 — four fields (first name, last name, company, email) at `font-size: 17px` minimum so iOS does not zoom on focus.

Screen 3 — the GDPR consent tick (never pre-checked) with a privacy notice link, then the result panel showing the four-character code via `textContent`.

- [ ] **Step 3: Call the Edge Function — never insert directly**

The kiosk gets NO direct table access and NO anon RLS policy. See the spec's
"Kiosk authentication" section for why: an anon SELECT would leak the roster to anyone
holding the publishable key, and an anon write path would silently disable migration
054's column guard.

```js
async function kioskRegister(form) {
  const { data, error } = await sb.functions.invoke('checkin-self-register', {
    body: {
      event_id: S.event.id,
      device_key: S.kioskDeviceKey,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      company: form.company.trim() || null,
      email: form.email.trim() || null,
      consent: form.consent === true,
    },
  });
  if (error) return { error: 'Something went wrong. Please see the desk.' };
  return data;   // { status: 'registered', code } | { status: 'already_registered' }
}
```

The function returns ONE of two shapes and nothing more:

- `{ status: 'registered', code: 'B4K2' }` — a genuinely new attendee
- `{ status: 'already_registered' }` — **no name, no code, no attendee id**

On `already_registered` the screen says only: *"You're already registered — we've emailed
your code to the address on file."* The server fires `checkin-send-qr-emails` to the
STORED address, so the code reaches the real owner rather than whoever is standing at the
screen. Returning the code here would make the kiosk an email-enumeration oracle: anyone
knowing a speaker's public address could obtain their QR and check in as them.

Do not add a "was that you?" affordance, a retry hint, or differing response timing
between the two branches. Any of those re-opens the oracle.

- [ ] **Step 4: Verify**

Enable `self_registration` for the seeded test event, open `?mode=kiosk`, register a walk-up. Expected: code on screen, QR email received, attendee row created. Register again with the same email. Expected: the already-registered panel showing the original code, and no second row.

- [ ] **Step 5: Commit**

```bash
git add cuedeck-checkin.html
git commit -m "feat(checkin): self-registration kiosk mode with GDPR consent"
```

---

### Task 13: End-to-end test

**Files:**
- Create: `tests/e2e/checkin-desk.spec.ts`

- [ ] **Step 1: Write the e2e test**

```ts
// tests/e2e/checkin-desk.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.CHECKIN_BASE ?? 'http://127.0.0.1:7230';

test('scanning a token checks the attendee in and offers undo', async ({ page }) => {
  await page.goto(`${BASE}/cuedeck-checkin.html`);
  await page.getByLabel('Email').fill(process.env.TEST_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.getByRole('button', { name: /AVE Summit/i }).click();

  const scan = page.locator('#scan');
  await expect(scan).toBeFocused();
  await scan.fill('SEED-TOKEN-001');
  await scan.press('Enter');

  await expect(page.getByText(/Anna Kowalska/)).toBeVisible();
  await page.getByRole('button', { name: /^Check in/ }).click();
  await expect(page.getByRole('button', { name: /Undo/ })).toBeVisible();
});

test('an unknown code tells staff what to do next', async ({ page }) => {
  await page.goto(`${BASE}/cuedeck-checkin.html`);
  const scan = page.locator('#scan');
  await scan.fill('NOT-A-REAL-TOKEN');
  await scan.press('Enter');
  await expect(page.getByText(/isn't for this event/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /search their name/i })).toBeVisible();
});

test('an attendee name containing markup renders as text, not HTML', async ({ page }) => {
  await page.goto(`${BASE}/cuedeck-checkin.html?mode=kiosk`);
  await page.getByRole('button', { name: /didn't register/i }).click();
  await page.getByLabel('First name').fill('<img src=x onerror=window.__xss=1>');
  await page.getByLabel('Last name').fill('Tester');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /continue|done/i }).click();
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});
```

- [ ] **Step 2: Run it**

```bash
python3 -m http.server 7230 &
npx playwright test tests/e2e/checkin-desk.spec.ts
```

Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/checkin-desk.spec.ts
git commit -m "test(checkin): e2e desk scan, unknown code, and XSS-safe rendering"
```

---

### Task 14: Full suite and live verification

- [ ] **Step 1: Run everything**

```bash
npm run test:all
```

Expected: all vitest specs pass (135 existing + 22 new), Playwright suite passes.

- [ ] **Step 2: Verify the console still works**

```bash
bash scripts/verify-cuedeck.sh 7230
```

Expected: no failures. The new page must not have broken anything shared.

- [ ] **Step 3: Live-verify per CLAUDE.md**

Open the deployed check-in page in Chrome, check someone in, screenshot the result, confirm no console errors. `CLAUDE.md` requires evidence, not a visual glance.

- [ ] **Step 4: Commit any fixes and push**

```bash
git add -A
git commit -m "chore(checkin): fixes from full-suite verification"
git push origin main
```

---

## Self-Review

**Spec coverage:** desk UI → Tasks 5–7; arrival/party model → Task 6; offline → Tasks 3, 7; duplicates first-wins → Tasks 2, 4; undo → Tasks 1, 8; name correction → Task 9; badge printing → Task 10; kiosk → Tasks 11, 12; per-event flags → Tasks 1, 12; GDPR consent → Tasks 11, 12; testing → Tasks 2, 3, 11, 13, 14. No spec section is unimplemented.

**Type consistency:** `Attendee`, `ScanResult`, `Pending`, and `KioskForm` are defined once and used identically throughout. Function names (`resolveToken`, `searchByName`, `assembleParty`, `enqueue`, `replayOrder`, `markSynced`, `validateKiosk`, `isDuplicateEmail`, `shortCode`, `printBadges`, `flushOutbox`, `commitParty`, `undoCheckin`, `saveName`) are stable across tasks.

**Security:** every DOM path that renders attendee-supplied text uses `createElement` + `textContent` + `replaceChildren`. No `innerHTML` anywhere in the plan. Task 13 includes an e2e test asserting a name containing markup does not execute.

**Known gap, deliberate:** `scan_point_id` is threaded through `checkin-record-scans` but the desk does not yet let staff choose a scan point — the seeded event has exactly one. Multi-point selection belongs with the door scanner spec.
