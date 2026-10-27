# Weekly activation funnel (THI-371)

How Thingery measures the install → first tool call → repeat-call funnel with
**no new infrastructure**: one structured stdout line per MCP `tools/call`
dispatch (shipped in `src/mcp-gate.ts`, same JSON-line discipline as
`src/security-events.ts`), aggregated weekly from existing Docker/Caddy logs
plus SQL over tables we already have.

## Definitions (the weekly report)

Reported per ISO week (UTC), produced by the weekly metrics routine:

| Metric | Definition | Source |
|---|---|---|
| `installs_7d` / `installs_total` | OAuth grants created in the window / live grants ever (user × connected app) | `oauth_grants` |
| `activated_users_7d` | Distinct `sellerId`s (and/or anon IPs absent) with ≥ 1 `tool_call` line in the window | docker logs |
| `repeat_users_7d` | Distinct `sellerId`s with `tool_call` lines on ≥ 2 distinct UTC days in the window | docker logs |
| `anon_calls_7d` | `tool_call` lines with `credential: "none"` (public reads — search-driven interest) | docker logs |
| `calls_by_tool_7d` | `tool_call` count grouped by `tool` (which tools do agents actually reach for) | docker logs |
| `first_call_latency` | Median hours from a seller's earliest `oauth_grants.created_at` to their first `tool_call` line | logs + SQL |
| `first_listing_within_7d` | Sellers whose first item was created ≤ 7d after their first `tool_call` | logs + SQL |
| `npm_downloads_7d` | `thingery` npm package downloads | public npm API |
| `glama_views_7d` | Glama server views/clicks | manual dashboard entry (see verdict) |

## Collecting the numbers

**1. Tool-call lines from the app container** (Caddy/Docker capture, 7-day window):

```bash
docker compose logs --since 168h app 2>/dev/null \
  | grep '"type":"tool_call"' > /tmp/tool_calls.jsonl
```

**2. Aggregates** (jq):

```bash
# activated / repeat / anon
jq -sr '
  { activated: ([.[] | select(.sellerId != null) | .sellerId] | unique | length),
    repeat:    ([.[] | select(.sellerId != null) | {s:.sellerId, d:(.ts[0:10])}] | unique | group_by(.s) | map(select(length >= 2)) | length),
    anon_calls: ([.[] | select(.credential == "none")] | length) }' /tmp/tool_calls.jsonl

# calls by tool
jq -sr 'group_by(.tool) | map({tool: .[0].tool, calls: length})' /tmp/tool_calls.jsonl
```

**3. Installs (SQL):**

```sql
SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days') AS installs_7d,
       count(*) FILTER (WHERE revoked_at IS NULL)                    AS installs_total
FROM oauth_grants;
```

**4. npm downloads (public API):**

```bash
curl -s https://api.npmjs.org/downloads/point/last-week/thingery | jq .downloads
```

## Data-availability verdicts

- **Per-agent (grant-level) attribution at call time is not available without
  touching protected paths.** `authenticateRequest` resolves the seller, not
  the grant; token → grant → client attribution would require changes in
  `src/auth.ts` (protected). The funnel therefore reports **per-user**
  activation/repeat. For users with exactly one grant (the common case today)
  user ≡ agent; multi-grant users are counted once. Documented limitation,
  accepted for now.
- **No retroactive funnel exists.** `oauth_tokens.last_used_at` is throttled
  (10-min granularity), swept with expired tokens, and has no per-call
  history — history before this PR cannot be reconstructed. The funnel starts
  accumulating at deploy; no backfill.
- **Glama:** the server page exposes view/click analytics in its dashboard,
  but no public API for automated pulls → `glama_views_7d` is a **manual
  weekly entry** by Growth until an API appears.
- **Smithery / mcp.so:** not yet published (growth strategy Bet 2) → no
  analytics source yet; the row appears once listed.
- **stats.json: unchanged.** It is a public, cached homepage asset with an
  aggregate-only, no-user-data design (THI-311). The funnel ratios above are
  operational metrics for the weekly report, not homepage content — keeping
  them out avoids a data-handling change (which would escalate to the
  board). `stats.json` continues to serve `items` / `agents` / `users`.

## Log-line contract

One JSON object per line, stdout, ship path = Docker/Caddy log capture:

```json
{"ts":"2026-10-27T15:04:05.000Z","type":"tool_call","tool":"search_items","credential":"oauth","sellerId":"<uuid>|null"}
```

- `tool`: one of the 16 registered names or the fixed `_unknown` slug —
  client-controlled strings are never logged raw.
- `credential`: `api_key` | `oauth` | `none` (Authorization header prefix).
- `sellerId`: resolved seller UUID (security events already log this field)
  or `null` for anonymous public reads.
- Measures **dispatch** (request passed every gate and reached the
  transport), not execution success. No arguments, params, tokens or
  payloads ever reach the log.
