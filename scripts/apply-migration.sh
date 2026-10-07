#!/usr/bin/env bash
# scripts/apply-migration.sh <file.sql>
# Applies one migration to the linked Supabase project and records it in
# supabase_migrations.schema_migrations IN THE SAME TRANSACTION, so it is
# never recorded without being applied, or applied without being recorded.
# (2026-10-07: a chained command skipped the apply after a failed rebase and
# still ran the record step, so 117 was listed as applied when it was not.)
# Version and name come from the file name: 117_checkin_plus_one_ticket_type.sql
# -> version '117', name 'checkin_plus_one_ticket_type'.
set -euo pipefail
f="${1:?usage: scripts/apply-migration.sh supabase/migrations/NNN_name.sql}"
[ -f "$f" ] || { echo "no such file: $f" >&2; exit 2; }
base=$(basename "$f" .sql)
version=${base%%_*}; name=${base#*_}
[[ "$version" =~ ^[0-9]+$ ]] || { echo "file name must start with a number: $base" >&2; exit 2; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{ echo "BEGIN;"; cat "$f"; echo ";"
  echo "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$name') ON CONFLICT (version) DO NOTHING;"
  echo "COMMIT;"; } > "$tmp"
out=$(/opt/homebrew/bin/supabase db query --linked -f "$tmp" 2>&1) || true
if grep -q '"_tag":"Error"\|ERROR:' <<<"$out"; then
  echo "FAILED, nothing applied or recorded: $(grep -o 'ERROR:  [^\\]*' <<<"$out" | head -1)" >&2
  exit 1
fi
rec=$(/opt/homebrew/bin/supabase db query --linked "select count(*) n from supabase_migrations.schema_migrations where version = '$version'" 2>/dev/null | grep -o '"n": [0-9]*' | grep -o '[0-9]*$')
[ "$rec" = "1" ] || { echo "applied but the record is missing" >&2; exit 1; }
echo "applied and recorded $version $name"
