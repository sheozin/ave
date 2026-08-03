# CueDeck Production Console — Agent Operating System

## What This Is
CueDeck is a single-file HTML production console for managing live conference events.
No build system, no framework — pure HTML/CSS/JS with Supabase backend.

## File Organization
**All CueDeck/LEOD files MUST live inside `AVE Production Console/`.** Never place project files outside this directory. See `FILE-ORGANIZATION.md` for the full directory structure and rules.

## Quick Start
- **Dev server:** `python3 -m http.server 7230` then open `http://127.0.0.1:7230/cuedeck-console.html`
- **Live URL:** https://app.cuedeck.io (Vercel auto-deploy from `cuedeck` remote)
- **Display page:** https://app.cuedeck.io/display
- **Tests:** `npm test` (vitest, 135 specs) | `npm run test:e2e` (Playwright, 202 specs)
- **Verify:** `bash scripts/verify-cuedeck.sh 7230`

## Architecture

### Stack
- Pure HTML/CSS/JS — no build system, no framework
- Supabase JS v2 via CDN
- Auth: email/password via Supabase Auth
- Realtime: postgres_changes subscription (2 channels)
- Clock sync: `correctedNow()` / `correctedHMS()` using `S.clockOffset`

### Primary Files
| File | Purpose |
|------|---------|
| `cuedeck-console.html` | Main console (~7800 lines) |
| `cuedeck-admin.html` | Admin dashboard (~2970 lines) |
| `cuedeck-display.html` | Digital signage display (11 modes, ~1800 lines) |
| `cuedeck-theme-preview.html` | Theme preview tool |
| `cuedeck-agent-*.js` | AI agent modules (3 files) |
| `supabase/functions/` | 27 Edge Functions + `_shared/` |
| `scripts/deploy-functions.sh` | Edge Function deployer |
| `cuedeck-marketing/` | Next.js 16 marketing site (has its own CLAUDE.md) |

### Database Tables
- **Core:** `leod_events`, `leod_sessions`, `leod_broadcast`, `leod_clock`, `leod_event_log`
- **Auth:** `leod_users`, `leod_config` (signup_code='CUEDECK2026')
- **Billing:** `leod_subscriptions`, `leod_invoices`, `leod_promo_codes`
- **Signage:** `leod_signage_displays`, `leod_signage_pairing`, `leod_signage_sponsors`
- **Admin:** `leod_admin_audit`, `leod_feedback`
- **Infra:** `leod_commands` (idempotency)

### Supabase
- URL: `https://sawekpguemzvuvvulfbc.supabase.co`
- Project ref: `sawekpguemzvuvvulfbc`
- Anon key: hardcoded in cuedeck-console.html `<script>` block
- CLI: `/opt/homebrew/bin/supabase`

## Session State Machine
```
PLANNED → READY → CALLING → LIVE → ENDED
  ↓         ↓        ↓        ↓
CANCELLED  HOLD   (back)   OVERRUN → ENDED
```
All transitions go through Edge Functions in `supabase/functions/`.
Shared logic in `supabase/functions/_shared/transition.ts`.

## Edge Functions (27 total)

**Session transitions:**
`go-live`, `end-session`, `set-ready`, `hold-stage`, `call-speaker`,
`cancel-session`, `reinstate`, `apply-delay`, `set-overrun`

**Operators:**
`invite-operator`, `manage-operator`

**Billing & Payments (Stripe):**
`create-checkout-session`, `customer-portal`, `stripe-webhook`,
`generate-invoice`, `send-invoice-email`, `update-billing-details`,
`redeem-code`, `admin-manage-promo`, `admin-manage-subscription`

**Admin:**
`admin-manage-user`, `admin-promote`

**Email (Resend):**
`process-email-queue`, `process-welcome-triggers`, `send-welcome-email`, `resend-webhook`

**AI:**
`ai-proxy`

**Shared helpers:** `_shared/` — `cors.ts`, `client.ts`, `transition.ts`, `stripe.ts`, `resend.ts`, `email-templates.ts`, `invoice-email-template.ts`, `invoice-pdf.ts`

Deploy all: `bash scripts/deploy-functions.sh`
Deploy one: `bash scripts/deploy-functions.sh go-live`

## Roles
`director` | `stage` | `av` | `interp` | `reg` | `signage`
- Role permissions defined in `ROLE_WRITE` and `ROLE_DELAY` constants
- Director has full access; other roles are scoped

## Git Remotes
- `origin` → sheozin/ave.git (primary)
- `cuedeck` → sheozin/cuedeck-console.git (Vercel deploy)

## Scripts
| Script | Purpose |
|--------|---------|
| `scripts/deploy-functions.sh` | Deploy Supabase Edge Functions |
| `scripts/verify-cuedeck.sh` | Smoke-test local dev server |
| `scripts/seed-test-account.mjs` | Seed test account data |
| `scripts/demo-reset.sql` | Reset demo event data |
| `scripts/add-operators.sql` | Seed operator records |
| `scripts/generate-social-images.mjs` | Generate OG/social images |
| `scripts/sync-blog-posts.mjs` | Sync blog posts to marketing site |
| `scripts/youtube-pipeline/` | YouTube content pipeline |
| `scripts/youtube-scripts/` | YouTube automation scripts |

## Marketing Site
The `cuedeck-marketing/` directory is a separate Next.js 16 (App Router, Turbopack) project with its own `CLAUDE.md`. Key details:
- **Live:** cuedeck.io (Vercel)
- **Stack:** Next.js 16, Tailwind CSS v4, Keystatic CMS, TypeScript strict
- **Dev:** `cd cuedeck-marketing && npm run dev`
- **Important:** All layout uses inline styles only (intentional). Mobile CSS overrides live in `<style>` tag in `layout.tsx` to bypass Tailwind v4 purge.

## Coding Rules
1. **Single-file architecture** — all console code lives in `cuedeck-console.html`
2. **No framework dependencies** — vanilla JS only, Supabase via CDN
3. **Edge Functions use Deno** — TypeScript, import from `https://esm.sh/`
4. **CORS headers required** on all Edge Function responses
5. **Idempotency** — all state transitions use `leod_commands` table
6. **RLS enforced** — row-level security on all tables
7. **Test before reporting done** — verify in browser, not just visually

## Edge Function Template
`corsHeaders` is a FUNCTION of the request, not an object — it reads the
`Origin` header to decide what to allow. Call it once and spread the
result. Spreading `corsHeaders` itself yields `{}`, which silently
strips every CORS header: browser calls then fail preflight while
`curl` and the deployer's ping still pass, because those send no
`Origin`.

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // ... logic here
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
```

Functions using the service-role key bypass RLS entirely, so any
`checkin_role_for_event()` / RLS gate must be re-checked explicitly in
the function body. See `checkin-import-attendees` for the reference
JWT + role + entitlement sequence.

## Content Writing Rules
- **Avoid dashes in titles, headings, and copy** — only use `—` or `-` when genuinely necessary (e.g. a range, or a strong pause no other punctuation can replace)
- Prefer clean, direct phrasing; no dash-connected clauses
- Applies to: blog titles, subtitles, cover image text, meta descriptions, all marketing copy

## Live Verification Protocol
Every code change MUST be verified live before reporting done:
1. **Console edits** (`cuedeck-console.html`): Open https://app.cuedeck.io in Chrome, reload, check for JS errors, take screenshot proof
2. **Marketing edits** (`cuedeck-marketing/`): Check preview server for build errors, screenshot the affected page
3. **Database changes** (migrations/RPC): Apply via Supabase SQL editor in Chrome, verify with a query
4. **Never claim done without evidence** — screenshot or console output proving it works

## Vercel Cron Route Template
```typescript
// api/cron/example.ts
export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ... cron logic
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
```
