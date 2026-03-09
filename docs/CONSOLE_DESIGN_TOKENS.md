# CueDeck Console — Design Tokens Reference
## PR-UI-001: CSS Custom Properties

**Status:** Draft — awaiting approval
**Scope:** CSS variable definitions only — implementation reference for PR-UI-001
**Purpose:** Single source of truth for all design tokens; paste the `:root` block verbatim into cuedeck-console.html

---

## How to Use

1. Replace the existing `:root { }` block in cuedeck-console.html with the block in §1
2. All other CSS references these tokens — no hardcoded hex values outside `:root`
3. Tokens are grouped by category; prefixes make origin obvious at a glance

---

## 1. Complete `:root` Block

```css
:root {

  /* ─────────────────────────────────────────────
     SURFACE ELEVATION
     Five levels from darkest (page) to lightest (interactive)
     ───────────────────────────────────────────── */
  --bg:          #0B0F14;   /* Level 0 — page background */
  --surface:     #111827;   /* Level 1 — sidebar, panels, modals */
  --card:        #141D2B;   /* Level 2 — session cards */
  --card-hi:     #1A2640;   /* Level 3 — elevated / selected card */
  --input-bg:    #0F1520;   /* Level 4 — inputs, controls */
  --hover:       #1E2D45;   /* Level 5 — hover & active states */

  /* ─────────────────────────────────────────────
     SEMANTIC TEXT COLORS
     ───────────────────────────────────────────── */
  --text-primary:   #E5E7EB;   /* Body text, card titles */
  --text-secondary: #9CA3AF;   /* Secondary labels, metadata */
  --text-muted:     #6B7280;   /* Timestamps, section headers, de-emphasised */
  --text-dim:       #4B5563;   /* Ghost / placeholder text */
  --text-inverse:   #0B0F14;   /* Text on bright coloured buttons */

  /* ─────────────────────────────────────────────
     BORDER COLORS
     ───────────────────────────────────────────── */
  --border:         rgba(148, 163, 184, 0.10);   /* Default card border */
  --border-strong:  rgba(148, 163, 184, 0.20);   /* Focused / active border */
  --border-subtle:  rgba(148, 163, 184, 0.06);   /* Cancelled card border */
  --border-section: rgba(148, 163, 184, 0.08);   /* Sidebar section dividers */

  /* ─────────────────────────────────────────────
     STATUS COLORS — BORDERS / ACCENTS
     Left-border colour + glow source colour
     ───────────────────────────────────────────── */
  --c-planned:   #3B82F6;   /* Blue */
  --c-ready:     #22C55E;   /* Green */
  --c-calling:   #F97316;   /* Amber-orange */
  --c-live:      #FF3B30;   /* Red */
  --c-overrun:   #FF00A8;   /* Magenta */
  --c-hold:      #F97316;   /* Amber-orange (same as calling) */
  --c-ended:     rgba(148, 163, 184, 0.15);
  --c-cancelled: rgba(148, 163, 184, 0.08);
  --c-break:     #8B5CF6;   /* Purple */

  /* ─────────────────────────────────────────────
     STATUS COLORS — BACKGROUND TINTS
     Very low opacity — card background wash per state
     ───────────────────────────────────────────── */
  --bg-planned:   rgba(59,  130, 246, 0.06);
  --bg-ready:     rgba(34,  197,  94, 0.07);
  --bg-calling:   rgba(249, 115,  22, 0.07);
  --bg-live:      rgba(255,  59,  48, 0.10);
  --bg-overrun:   rgba(255,   0, 168, 0.10);
  --bg-hold:      rgba(249, 115,  22, 0.07);
  --bg-break:     rgba(139,  92, 246, 0.07);

  /* ─────────────────────────────────────────────
     STATUS COLORS — BADGE TEXT
     Slightly lighter / more saturated than accent for legibility on dark
     ───────────────────────────────────────────── */
  --badge-planned:   #93C5FD;
  --badge-ready:     #86EFAC;
  --badge-calling:   #FDBA74;
  --badge-live:      #FF8B85;
  --badge-overrun:   #FF80D4;
  --badge-hold:      #FDBA74;
  --badge-ended:     #6B7280;
  --badge-cancelled: #4B5563;
  --badge-break:     #C4B5FD;

  /* ─────────────────────────────────────────────
     SEMANTIC UTILITY COLORS
     For diagnostics, buttons, and indicators
     ───────────────────────────────────────────── */
  --green:   #22C55E;
  --green-lt: #86EFAC;
  --amber:   #F97316;
  --amber-lt: #FDBA74;
  --red:     #FF3B30;
  --red-lt:  #F87171;
  --blue:    #3B82F6;
  --blue-lt: #60A5FA;
  --purple:  #8B5CF6;
  --purple-lt: #C4B5FD;
  --magenta: #FF00A8;
  --magenta-lt: #FF80D4;

  /* ─────────────────────────────────────────────
     SHADOWS
     Named by purpose, not by visual property
     ───────────────────────────────────────────── */
  --shadow-card:        0 1px 3px rgba(0, 0, 0, 0.40);
  --shadow-card-raised: 0 2px 8px rgba(0, 0, 0, 0.50);
  --shadow-modal:       0 8px 32px rgba(0, 0, 0, 0.60);
  --shadow-panel:       0 4px 16px rgba(0, 0, 0, 0.50);

  /* Glow shadows — status-coloured halos */
  --glow-live:    0 0 20px rgba(255,  59,  48, 0.35);
  --glow-overrun: 0 0 20px rgba(255,   0, 168, 0.40);
  --glow-ready:   0 0 12px rgba( 34, 197,  94, 0.25);
  --glow-calling: 0 0 12px rgba(249, 115,  22, 0.25);

  /* Combined card box-shadows (glow + depth) */
  --box-live:    0 0 24px rgba(255,59,48,0.20),  0 2px 8px rgba(0,0,0,0.50);
  --box-overrun: 0 0 20px rgba(255,0,168,0.25),  0 2px 8px rgba(0,0,0,0.50);
  --box-ready:   0 0 12px rgba(34,197,94,0.12);
  --box-default: 0 1px 3px rgba(0,0,0,0.30);

  /* ─────────────────────────────────────────────
     BORDER RADIUS
     ───────────────────────────────────────────── */
  --radius-sm:  4px;   /* Log entries, tiny chips */
  --radius-md:  6px;   /* Buttons, inputs, pills */
  --radius-lg:  8px;   /* Cards */
  --radius-xl:  12px;  /* Modals */
  --radius-full: 9999px; /* Fully rounded (dot indicators) */

  /* ─────────────────────────────────────────────
     SPACING SCALE
     Multiplied from a 4px base unit
     ───────────────────────────────────────────── */
  --sp-1: 4px;    /* Tight internal gaps */
  --sp-2: 8px;    /* Small internal padding, gap between cards */
  --sp-3: 12px;   /* Standard internal padding */
  --sp-4: 16px;   /* Card padding (horizontal), section gaps */
  --sp-5: 20px;   /* Button horizontal padding (primary) */
  --sp-6: 24px;   /* Large section separation */
  --sp-8: 32px;   /* Panel separation */

  /* Component-specific spacing shortcuts */
  --card-pad:      14px 16px;
  --card-gap:      8px;
  --sidebar-pad:   14px;
  --section-gap:   8px;

  /* ─────────────────────────────────────────────
     TYPOGRAPHY SCALE
     ───────────────────────────────────────────── */
  --t-2xs: 10px;   /* Timestamps, diagnostics, footnotes */
  --t-xs:  11px;   /* Log entries, metadata chips, filter labels */
  --t-sm:  12px;   /* Secondary labels, card metadata, input text */
  --t-base:13px;   /* Body text, card speaker, card times */
  --t-md:  14px;   /* Card title, sidebar labels, button text */
  --t-lg:  16px;   /* Active session title in sidebar */
  --t-xl:  20px;   /* Clock display (sidebar compact) */
  --t-2xl: 28px;   /* Clock display (header) */
  --t-3xl: 48px;   /* Stage monitor clock */

  /* Sidebar clock override (broadcast-style thin numeral) */
  --t-clock-sidebar: 36px;
  --fw-clock-sidebar: 200;

  /* ─────────────────────────────────────────────
     Z-INDEX STACK
     ───────────────────────────────────────────── */
  --z-base:    0;
  --z-card:    1;
  --z-sticky:  10;
  --z-header:  100;
  --z-overlay: 900;
  --z-modal:   1000;
  --z-toast:   1100;

  /* ─────────────────────────────────────────────
     TRANSITIONS
     ───────────────────────────────────────────── */
  --tx-fast:   0.10s ease;
  --tx-base:   0.15s ease;
  --tx-slow:   0.25s ease;

  /* ─────────────────────────────────────────────
     HEADER / BROADCAST BAR
     ───────────────────────────────────────────── */
  --header-bg:    rgba(11, 15, 20, 0.95);
  --header-h:     52px;
  --bcast-bg:     rgba(15, 21, 32, 0.97);
  --modal-backdrop: rgba(0, 0, 0, 0.70);

}
```

---

## 2. Token Usage Guide

### 2.1 Surface Elevation

Use surfaces in strict ascending order — never skip levels without reason:

```
Page background       → var(--bg)
Sidebar / panels      → var(--surface)
Cards                 → var(--card)
Selected / elevated   → var(--card-hi)
Inputs                → var(--input-bg)
Hover state           → var(--hover)
```

### 2.2 Text Colors

| Token | When to use |
|-------|-------------|
| `--text-primary` | All readable body text, card titles, values |
| `--text-secondary` | Supporting labels, metadata, secondary info |
| `--text-muted` | Section headers (UPPERCASE), timestamps |
| `--text-dim` | Placeholders, ghost labels, completely de-emphasised |

### 2.3 Status Color Pattern

For each status, three tokens are used together:

```css
/* Example: LIVE card */
border-left:   4px solid var(--c-live);         /* accent bar */
background:    var(--bg-live);                   /* tint wash */
box-shadow:    var(--box-live);                  /* glow + depth */

/* Badge inside card */
color: var(--badge-live);
```

### 2.4 Button Colour Aliases

These aliases map semantic button intent to status colours:

| Button class | Maps to |
|---|---|
| `.btn-green` / `.btn-go` | `--green` / `--green-lt` |
| `.btn-red` / `.btn-danger` | `--red` / `--red-lt` |
| `.btn-amber` / `.btn-hold` | `--amber` / `--amber-lt` |
| `.btn-blue` / `.btn-action` | `--blue` / `--blue-lt` |

### 2.5 Shadows

```css
/* Default card depth */
box-shadow: var(--shadow-card);

/* LIVE card (glow + depth combined) */
box-shadow: var(--box-live);

/* Modal */
box-shadow: var(--shadow-modal);
```

### 2.6 Radius

| Token | Use cases |
|-------|-----------|
| `--radius-sm` | Log entry borders, tiny chips |
| `--radius-md` | Buttons, inputs, badges |
| `--radius-lg` | Session cards |
| `--radius-xl` | Modal cards |
| `--radius-full` | Status dot indicators |

---

## 3. Typography Reference

### 3.1 Size Tokens in Context

```css
/* Section header (UPPERCASE label above a group) */
font-size:      var(--t-2xs);   /* 10px */
font-weight:    600;
letter-spacing: 0.08em;
text-transform: uppercase;
color:          var(--text-muted);

/* Log timestamp */
font-size:      var(--t-2xs);   /* 10px */
font-variant:   tabular-nums;

/* Badge text */
font-size:      var(--t-2xs);   /* 10px */
font-weight:    700;
letter-spacing: 0.06em;
text-transform: uppercase;

/* Card title */
font-size:      var(--t-md);    /* 14px */
font-weight:    600;

/* Card body / speaker name */
font-size:      var(--t-base);  /* 13px */
font-weight:    400;

/* Sidebar clock (broadcast thin style) */
font-size:      var(--t-clock-sidebar);  /* 36px */
font-weight:    var(--fw-clock-sidebar); /* 200 */
letter-spacing: 0.04em;
font-variant:   tabular-nums;

/* Header clock */
font-size:      var(--t-2xl);   /* 28px */
font-weight:    700;
letter-spacing: 0.02em;
```

### 3.2 Font Stack

```css
font-family: 'Inter', system-ui, -apple-system, sans-serif;
```

Numeric displays (clocks, counters):
```css
font-variant-numeric: tabular-nums;
```

---

## 4. Animation Tokens

```css
/* Status badge pulse (LIVE, READY) */
@keyframes badge-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.6; }
}
--pulse-duration: 1.4s;

/* HOLD badge blink */
@keyframes badge-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
--blink-duration: 1.0s;

/* Card border transition */
transition: border-color var(--tx-base), box-shadow var(--tx-base);
```

---

## 5. Dark-Surface Transparency Palette

Common rgba values used for dark-on-dark layering (avoid hardcoding these):

| Purpose | Value |
|---------|-------|
| Card border default | `rgba(148,163,184, 0.10)` |
| Card border active/focus | `rgba(148,163,184, 0.20)` |
| Section divider | `rgba(148,163,184, 0.08)` |
| Cancelled card border | `rgba(148,163,184, 0.06)` |
| Ended card left-border | `rgba(148,163,184, 0.15)` |
| Log entry background | `rgba(255,255,255, 0.02)` |
| Diagnostic pill background | `rgba(255,255,255, 0.03)` |
| Input background | `rgba(255,255,255, 0.04)` |
| Modal backdrop | `rgba(0,0,0, 0.70)` |
| Header background | `rgba(11,15,20, 0.95)` |
| Broadcast bar | `rgba(15,21,32, 0.97)` |

---

## 6. Breaking-Change Risk Tokens

These tokens replace existing CSS variables. The mapping must be 1:1 to avoid breaking JS-injected styles:

| Existing variable | Replaced by | Notes |
|---|---|---|
| `--fg` | `--text-primary` | Used in 50+ places |
| `--dim` | `--text-muted` | Used for timestamps, section labels |
| `--border` | `--border` | Same name — value changes only |
| `--surface` | `--surface` | Same name — value changes `#0f172a` → `#111827` |
| `--card-bg` | `--card` | Rename — audit JS for `var(--card-bg)` |
| `--green` | `--green` | Same name |
| `--amber` | `--amber` | Same name |
| `--red` | `--red` | Same name |
| `--blue` | `--blue` | Same name |
| `--blue-lt` | `--blue-lt` | Same name — already added in PR-013 |

> **Implementation note:** Before replacing, run `grep -o 'var(--[^)]\+)' cuedeck-console.html | sort | uniq` to get a complete list of variables currently in use. Any variable in the file but not in this token set must be kept or explicitly aliased.
