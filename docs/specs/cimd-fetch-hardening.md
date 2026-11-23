# Spec: CIMD client-metadata fetch hardening — retry-once, stale-if-error, richer rejection events

- **Status:** Proposed. **Not a protected-path change:** the diff touches `src/oauth-cimd.ts`
  and `src/oauth.ts` only — none of `db/schema.sql`, `src/tools.ts`, `src/auth.ts`,
  `src/routes.ts` — so the THI-36 sign-off chain is not triggered. The OAuth authorize surface
  is security-sensitive, however (docs/security.md §2a CIMD identity, §3.3 API7 SSRF
  containment), so **Security review of this spec is requested before implementation starts**.
- **Date:** 2026-11-23
- **Author:** Architect
- **Evidence:** THI-1286 description (prod, 2026-11-23): one `cimd_rejected`
  `{reason: fetch_failed}` for `https://claude.ai/oauth/claude-code-client-metadata` at
  20:24:42Z during the deploy load burst (DNS miss inside the 5 s fetch budget,
  `getaddrinfo EAI_AGAIN`-class failure); the same connector connected end-to-end at
  20:52:10Z. One transient miss = a hard 400 "Unknown application" page for a new user's
  first connect.
- **Decision (proposed):** retry a transient CIMD fetch exactly once after 300 ms; if the
  refresh still fails, serve the last successfully fetched **and validated** document stale
  for at most 24 h after it was fetched (never when the document is actively invalid and
  never when no valid copy was ever seen); `cimd_rejected` gains `detail`, `attempts` and
  `elapsed_ms`, and a new `cimd_served` line covers the rare non-cache paths (fresh fetch,
  stale serve).
- **Scope guard:** exactly the three hardening items of THI-1286. No change to the SSRF
  containment of §3.3 API7 (same URL rules, public-only lookup, no redirects, 5 s timeout,
  5 KB cap), no change to redirect-uri validation, the `oauth_clients` upsert, limiter
  budgets, or any MCP tool signature. The related ops finding — the box is under-provisioned
  for on-box builds; off-box image builds (Actions → ghcr → pull-only deploys) would shrink
  the deploy bursts that trigger this failure mode — is a CEO spend decision on THI-1262 and
  stays out of scope here.

Thingery is the open item database and MCP server for AI agents to list, find, and trade
second-hand goods.

## Problem

The CIMD resolver (`src/oauth-cimd.ts`, PR #290) fetches a client-supplied metadata document
on the `/oauth/authorize` path with zero tolerance for transient failure: one attempt, and
failures are never cached — a single DNS miss inside the 5 s budget rejects the client, and
`clientFromMetadataDocument` (`src/oauth.ts`) renders the 400 "Unknown application" page.
Claude's connect UI surfaces that as a hard failure; the user's first connect breaks even
though the same connector succeeds minutes later. Prod hit exactly this on 2026-11-23 during
a deploy burst (THI-1286 evidence). Diagnosis also cost a hand-reproduction because
`cimd_rejected` logs only `reason` — no error detail, no elapsed time, no attempt count.

## Context (repo @ caac29f)

- **Resolver** (`createMetadataDocumentResolver`): success cache (`client`, `expiresAt`),
  TTL 1 h, max 500 entries (insertion-order eviction); `inFlight` dedupe per URL; per-URL
  `RateLimiter(20/h)` checked **before** fetching; failures never cached. Entries past TTL
  stay in the map but are never served — expiry currently forces a refetch.
- **Fetch** (`fetchMetadataDocument`): https GET under the §3.3 API7 containment; all
  failures — timeout, socket/DNS errors, non-200 status (redirects included), wrong
  content-type, > 5 KB — throw `CimdError` with reason `fetch_failed` and a free-text
  `detail` that doubles as `error.message`; document-level failures throw `invalid_document`.
  **No retry anywhere.**
- **Consumer** (`clientFromMetadataDocument`, `src/oauth.ts`): resolve → validate redirect
  URIs (`validateClientRegistration`, same rules as dynamic registration) → upsert
  `oauth_clients`. Called only from `/oauth/authorize` (one call site). On `CimdError` it
  logs `securityEvent("cimd_rejected", { reason, client_id: slice(0,200) })` through the
  module-local `securityEvent` wrapper (stderr JSON line, same path as `code_replay`,
  `csrf_rejected`, etc. — deliberately not the `logSecurityEvent` union in
  `src/security-events.ts`).
- **Security story** (docs/security.md §2a): a CIMD client's displayed identity is the
  document's host, *which the fetch proved*; "a changed document takes effect for new flows
  within the fetch cache's lifetime (1 h)". Any change to how long a document may be served
  must keep that sentence honest — see Stale-if-error below and the docs updates in PR-2.
- **Tests:** `tests/oauth-cimd.test.ts` (178 lines, no network — lookups and fetches
  stubbed). `src/oauth.ts` has no direct unit tests; its log lines are pinned by review +
  manual smoke.

## Proposed design

### 1. Failure-handling state machine — `resolve(clientId)`

Every outcome is named; illegal transitions do not exist. Changes from today are marked.

| # | Pre-state | Event | Action | Outcome |
|---|-----------|-------|--------|---------|
| 1 | — | `client_id` fails `parseMetadataDocumentUrl` | throw | `invalid_url` (unchanged; no fetch, no timing) |
| 2 | fresh cache entry (`fetchedAt + CACHE_TTL_MS > now`) | resolve | serve entry | `cache` (unchanged, no fetch, no log) |
| 3 | in-flight load for URL | resolve | await pending promise | shared outcome (unchanged) |
| 4 | limiter denies (`20/h` exhausted) | — | **stale copy within grace? serve it** : throw | `rate_limited` or `stale` (serve is **new**) |
| 5 | entry expired or absent → fetch attempt 1 succeeds | — | validate, refresh cache | `fresh` (unchanged behavior, now observable) |
| 6 | attempt 1 fails **transiently** | retry after 300 ms | attempt 2 | succeeds → `fresh` (**new**); fails → step 7 |
| 7 | both attempts failed (`fetch_failed`) | — | **stale copy within grace? serve it** : throw with `attempts=2`, `elapsed_ms` | `stale` or `fetch_failed` (serve is **new**) |
| 8 | fetch/validate ends `invalid_document` | — | no retry, **no stale serve**, throw | `invalid_document` (unchanged) |
| 9 | fetch ends non-transient `fetch_failed` (HTTP 4xx, TLS identity, size cap, content-type) | — | no retry, **no stale serve**, throw | `fetch_failed` (unchanged, `attempts=1`) |

"Stale copy within grace" = a cache entry for the URL whose `fetchedAt + STALE_GRACE_MS
(24 h) > now`. Fail closed when no valid copy was ever seen or the grace window has passed.

### 2. Retry-once (PR-1)

- **Where:** inside `load()` in the resolver, around `fetchDocument(url)` only — never
  around `readMetadataDocument` validation (a deterministic content failure must not
  re-validate), and never as a second `resolve()` (limiter token stays one per resolve; see
  below). Concurrent resolvers share one logical load via the existing `inFlight` map.
- **Retryability classification** on `CimdError` (new `readonly retryable: boolean`):

  | Failure | retryable | Rationale |
  |---|---|---|
  | timeout (5 s budget hit) | yes | the incident class; load burst |
  | DNS/socket errors before response (`getaddrinfo EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, …) | yes | transient under load; the exact prod failure |
  | HTTP status ≥ 500 | yes | server-side blip upstream |
  | HTTP status 4xx / 3xx | no | the URL is wrong or withdrawn; a retry cannot change the answer and would stretch the authorize 400 by ~5.3 s |
  | TLS identity/certificate errors | no | deterministic MITM/misconfig signal |
  | size cap (> 5 KB), wrong content-type, `invalid_document`, `invalid_url`, `rate_limited` | no | deterministic |

  Exact predicates (which node error codes count as DNS/socket) are pinned in tests.
- **Backoff:** fixed 300 ms (mid-range of THI-1286's 250–500 ms). Single instance, single
  retry, no herd — no jitter, no env knob (YAGNI; constants are one-line changes). Injected
  as a constructor parameter (`retryDelayMs`) so tests run with `0`.
- **Worst case** authorize latency: only on already-failing paths — 5 s + 0.3 s + 5 s ≈
  10.3 s before the 400 (today: 5 s). Success paths gain nothing.
- **Limiter:** one `limiter.allow()` per resolve as today; the retry consumes no extra
  token. Worst case upstream load: 20 resolves/h/URL × 2 GETs = 40 GETs/h/URL, still bounded
  by the existing per-URL budget (today: ≤ 20).

### 3. Stale-if-error (PR-2)

- Cache entries gain `fetchedAt` (today only `expiresAt`). A past-TTL entry may be served
  **only** from outcome rows 4 and 7 of the state machine — refresh was denied or the
  network refresh failed transiently after retry — and only while
  `now ≤ fetchedAt + STALE_GRACE_MS` (`STALE_GRACE_MS = 24 h`). Grace counts from the last
  successful fetch, so a document is never served older than 24 h.
- **Fail closed** when no validated copy was ever seen (first connect during an outage still
  fails — unchanged) and when grace has passed.
- **Excluded from stale serve:** `invalid_document` (the refresh *succeeded* and said the
  document is now bad — masking it would pin redirect_uris the client has actively changed
  or removed) and non-transient `fetch_failed` (4xx = URL withdrawn; TLS = intercept
  signal). Serving a stale copy of a client's own previously validated document is within
  the same trust level as the fresh fetch — no new fetch class, no new data path — but it
  does extend a validated document's serviceable lifetime from 1 h to ≤ 24 h under refresh
  failure. That is the one security-relevant tradeoff in this spec; docs/security.md must
  say so (PR-2) and Security should veto the 24 h figure if it prefers shorter.
- The stale path re-runs the **same** `validateClientRegistration` in
  `clientFromMetadataDocument` and the same upsert — no bypass, and the upsert is idempotent.

### 4. Observability (PR-1, extended in PR-2)

- **`cimd_rejected` enriched** (oauth.ts `securityEvent` wrapper, stderr JSON line, same
  hard rule as today — no secrets, no request payloads): `{ reason, client_id:
  clientId.slice(0,200), detail?, attempts?, elapsed_ms? }`. `detail` is the existing
  `CimdError.detail` (resolver-internal error text: `"timeout"`, `"status 503"`,
  `"getaddrinfo EAI_AGAIN claude.ai"` — hostnames only, already public in `client_id`),
  truncated to 300 chars; fields are omitted when they don't apply (`invalid_url` has no
  fetch, `invalid_redirect_uri` keeps its current shape). `elapsed_ms` covers the whole
  load (all attempts).
- **New `cimd_served`** line, emitted only when the answer came from the network or from
  stale grace — cache hits (the hot path) stay silent: `{ client_id: slice(0,200), source:
  "fresh" | "stale", attempts, elapsed_ms, refresh_reason?, detail? }` (`refresh_reason` /
  `detail` present only on `source: "stale"`). Volume: ≤ 1/client/hour plus failure paths —
  negligible, and it gives p95 fetch latency plus direct deploy-burst correlation, the two
  things tonight's diagnosis lacked.
- To carry this, `resolve()` returns a small result object —
  `ResolvedClient { client, source: "cache" | "fresh" | "stale", attempts, elapsedMs }` —
  instead of the bare client. Internal API only (oauth.ts is the sole consumer); the MCP
  tool surface is untouched. On rejection the resolver attaches `attempts` / `elapsedMs`
  to the thrown `CimdError` so oauth.ts can log them.

## Data model changes

None. `oauth_clients` keeps its shape; the upsert statement is unchanged.

## API / MCP tool changes

None. `/oauth/authorize` and `/oauth/token` behavior change only in failure modes (fewer
hard 400s). No MCP tool signature, no JSONB schema, no registry impact.

## Migration plan

None. No schema change, no backfill, no feature flag (behavior changes live only on
previously-failing paths; the stale path additionally requires a prior successful fetch).

## Test plan (`tests/oauth-cimd.test.ts`, stubbed fetch/now/delay as today)

Retry: transient-then-success → 2 fetch calls, `source: "fresh"`, `attempts: 2`; both
transient attempts fail → throws with `attempts: 2`, `elapsedMs > 0`; non-retryable (404) →
1 fetch call; classification table (timeout, `EAI_AGAIN`, 503 → retryable; 404, TLS cert,
too-large, not-JSON, `invalid_document` → not); limiter shares one token per resolve
(always-fail stub: resolves 1–20 each burn exactly one token (40 GETs), resolve 21 →
`rate_limited` — this distinguishes shared-token from per-attempt tokens). Stale: seed →
advance past TTL → refresh fails transiently → stale served (`source: "stale"`);
advance past `fetchedAt + 24 h` → throws; no prior success → throws; limiter denial →
stale served; `invalid_document` → throws despite a stale copy; in-flight dedupe still
shares one load across concurrent resolves. Events: `CimdError` carries
`detail`/`attempts`/`elapsedMs`; the two oauth.ts log lines are covered by review + a
documented manual smoke (dev: point `client_id` at a non-resolving DNS name, observe the
enriched JSON line, then a stale serve with a stopped mock origin).

## Rollout + rollback

Rollout: PR-1 merges first — alone it addresses the incident class (the 20:24 failure was a
single DNS miss a 300 ms-later retry plausibly rescues) and ships the observability needed
to operate PR-2. PR-2 follows after Security's verdict on the 24 h grace. Each PR is its own
deploy via the existing runbook (rebuild app container on the VPS, docs/deploy-vps.md);
monitor by grepping container logs for `cimd_rejected` / `cimd_served` — with the new
fields, the next incident is diagnosable from the log line alone.
Rollback: `git revert` the PR and redeploy; no data to unwind, no migration to reverse.
Constants (300 ms, 24 h, 1 h TTL) are code-level one-liners if tuning is needed.

## Blast radius

- **thingery.dev users:** first connects get strictly more reliable; authorize latency grows
  only on already-failing paths (+300 ms–5.3 s worst case before the 400).
- **Live sessions / issued grants:** untouched — CIMD resolution happens at authorize only;
  tokens, grants and refresh families are unaffected.
- **npm package / registry installs (stdio):** untouched (no HTTP OAuth surface).
- **Self-hosters:** identical behavior, constants in code, no env changes.
- **Upstream metadata hosts:** worst case 2× GETs per resolve on failures, ≤ 40 GETs/h/URL —
  bounded, well under normal client polling.
- **Security posture:** no new fetch class, same SSRF containment on both attempts; the only
  new trust surface is serving an already-validated document up to 24 h under refresh
  failure — documented in docs/security.md §2a/§3.3 by PR-2 (API7 row's containment sentence
  gains retry + stale-grace wording; the "changed document takes effect within 1 h" sentence
  becomes "within 1 h, ≤ 24 h under refresh failure").

## Open questions

1. **Grace window length** — 24 h proposed (THI-1286's example). Security may prefer a
   shorter window (e.g. 6 h) to bound how long removed redirect_uris stay serviceable under
   a sustained upstream outage. Default stands at 24 h pending Security's verdict.
2. **`invalid_document` under stale grace** — spec says fail closed (refresh succeeded and
   said no). If an adopter is ever bitten by a broken deploy on their own metadata host,
   reconsider; not now.
3. **Sampling `cimd_served`** — volume is negligible; log all. Revisit only if adopters run
   huge client fleets.

## PR-sized implementation steps

- **PR-1 — retry-once + event enrichment** (`src/oauth-cimd.ts`, `src/oauth.ts`,
  `tests/oauth-cimd.test.ts`; ~150 lines with tests): `CimdError.detail` explicit +
  `retryable` + `attempts`/`elapsedMs`; retry inside `load()` with injectable delay;
  `resolve()` → `ResolvedClient`; enriched `cimd_rejected`; `cimd_served` for `fresh`;
  tests. Ships independently of PR-2.
- **PR-2 — stale-if-error + docs** (same files + `docs/security.md`; ~130 lines with
  tests): `fetchedAt` in cache entries, `STALE_GRACE_MS = 24 h`, stale serve on
  `fetch_failed`(transient, post-retry)/`rate_limited` per the state machine, `cimd_served`
  `source: "stale"` + `refresh_reason`, module-header comment update, §2a/§3.3 doc updates,
  tests.

Neither PR touches a protected path (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`,
`src/routes.ts`); both stay well under 300 lines. Docs: after merge, the MCP/OAuth reference
(docs-site `connect.mdx` if it mentions CIMD failure behavior) gets a one-line sync by Docs
— no user-visible error text changes, so nothing else to translate.
