#!/usr/bin/env bash
# check-fixture-leaks — sweep for synthetic ops fixtures that outlived their run (THI-1506).
#
# Read-only. Classifies sellers with the canonical synthetic predicate
# (scripts/synthetic-sellers.sql; docs/ops-smoke-policy.md "Audit") and lists
# each synthetic seller with its item counts. Exit codes:
#   0  clean — no non-deleted synthetic items
#   1  LEAK — synthetic sellers still own open (non-deleted) items; the active
#      ones are publicly browsable. Take down same-day (ops-smoke-policy rule 2
#      / moderation runbook step 2), then file the scoped purge (rule 4).
#   2  environment error (compose stack down, bad args)
# Synthetic sellers with ZERO items are purge backlog, not a leak — they are
# reported but do not fail the sweep (policy: file, never silently delete).
#
# The daily `synthetic` strip in scripts/daily-metrics.sh surfaces the counts;
# this script is the identity-level follow-up for exactly those rows.
#
# Usage (on the VPS from /opt/thingery, or any checkout with the stack up):
#   scripts/check-fixture-leaks.sh           # human-readable
#   scripts/check-fixture-leaks.sh --json    # JSON array of offender rows
# Same env knobs as daily-metrics.sh (COMPOSE_FILE, POSTGRES_USER, POSTGRES_DB).

set -euo pipefail

JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    *) echo "unknown arg: $1 (usage: $0 [--json])" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRED="$(sed -e '/^--/d' -e '/^$/d' "$SCRIPT_DIR/synthetic-sellers.sql" | tr '\n' ' ')"

db_psql() {
  docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}" exec -T db psql -X \
    -U "${POSTGRES_USER:-thingery}" -d "${POSTGRES_DB:-thingery}" -t -A "$@"
}

# One row per synthetic seller: id, email, created_at, open/active/total items.
# Data rows always carry 6 fields; the trailing awk drops any stray non-data
# line as defense in depth.
# -F$'\t' (ANSI-C quoting): psql's -F does no escape processing — a literal
# backslash-t would make every row single-field and the sweep would falsely
# report "clean" (review-bot finding on THI-1506).
ROWS=$(db_psql -F$'\t' -c "
  SELECT s.id, coalesce(s.email, '(NULL email)'), s.created_at,
         count(i.id) FILTER (WHERE i.status <> 'deleted') AS items_open,
         count(i.id) FILTER (WHERE i.status = 'active')  AS items_active,
         count(i.id) AS items_total
  FROM sellers s LEFT JOIN items i ON i.seller_id = s.id
  WHERE $PRED
  GROUP BY s.id, s.email, s.created_at
  ORDER BY items_open DESC, items_active DESC, items_total DESC, s.created_at" \
  | awk -F'\t' 'NF >= 6') || { echo "sweep failed: is the compose stack up?" >&2; exit 2; }

TOTAL=$(printf '%s\n' "$ROWS" | grep -c . || true)
OPEN=$(printf '%s\n' "$ROWS" | awk -F'\t' '$4 > 0' | grep -c . || true)
ACTIVE=$(printf '%s\n' "$ROWS" | awk -F'\t' '$5 > 0' | grep -c . || true)

if [ "$JSON" = 1 ]; then
  printf '%s\n' "$ROWS" | jq -Rr 'select(length > 0) | split("\t") |
    {seller_id: .[0], email: .[1], created_at: .[2],
     items_open: (.[3] | tonumber), items_active: (.[4] | tonumber),
     items_total: (.[5] | tonumber)}' | jq -s '.'
else
  echo "== synthetic fixture sweep (predicate: scripts/synthetic-sellers.sql) =="
  echo "synthetic sellers: $TOTAL | with open items: $OPEN | with active items: $ACTIVE"
  if [ "$TOTAL" -gt 0 ]; then
    printf 'seller_id\topen\tactive\ttotal\temail\tcreated_at\n'
    printf '%s\n' "$ROWS" | awk -F'\t' '{printf "%s\t%s\t%s\t%s\t%s\t%s\n", $1, $4, $5, $6, $2, $3}'
  fi
fi

if [ "$OPEN" -gt 0 ]; then
  echo "LEAK: $OPEN synthetic seller(s) still own non-deleted items ($ACTIVE active)." >&2
  echo "Take down same-day (ops-smoke-policy rule 2), then file the scoped purge (rule 4)." >&2
  exit 1
fi

[ "$JSON" = 1 ] || echo "no non-deleted synthetic items — clean"
exit 0
