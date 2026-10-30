# CueDeck print helper

Prints CueDeck badges straight to a Brother QL label printer (tested
format: QL-820NWB, 62 mm continuous roll DK-22205): no print dialog, no
Brother driver, no paper size to set. Each badge is cut at the label length.

Used for badge layouts that are drawn as an image (Event admin > Badges >
Badge layout, e.g. "Full badge zone 62x76"). Designer badges still print
through the browser.

## Run it (on the desk laptop)

1. Install Node.js 20 or newer (nodejs.org).
2. Put the printer on the same network and find its IP address
   (printer menu, or print the network settings page).
3. Start it:

       node cuedeck-print-helper.mjs --printer 192.168.1.50

   On a Mac you can double-click `Start print helper.command` instead and
   type the printer address when asked.
4. Open the desk in Chrome and click "Print straight to a Brother label
   printer?" at the bottom right once. Chrome may ask to let
   app.cuedeck.io reach devices on this computer: allow it.

Options: `--cut-mm 76` (label length), `--margin-dots 35` (the printer's
own feed before and after each label; if a label comes out longer or
shorter than it should, change this), `--port 7841`.

It listens on this laptop only (127.0.0.1) and takes jobs only from
app.cuedeck.io.
