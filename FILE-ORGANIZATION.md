# CueDeck File Organization Policy

**All CueDeck / LEOD related files MUST live inside the `AVE Production Console` directory.**

Do NOT place CueDeck files anywhere else (e.g., loose in Downloads, Desktop, or other folders).
This is the single source of truth for the entire CueDeck project.

## Directory Structure

```
AVE Production Console/
├── cuedeck-console.html      # Main console app
├── cuedeck-display.html      # Digital signage display
├── cuedeck-agent-*.js        # AI agent modules
├── cuedeck-marketing/        # Marketing site (Next.js)
├── supabase/                 # Edge Functions, migrations, config
├── scripts/                  # Deploy scripts, YouTube pipeline, verification
├── tests/                    # Unit + E2E tests
├── api/                      # Vercel cron routes
├── docs/                     # Documentation, specs, outreach materials
│   └── outreach/             # Outreach messages, proposals
├── assets/                   # Media assets (not tracked in git)
│   ├── demos/                # Product demo GIFs
│   ├── branding/             # Logos, banners, promotional images
│   ├── audio/                # Audio files (YouTube, etc.)
│   ├── screenshots/          # App screenshots
│   └── youtube-branding/     # YouTube channel assets
├── archive/                  # Legacy/old files kept for reference
│   ├── legacy-html/          # Old LEOD HTML prototypes
│   └── files-2/              # Historical files
├── .claude/                  # Claude Code config
├── .github/                  # CI/CD workflows
└── CueDeck Console.app/      # macOS launcher
```

## Rules

1. **New CueDeck files** — always create them inside this directory
2. **Downloaded assets** — move to `assets/` subdirectory immediately
3. **Old/legacy files** — move to `archive/` instead of deleting
4. **Documentation** — goes in `docs/`
5. **Large media** (GIFs, MP3s, PNGs) — goes in `assets/`, which is gitignored
