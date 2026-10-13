# Thingery Security — Threat Model & Hardening Backlog

> Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

This document is the security baseline for the flagship instance at
`https://thingery.dev` and for anyone self-hosting. It covers what we protect, where the
trust boundaries are, what is exploitable today, and the prioritized hardening backlog.
It is maintained by the Security role; changes go through PR like everything else.

- **Product posture:** open data (Apache-2.0), self-hostable, free for buyers and sellers.
  Listing content is public by design; confidentiality of listings is *not* a security goal.
  Integrity of listings, availability of the service, and secrecy of credentials are.
- **Lenses used:** STRIDE, OWASP API Top 10 (2023), OWASP LLM Top 10, least privilege,
  defense in depth, fail-securely, complete mediation, secure defaults.
- **Evidence convention:** findings cite code paths (`file/function`), not line numbers,
  so the references survive refactors. Everything cited was verified against `main`
  as of this document's commit.

---

## 1. Assets and actors

**Assets**

| Asset | Why it matters | Impact if lost |
|---|---|---|
| Seller API keys (`thg_...`) | Full write access to a seller's listings | Fake/modified listings under a real seller's name |
| Account credentials (email + scrypt hash) | Gateway to the API key | Account takeover |
| Session cookie (`thingery_session`) | Browser write access incl. chat agent | Listing tampering via chat tools |
| The Item Graph (Postgres: items, sellers) | The product itself | Platform unusable / untrustworthy |
| Uploaded images (`/app/uploads`) | Listing content | Disk exhaustion, illegal content hosting |
| Infrastructure secrets (`SESSION_SECRET`, `POSTGRES_PASSWORD`, `EMBED_API_KEY`, `LLM_API_KEY`) | Trust anchors + cost-bearing credentials | Session forgery, DB access, provider bill |
| Platform trust (spam-free, non-malicious listings) | Why agents and humans use Thingery at all | Slow death by spam; agent users poisoned |

**Actors:** anonymous buyers (browser + agents), authenticated sellers (MCP clients with
API keys, browsers with sessions), the chat assistant (server-side LLM agent acting for a
logged-in user), operators (VPS `thingery` user, GitHub maintainers), and attackers
(spammers, scrapers, griefers, credential thieves). Every actor is untrusted until
authenticated; listing content stays untrusted *after* publication.

## 2. Trust boundaries

```
                    ┌────────────────────────── thingery.dev VPS (Infomaniak, Debian 12) ─────────────────────┐
                    │                                                                                       │
 Browser ──TLS──▶ Caddy ──plain HTTP──▶ Express app ──SQL (TCP, password)──▶ Postgres 16 + pgvector           │
   ▲             :443/:80    (compose network)  │  │                                                      │
   │                                          │  └──HTTPS──▶ Embeddings API (EMBED_API_KEY)                  │
 MCP client ──TLS──▶ /mcp (Bearer thg_...) ───┘                                                              │
   │                                          └──HTTPS──▶ LLM chat API (LLM_API_KEY)                        │
   │                                                                                                         │
 Future: carrier/Stripe ──TLS──▶ Caddy ──▶ app webhook endpoint (does not exist yet)                          │
                                                                                                    └────────┘
```

Boundary-by-boundary:

1. **Browser ↔ Caddy.** TLS terminates at Caddy (automatic Let's Encrypt). `X-Forwarded-For`
   starts here. **Known gap:** the app never sets `trust proxy` (`src/index.ts`), so behind
   Caddy every request's `req.ip` is the Caddy container's address — all anonymous clients
   share one identity. See backlog item H1.
2. **Caddy ↔ app.** Plain HTTP on the compose network, single host. Acceptable today;
   note it becomes a boundary worth encrypting the day a second host or a service mesh
   appears. The app port is `expose`-only; only Caddy publishes 80/443. UFW allows SSH/80/443.
3. **App ↔ Postgres.** Password auth over TCP inside the compose network, no TLS, DB not
   published. Same single-host caveat. DB password lives in the VPS `.env`.
4. **MCP client ↔ `/mcp`.** The only client-facing API boundary. Streamable HTTP,
   stateless, JSON-RPC. Bearer API key is the sole authentication; anonymous callers get
   the three public tools (`describe_category`, `search_items`, `get_item`). Request
   bodies are capped at 4 MiB by the MCP SDK default (`requestBody.js` in
   `@modelcontextprotocol/sdk`), which the app relies on implicitly.
5. **App ↔ external LLM/embedding APIs.** Server-side egress with cost-bearing keys.
   Requests include untrusted listing content (embeddings) and user chat (LLM). Keys must
   never appear in logs or responses.
6. **Future webhooks (carrier/Stripe).** Do not exist yet. **Design requirement before the
   first one ships:** verify signatures (e.g. Stripe's `Stripe-Signature` header) with a
   constant-time comparison, reject-by-default on missing/invalid signature, enforce
   replay protection (timestamp window), and put webhooks behind their own rate limit.
   No webhook endpoint may trust source-IP allowlisting alone.

## 3. Threat model

### 3.1 Named risks

**Spam listings.** Any valid seller key can create listings at up to the authed MCP rate
limit (120/min ≈ 172k/day per key; `src/index.ts` `authedLimiter`). There is no per-seller
listing velocity limit, no content moderation surface, no takedown tooling short of manual
SQL. Each listing also triggers an embeddings API call (`src/items.ts` `createItem`), so
spam doubles as a **cost DoS** on `EMBED_API_KEY`. *Lens: Sensitive Business Flows abuse
(API6:2023), Unrestricted Resource Consumption (API4:2023).*

**Fake sellers.** Signup (`src/routes.ts` `/api/signup`) requires only a syntactically
valid email — no verification mail, no CAPTCHA, no identity proof. The account is
immediately issued an API key. Throwaway identities are free. The one control in place
(10 signups/logins per IP per hour) is currently defeated by the shared-bucket bug (H1).
*Lens: Broken Authentication (API2:2023), Spoofing (STRIDE).*

**Scraping.** The dataset is open by design — scraping it is not theft, and we do not
pretend otherwise. The scraping *threat* is resource consumption and freshness laundering:
`search_items` is public with limit ≤ 50, `/browse` renders 30 items, and anonymous `/mcp`
is nominally 30 req/min. Once H1 is fixed, per-IP limits make bulk scraping expensive
enough to be polite; robots.txt already states our crawl preferences. If scraping becomes
an operational problem, the lever is rate limits and caching, not access control.
*Lens: Unrestricted Resource Consumption (API4:2023), Economy of Mechanism.*

**Upload abuse.** Two upload paths: MCP `add_item_image` (base64, ≤ 5 MB claimed) and
browser `POST /api/items/:id/images` (raw bytes, ≤ 5 MB + 64 KB enforced by
`express.raw`). Both owner-check the item and allowlist media types — good. Gaps:
**no cap on images per item** (`src/images.ts` `addItemImage` appends unbounded),
**no per-seller storage quota**, **no rate limit on the browser upload route at all**,
and **media type is client-asserted, not validated against actual bytes** (no magic-byte
check). A single authenticated seller can fill the disk: 5 MB × request rate. Also,
`create_listing` accepts arbitrary `z.string().url()` image URLs — including
`javascript:`/`data:` schemes and attacker-controlled hosts (tracking pixels that
deanonymize buyers who open item pages). *Lens: API4:2023, input validation, least
privilege.*

**Key leakage.** API keys are stored **plaintext** in `sellers.api_key` (the schema's own
comment says "store hashed in production"), returned by `/api/me` on every page load of
the account page, included in login/signup responses, and readable by every `SELECT` in
`src/auth.ts`. Nightly backups (`docs/deploy-vps.md` §4) are unencrypted `pg_dump`s of
all keys, password hashes, and emails sitting 14 days in `/var/backups` on the same VPS.
A backup or DB read is a full compromise of every seller. There is also no key rotation
or regeneration flow, and no way to revoke a session (see H2). *Lens: Cryptographic
Failures (A02:2021), secrets management.*

### 3.2 STRIDE — MCP endpoint and API surface

| Threat | Surface | Assessment |
|---|---|---|
| **S**poofing | `/mcp` Bearer key; session cookie | Keys are 192-bit random (`thg_` + 24 bytes) — unguessable. But: no email verification (anyone can be "anyone"), keys never expire, sessions can't be revoked.Spoofing a *seller identity* is cheap; spoofing a *specific* seller requires the key. |
| **T**ampering | `create_listing`/`update_listing` payloads; `attributes` JSONB | TLS protects transit. Owner checks are correct (`updateItem` scopes `WHERE seller_id = $`); no cross-seller tampering found. Free-form attributes pass through by design — tampering with *semantic* integrity (fake ISBNs, wrong sizes) is unmitigated and accepted for now. Media type of uploads is client-asserted (tamperable). |
| **R**epudiation | Listing creation/edit, logins, rate-limit hits | **No audit trail.** Logs are `console.log/error` only; who created/edited what is reconstructible from the DB but nothing logs auth failures or abuse. Repudiation currently fails. Fix in H4. |
| **I**nformation disclosure | `get_item`, `/api/me`, error paths, headers, external image URLs | `get_item` returns `seller_id` (a UUID — acceptable, unguessable, no display name). Signup returns 409 "email exists" — account enumeration. Errors echo exception messages (`describeError`, signup 500). `x-powered-by` disabled since the baseline-headers PR. External image URLs leak viewer IPs to third parties. Plaintext keys in DB/backups (H2). No secrets found in repo/logs today. |
| **D**enial of service | `/mcp`, `/api/*`, uploads, embeddings API, chat LLM | Body sizes bounded (4 MiB SDK cap on `/mcp`, 256 KB JSON on `/api`, 5 MB uploads). Query limits capped (≤ 50 search, ≤ 100 my_listings). Real DoS vectors: the shared-bucket bug (H1) lets one client lock out *all* anonymous users; disk fill via uploads (H3); cost DoS on `EMBED_API_KEY`/`LLM_API_KEY` via spam or chat. ILIKE wildcards are escaped (`src/items.ts`), preventing pattern-DoS. |
| **E**levation of privilege | Tool surface, chat agent | **None found.** Every write tool re-checks `ctx.seller`; there is no admin surface at all (also means no privileged code to exploit — and no moderation capability; see H4). Chat agent tools execute with the *session* seller only (`src/chat.ts` `executeTool`). |

### 3.3 OWASP API Top 10 (2023) — every MCP tool is an API endpoint

| # | Category | Status | Evidence / notes |
|---|---|---|---|
| API1 | Broken Object Level Authorization | ✅ protected | `updateItem`/`myItems`/`addItemImage` all scope by `seller_id`; `get_item` is public-by-design, IDs are UUIDs (no enumeration). |
| API2 | Broken Authentication | ⚠️ gaps | High-entropy keys + scrypt + `timingSafeEqual` are solid. Gaps: no email verification, keys never expire/rotate, sessions non-revocable, signup 409 enumeration. → H2, H4 |
| API3 | Broken Object Property Level Authorization | ⚠️ by design | `attributes` is deliberately free-form (`src/attributes.ts`); undeclared keys pass through. Documented tradeoff — revisit if attributes ever drive pricing/shipping logic. |
| API4 | Unrestricted Resource Consumption | ❌ | Broken IP attribution (H1), uncapped uploads (H3), cost-bearing external calls per listing/chat. Rate limits *exist* on paper for `/mcp`, auth, chat. |
| API5 | Function Level Authorization | ✅ | Every write tool requires seller; public tools are read-only by construction. |
| API6 | Sensitive Business Flows | ❌ | Signup and listing-creation flows have no abuse controls beyond (broken) IP limits. → H4 |
| API7 | Server Side Request Forgery | ✅ today | The server never fetches URLs from user input (images are stored, not fetched; embed/LLM URLs come from env). **Future risk:** if we ever proxy/fetch external image URLs or add webhooks, SSRF controls (allowlist, no internal ranges) are mandatory. |
| API8 | Security Misconfiguration | ⚠️ | Baseline headers shipped (CSP without inline script, HSTS, nosniff, Referrer-Policy; `x-powered-by` off). Still open: `trust proxy` unset, `SESSION_SECRET` not wired into prod compose. → H1 |
| API9 | Inventory | ✅ small | One repo, one VPS, one npm package, one MCP registry entry. Stdio mode (`npx thingery`) is a second deployment shape — keep it in mind when adding env-dependent features. |
| API10 | Unsafe Consumption of APIs | ⚠️ | LLM/embedding responses are trusted: `embedText` casts responses to `number[]` without validation; LLM `tool_calls` are executed directly (bounded by the seller session and a 6-round loop). Acceptable now; revisit with H5. |

### 3.4 LLM/agent-specific risks (listings are untrusted input)

Thingery's users are agents, and its content is machine-consumed. Three flows matter:

1. **Indirect prompt injection via listing content (LLM01).** A listing's title,
   description, and attributes are attacker-controllable text. They flow verbatim into
   (a) the embeddings request, (b) `search_items`/`get_item` results that *buyer agents*
   read, and (c) the **chat agent's own context** as tool results (`src/chat.ts`:
   `executeTool("search_items")` output is appended to the message list that drives the
   same loop that can call `create_listing`/`update_listing` under the victim's session).
   An attacker who publishes a listing containing instruction-like text can attempt to
   hijack any downstream agent that reads it — including hijacking a logged-in user's
   chat session into destructive `update_listing` calls (e.g. mass status changes).
   *This is the defining LLM risk for a marketplace of agents.* → H5
2. **Excessive agency (LLM06-ish).** The chat agent can publish and mutate listings
   without a confirmation step. For listings this is a product choice, not a bug — but
   destructive ops (`status: "deleted"`) should require an explicit user confirmation
   turn, and the tool surface should stay minimal. The 6-round loop bound and 12 KB
   tool-result truncation are good existing mitigations.
3. **Output handling (LLM02-ish).** Chat replies and tool results are rendered with
   `textContent` in `website/chat.html` (safe) and escaped in `web-pages.ts` (safe).
   One sink uses `innerHTML` with `data.seller.name` (the user's own display name —
   self-XSS only, fixed trivially by switching to `textContent`; see quick wins).
   MCP tool responses are JSON — agent clients must treat listing fields as data, which
   is why tool descriptions should say so explicitly (H5).

Additional note for ** buyers' agents**: `get_item` returns `seller_id` and links but no
seller contact channel; trade settlement happens outside Thingery today. When payments
or messaging arrive, those surfaces inherit every risk in this document plus PCI and
phishing concerns — threat-model them before building, not after.

## 4. Current state — what exists and what doesn't

**In place (verified on `main` + live):**

- Parameterized SQL everywhere; ILIKE wildcards escaped; limits always parameter-capped.
- Owner checks (complete mediation) on all write paths: `updateItem`, `myItems`, `addItemImage`.
- scrypt password hashing with per-user salt and `timingSafeEqual`; HMAC-signed session
  cookies verified in constant time; 192-bit API keys.
- Zod validation on every MCP tool input and browser API route (type/length/range).
- Rate limiters: `/mcp` 120/min per key, 30/min per IP; signup+login 10/h per IP; chat
  10/h anon / 60/h authed. Body caps: 4 MiB `/mcp` (SDK default), 256 KB `/api` JSON,
  5 MB uploads.
- Upload allowlist by media type, generated filenames (no traversal), owner check, images
  served from `/img` with immutable caching.
- HTML output escaped on all server-rendered pages; `textContent` in chat UI.
- Cookies: `httpOnly`, `SameSite=lax`, `secure` in production; state-changing browser
  routes are POST + `application/json`-only (express.json ignores form posts), which —
  with SameSite — raises the CSRF bar to "not practically exploitable" today. No CORS
  headers are emitted (fail-closed for cross-origin browser callers).
- Network: only Caddy publishes ports; DB and app are `expose`-only; UFW SSH/80/443.
- CI (typecheck, build, test) runs on every PR/push to `main`; deploys are SSH-gated
  behind `DEPLOY_ENABLED` + GitHub Secrets.
- `npm audit --omit=dev` on the current lockfile: **0 production vulnerabilities**.
- Baseline security headers on every response (`src/security-headers.ts`): CSP with
  `script-src 'self'` only (no inline script — all executable scripts are static files),
  HSTS `max-age=15552000`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `x-powered-by` disabled.
  `style-src 'unsafe-inline'` remains (documented tradeoff). Item-page JSON-LD is
  `<`-escaped so seller content cannot break out of the data block (stored XSS fix).
- Fail-securely examples: unset `SESSION_SECRET` → sessions invalid (not forged);
  missing DB → 503 on `/healthz`; invalid key → read-only toolset.

**Missing (each maps to a backlog item below):**

- `trust proxy` configuration → IP-based limits are one global bucket (H1).
- API key hashing at rest, rotation/regeneration, show-once; encrypted offsite backups;
  `SESSION_SECRET`/`LLM_API_KEY` not passed in `docker-compose.prod.yml` (H2).
- Upload caps/quotas, upload-route rate limit, magic-byte validation, image URL scheme
  allowlist (H3).
- Email verification, listing velocity limits, moderation/takedown tooling, security
  event logging and alerting (H4).
- Prompt-injection hardening for the chat agent and downstream agent consumers (H5).
- CSP `style-src 'unsafe-inline'` remains (inline `<style>` blocks and `style=""`
  attributes); replace with per-response nonces or external stylesheets later.
- **Branch protection on `main` is NOT enabled** (verified via the GitHub API at the time
  of writing: no required checks, no rulesets). The convention "never push to main,
  human merges" is currently enforced only by discipline. Enable require-PR + green CI
  + no direct pushes (quick wins).
- `npm audit`/`npm outdated` are not part of CI (see §7 — current dev-dep findings exist).

## 5. Secrets hygiene policy

**Policy: keys and secrets live only in GitHub Secrets (CI/CD) or the VPS
`/opt/thingery/.env` (mode 600, owned by `thingery`). Never in the repo, never in
commits, branches, or PRs; never in code, logs, error messages, or issue/chat threads.
If a secret appears anywhere it shouldn't: rotate it first, then clean up, then report.**

Concretely:

- `.env` is gitignored and dockerignored (verified). Placeholders only in `.env.example`.
- CI secrets (`DEPLOY_SSH_KEY`, `NPM_TOKEN`) are referenced as `${{ secrets.* }}` only.
- Logs: current code logs no secrets, and error paths return exception messages — keep
  it that way when adding features; never `console.log` a key, header, or cookie.
- Rotation: `SESSION_SECRET` or `POSTGRES_PASSWORD` rotation invalidates sessions /
  requires a coordinated restart — acceptable. Provider keys (`EMBED_API_KEY`,
  `LLM_API_KEY`) rotate freely in `.env` + `docker compose up -d`. API key rotation for
  sellers does not exist yet (H2 deliverable).
- **What the `.env` baseline is not:** it is not a vault — no per-secret access control,
  no audit trail, no automatic rotation. Any process or person with root on the VPS can
  read every secret. Acceptable for one trusted operator; must be revisited before
  anyone else gets production access, and before webhook signing secrets for
  carriers/Stripe arrive (those should go in with a rotation story from day one).

## 6. Top-5 hardening backlog

Ordered by (severity × exploitability) ÷ effort — i.e., what to do first. These are
roadmap candidates for the Architect; each becomes its own issue/PR. "Severity" is
worst-case damage, "Exploitability" is how practical the attack is today.

### H1 — Fix client-IP attribution so rate limits actually rate limit

- **Class:** Security Misconfiguration (A05) + Unrestricted Resource Consumption (API4).
- **Evidence:** `src/index.ts` never calls `app.set("trust proxy", ...)`. Behind Caddy,
  `req.ip` is the Caddy container's address, so `ip:${req.ip}` buckets in
  `src/routes.ts`/`src/index.ts` are **one bucket shared by every anonymous user on the
  internet**: 30 `/mcp` calls/min and 10 signups+logins/hour globally. Two consequences:
  (a) a single abusive client locks out every anonymous buyer; (b) per-IP abuse control
  against spam/credential-stuffing doesn't exist. Verified in code; behavior follows
  from Express semantics with no trust-proxy setting.
- **Severity: High (availability + all IP-based abuse controls). Exploitability: High**
  (trivially reachable; arguably already degrading anon `/mcp` under load).
- **Fix:** `app.set("trust proxy", 1)` (exactly one trusted hop — Caddy; forged
  `X-Forwarded-For` entries stay untrusted because Caddy appends the real client IP),
  regression test that simulates the XFF chain, and a follow-up to key the anon limiter
  correctly. When a second proxy or instance appears, move limiter state to Redis and
  re-evaluate the hop count. **Every IP-based control in H3/H4 depends on this.**
- **Owner:** Coder implements; Security reviews; DevOps deploys. **Effort: S (< 1 day).**

### H2 — Secrets at rest: hash API keys, encrypt backups, wire prod secrets properly

- **Class:** Cryptographic Failures (A02) + secrets management.
- **Evidence:** `db/schema.sql` stores `api_key` plaintext (its own comment: "store
  hashed in production"); `src/auth.ts` selects keys everywhere; `/api/me` and
  login/signup responses return the key; `docs/deploy-vps.md` §4 cron produces
  unencrypted `pg_dump` (all keys, password hashes, emails) into `/var/backups` on the
  same VPS, 14-day retention, no offsite copy; `docker-compose.prod.yml` doesn't pass
  `SESSION_SECRET` (sessions silently reset on every restart) or `LLM_API_KEY`.
- **Severity: High** (backup/DB read = every seller account compromised; session
  invalidation storms). **Exploitability: Low** (requires VPS/DB/backup access or a
  future read primitive — but backups get copied, rsynced, and forgotten).
- **Fix:**
  1. Store `sha256(api_key)` and look up by hash (the key has 192 bits of entropy, so a
     fast hash is appropriate; no salt needed for random tokens). Show-once semantics at
     creation + a "regenerate key" endpoint that revokes the old key.
  2. Backup pipeline: encrypt dumps client-side (e.g. `age` with a key held offsite)
     before writing to disk, push offsite (object storage), keep the 14-day local prune.
  3. Add `SESSION_SECRET` (+ document rotation) and `LLM_API_KEY` to the prod compose
     env; fail startup loudly in production when `SESSION_SECRET` is unset.
  4. Session tokens: include an issue timestamp, reject tokens older than 30 days
     server-side (today only the cookie expires, the HMAC never does), and invalidate
     sessions on password change (bump a per-seller epoch into the MAC input).
- **Owner:** Coder (1–3), DevOps (2, backup pipeline on the VPS), Security reviews and
  signs off the schema change (protected file per AGENTS.md). **Effort: M (2–4 days).**

### H3 — Upload abuse controls: caps, quotas, real content validation

- **Class:** Unrestricted Resource Consumption (API4) + input validation.
- **Evidence:** `src/images.ts` `addItemImage` appends to `items.images` with no count
  cap; no per-seller storage quota; `POST /api/items/:id/images` (`src/routes.ts`) has
  **no rate limiter at all** (only session auth); media type is taken from the client's
  `Content-Type`/tool argument, never checked against the bytes; `create_listing`
  accepts `z.string().url()` for image URLs, which permits `javascript:`/`data:`
  schemes and arbitrary third-party hosts (buyer IP leak via tracking pixels,
  indirect-content risk for agents).
- **Severity: Medium** (disk exhaustion on a 20 GB VPS = full outage; illegal-content
  hosting is a real-world risk for any public upload surface). **Exploitability: High**
  (any free account; the browser route isn't even rate limited).
- **Fix:** cap images per item (12, matching `create_listing`'s array cap), per-seller
  daily upload quota (count + bytes), rate-limit the upload route, validate magic bytes
  (JPEG/PNG/WebP/GIF signatures) before accepting, allowlist `http(s)` for image URL
  fields (reject other schemes), and document that the SDK's 4 MiB body cap currently
  makes the "max 5 MB" claim on `add_item_image` unreachable via `/mcp` (~3 MB real
  ceiling after base64 + JSON overhead — align the doc, tool description, or raise
  `maxRequestBodySize` deliberately).
- **Owner:** Coder; Security reviews (upload paths are protected per AGENTS.md).
  **Effort: M (2–3 days).**

### H4 — Spam and fake-seller controls + security event logging

- **Class:** Sensitive Business Flows (API6) + Logging/Monitoring Failures (A09).
- **Evidence:** signup issues a working API key for any syntactically valid email
  (`src/routes.ts` `createAccount`); no listing velocity limits beyond the per-key MCP
  bucket; no moderation or takedown surface (no admin API exists — cleanup means manual
  SQL); no security events are logged anywhere (auth failures, signups, rate-limit
  rejections, listing creates are invisible).
- **Severity: Medium** (platform trust — the product dies by spam before it dies by
  exploit; also cost DoS on the embeddings API per listing). **Exploitability: High**
  (free accounts, trivial automation — contingent on H1 for the IP-throttling part).
- **Fix (pragmatic 90%):**
  1. Per-seller listing velocity limit (e.g. 50 active listings / 100 creates per day).
  2. Security event logging as structured JSON lines (signup, login success/failure,
     rate-limit rejections, listing create/update/delete, image upload) — never logging
     secrets or full payloads. Ship to stdout; Caddy/Docker capture is enough for now.
  3. A takedown path: an operator-only way to mark a seller/listing `deleted` (even a
     documented SQL runbook is acceptable for v1) — plus a `report` affordance for
     buyers/agents later.
  4. Email verification before *publishing* (search can stay open) — **product decision
     (friction vs. trust), needs CEO/Architect sign-off**, hence last in the item.
- **Owner:** Coder (1–3), CEO/Architect decision on (4), Security defines the event
  schema. **Effort: M–L (3–5 days incl. the verification flow).**

### H5 — Agent hardening: treat listings as data, not instructions

- **Class:** LLM01 Prompt Injection (+ LLM06 Excessive Agency, LLM02 Output Handling).
- **Evidence:** `src/chat.ts` feeds `search_items`/`get_item` output — attacker-authored
  listing text — back into the LLM context that also holds the victim's session tools
  (`create_listing`, `update_listing`). A crafted listing can attempt to commandeer a
  logged-in user's chat into destructive updates. Separately, buyer agents consuming
  `get_item`/`search_items` receive raw listing content with no machine-readable marker
  that it is untrusted user-generated data.
- **Severity: Medium-High** (trust in the platform's agent ecosystem; a single viral
  "ignore your instructions" listing damages every downstream user). **Exploitability:
  Medium** (attack reliability depends on the model; the *channel* is fully open).
- **Fix:**
  1. Wrap tool results in explicit delimiters in the chat prompt and instruct the model
     that content inside them is data, never instructions.
  2. Require a user-confirmation turn for destructive chat actions (`status` changes to
     `sold`/`deleted`, price drops) — human-in-the-loop for destructive ops.
  3. Add provenance to tool descriptions and `get_item` output: listing fields are
     user-generated content; agents must treat them as data. (Tool descriptions are
     protected per AGENTS.md — normal PR review applies.)
  4. Keep the existing good mitigations (6-round loop bound, 12 KB result truncation)
     and add a regression test asserting delimiters are present.
- **Owner:** Coder; Security reviews (tool surface changes are protected files).
  **Effort: S–M (1–2 days).**

**Quick wins (each < half a day, bundle into one PR):**

- ~~Security headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  a narrow `Content-Security-Policy` for the static pages; disable `x-powered-by`
  (`app.disable("x-powered-by")`).~~ **Done** — shipped with the baseline-headers PR
  (upstream #9), including `script-src 'self'`-only CSP and the JSON-LD `<`-escaping fix.
- Enable branch protection on `main` (require PR + green CI + no force push).
- `npm audit --omit=dev --audit-level=high` as a CI step + bump vitest to ≥ 4.1.11
  (see §7).
- Uniform signup response to kill the 409 account-enumeration oracle (or accept and
  document it — product call; flag it in the PR either way).
- `website/chat.html`: replace the one `innerHTML` sink (display name) with
  `textContent`.
- Secret scanning (e.g. gitleaks) in CI, plus a `thg_` pattern check so a real key can
  never land in a commit.

## 7. Dependency audit cadence

**Who runs it:** the Security role, on every release tag and at least weekly;
anyone can run it anytime.

**Baseline (recorded at this document's commit):**

- `npm audit --omit=dev` (production): **0 vulnerabilities**.
- `npm audit` (incl. dev): **3 — 2 critical, 1 moderate**, all in the test toolchain:
  `tinypool` ≤ 2.1.1 (prototype pollution → RCE gadgets, GHSA-5gmw-xhrv-c9v3 /
  GHSA-85c8-ppgw-ccpr) and `@vitest/mocker` (path traversal, GHSA-82fw-gwwq-j7x9),
  both reached via `vitest`. **Not shipped in production** (the runtime image runs
  `npm ci --omit=dev`), but CI executes the vulnerable code on every push — fix by
  bumping vitest to ≥ 4.1.11 (breaking, dev-only) in the quick-wins PR.
- `npm outdated`: `express` 4→5, `zod` 3→4, `typescript`, `vitest`, `@types/*` are
  behind majors. No action forced; plan `express` 5 deliberately (rate-limit and
  body-parser semantics shift) rather than reactively.

**Cadence and ownership:**

1. **CI (every PR):** `npm audit --omit=dev --audit-level=high` fails the build.
   Quick-wins PR adds this.
2. **Weekly (Security):** run `npm audit` (full) + `npm outdated` against `main`;
   triage new findings in an issue: severity, exploitability (is the package shipped?),
   owner, and either a fix PR or a documented accept-with-date. Dev-only findings get a
   30-day fix SLA; production findings are immediate.
3. **On every release tag:** re-run both before `npm publish` — the npm package and the
   Docker image inherit the lockfile, so this is the last gate.
4. **Supply-chain hygiene (standing rules):** lockfile-only installs (`npm ci` in CI,
   already the case), no new runtime dependency without a Security review comment,
   watch for typosquats when adding packages, and pin GitHub Actions to full SHAs
   (currently `appleboy/ssh-action@v1` is tag-pinned — tighten when touching deploy).

## 8. Incident response, briefly

- **Suspected key/secret leak:** rotate the secret first (VPS `.env` / GitHub Secrets /
  provider console), then investigate, then disclose per the disclosure policy below.
- **Spam/illegal content:** follow [`docs/moderation-runbook.md`](moderation-runbook.md) —
  preserve a DB snapshot for evidence first, then soft-delete the listing and disable the
  seller's key (all procedures tested; see the runbook).
- **Compromise of the VPS:** assume DB + backups + `.env` are gone; rotate everything
  (DB password, session secret, provider keys, deploy key, npm token), redeploy from a
  clean checkout, and diff `main` against the last known-good tag.
- **Disclosure discipline:** unpatched vulnerabilities are not discussed outside the
  issue thread; no PoCs in the public repo. Thingery has no private advisory channel
  yet — security reports arriving publicly should be triaged by the CEO for
  confidential handling.

## 9. Keeping this document honest

Review triggers: any PR touching `src/auth.ts`, `src/rate-limit.ts`, `src/routes.ts`,
`src/chat.ts`, `src/tools.ts`, `db/schema.sql`, the CI/deploy workflows, or the VPS
runbook must check whether this document still tells the truth and update it in the same
PR (or open a follow-up issue saying what changed). The Security role re-verifies the
backlog quarterly and after any incident.
