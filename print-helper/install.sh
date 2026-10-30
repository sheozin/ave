#!/bin/sh
# CueDeck print station installer (Mac or Linux, with Node.js 20+):
#   curl -fsSL https://app.cuedeck.io/print-helper/install.sh | sh
# Downloads the print station to ~/cuedeck-print-station, finds the Brother
# or Zebra printer on this network (Mac) and starts it. The first time it
# shows a pairing code (and prints it): type that code in CueDeck.
# With a code made on the desk instead: ... | sh -s -- PAIRING-CODE [printer-address]
# Later, start it again with ~/cuedeck-print-station/start.sh
set -e
CODE="$1"; IP="$2"; MODEL=brother
BASE="https://app.cuedeck.io/print-helper"
DIR="$HOME/cuedeck-print-station"
command -v node >/dev/null 2>&1 || { echo "Install Node.js first (https://nodejs.org), then run this again."; exit 1; }
mkdir -p "$DIR"
cd "$DIR"
for f in cuedeck-print-helper.mjs station-core.mjs brother-raster.mjs zebra-zpl.mjs label-text.mjs; do curl -fsSL "$BASE/$f" -o "$f"; done
if [ -z "$IP" ]; then
  echo "Looking for label printers on this network..."
  FOUND=$(node cuedeck-print-helper.mjs --find 2>/dev/null | grep -E ': [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  N=$(printf '%s\n' "$FOUND" | grep -c . || true)
  if [ "$N" = "1" ]; then
    LINE="$FOUND"
  elif [ "$N" -gt 1 ] 2>/dev/null; then
    printf '%s\n' "$FOUND" | nl -w1 -s') '
    printf "Which printer? Number: "; read PICK < /dev/tty
    LINE=$(printf '%s\n' "$FOUND" | sed -n "${PICK}p")
  fi
  IP=$(printf '%s\n' "${LINE:-}" | sed 's/.*: //')
  case "${LINE:-}" in *[Zz][Ee][Bb][Rr][Aa]*) MODEL=zebra ;; esac
fi
if [ -z "$IP" ]; then
  printf "Printer address (e.g. 192.168.1.50): "; read IP < /dev/tty
  printf "Is it a Zebra? (y/N): "; read Z < /dev/tty
  case "$Z" in [Yy]*) MODEL=zebra ;; esac
fi
printf '#!/bin/sh\ncd "%s" && exec node cuedeck-print-helper.mjs --printer %s --model %s\n' "$DIR" "$IP" "$MODEL" > start.sh
chmod +x start.sh
echo "Printer: $IP ($MODEL). Keep this window open while the event runs."
if [ -n "$CODE" ]; then exec node cuedeck-print-helper.mjs --printer "$IP" --model "$MODEL" --pair "$CODE"; fi
exec node cuedeck-print-helper.mjs --printer "$IP" --model "$MODEL"
