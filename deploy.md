# CueDeck — Deployment Reference

Facts only. If something below can't be confirmed from the repo, it's marked TBD — don't guess.

## Two Separate Deploy Targets

This repo root contains **two independently deployed things**:

| | Console (this repo) | Marketing site |
|---|---|---|
| Location | repo root (`cuedeck-*.html`, `supabase/`, `api/`) | `cuedeck-marketing/` — **its own nested git repo**, gitignored here (see `.gitignore` line 60) |
| GitHub | `sheozin/cuedeck-console.git` (remote `cuedeck`) | `sheozin/cuedeck-marketing.git` (own `origin`, unrelated to this repo's remotes) |
| Vercel project | `cuedeck-console` (`prj_yxtJHa9k9jO7ZEPjaYRr3BaBxuLz`) | `cuedeck-marketing` (`prj_kIvpNIrWv35Q5nEn45FQlCaTHj7q`) |
| Live URL | https://app.cuedeck.io | https://cuedeck.io |
| Stack | Static HTML/CSS/JS, no build step | Next.js 16 (Turbopack), own `CLAUDE.md` in that directory |

Both Vercel projects are under the same team (`team_PwIbNALSFmtcg9ELOX9o34M0`), confirmed via `.vercel/project.json` in each directory.

## Console — Build & Deploy

No build step — Vercel serves the HTML files directly per `vercel.json` rewrites:
- `/` → `cuedeck-console.html`
- `/admin` → `cuedeck-admin.html`
- `/display`, `/d` → `cuedeck-display.html`

Deploy is git-push-triggered auto-deploy on the `cuedeck` remote (per existing `CLAUDE.md`). No manual `vercel deploy` command is documented in this repo — TBD if manual deploys are ever used.

**Local dev:**
```
python3 -m http.server 7230
# open http://127.0.0.1:7230/cuedeck-console.html
```

**Local smoke test:** `bash scripts/verify-cuedeck.sh 7230`

**Local launch (macOS, non-dev use):**
- `Launch CueDeck Console.command` — starts the same `http.server` on 7230 and opens the console in the default browser
- `Launch CueDeck Display.command` — opens `https://app.cuedeck.io/display` (production, not local) in Chrome kiosk mode (`--kiosk --autoplay-policy=no-user-gesture-required`); accepts an optional display UUID arg
- `CueDeck Console.app/` — an Automator app bundle (`Contents/Resources/Scripts`) wrapping one of the launch scripts; not inspected further here

## Supabase Edge Functions

27 functions in `supabase/functions/`.
- Deploy all: `bash scripts/deploy-functions.sh`
- Deploy one: `bash scripts/deploy-functions.sh <function-name>`
- CLI: `/opt/homebrew/bin/supabase`
- Project ref: `sawekpguemzvuvvulfbc`

## Cron Jobs (`vercel.json`)

| Path | Schedule |
|---|---|
| `/api/cron/session-cleanup` | `0 2 * * *` (02:00 daily) |
| `/api/cron/health-check` | `0 6 * * *` (06:00 daily) |

Cron routes authenticate via `Authorization: Bearer $CRON_SECRET` (see Edge Function template pattern in `CLAUDE.md`).

## Environment Variables (names only — never commit values)

From `.env.example`:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `FROM_NAME`
- `TEST_EMAIL`
- `TEST_PASSWORD`
- `TEST_SESSION_ID`

`CRON_SECRET` is referenced in cron route code (`api/cron/`) but not listed in `.env.example` — TBD, confirm it's set in Vercel project env vars directly.

The Supabase anon key is also hardcoded inline in `cuedeck-console.html`'s `<script>` block (documented in `CLAUDE.md` — this is intentional for a static-HTML app, not an oversight).

## CI

`.github/workflows/ci.yml` runs on push/PR to `main`/`master`:
- `unit-tests` job: `npm ci` → `npm test` (vitest, 135 specs)
- `e2e-tests` job: `npm ci` → Playwright install → serve on :7230 via `http-server` → `npm run test:e2e` (202 specs, live-DB tests auto-skip when `TEST_EMAIL` is unset)

CI does not deploy — deployment is Vercel's own git integration, separate from this workflow.

## Mandatory Post-Deploy Verification

Never report a change as "live" on the strength of a git push or a green CI run alone. Confirm all three states:

1. **Pushed** — `git log origin/main..HEAD` (or the relevant branch) is empty
2. **Deployed** — the Vercel deployment for that commit shows `Ready` on the production target
3. **Actually serving the change** — `curl` the specific production file and grep for the exact string that changed, e.g.:
   ```
   curl -sL "https://app.cuedeck.io/cuedeck-console.html?cb=$RANDOM" | grep '<your changed string>'
   ```
   Since this app ships unbundled HTML/JS (no minifier, no chunked bundles, no build hash), verification is simpler than a bundled SPA: grep the served file directly for the literal string you changed — no backtick-vs-quote rewriting or chunk-splitting to account for (that class of gotcha applies to bundled apps like CueQuote, not this one).
4. For console UI changes specifically, `CLAUDE.md`'s existing Live Verification Protocol already requires opening https://app.cuedeck.io in Chrome, reloading, checking for JS errors, and taking a screenshot before reporting done — that step still applies on top of the curl check above.
5. If the user still reports stale content after curl confirms the new version is served, the gap is their browser/edge cache, not the deploy — have them hard-reload or check in Incognito before re-investigating.
