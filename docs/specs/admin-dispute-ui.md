# Spec: minimal admin dispute UI (THI-562 work item 3)

Status: revised 2026-11-10 (rev 2) — THI-566 B1–B3 and both minors normative (limiter split 10/300 per IP/hr, constant-time secret compares, explicit `SESSION_SECRET` ≥32 with fail-closed 404 gate) · Owner: Architect · Review: Security re-approval per revision, CEO sign-off required — touches protected path `src/routes.ts`.

## Problem

Disputes are resolved by `curl` against `POST /admin/orders/:id/resolve-dispute`
with a Bearer `ADMIN_API_KEY`. There is no UI: no list of disputed orders, no
order context, no message history, no record of what an operator looked at.
The acceptance bar for Phase 1 is that an operator resolves a dispute through
a minimal admin UI — no raw SQL, no admin-key endpoint in a terminal.

## Context

- The JSON endpoint already implements the hard parts: outcome
  `refund|release`, `refundAfterTransfer` (transfer reversal + refund,
  idempotent), `releaseWithReconcile`, timing-safe key compare, boot-time
  route disable, attempt rate limiting, `order_events` audit trail
  (`src/routes.ts` §admin).
- `web-pages.ts` renders the site's server-side HTML pages (existing `page()`
  helper, no client framework) — the admin pages reuse it.
- Order messaging (work item 1) gives disputes an evidence trail the UI can
  show; the admin detail page reads it read-only.
- `ADMIN_API_KEY` exists in config with fail-closed boot validation
  (≥32 chars or the route stays disabled).

## Proposed design

Three server-rendered pages + one form action, session-gated:

**Session, not per-request key.** `GET/POST /admin/login`: operator submits
the admin key once in a form; on timing-safe match the server sets an HMAC
cookie `admin_session = base64(exp) + "." + HMAC_SHA256(SESSION_SECRET, "admin|" + exp)`
— httpOnly, Secure, SameSite=Strict, 8-hour TTL. Every `/admin/*` page and
action requires a valid cookie; failures redirect to the login page. The
existing attempt limiter and a `admin_login_{ok|denied}` security event cover
brute force and audit. The JSON endpoint keeps its Bearer-key auth unchanged
(scripts keep working; no behavior change to its callers).

**Limiter scope (B1).** The strict `adminAttemptLimiter` (10/IP/hr) meters
**only the three state-changing POSTs** — login, resolve, reveal.
Authenticated page GETs (`/admin/disputes`, `/admin/disputes/:id`) run under a
separate, higher GET limit — a distinct `adminPageLimiter` at 300/IP/hr — so
operator browsing can never eat the action bucket; the secure default must
not be widened later for usability.

**CSRF.** `POST /admin/disputes/:id/resolve` (form) requires a CSRF token
embedded in the detail page, bound to the session (HMAC of `"csrf|" + exp`,
same secret) and checked server-side. SameSite=Strict is defense-in-depth,
not the control.

**Constant-time secret compares (THI-566 minor).** Every check of a secret
value — the login key match, the session cookie MAC, and the CSRF token —
uses a constant-time compare (`crypto.timingSafeEqual`, the existing
`adminKeyMatches` pattern). No plain string equality on derived secrets
anywhere in the admin path.

**Pages.**

**Output encoding (B2).** Every interpolated field — item titles, handles,
message bodies, event payloads, and error re-renders — is contextually
escaped via the existing `escapeHtml` discipline in both body and attribute
contexts; pages render only through the `page()` helper. This pins the named
stored-XSS→admin-session-takeover threat shut.

**Caching (B3).** All `/admin` pages send `Cache-Control: no-store` — they can
render revealed PII; the JSON endpoint already sets it.

1. `GET /admin/disputes` — table of `status = 'disputed'` orders: order id,
   item title, price, buyer/seller handles, disputed since. Newest first.
   Empty state says so, plainly.
2. `GET /admin/disputes/:id` — dispute workspace for that order: status,
   amounts, payment mode, tracker link, full `order_events` history, the
   order message history (read-only, from work item 1), and the resolve form
   (outcome radio `refund|release`, note textarea 1–500 chars, CSRF token).
   The shipping address is **masked by default** (PII minimization); a
   "reveal address" button performs a logged POST (`admin_pii_reveal`
   security event, includes order id) before unmasking for that session.
   Non-`disputed` orders 404 — this UI is a dispute workspace, not an order
   browser.
3. `POST /admin/disputes/:id/resolve` — validates CSRF + input, then calls
   the **same core** the JSON endpoint uses (the handler body is extracted
   into a shared `resolveDispute(orderId, outcome, note)` in routes-internal
   code — one code path, two transports). Success redirects to the detail
   page showing the new terminal status; failure re-renders the form with
   the error.

**No new env vars.** Reuses `ADMIN_API_KEY` (login proof) and
`SESSION_SECRET` (cookie + CSRF HMAC). Boot validation stays fail-closed for
**both**: admin key unset/short, or `SESSION_SECRET` unset or shorter than
32 chars, → all `/admin` routes 404, login included (the JSON admin endpoint
is unaffected). `SESSION_SECRET` must be **explicitly set** — the admin
session must not silently run on auth.ts's ephemeral random fallback, which
would churn every session on restart. Rotation note: rotating
`ADMIN_API_KEY` does not invalidate live cookies — rotate `SESSION_SECRET`
to kill admin sessions (this also drops user website sessions).

## Data model changes

None. (Dispute state, events, and messages already exist or come from work
item 1.)

## API / MCP tool changes

None. MCP surface untouched. The existing JSON admin endpoint is unchanged;
the form action is a new HTML route.

## Migration plan

None (no schema change). Deploy is code-only.

## Test plan

- Auth: no cookie → redirect; forged/expired cookie → redirect; wrong key →
  re-render + `admin_login_denied` event + limiter; right key → cookie set,
  Secure/httpOnly/SameSite flags asserted; 8h expiry; fail-closed boot gate —
  `SESSION_SECRET` unset or <32 chars → all `/admin` pages 404 while the JSON
  endpoint keeps working.
- CSRF: resolve without token or with mismatched token → 400, no state
  change.
- Pages: disputed list content and empty state; detail 404s for non-disputed
  and non-existent ids (uniform); address masked until reveal; reveal logs
  the security event; every interpolated field asserts escaped output (B2);
  `/admin` GETs carry `Cache-Control: no-store` (B3); action POSTs consume
  the strict limiter while page GETs consume the separate GET limit (B1).
- Resolve: refund path and release path produce the same transitions/events
  as the JSON endpoint (shared-core test), note length validation, re-render
  on error.
- Regression: JSON endpoint still works with Bearer key only.

## Rollout + rollback

Code-only; ships dark (nobody knows `/admin/login` URL unless told; the
endpoint enforces auth regardless). Rollback = revert; the JSON endpoint
remains the fallback resolver throughout, so there is no operational gap.

## Open questions

1. Should the login page be linked anywhere public? Proposal: no — operators
   bookmark it. (Security input welcome.)
2. Pagination on the disputes list — defer until dispute volume justifies it
   (v1 caps the list at 50 with a note).
3. Off-platform dispute resolve: release is a no-op money-wise (parties
   settle themselves) — the form labels this explicitly so operators don't
   expect a Stripe action. Confirm wording with Security/Drafts at review.

## Implementation steps (PR-sized)

1. **PR-A (protected):** admin session middleware (login/logout routes,
   cookie, CSRF helper, security events, limiter reuse) + tests.
2. **PR-B (protected):** disputes list + detail pages (events, messages,
   masked address + reveal) + tests.
3. **PR-C (protected):** resolve form + shared `resolveDispute` core
   extraction from the JSON handler + tests.
