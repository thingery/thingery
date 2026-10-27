#!/usr/bin/env bash
# End-to-end adoption demo (THI-391): agent lists a photo'd item → separate
# buyer query finds it → the public item page is live.
#
# Drives a RUNNING Thingery deployment through the complete new-user flow over
# real HTTP, the same surface an MCP agent uses:
#
#   1. onboarding      POST /api/signup                      → seller API key (thg_...)
#   2. schema discovery tools/call describe_category        → sneakers attribute shape
#   3. create listing  tools/call create_listing            → PENDING (hidden, needs photo)
#   4. buyer query #1  tools/call search_items (anonymous)  → 0 results — photo gate works
#   5. add photo       tools/call add_item_image            → published, visible in feeds
#   6. buyer query #2  tools/call search_items (anonymous)  → finds the item
#   7. public page     GET /item/:id                        → 200, title + og:image present
#
# Every step is scriptable — no manual magic. Anonymous buyer queries carry no
# credentials at all, proving search is public. Runs against any deployment:
#
#   scripts/demo-e2e.sh                          # https://thingery.dev (prod)
#   BASE_URL=http://localhost:3000 scripts/demo-e2e.sh
#
# Env overrides:
#   BASE_URL        deployment root (default https://thingery.dev)
#   SELLER_API_KEY  reuse an existing thg_ key instead of signing up a fresh
#                   demo seller (signup is rate-limited 10/h per IP)
#   DEMO_PHOTO      path to a JPEG/PNG/WebP < 5 MB (default scripts/demo-photo.jpg)
#   KEEP            set to keep the listing active (default: the script marks
#                   the demo listing 'reserved' so prod search stays clean)
#
# Secrets stay in the environment; nothing is logged except the item URL.
set -u

BASE="${BASE_URL:-https://thingery.dev}"
KEY="${SELLER_API_KEY:-}"
PHOTO="${DEMO_PHOTO:-$(dirname "$0")/demo-photo.jpg}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0; FAIL=0; STEP=""
log() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); log "  PASS  ${STEP}${1:+ — $1}"; }
bad() { FAIL=$((FAIL+1)); log "  FAIL  ${STEP}${1:+ — $1}"; }
section() { STEP="$1"; log ""; log "== $1"; }

# assert_eq <desc> <got> <want>
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2' want '$3')"; fi; }
assert_ne() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1 (got '$2', must differ)"; fi; }

# mcp <api-key-or-empty> <tool> <json-args> → raw transport reply (SSE-framed or JSON)
mcp() {
  local key="$1" tool="$2" args="${3:-{\}}"
  # ${auth[@]+...} keeps macOS bash 3.2 happy under `set -u` when the
  # array is empty (anonymous buyer calls carry no credentials at all).
  local auth=()
  [ -n "$key" ] && auth=(-H "Authorization: Bearer $key")
  curl -sS -X POST "$BASE/mcp" \
    ${auth[@]+"${auth[@]}"} -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}
# Strip SSE framing: the stateless streamable-http transport answers with
# `event: message\ndata: {...}` — join all data lines into one JSON-RPC doc.
sse_json() { printf '%s' "$1" | sed -n 's/^data: //p' | tr -d '\n'; }
# field from a tool payload: mcp_get <payload> <jq-path>
mcp_get() { printf '%s' "$(sse_json "$1")" | jq -r ".result.content[0].text | fromjson | $2" 2>/dev/null; }
err_code() { printf '%s' "$(sse_json "$1")" | jq -r '.result.content[0].text | fromjson | .code // empty' 2>/dev/null; }

STAMP="$(date +%s)$RANDOM"
TITLE="Nike Air Max 90 Infrared, EU 44 (demo $STAMP)"

section "0 · deployment"
H=$(curl -sS "$BASE/healthz")
assert_eq "healthz ok:true" "$(printf '%s' "$H" | jq -r .ok)" "true"

section "1 · agent onboarding — signup returns a thg_ API key"
if [ -n "$KEY" ]; then
  ok "SELLER_API_KEY provided — skipping signup"
else
  KEY=$(curl -sS -X POST "$BASE/api/signup" -H 'Content-Type: application/json' \
    -d "{\"email\":\"demo-$STAMP@example.test\",\"password\":\"demo-pass-123\",\"name\":\"Demo Seller\"}" \
    | jq -r '.seller.api_key // empty')
  assert_ne "signup returned an API key" "${KEY:0:4}" ""
fi

section "2 · agent discovers the category schema — describe_category(sneakers)"
R=$(mcp "" describe_category '{"category":"sneakers"}')
assert_eq "category name" "$(mcp_get "$R" '.category.name')" "sneakers"
SIZE_DECLARED=$(mcp_get "$R" '.category.attribute_definitions[]?.key' | grep -c '^size_eu$' || true)
assert_eq "declares size_eu" "$SIZE_DECLARED" "1"

section "3 · agent creates the listing — create_listing (no photo yet)"
R=$(mcp "$KEY" create_listing "{\"title\":\"$TITLE\",\"description\":\"Worn twice, like new. Original box included. Demo listing from the Thingery end-to-end demo.\",\"category\":\"sneakers\",\"condition\":\"like_new\",\"brand\":\"Nike\",\"price_cents\":9500,\"currency\":\"EUR\",\"location\":\"Milan, IT\",\"shipping_tier\":\"parcel\",\"attributes\":{\"size_eu\":44,\"colorway\":\"white/grey-infrared\"}}")
ITEM=$(mcp_get "$R" '.item.id')
URL=$(mcp_get "$R" '.item.url')
assert_eq "created:true" "$(mcp_get "$R" '.created')" "true"
assert_eq "photo_required:true" "$(mcp_get "$R" '.photo_required')" "true"
assert_eq "needs_photo:true (THI-308 gate)" "$(mcp_get "$R" '.item.needs_photo')" "true"
assert_eq "visible:false — hidden until first photo" "$(mcp_get "$R" '.visible')" "false"
log "        item: $ITEM"
log "        url:  $URL"

section "4 · buyer query (anonymous, no credentials) — item NOT findable yet"
R=$(mcp "" search_items "{\"q\":\"air max 90 infrared\",\"attributes\":{\"size_eu\":44},\"limit\":20}")
FOUND_HIDDEN=$(printf '%s' "$(sse_json "$R")" | jq -r ".result.content[0].text | fromjson | .results[]?.id // empty" | grep -c "^$ITEM$" || true)
assert_eq "pending item absent from search" "$FOUND_HIDDEN" "0"

section "5 · agent attaches the photo — add_item_image (first photo publishes)"
[ -f "$PHOTO" ] || { bad "demo photo not found at $PHOTO (set DEMO_PHOTO)"; exit 1; }
B64=$(base64 -i "$PHOTO" | tr -d '\n')
R=$(mcp "$KEY" add_item_image "{\"item_id\":\"$ITEM\",\"image_base64\":\"data:image/jpeg;base64,$B64\",\"media_type\":\"image/jpeg\"}")
assert_eq "added:true" "$(mcp_get "$R" '.added')" "true"
assert_eq "visible:true — published by the first photo" "$(mcp_get "$R" '.visible')" "true"
IMG_URL=$(mcp_get "$R" '.image_url')
log "        photo: $IMG_URL"

section "6 · buyer query again (anonymous) — finds the item"
R=$(mcp "" search_items "{\"q\":\"air max 90 infrared\",\"attributes\":{\"size_eu\":44},\"limit\":20}")
FOUND=$(printf '%s' "$(sse_json "$R")" | jq -r ".result.content[0].text | fromjson | .results[]?.id // empty" | grep -c "^$ITEM$" || true)
assert_eq "published item found by search" "$FOUND" "1"
assert_eq "result title matches" "$(mcp_get "$R" ".results[] | select(.id==\"$ITEM\") | .title")" "$TITLE"

section "7 · public item page — GET $URL"
PAGE_CODE=$(curl -sS -o /tmp/demo-page-$STAMP.html -w '%{http_code}' "$URL")
assert_eq "page 200" "$PAGE_CODE" "200"
grep -q "Nike Air Max 90" "/tmp/demo-page-$STAMP.html" && ok "page shows the item title" || bad "page shows the item title"
grep -q "og:image" "/tmp/demo-page-$STAMP.html" && ok "page carries the photo (og:image)" || bad "page carries the photo (og:image)"
rm -f "/tmp/demo-page-$STAMP.html"

if [ -z "${KEEP:-}" ]; then
  section "cleanup — mark the demo listing reserved (keeps prod search tidy)"
  R=$(mcp "$KEY" update_listing "{\"id\":\"$ITEM\",\"status\":\"reserved\"}")
  assert_eq "status reserved" "$(mcp_get "$R" '.item.status // empty')" "reserved"
  log "        (set KEEP=1 to leave it active)"
fi

log ""
log "=================================================="
log "DEMO E2E: $PASS passed, $FAIL failed"
log "item page: ${URL:-n/a}"
log "=================================================="
[ "$FAIL" -eq 0 ]
