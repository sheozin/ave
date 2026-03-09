#!/usr/bin/env bash
# CueDeck Edge Function Deployer
# Usage:  bash scripts/deploy-functions.sh           (deploy all)
#         bash scripts/deploy-functions.sh go-live   (deploy one)
set -euo pipefail

PROJ=$(cd "$(dirname "$0")/.." && pwd)
ALL_FUNCTIONS=(go-live end-session set-ready hold-stage call-speaker cancel-session reinstate apply-delay set-overrun invite-operator)
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
  if supabase functions deploy "$func" --project-ref "sawekpguemzvuvvulfbc" --workdir "$PROJ" 2>&1; then
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

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "  WARN: SUPABASE_URL/SUPABASE_ANON_KEY not set -- skipping ping"
else
  for func in "${DEPLOY_LIST[@]}"; do
    RESP=$(curl -s -X POST \
      "${SUPABASE_URL}/functions/v1/${func}" \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
      -H "Content-Type: application/json" \
      -d '{"_ping":true}' \
      --max-time 10 \
      -w "\n%{http_code}" 2>/dev/null)

    HTTP_CODE=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | head -1)

    if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"pong"'; then
      green "$func ping OK (HTTP $HTTP_CODE)"
    else
      red "$func ping FAILED (HTTP $HTTP_CODE) body: $BODY"
    fi
  done
fi

# Summary
echo ""
echo "=================================="
if [ $FAIL -eq 0 ]; then
  echo "  ALL FUNCTIONS DEPLOYED AND VERIFIED"
else
  echo "  $FAIL issue(s) -- check output above"
fi
echo "=================================="
echo ""
exit $FAIL
