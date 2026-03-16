#!/bin/bash
# CueDeck Display — Kiosk Launcher
# Opens the signage display page in Chrome kiosk mode with audio enabled.
# Usage: double-click, or pass a display UUID as argument.
#
#   ./Launch\ CueDeck\ Display.command [DISPLAY_UUID]
#
# If no UUID is given, opens the pairing screen.

DISPLAY_URL="https://app.cuedeck.io/display"

# If a display UUID was passed, append it as hash
if [ -n "$1" ]; then
  DISPLAY_URL="${DISPLAY_URL}#id=$1"
fi

echo "Launching CueDeck Display in kiosk mode..."
echo "URL: $DISPLAY_URL"
echo ""

# Launch Chrome in kiosk mode with autoplay audio enabled
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --kiosk \
  --autoplay-policy=no-user-gesture-required \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --noerrdialogs \
  --disable-translate \
  --no-first-run \
  --start-fullscreen \
  "$DISPLAY_URL"
