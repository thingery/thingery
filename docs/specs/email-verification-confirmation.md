# Spec: verify-email link lands on a friendly confirmation page (THI-1515)

- **Status:** Proposed — awaiting Security review (protected path: `src/routes.ts`) + CEO sign-off. Verdicts to be stated in the implementation PR description per protected-path policy (`AGENTS.md` rule 2).
- **Date:** 2026-11-25
- **Origin:** THI-1515 (user-reported, 2026-11-25: clicking the email-verification link lands on raw JSON `{"ok":true,"email_verified":true}`). Found during THI-1045.
- **Touches:** `src/web-pages.ts` (page renderers), `src/routes.ts` (`/api/verify-email` handler — **protected path**), `tests/email-verification-routes.test.ts`, this doc. No `db/schema.sql`, no `src/auth.ts`, no email-template change.

## Problem

The verification email links to `GET /api/verify-email?token=…`, which returns raw JSON. A human clicking the link from their inbox is dropped on `{"ok":true,"email_verified":true}` — verification works, but the post-verification UX is broken-looking. The failure paths are equally unfriendly (a bare `{"error":"Invalid or expired verification link."}`), and a rate-limited click shows JSON too.

## Context

- The endpoint is a deliberately "browser-friendly GET" (comment at `src/routes.ts`, THI-760 Phase 0 / THI-762): its primary consumer is a human clicking an email link. No programmatic consumer is known; tests are the only JSON dependency.
- The repo already renders human-facing HTML pages server-side for exactly this pattern: the Stripe order/payout **return pages** (`src/web-pages.ts` `orderReturnPage`, `payoutSetupReturnPage`) — capability-URL pages with `Cache-Control: no-store`, `Referrer-Policy: same-origin`, uniform unknown-id body, no JS needed.
- Thingery is self-hostable: the open-source core must give a good experience standalone. The consumer website lives in the private `platform` repo (`apps/web`); the legacy `website/` in this repo is frozen.
- The baseline security headers (`src/security-headers.ts`) apply to every response, including this one; `Referrer-Policy` baseline is `strict-origin-when-cross-origin` (query strings are not sent cross-origin), and the order-return page additionally pins `same-origin` because its URL carries a secret.
- Verification token flow (`issueEmailVerification`, `verifyEmailToken`, hashing, TTL) lives in `src/auth.ts` — untouched by this spec. The emailed URL does not change.

## Decision (Architect): API-rendered HTML confirmation page — not a redirect

`GET /api/verify-email` keeps its URL, status codes, rate limiting, security events, and token semantics exactly as today; only the **body** becomes content-negotiated:

| Case (uniform inside each row) | JSON client (`Accept` without explicit `text/html`) | Browser (`Accept` prefers `text/html`) |
|---|---|---|
| valid token, first consume | 200 `{"ok":true,"email_verified":true}` — **unchanged** | 200 HTML "Email confirmed" page |
| unknown / expired / reused / malformed / missing token | 400 uniform JSON — **unchanged** | 400 uniform HTML failure page — one identical body, no oracle |
| rate-limited | 429 JSON — **unchanged** | 429 HTML "Too many attempts" page |

Negotiation: `req.accepts(["json", "html"]) === "html"`. **`json` is listed first on purpose:** programmatic clients default to `Accept: */*` (Node/undici `fetch` does), which matches the first offered type → JSON, preserving today's contract byte-for-byte (API evolution: extend, don't mutate). Real browsers send `text/html` with quality 1.0 and win the negotiation → HTML.

Alternatives rejected:

- **302 redirect to the consumer website** (`thingery.dev` app route): breaks self-hosters (no platform website deployed; core must stand alone); a redirect that carries the token leaks it into the target's URL/logs, and stripping it adds a second hop plus a new SPA route in the private repo for zero user gain. Rejected.
- **Always HTML, drop the JSON body:** mutates a working API contract for unknown programmatic callers. Rejected (content negotiation is strictly additive).
- **Status 200 for HTML failures** (order-return-page style "same status for known/unknown"): rejected — the order page guards an order UUID; here the uniform-400 property is documented THI-762 security behavior, keep it.

### Page design (in `src/web-pages.ts`, following `orderReturnBody` conventions)

- **Success page:** title "Email confirmed — Thingery"; h1 "Email confirmed"; copy: your email address is verified and your assistant can now list, find, and trade on your behalf; link to `/` (relative — works on any host); canonical sentence footer, verbatim. `noindex = true`.
- **Failure page (all failure modes, one body):** h1 "This link didn't work"; copy: the verification link is invalid, expired, or was already used — if you just clicked it twice, your email is likely already confirmed (log in to check); hint: ask your assistant or use "resend verification email" for a fresh link; link to `/`. No token ever echoed; one identical body for unknown/expired/replayed/malformed/missing (no oracle).
- **Rate-limit page:** h1 "Too many attempts"; copy from the existing 429 message; link to `/`.
- All three: server-rendered, no JS, `page()` shell (inherited CSP applies), `noindex`, and on every HTML response of this endpoint: `Cache-Control: no-store` and `Referrer-Policy: same-origin` (same hardening rationale as F15 on the order page — the request URL carries a secret).

### Handler change (`src/routes.ts`, minimal protected-path diff)

The existing handler keeps its order of operations (limiter → token check → `logSecurityEvent` → respond). Each `res.json(...)` site branches: if `req.accepts(["json","html"]) === "html"`, set the two headers and `res.send(renderer())`, else respond exactly as today. No new routes, no new middleware, no schema, no config.

## Data model changes

None.

## API / MCP tool changes

- No MCP tool signatures change. No route added or removed.
- `GET /api/verify-email` response bodies become Accept-dependent as per the table above. JSON behavior is byte-identical to today for every non-HTML-preferred client, including status codes and error strings.

## Migration plan

None needed — additive code change, no schema step (expand-contract trivially satisfied: nothing contracts).

## Test plan (`tests/email-verification-routes.test.ts`)

1. Browser `Accept: text/html` + fresh token → 200 `text/html`, body contains "Email confirmed", does **not** contain the token substring, has `Cache-Control: no-store` and `Referrer-Policy: same-origin`; DB shows `email_verified_at` set (existing assertion stays).
2. Replay + malformed + missing token with browser Accept → all 400 with byte-identical HTML bodies (no oracle), no token echoed.
3. Rate-limited browser request → 429 HTML page (use the limiter-forcing pattern the suite already uses elsewhere).
4. JSON clients: existing assertions (default fetch) keep passing unchanged; add an explicit `Accept: */*` case asserting the exact legacy bodies.
5. Existing `logSecurityEvent` coverage untouched — events fire identically in both modes.

## Rollout + rollback

- **Rollout:** normal feature branch + PR + green CI; agents merge (THI-36). Deploy via the documented deploy runbook (DevOps executes when ready). No migration, no env change, no config.
- **Rollback:** revert the PR. Email links, token flow, and stored data are unaffected by both deploy and rollback.
- **Blast radius:** registry-listed MCP installs and npm users of the tools — unaffected (not an MCP tool; JSON contract preserved). Self-hosted instances — get the friendly page on upgrade, still work standalone. Live sessions — unaffected. Emails in flight — unchanged URL, better landing.

## Docs note

- `docs/security.md` §"Verification gate" describes the flow, not response bodies — no change required. Docs agent to confirm no reference doc quotes the JSON response of this endpoint (grep `email_verified` in docs/) as part of the implementation PR.

## Open questions

- Exact page copy (wording above is the proposal; reviewer tweaks welcome in the PR).
- None blocking.

## PR-sized breakdown

One implementation PR, well under 300 lines, after Security verdict + CEO sign-off are stated in its description:

1. `src/web-pages.ts`: three pure renderer functions (success / failure / rate-limit), no DB, no imports beyond the existing `page`/`escapeHtml`.
2. `src/routes.ts`: negotiation + header set + renderer calls at the three respond sites of the `/verify-email` handler.
3. Tests per the test plan.
4. This spec doc (already on main via the docs PR that precedes implementation).
