# Check-in desk runbook

How to set up and run the badge printer at a CueDeck check-in desk.
Written for whoever builds the desk on the morning of the event, not for
a developer.

The page is `cuedeck-checkin.html`. It prints badges by itself. There is
no print agent, no driver to install beyond the printer's own, and
nothing to configure inside the page.

---

## 1. Launch the desk

Chrome must be started with two flags. Without them a print dialog opens
on every check-in and the desk stops dead behind it.

```
chrome --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"
```

Replace `<host>` with wherever the page is served from.

The real binary name differs by platform:

| Platform | Command |
|---|---|
| macOS | `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"` |
| Windows | `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"` |
| Linux | `google-chrome --kiosk --kiosk-printing "http://<host>/cuedeck-checkin.html"` |

What the flags do:

- `--kiosk-printing` is the one that matters. It makes `window.print()`
  send the job straight to the default printer with no dialog and no
  preview. Drop it and every badge waits for someone to click Print.
- `--kiosk` hides the browser chrome so a volunteer cannot navigate away
  or close the tab by accident. Useful, not required.

Chrome must be launched fresh with these flags. Adding them to an
already-running Chrome does nothing: opening a new window from an
existing process reuses the flags that process started with. Quit Chrome
completely first.

---

## 2. The badge printer must be the OS default printer

`--kiosk-printing` prints to the system default. It offers no way to
choose a printer, and the page does not ask.

Set the badge printer as the default in the operating system's printer
settings **before** launching Chrome, and confirm nothing else on the
machine has since taken the default (a driver install or a Windows
"manage my default printer" setting will do this silently).

If badges start coming out of the office laser down the corridor, this
is why.

---

## 3. Test against the ACTUAL printer before the event

This is the step that gets skipped and the one that breaks the desk.

Silent printing only stays silent if nothing between Chrome and the
paper wants to ask a question. Anything that raises a prompt turns a
one-second check-in into a queue. The usual causes:

- **Paper size / media type prompts.** The driver asks which tray or
  confirms a non-standard stock. Badge stock is non-standard by
  definition.
- **Tray selection.** Multi-tray printers that prompt rather than
  defaulting.
- **Secure release / PIN printing.** Common on managed office fleets.
  The job sits on the device until someone walks over and types a code.
  Nothing appears on the desk screen.
- **Accounting or cost-centre codes.** Same shape of failure: the job is
  held pending an entry nobody at the desk knows about.
- **"Print using system dialog" driver options** and any driver-side
  confirmation popup.

Turn all of these off in the printer's driver and device settings for
the account Chrome runs as.

Test procedure, on the real printer with the real stock loaded:

1. Launch Chrome with the flags above.
2. Sign in, pick the event, scan or search a test attendee.
3. Press **Check in · Print 1 badge**.
4. A badge should come out with no dialog, no preview and no click.
5. Do it again with a party of three. Three badges, one job, no blanks
   between them.
6. Check a long name (25+ characters) and a name with an accent.

If any of those steps needs a click, the desk is not ready.

---

## 4. When the printer fails mid-event

The desk has a second button for exactly this: **Check in without
printing**.

It records the arrival identically — same outbox, same server write,
same head count — and simply does not print. Use it when the printer
jams, runs out of stock, or goes offline, and hand-write or hand out
badges instead. The check-in data stays correct and nobody has to wait
for the printer to be fixed.

The page does not know whether a badge physically came out. Chrome
reports nothing back once a job has been handed to the operating system,
so a jam, an empty tray or a powered-off printer all look like success
from the desk. **Someone has to watch the printer.** If badges stop
appearing, switch to *Check in without printing* and deal with the
printer separately.

---

## 5. Changing the badge stock size

The default is **100mm × 70mm**, landscape.

Open `cuedeck-checkin.html` and search for `★ BADGE STOCK SIZE ★`. Three
values sit together in that block and all three must change together:

```css
@page { size: 100mm 70mm; margin: 0; }
.badge {
  width: 100mm; height: 70mm;
  ...
}
```

- `@page size` — the physical sheet.
- `.badge width` / `height` — the drawn badge.

If they disagree, Chrome scales the page to fit and every badge prints
small and off-centre.

Also in the same block, adjust if the new stock is much narrower or
wider:

- `padding: 0 6mm` on `.badge` — keeps text off the physical edge, where
  a cutter's tolerance eats a millimetre or two.
- `.badge .nm` / `.co` / `.tt` font sizes — the name, the company and the
  ticket type.

And in the script, next to `BADGE_NAME_PT`:

- `BADGE_NAME_FITS` — roughly how many characters fit across the badge at
  the full name size. Longer names scale down from here rather than
  being clipped, so this number being wrong shows up as names that are
  needlessly small or that wrap when they did not have to.

After any change, reprint the six test cases in section 3.

---

## 6. What the desk records

`badge_printed_at` is stamped on each attendee immediately after the
print job is sent, straight from the desk page with the operator's own
sign-in. It records "this badge was sent to the printer", not "this
badge came out".

Two known gaps, both deliberate:

- **Printing works offline; the stamp does not.** A desk on dead wifi
  still prints badges — the printer is usually on the same table, and
  refusing to print because a database is unreachable would stop the
  desk in exactly the situation the offline mode exists for. The
  timestamp is written locally but is not queued for the server, so it
  is lost the next time the roster refreshes. Check-ins themselves are
  never lost this way; they go through the outbox.
- **A name corrected after printing does not reprint.** The party row
  says *"Badge already printed · reprint needed"* under that person's
  name. Hand them a corrected badge yourself, or check them in again
  with printing on.
