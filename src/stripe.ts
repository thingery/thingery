// Stripe client module (spec THI-3 rev 2 §6 + rev 3 §11.1/§11.4; PR-3).
//
// Separate charges and transfers with Express connected accounts (§6.1):
// the buyer pays the platform account via Checkout; funds sit in the
// platform balance until release; the platform then transfers to the
// seller's Express account. application_fee_amount is always 0 — Thingery
// never charges the users who create liquidity (any fee change is the
// human's call, never introduced here).
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

let client: Stripe | null | undefined;

/** Singleton Stripe client; null when STRIPE_SECRET_KEY is unset (kill switch). */
export function getStripe(): Stripe | null {
  if (client !== undefined) return client;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    client = null;
    return client;
  }
  client = new Stripe(key); // apiVersion pinned by the SDK default
  return client;
}

/** Test seam: inject a fake client (or reset to re-read the environment). */
export function setStripeForTests(fake: Stripe | null): void {
  client = fake;
}

/** Full order amount the buyer pays and the seller receives (rev 3 §11.4). */
export function orderAmountCents(order: { price_cents: number; shipping_price_cents: number }): number {
  return order.price_cents + order.shipping_price_cents;
}

// ---------------------------------------------------------------------------
// Checkout Sessions (§6.2)

export interface CheckoutSessionInput {
  orderId: string;
  item: Pick<ItemRow, "title" | "currency" | "price_cents">;
  shippingPriceCents: number; // orders snapshot; 0 → no shipping line
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
  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: lineItems,
      // Card only in v1: async EU methods can complete Checkout in
      // `processing`, which must never flip an order to sold (F5). SDK v23
      // spells the restriction `allowed_payment_method_types`.
      allowed_payment_method_types: ["card"],
      client_reference_id: input.orderId,
      metadata: { order_id: input.orderId },
      payment_intent_data: { metadata: { order_id: input.orderId } },
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

export async function createTransferForOrder(
  order: { id: string; price_cents: number; shipping_price_cents: number; currency: string },
  destination: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.Transfer> {
  // application_fee_amount is omitted → 0: the platform takes no cut (§6.1).
  return stripe.transfers.create(
    {
      amount: orderAmountCents(order),
      currency: order.currency.toLowerCase(),
      destination,
    },
    { idempotencyKey: `payout:${order.id}` },
  );
}

export async function createRefundForOrder(
  order: { id: string; price_cents: number; shipping_price_cents: number },
  paymentIntentId: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.Refund> {
  return stripe.refunds.create(
    { payment_intent: paymentIntentId, amount: orderAmountCents(order) },
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
// Seller payout onboarding (§6.3; rev 3 OQ3: asked, not mandatory)

export interface PayoutSetup {
  stripeAccountId: string;
  onboardedAt: Date | null;
}

/**
 * The seller's connected-account id, creating an Express account once.
 * Concurrent calls can briefly create two accounts; the UPDATE…WHERE NULL
 * arbitration keeps exactly one stored — the loser account stays unused in
 * Stripe (harmless; cleaned up by the seller's own Stripe dashboard).
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
  if (current) return current;

  const account = await stripe.accounts.create({ type: "express", metadata: { seller_id: sellerId } });
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

/** Stripe Express onboarding link (account_links, §6.3). */
export async function createOnboardingLink(
  stripeAccountId: string,
  baseUrl: string,
  stripe: Stripe = getStripe() ?? undefined!,
): Promise<Stripe.AccountLink> {
  return stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${baseUrl}/order/payout-setup`,
    return_url: `${baseUrl}/order/payout-setup`,
    type: "account_onboarding",
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
