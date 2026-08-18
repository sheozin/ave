# Check-in Scanner — Operator Runbook

> **Written ahead of the build.** The scanner page (`cuedeck-scanner.html`) does not
> exist yet; this documents the platform behaviour and the deployment traps that are
> already settled, so they are not rediscovered at 7am. Sections marked
> **UNVERIFIED** are waiting on a real phone test.

The scanner is a roaming device. Staff carry a phone to a door or a session room,
point it at an attendee's QR code, and admit them. It is bound to **one scan point**
and cannot be moved to another without re-pairing.

---

## Which devices work

Any phone, tablet or laptop with a rear camera and a modern browser. There is **no
app to install** and no per-platform build — one page, one code path.

| Platform | Decoder used | Notes |
|---|---|---|
| **Android — Chrome** | **Native**, via Play Services | Fastest. The 431 KB decoder may never download. |
| **iPhone / iPad — any browser** | WASM ponyfill | Every iOS browser is WebKit underneath. See below. |
| **Windows — Chrome or Edge** | WASM ponyfill | Fully supported. No native barcode API on Windows. |
| **macOS — Chrome or Safari** | Native on Chrome (Vision framework), WASM on Safari | Both work. |
| **ChromeOS** | Native | |
| **Linux — Chrome** | WASM ponyfill | Fully supported. |

**Nothing is second-class.** The WASM decoder is the primary path by design, because
it is the one iPhones use, and iPhones are most of the fleet. Platforms with a native
decoder simply get a free speed-up.

### Why iPhones cannot use the fast path

Apple ships the barcode API behind **Settings → Safari → Advanced → Feature Flags →
Shape Detection API**, switched **off by default** on every version from iOS 17.0
through 26.5. It cannot be enabled from a web page, and has been reported broken
since iOS 18 even with the flag on. Chrome and Firefox for iOS inherit this, because
iOS requires them to use WebKit.

Do not attempt to talk staff through enabling that flag. The WASM decoder works
without it.

**Installing Chrome on an iPhone does not help.** Checked 2026-08-18: the EU's DMA
does permit alternative browser engines on iOS, but Chrome has not shipped one —
Apple's certification requirements are onerous enough that no major browser has made
the switch. The only publicly available iOS browser running an alternative engine is
Perplexity's Comet (Blink, March 2026). Chrome, Firefox, Edge, Brave and Arc on iOS
are all WebKit and all inherit the same disabled API.

---

## ⚠️ Open it in the browser, not inside another app

**Android:** opening the scanner link from inside Slack, WhatsApp, Teams or Gmail
launches it in an in-app **WebView**, not Chrome. A WebView does not reliably get
Play Services barcode detection, so the device silently falls back to the slower WASM
decoder — and camera permission behaves differently, sometimes failing outright.

**Tell staff: open the link in Chrome.** On Android, the in-app browser has a
three-dot menu with **Open in Chrome**. It is worth doing this once per device and
then bookmarking the page.

**iPhone:** the same advice applies for consistency, though the decoder is the same
either way.

---

## ⚠️ HTTPS is required, and failure is silent

`getUserMedia` — the browser API that opens the camera — **only works on HTTPS or
localhost.** Served over plain `http://` from a laptop's LAN address, the camera API
is simply absent. There is no error dialog. The page appears to load and the camera
never opens.

**This is the single most likely reason the scanner looks broken.**

At a real event the scanner must be served over HTTPS. For testing from a laptop:

- **Android:** allowlist the origin in `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
- **iPhone:** there is no equivalent flag. Use a tunnel:
  ```
  cloudflared tunnel --url http://127.0.0.1:7230
  ```
  then open the `https://` address it prints.

---

## Pairing a scanner

1. On the desk, an **organizer** opens **Set up a kiosk** and chooses **Scanner**
2. Pick which scan point this device covers — the door or the session room
3. Read the 8-character code aloud to whoever holds the phone
4. On the phone, open the scanner page and type the code

The code is **single-use** and expires in **10 minutes**. If it is lost or expires,
mint another — nothing is stuck, and a mistyped code burns nothing.

The bound scan point is shown permanently in the header. Staff carrying two scanners
must be able to tell at a glance which door each is for.

**The decoder is downloaded at pairing**, while the device is demonstrably online.
Do not pair a device and then walk it somewhere with no signal before its first scan.

---

## Camera permission

Requested on the **first scan**, not when the page opens. If someone declines it, the
browser will not ask again from the page — it has to be re-granted in browser
settings:

- **Android Chrome:** tap the padlock in the address bar → Permissions → Camera
- **iOS Safari:** Settings → Safari → Camera, or the **aA** menu → Website Settings

Three failures are handled explicitly, each with a next step on screen: permission
denied, no camera on the device, and **camera already in use by another app**. The
third is common on a shared event phone and looks like a crash if you do not know it.

---

## During the event

**Battery.** Continuous camera use is heavy. Assume a phone will not last a full day
scanning. Bring power banks, and consider two devices per door rotating.

**Scanning a phone screen.** Ask the attendee to turn their brightness up. A dimmed
screen behind glare is the commonest decode failure, not a broken scanner.

**The same code twice.** A second scan of the same code within a few seconds is
deliberately ignored, so one person holding up a phone does not register dozens of
times. The screen shows a cooldown indicator. This is not a fault.

**Offline.** The scanner keeps working: it holds a list of valid codes and queues
scans, which sync when signal returns. **Offline it shows a verdict but no name** —
the device deliberately carries no attendee names, so that a phone left on a chair
leaks nothing personal.

**When a scan fails.** Send the person to the registration desk. The desk holds the
full roster and can find them by name; the scanner cannot, by design.

---

## Losing a device

Revoke it from the desk immediately: **Set up a kiosk** → the device list →
**Revoke**. This is irreversible — a revoked device must pair again for a new key.

A revoked scanner stops working on its next scan. It cannot be un-revoked, which is
deliberate: a key that could be re-armed is not really withdrawn.

---

## Switching a scanner to a different door

Not possible without re-pairing. A scanner is bound to one scan point by the database
itself. Revoke it and pair it again against the new point.

---

## What this scanner does not do

- **It does not deny anyone entry.** It records who was scanned where. Access control
  — "this ticket type may not enter here" — is a later build.
- **It does not distinguish a re-entry from a duplicate.** Someone who steps out for
  a call and returns currently reads as a repeat scan. Also a later build.
- **It does not print badges.** A roaming device has no printer; that is the desk's job.
- **It does not search by name.** It holds no names.

---

## UNVERIFIED — waiting on a real phone test

The decoder choice is provisional. What has been verified is that every candidate
loads from a CDN and decodes a real token on a desktop. What has **not** been
measured is the thing that decides it: decoding a QR **off another phone's screen**,
at arm's length, in a bright lobby.

Test on **both** an iPhone and an Android phone — they exercise different decoders,
so a good result on one says nothing about the other. Spike page:
`.superpowers/qr-decoder-spike.html`.
