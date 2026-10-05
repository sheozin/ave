#!/usr/bin/env bash
# CueDeck Edge Function Deployer
# Usage:  bash scripts/deploy-functions.sh           (deploy all)
#         bash scripts/deploy-functions.sh go-live   (deploy one)
set -euo pipefail

PROJ=$(cd "$(dirname "$0")/.." && pwd)
ALL_FUNCTIONS=(go-live end-session set-ready hold-stage call-speaker cancel-session reinstate apply-delay set-overrun invite-operator create-checkout-session stripe-webhook customer-portal checkin-enable-event checkin-import-attendees checkin-send-qr-emails checkin-record-scans checkin-self-register checkin-kiosk-pair checkin-invite-staff checkin-price checkin-create-checkout)
FAIL=0

green() { echo "  OK  $1"; }
red()   { echo "  FAIL $1"; FAIL=$((FAIL+1)); }

echo ""
echo "=== CueDeck Edge Function Deployer ==="

if [ $# -ge 1 ]; then
  DEPLOY_LIST=("$@")
else
  DEPLOY_LIST=("${ALL_FUNCTIONS[@]}")
fi
echo "  Deploying: ${DEPLOY_LIST[*]}"

# 1. Deploy
echo ""
echo "-- Deploy --"
for func in "${DEPLOY_LIST[@]}"; do
  echo "  -> deploying $func..."
  extra=()
  case "$func" in stripe-webhook|checkin-price|create-checkout-session|customer-portal|send-invoice-email|ai-proxy) extra=(--no-verify-jwt) ;; esac
  if supabase functions deploy "$func" --project-ref "sawekpguemzvuvvulfbc" --workdir "$PROJ" ${extra[@]+"${extra[@]}"} 2>&1; then
    green "$func deployed"
  else
    red "$func FAILED to deploy"
  fi
done

# 2. Ping verification
echo ""
echo "-- Ping verification --"

if [ -f "$PROJ/.env" ]; then
  set -a; source "$PROJ/.env"; set +a
fi

SUPABASE_URL="${SUPABASE_URL:-https://sawekpguemzvuvvulfbc.supabase.co}"
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  # The publishable key is public (it ships in every page), but it is still
  # never echoed here.
  SUPABASE_ANON_KEY=$(supabase projects api-keys --project-ref "sawekpguemzvuvvulfbc" -o json 2>/dev/null \
    | python3 -c 'import json,sys
for k in json.load(sys.stdin):
    if k.get("type") == "publishable" and k.get("api_key"):
        print(k["api_key"]); break' 2>/dev/null || true)
fi

SKIPPED=0
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "  WARN: no publishable key (SUPABASE_ANON_KEY unset and the CLI lookup failed) -- skipping ping"
  SKIPPED=1
else
  for func in "${DEPLOY_LIST[@]}"; do
    if ! grep -q '_ping' "$PROJ/supabase/functions/$func/index.ts" 2>/dev/null; then
      echo "  SKIP $func has no _ping handler, not verified"
      SKIPPED=1
      continue
    fi
    # Sent with the production Origin: a function that answers pong but
    # drops Access-Control-Allow-Origin passes curl and fails every browser.
    HDRS=$(mktemp)
    RESP=$(curl -s -X POST \
      "${SUPABASE_URL}/functions/v1/${func}" \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
      -H "Origin: https://app.cuedeck.io" \
      -H "Content-Type: application/json" \
      -d '{"_ping":true}' \
      -D "$HDRS" \
      --max-time 10 \
      -w "\n%{http_code}" 2>/dev/null || true)
    ACAO=$(grep -i '^access-control-allow-origin:' "$HDRS" | tr -d '\r' | sed 's/^[^:]*: *//' || true)
    rm -f "$HDRS"

    HTTP_CODE=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | head -1)

    if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"pong"' && [ -n "$ACAO" ]; then
      green "$func ping OK (HTTP $HTTP_CODE, ACAO $ACAO)"
    elif [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"pong"'; then
      red "$func ping FAILED: no Access-Control-Allow-Origin for https://app.cuedeck.io"
    else
      red "$func ping FAILED (HTTP $HTTP_CODE) body: $BODY"
    fi
  done
fi

# Summary
echo ""
echo "=================================="
if [ $FAIL -ne 0 ]; then
  echo "  $FAIL issue(s) -- check output above"
elif [ $SKIPPED -eq 1 ]; then
  echo "  DEPLOYED, NOT VERIFIED (ping skipped)"
else
  echo "  ALL FUNCTIONS DEPLOYED AND VERIFIED"
fi
echo "=================================="
echo ""
if [ $FAIL -ne 0 ]; then exit $FAIL; fi
if [ $SKIPPED -eq 1 ]; then exit 3; fi
exit 0
