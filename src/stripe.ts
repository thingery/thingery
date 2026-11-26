// Stripe client module (spec THI-3 rev 2 §6 + rev 3 §11.1/§11.4; PR-3).
//
// Separate charges and transfers with Express connected accounts (§6.1):
// the buyer pays the platform account via Checkout; funds sit in the
// platform balance until release; the platform then transfers to the
// seller's Express account. application_fee_amount is always 0 — Thingery
// never charges the users who create liquidity (any fee change is the
// human's call, never introduced here). The Stripe processing fee on the
// buyer's charge is borne by the SELLER via payout netting (board decision
// 2026-10-27, THI-374; ADR 0003 amendment 2026-10-27): the transfer is
// gross − fee, so a completed order costs the platform €0 net.
//
// Money-path idempotency (THI-8 F3): every transfers.create uses the Stripe
// idempotency key `payout:{order_id}` and every refunds.create uses
// `refund:{order_id}` — a crash between the Stripe call and the DB commit
// can never produce a second transfer or refund. Callers that reach a
// release/refund decision on an order that already carries a transfer_id /
// refund_id must RECONCILE, not recreate (retrieve* helpers below).
//
// The client is null when Stripe is unconfigured (config.ts kill switch) —
// callers translate that into `payments_not_configured`.

import Stripe from "stripe";
import { pool } from "./db.js";
import type { ItemRow } from "./db.js";
import { orderFlowConfig } from "./config.js";
import { planOperatorAlert } from "./notify/operator.js";
import { RateLimiter } from "./rate-limit.js";

/** Per-seller mint throttle for get_payout_setup (THI-875, residual finding
 *  from the THI-871 security review): every call mints a single-use Stripe
 *  onboarding link — a provider-side API call with per-call cost. The web
 *  client bounds presses per tab, but nothing client-side bounds a scripted
 *  session looping the tool, so the mint itself is capped server-side:
 *  10 mints/hour per seller (THI-112/THI-144 bucket convention, same shape
 *  as extractionSellerLimiter in extraction.ts — one shared exported bucket,
 *  keyed `seller:{id}`). Enforced in the get_payout_setup handler AFTER the
 *  kill-switch check, so unconfigured deployments keep returning the stable
 *  `payments_not_configured` error and never consume the bucket; over-limit
 *  reads fail closed with the `rate_limited` code the web client already
 *  renders, and log a `rate_limit` security event ("/mcp", THI-112 H4.2). */
export const payoutSetupLimiter = new RateLimiter(10, 60 * 60_000);

/** A6 (THI-1624): explicit API-version pin — the SDK's typed version, written
 *  as a literal `satisfies Stripe.LatestApiVersion`. A literal (NOT the SDK's
 *  silent default or the API_VERSION static) is the point: bumping the stripe
 *  npm package moves the typed version, so this line FAILS THE BUILD until
 *  the pin is re-confirmed deliberately (§5.3: an SDK upgrade is a deliberate
 *  act — bump the pin, re-check the §5.3 webhook event list against the new
 *  spec version, re-run the test-mode rehearsal). Exported for the CI guard
 *  test asserting pin == installed SDK version. */
export const STRIPE_API_VERSION = "2026-09-30.endive" satisfies Stripe.LatestApiVersion;

let client: Stripe | null | undefined;

/** Singleton Stripe client; null when STRIPE_SECRET_KEY is unset (kill switch). */
export function getStripe(): Stripe | null {
  if (client !== undefined) return client;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    client = null;
    return client;
  }
  client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  return client;
}

/** Test seam: inject a fake client (or reset to re-read the environment). */
export function setStripeForTests(fake: Stripe | null): void {
  client = fake;
}

/** The buyer's charge total (spec buyer-paid-shipping §3) — what Stripe must
 *  have taken for this order: item + flat shipping (0 in quote mode, where the
 *  label line replaces it) + the label-quote line when one exists. One helper
 *  everywhere a charge total is asserted or taken (webhook F5 acceptance,
 *  refunds) so the three can never drift. Integer cents end-to-end. */
export function chargeTotalCents(order: {
  price_cents: number;
  shipping_price_cents: number;
  label_quote?: { amount_cents: number } | null;
}): number {
  return order.price_cents + order.shipping_price_cents + (order.label_quote?.amount_cents ?? 0);
}

/** The seller's payout base (§3/§4): item + flat shipping. The label line is
 *  the buyer's money spent on their label — it is never transferable to the
 *  seller, so it is excluded here by construction (in quote mode
 *  shipping_price_cents is stored 0). */
export function payoutBaseCents(order: { price_cents: number; shipping_price_cents: number }): number {
  return order.price_cents + order.shipping_price_cents;
}

// ---------------------------------------------------------------------------
// Checkout Sessions (§6.2)

export interface CheckoutSessionInput {
  orderId: string;
  item: Pick<ItemRow, "title" | "currency" | "price_cents">;
  shippingPriceCents: number; // orders snapshot; 0 → no shipping line (flat)
  labelQuoteAmountCents?: number; // quote-mode label line (§3); 0/undefined → none
  expiresAt: Date; // payment deadline
  baseUrl: string;
}

export async function createCheckoutSession(
  input: CheckoutSessionInput,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.Checkout.Session> {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: input.item.currency.toLowerCase(),
        unit_amount: input.item.price_cents,
        product_data: { name: input.item.title.slice(0, 200) },
      },
    },
  ];
  if (input.shippingPriceCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: input.item.currency.toLowerCase(),
        unit_amount: input.shippingPriceCents,
        product_data: { name: "Shipping" },
      },
    });
  }
  // Quote mode (§3): the buyer pays the quoted label amount as its own
  // "Shipping" line — the flat amount is never added on top (the caller
  // stores shipping_price_cents 0 for these orders, so the branch above
  // stays silent). amount_cents is integer cents straight off the row
  // snapshot; the EUR-only selection upstream guarantees the currency matches.
  if (input.labelQuoteAmountCents && input.labelQuoteAmountCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: input.item.currency.toLowerCase(),
        unit_amount: input.labelQuoteAmountCents,
        product_data: { name: "Shipping" },
      },
    });
  }
  // Metadata (§3): the split is reconstructible from Stripe's side during
  // reconciliation — label_quote_amount_cents rides on both the Session and
  // the PaymentIntent (decimal string, Stripe metadata values are strings).
  const metadata: Record<string, string> = { order_id: input.orderId };
  if (input.labelQuoteAmountCents && input.labelQuoteAmountCents > 0) {
    metadata.label_quote_amount_cents = String(input.labelQuoteAmountCents);
  }
  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: lineItems,
      // Card only in v1: async EU methods can complete Checkout in
      // `processing`, which must never flip an order to sold (F5). SDK v23
      // spells the restriction `allowed_payment_method_types`.
      allowed_payment_method_types: ["card"],
      client_reference_id: input.orderId,
      metadata: { ...metadata },
      payment_intent_data: { metadata: { ...metadata } },
      expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      success_url: `${input.baseUrl}/order/${input.orderId}`,
      cancel_url: `${input.baseUrl}/order/${input.orderId}?canceled=1`,
    },
    { idempotencyKey: `checkout:${input.orderId}` },
  );
}

/** Pre-payment cancel (§2.3 #3): expire the session server-side, best-effort. */
export async function expireCheckoutSession(
  sessionId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<void> {
  await stripe.checkout.sessions.expire(sessionId).catch(() => undefined);
}

/** Paid-check (THI-8 F2): the authority cancel paths consult before cancelling. */
export async function getCheckoutPaymentStatus(
  sessionId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<"paid" | "unpaid" | "processing" | "unknown"> {
  const session = await stripe.checkout.sessions
    .retrieve(sessionId)
    .catch(() => null);
  const status = session?.payment_status as string | undefined;
  if (status === "paid" || status === "unpaid" || status === "processing") return status;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Money movement (§6.4) — idempotency keys + reconcile-don't-recreate

/** Shape every payout call site passes (all three pass the full OrderRow). */
export interface PayoutOrder {
  id: string;
  payment_intent_id: string | null;
  price_cents: number;
  shipping_price_cents: number;
  currency: string;
  label_quote?: { amount_cents: number } | null;
}

/** Refund-settle shape: the label line and its two settlement states are
 * row-only (spec §6) — label_purchase is an orders JSONB column, and the
 * own-label refund persists line_refund_id on label_quote. */
export interface RefundOrder {
  id: string;
  price_cents: number;
  shipping_price_cents: number;
  label_quote?: { amount_cents: number; line_refund_id?: string } | null;
  label_purchase?: Record<string, unknown> | null;
}

/**
 * Seller net payout = gross − the Stripe processing fee on the buyer's
 * charge (THI-374; spec docs/specs/seller-borne-stripe-fees.md). The fee is
 * read from the PaymentIntent's latest-charge balance transaction — the
 * settlement source of truth — and is fixed once the charge settles, so
 * repeated attempts under the same payout:{order_id} idempotency key carry
 * identical params (F3 stays sound; drift can only produce an
 * idempotency_error, never a second or different transfer).
 *
 * Fails closed on ANY unknown — missing payment intent, non-succeeded or
 * unexpanded charge, missing/unexpanded balance transaction, currency or
 * amount mismatch, or a net below 1 cent — so the order stays payout_pending
 * for the sweep retry + rule-7 alert (§6.6). It never falls back to gross:
 * a gross fallback would silently reinstate the board-rejected cost model
 * (Security review THI-375: fail-securely).
 */
export interface SellerNetTransfer {
  amountCents: number;
  /** The PaymentIntent's latest succeeded charge (A5) — passed as the
   *  transfer's source_transaction so the payout is tied to that charge's
   *  funds rather than the platform's available balance. */
  sourceChargeId: string;
}

export async function sellerNetTransfer(order: PayoutOrder, stripe: Stripe): Promise<SellerNetTransfer> {
  if (!order.payment_intent_id) throw new Error("inconsistent_state: paid order missing payment intent");
  const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id, {
    expand: ["latest_charge.balance_transaction"],
  });
  // THI-375 R2: the expanded latest_charge must be an object in a succeeded
  // state — anything else fails closed with a precise reason instead of a
  // confusing "missing balance transaction".
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  if (!charge || charge.status !== "succeeded") {
    throw new Error(`payout_netting_unavailable: no succeeded charge on ${order.payment_intent_id}`);
  }
  const bt = typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  if (!bt) throw new Error(`payout_netting_unavailable: no balance transaction on charge ${charge.id}`);
  const gross = payoutBaseCents(order);
  const chargeTotal = chargeTotalCents(order);
  // THI-375 R1 / buyer-paid-shipping §4 rule 1: the balance transaction must
  // BE this order's charge — the buyer's full charge, which in quote mode
  // includes the label line. A mismatch (dashboard manipulation, partial
  // capture, cross-currency settlement) fails closed; netting against the
  // wrong base could over- or under-pay the seller.
  if (bt.currency !== order.currency.toLowerCase() || bt.amount !== chargeTotal) {
    throw new Error(
      `payout_charge_mismatch: balance transaction ${bt.amount} ${bt.currency} ≠ charge ${chargeTotal} ${order.currency.toLowerCase()}`,
    );
  }
  // §4 rule 2 — fee allocation: the seller bears the fee on their own money
  // only. The Stripe fee covers item + flat + label lines together, so the
  // seller's share is proportional, rounded UP (the operator never absorbs
  // rounding). In flat mode base = charge, so the share is the whole fee and
  // this is byte-identical to the pre-quote netting.
  const sellerFeeShareCents = Math.ceil((bt.fee * gross) / chargeTotal);
  const net = Math.min(gross - sellerFeeShareCents, gross); // clamp pathological fees (negative); never overpay
  if (net < 1) throw new Error(`payout_netting_unavailable: net ${net}c after fee share ${sellerFeeShareCents}c of ${bt.fee}c (payout base ${gross}c)`);
  return { amountCents: net, sourceChargeId: charge.id };
}

/** The net amount alone — retained for callers/tests that only need the
 *  figure; createTransferForOrder uses sellerNetTransfer (charge id + net)
 *  so one Stripe read feeds both the netting and the source_transaction. */
export async function sellerNetTransferCents(order: PayoutOrder, stripe: Stripe): Promise<number> {
  return (await sellerNetTransfer(order, stripe)).amountCents;
}

/** B1-sibling (Security review THI-1013): a legal zero payout base — a
 * free item with no flat shipping. Nothing is due to the seller, so no
 * transfer exists or will ever exist (Stripe rejects amount-0 transfers);
 * `id` is null because there is nothing to reconcile at Stripe. Callers
 * settle the order via the `transfer_paid` transition (the sweep's rule-4
 * convergence point) instead of waiting for a webhook that cannot come. */
export interface ZeroBasePayout {
  zeroBase: true;
  id: null;
}

export type OrderTransfer = Stripe.Transfer | ZeroBasePayout;

/** THI-1681: check the destination account's transfer capability before
 *  moving money. The v1-view `capabilities.transfers` field serves BOTH
 *  legacy v1 accounts and v2 recipient accounts (sandbox-verified: a v2
 *  account with stripe_balance.stripe_transfers restricted reports
 *  `transfers: "inactive"` on GET /v1/accounts/:id). Active → ok; explicitly
 *  not-active → throw (callers already treat a failed transfer create the
 *  same way — the order sits in payout_pending and the sweep retries); a
 *  missing capabilities block (older v1 shapes) defers to Stripe's own
 *  rejection rather than guessing. If the retrieve itself fails, defer to
 *  Stripe: this guard sharpens the error and moves it earlier, it is not
 *  the enforcement boundary — transfers.create rejects unready accounts
 *  server-side, and callers handle that rejection identically. */
export async function ensureTransferable(accountId: string, stripe: Stripe = getStripe() ?? undefined!): Promise<void> {
  let acct: Stripe.Account | null = null;
  try {
    acct = await stripe.accounts.retrieve(accountId);
  } catch {
    return; // retrieve unavailable/failed → Stripe enforces at transfers.create
  }
  const transfers = acct?.capabilities?.transfers;
  if (transfers === undefined || transfers === "active") return;
  throw new Error(
    `payout_account_not_ready: ${accountId} transfer capability is ${transfers} — seller must complete payout onboarding`,
  );
}

export async function createTransferForOrder(
  order: PayoutOrder,
  destination: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<OrderTransfer> {
  // B1-sibling (THI-1013): base 0 (free listing) is schema-legal and
  // quote-mode-eligible. The old fail-closed throw (net < 1) wedged such
  // orders in payout_pending forever — no transfer could ever satisfy it.
  // Nothing to net or transfer: settle as an explicit zero-base outcome.
  // The balance-transaction read is skipped: with no funds moving, a
  // charge mismatch has nothing to corrupt (R1 guards transfers only).
  if (payoutBaseCents(order) <= 0) return { zeroBase: true, id: null };
  // THI-1681: net first, then the capability check, then move money — a
  // netting failure must surface before an onboarding-gap failure so the
  // operator sees the money-math problem, not the seller's KYC state.
  const { amountCents, sourceChargeId } = await sellerNetTransfer(order, stripe);
  await ensureTransferable(destination, stripe);
  // application_fee_amount is omitted → 0: the platform takes no cut (§6.1).
  // The seller bears the Stripe processing fee by netting (THI-374) — a
  // pass-through of Stripe's own processing cost, not platform revenue.
  return stripe.transfers.create(
    {
      amount: amountCents,
      currency: order.currency.toLowerCase(),
      destination,
      // A5 (spec docs/specs/thi1611-payments-card-only.md §A5): tie the
      // transfer to the buyer's charge instead of the platform's available
      // balance. Per Stripe (SDK v23 TransferCreateParams.source_transaction):
      // funds transfer before they are added to the available balance — the
      // transfer lands immediately and its funds become spendable by the
      // seller when the source charge settles, instead of failing with
      // balance_insufficient while card funds are still pending. The amount
      // is bounded by netting: amount ≤ gross − fee share ≤ charge net.
      source_transaction: sourceChargeId,
    },
    { idempotencyKey: `payout:${order.id}` },
  );
}

// ---------------------------------------------------------------------------
// Settle-aware refunds (buyer-paid shipping §6) — one helper, every site

/** The buyer's label line, if the order is in quote mode. */
export function labelLineCents(order: Pick<RefundOrder, "label_quote">): number {
  return order.label_quote?.amount_cents ?? 0;
}

/** A platform label was bought for this order (label_purchase present) — the
 * line was procured with the buyer's money and is retained against it. */
export function lineRetained(order: Pick<RefundOrder, "label_purchase">): boolean {
  return order.label_purchase != null;
}

/** The own-label partial refund (`labelrefund:{order_id}`) already fired —
 * the line is back with the buyer; a full refund must not repeat it. */
export function lineRefunded(order: Pick<RefundOrder, "label_quote">): boolean {
  return order.label_quote?.line_refund_id != null;
}

/** Per-site refund policy for the label line when a platform label was
 * bought (retained): `exclude_label` — the buyer bears the bought label
 * (cancel, stale-sale, never-shipped, admin default); `include_label` — the
 * deployment bears its own procurement (carrier failure with a platform
 * label, and sites that can only run before any purchase). */
export type LabelLinePolicy = "exclude_label" | "include_label";

/**
 * Settle-aware refund amount (§6):
 *
 *   chargeTotalCents
 *   − (lineRetained AND policy excludes ? labelLineCents : 0)
 *   − (lineRefunded ? labelLineCents : 0)
 *
 * The two deductions are structurally exclusive; should a future feature
 * ever stack them, this over-deducts (refunds too little — alertable via the
 * C1 operator alert) and the clamp keeps it within [0, charge].
 */
export function refundCents(order: RefundOrder, policy: LabelLinePolicy): number {
  const total = chargeTotalCents(order);
  let amount = total;
  if (lineRetained(order) && policy === "exclude_label") amount -= labelLineCents(order);
  if (lineRefunded(order)) amount -= labelLineCents(order);
  return Math.max(0, Math.min(amount, total));
}

/**
 * C1 carry-forward (THI-988): the stacked state `label_purchase ∧
 * label_quote.line_refund_id` is structurally impossible (the own-label
 * refund fires only while no label was bought), but if it ever appears the
 * refund helper over-deducts — refunds too little. Make the alert concrete:
 * console.error floor + a deduped operator alert (opalert:{ref}), never
 * breaking the refund path over the alert itself.
 */
async function alertLabelRefundStackIfPresent(order: RefundOrder): Promise<void> {
  if (!(lineRetained(order) && lineRefunded(order))) return;
  const line = labelLineCents(order);
  console.error(
    `[refund] C1 stacked state on order ${order.id}: label_purchase ∧ line_refund_id both set (line ${line}c) — ` +
      `refundCents will over-deduct; operator reconciliation needed`,
  );
  await planOperatorAlert({
    kind: "label_refund_stack",
    ref: `label_stack:${order.id}`,
    subject: `Order ${order.id}: label line both retained and refunded`,
    payload: { order_id: order.id, label_line_cents: line },
  }).catch(() => undefined); // the console.error floor already fired
}

/** B1 (Security review THI-1013): the legal zero-remainder refund outcome.
 * Stripe rejects `amount: 0` with invalid_request_error, so no refund object
 * can exist for a nothing-due remainder; the transition still fires. `id`
 * carries the own-label line refund when that already returned the buyer's
 * label money (keeping refund_id-based reconcile guards sound), else null —
 * replaying the site recomputes the same outcome with no Stripe call, so a
 * null id stays idempotent. */
export interface NothingDueRefund {
  nothingDue: true;
  id: string | null;
}

export type OrderRefund = Stripe.Refund | NothingDueRefund;

/** B1 (THI-1013): narrow the refund union — Stripe.Refund carries no
 * `nothingDue` marker, so this is the one safe discriminator. */
export function isNothingDueRefund(refund: OrderRefund): refund is NothingDueRefund {
  return (refund as NothingDueRefund).nothingDue === true;
}

export async function createRefundForOrder(
  order: RefundOrder,
  paymentIntentId: string,
  stripe: Stripe = getStripe() ?? undefined!,
  labelLinePolicy: LabelLinePolicy = "exclude_label",
): Promise<OrderRefund> {
  await alertLabelRefundStackIfPresent(order);
  // Settle-aware amount (§6): identical to chargeTotalCents in every state
  // where no label was bought (flat mode, quote mode before purchase, and
  // the pre-payment sites); the label line leaves the refund only when a
  // platform label was bought under an excluding policy, or when
  // the own-label partial refund already returned it.
  const amount = refundCents(order, labelLinePolicy);
  // B1 (THI-1013): a zero remainder is legal — a free item whose charge is
  // the label line only (bought, excluding policy), the C1 clamp bottoming
  // out, or a fully line-refunded zero-price charge. Stripe would reject
  // amount 0 (invalid_request_error), which wedged the transition at every
  // refund site. Nothing is due: settle without a Stripe call, surfacing
  // the line refund id when the own-label refund already paid the buyer.
  if (amount <= 0) {
    const lineRefundId = order.label_quote?.line_refund_id ?? null;
    console.error(
      `[refund] order ${order.id}: refund remainder ${amount}c — nothing due` +
        (lineRefundId ? `; settled by own-label line refund ${lineRefundId}` : "; no Stripe refund created"),
    );
    return { nothingDue: true, id: lineRefundId };
  }
  return stripe.refunds.create(
    { payment_intent: paymentIntentId, amount },
    { idempotencyKey: `refund:${order.id}` },
  );
}

/** Reconcile path (F3): retrieve instead of recreating. */
export async function retrieveTransfer(
  transferId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.Transfer | null> {
  return stripe.transfers.retrieve(transferId).catch(() => null);
}

export async function retrieveRefund(
  refundId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.Refund | null> {
  return stripe.refunds.retrieve(refundId).catch(() => null);
}

// ---------------------------------------------------------------------------
// Seller payout onboarding (§6.3; rev 3 OQ3: asked, not mandatory;
// THI-1681: creation + onboarding links moved to the Accounts v2 API —
// THI-571: Stripe rejects v1 `accounts.create` on this account, so the v1
// path is dead for NEW accounts. Legacy v1 account ids (none exist in prod
// or test as of 2026-11-26: sellers.stripe_account_id is NULL on all 54
// sellers) stay readable: the v1 GET /v1/accounts/:id works on v2 ids too
// (verified in sandbox), so retrieve/reconcile paths are version-agnostic.

export interface PayoutSetup {
  stripeAccountId: string;
  onboardedAt: Date | null;
}

/** v2 recipient accounts require a contact email (sandbox-verified 400
 *  invalid_fields when absent). Sellers created through signup always have
 *  one; API-key-seeded sellers may not — the tool surfaces this as a
 *  recoverable `email_required` error, never a generic 500. */
export class PayoutSetupEmailRequiredError extends Error {
  constructor() {
    super("payout setup requires an account email (Stripe contact_email)");
    this.name = "PayoutSetupEmailRequiredError";
  }
}

/** The seller's payout country for account creation: their most relevant
 *  address country (default first, then most recently used), else the
 *  platform country (EE). Prefill only — Stripe's hosted onboarding collects
 *  the authoritative identity; identity.country remains editable via
 *  accounts.update until onboarding completes (sandbox-verified).
 *  Caller supplies the seller's id; NULL when the seller has no address. */
async function payoutCountryFor(sellerId: string): Promise<string | null> {
  const r = await pool.query<{ country: string | null }>(
    `SELECT (SELECT a.country FROM account_addresses a WHERE a.account_id = $1
             ORDER BY a.is_default DESC, a.last_used_at DESC NULLS LAST, a.created_at DESC
             LIMIT 1) AS country`,
    [sellerId],
  );
  return r.rows[0]?.country ?? null;
}

/** Keep an existing account's identity.country aligned with the seller's
 *  current address country while onboarding has NOT completed (transfers
 *  capability not active — the same v1-view field serves v2 recipient
 *  accounts, sandbox-verified). Only v2 accounts (v1-view `type: "none"`)
 *  are updated; legacy v1 accounts are left untouched, and any failure is
 *  swallowed — a stale prefill must never break link minting. */
async function syncPayoutCountry(accountId: string, sellerId: string, stripe: Stripe): Promise<void> {
  try {
    const country = await payoutCountryFor(sellerId);
    if (!country) return;
    const acct = await stripe.accounts.retrieve(accountId);
    if (acct.type !== "none") return; // legacy v1 account — hands off
    const active = acct.capabilities?.transfers === "active";
    if (active) return;
    if ((acct.country ?? "").toUpperCase() === country.toUpperCase()) return;
    await stripe.v2.core.accounts.update(accountId, { identity: { country } });
  } catch {
    // Prefill-only best effort: never fail payout setup over it.
  }
}

/**
 * The seller's connected-account id, creating a v2 recipient account once
 * (THI-1681: Accounts v2 — marketplace recipient configuration, transfers
 * only, NO merchant/card-payments; Express dashboard; platform collects
 * fees and bears losses — the one Dashboard-acknowledged combination Stripe
 * allows for recipient+stripe_transfers, docs.stripe.com/connect/marketplace/tasks/create).
 * Concurrent calls can briefly create two accounts; the UPDATE…WHERE NULL
 * arbitration keeps exactly one stored — the loser account stays unused in
 * Stripe (harmless; cleaned up by the seller's own Stripe dashboard).
 * Throws PayoutSetupEmailRequiredError when the seller has no email (v2
 * requires contact_email).
 */
export async function getOrCreateStripeAccount(
  sellerId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<string> {
  const existing = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [sellerId],
  );
  const current = existing.rows[0]?.stripe_account_id;
  if (current) {
    await syncPayoutCountry(current, sellerId, stripe);
    return current;
  }

  const owner = await pool.query<{ email: string | null }>(
    "SELECT email FROM sellers WHERE id = $1",
    [sellerId],
  );
  const email = owner.rows[0]?.email ?? null;
  if (!email) throw new PayoutSetupEmailRequiredError();

  // THI-1678 (parent decision 2026-11-26): v2 account creation carries the
  // seller's country (v1 sent none and Stripe defaulted it to the platform's
  // Estonia). include keeps identity + recipient state in the create response
  // so the arbitration loser is fully described in logs.
  const country = (await payoutCountryFor(sellerId)) ?? "EE";
  const account = await stripe.v2.core.accounts.create({
    dashboard: "express",
    identity: { country },
    contact_email: email,
    metadata: { seller_id: sellerId },
    defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    },
    include: ["configuration.recipient", "identity"],
  });
  const won = await pool.query(
    "UPDATE sellers SET stripe_account_id = $2 WHERE id = $1 AND stripe_account_id IS NULL",
    [sellerId, account.id],
  );
  if (won.rowCount === 1) return account.id;
  const reread = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [sellerId],
  );
  return reread.rows[0]?.stripe_account_id ?? account.id;
}

/** Stripe-hosted onboarding link (Accounts v2 account_links, §6.3 + THI-1681).
 *  Single-use, HTTPS-only URLs (even in sandbox); refresh/return both land on
 *  the payout-setup page, which re-calls get_payout_setup for a fresh link. */
export async function createOnboardingLink(
  stripeAccountId: string,
  baseUrl: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.V2.Core.AccountLink> {
  return stripe.v2.core.accountLinks.create({
    account: stripeAccountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        refresh_url: `${baseUrl}/order/payout-setup`,
        return_url: `${baseUrl}/order/payout-setup`,
      },
    },
  });
}

/** Payout readiness snapshot for tool responses (onboarded_at set by PR-6). */
export async function getPayoutSetup(sellerId: string): Promise<PayoutSetup | null> {
  const r = await pool.query<{ stripe_account_id: string | null; stripe_onboarded_at: Date | null }>(
    "SELECT stripe_account_id, stripe_onboarded_at FROM sellers WHERE id = $1",
    [sellerId],
  );
  const row = r.rows[0];
  if (!row?.stripe_account_id) return null;
  return { stripeAccountId: row.stripe_account_id, onboardedAt: row.stripe_onboarded_at };
}

/** payments_not_configured guard shared by every stripe-mode surface. */
export function stripeConfigured(): boolean {
  return orderFlowConfig().stripePaymentsEnabled;
}
