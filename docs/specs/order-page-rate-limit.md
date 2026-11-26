# Spec: rate-limit the order page pay step

- **Status:** Implemented in this PR. **No protected path** touched (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`, `src/routes.ts` untouched) — normal ADR 0007 gate.
- **Date:** 2026-11-26
- **Origin:** finding F1 (LOW severity / LOW-MEDIUM exploitability, OWASP API #4 Unrestricted Resource Consumption) from the ADR-0007 security review of the order-page pay-step PR (#400), filed as the follow-up ticket on the review thread. The review verdict pre-accepted two PR-sized remediations.
- **Touches:** `src/web-pages.ts` (limiter + middleware + fixed 429 body), `src/index.ts` (mount), `tests/order-return-page.test.ts`, this doc.

## Problem

Since the pay step landed, `GET /order/:id` for a *pending stripe* order costs one DB read plus one outbound Stripe `checkout.sessions.retrieve` per request. The route had no rate limiter (like all public pages) and serves `Cache-Control: no-store`, so a capability holder can loop single GETs and consume the account-level Stripe read bucket, degrading `payment_url` retrieval platform-wide. Pre-pay-step the retrieve was reachable only through rate-limited authenticated MCP paths. The route-level limiter additionally caps the page's pre-existing per-hit DB query amplification.

## Context

- Blast radius of the finding is bounded (degraded UX only; every failure mode renders the status-only body, fail-closed) — this is hardening, not an incident response.
- The repo already standardizes on the in-process token bucket `RateLimiter` (src/rate-limit.ts) with per-feature exported limiters (`addressWriteLimiter`, `orderMessageLimiter`, …) and per-IP keying via `trust proxy` 1 (the single-trusted-proxy prerequisite from the /mcp gate spec §4.1: Caddy is the one trusted hop).
- The review verdict pre-accepted two remediations: (1) per-IP `RateLimiter` on the route, or (2) a short TTL memo of the retrieve result. **Decision: option 1** — it caps the whole handler cost (DB query included), not just the Stripe call, and matches the existing anonymous /mcp posture (30 req/min/IP).

## Proposed design

- `orderPageLimiter = new RateLimiter(30, 60_000)` in src/web-pages.ts, exported for tests (reset convention).
- `orderPageRateLimit` middleware mounted in src/index.ts directly in front of the handler: `app.get("/order/:id", orderPageRateLimit, asyncHandler(orderReturnPage))`. `/order/payout-setup` (static, no DB/Stripe) stays unlimited.
- Bucket key: `req.ip ?? "unknown"` (fail-closed: an unresolvable IP collapses into one global bucket rather than bypassing the limit).
- Limit path: **429** with `Retry-After: 60`, and the F15 headers kept on every response (`Cache-Control: no-store`, `Referrer-Policy: same-origin`).
- **No-oracle preserved by construction:** the limiter fires before the order lookup, so the 429 body is fixed, id-independent copy ("Too many requests" — one shape for known, unknown, and malformed ids; it renders neither the status label nor the not-found line, and reflects nothing). A rate-limited known id is indistinguishable from a rate-limited unknown id.

### Explicit state machine (request → response)

| Input | Response |
|---|---|
| requests 1–30/min per IP | handler runs — existing page states (pay-step spec table, docs/specs/order-page-pay-step.md), 200 |
| request 31+/min per IP | fixed "Too many requests" body, 429 + `Retry-After: 60`, F15 headers |
| bucket refill (continuous, 30/min) | tokens restore; no hysteresis, no penalty state |

Illegal/edge inputs (bad UUID, unknown id) are unchanged — they are handler states, not limiter states.

## API / MCP tool changes

None. MCP `payment_url` contract untouched; page states unchanged for requests within the bucket. Self-hosted single-instance semantics match the existing in-memory limiter posture (documented in src/rate-limit.ts — swap for Redis when federating).

## Data model changes

None.

## Test plan

- Regression that fails against pre-change code: fire 35 requests from one IP at a pending stripe order with a live session; assert exactly 30 pass, 5 return 429, and `retrieveCalls === 30` (pre-change: 35/0/35).
- Uniformity: after exhausting the bucket, 429 body for the known id is byte-identical to the 429 body for an unknown id; asserts no `Awaiting payment` / `Order not found` / pay button / order data / stripe.com on the limit path; F15 headers + `Retry-After` present.
- Existing pay-step/F15 tests unchanged (bucket reset per test).

## Rollout & rollback

Additive middleware on a non-protected route; no migration, no config, no env var (fixed 30/min like the anon MCP bucket). Rollback = single-commit revert. Risk: a buyer behind a shared egress IP (office/VPN) could hit 429 after 30 page views/min — self-heals within the window; the copy points at the assistant path (`get_order`), which is separately rate-limited and unaffected.

## Open questions

None. Option choice was pre-accepted by the review verdict; residual risk after merge: LOW (matches the accepted posture of the pay-step review, now reduced).
