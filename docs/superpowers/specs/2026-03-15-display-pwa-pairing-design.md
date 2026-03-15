# Display PWA + Short URL + Auto-Reconnect

**Date:** 2026-03-15
**Status:** Approved

## Problem

Display screens (TVs, professional monitors) require typing `app.cuedeck.io/display` on a TV remote — 24 characters on a clunky remote. After pairing, if the screen reboots, the user must re-pair from scratch since nothing is persisted.

## Solution — Three Changes

### 1. Short URL: `/d` → `/display`

Add a Vercel rewrite so `cuedeck.io/d` loads the display page. 11 characters instead of 24.

**Implementation:** Single line in `vercel.json` rewrites array.

### 2. PWA: Install as App

Make `cuedeck-display.html` installable as a Progressive Web App so it:
- Appears as "CueDeck Display" icon on the device home screen
- Opens fullscreen (no browser chrome)
- Survives device reboots — tap icon to relaunch

**Files:**
- `display-manifest.json` — PWA manifest with `start_url: "/display"`, `display: "fullscreen"`, display-specific icon
- `display-sw.js` — Minimal service worker (cache app shell, serve offline fallback)
- `cuedeck-display.html` — Add `<link rel="manifest">`, meta theme-color, SW registration

**Service worker strategy:** Cache the HTML shell + favicon on install. Network-first for Supabase API calls (never cache data). Offline fallback shows "Reconnecting..." screen.

### 3. Auto-Reconnect via localStorage

After successful pairing, persist the display ID in localStorage. On next launch, skip the pairing screen and boot directly.

**localStorage keys:**
- `cuedeck_display_id` — The paired display UUID
- `cuedeck_display_url` — Supabase URL
- `cuedeck_display_key` — Supabase anon key

**Flow change in `cuedeck-display.html`:**
```
Page loads → check URL params (?id= or #id=)
  → if found: bootDisplay() (existing)
  → if not: check localStorage for cuedeck_display_id
    → if found: bootDisplay() with saved config
      → if boot fails (display deleted/invalid): clear localStorage, show pairing
    → if not: startPairing() (existing)
```

**Forget display:** Add a small "Disconnect" button in the display status bar so operators can unpair and re-pair to a different display without clearing browser data.

## Architecture

```
cuedeck.io/d  ──(Vercel rewrite)──►  cuedeck-display.html
                                          │
                                    ┌─────┴──────┐
                                    │ Check URL   │
                                    │ ?id= param  │
                                    └─────┬──────┘
                                      no  │  yes → bootDisplay()
                                    ┌─────┴──────┐
                                    │ Check       │
                                    │ localStorage│
                                    └─────┬──────┘
                                      no  │  yes → bootDisplay() (auto)
                                    ┌─────┴──────┐
                                    │ Show pairing│
                                    │ code screen │
                                    └────────────┘
```

## Files Changed

| File | Change |
|------|--------|
| `vercel.json` | Add `/d` rewrite |
| `display-manifest.json` | New — PWA manifest for display |
| `display-sw.js` | New — minimal service worker |
| `cuedeck-display.html` | Add manifest link, SW registration, localStorage persistence, auto-reconnect, disconnect button |

## Testing

- Verify `/d` loads display page on Vercel
- Verify PWA install prompt appears in Chrome
- Verify pairing persists across page reload
- Verify auto-reconnect after boot with saved display ID
- Verify disconnect button clears localStorage and returns to pairing screen
- Verify invalid/deleted display ID falls back to pairing screen gracefully
