# Check-in Module — Scanner Device — Design Spec (Build A)

## What this is

The third sub-project of the check-in module, after QR/email delivery and the
registration desk. A **roaming camera scanner**: staff walk to a door or a session
room, point a phone at an attendee's QR, and admit them.

This spec covers **entrance scanning and session attendance** only. Two related
features were deliberately split out because each needs schema this database does
not have:

- **Access control** (Build B) — nothing currently expresses "a `vip` ticket may
  enter the VIP lounge, an `attendee` may not". That is a new relation between
  ticket types and scan points, and the first time the scanner must render a hard
  DENY to someone standing in front of it.
- **Re-entry semantics** (Build C) — today a second scan is `duplicate`. At a door
  people legitimately leave and return all day, so `duplicate` is wrong on every
  one of them. Fixing it changes how `scan_events` is read everywhere, including
  any report this build produces.

Building A first yields something usable at a real event and starts generating
attendance data, without waiting on either schema decision.

## What the schema already settles

Three constraints are already in the database and are not open for redesign:

- `leod_checkin_devices.kind` allows `scanner`, and a CHECK enforces that a scanner
  **must** carry a `scan_point_id`. A scanner is always bound to one place.
- `leod_checkin_scan_points.kind` is `entrance` or `interior`.
- `leod_checkin_entitlements.multi_point_scanning` is **written** by
  `checkin-enable-event` (line 84) when an organizer enables check-in, but is
  **read by nothing** — no code gates any behaviour on it. This build is the first
  to enforce it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Whose device | Either — same page, paired per device | Pairing already works; no reason to constrain hardware |
| Auth | Device key, exactly as the kiosk | A roaming phone has no operator session and must not hold one |
| Offline cache | **Tokens only. No names, emails or companies** | A phone left on a chair must leak nothing personal |
| Verdict display | Name + ticket type **when online**; bare verdict offline | See the conflict note below |
| Scan input | Camera, continuous | The point of this device; a gun would defeat roaming |

### The cache/display conflict, stated plainly

Caching only tokens and showing names cannot both hold offline. The resolution:
the token cache answers admit-or-deny locally, and the **name is fetched per scan
when online**. Offline the screen shows a verdict and no identity.

The cost is real: the most useful display disappears exactly when the network does,
which at a badly-covered door is when staff most want to check a badge against a
face. The alternative — caching names — puts the attendee list on a device that
roams and gets left on chairs. For a device that is by definition not on a staffed
table, the exposure is the worse risk.

## Architecture

A new standalone page, `cuedeck-scanner.html`, matching the repo's single-file
convention. It does **not** live inside `cuedeck-checkin.html`: that file is already
3,768 lines carrying the desk, the kiosk and the mint modal, and a fourth mode with
a camera and its own permission lifecycle would make it unreviewable.

Auth reuses the kiosk's proven path: `checkin-kiosk-pair` mints a code, the scanner
claims it, and the device key lands in localStorage. `leod_checkin_devices.kind` is
`scanner` rather than `kiosk`, and the pairing must carry the `scan_point_id` the
device is bound to.

### Camera

`getUserMedia` with `facingMode: 'environment'`, decoded in-page. The repo has no
build step, so the decoder must be a single CDN script with no bundler — the same
constraint that led `qr-email.ts` to `qrcode-generator`. That library **encodes
only**; a decoder is a separate dependency and choosing it is the first
implementation task.

Requirements the decoder must meet: continuous scanning without a shutter tap,
tolerance of a QR displayed on another screen (glare, backlight, moiré), and a
torch control where the browser exposes one. Lobbies are dark and phone screens
are reflective.

**Duplicate suppression is mandatory.** A continuous decoder fires many times a
second on the same code. Without a per-token cooldown the same attendee generates
dozens of scan events in the seconds they hold their phone up.

### Recording a scan

Scans go through `checkin-record-scans`, which already exists, is deployed, and
already accepts `scan_point_id` — it is threaded through and currently always null
because the desk has no scan points. This build is what makes that parameter real.

Two changes are needed:

1. The function must accept a **device key** as an alternative to an operator JWT,
   validated as `checkin-self-register` validates the kiosk's. A roaming scanner
   has no user session.
2. It must enforce `multi_point_scanning` when the target scan point is `interior`.
   An entrance scan is core check-in; scanning people into individual sessions is
   the paid feature the entitlement was created for.

### Offline model

The token cache is a list of `qr_token` values for the event and nothing else — no
names, no emails, no companies, no ids. It answers one question: is this code on
this event's list. Scans queue in an outbox and flush exactly as the desk's does,
reusing `enqueue` / `replayOrder` / `markSynced` and the `client_id` dedup index
from migration 053.

Because the cache holds no `checked_in_at`, the scanner cannot distinguish a first
scan from a repeat while offline. It shows "on the list" and lets the server decide.
This is honest rather than confident, and it is also why Build C matters: the server
will currently answer `duplicate` for a legitimate re-entry.

## Session attendance

Nothing new is stored. `scan_events` already records attendee, scan point and time,
so per-session attendance is a **query**, not a feature:

```sql
SELECT sp.name, count(DISTINCT se.attendee_id) AS attended
  FROM leod_checkin_scan_events se
  JOIN leod_checkin_scan_points sp ON sp.id = se.scan_point_id
 WHERE se.event_id = $1 AND sp.kind = 'interior' AND se.result = 'ok'
 GROUP BY sp.name;
```

A minimal report belongs in this build. Attendance data nobody can read is not a
feature — it is a table that grows.

## Security

- No `innerHTML` anywhere. Attendee names arrive from a kiosk a stranger typed into.
- The device key is a credential: never logged, never rendered, never in a URL.
- Camera permission is requested on first scan, not on page load — a permission
  prompt before the operator has decided to scan trains people to dismiss it.
- The token cache is the only attendee data on the device and must be cleared when
  the device is revoked or the event is switched.
- Revoked devices are rejected, reusing migration 057's `revoked_at`.

## Out of scope

- Access control and the DENY screen (Build B)
- Re-entry semantics (Build C)
- Badge printing — a roaming scanner has no printer
- Attendee lookup by name — the scanner holds no names by design; a failed scan
  sends the person to the desk, which does have them
- Offline identity display, as argued above
