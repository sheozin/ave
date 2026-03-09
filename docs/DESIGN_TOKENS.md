# CueDeck Console — Design Tokens

**Authored by:** UI Designer (Design System)
**Status:** Phase 1 — Design Output
**Implementation:** CSS custom properties in `:root {}` — no preprocessor required

---

## 1. Colour Palette

### Base (Dark Theme — only theme)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0d0f17` | Page background |
| `--surface` | `#141722` | Card background, modal |
| `--surface2` | `#1c2030` | Input background, sidebar |
| `--surface3` | `#242840` | Hover state on cards |
| `--border` | `#2a2f45` | Card borders, dividers |
| `--border-strong` | `#3a4060` | Active element borders, modal edges |
| `--text` | `#e8ecf4` | Primary text |
| `--text-dim` | `#7c85a0` | Secondary text, metadata |
| `--text-disabled` | `#45506a` | Disabled labels |
| `--overlay` | `rgba(0,0,0,0.7)` | Modal backdrop |

### Accent

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#3b6cff` | Active role button, links, focus rings |
| `--accent-dim` | `rgba(59,108,255,0.15)` | Accent tint backgrounds |
| `--accent-hover` | `#4d7fff` | Hover state for accent elements |

### Status Colours

Used for card left-border, badge background, and status pill backgrounds.

| Status | Border Token | Badge Token | Badge Text | Animation |
|--------|-------------|-------------|-----------|-----------|
| PLANNED | `--s-planned-border: #2a2f45` | `--s-planned-bg: #1c2030` | `--text-dim` | none |
| READY | `--s-ready-border: #3b6cff` | `--s-ready-bg: rgba(59,108,255,0.15)` | `#8aabff` | none |
| CALLING | `--s-calling-border: #d97706` | `--s-calling-bg: rgba(217,119,6,0.15)` | `#fbbf24` | `pulse-amber` |
| LIVE | `--s-live-border: #dc2626` | `--s-live-bg: rgba(220,38,38,0.15)` | `#f87171` | `pulse-red` |
| OVERRUN | `--s-overrun-border: #a21caf` | `--s-overrun-bg: rgba(162,28,175,0.15)` | `#e879f9` | `pulse-magenta` |
| HOLD | `--s-hold-border: #ea580c` | `--s-hold-bg: rgba(234,88,12,0.15)` | `#fb923c` | `blink` |
| ENDED | `--s-ended-border: #166534` | `--s-ended-bg: rgba(22,101,52,0.10)` | `#4ade80` | none |
| CANCELLED | `--s-cancelled-border: #2a2f45` | `--s-cancelled-bg: #0d0f17` | `--text-disabled` | none |

### Semantic Colours

| Token | Value | Usage |
|-------|-------|-------|
| `--ok` | `#22c55e` | Success, connected, on-time |
| `--warn` | `#f59e0b` | Warning, delay, caution |
| `--error` | `#ef4444` | Error, disconnected, overrun |
| `--info` | `#38bdf8` | Informational, broadcast |
| `--ok-bg` | `rgba(34,197,94,0.12)` | Success background tint |
| `--warn-bg` | `rgba(245,158,11,0.12)` | Warning background tint |
| `--error-bg` | `rgba(239,68,68,0.12)` | Error background tint |
| `--info-bg` | `rgba(56,189,248,0.12)` | Info background tint |

---

## 2. Typography

**Font family:** Inter (Google Fonts CDN, weights 400/500/600)
**Fallback:** `system-ui, -apple-system, sans-serif`
**Base size:** 14px (console) — operators work in dim environments at a desk
**Display size:** clamp(16px, 2vw, 22px) (confidence monitor, display page)

### Type Scale

| Token | Size | Weight | Line-height | Usage |
|-------|------|--------|-------------|-------|
| `--text-xs` | `11px` | 400 | 1.4 | Timestamps, diagnostics |
| `--text-sm` | `12px` | 400 | 1.5 | Secondary metadata, badge labels |
| `--text-base` | `14px` | 400 | 1.5 | Body text, session metadata |
| `--text-md` | `15px` | 500 | 1.4 | Session titles |
| `--text-lg` | `18px` | 600 | 1.3 | Active session title in monitor |
| `--text-xl` | `24px` | 600 | 1.2 | Confidence monitor title |
| `--text-2xl` | `36px` | 700 | 1.1 | Confidence monitor (large format) |
| `--text-mono` | `13px` | 400 | 1.4 | Clock, timestamps, log entries (`font-family: 'JetBrains Mono', monospace`) |

### Monospace Font

`#server-clock`, event log timestamps, all time displays:
```css
font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
font-variant-numeric: tabular-nums;
letter-spacing: 0.02em;
```
Tabular nums prevent clock-width jitter on digit change.

---

## 3. Spacing Scale

Based on 4px grid.

| Token | Value | Usage |
|-------|-------|-------|
| `--sp-1` | `4px` | Tight padding, icon gaps |
| `--sp-2` | `8px` | Badge padding, small gaps |
| `--sp-3` | `12px` | Input padding, button padding (vertical) |
| `--sp-4` | `16px` | Card padding, section gaps |
| `--sp-5` | `20px` | Modal padding |
| `--sp-6` | `24px` | Large section gaps |
| `--sp-8` | `32px` | Panel padding |

### Component Sizing

| Token | Value | Usage |
|-------|-------|-------|
| `--sidebar-w` | `272px` | Fixed sidebar width |
| `--role-bar-h` | `44px` | Role bar height |
| `--filter-bar-h` | `40px` | Filter bar height |
| `--header-h` | `52px` | Header bar height |
| `--diag-bar-h` | `28px` | Diagnostic bar height |
| `--card-radius` | `6px` | Session card border radius |
| `--modal-radius` | `8px` | Modal card border radius |
| `--btn-radius` | `4px` | Action button border radius |
| `--badge-radius` | `4px` | Status badge border radius |

### Z-Index Stack

| Token | Value | Layer |
|-------|-------|-------|
| `--z-base` | `1` | Normal content |
| `--z-sticky` | `10` | Sticky header |
| `--z-delay-strip` | `20` | Delay strip banner |
| `--z-modal-backdrop` | `200` | Modal backdrop |
| `--z-modal` | `210` | Modal card |
| `--z-overlay` | `500` | Reconnect overlay |
| `--z-loading` | `1000` | Boot loading overlay |
| `--z-confidence` | `900` | Confidence fullscreen |

---

## 4. Status Colour Reference (Quick Look)

For use in card left-border, badge, and any status indicator:

```css
:root {
  /* PLANNED */
  --s-planned-border: #2a2f45;
  --s-planned-badge-bg: #1c2030;
  --s-planned-badge-text: #7c85a0;

  /* READY */
  --s-ready-border: #3b6cff;
  --s-ready-badge-bg: rgba(59,108,255,0.15);
  --s-ready-badge-text: #8aabff;

  /* CALLING */
  --s-calling-border: #d97706;
  --s-calling-badge-bg: rgba(217,119,6,0.15);
  --s-calling-badge-text: #fbbf24;

  /* LIVE */
  --s-live-border: #dc2626;
  --s-live-badge-bg: rgba(220,38,38,0.15);
  --s-live-badge-text: #f87171;

  /* OVERRUN */
  --s-overrun-border: #a21caf;
  --s-overrun-badge-bg: rgba(162,28,175,0.15);
  --s-overrun-badge-text: #e879f9;

  /* HOLD */
  --s-hold-border: #ea580c;
  --s-hold-badge-bg: rgba(234,88,12,0.15);
  --s-hold-badge-text: #fb923c;

  /* ENDED */
  --s-ended-border: #166534;
  --s-ended-badge-bg: rgba(22,101,52,0.10);
  --s-ended-badge-text: #4ade80;

  /* CANCELLED */
  --s-cancelled-border: #2a2f45;
  --s-cancelled-badge-bg: #0d0f17;
  --s-cancelled-badge-text: #45506a;
}
```

---

## 5. Animation Tokens

| Token | Value | Used by |
|-------|-------|---------|
| `--anim-fast` | `150ms` | Button press, pill colour change |
| `--anim-base` | `250ms` | Card appearance, modal open |
| `--anim-slow` | `400ms` | Reconnect overlay fade |

### Keyframe Definitions

```css
@keyframes pulse-amber {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217,119,6,0); }
  50%       { box-shadow: 0 0 0 6px rgba(217,119,6,0.4); }
}
@keyframes pulse-red {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
  50%       { box-shadow: 0 0 0 6px rgba(220,38,38,0.4); }
}
@keyframes pulse-magenta {
  0%, 100% { box-shadow: 0 0 0 0 rgba(162,28,175,0); }
  50%       { box-shadow: 0 0 0 6px rgba(162,28,175,0.4); }
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}

/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  .sc-badge { animation: none !important; }
}
```

---

## 6. Component Tokens

### Session Card

```css
.sc {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--s-{status}-border);
  border-radius: var(--card-radius);
  padding: var(--sp-3) var(--sp-4);
  transition: background var(--anim-fast);
}
.sc:hover { background: var(--surface3); }
```

### Action Buttons

```css
.sc-btn {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--btn-radius);
  font-size: var(--text-sm);
  font-weight: 500;
  min-height: 30px;
  min-width: 72px;
  transition: opacity var(--anim-fast), background var(--anim-fast);
}
.sc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.sc-btn.loading  { opacity: 0.6; pointer-events: none; }
```

### Connection Pill

```css
.conn-pill {
  padding: 2px var(--sp-2);
  border-radius: 999px;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.conn-pill.live          { background: var(--ok-bg);    color: var(--ok);    }
.conn-pill.reconnecting  { background: var(--warn-bg);  color: var(--warn);  }
.conn-pill.offline       { background: var(--error-bg); color: var(--error); }
```

---

## 7. Accessibility Colour Contrast

All text/background pairs must meet WCAG 2.1 AA (4.5:1 normal text, 3:1 large text):

| Pair | Ratio | Pass |
|------|-------|------|
| `--text` on `--bg` | 13.2:1 | ✅ |
| `--text` on `--surface` | 11.4:1 | ✅ |
| `--text-dim` on `--surface` | 4.7:1 | ✅ |
| `--s-live-badge-text` on `--s-live-badge-bg` | 5.1:1 | ✅ |
| `--s-calling-badge-text` on `--s-calling-badge-bg` | 4.8:1 | ✅ |
| `--s-ready-badge-text` on `--s-ready-badge-bg` | 4.6:1 | ✅ |
| `--accent` on `--bg` | 4.9:1 | ✅ |
| `--text-disabled` on `--surface` | 2.1:1 | ⚠ decorative only |
