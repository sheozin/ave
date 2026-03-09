# CueDeck Console — UI Upgrade Specification
## PR-UI-001: Visual Foundation Upgrade

**Status:** Draft — awaiting approval
**Scope:** CSS-only visual upgrade, zero JS logic changes
**Goal:** Broadcast control aesthetic — premium, dark, operational, instantly readable under pressure

---

## 1. Design Principles

### 1.1 Core Tenets
1. **Instant status recognition** — A director must identify the LIVE session in < 1 second from normal viewing distance
2. **Information hierarchy over decoration** — Every visual element serves operational clarity
3. **Elevation = importance** — Higher elevation (brighter surface) = more important / more interactive
4. **Color is reserved for status** — Avoid using status colors for decoration
5. **Contrast first** — Minimum 4.5:1 for body text, 7:1 for critical status text

### 1.2 Target Feel
- Broadcast control software (ROSS, Vizrt, vMix)
- Apple Pro Display reference UI
- Mission control terminal — not a web app, not a dashboard

### 1.3 Anti-patterns to remove
- Thin same-weight borders on everything
- Small badges that disappear in peripheral vision
- Status colors used as decoration
- Developer-style monospace labels throughout
- Cramped line heights

---

## 2. Typography Scale

### 2.1 Type Ramp

| Token | Size | Weight | Line-height | Usage |
|-------|------|--------|-------------|-------|
| `--t-2xs` | 10px | 500 | 1.4 | Timestamp, diagnostics, footnotes |
| `--t-xs` | 11px | 500 | 1.4 | Log entries, metadata chips, filter labels |
| `--t-sm` | 12px | 500 | 1.5 | Secondary labels, card metadata, input text |
| `--t-base` | 13px | 400 | 1.5 | Body text, card speaker, card times |
| `--t-md` | 14px | 500 | 1.4 | Card title, sidebar labels, button text |
| `--t-lg` | 16px | 600 | 1.3 | Active session title in sidebar |
| `--t-xl` | 20px | 700 | 1.2 | Clock display (sidebar) |
| `--t-2xl` | 28px | 700 | 1.0 | Clock display (header) |
| `--t-3xl` | 48px | 300 | 1.0 | Stage monitor clock |

### 2.2 Label Style
- Section headers (ACTIVE SESSION, SERVER CLOCK, etc.): `10px / 600 / uppercase / letter-spacing: 0.08em / --text-muted`
- Status badge text: `10px / 700 / uppercase / letter-spacing: 0.06em`
- Card time labels (PLANNED / SCHEDULED / STARTED): `9px / 600 / uppercase / letter-spacing: 0.06em / --text-muted`
- Session title: `14px / 600 / --text-primary`

### 2.3 Font
Keep existing: `Inter, system-ui, -apple-system, sans-serif`

---

## 3. Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--sp-1` | 4px | Tight internal gaps |
| `--sp-2` | 8px | Small internal padding |
| `--sp-3` | 12px | Standard internal padding |
| `--sp-4` | 16px | Card padding, section gaps |
| `--sp-5` | 20px | Between section groups |
| `--sp-6` | 24px | Large section separation |
| `--sp-8` | 32px | Panel separation |

### 3.1 Card Spacing
- Card padding: `14px 16px` (up from ~10px 12px)
- Gap between cards: `8px` (up from 6px)
- Card inner row gap: `8px`

### 3.2 Sidebar Spacing
- Section padding: `14px`
- Section gap: `1px solid` divider or `8px` gap
- Label to content gap: `8px`

---

## 4. Panel & Card Principles

### 4.1 Surface Elevation System

```
Level 0 — Base page:         --bg        #0B0F14
Level 1 — Panel/Sidebar:     --surface   #111827
Level 2 — Card:              --card      #141D2B
Level 3 — Elevated card:     --card-hi   #1A2640
Level 4 — Input/control:     --input-bg  #0F1520
Level 5 — Hover/selected:    --hover     #1E2D45
```

### 4.2 Card Design
- Background: `--card` (#141D2B)
- Border: `1px solid rgba(148,163,184,0.10)` — barely visible, just defines shape
- Border-left: `3px solid transparent` by default, coloured per status
- Border-radius: `8px`
- Box-shadow: `0 1px 3px rgba(0,0,0,0.4)`
- Transition: `border-color 0.15s, box-shadow 0.15s`
- ENDED/CANCELLED cards: 50% opacity (down from 55%/35% — make consistent)

### 4.3 Sidebar Panels
- Background: `--surface` (#111827)
- Section separator: `1px solid rgba(148,163,184,0.08)`
- Section title: `10px / 600 / uppercase / letter-spacing:0.08em / --text-muted`
- No outer borders — sidebar is a distinct surface already

### 4.4 Modal Cards
- Background: `--surface` with subtle shadow
- Border: `1px solid rgba(148,163,184,0.12)`
- Backdrop: `rgba(0,0,0,0.7)` with `backdrop-filter: blur(4px)`

---

## 5. Status Color System

### 5.1 Status Color Tokens

| State | Border / Accent | Background tint | Badge text | Glow |
|-------|----------------|-----------------|-----------|------|
| `PLANNED` | `#3B82F6` | `rgba(59,130,246,0.06)` | `#93C5FD` | none |
| `READY` | `#22C55E` | `rgba(34,197,94,0.07)` | `#86EFAC` | `0 0 12px rgba(34,197,94,0.25)` |
| `CALLING` | `#F97316` | `rgba(249,115,22,0.07)` | `#FDBA74` | `0 0 12px rgba(249,115,22,0.25)` |
| `LIVE` | `#FF3B30` | `rgba(255,59,48,0.10)` | `#FF8B85` | `0 0 20px rgba(255,59,48,0.35)` |
| `OVERRUN` | `#FF00A8` | `rgba(255,0,168,0.10)` | `#FF80D4` | `0 0 20px rgba(255,0,168,0.40)` |
| `HOLD` | `#F97316` | `rgba(249,115,22,0.07)` | `#FDBA74` | none |
| `ENDED` | `rgba(148,163,184,0.15)` | transparent | `#6B7280` | none |
| `CANCELLED` | `rgba(148,163,184,0.08)` | transparent | `#4B5563` | none |
| `BREAK` | `#8B5CF6` | `rgba(139,92,246,0.07)` | `#C4B5FD` | none |

### 5.2 Status Application Rules

**LIVE card:**
- Left border: `4px solid #FF3B30`
- Background tint: `rgba(255,59,48,0.06)` on card
- Box shadow: `0 0 20px rgba(255,59,48,0.2), 0 2px 8px rgba(0,0,0,0.5)`
- Badge: large, pulsing, bright red
- Session number: replaced with red dot `●`

**OVERRUN card:**
- Left border: `4px solid #FF00A8`
- Background tint: `rgba(255,0,168,0.08)`
- Box shadow: `0 0 20px rgba(255,0,168,0.25)`
- Live timer text: `#FF00A8` — impossible to miss
- "OVERRUN" text: bolder, magenta

**READY card (NEXT session):**
- Left border: `3px solid #22C55E`
- Subtle green tint
- Badge: green pulse

**HOLD card:**
- Left border: `3px solid #F97316`
- Subtle orange tint
- Badge: orange blink

**ENDED card:**
- Left border: `3px solid rgba(148,163,184,0.15)`
- Opacity: `0.5`
- No glow

**CANCELLED card:**
- Opacity: `0.35`
- Left border: none
- Strikethrough on title

---

## 6. Button Hierarchy

### 6.1 Button Tiers

**Tier 1 — Primary action (GO LIVE, SET READY)**
- Height: `36px` (up from ~28px)
- Padding: `0 20px`
- Font: `13px / 700 / uppercase / letter-spacing:0.04em`
- Border-radius: `6px`
- Full colour fill — green, amber, red as appropriate

**Tier 2 — Secondary action (HOLD, END SESSION)**
- Height: `32px`
- Padding: `0 16px`
- Font: `12px / 600`
- Semi-transparent fill with coloured border

**Tier 3 — Tertiary/utility (DE-ARM, CANCEL, delay buttons)**
- Height: `28px`
- Font: `11px / 500`
- Ghost style — transparent fill, subtle border

### 6.2 Dangerous Action Style
END SESSION / CANCEL:
- Background: `rgba(239,68,68,0.12)`
- Border: `1px solid rgba(239,68,68,0.35)`
- Color: `#F87171`
- Hover: `background: rgba(239,68,68,0.20)`
- Active (confirm-pending): `background: rgba(239,68,68,0.25); border-color: #ef4444`

### 6.3 Quick Action Buttons (Sidebar)
- Full width
- Height: `38px`
- Left-aligned text with icon
- HOLD: `btn-red` style
- END SESSION: `btn-red` style
- Stage Monitor: `btn-blue` style
- Border-radius: `6px`

---

## 7. Role Tab Styling

### 7.1 Role Buttons
- Height: `30px`
- Padding: `0 14px`
- Font: `11px / 600 / uppercase / letter-spacing:0.06em`
- Default: `background: transparent; color: --text-muted; border: 1px solid rgba(148,163,184,0.15)`
- Active: `background: #1A2640; color: #E5E7EB; border-color: rgba(148,163,184,0.3); box-shadow: 0 1px 4px rgba(0,0,0,0.4)`
- Border-radius: `6px`
- Gap between buttons: `4px`

---

## 8. Card State Styling Reference

### 8.1 Normal state (PLANNED)
```
background: #141D2B
border: 1px solid rgba(148,163,184,0.10)
border-left: 3px solid #3B82F6
box-shadow: 0 1px 3px rgba(0,0,0,0.3)
opacity: 1
```

### 8.2 LIVE state
```
background: linear-gradient(135deg, rgba(255,59,48,0.07) 0%, #141D2B 60%)
border: 1px solid rgba(255,59,48,0.25)
border-left: 4px solid #FF3B30
box-shadow: 0 0 24px rgba(255,59,48,0.2), 0 2px 8px rgba(0,0,0,0.5)
opacity: 1
```

### 8.3 OVERRUN state
```
background: linear-gradient(135deg, rgba(255,0,168,0.08) 0%, #141D2B 60%)
border: 1px solid rgba(255,0,168,0.30)
border-left: 4px solid #FF00A8
box-shadow: 0 0 20px rgba(255,0,168,0.25), 0 2px 8px rgba(0,0,0,0.5)
```

### 8.4 READY state
```
background: #141D2B
border: 1px solid rgba(34,197,94,0.20)
border-left: 3px solid #22C55E
box-shadow: 0 0 12px rgba(34,197,94,0.12)
```

### 8.5 HOLD state
```
background: #141D2B
border: 1px solid rgba(249,115,22,0.20)
border-left: 3px solid #F97316
```

### 8.6 ENDED state
```
background: #141D2B
border: 1px solid rgba(148,163,184,0.07)
border-left: 3px solid rgba(148,163,184,0.15)
opacity: 0.50
```

### 8.7 CANCELLED state
```
background: transparent
border: 1px solid rgba(148,163,184,0.06)
border-left: none
opacity: 0.35
```

---

## 9. Server Clock Styling

### 9.1 Sidebar Clock
```
Font size: 36px
Font weight: 200 (thin, broadcast-style)
Letter-spacing: 0.04em
Color: #E5E7EB
Font variant: tabular-nums
```
Clock details (offset, rtt, sync, tick):
```
Font size: 10px
Color: --text-muted
Font: monospace
```

### 9.2 Header Clock
```
Font size: 26px
Font weight: 700
Color: #F1F5F9
Letter-spacing: 0.02em
```

---

## 10. Event Log Styling

### 10.1 Log Entry Structure
Colour-code by action type:

| Action type | Accent color | Example |
|-------------|-------------|---------|
| State change (GO_LIVE, END, etc.) | `#22C55E` (green) | SESSION_STATUS_CHANGE |
| BOOT / SYSTEM | `#3B82F6` (blue) | BOOT, SYSTEM |
| ESCALATION / ERROR | `#FF3B30` (red) | ESCALATION |
| BROADCAST | `#F97316` (amber) | BROADCAST |
| DELAY | `#FF00A8` (magenta) | DELAY_APPLIED |
| Default | `--text-muted` | Everything else |

### 10.2 Entry Layout
```
.le {
  padding: 5px 10px;
  border-left: 2px solid {action-color};
  margin-bottom: 2px;
  background: rgba(255,255,255,0.02);
  border-radius: 0 4px 4px 0;
}
.le-ts { font-size:10px; color:--text-muted; font-variant:tabular-nums; }
.le-act { font-size:10px; font-weight:700; letter-spacing:0.04em; color:{action-color}; }
.le-det { font-size:11px; color:--text-primary; }
```

---

## 11. Header Bar Styling

### 11.1 Header
```
background: rgba(11,15,20,0.95)
backdrop-filter: blur(12px)
border-bottom: 1px solid rgba(148,163,184,0.10)
height: 52px
```

### 11.2 Diagnostics Bar
Status pills:
- Dot size: `8px` (up from 6px)
- Label: `10px / 600`
- OK state: `--green`
- Warn state: `--amber`
- Error state: `--red`
- Background: `rgba(255,255,255,0.03)` per pill

---

## 12. Broadcast Bar Styling

```
background: rgba(15,21,32,0.97)
border-top: 1px solid rgba(148,163,184,0.10)
backdrop-filter: blur(8px)
padding: 10px 16px
```

Input:
```
background: rgba(255,255,255,0.04)
border: 1px solid rgba(148,163,184,0.15)
border-radius: 6px
color: --text-primary
font-size: 13px
height: 38px
```

SEND button:
```
background: #3B82F6
color: white
font-weight: 700
height: 38px
border-radius: 6px
```

---

## Acceptance Criteria Checklist

- [ ] Director identifies LIVE session in < 1 second
- [ ] NEXT/READY session is clearly next-in-line
- [ ] OVERRUN state is visually alarming
- [ ] Server clock is immediately readable
- [ ] All action buttons have comfortable click targets (≥32px)
- [ ] Dangerous actions (END/CANCEL) are visually distinct
- [ ] Role buttons clearly show active role
- [ ] Event log entries are scannable by type
- [ ] All existing JS selectors and class names work unchanged
- [ ] All 6 role views render correctly
- [ ] No broken event handlers
