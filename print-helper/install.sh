#!/bin/sh
# CueDeck print station installer (Mac or Linux, with Node.js 20+):
#   curl -fsSL https://app.cuedeck.io/print-helper/install.sh | sh -s -- PAIRING-CODE [printer-address]
# Downloads the print station to ~/cuedeck-print-station, finds the Brother
# printer on this network (Mac), pairs it with the code from the desk and
# starts it. Later, start it again with ~/cuedeck-print-station/start.sh
set -e
CODE="$1"; IP="$2"
BASE="https://app.cuedeck.io/print-helper"
DIR="$HOME/cuedeck-print-station"
command -v node >/dev/null 2>&1 || { echo "Install Node.js first (https://nodejs.org), then run this again."; exit 1; }
mkdir -p "$DIR"
cd "$DIR"
for f in cuedeck-print-helper.mjs brother-raster.mjs; do curl -fsSL "$BASE/$f" -o "$f"; done
if [ -z "$IP" ]; then
  echo "Looking for Brother printers on this network..."
  FOUND=$(node cuedeck-print-helper.mjs --find 2>/dev/null | grep -E ': [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  N=$(printf '%s\n' "$FOUND" | grep -c . || true)
  if [ "$N" = "1" ]; then
    IP=$(printf '%s\n' "$FOUND" | sed 's/.*: //')
  elif [ "$N" -gt 1 ] 2>/dev/null; then
    printf '%s\n' "$FOUND" | nl -w1 -s') '
    printf "Which printer? Number: "; read PICK < /dev/tty
    IP=$(printf '%s\n' "$FOUND" | sed -n "${PICK}p" | sed 's/.*: //')
  fi
fi
if [ -z "$IP" ]; then printf "Printer address (e.g. 192.168.1.50): "; read IP < /dev/tty; fi
printf '#!/bin/sh\ncd "%s" && exec node cuedeck-print-helper.mjs --printer %s\n' "$DIR" "$IP" > start.sh
chmod +x start.sh
echo "Printer: $IP. Keep this window open while the event runs."
if [ -n "$CODE" ]; then exec node cuedeck-print-helper.mjs --printer "$IP" --pair "$CODE"; fi
exec node cuedeck-print-helper.mjs --printer "$IP"
