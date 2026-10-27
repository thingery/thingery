# Spec: Sellers bear Stripe processing fees (THI-374)

- **Status:** Accepted design, pending Security review → implementation
- **Date:** 2026-10-28
- **Author:** Architect
- **Decision source:** board 2026-10-27T15:02:33Z — rejection of the THI-358 confirmation card `112e00aa`, verbatim: *"sellers will pay the fees with their stripe account. Platform will not bare any cost."* Supersedes ADR 0003 OQ1 for the fee axis.
- **Gates THI-358** (DevOps live-mode flip). DevOps will not flip prod onto a cost model the board rejected.

## Problem

Today the platform transfers the **full** order amount to the seller's Express account (`src/stripe.ts` `createTransferForOrder` → `stripe.transfers.create({ amount: orderAmountCents(order) })`, `application_fee_amount` omitted). The buyer's charge settles into the platform balance **net of the Stripe processing fee**, so every completed order leaves the platform balance short by the fee (~1.5% + €0.25 EEA standard pricing). The board has rejected that cost model: sellers bear the fees; the platform's net cost per completed order must be €0.

## Context (repo @ 22fa8cf)

- ADR 0003: separate charges & transfers, Express connected accounts, platform = merchant of record (OQ2), funds held until delivered + dispute window, destination charges rejected (no hold at delivery → no buyer protection).
- Money path facts:
  - Payout funnels through exactly one function, `createTransferForOrder`, called from three sites, all passing the full `OrderRow`: `releaseFunds` (`src/fulfillment.ts`, trigger #17), `attemptPayout` (`src/orders-sweep.ts`, rule 4 / #16 + retry arm), `releaseWithReconcile` (`src/routes.ts`, admin release #19).
  - All payout sites already run inside the `payout_pending` retry semantics: a Stripe failure leaves the order `payout_pending` without `transfer_id`; sweep rule 4 retries under the same `payout:{order_id}` idempotency key; rule 7 alerts if stuck (§6.6).
  - Refunds always refund the **buyer in full** (`createRefundForOrder`, gross amount) from: stale sale / stuck transit / never-shipped (sweep rules 2/3/8, `refundFirst`), carrier failure (`webhooks-carrier.ts`), unexpected payment on a cancelled order (`webhooks-stripe.ts` F2), and admin refund after transfer (`routes.ts` `refundAfterTransfer` — full transfer reversal first, then gross refund, operator alert on shortfall).
  - Stripe SDK v23 types confirm the read path: `PaymentIntent.latest_charge: string | Charge | null` (expandable) → `Charge.balance_transaction: string | BalanceTransaction | null` (expandable) → `BalanceTransaction.fee / .net / .currency`.
- **Verified against current Stripe docs** (docs.stripe.com/refunds, retrieved 2026-10-28): *"You can cancel a payment before it completes at no cost. Alternatively, you can refund a payment in full or in part after it succeeds, but this might incur a cost. The Stripe processing fees on the original transaction aren't returned."* Refunds issued shortly after the original charge may instead process as **reversals**, for which Stripe withholds no fees — a possible recovery on fast refunds, never a design assumption.

## Proposed design (option A — net the transfer, preserve escrow)

**One change, in one function.** `src/stripe.ts` gains a helper and nets the transfer:

```ts
/** Seller payout = gross − the Stripe processing fee on the buyer's charge
 *  (board 2026-10-27; ADR 0003 amendment). Fails closed: any unknown fee
 *  leaves the order payout_pending for the sweep to retry (§6.6). */
export async function sellerNetTransferCents(
  order: { payment_intent_id: string | null; price_cents: number; shipping_price_cents: number; currency: string },
  stripe: Stripe,
): Promise<number>
```

Behavior:
1. Requires `order.payment_intent_id` (throws `inconsistent_state` otherwise — paid orders always have one).
2. `stripe.paymentIntents.retrieve(order.payment_intent_id, { expand: ["latest_charge.balance_transaction"] })`.
3. Reads the expanded `latest_charge.balance_transaction`; **throws** (`payout_netting_unavailable`) when the balance transaction is missing/not expanded, when `bt.currency !== order.currency.toLowerCase()` (cross-currency settlement — refuse to guess), or when `gross − bt.fee < 1` cent (degenerate micro-price; unreachable at real price floors, guarded anyway).
4. Returns `min(gross − bt.fee, gross)` — the fee is fixed once the charge settles, so the result is **deterministic across retries**, keeping the `payout:{order_id}` idempotency key sound (webhook-idempotency lens: same key + same params, never a second or drifting transfer).

`createTransferForOrder` then transfers `sellerNetTransferCents(order, stripe)` instead of `orderAmountCents(order)`. Its accepted order shape widens to include `payment_intent_id`; **all three call sites already pass the full `OrderRow` — no call-site changes, and no changes to `src/routes.ts` at all** (no protected-path involvement: the touched files are `src/stripe.ts` + tests + docs).

Money flow after the change (€100 order, €1.75 fee): buyer card → platform balance **+€98.25 net** → held until delivered + dispute window → **€98.25** transferred to the seller's Express account → **platform net cost €0.00**. The seller's own Express→bank payout fees (if any) are the seller's Stripe account costs — exactly "sellers will pay the fees with their stripe account."

**Refund sub-decision (decided, per verified Stripe policy).** Fees are not returned on refunds, and under separate charges & transfers there is no mechanism to debit a seller beyond reversing the transfer (max = the net already transferred), so the fee on a refunded order is **borne by the platform**:
- Pre-payout refunds (stale sale, stuck transit, never-shipped, carrier failure, unexpected payment): buyer refunded in full; platform cost = the fee (unless the refund lands as a pre-settlement reversal, best case).
- Post-payout refunds (admin refund after transfer): the existing full transfer reversal recovers the net transfer; the buyer is refunded in full; the residual gap shrinks from full-price to exactly the fee. The existing §6.4 reserve requirement and shortfall alert shrink accordingly.
- This residual is bounded per order by the fee and applies to **refunded** orders only — completed orders cost €0, which is the required end state. Recorded in the ADR amendment and flagged to the board (not silently decided).

**Unchanged and flagged.** Dispute/chargeback liability stays on the platform (merchant of record, ADR 0003 OQ2). Zero dispute exposure would mean direct charges (option C) — a product redesign re-trading escrow and buyer protection; out of scope without an explicit board decision.

## Data model changes

None. No new columns, no migrations. The fee is read live from the balance transaction — the settlement source of truth — rather than stored (storing `fee_cents` was rejected: schema churn plus a second source of truth that can drift; reading it costs one API call at payout time, per order).

## API / MCP tool changes

None to signatures or schemas (API-evolution lens: no agent-visible contract breaks). Behavioral change: the transfer that lands on a seller's connected account equals the order total **minus** the Stripe processing fee. `llms.txt` payout wording is updated so agents can set seller expectations. Self-hosters (registry installs, npm package) get netting automatically on upgrade — blast radius is payout amounts only, named in the PR and release notes. No per-deployment gross/net flag: one money-path branch fewer (simplicity/YAGNI; the board decision is product-level).

## Migration plan (expand-contract lens)

Purely additive code deploy; no DB step. In-flight orders at deploy time:
- `payout_pending` **with** `transfer_id` → already paid gross under the old model; terminal for money movement; platform eats that cohort's fee (bounded, one-time).
- `payout_pending` **without** `transfer_id` (or reaching payout after deploy) → first transfer attempt runs netted. Same `payout:{order_id}` key: if no attempt reached Stripe yet, no key was consumed; the first attempt is net and stays net.

## Test plan

New `tests/payout-netting.test.ts` (fake Stripe client, same seams as `fulfillment.test.ts`):
1. Transfers gross − fee; idempotency key still `payout:{order_id}`; currency lowercase.
2. Fee 0 → transfers gross.
3. Balance transaction missing / not expanded → throws `payout_netting_unavailable` (order stays payout_pending → sweep retry path).
4. `bt.currency` mismatch → throws.
5. `gross − fee < 1` → throws.
6. Fee ≥ gross pathological → clamped, never overpays (`min(net, gross)`).
7. Missing `payment_intent_id` → `inconsistent_state` (prevents blind gross transfer).

Update existing fakes: `fulfillment.test.ts` and `orders-sweep.test.ts` fake Stripe clients must stub `paymentIntents.retrieve` (expanded PI → charge → balance transaction with a fee) so `releaseFunds` / rule 4 keep asserting `transfers.create:payout:{order_id}`; `admin-route` release path likewise if it exercises transfer creation. CI green = acceptance.

## Rollout and rollback

- Rollout: merge (THI-36: CI green + Security review stated in the PR) → DevOps deploys → THI-358 executes the live flip + one real €1 end-to-end order (under the new model the ~€0.27 fee on the €1 test is borne by the test seller). DevOps updates `docs/deploy-vps.md` §5.3 payout-verification expectations after the code lands.
- Rollback: revert the commit; the kill switch (§5.3) is unchanged. Residual edge: an order whose netted transfer attempt failed at Stripe and whose gross retry is issued within the 24h idempotency window gets an `idempotency_error` → stays `payout_pending` → rule 7 alert → operator manual payout. Acceptable for a rollback-only path.

## Open questions

- None blocking. Two flags recorded, neither gating this change: (1) refund-path fee residual is platform-borne (mechanically unavoidable under A; board-visible in the ADR amendment); (2) dispute liability remains platform-borne (option C territory, needs an explicit board decision if ever wanted).

## PR-sized breakdown

One PR, `feat/thi374-seller-borne-fees` (~300 lines incl. docs):
1. `docs/specs/seller-borne-stripe-fees.md` (this spec) + ADR 0003 amendment + `website/llms.txt` payout wording.
2. `src/stripe.ts`: `sellerNetTransferCents` + netted `createTransferForOrder`.
3. `tests/payout-netting.test.ts` + fake updates in `fulfillment.test.ts` / `orders-sweep.test.ts`.

Sequence: Security reviews this spec **before** step 2 lands (payments change — secure-by-design lens); the review verdict is stated in the PR description with the board decision citation.
