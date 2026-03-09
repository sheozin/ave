#!/bin/bash
# CueDeck Console Launcher
# Double-click this file to start the server and open the console.

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=7230

# Check if already running on this port
if lsof -Pi :$PORT -sTCP:LISTEN -t &>/dev/null; then
  echo "✓ Server already running on port $PORT"
else
  echo "Starting CueDeck server on port $PORT..."
  cd "$DIR"
  python3 -m http.server $PORT &>/dev/null &
  sleep 1
  echo "✓ Server started"
fi

# Open console in default browser
open "http://127.0.0.1:$PORT/cuedeck-console.html"
echo "✓ Console opened in browser"
echo ""
echo "Close this window to stop the server when done with your event."
echo "Server PID: $(lsof -ti:$PORT)"

# Keep terminal open so server stays alive (Ctrl+C or close window to stop)
wait
