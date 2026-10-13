# ADR 0003: Order state machine, Stripe Connect payouts, carrier webhooks

- **Status:** Accepted (spec [THI-3](https://paperclip.ing/THI/issues/THI-3) rev 2/3, CEO-accepted 2026-10-12; board OQ verdicts 2026-10-12)
- **Date:** 2026-10-13
- **Implements:** PRs #39–#49 (order flow)

*Filename note: the spec's §9 table names this file `0001-order-state-machine.md`; `0002-mcp-oauth-onboarding.md` had already claimed the next slot when this landed, so it ships as ADR 0003. Numbering deviation only — content is the spec's ADR summary, recorded per ADR discipline.*

## Context

Thingery listings had no order path: an item could be marked `sold` via `update_listing`, but there was no buyer identity, no payment, no shipping state, and no audit trail. Agents negotiating in chat had no way to close a deal on-platform, and nothing could protect a buyer who pays a stranger. The roadmap needed an order flow that AI agents can drive end-to-end via MCP tools, with money movement that survives webhook duplicates, outages, and races.

Constraints that shaped the design:

- **Free for buyers and sellers** — the platform absorbs payment costs; no take rate, no seller/buyer fees (board OQ1).
- **Agent-native** — every step is an MCP tool; the website gets only a minimal payment-return page.
- **Self-hostable** — payments and carrier integration must be optional per deployment, degrading to an `off_platform` order mode rather than breaking.
- **Second-hand items are unique** — quantity is always 1; one listing → at most one live order.
- **EU flagship** — card payments via Stripe Checkout, carrier coverage via one aggregator (EasyPost), EUR-default currencies.
- **Trust boundaries** — provider webhooks (Stripe, EasyPost) and an admin dispute route are untrusted or semi-trusted inputs on a money path; every handler must be idempotent, replay-safe, and fail closed on missing configuration ([THI-8](https://paperclip.ing/THI/issues/THI-8) findings F1–F15).

## Decision

1. **An explicit 11-state order machine** (`pending → sold → label_issued → in_transit → delivered → payout_pending → paid_out`, with `disputed` and terminal `cancelled`/`refunded`), implemented as a declarative transition table. Every transition is a single conditional `UPDATE … WHERE status = $expected` (compare-and-swap); illegal transitions throw instead of producing undefined behavior. Each transition writes an append-only `order_events` row (actor type, trigger, timestamps) — the audit trail is the log, not the columns.
2. **Separate charges & transfers** with Stripe Express connected accounts: the platform charges the buyer (Stripe Checkout Session URL returned by `create_order`), holds the funds, and transfers to the seller's connected account only after delivery + dispute window. Buyer protection by construction; the platform is merchant of record (OQ2 — **test mode until legal/ToS sign-off**).
3. **Seller-recorded tracking in v1**: the seller calls `record_tracking` (order → `label_issued`); when the deployment configures EasyPost, a carrier tracker is registered and signed carrier webhooks drive `in_transit`/`delivered` automatically. Carrier events resolve `tracker_id`-first, `(carrier, tracking_code)` only when exactly one live order matches; ambiguous input is skipped with an operator alert, never guessed.
4. **Idempotent, reconcile-don't-recreate money mutations**: every Stripe call carries a deterministic idempotency key (`refund:{order_id}`, `payout:{order_id}`, `reversal:{order_id}`); recovery paths retrieve existing objects instead of creating seconds. Webhook events are deduplicated on provider event id (Stripe) / body hash (EasyPost trackers carry no event id) and stored before processing; failed processing marks `process_error` and a sweep reprocesses with backoff.
5. **Fail-closed boot configuration** (THI-8 F1): empty secrets mean "feature disabled" (Stripe absent → `off_platform` orders only; webhook secrets absent → endpoint mounts as a 503 stub; admin key < 32 chars → admin route 404s), never "feature enabled with an empty secret."
6. **Deadlines are swept, not trusted**: payment expiry, stale-sale, stuck-transit, dispute window, pickup auto-confirm, and stuck-money states are enforced by a periodic sweep over DB timestamps — provider silence can strand an order, never money.
7. **`update_listing` status guard** is the only behavior change to existing tools: a listing with a live order cannot be manually flipped out of the order's shadow (`sold`/`reserved` follow the order machine).

## Alternatives rejected

- **Destination charges** (Stripe transfers at charge time) — no hold at delivery, so no buyer protection; rejected outright.
- **Platform-issued shipping labels in v1** — carrier billing/ops weight before product-market fit; seller-recorded tracking covers v1.
- **Offers/negotiation in v1** — chat already supports informal negotiation; the order snapshots the agreed price. YAGNI until asked for.
- **Direct carrier APIs** — N integrations, each with its own auth/webhook shape; one aggregator covers the EU carrier set the flagship actually sees.
- **Item-status-only "sold"** (status quo) — no buyer, payment, or audit trail; the reason this ADR exists.
- **`off_platform` order mode in v1** — initially deferred as "double the machine"; **reconsidered at implementation**: payments being optional per deployment forced a mode flag anyway, and off-platform orders fell out of the same transition table for near-zero extra states (board OQ4 approved building it).
- **Renaming `sellers` → `accounts`** — cosmetic destructive churn on a protected schema; rejected.
- **Empty-secret-tolerant config** — fail-open; rejected per THI-8 F1.

## Consequences

- The platform holds buyer funds between charge and delivery → merchant-of-record duties (OQ2: test mode until sign-off) and a funded Stripe reserve for full-price transfers, including the refund-during-payout path (OQ1).
- Carrier automation is optional per deployment; without EasyPost the flow degrades to buyer/seller manual `confirm_receipt`.
- Disputes in v1 are resolved by a human operator through a hardened admin route (OQ7) — audited via `order_events`, no automation.
- The money path carries webhook-duplicate, replay, and race hazards permanently: every future change to `orders`, `order_events`, `webhook_events`, the transition table, or the Stripe/EasyPost handlers re-enters the spec-first + protected-path review regime.
- Agents get a uniform surface: 9 new MCP tools (`get_payout_setup`, `create_order`, `get_order`, `cancel_order`, `record_tracking`, `confirm_payment`, `confirm_receipt`, `open_dispute`, `release_funds`) with stable semantics documented in `llms.txt` and `.well-known/agents.json`.
