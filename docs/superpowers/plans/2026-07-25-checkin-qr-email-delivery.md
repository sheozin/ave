# Check-in QR/Email Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver each attendee's `qr_token` by email — automatically on import (if the event's organizer opts in) and via a manual/resend Edge Function — using an event-branded template with a quiet CueDeck footer credit.

**Architecture:** A new shared module (`_shared/qr-email.ts`) holds the actual "generate QR + render email + send + record result" logic, imported by both the existing `checkin-import-attendees` (auto-send path) and a new `checkin-send-qr-emails` (manual/resend path) — mirroring how `_shared/resend.ts` is already shared across functions. Two new columns (`qr_email_sent_at`, `auto_send_qr_email`) track send state and the per-event opt-in.

**Tech Stack:** Deno Edge Functions (TypeScript), `qrcode-generator` (zero-dependency, pure-JS QR encoder, works in Deno without a Canvas polyfill) via esm.sh, existing Resend integration (`_shared/resend.ts`), vitest for pure-logic tests.

---

## Before you start

- Working directory for every path below: `/Users/sheriff/Downloads/AVE Production Console`
- This plan builds on the check-in module's Phase 1a (migrations 044-051, live on production project `sawekpguemzvuvvulfbc`). `checkin-import-attendees`, `checkin-enable-event`, and the schema referenced here already exist — read the actual current files before editing, don't assume this plan's quoted excerpts are still byte-exact by the time you implement (they were read directly from the repo when this plan was written, but always re-read before editing).
- Design spec: `docs/superpowers/specs/2026-07-25-checkin-qr-email-delivery-design.md`.
- Follow the Live Verification Protocol (`CLAUDE.md`): every migration/function change gets applied/deployed and verified live before being called done, same rigor as Phase 1a's 11-task plan (every single task in that plan found at least one real bug by actually running things).

---

### Task 1: Migration — send-tracking and auto-send columns

**Files:**
- Create: `supabase/migrations/052_checkin_qr_email_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- CueDeck — Migration 052: Check-in module — QR email columns
-- ============================================================
-- Two columns supporting QR/email delivery (see
-- docs/superpowers/specs/2026-07-25-checkin-qr-email-delivery-design.md):
--
-- qr_email_sent_at: tracks whether/when an attendee's QR email went
-- out. Used to target "never sent" attendees by default, avoid
-- double-sending, and (later) show send status in an admin UI.
--
-- auto_send_qr_email: per-event opt-in for automatic sending on
-- import. Defaults FALSE, not TRUE — the failure modes aren't
-- symmetric. An organizer who forgot to enable it just flips a switch
-- or calls the manual send endpoint (search-by-name still works
-- on-site regardless). An organizer who already runs registration
-- elsewhere and gets a surprise duplicate email sent to their
-- attendees the moment they import a CSV is a real trust problem.
-- No RLS policy changes needed — both columns live on tables already
-- covered by existing policies (leod_checkin_attendees,
-- leod_checkin_entitlements), and entitlements still has no
-- client-writable policy at all (unchanged from migration 051).
-- ============================================================

ALTER TABLE leod_checkin_attendees
  ADD COLUMN IF NOT EXISTS qr_email_sent_at TIMESTAMPTZ;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS auto_send_qr_email BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Apply it**

```bash
/opt/homebrew/bin/supabase link --project-ref sawekpguemzvuvvulfbc
/opt/homebrew/bin/supabase db push --include-all
```

(`--include-all` is required in this repo due to pre-existing timestamp-named migrations sorting after the numeric ones — a known, harmless quirk, not something to investigate.)

- [ ] **Step 3: Verify live**

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'leod_checkin_attendees' AND column_name = 'qr_email_sent_at';
-- expected: one row, data_type = 'timestamp with time zone', column_default NULL

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'leod_checkin_entitlements' AND column_name = 'auto_send_qr_email';
-- expected: one row, data_type = 'boolean', column_default = 'false'
```

Also confirm no existing entitlements rows were broken by the new `NOT NULL DEFAULT false` column:

```sql
SELECT count(*) FROM leod_checkin_entitlements WHERE auto_send_qr_email IS NULL;
-- expected: 0
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/052_checkin_qr_email_columns.sql
git commit -m "feat(checkin): add qr_email_sent_at and auto_send_qr_email columns"
```

---

### Task 2: Let `sendEmail()` accept a per-call sender override

**Files:**
- Modify: `supabase/functions/_shared/resend.ts:18-27`

**Why:** `sendEmail()` currently reads `fromName`/`fromEmail` only from the `FROM_NAME`/`FROM_EMAIL` env vars — there's no way to pass a per-call override. The QR email design requires the from name to be `"{event.name} Check-in"`, which is per-event, not a global env var. This is the smallest possible change: two new optional fields on `EmailPayload`, falling back to the exact same env-var behavior when omitted, so every existing caller (`checkin-enable-event`, the founder welcome sequence, etc.) is unaffected.

- [ ] **Step 1: Read the current file to confirm nothing has changed underneath this plan**

```bash
cat "supabase/functions/_shared/resend.ts"
```

Confirm `sendEmail()` still looks like the version below (env-var-only from address) before editing — if it's drifted, adapt the diff accordingly rather than blindly pasting over it.

- [ ] **Step 2: Add the override fields and use them**

In `supabase/functions/_shared/resend.ts`, change:

```typescript
export interface EmailPayload {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  tags?: { name: string; value: string }[]
}
```

to:

```typescript
export interface EmailPayload {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  tags?: { name: string; value: string }[]
  fromName?: string
  fromEmail?: string
}
```

And change the body of `sendEmail()`:

```typescript
export async function sendEmail(payload: EmailPayload): Promise<ResendResponse> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set')
    return { error: 'Email service not configured' }
  }

  const fromEmail = payload.fromEmail || Deno.env.get('FROM_EMAIL') || 'sheriff@cuedeck.io'
  const fromName = payload.fromName || Deno.env.get('FROM_NAME') || 'Sheriff from CueDeck'
```

(Only these two `const` lines change — the rest of the function, including the `fetch()` call below them, is untouched.)

- [ ] **Step 3: Verify no regression**

```bash
grep -n "sendEmail(" supabase/functions/*/index.ts
```

Confirm every existing call site (e.g. `checkin-enable-event`, if it sends email — check the actual grep output; if no other function currently calls `sendEmail` besides what this plan adds, that's fine too) passes a payload object literal, not a positional-args call, so adding two optional fields to the interface can't break any of them.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/resend.ts
git commit -m "feat(checkin): let sendEmail accept a per-call from name/address override"
```

---

### Task 3: `_shared/qr-email.ts` — QR generation, email template, send logic

**Files:**
- Create: `supabase/functions/_shared/qr-email.ts`

- [ ] **Step 1: Confirm the QR library's actual API before writing integration code**

`qrcode-generator` is a zero-dependency, pure-JS QR encoder (no Canvas/DOM required, which is why it works in Deno) — but library APIs drift between versions, so confirm the exact shape before relying on it:

```bash
curl -s https://esm.sh/qrcode-generator@1.4.4 | head -50
```

Confirm the module exports a default function with signature `qrcode(typeNumber: number, errorCorrectionLevel: string)` returning an object with `.addData(text)`, `.make()`, and a data-URL-producing method (commonly `.createDataURL(cellSize?, margin?)` returning `data:image/gif;base64,...`). If the actual exported API differs from this, adapt Step 2 below to match what you actually find — don't guess silently, and don't skip this check.

- [ ] **Step 2: Write the shared module**

```typescript
// supabase/functions/_shared/qr-email.ts
// Shared "generate QR + render email + send + record result" logic for
// check-in QR delivery, used by both checkin-import-attendees's
// auto-send path and checkin-send-qr-emails's manual/resend path.
//
// A QR code is a check-in TOKEN, not a badge — the attendee still
// gets verified and their badge printed on-site. Copy is deliberately
// phrased as a verification step, not a skip-the-line pass.

import qrcode from 'https://esm.sh/qrcode-generator@1.4.4'
import { sendEmail } from './resend.ts'

export interface QrEmailAttendee {
  id: string
  first_name: string
  email: string | null
  qr_token: string
}

export interface QrEmailEvent {
  name: string
  date: string        // ISO date, e.g. '2026-09-15'
  venue: string | null
}

export interface QrEmailResult {
  attendee_id: string
  status: 'sent' | 'skipped_no_email' | 'error'
  error?: string
}

function formatEventDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function generateQrDataUrl(token: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(token)
  qr.make()
  return qr.createDataURL()
}

// event.name/venue are organizer-controlled; attendee.first_name comes
// from CSV import, which can carry adversarial input from an external
// registration list. Escape before interpolating into HTML.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderQrEmailHtml(event: QrEmailEvent, attendee: QrEmailAttendee, qrDataUrl: string): string {
  const safeName = escapeHtml(event.name)
  const safeFirstName = escapeHtml(attendee.first_name)
  const venueLine = event.venue ? ` &middot; ${escapeHtml(event.venue)}` : ''
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
      <div style="background:#fff;padding:28px 24px;text-align:center;border-bottom:1px solid #eee;">
        <div style="font-size:22px;font-weight:700;color:#1a1a2e;">${safeName}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:6px;">${formatEventDate(event.date)}${venueLine}</div>
      </div>
      <div style="padding:28px 24px;color:#374151;">
        <p style="margin:0 0 8px;font-size:15px;">Hi ${safeFirstName},</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Show this QR code at the entrance to check in — no need to print anything, your phone screen works fine.</p>
        <div style="text-align:center;margin:0 0 20px;">
          <img src="${qrDataUrl}" width="160" height="160" alt="Your check-in QR code" style="display:inline-block;border:1px solid #e5e7eb;border-radius:8px;padding:8px;">
        </div>
        <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Lost this email? Just show your name at the entrance instead.</p>
      </div>
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">Check-in powered by</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>
    </div>
  </div>
</body>
</html>`
}

// Sends (or skips, or records a failure for) each attendee in the
// list. Does NOT query the database for which attendees to target —
// callers decide that (see checkin-send-qr-emails and
// checkin-import-attendees's auto-send integration) and pass the
// already-fetched rows in.
export async function sendQrEmailsForAttendees(
  sb: ReturnType<typeof import('./client.ts').adminClient>,
  event: QrEmailEvent,
  attendees: QrEmailAttendee[],
): Promise<QrEmailResult[]> {
  const results: QrEmailResult[] = []

  for (const attendee of attendees) {
    if (!attendee.email) {
      results.push({ attendee_id: attendee.id, status: 'skipped_no_email' })
      continue
    }

    const qrDataUrl = generateQrDataUrl(attendee.qr_token)
    const html = renderQrEmailHtml(event, attendee, qrDataUrl)

    const { error } = await sendEmail({
      to: attendee.email,
      subject: `Your check-in QR code — ${event.name}`,
      html,
      fromName: `${event.name} Check-in`,
    })

    if (error) {
      results.push({ attendee_id: attendee.id, status: 'error', error })
      continue
    }

    const { error: updateErr } = await sb.from('leod_checkin_attendees')
      .update({ qr_email_sent_at: new Date().toISOString() })
      .eq('id', attendee.id)
    if (updateErr) {
      // Email genuinely sent — record it as sent even though the
      // sent_at bookkeeping failed, so callers don't double-send. Log
      // for visibility rather than silently losing the discrepancy.
      console.error('sendQrEmailsForAttendees: qr_email_sent_at update failed for', attendee.id, updateErr.message)
    }
    results.push({ attendee_id: attendee.id, status: 'sent' })
  }

  return results
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/qr-email.ts
git commit -m "feat(checkin): add shared QR generation and email-send module"
```

---

### Task 4: `checkin-send-qr-emails` Edge Function

**Files:**
- Create: `supabase/functions/checkin-send-qr-emails/index.ts`

- [ ] **Step 1: Write the function**

```typescript
// supabase/functions/checkin-send-qr-emails/index.ts
// Manual/resend QR email delivery. Organizer-only. With no
// attendee_ids, targets every attendee for the event that has never
// been sent a QR email (qr_email_sent_at IS NULL). With attendee_ids,
// forces a resend for exactly those attendees regardless of prior
// send state — always reusing their existing qr_token, never
// regenerating it (that would invalidate anything they already
// saved from a prior email).

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendQrEmailsForAttendees, type QrEmailResult } from '../_shared/qr-email.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const event_id = String(body.event_id || '')
  const attendee_ids = Array.isArray(body.attendee_ids) ? (body.attendee_ids as string[]) : undefined
  if (!event_id) {
    return new Response(JSON.stringify({ error: 'Missing event_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: opRow } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
  if (opRow?.role !== 'organizer') {
    return new Response(JSON.stringify({ error: 'Forbidden — organizers only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Service-role client bypasses RLS entirely, so the entitlement gate
  // (migration 051's checkin_role_for_event) is never consulted here —
  // same explicit check as checkin-import-attendees.
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core').eq('event_id', event_id).single()
  if (!entRow?.checkin_core) {
    return new Response(JSON.stringify({ error: 'Check-in is not enabled for this event' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: event } = await sb.from('leod_events')
    .select('name, date, venue').eq('id', event_id).single()
  if (!event) {
    return new Response(JSON.stringify({ error: 'Event not found' }), {
      status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  let attendeesQuery = sb.from('leod_checkin_attendees')
    .select('id, first_name, email, qr_token')
    .eq('event_id', event_id)

  attendeesQuery = attendee_ids && attendee_ids.length
    ? attendeesQuery.in('id', attendee_ids)
    : attendeesQuery.is('qr_email_sent_at', null)

  const { data: attendees, error: fetchErr } = await attendeesQuery
  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const results: QrEmailResult[] = await sendQrEmailsForAttendees(sb, event, attendees || [])

  const summary = {
    total: results.length,
    sent: results.filter(r => r.status === 'sent').length,
    skipped_no_email: results.filter(r => r.status === 'skipped_no_email').length,
    errored: results.filter(r => r.status === 'error').length,
  }
  const send_errors = results.filter(r => r.status === 'error')

  return new Response(JSON.stringify({
    ok: true, summary,
    ...(send_errors.length ? { send_errors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Deploy**

```bash
bash scripts/deploy-functions.sh checkin-send-qr-emails
```

- [ ] **Step 3: Verify live**

```bash
curl -s -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-send-qr-emails \
  -H "Authorization: Bearer sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB" \
  -H "Content-Type: application/json" -d '{"_ping": true}'
# expected: {"pong":true}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/checkin-send-qr-emails/index.ts
git commit -m "feat(checkin): add manual/resend QR email Edge Function"
```

---

### Task 5: Auto-send integration in `checkin-import-attendees`

**Files:**
- Modify: `supabase/functions/checkin-import-attendees/index.ts`

- [ ] **Step 1: Re-read the current file to confirm nothing has drifted**

```bash
cat supabase/functions/checkin-import-attendees/index.ts
```

Confirm it still matches the version quoted in this plan's "Before you start" context (entitlements check at the top, `toInsert`/`toUpdate` split, `updateErrors` tracking at the end) before editing.

- [ ] **Step 2: Add the import, fetch `auto_send_qr_email` alongside `checkin_core`, and get inserted rows back**

Change:

```typescript
import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
```

to:

```typescript
import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendQrEmailsForAttendees } from '../_shared/qr-email.ts'
```

Change:

```typescript
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core').eq('event_id', event_id).single()
  if (!entRow?.checkin_core) {
```

to:

```typescript
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, auto_send_qr_email').eq('event_id', event_id).single()
  if (!entRow?.checkin_core) {
```

Change:

```typescript
  if (toInsert.length) {
    const { error } = await sb.from('leod_checkin_attendees').insert(toInsert)
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }
```

to:

```typescript
  let insertedAttendees: { id: string; first_name: string; email: string | null; qr_token: string }[] = []
  if (toInsert.length) {
    const { data: inserted, error } = await sb.from('leod_checkin_attendees')
      .insert(toInsert)
      .select('id, first_name, email, qr_token')
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    insertedAttendees = inserted || []
  }
```

- [ ] **Step 3: Fire the auto-send after the update loop, before the response**

Change:

```typescript
  return new Response(JSON.stringify({
    ok: true, dry_run: false, summary,
    ...(updateErrors.length ? { update_errors: updateErrors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

to:

```typescript
  // Auto-send is best-effort: the import itself already succeeded
  // regardless of email delivery, matching the precedent set by
  // checkin-enable-event's organizer-grant upsert. Only fires for
  // newly-CREATED attendees — re-imports/updates never trigger a send.
  if (entRow.auto_send_qr_email && insertedAttendees.length) {
    const { data: event } = await sb.from('leod_events')
      .select('name, date, venue').eq('id', event_id).single()
    if (event) {
      const sendResults = await sendQrEmailsForAttendees(sb, event, insertedAttendees)
      const failed = sendResults.filter(r => r.status === 'error')
      if (failed.length) {
        console.error('checkin-import-attendees: auto-send QR email failures:', failed)
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, dry_run: false, summary,
    ...(updateErrors.length ? { update_errors: updateErrors } : {}),
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 4: Deploy**

```bash
bash scripts/deploy-functions.sh checkin-import-attendees
```

- [ ] **Step 5: Verify live**

```bash
curl -s -X POST https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-import-attendees \
  -H "Authorization: Bearer sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB" \
  -H "Content-Type: application/json" -d '{"_ping": true}'
# expected: {"pong":true}
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/checkin-import-attendees/index.ts
git commit -m "feat(checkin): auto-send QR emails on import when auto_send_qr_email is enabled"
```

---

### Task 6: Pure-logic tests

**Files:**
- Create: `tests/checkin-qr-email.spec.ts`

Following this repo's no-live-DB convention (`tests/checkin-import.spec.ts`, `tests/checkin-rls.spec.ts`): the targeting/gating logic is re-expressed as pure functions and tested in isolation. QR image generation and actual Resend delivery aren't unit-tested here — no precedent for that anywhere in this codebase; verified via a real send in Task 7.

- [ ] **Step 1: Write the test file**

```typescript
// tests/checkin-qr-email.spec.ts
// Check-in QR/email delivery — targeting and gating logic, re-expressed
// as pure functions per this repo's no-live-DB testing convention (see
// tests/checkin-import.spec.ts). Mirrors the real logic in
// supabase/functions/_shared/qr-email.ts,
// supabase/functions/checkin-send-qr-emails/index.ts, and the
// auto-send addition in supabase/functions/checkin-import-attendees/index.ts.

import { describe, it, expect } from 'vitest';

interface Attendee {
  id: string;
  email: string | null;
  qr_email_sent_at: string | null;
}

// Mirrors checkin-send-qr-emails/index.ts's query-building logic:
// attendee_ids provided -> those exact rows; omitted -> never-sent rows.
function selectTargets(attendees: Attendee[], attendeeIds?: string[]): Attendee[] {
  if (attendeeIds && attendeeIds.length) {
    const idSet = new Set(attendeeIds);
    return attendees.filter(a => idSet.has(a.id));
  }
  return attendees.filter(a => a.qr_email_sent_at === null);
}

describe('checkin-send-qr-emails: target selection', () => {
  const attendees: Attendee[] = [
    { id: 'a1', email: 'a1@x.com', qr_email_sent_at: null },
    { id: 'a2', email: 'a2@x.com', qr_email_sent_at: '2026-07-01T00:00:00Z' },
    { id: 'a3', email: 'a3@x.com', qr_email_sent_at: null },
  ];

  it('01 with no attendee_ids, targets only never-sent attendees', () => {
    const targets = selectTargets(attendees);
    expect(targets.map(a => a.id)).toEqual(['a1', 'a3']);
  });

  it('02 with explicit attendee_ids, targets exactly those regardless of send state (forces a resend)', () => {
    const targets = selectTargets(attendees, ['a2']);
    expect(targets.map(a => a.id)).toEqual(['a2']);
  });

  it('03 an empty attendee_ids array behaves like "omitted" (never-sent only), not "target nothing"', () => {
    const targets = selectTargets(attendees, []);
    expect(targets.map(a => a.id)).toEqual(['a1', 'a3']);
  });
});

// Mirrors sendQrEmailsForAttendees()'s per-attendee classification in
// _shared/qr-email.ts (the no-email skip specifically).
function classifyForSend(attendee: Attendee): 'send' | 'skip_no_email' {
  return attendee.email ? 'send' : 'skip_no_email';
}

describe('sendQrEmailsForAttendees: no-email skip', () => {
  it('04 an attendee with no email is classified skip_no_email, never attempted', () => {
    const attendee: Attendee = { id: 'a4', email: null, qr_email_sent_at: null };
    expect(classifyForSend(attendee)).toBe('skip_no_email');
  });

  it('05 an attendee with an email is classified send', () => {
    const attendee: Attendee = { id: 'a5', email: 'a5@x.com', qr_email_sent_at: null };
    expect(classifyForSend(attendee)).toBe('send');
  });
});

// Mirrors the auto-send gate added to checkin-import-attendees:
// only fires when auto_send_qr_email is true AND there are newly-
// inserted attendees (never for updated/re-imported rows, since those
// never appear in insertedAttendees to begin with).
function shouldAutoSend(autoSendEnabled: boolean, insertedCount: number): boolean {
  return autoSendEnabled && insertedCount > 0;
}

describe('checkin-import-attendees: auto-send gate', () => {
  it('06 does not auto-send when auto_send_qr_email is false, even with new attendees', () => {
    expect(shouldAutoSend(false, 3)).toBe(false);
  });

  it('07 does not auto-send when auto_send_qr_email is true but nothing was newly inserted (e.g. a batch of pure updates)', () => {
    expect(shouldAutoSend(true, 0)).toBe(false);
  });

  it('08 auto-sends when auto_send_qr_email is true and at least one attendee was newly inserted', () => {
    expect(shouldAutoSend(true, 1)).toBe(true);
  });
});

// Mirrors sendQrEmailsForAttendees(): the email payload always reuses
// the attendee's existing qr_token, whether this is the first send or
// an explicit resend — never regenerated.
function buildEmailQrToken(attendee: { qr_token: string }): string {
  return attendee.qr_token;
}

describe('QR token reuse on resend', () => {
  it('09 a resend for an already-sent attendee uses their existing qr_token unchanged', () => {
    const attendee = { id: 'a2', qr_token: 'existing-token-abc' };
    expect(buildEmailQrToken(attendee)).toBe('existing-token-abc');
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/checkin-qr-email.spec.ts
```

Expected: all 9 tests pass.

- [ ] **Step 3: Cross-check against the real code**

Re-read `supabase/functions/checkin-send-qr-emails/index.ts`'s query-building (the `attendeesQuery.in('id', ...)` vs `.is('qr_email_sent_at', null)` branch) and `supabase/functions/_shared/qr-email.ts`'s no-email check, and confirm `selectTargets`/`classifyForSend` above match exactly. If any test case disagrees with the real code, fix the simulation function, not the test's expected outcome — unless you find an actual bug in the real code, in which case stop and report it.

- [ ] **Step 4: Run the full suite**

```bash
npx vitest run
```

Expected: all test files pass, no regressions (201 tests before this task, 210 after).

- [ ] **Step 5: Commit**

```bash
git add tests/checkin-qr-email.spec.ts
git commit -m "test(checkin): add QR/email delivery targeting and gating tests"
```

---

### Task 7: End-to-end live verification with a real email

**Files:** none (verification only)

- [ ] **Step 1: Enable auto-send on the seeded test event**

```bash
SUPABASE_URL="https://sawekpguemzvuvvulfbc.supabase.co" \
/opt/homebrew/bin/supabase db query --linked \
  "UPDATE leod_checkin_entitlements SET auto_send_qr_email = true WHERE event_id = 'bdd18620-1df4-4c95-b398-8a96a25f5d17'"
```

(Event `bdd18620-1df4-4c95-b398-8a96a25f5d17`, "IME 2026", is the event `scripts/seed-checkin-test-event.mjs` already provisions with check-in entitlements — see Task 10 of the Phase 1a plan.)

- [ ] **Step 2: Call the manual send endpoint for the seeded test attendees, to a real inbox you control**

Since the seeded attendees use `@example.com` addresses (not deliverable), use the manual endpoint with a real test attendee instead — insert one with your own email first:

```sql
INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token)
VALUES ('bdd18620-1df4-4c95-b398-8a96a25f5d17', 'Test', 'Delivery', '<your real email>', 'e2e-verify-token')
RETURNING id;
```

Then call `checkin-send-qr-emails` with a real director JWT (not the anon key — this function requires a genuine authenticated organizer session; sign in as `director@leod.test` via the Supabase client or dashboard to get one) and `{"event_id": "bdd18620-1df4-4c95-b398-8a96a25f5d17", "attendee_ids": ["<id from above>"]}`.

- [ ] **Step 3: Check the actual inbox**

Confirm: the email arrives, the QR image renders (check at least two clients if possible — e.g. Gmail web and one other, since email client rendering of embedded images is exactly the kind of thing that looks fine in one client and breaks in another), the from name reads `"IME 2026 Check-in"`, the subject reads `"Your check-in QR code — IME 2026"`, and the footer shows the quiet "Check-in powered by CueDeck" credit. If the QR image doesn't render in some client, note which one — that's a real finding to report, not something to silently work around.

- [ ] **Step 4: Verify `qr_email_sent_at` was recorded and clean up the test attendee**

```sql
SELECT qr_email_sent_at FROM leod_checkin_attendees WHERE qr_token = 'e2e-verify-token';
-- expected: a real timestamp, not NULL

DELETE FROM leod_checkin_attendees WHERE qr_token = 'e2e-verify-token';
```

- [ ] **Step 5: Revert the test event's auto-send flag back to its seed default**

```bash
/opt/homebrew/bin/supabase db query --linked \
  "UPDATE leod_checkin_entitlements SET auto_send_qr_email = false WHERE event_id = 'bdd18620-1df4-4c95-b398-8a96a25f5d17'"
```

No commit for this task — it's verification only, no file changes.

---

## Self-Review

**Spec coverage:** every section of `docs/superpowers/specs/2026-07-25-checkin-qr-email-delivery-design.md` maps to a task — architecture (Task 3's shared module split), data model (Task 1), `checkin-send-qr-emails` (Task 4), auto-send integration (Task 5), email content (Task 3's template), testing (Task 6), entitlement gate on the manual function (Task 4 Step 1's explicit `checkin_core` check).

**Placeholder scan:** no TBD/TODO; every code step has complete, working code. The one deliberately-flagged uncertainty (Task 3 Step 1, the QR library's exact API) is handled as an explicit verification step with a concrete command and a clear instruction to adapt rather than guess — not a placeholder, a checked assumption.

**Type/name consistency:** `QrEmailAttendee`/`QrEmailEvent`/`QrEmailResult` are defined once in `_shared/qr-email.ts` (Task 3) and imported identically by both consumers (Tasks 4 and 5) — no redefinition drift. `sendQrEmailsForAttendees`'s signature (`sb, event, attendees`) matches both call sites exactly. `qr_email_sent_at` and `auto_send_qr_email` column names match between the migration (Task 1), the shared module (Task 3), and both Edge Functions (Tasks 4-5).

---

Plan complete and saved to `docs/superpowers/plans/2026-07-25-checkin-qr-email-delivery.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

---

## Post-implementation notes

**Task 3 finding, fixed:** `renderQrEmailHtml()` interpolated `event.name`/`event.venue`/`attendee.first_name` into raw HTML with no escaping — a real injection risk since `attendee.first_name` comes from CSV import (adversarial-input-capable). Added an `escapeHtml()` helper, applied to all three fields.

**Task 4 finding, fixed (cheap, mechanical):** `scripts/deploy-functions.sh`'s `ALL_FUNCTIONS` array didn't include any `checkin-*` function — the bare "deploy all" form silently skipped them. Added `checkin-enable-event`, `checkin-import-attendees`, `checkin-send-qr-emails`. Noted, not fixed: the array is also missing several unrelated pre-existing functions (per the project's own `CLAUDE.md`, 27 total Edge Functions exist vs. 16 now listed) — out of scope for this plan.

**Task 4 finding, deliberately deferred (not a Task 4 bug, a scale question):** `sendQrEmailsForAttendees` (Task 3's shared module) processes attendees strictly sequentially — one QR-generation + Resend HTTP call at a time, inside a single Edge Function invocation. `checkin-send-qr-emails`'s no-`attendee_ids` path ("send to everyone never sent") is the first live caller that can trigger this against an entire event's roster. On an event with a few hundred attendees, this risks hitting the Edge Function's wall-clock timeout mid-batch, with no partial-progress feedback to the organizer (though it's self-healing on retry, since `qr_email_sent_at IS NULL` targeting naturally skips whatever already succeeded).
This wasn't fixed here because a real fix (batch-size capping with pagination signaling, or a background/queued execution model) is a genuine design decision — not a bug fix — matching the original check-in module spec's own "Phase 4: hardening... load test 1,000 attendees" as the place this class of concern is meant to be addressed, not something to bolt onto this task unilaterally. **Decision needed before this function is used against any real production event with more than roughly 50-100 attendees**, and definitely before Task 5's auto-send makes bulk invocation routine rather than occasional.

**Task 5 finding, fixed (cheap, mechanical):** the auto-send block's post-import event fetch (`checkin-import-attendees/index.ts`) silently skipped sending with no logging if the fetch failed or returned null — unlike every other failure path in this file and in `qr-email.ts`, which all log. Added a `console.error` in the `else` branch capturing the fetch error.

**Task 5 finding, noted for Task 6:** the auto-send gate is really a three-condition branch (`auto_send_qr_email` toggle, `insertedAttendees.length`, and whether the event fetch succeeds), not the two-boolean `shouldAutoSend(autoSendEnabled, insertedCount)` model sketched for Task 6's tests. The event-fetch-failure branch can't be exercised by a pure two-input model — Task 6 should account for this as a known gap rather than silently under-covering it.
