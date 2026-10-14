#!/usr/bin/env bash
# Staging end-to-end order test (spec THI-3 §7.2 "Manual/staging" checklist).
#
# Drives a RUNNING Thingery HTTP server through the full order lifecycle over
# real HTTP: signup x2, listing, off_platform order (pending → sold →
# label_issued → in_transit → delivered → disputed → admin release →
# completed), cancel path, return-page privacy checks (F15), webhook
# signature verification (Stripe + carrier, incl. negative), the payment-
# expiry sweep, and party-only get_order (F14).
#
# Stripe money paths (checkout, transfers, refunds) need real Stripe test
# keys + `stripe listen` — see README "Order flow" and the THI-3 §7.2
# DevOps checklist. This script proves everything that does not require
# provider accounts, against any deployment (local rig, staging, or prod
# while it still answers off_platform orders).
#
# Usage:
#   BASE_URL=http://localhost:3999 \
#   STRIPE_WEBHOOK_SECRET=whsec_... EASYPOST_WEBHOOK_SECRET=... \
#   ADMIN_API_KEY=... \
#   STAGING_DATABASE_URL=postgres://...  \   # optional: enables the sweep leg
#   scripts/staging-e2e.sh
#
# Secrets stay in the environment; nothing is logged.
# NOTE: each run performs 3 signups from one IP; the signup/login limiter
# is 10/hour/IP — restart the server (or wait) between repeated local runs.
set -u

BASE="${BASE_URL:-http://localhost:3999}"
STRIPE_SEC="${STRIPE_WEBHOOK_SECRET:-}"
CARRIER_SEC="${EASYPOST_WEBHOOK_SECRET:-}"
ADMIN_KEY="${ADMIN_API_KEY:-}"
DB_URL="${STAGING_DATABASE_URL:-}"

PASS=0; FAIL=0; STEP=""
log() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); log "  PASS  ${STEP}${1:+ — $1}"; }
bad() { FAIL=$((FAIL+1)); log "  FAIL  ${STEP}${1:+ — $1}"; }
section() { STEP="$1"; log ""; log "== $1"; }

# assert_eq <desc> <got> <want>
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2' want '$3')"; fi; }
assert_ne() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1 (got '$2', must differ)"; fi; }

# mcp <api-key> <tool> <json-args> → raw transport reply (SSE-framed or JSON)
mcp() {
  local key="$1" tool="$2" args="${3:-{\}}"
  curl -sS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}
# Strip SSE framing: the stateless streamable-http transport answers with
# `event: message\ndata: {...}` — join all data lines into one JSON-RPC doc
# (long payloads can be split across chunks).
sse_json() { printf '%s' "$1" | sed -n 's/^data: //p' | tr -d '\n'; }
# field from a tool payload: mcp_get <payload> <jq-path>
mcp_get() { printf '%s' "$(sse_json "$1")" | jq -r ".result.content[0].text | fromjson | $2" 2>/dev/null; }
# tool errors are `err(msg, code)` → text JSON {error, code} (src/tools.ts)
err_code() { printf '%s' "$(sse_json "$1")" | jq -r '.result.content[0].text | fromjson | .code // empty' 2>/dev/null; }

STAMP=$RANDOM
section "health"
H=$(curl -sS "$BASE/healthz")
assert_eq "healthz ok:true" "$(printf '%s' "$H" | jq -r .ok)" "true"

section "signup (seller + buyer, real HTTP sessions)"
S_KEY=$(curl -sS -X POST "$BASE/api/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"staging-seller-$STAMP@example.test\",\"password\":\"pass-word-123\",\"name\":\"Staging Seller\"}" \
  | jq -r '.seller.api_key // empty')
B_KEY=$(curl -sS -X POST "$BASE/api/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"staging-buyer-$STAMP@example.test\",\"password\":\"pass-word-123\",\"name\":\"Staging Buyer\"}" \
  | jq -r '.seller.api_key // empty')
assert_ne "seller got thg_ key" "${S_KEY:0:4}" ""
assert_ne "buyer got thg_ key" "${B_KEY:0:4}" ""

section "create_listing (seller)"
R=$(mcp "$S_KEY" create_listing "{\"title\":\"Staging e2e winter jacket\",\"description\":\"close-out rig item\",\"category\":\"other\",\"condition\":\"good\",\"price_cents\":12500,\"currency\":\"EUR\",\"location\":\"Milan, IT\",\"shipping_tier\":\"parcel\"}")
ITEM=$(mcp_get "$R" '.item.id')
assert_eq "created:true" "$(mcp_get "$R" '.created')" "true"
R=$(mcp "$B_KEY" get_item "{\"id\":\"$ITEM\"}")
assert_eq "buyer get_item orderable:true" "$(mcp_get "$R" '.item.orderable')" "true"
assert_eq "get_item payment_available:false (§11.2 surface)" "$(mcp_get "$R" '.item.payment_available')" "false"

section "create_order — explicit stripe refused while seller not payout-ready"
R=$(mcp "$B_KEY" create_order "{\"item_id\":\"$ITEM\",\"payment_mode\":\"stripe\",\"shipping_address\":{\"name\":\"Buyer\",\"line1\":\"Via Test 1\",\"city\":\"Milan\",\"postal_code\":\"20121\",\"country\":\"IT\"}}")
CODE=$(err_code "$R")
if [ "$CODE" != "payments_not_configured" ] && [ "$CODE" != "seller_not_payout_ready" ]; then
  bad "stripe refused (got '$CODE')"
else ok "stripe refused with '$CODE'"
fi

section "create_order — off_platform default"
R=$(mcp "$B_KEY" create_order "{\"item_id\":\"$ITEM\",\"shipping_address\":{\"name\":\"Buyer\",\"line1\":\"Via Test 1\",\"city\":\"Milan\",\"postal_code\":\"20121\",\"country\":\"IT\"}}")
ORDER=$(mcp_get "$R" '.order.id')
assert_eq "status pending" "$(mcp_get "$R" '.order.status')" "pending"
assert_eq "payment_mode off_platform" "$(mcp_get "$R" '.order.payment_mode')" "off_platform"
assert_eq "total = price (shipping 0 by default)" "$(mcp_get "$R" '.order.total_price_cents')" "12500"

section "F14 — get_order by non-party"
R=$(mcp "$S_KEY" get_order "{\"order_id\":\"$(printf '%s' "$ORDER" | tr 'a-f' 'A-F')\"}")
# seller IS a party; use a third account as the outsider
O_KEY=$(curl -sS -X POST "$BASE/api/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"staging-outsider-$STAMP@example.test\",\"password\":\"pass-word-123\"}" | jq -r '.seller.api_key // empty')
R=$(mcp "$O_KEY" get_order "{\"order_id\":\"$ORDER\"}")
assert_eq "outsider sees not_found" "$(err_code "$R")" "not_found"

section "F15 — /order/:id return page privacy"
P=$(curl -sS -D - -o "$TMPDIR/page.html" "$BASE/order/$ORDER")
PAGE=$(cat "$TMPDIR/page.html")
assert_eq "200" "$(printf '%s' "$P" | head -1 | awk '{print $2}')" "200"
assert_eq "Cache-Control: no-store" "$(printf '%s' "$P" | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)" "no-store"
assert_eq "Referrer-Policy: same-origin" "$(printf '%s' "$P" | grep -i '^referrer-policy:' | tr -d '\r' | cut -d' ' -f2-)" "same-origin"
assert_eq "no item title leak" "$(printf '%s' "$PAGE" | grep -c 'winter jacket')" "0"
assert_eq "no price leak" "$(printf '%s' "$PAGE" | grep -c '12500')" "0"
P2=$(curl -sS "$BASE/order/not-a-uuid")
if printf '%s' "$P2" | grep -q 'Order status'; then ok "malformed id renders the same status-only page (F15 no oracle)"; else bad "malformed id renders the same status-only page (F15 no oracle)"; fi
assert_eq "payout-setup page 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/order/payout-setup")" "200"

section "confirm_payment #24 (seller) → sold"
R=$(mcp "$S_KEY" confirm_payment "{\"order_id\":\"$ORDER\"}")
assert_eq "status sold" "$(mcp_get "$R" '.order.status')" "sold"

section "record_tracking #5 (seller) → label_issued"
R=$(mcp "$S_KEY" record_tracking "{\"order_id\":\"$ORDER\",\"carrier\":\"DHL\",\"tracking_code\":\"9400${STAMP}001\"}")
assert_eq "status label_issued" "$(mcp_get "$R" '.order.status')" "label_issued"

section "carrier webhook #10 — signed → in_transit"
if [ -n "$CARRIER_SEC" ]; then
  EV="{\"description\":\"tracker.updated\",\"mode\":\"test\",\"result\":{\"id\":\"trk_$STAMP\",\"tracking_code\":\"9400${STAMP}001\",\"carrier\":\"DHL\",\"status\":\"in_transit\"}}"
  SIG=$(printf '%s' "$EV" | openssl dgst -sha256 -hmac "$CARRIER_SEC" -hex | sed 's/^.*= //')
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/carrier" -H 'Content-Type: application/json' -H "X-Hmac-Signature: $SIG" -d "$EV")
  assert_eq "signed event 200" "$CODE" "200"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/carrier" -H 'Content-Type: application/json' -H "X-Hmac-Signature: deadbeef$SIG" -d "$EV")
  assert_eq "tampered signature rejected" "$CODE" "400"
  R=$(mcp "$B_KEY" get_order "{\"order_id\":\"$ORDER\"}")
  assert_eq "order in_transit" "$(mcp_get "$R" '.order.status')" "in_transit"
else log "  SKIP  (EASYPOST_WEBHOOK_SECRET not provided)"; fi

section "carrier webhook #12 — delivered; then open_dispute #15"
if [ -n "$CARRIER_SEC" ]; then
  EV="{\"description\":\"tracker.updated\",\"mode\":\"test\",\"result\":{\"id\":\"trk_$STAMP\",\"tracking_code\":\"9400${STAMP}001\",\"carrier\":\"DHL\",\"status\":\"delivered\",\"tracking_details\":[{\"datetime\":\"2026-10-14T10:00:00Z\",\"message\":\"Delivered\",\"signed_by\":\"SHOULD NOT PERSIST\"}]}}"
  SIG=$(printf '%s' "$EV" | openssl dgst -sha256 -hmac "$CARRIER_SEC" -hex | sed 's/^.*= //')
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/carrier" -H 'Content-Type: application/json' -H "X-Hmac-Signature: $SIG" -d "$EV")
  assert_eq "delivered event 200" "$CODE" "200"
  R=$(mcp "$B_KEY" get_order "{\"order_id\":\"$ORDER\"}")
  assert_eq "order delivered" "$(mcp_get "$R" '.order.status')" "delivered"
fi
R=$(mcp "$B_KEY" open_dispute "{\"order_id\":\"$ORDER\",\"reason\":\"staging close-out dispute\"}")
assert_eq "status disputed" "$(mcp_get "$R" '.order.status')" "disputed"

section "admin route #19b — auth + off_platform release → completed"
if [ -n "$ADMIN_KEY" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/orders/$ORDER/resolve-dispute" -H 'Content-Type: application/json' -d '{"outcome":"release","note":"staging"}')
  assert_eq "no key → 401" "$CODE" "401"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/orders/$ORDER/resolve-dispute" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"outcome":"nonsense","note":"x"}')
  assert_eq "bad outcome → 400" "$CODE" "400"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/orders/$ORDER/resolve-dispute" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"outcome":"release","note":"staging close-out: release"}')
  assert_eq "release → 200" "$CODE" "200"
  R=$(mcp "$B_KEY" get_order "{\"order_id\":\"$ORDER\"}")
  assert_eq "status completed" "$(mcp_get "$R" '.order.status')" "completed"
else log "  SKIP  (ADMIN_API_KEY not provided)"; fi

section "cancel path #3/#8b — order2 cancelled, item back active"
R=$(mcp "$S_KEY" create_listing "{\"title\":\"Staging e2e second item\",\"category\":\"other\",\"price_cents\":4000,\"currency\":\"EUR\"}")
ITEM2=$(mcp_get "$R" '.item.id')
R=$(mcp "$B_KEY" create_order "{\"item_id\":\"$ITEM2\",\"shipping_address\":{\"name\":\"Buyer\",\"line1\":\"Via Test 1\",\"city\":\"Milan\",\"postal_code\":\"20121\",\"country\":\"IT\"}}")
ORDER2=$(mcp_get "$R" '.order.id')
R=$(mcp "$B_KEY" confirm_payment "{\"order_id\":\"$ORDER2\"}") # buyer is wrong actor → must fail
assert_ne "buyer cannot confirm_payment" "$(mcp_get "$R" '.order.status // "error"')" "sold"
R=$(mcp "$S_KEY" confirm_payment "{\"order_id\":\"$ORDER2\"}")
R=$(mcp "$B_KEY" cancel_order "{\"order_id\":\"$ORDER2\"}")
assert_eq "order2 cancelled" "$(mcp_get "$R" '.order.status')" "cancelled"
R=$(mcp "$S_KEY" my_listings '{}')
assert_eq "item2 active again" "$(mcp_get "$R" ".items[] | select(.id==\"$ITEM2\") | .status")" "active"

section "stripe webhook endpoint — signature gate (no provider needed)"
if [ -n "$STRIPE_SEC" ]; then
  T=$(date +%s)
  EV="{\"id\":\"evt_staging_$STAMP\",\"object\":\"event\",\"type\":\"checkout.session.completed\",\"created\":$T,\"data\":{\"object\":{\"id\":\"cs_staging_$STAMP\",\"client_reference_id\":\"00000000-0000-0000-0000-000000000000\"}}}"
  SIG=$(printf '%s' "${T}.${EV}" | openssl dgst -sha256 -hmac "$STRIPE_SEC" -hex | sed 's/^.*= //')
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/stripe" -H 'Content-Type: application/json' -H "Stripe-Signature: t=$T,v1=$SIG" -d "$EV")
  assert_eq "signed event accepted (200, machine arbitrates no-match)" "$CODE" "200"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/stripe" -H 'Content-Type: application/json' -H "Stripe-Signature: t=$T,v1=0000$SIG" -d "$EV")
  assert_eq "tampered signature → 400" "$CODE" "400"
else log "  SKIP  (STRIPE_WEBHOOK_SECRET not provided)"; fi

section "payment-expiry sweep #4 (backdated deadline)"
if [ -n "$DB_URL" ]; then
  R=$(mcp "$S_KEY" create_listing "{\"title\":\"Staging e2e sweep item\",\"category\":\"other\",\"price_cents\":3000,\"currency\":\"EUR\"}")
  ITEM3=$(mcp_get "$R" '.item.id')
  R=$(mcp "$B_KEY" create_order "{\"item_id\":\"$ITEM3\",\"shipping_address\":{\"name\":\"Buyer\",\"line1\":\"Via Test 1\",\"city\":\"Milan\",\"postal_code\":\"20121\",\"country\":\"IT\"}}")
  ORDER3=$(mcp_get "$R" '.order.id')
  psql "$DB_URL" -q -c "UPDATE orders SET payment_deadline = now() - interval '2 hours' WHERE id = '$ORDER3'" >/dev/null 2>&1 \
    || bad "psql backdate failed (is STAGING_DATABASE_URL reachable?)"
  SW=""; for i in $(seq 1 24); do
    sleep 5
    SW=$(psql "$DB_URL" -tA -c "SELECT status FROM orders WHERE id = '$ORDER3'" 2>/dev/null)
    [ "$SW" = "cancelled" ] && break
  done
  assert_eq "order3 cancelled by sweep" "$SW" "cancelled"
  ST=$(psql "$DB_URL" -tA -c "SELECT status FROM items WHERE id = '$ITEM3'" 2>/dev/null)
  assert_eq "item3 active again" "$ST" "active"
else log "  SKIP  (STAGING_DATABASE_URL not provided — needs SQL access to backdate the deadline)"; fi

log ""
log "======================================"
log "STAGING E2E: $PASS passed, $FAIL failed"
log "======================================"
[ "$FAIL" -eq 0 ]
