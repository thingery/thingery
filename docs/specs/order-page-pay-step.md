# Spec: order page pay step (closes the email→order→pay journey)

- **Status:** Implemented in this PR. **No protected path** touched (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`, `src/routes.ts` untouched; no schema, no payment-service rails change). Merges under the normal review gate (ADR 0007: CI green + `thingery-review-bot` approval), with the capability/pay-exposure rationale below called out for the review.
- **Date:** 2026-11-26
- **Origin:** follow-up from the email redesign (PRs #397/#398). The approved order emails link "Open the order" → the order page, but the page had no pay action — payment existed only behind the MCP tools' `payment_url`. Product decision (recorded on the follow-up thread): build the pay step. The email rule from the redesign stands unchanged: **emails keep pointing at the order page; Stripe URLs never enter email payloads.**
- **Touches:** `src/order-flow.ts` (additive read-only helper), `src/web-pages.ts` (page body), `tests/order-return-page.test.ts`, `.env.example` (ride-along docs commit), this doc. No email-template change, no MCP tool change, no schema change.

## Problem

`GET /order/:id` (`orderReturnPage`, src/web-pages.ts) is a status-only F15 capability page: anyone holding the order UUID learns the order's *status* and nothing else. Payment today flows only via the Stripe Checkout `payment_url` returned by the `create_order`/`get_order` MCP tools. A buyer who follows an order email's "Open the order" link on a pending order sees "Awaiting payment" with no way to pay. The journey is broken mid-link.

## Context

- The page is already the Stripe Checkout `success_url` (`createCheckoutSession`, src/stripe.ts) — after paying, the buyer lands right back on it. The page is the natural pay landing; only the action is missing.
- `getOrderView` (src/order-flow.ts) already defines the payable-state gate and the read-only URL retrieval: `status === "pending" && payment_mode === "stripe" && checkout_session_id` → `stripe.checkout.sessions.retrieve(id).url`. The web page can reuse **exactly** that path — zero new rails.
- Stripe Checkout sessions are single-completion: the session URL pays the order once; Stripe itself rejects/gates a second completion. The page never mints, transitions, refunds, or transfers anything.
- F15 data discipline: the page renders status only — never title, price, party names, addresses. The pay button adds **no order data**; it adds one outbound link (the checkout session URL) for the same audience that can already read the status.
- Email button voice (approved layout, src/notify/templates.ts): imperative, article-led — "Open the order", "View the item", "Verify your email"; deadline copy "Your order awaits payment." / "Complete payment by … or the order is cancelled automatically."

## Proposed design

1. **`src/order-flow.ts` — additive, read-only helper** `getPayableCheckoutUrl(sessionId: string | null): Promise<string | null>`:
   - `null`/empty session id → `null` (no Stripe call). Stripe kill switch (`getStripe() === null`) → `null`. Retrieve error or missing `url` (expired session) → `null`. Otherwise the session URL.
   - No viewer check: the caller (the capability page) has already resolved the order by UUID — the UUID is the capability, the same trust level that grants status visibility. The helper never mutates; it mirrors the retrieval block inside `getOrderView` (duplicated, ~8 lines, deliberately — `getOrderView`'s copy sits on the MCP hot path and is left untouched).
2. **`src/web-pages.ts` — status-gated pay step on `orderReturnPage`:**
   - The existing single orders query widens from `status` to `status, payment_mode, checkout_session_id` (same row, same no-oracle treatment: unknown/malformed id → identical "Order not found" body, 200, as today).
   - When `status === "pending"` **and** `payment_mode === "stripe"`: `payUrl = await getPayableCheckoutUrl(row.checkout_session_id)`.
   - Render, only when `payUrl` exists: primary button **"Pay for this order"** → `payUrl` (plain `<a href>`, `escapeHtml`d — CSP `form-action 'self'` is irrelevant to link navigation, and `Referrer-Policy: same-origin` (already set) means the cross-origin navigation to Stripe carries no Referer, so the UUID cannot leak that way), plus one line "You'll come back here after paying." (true: `success_url` is this page).
   - Pending **without** a payable URL (Stripe unconfigured, session expired, or self-hosted without rails): exactly today's status render — plus, for pending, the existing hint already tells the buyer to ask their assistant (which still yields `payment_url` via `get_order`). No new copy required; no error state invented.
   - `?canceled=1` (Stripe's `cancel_url` returns here with this flag): when the order is still pending, add one line "Payment was canceled — you can still complete it." above the button when a button exists, or after the status when it does not. Read from the query string, rendered as static copy only (no reflected values).
   - **Explicit render states (state machine of the page — all other combinations are today's status-only render):**
     | Order state (from the row) | Stripe session | Page |
     |---|---|---|
     | unknown / malformed id | — | "Order not found" body (identical template, 200) — unchanged |
     | pending, stripe, session id | retrieve → url | status + **Pay for this order** button (+ canceled line if `?canceled=1`) |
     | pending, stripe, session id | url null / error / kill switch | status + hint (ask your assistant) |
     | pending, non-stripe / no session id | — | status + hint |
     | any non-pending status | — | status + hint — unchanged (button never shows; payment is not due) |
   - F15 header comment in `web-pages.ts` is updated to record the pay-step carve-out ("richer order pages are a follow-up" → this is the first, minimal slice: one action, no new data).
3. **No changes to:** email templates (already link the order page), MCP tools (`payment_url` contract untouched — API evolution: extend, don't mutate), `src/stripe.ts` rails, `src/routes.ts`/`src/index.ts` routing (page already mounted at `/order/:id`), auth (page remains session-less by design), schema.

### Security rationale (for the ADR-0007 review)

- **Audience delta ≈ zero:** today the capability UUID grants status visibility; the same UUID-holder can already complete payment via the `payment_url` that `create_order`/`get_order` hand back and that rides in the buyer's own email thread. The button re-exposes the *same* Stripe session URL to the *same* audience. No new capability is minted.
- **No-oracle, no-store, same-origin referrer, uniform unknown-id body:** all preserved (tests assert each).
- **No rails:** read-only session retrieval; single-completion is enforced by Stripe, not by us; no idempotency surface added; a paid/expired/cancelled order simply stops rendering the button (status gate).
- **No reflected input:** `?canceled=1` maps to fixed copy; the only interpolated URL is the server-fetched Stripe session URL, escaped.

## Data model changes

None.

## API / MCP tool changes

None. `payment_url` semantics, tool signatures, and email payloads unchanged.

## Migration plan

None (no schema change).

## Test plan (`tests/order-return-page.test.ts`, DB-backed, Stripe faked via `setStripeForTests`)

1. Existing suite passes unchanged (status-only render, no-store, referrer policy, unknown/malformed uniformity, payout-setup route).
2. New: pending stripe order **without** `checkout_session_id` (today's seed) → 200, "Awaiting payment", **no** pay button, no `stripe.com` link.
3. New: pending stripe order **with** `checkout_session_id`, fake Stripe returns `{ url }` → body contains "Pay for this order" and the escaped session URL; still never title/price; headers unchanged.
4. New: same order with fake Stripe returning `url: null` and with retrieve rejecting → no button, hint path (two asserts, one test each or combined).
5. New: fake Stripe `null` (kill switch) → no button.
6. New: non-pending status (`sold`) with session id present → no button (status-gated).
7. New: `?canceled=1` on a pending payable order → canceled line + button; on a non-payable pending order → canceled line, no button, 200.
8. Unit-level: `getPayableCheckoutUrl(null)` → `null` without any Stripe call (spy count 0).
9. Full `npm run typecheck && npm test` green in CI (`verify`).

## Rollout + rollback

- Rollout: ordinary merge via the ADR-0007 gate; deployed with the next server rebuild (documented runbook path). No flag: the button is inherently status-gated and only renders when a live checkout session exists, so enablement risk is nil — a deployment without Stripe configured renders today's page.
- Rollback: revert the single commit; page returns to status-only. No data, no schema, no emails to unwind.

## Ride-along (same PR, separate commit): `.env.example` NOTIFY_FROM_ADDRESS alignment

- `.env.example` currently shows `NOTIFY_FROM_ADDRESS=notifications@thingery.dev` and comments "Sender falls back to notifications@" — both contradict the code default (`src/config.ts`: `NOTIFY_FROM_ADDRESS ?? "noreply@thingery.dev"`; digests/`NOTIFY_DIGEST_FROM_ADDRESS` default `notifications@thingery.dev`). Production verified (PR #397): transactional sends from `noreply@`, digests from `notifications@`.
- Fix (docs-only, no code default changes): example value → `noreply@thingery.dev`; comment states the transactional default and the digest split; `NOTIFY_DIGEST_FROM_ADDRESS=` added with a comment so the split is visible in the example file.

## Out of scope (tracked on the follow-up thread)

- **Live-client render check of the five redesigned emails** (Gmail web+mobile, Apple Mail, Outlook): requires the live notification provider that the separate enablement effort is still provisioning. Sequenced strictly after that enablement; tracked on the follow-up thread so it cannot be forgotten, without holding this PR hostage.
- Richer order pages (title/price/parties, session-scoped): explicitly NOT here — F15 data discipline stays.

## Open questions

1. Button label "Pay for this order" vs "Pay now" — chosen for the article-led approved voice ("Open the order" → "Pay for this order"). Copy bikeshed; reviewer may override in the PR.
2. Whether the canceled line should also appear for non-stripe pending orders — rendered only from the query flag, harmless; defaulted to yes for copy symmetry.

## PR breakdown (each PR-sized, one purpose)

- **PR (this spec's implementation):** `feat(web): order page pay step — email journey closes at the order page` — helper + page + tests + this spec (~150 lines).
  - Ride-along commit: `docs(env): align NOTIFY_FROM_ADDRESS example with the transactional default` (~6 lines).
