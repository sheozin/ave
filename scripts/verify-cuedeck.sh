#!/usr/bin/env bash
# ============================================================
# CueDeck Pre-Handoff Verification Script
# Run after any code change before handing off to user testing
# Usage: bash scripts/verify-cuedeck.sh [PORT]
# ============================================================

PORT=${1:-7230}
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

green() { echo "  ✅ $1"; }
red()   { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info()  { echo ""; echo "── $1 ──"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     CueDeck Verification Agent v1.0        ║"
echo "╚══════════════════════════════════════════╝"

# ── 1. Server reachable ───────────────────────
info "Server"
STATUS=$(curl -s -L -o /dev/null -w "%{http_code}" "$BASE/cuedeck-console.html")
if [ "$STATUS" = "200" ]; then
  green "Server reachable at $BASE"
  PASS=$((PASS+1))
else
  red "Server not reachable at $BASE (HTTP $STATUS)"
fi

# ── 2. Console HTML structure ─────────────────
info "Console HTML"
HTML=$(curl -s -L "$BASE/cuedeck-console.html")

checks=(
  "SUPABASE_URL"
  "SUPABASE_ANON_KEY"
  "renderSessions"
  "renderSignagePanel"
  "buildDisplayUrl"
  "launchDisplay"
  "sendBroadcast"
  "setRole"
  "async function boot"
  "bc-bar"
  "bc-presets"
  "disp-modal"
  "spon-modal"
)

for check in "${checks[@]}"; do
  if echo "$HTML" | grep -q "$check"; then
    green "Console contains: $check"
    PASS=$((PASS+1))
  else
    red "Console MISSING: $check"
  fi
done

# ── 3. Display HTML structure ─────────────────
info "Display HTML"
DISP=$(curl -s -L "$BASE/cuedeck-display.html")
disp_checks=(
  "fromHash"
  "fromQuery"
  "bootDisplay"
  "renderSchedule"
  "renderSponsors"
  "renderBreak"
  "sendHeartbeat"
  "activeMode"
  "CueDeck Display"
)
for check in "${disp_checks[@]}"; do
  if echo "$DISP" | grep -q "$check"; then
    green "Display contains: $check"
    PASS=$((PASS+1))
  else
    red "Display MISSING: $check"
  fi
done

# ── 4. Launch link format ─────────────────────
info "Launch Link"
if echo "$HTML" | grep -q 'a class="launch"'; then
  green "Launch button is an <a> tag (not blocked by popup blocker)"
  PASS=$((PASS+1))
else
  red "Launch button is NOT an <a> tag — will be blocked by popup blocker"
fi

if echo "$HTML" | grep -q 'buildDisplayUrl'; then
  green "buildDisplayUrl function exists"
  PASS=$((PASS+1))
else
  red "buildDisplayUrl function missing"
fi

# ── 5. Hash param support ─────────────────────
info "Hash Params (file:// compatibility)"
if echo "$DISP" | grep -q 'location.hash'; then
  green "Display reads hash params (file:// compatible)"
  PASS=$((PASS+1))
else
  red "Display does NOT read hash params"
fi

# ── 6. Storage RLS fix present ────────────────
info "Storage Upload"
if echo "$HTML" | grep -q 'Upload failed:'; then
  green "Upload error handling present"
  PASS=$((PASS+1))
else
  red "Upload error handling missing"
fi

# ── 7. Broadcast bar ─────────────────────────
info "Broadcast Bar"
if echo "$HTML" | grep -q 'bc-char'; then
  green "Character counter present"
  PASS=$((PASS+1))
else
  red "Character counter missing"
fi
if echo "$HTML" | grep -q 'bc-presets'; then
  green "Presets bar present"
  PASS=$((PASS+1))
else
  red "Presets bar missing"
fi

# ── 8. Migrations present ────────────────────
info "Migrations"
PROJ=$(dirname "$0")/../supabase/migrations
if [ -f "$PROJ/001_remove_dev_policies.sql" ]; then
  green "Migration 001_remove_dev_policies.sql present"
  PASS=$((PASS+1))
else
  red "Migration 001_remove_dev_policies.sql MISSING"
fi
if [ -f "$PROJ/002_add_commands_table.sql" ]; then
  green "Migration 002_add_commands_table.sql present"
  PASS=$((PASS+1))
else
  red "Migration 002_add_commands_table.sql MISSING"
fi

# ── 9. No hardcoded secrets ───────────────────
info "Secrets"
AUTH=$(cat "$(dirname "$0")/../auth-setup.sql" 2>/dev/null)
if echo "$AUTH" | grep -q 'CueDeck#'; then
  red "Hardcoded password still in auth-setup.sql"
else
  green "No hardcoded password in auth-setup.sql"
  PASS=$((PASS+1))
fi

# ── 10. Tests pass ────────────────────────────
info "Test Suite"
if command -v npm &>/dev/null && [ -f "$(dirname "$0")/../package.json" ]; then
  if npm test --prefix "$(dirname "$0")/.." --silent 2>/dev/null; then
    green "All unit tests pass (npm test)"
    PASS=$((PASS+1))
  else
    red "Unit tests FAILING — run npm test for details"
  fi
else
  red "npm or package.json not found — cannot run tests"
fi

# ── Summary ───────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo "  ✅ ALL $TOTAL CHECKS PASSED — safe to hand off"
else
  echo "  ❌ $FAIL/$TOTAL CHECKS FAILED — fix before handing off"
fi
echo "══════════════════════════════════════════"
echo ""
exit $FAIL
