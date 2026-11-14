// Notification fan-out sweep (THI-760 plan Phase 1 / THI-763, PR 3; plan
// §2.1/§4 sweep 1). Derives in-app notifications + email-outbox rows from the
// append-only order_events audit log via a persisted watermark — the order
// state machine (src/orders.ts) is untouched, and every INSERT is
// ON CONFLICT (dedupe_key) DO NOTHING, so replays are no-ops: idempotent and
// crash-safe by construction (webhook-idempotency lens). Single-instance
// in-process posture, same as orders-sweep.ts: boot run + setInterval,
// unref'd; the watermark row is SELECT … FOR UPDATE'd inside the fan-out
// transaction, so even two app instances cannot double-advance it.
//
// Phase-1 channel scope (plan §1): every taxonomy row lands in-app; email
// rows land too EXCEPT in-transit intermediate scans (buyer.in_transit is
// in-app only). Non-transition event rows (tracking_corrected, raw
// carrier/stripe bookkeeping, operator_alert) carry no user-facing news in
// Phase 1 and are skipped.

import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { notifyConfig, orderFlowConfig, type NotifyConfig, type OrderFlowConfig } from "../config.js";
import { renderOrderEmail } from "./templates.js";

const WATERMARK = "order-events";
/** Late-committing transactions (created_at = tx BEGIN time) can commit rows
 *  behind the watermark; re-reading this overlap keeps them in play while the
 *  dedupe keys absorb the replay. 5 min ≫ any order transaction's lifetime. */
const OVERLAP_MS = 5 * 60_000;
export const BATCH_LIMIT = 200;
/** Plan §1.1 row 2: remind ~4h before the payment deadline, once per order. */
const REMINDER_LEAD_MS = 4 * 3_600_000;

export interface OrderEventRow {
  id: string;
  order_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  reason: string | null;
  created_at: Date;
  // joined from orders + items (payload stays PII-free: F6)
  buyer_id: string;
  seller_id: string;
  item_id: string;
  item_title: string;
  price_cents: number;
  shipping_price_cents: number;
  currency: string;
  payment_mode: string;
  payment_deadline: Date | null;
  tracking_code: string | null;
  carrier: string | null;
}

export interface PlannedNotification {
  /** `{role}.{event}` — the outbox template key is `${eventType}.v1`. */
  eventType: string;
  role: "buyer" | "seller";
  recipientId: string;
  /** E channel per plan §1 (false = in-app only). */
  email: boolean;
  payload: Record<string, unknown>;
}

function basePayload(e: OrderEventRow): Record<string, unknown> {
  return {
    order_id: e.order_id,
    item_id: e.item_id,
    item_title: e.item_title,
    amount_cents: e.price_cents + e.shipping_price_cents,
    currency: e.currency,
    order_status: e.to_status,
    ...(e.tracking_code ? { tracking_code: e.tracking_code } : {}),
    ...(e.carrier ? { carrier: e.carrier } : {}),
  };
}

function buyerNotif(e: OrderEventRow, eventType: string, email: boolean, extra?: Record<string, unknown>): PlannedNotification {
  return { eventType, role: "buyer", recipientId: e.buyer_id, email, payload: { ...basePayload(e), ...extra } };
}
function sellerNotif(e: OrderEventRow, eventType: string, extra?: Record<string, unknown>): PlannedNotification {
  return { eventType, role: "seller", recipientId: e.seller_id, email: true, payload: { ...basePayload(e), ...extra } };
}

/**
 * Pure mapping: one order_events row → the plan §1 notifications it implies.
 * Transition events are classified by (from_status, to_status, actor_type) —
 * the trigger itself is not stored on the row, but every ambiguous pair is
 * disambiguated by actor, and every outcome maps to exactly the taxonomy
 * rows the board approved. Non-transition rows return [] in Phase 1.
 */
export function mapOrderEvent(
  e: OrderEventRow,
  flowCfg: Pick<OrderFlowConfig, "disputeWindowHours">,
): PlannedNotification[] {
  if (e.event_type !== "transition" || !e.to_status) return [];
  const deadline = e.payment_deadline ? new Date(e.payment_deadline).toISOString() : undefined;
  switch (e.to_status) {
    case "pending": // #1 create_order
      return [
        buyerNotif(e, "buyer.order_placed", true, deadline ? { payment_deadline: deadline } : {}),
        ...(e.payment_mode === "off_platform" ? [sellerNotif(e, "seller.off_platform_order")] : []),
      ];
    case "sold": // #2 stripe_payment / #24 confirm_payment
      return e.from_status === "pending"
        ? [buyerNotif(e, "buyer.payment_received", true), sellerNotif(e, "seller.item_sold")]
        : []; // #22r restore into 'sold' — news was the dispute outcome, not the restore
    case "cancelled":
      if (e.from_status === "pending") {
        // #4 payment_expired (system) vs #3 buyer/seller cancel
        if (e.actor_type === "system") return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "payment_deadline_passed" })];
        if (e.actor_type === "buyer")
          return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "you_cancelled" }), sellerNotif(e, "seller.order_cancelled_by_buyer", { reason: "buyer_cancelled" })];
        return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "seller_cancelled" })];
      }
      if (e.from_status === "disputed") {
        // #18b/#18c dispute resolved against the sale
        return [
          buyerNotif(e, "buyer.dispute_outcome", true, { reason: "dispute_refund", outcome: "cancelled" }),
          sellerNotif(e, "seller.dispute_resolved", { outcome: "cancelled" }),
        ];
      }
      // #8b/#11b (off-platform cancels) / #9b/#14b(d) (system: never-shipped,
      // carrier failure, stuck transit — off-platform arms end in cancelled).
      if (e.actor_type === "buyer")
        return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "you_cancelled" }), sellerNotif(e, "seller.order_cancelled_by_buyer", { reason: "buyer_cancelled" })];
      if (e.actor_type === "seller") return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "seller_cancelled" })];
      return [buyerNotif(e, "buyer.order_cancelled", true, { reason: "not_shipped_or_transit_issue" })];
    case "label_issued": // #5/#5b shipped (from sold) — #22r restore is silent
      return e.from_status === "sold" ? [buyerNotif(e, "buyer.item_shipped", true)] : [];
    case "in_transit": // #10 — in-app ONLY (plan §1.1: email = noise)
      return e.from_status === "label_issued" ? [buyerNotif(e, "buyer.in_transit", false)] : [];
    case "delivered": // #6/#7/#12/#13
      return ["sold", "in_transit"].includes(e.from_status ?? "")
        ? [buyerNotif(e, "buyer.order_delivered", true, { dispute_window_hours: flowCfg.disputeWindowHours })]
        : []; // #22r restore
    case "disputed": // #15 buyer dispute vs #22 chargeback (stripe actor)
      return e.actor_type === "stripe"
        ? [sellerNotif(e, "seller.chargeback")]
        : [sellerNotif(e, "seller.dispute_opened")];
    case "refunding": // refund initiated — money class
      if (e.from_status === "disputed") {
        // #18 admin_refund / #18a never-shipped autoresolve
        return [
          buyerNotif(e, "buyer.dispute_outcome", true, { reason: "dispute_refund", outcome: "refunded" }),
          sellerNotif(e, "seller.dispute_resolved", { outcome: "refunded" }),
        ];
      }
      if (e.actor_type === "buyer")
        return [buyerNotif(e, "buyer.refund_initiated", true, { reason: "you_requested_refund" }), sellerNotif(e, "seller.order_cancelled_by_buyer", { reason: "buyer_requested_refund" })];
      if (e.actor_type === "seller") return [buyerNotif(e, "buyer.refund_initiated", true, { reason: "seller_initiated_refund" })];
      return [buyerNotif(e, "buyer.refund_initiated", true, { reason: "not_shipped_or_transit_issue" })]; // #9/#14/#14c
    case "refunded": // #21 refund confirmed — money class
      return [buyerNotif(e, "buyer.refund_confirmed", true)];
    case "payout_pending":
    case "completed":
      if (e.from_status === "disputed") {
        // #19/#19b admin release
        return [
          buyerNotif(e, "buyer.dispute_outcome", true, { reason: "dispute_released", outcome: "released_to_seller" }),
          sellerNotif(e, "seller.dispute_resolved", { outcome: "released_to_seller" }),
        ];
      }
      return []; // #16/#16b window elapsed, #17/#17b self release — not in plan §1
    case "paid_out": // #20
      return [sellerNotif(e, "seller.payout_paid")];
    default:
      return [];
  }
}

export interface FanoutReport {
  initialized: boolean;
  eventsProcessed: number;
  notificationsInserted: number;
  outboxInserted: number;
  remindersPlanned: number;
}

/** Insert one notification + (when the E channel applies) its outbox row, on
 *  the caller's transaction. At-most-once via dedupe keys; the outbox email
 *  address is the recipient's address at fan-out time ('' when the account
 *  has none) — the delivery sweep re-checks verification before any send. */
async function insertNotificationAndOutbox(
  db: PoolClient,
  plan: PlannedNotification,
  orderId: string,
  sourceId: string,
  baseUrl: string,
): Promise<boolean> {
  const dedupeKey = `${plan.eventType}:${sourceId}`;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO notifications (recipient_id, order_id, event_type, role, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [plan.recipientId, orderId, plan.eventType, plan.role, JSON.stringify(plan.payload), dedupeKey],
  );
  if (inserted.rows.length === 0) return false; // replayed — already planned
  if (plan.email) {
    const to = await db.query<{ email: string | null }>("SELECT email FROM sellers WHERE id = $1", [plan.recipientId]);
    const subject = renderOrderEmail(plan.eventType, plan.payload, baseUrl).subject;
    await db.query(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [inserted.rows[0].id, to.rows[0]?.email ?? "", subject, `${plan.eventType}.v1`, JSON.stringify(plan.payload), inserted.rows[0].id],
    );
  }
  return true;
}

/**
 * One fan-out pass: payment-deadline reminders (plan §1.1 row 2) + the
 * watermark-driven order_events pass. The event pass runs inside one
 * transaction (watermark row locked), so a crash mid-batch rolls back and the
 * next run replays the same window — dedupe keys make the replay a no-op.
 */
export async function runNotifyFanout(
  flowCfg: OrderFlowConfig = orderFlowConfig(),
  now: Date = new Date(),
  baseUrl: string = notifyConfig().publicBaseUrl,
): Promise<FanoutReport> {
  const report: FanoutReport = {
    initialized: false, eventsProcessed: 0, notificationsInserted: 0, outboxInserted: 0, remindersPlanned: 0,
  };
  const client = await pool.connect();
  try {
    // --- Deadline reminders: pending orders whose deadline lands within the
    // next 4h — dedupe per order (`buyer.payment_deadline_reminder:{order_id}`),
    // so one reminder per order ever, not per sweep.
    await client.query("BEGIN");
    const due = await client.query(
      `SELECT o.id, o.buyer_id, o.payment_deadline, o.price_cents + o.shipping_price_cents AS amount_cents,
              o.currency, o.status AS order_status, i.title AS item_title, i.id AS item_id
         FROM orders o JOIN items i ON i.id = o.item_id
        WHERE o.status = 'pending' AND o.payment_deadline IS NOT NULL
          AND o.payment_deadline > $1 AND o.payment_deadline <= $2`,
      [now, new Date(now.getTime() + REMINDER_LEAD_MS)],
    );
    for (const o of due.rows as Array<{
      id: string; buyer_id: string; payment_deadline: Date; amount_cents: number;
      currency: string; order_status: string; item_title: string; item_id: string;
    }>) {
      const payload = {
        order_id: o.id, item_id: o.item_id, item_title: o.item_title, amount_cents: o.amount_cents,
        currency: o.currency, order_status: o.order_status,
        payment_deadline: new Date(o.payment_deadline).toISOString(),
      };
      const ok = await insertNotificationAndOutbox(
        client,
        { eventType: "buyer.payment_deadline_reminder", role: "buyer", recipientId: o.buyer_id, email: true, payload },
        o.id,
        o.id, // dedupe per ORDER (plan §1.1 "dedupe per order")
        baseUrl,
      );
      if (ok) report.remindersPlanned++;
    }
    await client.query("COMMIT");

    // --- Event fan-out with watermark.
    await client.query("BEGIN");
    const wm = await client.query<{ last_event_id: string | null; last_event_at: Date | null }>(
      "SELECT last_event_id, last_event_at FROM notify_watermarks WHERE name = $1 FOR UPDATE",
      [WATERMARK],
    );
    if (wm.rows.length === 0) {
      // Clean cutover: first-ever run snapshots the stream head WITHOUT
      // notifying on history (plan rollout: notifications start going forward).
      await client.query(
        "INSERT INTO notify_watermarks (name, last_event_id, last_event_at) VALUES ($1, NULL, $2)",
        [WATERMARK, now],
      );
      await client.query("COMMIT");
      report.initialized = true;
      return report;
    }
    const lastAt = wm.rows[0].last_event_at ? new Date(wm.rows[0].last_event_at) : null;
    const since = lastAt ? new Date(lastAt.getTime() - OVERLAP_MS) : new Date(0);
    const events = await client.query<OrderEventRow>(
      `SELECT e.id, e.order_id, e.event_type, e.from_status, e.to_status, e.actor_type, e.reason, e.created_at,
              o.buyer_id, o.seller_id, o.item_id, i.title AS item_title,
              o.price_cents, o.shipping_price_cents, o.currency, o.payment_mode, o.payment_deadline,
              o.tracking_code, o.carrier
         FROM order_events e
         JOIN orders o ON o.id = e.order_id
         JOIN items i ON i.id = o.item_id
        WHERE e.created_at > $1
        ORDER BY e.created_at ASC
        LIMIT $2`,
      [since, BATCH_LIMIT],
    );
    for (const e of events.rows) {
      report.eventsProcessed++;
      for (const plan of mapOrderEvent(e, flowCfg)) {
        if (await insertNotificationAndOutbox(client, plan, e.order_id, e.id, baseUrl)) {
          report.notificationsInserted++;
        }
      }
    }
    const last = events.rows.at(-1);
    if (last) {
      await client.query(
        "UPDATE notify_watermarks SET last_event_id = $2, last_event_at = $3, updated_at = now() WHERE name = $1",
        [WATERMARK, last.id, last.created_at],
      );
    }
    await client.query("COMMIT");
    return report;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Boot run + interval (plan §4) — same posture as orders-sweep.ts:
 *  re-entrant-safe, timer unref'd. */
export function startNotifyFanoutTimer(cfg: NotifyConfig = notifyConfig()): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runNotifyFanout(orderFlowConfig(), new Date(), cfg.publicBaseUrl);
      if (r.eventsProcessed > 0 || r.initialized || r.remindersPlanned > 0) {
        console.log(`[notify-fanout] ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error("[notify-fanout] sweep failed:", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), cfg.sweepIntervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
