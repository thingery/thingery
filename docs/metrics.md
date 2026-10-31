# Weekly activation funnel (THI-371) + sprint metrics (THI-394)

How Thingery measures adoption with **no new infrastructure**: structured stdout
JSON lines per MCP call — dispatch-time `tool_call` lines (THI-371, shipped in
`src/mcp-gate.ts`) and outcome-time `tool_result` lines (THI-394, shipped in
`src/analytics.ts`) — aggregated from Docker logs plus SQL over tables we
already have, by `scripts/daily-metrics.sh` (daily snapshot) and the weekly
metrics routine. Same JSON-line discipline as `src/security-events.ts`.

## Sprint week-1 metrics (THI-394) — activation / search success / listing funnel

The adoption sprint optimizes three numbers. All are computable from real
events via **`scripts/daily-metrics.sh`** (run on the VPS from `/opt/thingery`;
cron-daily per docs/deploy-vps.md §6b) or ad-hoc with the jq below.

| Metric | Definition | Source |
|---|---|---|
| `activated_callers` | Sellers with ≥ 1 **successful** (`ok:true`) tool call in window — first useful action; per-seller first-useful timestamps are derivable from the same lines | `tool_result` lines |
| `anon_useful_calls` | Successful anonymous calls (public reads) | `tool_result` lines |
| `searches` / `with_results` | Successful `search_items` calls; share returning ≥ 1 result (**query → results**) | `tool_result` `.results` |
| `click_through` | Searches followed ≤ 10 min later by a successful `get_item` from the same caller bucket (**query → click**) | `tool_result` lines |
| `log_attempts → created → visible` | Listing funnel from events: `create_listing` calls (any outcome) → `ok:true` → visible at create; `first_photo_publishes` = `add_item_image` ok with `visible:true` | `tool_result` lines |
| `sql_created / sql_published / sql_pending_photo` | Funnel truth from the items table (covers web-page photo uploads too, not just MCP) — **cite these in reports** | SQL |

**Daily snapshot:** `scripts/daily-metrics.sh` writes
`$THINGERY_METRICS_DIR/daily-YYYY-MM-DD.json` (default `/opt/thingery/metrics/`)
and prints a 4-line summary. Snapshots are the durable record — container logs
rotate; snapshots survive. Definitions live in the JSON itself
(`ctr_window_seconds` etc.).

**Known limitations (documented, accepted):**

- Anonymous callers share one coarse `"anon"` bucket — anonymous click-through
correlates the bucket, not an individual caller. Authenticated sellers
(sellerId) correlate exactly.
- `first_photo_publishes` counts every successful `add_item_image` whose item
is visible afterwards, including second photos of already-visible items; the
exact publish count is `sql_published`.
- `tool_result` measures tool execution, not buyer conversion; `create_order`
success is available in `by_tool` if the sprint later needs it.

## Sharing attribution (THI-396, sprint D9)

Every successful public item-page render (`GET /item/:id`, 200 only) emits one
`page_view` line with the visit origin classified **at request time** —
canonical listing URLs are query-string-free (SEO/unfurl stability), so the
Referer header and `utm_*` params are the only origin signals and they cannot
be reconstructed later. The snapshot's `sharing` section and the 5th output
line of `scripts/daily-metrics.sh` carry:

| Metric | Definition | Source |
|---|---|---|
| `item_views` / `item_views_human` | All item-page renders; human = non-unfurler User-Agent | `page_view` lines |
| `unfurl_bot_views` | Card-unfurl fetches (facebookexternalhit, twitterbot, …) — share *evidence*, not visits | `page_view` `.bot` |
| `human_by_origin` | Human views by origin: `direct` (no/blocked referrer) / `internal` (own host) / `external` (referrer host = sharing platform) | `page_view` `.origin` |
| `top_ref_hosts` | Top 5 external referrer hosts among human views | `page_view` `.refHost` |
| `utm_tagged_views` | Human views carrying valid `utm_*` params (a sharer tagged the link) | `page_view` `.utm` |
| `share_attributable_views` | Human views with `external` origin **or** utm params — the "share-clicks" number for the ≥5-shares sprint target | `page_view` lines |

Owner self-views carry `owner:true` and can be filtered out (jq: `select(.owner != true)`).

### Privacy & retention

What is collected per tool call — and nothing else:

dispatch line: timestamp, tool name (registered names only), credential kind,
seller UUID-or-null. result line: timestamp, tool name, seller UUID-or-null,
ok boolean, duration ms, plus at most one results count (search) or two
booleans (created/visible). **Never collected:** tool arguments, search query
text, item ids/titles/attributes, user content, IPs, tokens, error messages.
`src/analytics.ts` reads payload fields by fixed name only and clamps them.

page_view line (THI-396): timestamp, public listing UUID, owner boolean,
origin (`direct`/`internal`/`external`), optional external referrer **host
only** (never the full Referer URL — third-party referrer paths can identify
users), optional utm values (kept only when they match a conservative clamped
charset; anything else dropped), unfurler boolean from a fixed User-Agent
substring list. **Never collected for views:** full referrer URLs, arbitrary
query strings beyond the five utm params, viewer identity or IPs — not even
the owner flag resolves to a logged seller UUID.

Storage: container stdout → Docker `json-file` driver, rotation `max-size:
10m`, `max-file: 3` per service (docker-compose.prod.yml, THI-312) — raw lines
are transient and are not part of offsite backups. The daily snapshot files
store aggregate counts only (no identifiers). Retention of snapshots:
manual/undefined — they are a handful of KB per day; clean up when stale.

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
{"ts":"2026-10-27T15:04:05.030Z","type":"tool_result","tool":"search_items","sellerId":"<uuid>|null","ok":true,"ms":30,"results":3}
{"ts":"2026-11-04T10:02:00.000Z","type":"page_view","page":"item","itemId":"<uuid>","owner":false,"origin":"external","refHost":"web.whatsapp.com","utm":{"source":"wa","medium":"chat"},"bot":false}
```

- `tool_call` (THI-371): one per `tools/call` message at **dispatch** — the
  request passed every gate and reached the transport. `tool` is one of the
  21 registered names or the fixed `_unknown` slug — client-controlled
  strings are never logged raw.
- `tool_result` (THI-394): one per **executed** tool call after the handler
  ran — success, structured error (`ok:false`), or throw. `results`
  (search_items) and `created`/`visible` (create_listing, add_item_image)
  are read by fixed name from the handler's own JSON output and clamped
  (see `src/analytics.ts`).
- `page_view` (THI-396): one per successful public item-page render, emitted
  in `itemPage` (src/web-pages.ts) with the origin classified server-side in
  `classifyVisitOrigin` (src/analytics.ts). `refHost`/`utm` appear only when
  present; `owner` lets self-views be excluded from share metrics.
- `credential`: `api_key` | `oauth` | `none` (Authorization header prefix).
- `sellerId`: resolved seller UUID (security events already log this field)
  or `null` for anonymous public reads.
- No arguments, params, tokens, payloads or error text ever reach the log.
