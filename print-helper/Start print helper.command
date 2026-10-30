#!/bin/bash
# Double-click on a Mac to start the CueDeck print helper.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js first: https://nodejs.org"; read -r -p "Press Return to close"; exit 1; }
read -r -p "Brother printer IP address (e.g. 192.168.1.50): " ip
node cuedeck-print-helper.mjs --printer "$ip"
read -r -p "Stopped. Press Return to close"
