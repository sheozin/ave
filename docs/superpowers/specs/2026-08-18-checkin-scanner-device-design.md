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

## Every feature is optional per event

Not every event wants session scanning, and some want no door scanning at all — a
small seminar checks people in at a desk and nothing else. Nothing in this build
may be mandatory.

This exposes a muddle in `leod_checkin_entitlements`. It currently holds two
different kinds of flag:

- **Commercial entitlements** — `checkin_core`, `multi_point_scanning`,
  `integration_api`, `pii_in_api`. What the organizer's plan *permits*. Set by
  `checkin-enable-event`, never by the organizer directly.
- **Operational settings** — `auto_send_qr_email` (migration 052),
  `self_registration` and `kiosk_self_print` (both migration 053). What the
  organizer *chose to switch on for this event*. Added following the existing
  shape, but they are not the same kind of thing.

The distinction now matters, because `multi_point_scanning` answers *may they* and
this requirement is *do they want it, here*. Both gates must pass: an event with the
entitlement but the setting off does no session scanning.

**Migration 058 adds a settings concept**, separating the two rather than piling
more booleans into the entitlements table:

- `entrance_scanning` — door scanning on or off for this event
- `session_scanning` — interior scanning on or off, and only usable when
  `multi_point_scanning` is true

Both default **false**. A feature that appears without the organizer asking for it
is a feature they will discover at 8am on a day they did not plan for it.

Whether to move the three existing operational settings across at the same time is
a judgement call for the implementer: it is tidier, but all three are live in
production and read by deployed Edge Functions. The plan treats that as optional and
does not require it.

The organizer sets these where they already set up check-in. The scanner reads them
at pair time and refuses to bind to a scan point whose kind is switched off, with a
message naming the setting rather than an error code.

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

### Decoder

**Chosen: the `barcode-detector` ponyfill (ZXing-C++ compiled to WASM), with the
native `BarcodeDetector` used wherever the browser actually has one.**

```html
<script src="https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js"></script>
```

```js
// The ponyfill implements the same interface as the native API, so this is the
// whole of the branch. Presence of the constructor is not sufficient: test the
// format list, because a browser can ship the object without qr_code.
const native = 'BarcodeDetector' in window &&
  (await BarcodeDetector.getSupportedFormats()).includes('qr_code');
const Detector = native ? BarcodeDetector : BarcodeDetectionAPI.BarcodeDetector;
```

#### The candidates, measured

Sizes are bytes actually served by jsDelivr on 2026-08-18, raw and Brotli
compressed. Every URL below was fetched and returned **HTTP 200**.

| Candidate | Version, released | Wire size (br) | Continuous | Torch | Maintenance | Licence |
|---|---|---|---|---|---|---|
| **`barcode-detector` ponyfill** | 3.2.2, 2026-08-16 | **15 KB** JS + **431 KB** WASM | Yes | Yes | **Active** | MIT (+ Apache-2.0 ZXing-C++) |
| `jsQR` | 1.4.0, 2021-04-24 | 52 KB | Yes | Yes | Stale, 79 issues / 18 PRs | Apache-2.0 |
| `@zxing/browser` | 0.2.1, 2026-07-06 | 104 KB | Yes | Yes | Maintenance mode, "maintainer wanted" | MIT |
| `html5-qrcode` | 2.3.8, 2023-04-15 | 103 KB | Yes | Yes, built in | **Maintenance mode, PRs not merged**, 413 issues | Apache-2.0 |
| `qr-scanner` (Nimiq) | 1.4.2, 2022-11-23 | 6 KB + 10 KB worker | **Fails to load** | n/a | Stale | MIT |
| `BarcodeDetector` native | n/a | **0 bytes** | Yes | Yes | n/a | n/a |

"Continuous" means decoding frames off a `MediaStream` with no shutter tap. Only
`html5-qrcode` and `@zxing/browser` own that loop; with the other options we drive
`requestAnimationFrame` ourselves, which is a handful of lines and is what we want
anyway, because the Task 3 cooldown has to sit inside that loop.

**Torch is reachable in every case that loads**, and does not discriminate between
them: we hold the `MediaStream`, so it is
`track.applyConstraints({ advanced: [{ torch: true }] })` regardless of decoder.
Note that WebKit does not expose the `torch` capability at all, so on an iPhone the
control must be hidden rather than shown dead.

#### `BarcodeDetector` on iOS Safari: no

This is the question that decides whether the native path is a solution or a
fallback, so it is worth being unambiguous.

**There is no usable `BarcodeDetector` on any iOS browser.** WebKit has it behind
**Settings > Safari > Advanced > Feature Flags > Shape Detection API**, off by
default, on every version from iOS 17.0 through 26.5. It cannot be enabled
programmatically, and it has been reported broken since iOS 18 even when the flag
is on. Every browser on iOS is WebKit underneath, so Chrome and Firefox for iOS
inherit the same gap. Chrome's own platform coverage is also narrower than the
compatibility tables suggest: the implementation delegates to a native OS service,
so it exists on Android (Play Services), macOS (the Vision framework) and ChromeOS,
and **not on Windows or Linux**, where the constructor is simply absent.

AVE's staff carry iPhones. A decoder that misses the entire target fleet is not the
decoder, and the native API is therefore treated strictly as a free optimisation for
the Android and macOS cases. **The WASM decoder is the primary path, not the
fallback**, and it is the one that has to be good.

#### What was rejected, and why

- **`qr-scanner` (Nimiq)** — disqualified outright, not on quality. It loads its
  decoder with `import("./qr-scanner-worker.min.js")`, a *relative* dynamic import
  that resolves against the document rather than the CDN, so from a plain script tag
  it 404s against our own origin. The escape hatch is gone too: setting
  `QrScanner.WORKER_PATH` now logs *"not required and not supported anymore"* and is
  ignored. It cannot work without a bundler, which is exactly the constraint we have.
- **`html5-qrcode`** — the README states the project is in maintenance mode, the
  author is looking for new owners, and **pull requests are not being merged**. 413
  open issues, nothing released since April 2023. It also wants to own its own UI,
  and this build needs a bespoke verdict screen readable at arm's length. 103 KB to
  inherit an unmaintained decoder plus a UI we would fight is a bad trade.
- **`@zxing/browser` / `@zxing/library`** — genuinely still receiving releases, and
  the nicest ready-made camera API of the lot. Rejected because it is the *JavaScript*
  port of ZXing, which upstream describes as maintenance mode with "no active
  development or roadmap" and a maintainer-wanted badge. The WASM option is the same
  algorithm lineage, actively developed, and a quarter of the JavaScript.
- **`jsQR`** — not rejected. **Held as the fallback.** It is the smallest thing that
  works, has no WASM and no second origin to fetch from, and its one dependency is a
  canvas. Its problems are that it has had no release since April 2021 and that its
  binarizer is a single pass with no retry, which is precisely the weakness that
  glare and moiré exploit. If the phone test finds the WASM download or its per-frame
  cost unacceptable, jsQR is the swap, and it is a one-function change.

#### Why the WASM one wins

ZXing-C++ is the actively developed member of the ZXing family and is what the
polyfill ecosystem has converged on; the JavaScript ports are both frozen. The
ponyfill was released **two days before this decision** against a `zxing-wasm` build
from four days before, which is the only candidate here that is not measured in
years since last touch.

It also gives us the branch above for free. Because it implements the native
interface rather than a competing one, "native where available, WASM otherwise" is
one ternary and one code path, not two decoders to keep in step.

The no-build constraint holds, and this was verified rather than assumed: the IIFE
bundle carries a **hardcoded default `locateFile` pointing at
`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm`**,
so the binary resolves with no asset path, no bundler and no configuration.

#### Verified so far, and by what

Served over `http://127.0.0.1`, in desktop Chromium, all four viable candidates were
loaded from their CDN and **decoded the real seeded token**
(`52e8f3bb674246f2b34b018d8ed473c0`, the same payload `qr-email.ts` produces) off a
canvas. Steady-state cost of one decode attempt on a 1280x720 frame with a 200 px
code in it:

| | native | ponyfill (WASM) | jsQR | ZXing-JS |
|---|---|---|---|---|
| ms per frame | 11.8 | 27.3 | 26.8 | 4.7 |

Every one of these is inside a 30 fps budget, so **per-frame cost does not separate
the candidates** and should not be used to choose between them.

**This is weak evidence and must not be read as a result.** It was a synthetic,
perfectly-lit, head-on canvas, on desktop hardware, with no camera in the loop. It
establishes that the CDN wiring works and the libraries decode our exact payload. It
says nothing about the actual question.

#### Outstanding: the measurement only a human can take

**The decision is provisional until someone runs the spike on a phone.** The whole
premise of this build is a phone camera reading a QR on *another phone's screen* at
arm's length in a bright lobby, and no amount of desktop testing substitutes for it.

The spike is at `.superpowers/qr-decoder-spike.html` (gitignored). It loads each
candidate from its CDN, opens the rear camera, lets the tester switch decoder without
reloading, and reports time to first decode, a running count, decode rate and
per-frame cost. Point it at `.superpowers/qr-test-badges.html` on a second screen.

What has to be recorded, per decoder, **on an iPhone**, since that is the fleet:

1. Time to first decode, arm's length, off a phone screen.
2. Decode rate once it has locked on, and whether it holds lock or flickers.
3. Behaviour against a phone at full brightness (glare) and at low brightness
   (the failure people actually hit), and in dark-mode inverted rendering.
4. Whether the WASM download is tolerable on venue wifi from a cold cache.

> **`getUserMedia` requires HTTPS or localhost.** Opening the spike on a phone via a
> LAN IP over plain `http://` gives you no camera at all and **fails silently** —
> `navigator.mediaDevices` is simply not there. This is the single most likely reason
> the spike appears broken. On Android, allowlist the origin in
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. **iOS Safari has no
> equivalent flag**, so for an iPhone run a tunnel (`cloudflared tunnel --url
> http://127.0.0.1:7230`) and open the `https://` URL it prints. The spike detects
> this and says so in a red banner rather than letting it fail quietly, and the same
> warning belongs in the runbook (Task 8) because it is a live deployment failure,
> not just a spike one.

#### One risk this decision creates

The WASM is a **431 KB fetch from a third-party CDN**, and this device is specified
to keep working offline. If the binary has not been fetched before the network dies,
the scanner does not decode at all — a worse failure than a stale cache, because it
looks like a broken camera. jsQR has the same shape of problem at 52 KB from one
origin, which is a smaller surface but not a different one.

Task 6 must therefore **warm the decoder at pair time**, while the device is
demonstrably online and someone is watching it, rather than lazily at first scan in
a doorway. Whether that is enough, or whether this needs a service worker pinning
both the page and the binary, is a call for Task 6 with the phone measurements in
hand.

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
