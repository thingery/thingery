// Fulfillment + dispute tools (spec THI-3 rev 2 §4.2/§5.2 + rev 3 §11.2; PR-5).
//
// record_tracking (#5/#23), confirm_payment (#24), confirm_receipt (#6/#13),
// open_dispute (#15), release_funds (#17/#17b). All state changes go through
// the PR-2 transition core (src/orders.ts). Money only moves on
// release_funds (stripe mode): transition first (the conditional UPDATE
// guarantees we exclusively hold delivered → payout_pending — a racing
// chargeback #22 loses), then transfers.create under the payout:{order_id}
// idempotency key (F3). If the Stripe call fails after the transition the
// order sits in payout_pending with no transfer_id — surfaced to the caller
// and reconciled later by the PR-8 sweep with the same idempotency key.

import { pool } from "./db.js";
import type { OrderRow } from "./orders.js";
import { applyTransition, IllegalTransitionError } from "./orders.js";
import { orderFlowConfig } from "./config.js";
import { OrderFlowError } from "./order-flow.js";
import { createTransferForOrder, getStripe } from "./stripe.js";
import { createEasyPostTracker } from "./easypost.js";

export { OrderFlowError };

/** Loads the order; outsiders (and wrong ids) get not_found — no leak. */
async function partyOrder(orderId: string, actorId: string, mustBe: "buyer" | "seller"): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) throw new OrderFlowError("not_found", "Order not found.");
  if (mustBe === "buyer" && order.buyer_id !== actorId) {
    throw new OrderFlowError("not_found", "Order not found.");
  }
  if (mustBe === "seller" && order.seller_id !== actorId) {
    throw new OrderFlowError("not_found", "Order not found.");
  }
  return order;
}

function rethrow(err: unknown): never {
  if (err instanceof IllegalTransitionError) {
    throw new OrderFlowError("invalid_transition", err.message);
  }
  throw err;
}

export interface RecordTrackingInput {
  carrier: string;
  trackingCode: string;
  labelUrl?: string;
}

/**
 * Seller records tracking (#5 sold → label_issued, shipping only) or
 * corrects it pre-transit (#23 — not a state change: fields replaced and
 * logged as an event while still label_issued). Registers an EasyPost
 * tracker when the deployment has EASYPOST_API_KEY (best-effort — failures
 * are event-logged, the order still advances; the carrier only automates).
 */
export async function recordTracking(
  orderId: string,
  sellerId: string,
  input: RecordTrackingInput,
): Promise<{ order: OrderRow; trackerRegistered: boolean; note?: string }> {
  const order = await partyOrder(orderId, sellerId, "seller");

  let trackerId: string | null = null;
  let trackerRegistered = false;
  let note: string | undefined;
  try {
    const tracker = await createEasyPostTracker(input.carrier, input.trackingCode);
    if (tracker) {
      trackerId = tracker.id;
      trackerRegistered = true;
    }
  } catch (err) {
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'tracker_registration_failed', 'system', NULL, $2, $3::jsonb)`,
      [orderId, (err as Error).message, JSON.stringify({ carrier: input.carrier })],
    );
    note = "Tracking stored, but carrier tracker registration failed — retry with a corrected record_tracking call.";
  }

  const sets = {
    carrier: input.carrier,
    tracking_code: input.trackingCode,
    ...(trackerId ? { tracker_id: trackerId } : {}),
    ...(input.labelUrl ? { label_url: input.labelUrl } : {}),
  };

  if (order.status === "label_issued") {
    // #23 — correction, not a transition (§2.3): replace tracking fields
    // while still pre-transit and log it; never move the state machine.
    const { rows } = await pool.query<OrderRow>(
      `UPDATE orders SET carrier = $2, tracking_code = $3,
         tracker_id = $4, label_url = COALESCE($5, label_url), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, input.carrier, input.trackingCode, trackerId, input.labelUrl ?? null],
    );
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, actor_id, reason, payload)
       VALUES ($1, 'tracking_corrected', 'label_issued', 'label_issued', 'seller', $2, 'record_tracking #23', $3::jsonb)`,
      [orderId, sellerId, JSON.stringify({ carrier: input.carrier, tracking_code: input.trackingCode })],
    );
    return { order: rows[0], trackerRegistered, note };
  }

  if (order.fulfillment !== "shipping") {
    throw new OrderFlowError(
      "fulfillment_mismatch",
      "This is a local-pickup order — there is nothing to ship. Use confirm_receipt when the buyer collects.",
    );
  }
  try {
    const next = await applyTransition({
      orderId,
      trigger: "record_tracking",
      actor: { type: "seller", id: sellerId },
      reason: `carrier ${input.carrier}, code ${input.trackingCode}`,
      sets,
    });
    return { order: next, trackerRegistered, note };
  } catch (err) {
    return rethrow(err);
  }
}

/** Seller confirms an off-platform payment (#24, rev 3 §11.2) — pending → sold. */
export async function confirmPayment(orderId: string, sellerId: string, note?: string): Promise<OrderRow> {
  await partyOrder(orderId, sellerId, "seller");
  try {
    return await applyTransition({
      orderId,
      trigger: "confirm_payment",
      actor: { type: "seller", id: sellerId },
      reason: note?.slice(0, 500),
    });
  } catch (err) {
    return rethrow(err);
  }
}

/**
 * Buyer confirms receipt (#6 pickup: sold → delivered; #13 early confirm:
 * in_transit → delivered). Opens the dispute window (§4.4:
 * DISPUTE_WINDOW_HOURS, default 48h) in the same transition.
 */
export async function confirmReceipt(orderId: string, buyerId: string): Promise<OrderRow> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  const cfg = orderFlowConfig();
  if (order.status === "sold" && order.fulfillment !== "pickup") {
    throw new OrderFlowError(
      "fulfillment_mismatch",
      "This item ships — the seller records tracking first; you confirm receipt after it arrives.",
    );
  }
  const disputeDeadline = new Date(Date.now() + cfg.disputeWindowHours * 3600_000);
  try {
    return await applyTransition({
      orderId,
      trigger: "confirm_receipt",
      actor: { type: "buyer", id: buyerId },
      sets: { dispute_deadline: disputeDeadline },
    });
  } catch (err) {
    return rethrow(err);
  }
}

/** Buyer opens a dispute (#15) — delivered → disputed, within the dispute window. */
export async function openDispute(orderId: string, buyerId: string, reason: string): Promise<OrderRow> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  if (order.dispute_deadline && new Date(order.dispute_deadline).getTime() < Date.now()) {
    throw new OrderFlowError(
      "dispute_window_closed",
      "The dispute window has closed. Contact the deployment operator if you believe this is in error.",
    );
  }
  try {
    return await applyTransition({
      orderId,
      trigger: "open_dispute",
      actor: { type: "buyer", id: buyerId },
      reason: reason.slice(0, 1000),
    });
  } catch (err) {
    return rethrow(err);
  }
}

export interface ReleaseResult {
  order: OrderRow;
  note?: string;
}

/**
 * Buyer releases funds early (#17 stripe → payout_pending, #17b off_platform
 * → completed) — waives the remaining dispute window. Stripe mode then moves
 * the money: transfers.create under payout:{order_id} (F3; a replayed or
 * retried release can never produce a second transfer). A Stripe failure
 * after the transition leaves payout_pending without a transfer_id — the
 * PR-8 sweep reconciles with the same idempotency key; never retried blind.
 */
export async function releaseFunds(orderId: string, buyerId: string): Promise<ReleaseResult> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  if (order.payment_mode === "off_platform") {
    try {
      const next = await applyTransition({
        orderId,
        trigger: "release_funds",
        actor: { type: "buyer", id: buyerId },
        reason: "buyer released — off_platform",
      });
      return { order: next, note: "Deal completed — thank you." };
    } catch (err) {
      return rethrow(err);
    }
  }

  const stripe = getStripe();
  if (!stripe) throw new OrderFlowError("payments_not_configured", "Stripe payments are not configured on this deployment.");
  const dest = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [order.seller_id],
  );
  const destination = dest.rows[0]?.stripe_account_id;
  if (!destination) {
    throw new OrderFlowError("inconsistent_state", "Seller payout account missing; refusing to release.");
  }

  const next = await applyTransition({
    orderId,
    trigger: "release_funds",
    actor: { type: "buyer", id: buyerId },
    reason: "buyer released — payout initiated",
  });

  try {
    const transfer = await createTransferForOrder(order, destination, stripe);
    const { rows } = await pool.query<OrderRow>(
      "UPDATE orders SET transfer_id = $2 WHERE id = $1 RETURNING *",
      [orderId, transfer.id],
    );
    return { order: rows[0] };
  } catch (err) {
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'payout_attempt_failed', 'system', NULL, $2, '{}'::jsonb)`,
      [orderId, (err as Error).message.slice(0, 500)],
    );
    return {
      order: next,
      note: "Funds released; the payout call failed and will be retried automatically — no action needed.",
    };
  }
}
