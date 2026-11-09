// Buyer-facing order flow (spec THI-3 rev 2 §2/§4.1/§4.2 + rev 3 §11.2) —
// PR-4: create_order, get_order, cancel_order. State changes go through the
// PR-2 transition core (src/orders.ts): the only direct write here is the
// order's own creation (#1), which reserves the item with the same
// conditional-UPDATE protocol (WHERE status='active' — 0 rows means a racing
// buyer won, never a double reservation; the partial unique index
// one_live_order_per_item backs it up).
//
// Money never moves here except refunds on stripe-mode cancellation (#8/#11),
// which use the PR-3 Stripe module's refund:{order_id} idempotency key and
// RECONCILE-don't-recreate on replay (THI-8 F3). The F2 paid-check refuses
// to cancel a paid-but-webhook-pending order instead of stranding money.

import { pool } from "./db.js";
import type { OrderRow, OrderStatus } from "./orders.js";
import { applyTransition, IllegalTransitionError } from "./orders.js";
import { orderFlowConfig } from "./config.js";
import {
  createCheckoutSession,
  createRefundForOrder,
  expireCheckoutSession,
  getCheckoutPaymentStatus,
  getStripe,
} from "./stripe.js";

export class OrderFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OrderFlowError";
  }
}

/** Validated by the tool layer's zod schema (F16); unknown keys rejected there. */
export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postal_code: string;
  country: string;
}

export type OrderView = OrderRow & {
  item_title: string;
  payment_url: string | null;
};

export interface CreateOrderInput {
  buyerId: string;
  itemId: string;
  shippingAddress?: ShippingAddress;
  paymentMode?: "stripe" | "off_platform";
}

/** payments configured deployment-wide AND seller payout-ready (§11.2). */
export async function sellerPayoutReady(
  sellerId: string,
  db: Pick<typeof pool, "query"> = pool,
): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    "SELECT (stripe_account_id IS NOT NULL AND stripe_onboarded_at IS NOT NULL) AS ready FROM sellers WHERE id = $1",
    [sellerId],
  );
  return rows[0]?.ready === true;
}

export async function createOrder(input: CreateOrderInput): Promise<{ order: OrderView; paymentUrl: string | null }> {
  const cfg = orderFlowConfig();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const item = await db.query(
      "SELECT id, seller_id, title, price_cents, shipping_price_cents, currency, shipping_tier FROM items WHERE id = $1",
      [input.itemId],
    );
    const row = item.rows[0];
    if (!row || (await db.query("SELECT status FROM items WHERE id = $1", [input.itemId])).rows[0].status === "deleted") {
      throw new OrderFlowError("not_found", "Item not found.");
    }
    if (row.seller_id === input.buyerId) {
      throw new OrderFlowError("self_order", "Sellers cannot order their own item.");
    }

    // F8 — abuse caps before reserving anything.
    const pending = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM orders WHERE buyer_id = $1 AND status = 'pending'",
      [input.buyerId],
    );
    if (pending.rows[0].n >= cfg.maxPendingOrdersPerBuyer) {
      throw new OrderFlowError(
        "too_many_pending_orders",
        `You already have ${pending.rows[0].n} pending orders (cap ${cfg.maxPendingOrdersPerBuyer}). Pay or cancel one first.`,
      );
    }
    const cooldown = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE item_id = $1 AND buyer_id = $2 AND status = 'cancelled'
         AND updated_at > now() - ($3 || ' minutes')::interval`,
      [input.itemId, input.buyerId, String(cfg.reorderCooldownMinutes)],
    );
    if (cooldown.rows[0].n > 0) {
      throw new OrderFlowError(
        "reorder_cooldown",
        `You cancelled an order on this item less than ${cfg.reorderCooldownMinutes} minutes ago; please wait before reordering.`,
      );
    }

    // Payment mode resolution (§11.2): default stripe when available, else
    // off_platform; an explicit 'stripe' where unavailable is an error.
    const paymentsAvailable = cfg.stripePaymentsEnabled && (await sellerPayoutReady(row.seller_id, db));
    const mode = input.paymentMode ?? (paymentsAvailable ? "stripe" : "off_platform");
    if (mode === "stripe" && !paymentsAvailable) {
      throw new OrderFlowError(
        cfg.stripePaymentsEnabled ? "seller_not_payout_ready" : "payments_not_configured",
        cfg.stripePaymentsEnabled
          ? "The seller has not completed payout onboarding; order with payment_mode 'off_platform'."
          : "Stripe payments are not configured on this deployment; order with payment_mode 'off_platform'.",
      );
    }

    // Fulfillment: local-tier items are pickup-only; everything else ships
    // and requires an address (validated at the tool boundary, F16).
    const fulfillment = row.shipping_tier === "local" ? "pickup" : "shipping";
    if (fulfillment === "shipping" && !input.shippingAddress) {
      throw new OrderFlowError("shipping_address_required", "This item ships — provide shipping_address (name, line1, city, postal_code, country).");
    }

    // #1 create_order: conditional reservation — 0 rows = racing buyer won.
    const reserved = await db.query(
      "UPDATE items SET status = 'reserved', updated_at = now() WHERE id = $1 AND status = 'active'",
      [input.itemId],
    );
    if (reserved.rowCount !== 1) {
      throw new OrderFlowError("item_unavailable", "Item is no longer available (just reserved, sold, or removed).");
    }

    const deadline = new Date(Date.now() + cfg.paymentDeadlineHours * 3600_000);
    let paymentUrl: string | null = null;
    let order: OrderRow | undefined;
    try {
      const inserted = await db.query<OrderRow>(
        `INSERT INTO orders (item_id, seller_id, buyer_id, status, payment_mode, price_cents,
           shipping_price_cents, currency, fulfillment, shipping_address, payment_deadline)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
        [
          input.itemId, row.seller_id, input.buyerId, mode, row.price_cents,
          fulfillment === "pickup" ? 0 : row.shipping_price_cents, row.currency,
          fulfillment, JSON.stringify(input.shippingAddress ?? {}), deadline,
        ],
      );
      order = inserted.rows[0];
    } catch (err) {
      // one_live_order_per_item partial unique index: a racing writer got
      // here first despite the reservation (belt and braces).
      if ((err as { code?: string }).code === "23505") {
        throw new OrderFlowError("item_unavailable", "Item is no longer available.");
      }
      throw err;
    }
    await db.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, actor_id, reason)
       VALUES ($1, 'transition', NULL, 'pending', 'buyer', $2, 'create_order')`,
      [order.id, input.buyerId],
    );

    if (mode === "stripe") {
      const stripe = getStripe();
      if (!stripe) throw new OrderFlowError("payments_not_configured", "Stripe payments are not configured on this deployment.");
      const session = await createCheckoutSession(
        {
          orderId: order.id,
          item: { title: row.title, currency: row.currency, price_cents: row.price_cents },
          shippingPriceCents: order.shipping_price_cents,
          expiresAt: deadline,
          baseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
        },
        stripe,
      );
      await db.query("UPDATE orders SET checkout_session_id = $2 WHERE id = $1", [order.id, session.id]);
      order = { ...order, checkout_session_id: session.id };
      paymentUrl = session.url;
    }

    await db.query("COMMIT");
    return { order: { ...order, item_title: row.title, payment_url: paymentUrl }, paymentUrl };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

/** Buyer or seller only — outsiders get not_found (no existence leak). */
export async function getOrderView(orderId: string, viewerId: string): Promise<OrderView | null> {
  const { rows } = await pool.query<OrderRow & { item_title: string }>(
    `SELECT o.*, i.title AS item_title FROM orders o JOIN items i ON i.id = o.item_id
     WHERE o.id = $1 AND (o.buyer_id = $2 OR o.seller_id = $2)`,
    [orderId, viewerId],
  );
  const order = rows[0];
  if (!order) return null;

  let paymentUrl: string | null = null;
  if (order.status === "pending" && order.payment_mode === "stripe" && order.checkout_session_id) {
    const stripe = getStripe();
    if (stripe) {
      const session = await stripe.checkout.sessions.retrieve(order.checkout_session_id).catch(() => null);
      paymentUrl = session?.url ?? null;
    }
  }
  return { ...order, payment_url: paymentUrl };
}

// sold: paid (#2) or payment confirmed (#24), so the seller must ship now.
// label_issued: tracking is recorded but no carrier has scanned the parcel
// (#10 is carrier-only), so a relabel or a #23 tracking correction can still
// need the address. Every other state is either before payment, in carrier
// custody, frozen by a dispute or finished. A won chargeback (#22r) restores
// sold/label_issued, which re-enables disclosure through this same check.
const SELLER_SHIPPING_ADDRESS_STATUSES: readonly OrderStatus[] = ["sold", "label_issued"];

/**
 * The one place shipping_address may be released to a counterparty: the
 * order's own seller, on a shipped order, only while there is something to
 * ship and, off-platform, only after the buyer agreed for this order.
 * Returns null otherwise.
 */
export function shippingAddressForSeller(
  order: Pick<OrderRow, "seller_id" | "status" | "fulfillment" | "shipping_address" | "payment_mode" | "shipping_address_shared_at">,
  viewerId: string,
): OrderRow["shipping_address"] | null {
  if (order.seller_id !== viewerId) return null;
  if (order.fulfillment !== "shipping") return null;
  if (!SELLER_SHIPPING_ADDRESS_STATUSES.includes(order.status)) return null;
  if (needsBuyerAddressConsent(order) && !order.shipping_address_shared_at) return null;
  return order.shipping_address;
}

// Stripe verifies payment before an order reaches sold. Off-platform, sold only
// records the seller's own claim (#24), so it cannot be what releases the address.
function needsBuyerAddressConsent(order: Pick<OrderRow, "payment_mode">): boolean {
  return order.payment_mode !== "stripe";
}

export type ShippingAddressConsent =
  | { status: "granted"; granted_at: Date }
  | { status: "awaiting_buyer"; next_step: string };

const AWAITING_CONSENT_NEXT_STEP = {
  buyer:
    "The seller has marked this order paid but cannot see your address. Ask the buyer whether to share it; " +
    "call share_shipping_address only if they agree.",
  seller:
    "The buyer has not agreed to share their address yet. It appears in shipping_address once they do; " +
    "you cannot grant this yourself.",
};

/**
 * What an order party is told about address consent. Null when consent does
 * not apply: Stripe-mode and pickup orders, and states where it cannot lead to
 * a release. Never carries the address itself.
 */
export function shippingAddressConsent(
  order: Pick<OrderRow, "seller_id" | "buyer_id" | "status" | "fulfillment" | "payment_mode" | "shipping_address_shared_at">,
  viewerId: string,
): ShippingAddressConsent | null {
  if (viewerId !== order.seller_id && viewerId !== order.buyer_id) return null;
  if (order.fulfillment !== "shipping" || !needsBuyerAddressConsent(order)) return null;
  if (order.shipping_address_shared_at) return { status: "granted", granted_at: order.shipping_address_shared_at };
  if (!SELLER_SHIPPING_ADDRESS_STATUSES.includes(order.status)) return null;
  return {
    status: "awaiting_buyer",
    next_step: AWAITING_CONSENT_NEXT_STEP[viewerId === order.buyer_id ? "buyer" : "seller"],
  };
}

function consentClosedError(status: OrderStatus): OrderFlowError {
  return new OrderFlowError(
    "invalid_state",
    `This order is ${status}. The address can be shared only once the seller has confirmed payment and ` +
      "before the parcel is with the carrier (sold or label_issued).",
  );
}

/**
 * Records the buyer's agreement to show the seller this order's address.
 * Not offered in `pending`: agreeing after the seller's payment claim is what
 * lets the buyer check that claim first. Replaying it is a no-op.
 */
export async function shareShippingAddress(orderId: string, buyerId: string): Promise<OrderRow> {
  const buyerOrder = async () =>
    (await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1 AND buyer_id = $2", [orderId, buyerId])).rows[0];

  const order = await buyerOrder();
  if (!order) throw new OrderFlowError("not_found", "Order not found.");
  if (!needsBuyerAddressConsent(order)) {
    throw new OrderFlowError("not_applicable", "Stripe-mode orders need no address consent: payment is verified.");
  }
  if (order.fulfillment !== "shipping") {
    throw new OrderFlowError("not_applicable", "Pickup orders have no shipping address to share.");
  }
  if (order.shipping_address_shared_at) return order;
  if (!SELLER_SHIPPING_ADDRESS_STATUSES.includes(order.status)) throw consentClosedError(order.status);

  // One statement, so consent and its audit row cannot diverge. The WHERE
  // repeats the status check because a racing transition can land after the
  // read above; IS NULL keeps a concurrent replay to a single event.
  await pool.query(
    `WITH shared AS (
       UPDATE orders SET shipping_address_shared_at = now()
       WHERE id = $1 AND buyer_id = $2 AND status = ANY($3::text[]) AND shipping_address_shared_at IS NULL
       RETURNING id, buyer_id
     )
     INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason)
     SELECT id, 'shipping_address_shared', 'buyer', buyer_id::text, 'share_shipping_address' FROM shared`,
    [orderId, buyerId, SELLER_SHIPPING_ADDRESS_STATUSES],
  );

  const current = await buyerOrder();
  if (!current) throw new OrderFlowError("not_found", "Order not found.");
  if (!current.shipping_address_shared_at) throw consentClosedError(current.status);
  return current;
}

export async function cancelOrder(orderId: string, actorId: string, reason?: string): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order || (order.buyer_id !== actorId && order.seller_id !== actorId)) {
    throw new OrderFlowError("not_found", "Order not found.");
  }
  const actorType = actorId === order.buyer_id ? "buyer" : "seller";

  if (order.status === "pending" && order.payment_mode === "stripe") {
    // F2 paid-check: never cancel a paid-but-webhook-pending order.
    if (!order.checkout_session_id) return applyTransition({ orderId, trigger: "cancel_order", actor: { type: actorType, id: actorId }, reason });
    const status = await getCheckoutPaymentStatus(order.checkout_session_id);
    if (status === "paid" || status === "processing" || status === "unknown") {
      await pool.query(
        `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
         VALUES ($1, 'unexpected_payment', 'system', NULL, 'cancel refused: checkout session paid/unclear', $2::jsonb)`,
        [orderId, JSON.stringify({ payment_status: status })],
      );
      throw new OrderFlowError(
        "order_already_paid",
        "Payment already went through (webhook catching up). Let it settle; after delivery you can open_dispute if needed.",
      );
    }
    await expireCheckoutSession(order.checkout_session_id); // best-effort
  }

  if ((order.status === "sold" || order.status === "label_issued") && order.payment_mode === "stripe") {
    // #8/#11 — refund first under refund:{order_id} idempotency (F3), then
    // transition; a replayed cancel retrieves the same refund instead of
    // creating a second one. refund_confirmed (#21) lands via the PR-6 webhook.
    if (!order.payment_intent_id) {
      throw new OrderFlowError("inconsistent_state", "Paid order missing payment intent; refusing to refund blindly.");
    }
    const stripe = getStripe();
    if (!stripe) throw new OrderFlowError("payments_not_configured", "Stripe payments are not configured on this deployment.");
    const refund = await createRefundForOrder(order, order.payment_intent_id, stripe);
    return applyTransition({
      orderId, trigger: "cancel_order", actor: { type: actorType, id: actorId }, reason,
      sets: { refund_id: refund.id },
    });
  }

  // #3 / #8b / #11b — off_platform twins and stripe pre-payment cancel.
  try {
    return await applyTransition({ orderId, trigger: "cancel_order", actor: { type: actorType, id: actorId }, reason });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      throw new OrderFlowError("invalid_transition", err.message);
    }
    throw err;
  }
}
