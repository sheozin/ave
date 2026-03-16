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
- **Tests:** `npm test` (vitest, 119 specs) | `npm run test:e2e` (Playwright, 169 specs)
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
| `cuedeck-console.html` | Main console (~6400+ lines) |
| `cuedeck-display.html` | Digital signage display (11 modes) |
| `cuedeck-agent-*.js` | AI agent modules (3 files) |
| `supabase/functions/` | 10 Edge Functions |
| `scripts/deploy-functions.sh` | Edge Function deployer |

### Database Tables
- **Core:** `leod_events`, `leod_sessions`, `leod_broadcast`, `leod_clock`, `leod_event_log`
- **Auth:** `leod_users`, `leod_config` (signup_code='CUEDECK2026')
- **Signage:** `leod_signage_displays`, `leod_signage_sponsors`
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

## Edge Functions (10 total)
`go-live`, `end-session`, `set-ready`, `hold-stage`, `call-speaker`,
`cancel-session`, `reinstate`, `apply-delay`, `set-overrun`, `invite-operator`

Deploy all: `bash scripts/deploy-functions.sh`
Deploy one: `bash scripts/deploy-functions.sh go-live`

## Roles
`director` | `stage` | `av` | `interp` | `reg` | `signage`
- Role permissions defined in `ROLE_WRITE` and `ROLE_DELAY` constants
- Director has full access; other roles are scoped

## Git Remotes
- `origin` → sheozin/ave.git (primary)
- `cuedeck` → sheozin/cuedeck-console.git (Vercel deploy)

## Coding Rules
1. **Single-file architecture** — all console code lives in `cuedeck-console.html`
2. **No framework dependencies** — vanilla JS only, Supabase via CDN
3. **Edge Functions use Deno** — TypeScript, import from `https://esm.sh/`
4. **CORS headers required** on all Edge Function responses
5. **Idempotency** — all state transitions use `leod_commands` table
6. **RLS enforced** — row-level security on all tables
7. **Test before reporting done** — verify in browser, not just visually

## Edge Function Template
```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // ... logic here
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

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
