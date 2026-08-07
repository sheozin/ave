# CueDeck — Team Rules

This file holds rules that apply across all Claude Code sessions working in this repo but aren't
specific enough to belong in `CLAUDE.md`'s architecture/coding-rules sections. They're pulled from
the user's **global** memory (`~/.claude/projects/-Users-sheriff/memory/`), scoped down to what's
genuinely universal — no CueQuote, AVE Egypt, or AVE Events-specific rules are included here.

For CueDeck's own internal documentation of record, see:
- **`FILE-ORGANIZATION.md`** — where CueDeck/LEOD files must live, directory structure
- **`LEOD-sync-engine.md`** — the full runtime sync architecture (Supabase realtime, state machine, clock authority, conflict resolution). Read this before touching session-state or timing logic; it's long, don't try to hold it all in context at once.

## Git Discipline

**Never `git add -A`, `git add .`, or `git commit -a`.** Sherif runs parallel Claude Code sessions
against this repo. A bulk-staged commit can sweep another session's uncommitted work into your
commit under an unrelated message. Always:
```
git status --short          # look first, every time
git add path/to/file.ts     # name each path explicitly
git diff --cached --stat    # confirm before committing
```
A `PreToolUse` hook (`~/.claude/hooks/no-bulk-git-staging.sh`) already blocks the bulk forms — this
is enforced, not just a habit to remember.

If another session is visibly active in this repo, don't edit, fix, or commit their files beyond a
single mention of anything concerning you find — report it once and stay in your own scope.

## Research Before Acting

Before modifying, removing, or editing any existing code or system in this repo, read the full file
and understand what it's connected to first — especially session-state transitions (all go through
Edge Functions, see `CLAUDE.md`) and anything driven by `leod_*` tables. Don't override working logic
with new code without first tracing what currently depends on it.

## Verification Before Confirming "Done"

Never say something is "pushed" or "live" without proving it. This is the single rule the user has
pushed back on hardest across projects:

1. Confirm the commit is actually pushed (`git log origin/<branch>..HEAD` empty)
2. Confirm the Vercel deployment for that commit is `Ready`
3. `curl` the live URL and grep for the exact string that changed — report the grep result as
   evidence, not just the claim
4. For console/UI changes, open the live URL in **Chrome** (not Safari — `open -a "Google Chrome"
   <url>`, never a bare `open`) and visually confirm, per `CLAUDE.md`'s existing Live Verification
   Protocol
5. If the user still sees stale content after curl confirms the new version is served, the gap is
   their browser/edge cache — point them at a hard reload or Incognito, don't assume a phantom
   service worker or re-diagnose the deploy

See `deploy.md` for how this applies concretely to CueDeck's unbundled HTML/JS console (verification
here is simpler than a bundled SPA — no minified/chunked bundle gotchas to work around, just grep the
served file directly).

## No Fake or Placeholder Data

Never introduce invented, estimated, or "reasonable guess" data anywhere it could be mistaken for
real — specs, descriptions, counts, dates, pricing, names. If real data doesn't exist yet, leave the
field null/empty or flag it — never fill with a plausible-looking guess. If you discover previously
seeded fake data, surface and clear it immediately.

## Logical, Realistic Values

Apply common sense to every generated value. Never date content in a future month relative to today.
Use realistic numbers for the context. Don't reference features or pages that don't exist yet unless
you're the one building them right now. Follow the project's existing version-numbering pattern —
don't jump versions.

## No Emoji Icons in Marketing/Professional Surfaces

Applies to `cuedeck-marketing/` and any user-facing marketing copy, banners, or feature cards: use
Lucide icons or clean SVG, never emoji (📋📦👥). This does not apply to terminal/script output (e.g.
`scripts/verify-cuedeck.sh` already uses ✅/❌ for CLI readability — that's fine, it's not a
marketing surface).
