#!/usr/bin/env bash
# Post-deploy functional smoke (THI-909): a deploy is DONE only when this passes.
#
# Background: on Nov 17 2026 a claim-probe passed `query` instead of the schema's
# `q` param; zod silently strips unknown keys, so search_items served the no-query
# browse for every call and the probe read it as "prod ignores queries" (prod was
# never broken — the 17:07 false-alarm record in THI-524's reddit-dispatch sheet
# caught the same mistake again). healthz alone cannot catch a silently degraded
# tool layer, and between Growth's scheduled probes nothing exercised behavior.
# This script closes that gap: it runs the REAL contract on every deploy, from
# the deploy workflow, and hardcodes the exact param names so a probe-side
# mistake of that class fails loudly here too.
#
# What it asserts (all read-only, anonymous — no accounts, no listings, nothing
# created; consistent with docs/ops-smoke-policy.md):
#   1. /healthz is ok, and its commit matches EXPECT_COMMIT when provided.
#   2. MCP initialize answers on $BASE_URL/mcp.
#   3. tools/list returns at least $MIN_TOOLS tools (floor, printed for the log;
#      exact-set pinning lives in the anti-drift tests).
#   4. search_items with no q returns the live marketplace (>=1 item).
#   5. search_items with q=<distinctive word from a live title> returns at least
#      one hit AND fewer than the no-q page — q must actually filter.
#   6. search_items with a nonsense q returns exactly 0.
#
# Usage:
#   bash scripts/prod-smoke.sh                      # against https://thingery.dev
#   BASE_URL=https://staging.example bash scripts/prod-smoke.sh
#   EXPECT_COMMIT=<sha> bash scripts/prod-smoke.sh  # deploy workflow passes github.sha
#
# Retries each HTTP step briefly: right after `up -d` Caddy can 502 for a few
# seconds while the app container settles.

set -euo pipefail

BASE_URL="${BASE_URL:-https://thingery.dev}"
EXPECT_COMMIT="${EXPECT_COMMIT:-}"
MIN_TOOLS="${MIN_TOOLS:-35}"
ATTEMPTS="${ATTEMPTS:-12}"
SLEEP_SECS="${SLEEP_SECS:-5}"

FAILURES=0
fail() { echo "prod-smoke: FAIL - $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "prod-smoke: ok  - $*"; }

# MCP POST helper: prints the JSON-RPC result object (from the SSE envelope).
mcp_call() {
  local body="$1"
  curl -sS --max-time 30 -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$body" | python3 -c '
import json, sys
data = ""
for line in sys.stdin:
    if line.startswith("data: "):
        data = line[6:].strip()
if not data:
    sys.exit(3)
msg = json.loads(data)
if "error" in msg:
    sys.stderr.write(json.dumps(msg["error"]))
    sys.exit(4)
json.dump(msg["result"], sys.stdout)
'
}

# Retry an MCP method until it yields a usable result object.
mcp_retry() {
  local body="$1" i out
  for ((i = 1; i <= ATTEMPTS; i++)); do
    if out=$(mcp_call "$body" 2>/dev/null) && [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
    sleep "$SLEEP_SECS"
  done
  return 1
}

echo "prod-smoke: target $BASE_URL (expect commit: ${EXPECT_COMMIT:-<none>})"

# --- 1. healthz ---------------------------------------------------------------
health=""
for ((i = 1; i <= ATTEMPTS; i++)); do
  if health=$(curl -sS --max-time 15 "$BASE_URL/healthz" 2>/dev/null); then
    break
  fi
  sleep "$SLEEP_SECS"
done
if [ -z "$health" ]; then
  fail "healthz unreachable"
else
  ok=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
  if [ "$ok" = "True" ]; then
    live_commit=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))')
    if [ -n "$EXPECT_COMMIT" ] && [ "$live_commit" != "$EXPECT_COMMIT" ]; then
      fail "healthz commit $live_commit != expected $EXPECT_COMMIT (deploy did not land?)"
    else
      pass "healthz ok at commit ${live_commit:0:12}"
    fi
  else
    fail "healthz not ok: $health"
  fi
fi

# --- 2. MCP initialize ---------------------------------------------------------
init=$(mcp_retry '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"prod-smoke","version":"1.0"}}}' \
  && echo) || true
if [ -n "${init:-}" ]; then
  pass "MCP initialize answered"
else
  fail "MCP initialize did not answer after $ATTEMPTS attempts"
fi

# --- 3. tools/list --------------------------------------------------------------
tools=$(mcp_retry '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' || true)
if [ -n "${tools:-}" ]; then
  count=$(printf '%s' "$tools" | python3 -c '
import json,sys
r=json.load(sys.stdin)
tools=r.get("tools") or []
print(len(tools))
sys.stderr.write(",".join(sorted(t["name"] for t in tools)))
' 2>/tmp/prod-smoke-tools.txt)
  if [ "$count" -ge "$MIN_TOOLS" ] 2>/dev/null; then
    pass "tools/list returned $count tools (floor $MIN_TOOLS)"
  else
    fail "tools/list returned only '$count' tools (floor $MIN_TOOLS); names: $(cat /tmp/prod-smoke-tools.txt)"
  fi
else
  fail "tools/list did not answer"
fi

# --- 4-6. search_items q discipline ---------------------------------------------
search_json() { # args: python literals for the arguments object
  local args="$1"
  mcp_retry "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_items\",\"arguments\":$args}}" || true
}

browse=$(search_json '{}')
if [ -z "${browse:-}" ]; then
  fail "search_items (no q) did not answer"
else
  parsed=$(printf '%s' "$browse" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=json.loads(r["content"][0]["text"])
print(t.get("count", -1))
if t.get("results"):
    title=(t["results"][0].get("title") or "")
    print(title)
' 2>/dev/null || true)
  browse_count=$(printf '%s' "$parsed" | sed -n 1p)
  first_title=$(printf '%s' "$parsed" | sed -n 2p)
  if [ "${browse_count:-0}" -ge 1 ] 2>/dev/null; then
    pass "no-q browse returned $browse_count live listings"
  else
    fail "no-q browse returned nothing (count=$browse_count) — marketplace unreachable or empty?"
  fi

  # Distinctive probe word: longest >=5-char alphanumeric token of a live title.
  probe_word=$(printf '%s' "$first_title" | tr -cs 'A-Za-z0-9' '\n' | awk 'length($0)>=5' | awk '{ if (length($0)>length(m)) m=$0 } END { print m }')
  if [ -n "$probe_word" ]; then
    hit=$(search_json "{\"q\":\"$probe_word\"}")
    hit_count=$(printf '%s' "$hit" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=json.loads(r["content"][0]["text"])
print(t.get("count", -1))
' 2>/dev/null || echo -1)
    if [ "${hit_count:--1}" -ge 1 ] 2>/dev/null && [ "${hit_count:--1}" -lt "${browse_count:-0}" ] 2>/dev/null; then
      pass "q=\"$probe_word\" filtered: $hit_count result(s) < $browse_count browse"
    else
      fail "q=\"$probe_word\" did not filter (count=$hit_count vs browse $browse_count) — q is being ignored"
    fi
  else
    fail "could not derive a probe word from first listing title '$first_title'"
  fi
fi

nonsense=$(search_json '{"q":"zzqxvbl9k3junkprobe"}')
nonsense_count=$(printf '%s' "$nonsense" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=json.loads(r["content"][0]["text"])
print(t.get("count", -1))
' 2>/dev/null || echo -1)
if [ "${nonsense_count:--1}" -eq 0 ] 2>/dev/null; then
  pass "nonsense q returned 0 results"
else
  fail "nonsense q returned ${nonsense_count:-?} results — expected exactly 0"
fi

# -------------------------------------------------------------------------------
if [ "$FAILURES" -gt 0 ]; then
  echo "prod-smoke: FAILED ($FAILURES assertion(s)) — this deploy is NOT done; treat as an open incident." >&2
  exit 1
fi
echo "prod-smoke: PASS — deploy is functionally verified ($BASE_URL)"
