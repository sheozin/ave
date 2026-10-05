#!/usr/bin/env bash
# Usage: scripts/verify-no-public-internals.sh <base-url>
# Fails (exit 1) if an internal file is publicly served or a served page is missing.
set -u
BASE="${1:?usage: $0 <base-url>}"; BASE="${BASE%/}"
MUST_404=(
  CLAUDE.md deploy.md team-rules.md auth-setup.sql supabase-setup.sql .env.example
  scripts/deploy-functions.sh supabase/config.toml
  supabase/functions/stripe-webhook/index.ts supabase/functions/_shared/stripe.ts
  supabase/migrations/061_security_hardening.sql
  docs/outreach/CueDeck_Outreach_Messages_v2.docx
  tests/checkin-policy.spec.ts package.json
  assets/youtube-branding/.auth-state.json
)
MUST_200=(
  / /admin /display /checkin /checkin/desk /cuedeck-console.html /cuedeck-i18n.js
  /favicon.svg /console-manifest.json /console-sw.js /checkin-window.js
  /checkin/setup /checkin-app.css /checkin-csv.js /cuedeck-auth.js
  /checkin-roles.js /checkin-dashboard.js /checkin/dashboard
)
# Vercel's bot protection answers scripted clients with 403 + x-vercel-mitigated
# on every path. That says nothing about the deploy, so it must not read as a
# failure or a pass: exit 2 and say so, and check from a browser instead.
if curl -sI "$BASE/" | grep -qi '^x-vercel-mitigated:'; then
  echo "BLOCKED  Vercel bot protection is challenging this machine; results would be meaningless."
  echo "         Re-run later or check the paths from a browser session."
  exit 2
fi
fail=0
for p in "${MUST_404[@]}"; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$p")
  if [ "$c" = "404" ]; then echo "ok    $c  /$p (hidden)"; else echo "FAIL  $c  /$p (must be 404)"; fail=1; fi
done
for p in "${MUST_200[@]}"; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")
  if [ "$c" = "200" ]; then echo "ok    $c  $p"; else echo "FAIL  $c  $p (must be 200)"; fail=1; fi
done
[ $fail = 0 ] && echo "PASS" || echo "FAILED"
exit $fail
