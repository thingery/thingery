#!/bin/bash
# thingery-daily-metrics — daily-readable sprint metrics (THI-394).
#
# Produces the three numbers the adoption sprint optimizes, from real events:
#   1. ACTIVATION   — callers (sellers) with >=1 successful tool call in the
#                     window, plus anonymous useful calls
#   2. SEARCH       — searches, share returning >=1 result (query → results),
#                     and click-through: searches followed within 10 minutes
#                     by a successful get_item from the same caller bucket
#   3. LISTINGS     — funnel from logs (attempts → created → visible) cross-
#                     checked against SQL truth (items table)
# plus a small liquidity strip (live items, sellers) and npm downloads.
#
# Sources (all read-only):
#   - app container stdout (docker compose logs): THI-371 `tool_call` dispatch
#     lines + THI-394 `tool_result` outcome lines (see docs/metrics.md)
#   - Postgres: items/sellers aggregates
#   - public npm downloads API (best effort; null offline)
#
# Output: a human-readable block on stdout AND a JSON snapshot written to
# $THINGERY_METRICS_DIR (default ./metrics) as daily-YYYY-MM-DD.json — the
# durable record, because container logs rotate (10m x 3 files per service).
# Re-running the same day overwrites that day's snapshot (idempotent).
#
# Run on the VPS from /opt/thingery (any checkout with the compose stack up):
#   scripts/daily-metrics.sh                  # last 24h
#   scripts/daily-metrics.sh --hours 168      # week view
# Cron on the VPS (deploy user, daily 00:10 UTC — install steps in
# docs/deploy-vps.md section 6b):
#   10 0 * * * deploy cd /opt/thingery && scripts/daily-metrics.sh >> /var/log/thingery-daily-metrics.log 2>&1
#
# Privacy: aggregates counts only. Raw lines carry no args, queries, item
# data or IPs (docs/metrics.md "Privacy & retention"); snapshots store the
# same counts, so no PII is persisted by this script.

set -euo pipefail

HOURS=24
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
OUT_DIR="${THINGERY_METRICS_DIR:-./metrics}"
CTR_WINDOW=600 # seconds between search and get_item for click-through

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --out)   OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1 (usage: $0 [--hours N] [--out DIR])" >&2; exit 2 ;;
  esac
done

# --- 1. Capture analytics lines from the app container ----------------------
RAW_LINES=$(docker compose -f "$COMPOSE_FILE" logs --since "${HOURS}h" app 2>/dev/null \
  | jq -Rr 'fromjson? // empty' | jq -c 'select(.type == "tool_call" or .type == "tool_result")' || true)

LOG_METRICS=$(printf '%s\n' "$RAW_LINES" | jq -s '
  # ISO ts (with millis) -> epoch seconds
  def sec: (.[0:19] + "Z") | fromdateiso8601;
  (map(select(.type == "tool_result"))) as $r
  | (map(select(.type == "tool_call"))) as $d
  | ($r | map(select(.tool == "search_items" and .ok == true))) as $searches
  | ($r | map(select(.tool == "get_item" and .ok == true))) as $gets
  | {
      dispatches: ($d | length),
      results: ($r | length),
      calls_ok: ([$r[] | select(.ok == true)] | length),
      activated_callers: ([$r[] | select(.ok == true and .sellerId != null) | .sellerId] | unique | length),
      anon_useful_calls: ([$r[] | select(.ok == true and .sellerId == null)] | length),
      searches: ($searches | length),
      searches_with_results: ([$searches[] | select((.results // 0) > 0)] | length),
      search_click_through: (
        [$searches[] | . as $s
          | select([$gets[] | select(
                ((.sellerId // "anon") == ($s.sellerId // "anon"))
                and (((.ts | sec) - ($s.ts | sec)) > 0)
                and (((.ts | sec) - ($s.ts | sec)) <= '$CTR_WINDOW'))] | length > 0)] | length),
      by_tool: ($r | group_by(.tool) | map({key: .[0].tool, value: length}) | from_entries),
      listing_attempts: ([$r[] | select(.tool == "create_listing")] | length),
      listing_created: ([$r[] | select(.tool == "create_listing" and .ok == true)] | length),
      listing_created_visible: ([$r[] | select(.tool == "create_listing" and .visible == true)] | length),
      first_photo_publishes: ([$r[] | select(.tool == "add_item_image" and .ok == true and .visible == true)] | length)
    }')

# --- 2. SQL truth for the listing funnel + liquidity strip ------------------
SQL_METRICS=$(docker compose -f "$COMPOSE_FILE" exec -T db psql -X -U "${POSTGRES_USER:-thingery}" -d "${POSTGRES_DB:-thingery}" \
  -t -A -F'	' -c "
  SELECT
    (SELECT count(*) FROM items WHERE created_at > now() - interval '${HOURS} hours' AND status <> 'deleted') AS sql_created,
    (SELECT count(*) FROM items WHERE created_at > now() - interval '${HOURS} hours' AND status <> 'deleted'
       AND (NOT photo_required OR cardinality(images) > 0)) AS sql_published,
    (SELECT count(*) FROM items WHERE created_at > now() - interval '${HOURS} hours' AND status <> 'deleted'
       AND photo_required AND cardinality(images) = 0) AS sql_pending_photo,
    (SELECT count(*) FROM items WHERE status = 'active' AND (NOT photo_required OR cardinality(images) > 0)) AS live_items,
    (SELECT count(*) FROM sellers WHERE created_at > now() - interval '${HOURS} hours') AS new_sellers,
    (SELECT count(*) FROM sellers) AS sellers_total" \
  | head -1)

IFS="	" read -r SQL_CREATED SQL_PUBLISHED SQL_PENDING LIVE_ITEMS NEW_SELLERS SELLERS_TOTAL <<< "$SQL_METRICS"

# --- 3. npm downloads (public API, best effort) ------------------------------
NPM_DL=$(curl -fsS --max-time 10 "https://api.npmjs.org/downloads/point/last-day/thingery" 2>/dev/null | jq -r '.downloads // empty' || true)

# --- 4. Snapshot + human-readable output -------------------------------------
mkdir -p "$OUT_DIR"
SNAP="$OUT_DIR/daily-$(date -u +%F).json"

jq -n \
  --argjson hours "$HOURS" \
  --argjson ctr_window "$CTR_WINDOW" \
  --argjson log "$LOG_METRICS" \
  --argjson sql_created "${SQL_CREATED:-0}" --argjson sql_published "${SQL_PUBLISHED:-0}" \
  --argjson sql_pending "${SQL_PENDING:-0}" --argjson live_items "${LIVE_ITEMS:-0}" \
  --argjson new_sellers "${NEW_SELLERS:-0}" --argjson sellers_total "${SELLERS_TOTAL:-0}" \
  --argjson npm "${NPM_DL:-null}" \
  '{ generated_at: (now | todateiso8601),
     window_hours: $hours,
     activation: {
       activated_callers: $log.activated_callers,
       anon_useful_calls: $log.anon_useful_calls,
       calls_total: $log.dispatches, calls_completed_ok: $log.calls_ok,
       by_tool: $log.by_tool },
     search: {
       searches: $log.searches,
       with_results: $log.searches_with_results,
       success_pct: (if $log.searches > 0 then (100 * $log.searches_with_results / $log.searches | round) else null end),
       click_through: $log.search_click_through,
       ctr_pct: (if $log.searches > 0 then (100 * $log.search_click_through / $log.searches | round) else null end),
       ctr_window_seconds: $ctr_window },
     listings: {
       log_attempts: $log.listing_attempts, log_created: $log.listing_created,
       log_created_visible: $log.listing_created_visible, log_first_photo_publishes: $log.first_photo_publishes,
       sql_created: $sql_created, sql_published: $sql_published, sql_pending_photo: $sql_pending },
     liquidity: { live_items: $live_items, new_sellers: $new_sellers, sellers_total: $sellers_total },
     npm_downloads_1d: $npm }' > "$SNAP"

echo "== Thingery daily metrics (window: last ${HOURS}h, saved to $SNAP) =="
jq -r '"activation:      callers with >=1 OK call: \(.activation.activated_callers)  | anon useful calls: \(.activation.anon_useful_calls)  | calls: \(.activation.calls_total) (\(.activation.calls_completed_ok) OK)",
       "search:          \(.search.searches) searches, \(.search.with_results) with results (\(.search.success_pct // "n/a")% success), \(.search.click_through) with follow-up get_item (\(.search.ctr_pct // "n/a")% CTR, 10-min window)",
       "listing funnel:  attempts \(.listings.log_attempts) -> created \(.listings.log_created) -> visible at create \(.listings.log_created_visible) | SQL truth: created \(.listings.sql_created), published \(.listings.sql_published), pending photo \(.listings.sql_pending_photo)",
       "liquidity:       live items \(.liquidity.live_items) | new sellers \(.liquidity.new_sellers) | npm dl (1d) \(.npm_downloads_1d // "n/a")"' "$SNAP"
