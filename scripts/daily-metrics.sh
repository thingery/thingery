#!/bin/bash
# thingery-daily-metrics — daily-readable funnel metrics (THI-394).
#
# Produces the three funnel numbers, from real events:
#   1. ACTIVATION   — callers (sellers) with >=1 successful tool call in the
#                     window, plus anonymous useful calls
#   2. SEARCH       — searches, share returning >=1 result (query → results),
#                     and click-through: searches followed within 10 minutes
#                     by a successful get_item from the same caller bucket
#   3. LISTINGS     — funnel from logs (attempts → created → visible) cross-
#                     checked against SQL truth (items table)
# plus a small liquidity strip (live items, sellers) and npm downloads.
#
# Organic-only by default (THI-1506): every listings/sellers count and
# `activated_callers` EXCLUDES synthetic ops fixtures — sellers matching the
# canonical predicate in scripts/synthetic-sellers.sql (docs/ops-smoke-policy.md
# "Audit"). NULL-email sellers are legacy accounts and stay organic. The
# `synthetic` strip reports exactly what was excluded (raw = organic +
# synthetic): nonzero synthetic ITEMS mean a fixture outlived its run — sweep
# identities with scripts/check-fixture-leaks.sh and file per policy rule 4.
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Canonical synthetic-seller predicate (WHERE fragment, sellers aliased `s`),
# shared with scripts/check-fixture-leaks.sh. Strip full-line comments and
# blank lines, join to one line for splicing into the SQL below.
PRED="$(sed -e '/^--/d' -e '/^$/d' "$SCRIPT_DIR/synthetic-sellers.sql" | tr '\n' ' ')"

# psql against the compose db service, tuples-only/unaligned (read-only use).
db_psql() {
  docker compose -f "$COMPOSE_FILE" exec -T db psql -X -U "${POSTGRES_USER:-thingery}" \
    -d "${POSTGRES_DB:-thingery}" -t -A "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --out)   OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1 (usage: $0 [--hours N] [--out DIR])" >&2; exit 2 ;;
  esac
done

# --- 0. Synthetic-seller ids (organic-only filtering, THI-1506) --------------
# Needed by the log-side jq (activated_callers). Fault-tolerant: a down DB
# must not abort earlier than the original SQL section did — on failure the
# organic-only log-side exclusion is disabled ([] = exclude nothing) and the
# SQL section below fails as it always has.
SYNTH_IDS=$(db_psql -c "SELECT coalesce(json_agg(s.id), '[]'::json) FROM sellers s WHERE $PRED" | head -1) || SYNTH_IDS="[]"

# --- 1. Capture analytics lines from the app container ----------------------
RAW_LINES=$(docker compose -f "$COMPOSE_FILE" logs --no-log-prefix --since "${HOURS}h" app 2>/dev/null \
  | jq -Rr 'fromjson? // empty' | jq -c 'select(.type == "tool_call" or .type == "tool_result" or .type == "page_view")' || true)

LOG_METRICS=$(printf '%s\n' "$RAW_LINES" | jq -s --argjson synth_ids "${SYNTH_IDS:-[]}" '
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
      # organic-only: ops-fixture callers (synthetic seller ids, section 0) do
      # not count as activation. Anon calls stay unattributable (docs/metrics.md).
      activated_callers: ([$r[] | .sellerId as $sid
        | select(.ok == true and $sid != null and ($synth_ids | index($sid) | not)) | $sid] | unique | length),
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

# --- 1b. Sharing attribution (THI-396 page_view lines) -----------------------
# Origin of public item-page visits: direct / internal / external referrer,
# utm-tagged views, and share-attributable = human views with an external
# referrer or utm params. Unfurl-bot hits (card renderers) are counted but
# excluded from human/attributable views — they are share *evidence*, not visits.
SHARING_METRICS=$(printf '%s\n' "$RAW_LINES" | jq -s '
  (map(select(.type == "page_view"))) as $v
  | ($v | map(select(.bot != true))) as $h
  | {
      item_views: ($v | length),
      item_views_human: ($h | length),
      unfurl_bot_views: (($v | length) - ($h | length)),
      human_by_origin: ($h | group_by(.origin) | map({key: .[0].origin, value: length}) | from_entries),
      top_ref_hosts: ([$h[] | select(.refHost != null) | .refHost]
        | group_by(.) | map({host: .[0], views: length}) | sort_by(-.views) | .[0:5]),
      utm_tagged_views: ([$h[] | select(.utm != null)] | length),
      share_attributable_views: ([$h[] | select(.origin == "external" or .utm != null)] | length)
    }')

# --- 2. SQL truth for the listing funnel + liquidity strip ------------------
# Organic-only by default: the NOT EXISTS/EXISTS clauses against the canonical
# predicate (scripts/synthetic-sellers.sql) split every count into organic
# (headline) and synthetic (leak strip). NULL-email sellers = legacy = organic.
SQL_METRICS=$(db_psql -F'\t' -c "
  SELECT
    (SELECT count(*) FROM items i WHERE i.created_at > now() - interval '${HOURS} hours' AND i.status <> 'deleted'
       AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS sql_created,
    (SELECT count(*) FROM items i WHERE i.created_at > now() - interval '${HOURS} hours' AND i.status <> 'deleted'
       AND (NOT i.photo_required OR cardinality(i.images) > 0)
       AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS sql_published,
    (SELECT count(*) FROM items i WHERE i.created_at > now() - interval '${HOURS} hours' AND i.status <> 'deleted'
       AND i.photo_required AND cardinality(i.images) = 0
       AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS sql_pending_photo,
    (SELECT count(*) FROM items i WHERE i.status = 'active' AND (NOT i.photo_required OR cardinality(i.images) > 0)
       AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS live_items,
    (SELECT count(*) FROM sellers s WHERE s.created_at > now() - interval '${HOURS} hours'
       AND (NOT ($PRED) OR s.email IS NULL)) AS new_sellers,
    (SELECT count(*) FROM sellers s WHERE NOT ($PRED) OR s.email IS NULL) AS sellers_total,
    (SELECT count(*) FROM sellers s WHERE $PRED) AS synthetic_sellers_total,
    (SELECT count(*) FROM items i WHERE i.status <> 'deleted'
       AND EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS synthetic_items_open,
    (SELECT count(*) FROM items i WHERE i.status = 'active'
       AND EXISTS (SELECT 1 FROM sellers s WHERE s.id = i.seller_id AND ($PRED))) AS synthetic_items_active" \
  | head -1)

IFS="	" read -r SQL_CREATED SQL_PUBLISHED SQL_PENDING LIVE_ITEMS NEW_SELLERS SELLERS_TOTAL \
  SYNTH_SELLERS SYNTH_ITEMS_OPEN SYNTH_ITEMS_ACTIVE <<< "$SQL_METRICS"

# --- 3. npm downloads (public API, best effort) ------------------------------
NPM_DL=$(curl -fsS --max-time 10 "https://api.npmjs.org/downloads/point/last-day/thingery" 2>/dev/null | jq -r '.downloads // empty' || true)

# --- 4. Snapshot + human-readable output -------------------------------------
mkdir -p "$OUT_DIR"
SNAP="$OUT_DIR/daily-$(date -u +%F).json"

jq -n \
  --argjson hours "$HOURS" \
  --argjson ctr_window "$CTR_WINDOW" \
  --argjson log "$LOG_METRICS" \
  --argjson sharing "$SHARING_METRICS" \
  --argjson sql_created "${SQL_CREATED:-0}" --argjson sql_published "${SQL_PUBLISHED:-0}" \
  --argjson sql_pending "${SQL_PENDING:-0}" --argjson live_items "${LIVE_ITEMS:-0}" \
  --argjson new_sellers "${NEW_SELLERS:-0}" --argjson sellers_total "${SELLERS_TOTAL:-0}" \
  --argjson synthetic_sellers "${SYNTH_SELLERS:-0}" --argjson synthetic_items_open "${SYNTH_ITEMS_OPEN:-0}" \
  --argjson synthetic_items_active "${SYNTH_ITEMS_ACTIVE:-0}" \
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
     synthetic: { sellers_total: $synthetic_sellers, items_open: $synthetic_items_open, items_active: $synthetic_items_active },
     sharing: $sharing,
     npm_downloads_1d: $npm }' > "$SNAP"

echo "== Thingery daily metrics (window: last ${HOURS}h, saved to $SNAP) =="
jq -r '"activation:      callers with >=1 OK call: \(.activation.activated_callers)  | anon useful calls: \(.activation.anon_useful_calls)  | calls: \(.activation.calls_total) (\(.activation.calls_completed_ok) OK)",
       "search:          \(.search.searches) searches, \(.search.with_results) with results (\(.search.success_pct // "n/a")% success), \(.search.click_through) with follow-up get_item (\(.search.ctr_pct // "n/a")% CTR, 10-min window)",
       "listing funnel:  attempts \(.listings.log_attempts) -> created \(.listings.log_created) -> visible at create \(.listings.log_created_visible) | SQL truth: created \(.listings.sql_created), published \(.listings.sql_published), pending photo \(.listings.sql_pending_photo)",
       "liquidity:       live items \(.liquidity.live_items) | new sellers \(.liquidity.new_sellers) | npm dl (1d) \(.npm_downloads_1d // "n/a")",
       "synthetic:       \(.synthetic.sellers_total) sellers, \(.synthetic.items_open) open items (\(.synthetic.items_active) active) | nonzero items = fixture leak -> scripts/check-fixture-leaks.sh",
       "sharing:         \(.sharing.item_views) item views (\(.sharing.item_views_human) human, \(.sharing.unfurl_bot_views) unfurl bots) | origins \(.sharing.human_by_origin.direct // 0) direct / \(.sharing.human_by_origin.internal // 0) internal / \(.sharing.human_by_origin.external // 0) external | \(.sharing.share_attributable_views) share-attributable | top referrers: \(.sharing.top_ref_hosts | if length > 0 then map("\(.host) x\(.views)") | join(", ") else "none" end)"' "$SNAP"
