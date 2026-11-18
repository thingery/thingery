# Spec: buyer-paid shipping on card orders

- **Status:** Proposed. This document is the required written spec for the protected paths it
  touches (`db/schema.sql`, `src/tools.ts`, `src/routes.ts`, and the money/label modules).
  Implementation starts only after spec review with recorded sign-off.
- **Date:** 2026-11-18
- **Author:** Architect
- **Decision:** product decision, 2026-11-18 — on card (Stripe) orders, the buyer pays for the
  shipping label, as on Vinted. Today `buy_shipping_label` charges the deployment's EasyPost
  account and nothing charges that cost back to anyone: every label is operator-borne.
- **Amends:** the seller-payout model of `docs/specs/seller-borne-stripe-fees.md` (fee
  allocation gains a proportional rule, §4) and the label-purchase behavior in
  `src/fulfillment.ts` (funding source, §5). No order state is added or removed.

## Problem

A shipped card order today charges the buyer `price + shipping_price_cents` (a flat,
seller-entered amount), pays the seller that whole total, and then — if the seller uses
`buy_shipping_label` — the deployment's EasyPost account pays the real label cost. Three
consequences:

1. The flat amount and the real label cost are unrelated; whoever set the lower of the two
   subsidizes the other, and the operator subsidizes every label bought without a matching
   flat charge.
2. The buyer never sees the actual shipping price before paying unless they ask and do math.
3. The platform-borne spend is bounded only by the label guards (per-label cap, daily budget,
   per-seller quota), not by user money.

The decision: on shippable Stripe orders, quote the real cheapest EUR label rate at order
time, charge it to the buyer as its own line, and buy the label against that paid quote. The
label amount is never part of the seller's payout.

## Context (repo @ f520758)

- Orders are created through one funnel, the `create_order` MCP tool (`src/tools.ts`), used by
  chat agents and by the web buy form through a tool client. `createOrder`
  (`src/order-flow.ts`) reserves the item, snapshots price + `shipping_price_cents`, stores the
  buyer address in `orders.shipping_address`, and for Stripe mode creates a Checkout session
  (`createCheckoutSession`, `src/stripe.ts`) with line items `[item price, "Shipping" (flat if
  > 0)]`, card-only, idempotency key `checkout:{order_id}`, expiring at the 24h payment
  deadline. Payment confirmation (`checkout.session.completed` / `payment_intent.succeeded`,
  `src/webhooks-stripe.ts`) flips `pending → sold` after checking the session amount equals
  `price + shipping_price_cents` (defense F5).
- Payout: `sellerNetTransferCents` (`src/stripe.ts`) transfers `gross − Stripe fee` where gross
  is the whole order amount (`orderAmountCents` = price + flat), under `payout:{order_id}`
  idempotency; fail-closed on any unknown (missing balance transaction, currency/amount
  mismatch, net < 1¢). Called from `releaseFunds`, sweep rule 4, and the admin release route.
- Refunds: every refund site calls `createRefundForOrder` (full amount, `refund:{order_id}`
  idempotency): cancel of a sold/label_issued Stripe order (`order-flow.ts`), sweep rules
  2/3/8 (stale sale, stuck transit, never-shipped; `orders-sweep.ts` `refundFirst`), carrier
  failure (`webhooks-carrier.ts`), late payment on a cancelled order (`webhooks-stripe.ts`
  F2), and the admin refund route (`routes.ts`).
- Labels: `buy_shipping_label` (`src/tools.ts` → `buyShippingLabel`, `src/fulfillment.ts`)
  quotes EasyPost rates from the buyer's stored address + a seller-supplied from-address +
  weight/dimensions (listing estimate or per-call override), selects the cheapest EUR rate
  (non-EUR rates are never selectable), enforces three spend guards **before** the single
  `/buy` call — per-label cap (`LABEL_MAX_COST_CENTS`, default €30), deployment daily budget
  (`LABEL_DAILY_BUDGET_CENTS`, default €200, 0 = kill switch; aggregated from persisted
  `orders.label_purchase` snapshots), 10 purchases per seller per day (`seller_label_quota`) —
  then buys and persists the `label_purchase` snapshot in the same transaction as the
  `sold → label_issued` transition. Replaying the call returns the stored label. Degraded mode
  (`EASYPOST_API_KEY` unset): the call fails `easypost_not_configured`; sellers ship themselves
  and use `record_tracking`.
- Listings carry `weight_grams INTEGER`, `dimensions_mm TEXT` ("LxWxH"), `shipping_tier`
  (`locker | parcel | bulky | local`; `local` = pickup-only), and the flat
  `shipping_price_cents`. Orders snapshot price, flat shipping, and the buyer address.
- Saved addresses (`docs/specs/saved-addresses.md`, `account_addresses`): per-account store,
  at most 10, one `is_default`, owner-scoped reads; `create_order` accepts `address_id` (a
  saved address) or a typed `shipping_address`, exactly one of the two.
- Off-platform orders: no Stripe charge; the buyer and seller agree payment and shipping in
  messages, the seller confirms payment (`confirm_payment`), records tracking
  (`record_tracking`), and the buyer may gate address sharing via `share_shipping_address`.

## Goals

1. On shippable Stripe orders (where shipping can be quoted), the buyer pays the actual
   cheapest EUR label rate, shown as its own line at checkout.
2. The paid quote is what the label is bought against; the deployment never spends more on a
   buyer-funded label than the buyer paid for it.
3. The label amount is excluded from the seller's payout and from dispute/escrow math by
   construction.
4. Degraded mode (no EasyPost) and off-platform orders behave exactly as today — fail-safe,
   order creation never fails because of quoting.
5. The existing label spend guards (per-label cap, daily budget, per-seller quota) are kept
   unchanged and apply to every purchase, funded or not.
6. No MCP tool signature breaks; agents and existing installs keep working (additive fields
   only).

Non-goals: carrier choice re-evaluation at quote/label time beyond what §5 defines; multi-
parcel or bulky-tier rating; the contract phase (retiring operator-funded labels or the flat
amount on EasyPost deployments) — recorded as an open question; any web UI change.

## Proposed design

### §1 Funding modes — decided once, at order creation

Every order is one of two shipping-funding modes, fixed when `create_order` runs:

| | **label-quote mode** (new) | **flat mode** (today, unchanged) |
|---|---|---|
| When | Stripe payment mode AND `fulfillment = shipping` AND EasyPost configured AND listing has `weight_grams > 0` AND the seller has a default saved address AND a live quote succeeds AND the cheapest EUR rate ≤ `LABEL_MAX_COST_CENTS` AND `orders.currency = EUR` | everything else, including every failure/absence above and every degraded-mode deployment |
| Buyer pays | `price + quoted label amount` | `price + shipping_price_cents` (flat snapshot) |
| Seller payout base | `price` | `price + shipping_price_cents` |
| Label | bought against the paid quote (§5) | any label purchase is operator-funded exactly as today |

Mode resolution is a pure fall-through: any condition that cannot be met drops the order to
flat mode and the order is still created. Quoting can never be the reason an order fails. An
`order_events` row records the outcome (`label_quote_created` with carrier + amount, or
`label_quote_fallback` with the reason) — amounts and reasons only, never address data.

The origin for the quote is the **seller's default saved address** (`account_addresses` row
with `is_default`). If the seller has none, or it fails the same completeness check labels
use, the order falls back to flat mode. (The saved-addresses store anticipated this reuse;
no new address storage is introduced.)

### §2 Quote lifecycle

**Creation.** Inside `createOrder`, after the reservation succeeds and before the Checkout
session is created (same transaction, same external-call-in-transaction precedent as the
Stripe call): build the shipment from the buyer's address snapshot, the seller's default
address, and the listing's `weight_grams` / `dimensions_mm`, quote via EasyPost, select the
cheapest EUR rate with the existing selection helper. Failure of any step (EasyPost error,
timeout, no EUR rate, rate above the cap) = flat-mode fallback, never an order error.

**Storage.** One JSONB snapshot on the order — the same pattern as `label_purchase`:

```
orders.label_quote = {
  shipment_id, rate_id, carrier, service,
  amount_cents, currency,             // integer cents, EUR
  weight_grams, dimensions_mm,        // the parcel the quote was computed for
  origin: { name, line1, line2?, city, postal_code, country },  // seller default address at quote time
  quoted_at                           // ISO UTC
}
```

The snapshot is the single source of truth. It is never exposed verbatim to buyers or sellers
(the public shape is the `shipping` block of §9); the origin is the seller's PII and is used
only to reproduce the quote at label time, never logged or evented.

**Binding.** The Checkout session is built from the row snapshot (§3), so the buyer's charge
amount equals the quote amount by construction. Once paid, the quote is bound to the order for
its lifetime: label purchase, refunds, and payout math all read the same stored
`amount_cents`.

**Expiry.** There is no independent quote-expiry state machine. Before payment, the quote
lives exactly as long as the Checkout session: the session expires at the 24h payment
deadline and the existing pending-order sweep cancels the order — the quote dies with it, no
label was ever bought, nothing is owed. After payment, what governs is the label-time rule
(§5): the platform attempts the stored rate first and only buys a re-quote that does not
exceed the paid amount. Estimates surfaced by `quote_shipping` (§9) carry a display freshness
note (default 15 minutes, `SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES`) because carrier rates drift;
that note is advisory for display, not a binding expiry.

**Tamper-proofing.** No client ever supplies a shipping amount, a quote id, or a rate id:

- `create_order`'s schema is unchanged (no money fields added);
- the charge line and metadata are derived server-side from the row;
- `buy_shipping_label` reads the snapshot from the order row, not from its arguments — in
  label-quote mode the per-call `weight_grams`, `dimensions_mm`, and `from_address` are
  **locked to the snapshot** (accepted and ignored, with an explanatory note in the response)
  so the parcel and origin cannot be swapped for a different rate after payment.

**Idempotency.** Order creation is single-shot per order (the item reservation CAS and
`one_live_order_per_item` already prevent duplicates), so one quote per order; the quote and
the order commit or roll back together.

### §3 Charge construction — money handling

In label-quote mode `createCheckoutSession` builds:

- line 1: the item, as today;
- line 2: `"Shipping"` with `unit_amount = label_quote.amount_cents` (the flat amount is
  **not** added — quote mode supersedes it for this order; the listing's flat value keeps its
  meaning for flat-mode orders and off-platform agreements);
- Checkout Session **and** PaymentIntent metadata gain `label_quote_amount_cents` (decimal
  string) so the split is reconstructible from Stripe's side during reconciliation.

The charge-total invariant (webhook F5 check in `src/webhooks-stripe.ts` and the payout
balance-transaction check) becomes one helper used everywhere:

```
chargeTotalCents(order)  = price_cents
                         + shipping_price_cents        // flat charged (0 in quote mode)
                         + (label_quote ? label_quote.amount_cents : 0)
payoutBaseCents(order)   = price_cents + shipping_price_cents   // label amount never here
```

In quote mode `orders.shipping_price_cents` is stored as `0` (the flat amount is not charged),
so both helpers read straight off the row with no hidden state. `checkout.session.completed`
acceptance compares `amount_total` against `chargeTotalCents`. Money is integer cents
end-to-end; EasyPost decimal rate strings are converted to cents by the existing rounding
helper; quote mode requires `currency = EUR` on both the order and the rate (non-EUR rates
were already unselectable — quote mode simply inherits that).

### §4 Payout — exclusion and fee allocation

`label_quote.amount_cents` is excluded from `payoutBaseCents` by construction (§3), so
transfers, the `payout:{order_id}` idempotency key, and the escrow flow are unchanged in
shape. Two rules extend `seller-borne-stripe-fees.md`:

1. **Charge match.** The balance transaction must equal `chargeTotalCents` (the buyer's
   charge) — the existing fail-closed mismatch check, re-based on the new helper.
2. **Fee allocation.** The seller bears the fee on their own money only. The Stripe fee on
   the buyer's charge covers the item + flat lines and the label line together, so the
   seller's share is proportional, rounded up (the operator never absorbs rounding):

```
sellerFeeShareCents = ceil(fee * payoutBaseCents / chargeTotalCents)
netTransferCents    = min(payoutBaseCents − sellerFeeShareCents, payoutBaseCents)
```

Same fail-closed behavior as today on any unknown (missing intent/charge/balance transaction,
currency mismatch, net < 1¢ → order stays `payout_pending`, sweep retries). The result stays
deterministic per order, keeping the idempotency key sound.

Escrow/dispute note: the label line settles into the platform balance like the rest of the
charge and is spent on the label at purchase (§5). It is not escrowed for the seller and is
never transferable to them.

### §5 Label purchase against the paid quote

`buy_shipping_label` keeps its contract and all three spend guards. It branches on funding
mode, read from the order row:

**Label-quote mode (`label_quote` present):**

1. Preconditions unchanged (seller party, `sold`, shippable, address visible).
2. Try `buyEasyPostLabel(quote.shipment_id, quote.rate_id)` — the exact paid rate.
3. If EasyPost rejects it (rate or shipment no longer purchasable), re-create the shipment
   **from the snapshot** (same origin, same destination address, same weight/dimensions) and
   select the cheapest EUR rate; a `carrier_preference` is honored only when its cheapest
   match does not exceed the paid amount, otherwise it is ignored in favor of the cheapest
   rate. An `order_events` row (`label_requoted`) records the replacement (ids + amounts
   only).
4. **Rate-up rule:** the purchase proceeds only if the rate to buy costs ≤
   `label_quote.amount_cents`. The deployment never supplements a buyer-funded label. If the
   live cheapest rate exceeds the paid amount, fail closed with a new error code
   `label_rate_exceeded`, no spend, and the message names the remedies: retry later (rates
   drift), cancel the order (full refund — no label was bought, §6), or ship with the
   seller's own label via `record_tracking` (the buyer's label line is then refunded, §6). If
   the re-quote returns no EUR rate at all, the existing `label_no_rate` error fires with the
   same remedies.
5. Spend guards, unchanged and before any `/buy`: per-label cap on the actual rate (a
   re-quoted cheaper rate can only pass more easily; the cap still bounds every purchase),
   daily budget aggregated over **all** `label_purchase` snapshots regardless of funding
   source, per-seller quota. Refusals carry the same errors and events as today.
6. On success: same single `/buy` call, same `sold → label_issued` transaction, and the
   `label_purchase` snapshot gains `funded_by: "buyer_quote"` (absent = operator-funded,
   so existing rows stay valid). If the bought rate is cheaper than the paid quote, the
   difference stays with the deployment in v1 (no partial refunds — open question 1). The
   cancel-race orphan path (label bought, transition CAS lost) is unchanged: operator alert
   event, order untouched; in quote mode the buyer's refund already includes the label line
   because no `label_purchase` was persisted (§6), so the orphaned label cost is the
   deployment's — same bounded exposure class as today.

**Flat mode and pre-existing orders (`label_quote` absent):** byte-for-byte today's path —
live quote, cheapest EUR rate (or carrier preference), operator-funded, all guards. Legacy
in-flight orders therefore keep their exact current behavior across the deploy.

### §6 Refunds and disputes — who bears the label line

All refund sites funnel through `createRefundForOrder`, so the amount is one helper:

```
refundCents(order, policy) =
  chargeTotalCents(order)
  − (label_purchase exists AND policy excludes the label line ? label_quote.amount_cents : 0)
```

In flat mode there is no label line and every refund is the full amount, exactly as today.
In label-quote mode the line is excluded **only when a platform label was actually bought**
(`label_purchase` present — buying always records tracking, so "label bought" is knowable
from the row). Path by path:

| Path | Label line | Who bears it |
|---|---|---|
| Cancel while `pending` (unpaid) | n/a | nobody — nothing charged |
| Cancel / stale-sale / never-shipped refund with **no label bought** | refunded | nobody — the deployment never spent |
| Cancel / stuck-transit / dispute refund with **label bought** | not refunded | buyer — the label was procured with their money and is theirs (unused-label recovery is an operator concern, open question 2) |
| Carrier failure refund (parcel lost/returned in transit) | refunded | deployment — the shipping service it procured failed; carrier claim is the deployment's remedy |
| Chargeback (#22) | pulled by Stripe | deployment (merchant of record — unchanged exposure) |
| Admin refund after transfer | per policy, default excludes | deployment reverses the transfer (payout base only) and refunds `refundCents`; the label line is retained against the EasyPost spend |
| Seller ships with own label on a quote-mode order (`record_tracking` with no `label_purchase`) | refunded | nobody — see below |

**Unused-quote refund (new, small):** when `record_tracking` records a seller-own label on a
label-quote order (`label_quote` present, `label_purchase` absent), the buyer's label line is
refunded immediately as a partial refund under a new idempotency key
`labelrefund:{order_id}` (retrieve-before-create, same replay discipline as `refund:`),
logged as a `label_line_refunded` event. This is the fail-safe for "EasyPost broke (or was
switched off) after payment" and the third remedy of `label_rate_exceeded`: the buyer never
pays a label line that bought no label. Full-refund sites never need this — when no label was
bought their amount already includes the line.

### §7 Off-platform (direct payment) orders: unchanged

This spec adds nothing to off-platform orders: no quote, no shipping charge line — Thingery
sells no label there. The seller and buyer agree shipping in messages; the seller records
tracking with `record_tracking`; address sharing keeps its consent gate. The existing
operator-funded `buy_shipping_label` capability on off-platform orders remains exactly as it
is today, under today's guards; whether it survives the contract phase is open question 3.

### §8 State machine, errors, events

No new order statuses or transitions — every change rides existing states and triggers
(`stripe_payment`, `label_purchased`, `record_tracking`, `cancel_order`, `refund_confirmed`,
webhook/sweep triggers). Illegal transitions keep being rejected by the transition core. New
surface:

- Error codes: `label_rate_exceeded` (§5.4). Everything else reuses existing codes
  (`easypost_not_configured`, `label_no_rate`, `label_cost_exceeds_cap`,
  `label_budget_exceeded`, `rate_limited`).
- `order_events` types: `label_quote_created`, `label_quote_fallback`, `label_requoted`,
  `label_line_refunded`. Payloads carry ids, amounts, and reasons only — never address data
  (PII minimization, `docs/security.md`).

### §9 API / MCP tool changes (additive)

- **`create_order`** — signature unchanged. Response gains a `shipping` block:
  `{ mode: "label_quote" | "flat", amount_cents, currency, carrier?, service? }`, and
  `total_price_cents` becomes `chargeTotalCents` (for flat orders the value is unchanged;
  quote mode is new, so no existing agent sees a changed number). `next_steps` for quote-mode
  orders tells the buyer the shipping line is the label they paid for.
- **`quote_shipping` (new, read-only)** — the pre-checkout estimate surface, and the contract
  the web checkout-total work builds against. Params: `item_id` + exactly one of `address_id`
  | `shipping_address` (same shapes and validation as `create_order`). Returns
  `{ estimate: { amount_cents, currency, carrier, service } , valid_for_minutes, binding: false,
  quotable: true }` or `{ quotable: false, reason }` (no weight on the listing, seller has no
  default address, EasyPost unset, no EUR rate under the cap). Rate-limited per account
  (token bucket, 20/hour default) — it is an unauthenticated-free oracle for carrier quotes
  otherwise. No PII in logs.
- **`buy_shipping_label`** — signature unchanged; description updated (quote-mode orders buy
  against the paid amount; overrides locked to the snapshot with a note in the response).
- **`get_order` / `my_orders`** — the `shipping` block (mode + amount) is added to the public
  allowlist; `label_quote` itself never leaves the database.

Blast radius: registry-listed installs and npm users get new behavior only with
`EASYPOST_API_KEY` set; degraded deployments are byte-compatible. Tool outputs gain fields;
none change meaning for existing orders.

## Data model changes

One additive column, mirroring the `label_purchase` precedent:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_quote JSONB;
-- {shipment_id, rate_id, carrier, service, amount_cents, currency,
--  weight_grams, dimensions_mm, origin{...}, quoted_at}
```

No CHECK constraint (same as `label_purchase` — shape is enforced in code where it is read).
No new tables: the quote origin reuses `account_addresses` (`is_default` row), and the budget
aggregation keeps reading `label_purchase`. New env: `SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES`
(default 15, display-only). `db/schema.sql` is a protected path — this section is its spec.

## Migration plan (expand-contract)

Additive only: one `ALTER TABLE`, deployed with the code. Orders created before the deploy
have `label_quote = NULL` and keep flat-mode semantics forever (§5). Quote-mode orders exist
only after both code and column are live; quoting at order creation is +1 EasyPost call per
shippable Stripe order creation (rate quotes are free; volume is bounded by the
pending-orders cap). No backfill. The contract step — retiring operator-funded labels and/or
the flat amount on EasyPost deployments — is deliberately not scheduled here (open question
3); when it happens it ships as its own spec'd change.

## Test plan

New `tests/shipping-quote.test.ts` + extensions to `order-flow` / `stripe` / `fulfillment` /
`webhooks` suites (same fake-Stripe/EasyPost seams as today):

1. Mode resolution: every fallback condition in §1 (no weight, no seller default address,
   EasyPost error/timeout, no EUR rate, rate > cap, non-EUR order) → order still created,
   flat charged, `label_quote_fallback` event with reason; happy path → quote stored,
   `label_quote_created` event, charge = price + quote.
2. Charge: quote-mode session has the label line and `label_quote_amount_cents` metadata;
   flat mode unchanged; F5 check accepts `chargeTotalCents` on both modes.
3. Payout: proportional fee share (ceil, seller never subsidizes the label line's fee;
   deployment never absorbs rounding); net clamped at payout base; charge mismatch
   (`bt.amount ≠ chargeTotalCents`) fails closed; label amount never in the transfer.
4. Refunds: no-label-bought → full incl. line; label-bought cancel/stuck-transit → line
   excluded; carrier failure → full; `refund:{order_id}` replays keep the same amount;
   `labelrefund:{order_id}` fires exactly once on `record_tracking` own-label path and never
   on orders without a quote.
5. Label purchase: exact-rate buy; re-quote on rejection; cheaper re-quote buys and records
   `label_requoted`; more-expensive re-quote → `label_rate_exceeded`, no EasyPost `/buy`
   call; all three guards enforced on the actual rate in both funding modes; overrides
   ignored in quote mode; replay returns stored label; `funded_by` recorded.
6. Off-platform: no quote, no behavior change (regression fixtures).

CI green = acceptance.

## Rollout and rollback

Rollout: single deploy (code + additive column). No feature flag: a deployment without
`EASYPOST_API_KEY` is inert by construction, and EasyPost deployments opt in by existing
configuration. Watch after deploy: quote fallback rate (`label_quote_fallback` reasons),
`label_rate_exceeded` frequency, `labelrefund` volume.

Rollback: revert the deploy; the column stays (additive). Orders created in the window with
`label_quote IS NOT NULL AND status IN ('pending','sold')` are the exposed set — pending ones
die with their sessions; sold-but-unlabeled ones would, under reverted code, buy an
operator-funded label while the buyer already paid the line: the runbook is to refund those
orders in full (or let the seller ship own-label via the unchanged `record_tracking`) —
enumerable by the query above, bounded by window size. Documented in the deploy runbook with
the rollout PR.

## Open questions

1. **Quote overage.** Buyer pays €7.20, label re-quotes at €6.90 — v1 keeps the difference
   (no partial refunds). Alternative: fold the overage into the completion refund. Revisit
   with real volume.
2. **Unused-label recovery pass-back.** When a bought label is never used (cancelled order),
   EasyPost label refunds recover the cost to the deployment's account; returning it to the
   buyer is not automated in v1. Needs a carrier-refund reconciliation sweep first.
3. **Contract phase.** When (and whether) to retire operator-funded labels and the flat
   `shipping_price_cents` on EasyPost deployments. Separate spec, informed by §-rollout
   metrics.
4. **Estimate HTTP route.** `quote_shipping` is MCP-surface only in v1; the web reaches it
   through the same tool client it uses for `create_order`. If the web needs a session-cookie
   HTTP endpoint instead, it is an additive follow-up with the same contract.
5. **Bulky tier.** Bulky-tier items will usually exceed the per-label cap and fall back to
   flat mode. Acceptable now; revisit if listings data shows otherwise.

## Implementation breakdown (PR-sized, each references sections)

1. **Schema + quoting core** — `label_quote` column, `SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES`,
   `src/shipping-quotes.ts` (mode resolution, quote creation, selection reuse) + unit tests
   (§1, §2, data model). No behavior change yet.
2. **Checkout integration** — quote at `createOrder`, charge line + metadata,
   `chargeTotalCents` helper, F5 check re-base, `create_order`/`get_order`/`my_orders`
   `shipping` block (§2, §3, §9).
3. **Money paths** — payout base + proportional fee share, `refundCents` policy helper
   across all refund sites, carrier-failure full-refund rule (§4, §6).
4. **Label purchase** — quote-mode branch, rate-up rule, guards on actual rate, snapshot
   locking, `labelrefund` path on `record_tracking` (§5, §6).
5. **Estimate tool + docs** — `quote_shipping` with rate limit, `llms.txt`/reference updates
   for agents (§9).
