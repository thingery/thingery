// Order state machine core (spec THI-3 rev 2 §2 + rev 3 addendum §11.2, THI-10).
//
// Normative transition protocol: every state change is ONE conditional
//   UPDATE orders SET status = $to, status_changed_at = now(), …
//   WHERE id = $id AND status = $expected            (rowcount-checked)
// inside the SAME database transaction as its side effects (item status,
// order_events insert, column updates). Zero rows updated means an illegal
// transition or a racing writer (tool vs sweep vs webhook) won the race —
// the loser is treated exactly like an illegal transition. No transition is
// ever inferred or defaulted; anything not in TRANSITIONS is rejected.
//
// Payment modes (rev 3, OQ4): 'stripe' orders move platform money (the §2
// machine); 'off_platform' orders track an agreement the parties settle
// themselves — every stripe money transition has an off_platform twin that
// ends in the matching terminal ('cancelled' instead of 'refunding',
// 'completed' instead of 'payout_pending').

import type { PoolClient } from "pg";
import { pool } from "./db.js";

export type OrderStatus =
  | "pending"
  | "sold"
  | "label_issued"
  | "in_transit"
  | "delivered"
  | "disputed"
  | "refunding"
  | "refunded"
  | "payout_pending"
  | "paid_out"
  | "cancelled"
  | "completed";

export type PaymentMode = "stripe" | "off_platform";

export type ActorType = "buyer" | "seller" | "system" | "carrier" | "stripe" | "admin";

export type ItemStatus = "active" | "reserved" | "sold" | "deleted";

export type TransitionTrigger =
  | "create_order" // #1
  | "stripe_payment" // #2
  | "confirm_payment" // #24 — off_platform only
  | "cancel_order" // #3/#8/#8b/#11/#11b
  | "payment_expired" // #4
  | "record_tracking" // #5
  | "pickup_autoconfirm" // #7
  | "carrier_update" // #10/#12
  | "carrier_failure" // #14/#14b — lost / return-to-sender
  | "stale_sale" // #9/#9b
  | "stuck_transit" // #14/#14b
  | "confirm_receipt" // #6/#13
  | "open_dispute" // #15
  | "chargeback" // #22 — stripe only
  | "dispute_won" // #22r — chargeback representment won, restore
  | "dispute_window_elapsed" // #16/#16b
  | "release_funds" // #17/#17b
  | "admin_refund" // #18/#18b
  | "admin_release" // #19/#19b
  | "dispute_autoresolve" // #18b — never-shipped automation (rev 3 §11.3)
  | "transfer_paid" // #20
  | "refund_confirmed"; // #21

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending", "sold", "label_issued", "in_transit", "delivered", "disputed",
  "refunding", "refunded", "payout_pending", "paid_out", "cancelled", "completed",
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  "refunded", "paid_out", "cancelled", "completed",
];

const NON_TERMINAL_EXCEPT_REFUNDING: readonly OrderStatus[] = [
  "pending", "sold", "label_issued", "in_transit", "delivered", "disputed", "payout_pending",
];

export interface TransitionSpec {
  /** Spec §2.3 transition number (rev 3 twins carry a letter suffix). */
  id: string;
  from: readonly OrderStatus[];
  /** `"pre_dispute"` (chargeback-won restore, §6.5): the caller supplies the
   *  recorded pre-dispute status via `restoreTo`, validated against
   *  RESTORE_TARGETS — one entry, explicit targets, no dynamic matrix. */
  to: OrderStatus | "pre_dispute";
  trigger: TransitionTrigger;
  actors: readonly ActorType[];
  /** Restricts the transition to one payment mode; omit for both. */
  mode?: PaymentMode;
  /** items.status side effect applied in the same transaction. */
  itemStatus?: ItemStatus;
}

/** Legal chargeback-won restore targets (§6.5): non-terminal, post-charge.
 * A chargeback recorded from `pending` restores to `sold` — the charge
 * completing is what made the order disputable in the first place. */
export const RESTORE_TARGETS: readonly OrderStatus[] = [
  "sold", "label_issued", "in_transit", "delivered", "payout_pending",
];

const BUYER_SELLER: readonly ActorType[] = ["buyer", "seller"];

export const TRANSITIONS: readonly TransitionSpec[] = [
  { id: "1", from: [], to: "pending", trigger: "create_order", actors: ["buyer"], itemStatus: "reserved" },
  { id: "2", from: ["pending"], to: "sold", trigger: "stripe_payment", actors: ["stripe"], mode: "stripe", itemStatus: "sold" },
  { id: "24", from: ["pending"], to: "sold", trigger: "confirm_payment", actors: ["seller"], mode: "off_platform", itemStatus: "sold" },
  { id: "3", from: ["pending"], to: "cancelled", trigger: "cancel_order", actors: BUYER_SELLER, itemStatus: "active" },
  { id: "4", from: ["pending"], to: "cancelled", trigger: "payment_expired", actors: ["system"], itemStatus: "active" },
  { id: "5", from: ["sold"], to: "label_issued", trigger: "record_tracking", actors: ["seller"] },
  { id: "6", from: ["sold"], to: "delivered", trigger: "confirm_receipt", actors: ["buyer"] },
  { id: "7", from: ["sold"], to: "delivered", trigger: "pickup_autoconfirm", actors: ["system"] },
  { id: "8", from: ["sold"], to: "refunding", trigger: "cancel_order", actors: BUYER_SELLER, mode: "stripe", itemStatus: "active" },
  { id: "8b", from: ["sold"], to: "cancelled", trigger: "cancel_order", actors: BUYER_SELLER, mode: "off_platform", itemStatus: "active" },
  { id: "9", from: ["sold"], to: "refunding", trigger: "stale_sale", actors: ["system"], mode: "stripe", itemStatus: "active" },
  { id: "9b", from: ["sold"], to: "cancelled", trigger: "stale_sale", actors: ["system"], mode: "off_platform", itemStatus: "active" },
  { id: "10", from: ["label_issued"], to: "in_transit", trigger: "carrier_update", actors: ["carrier"] },
  { id: "11", from: ["label_issued"], to: "refunding", trigger: "cancel_order", actors: BUYER_SELLER, mode: "stripe", itemStatus: "active" },
  { id: "11b", from: ["label_issued"], to: "cancelled", trigger: "cancel_order", actors: BUYER_SELLER, mode: "off_platform", itemStatus: "active" },
  { id: "12", from: ["in_transit"], to: "delivered", trigger: "carrier_update", actors: ["carrier"] },
  { id: "13", from: ["in_transit"], to: "delivered", trigger: "confirm_receipt", actors: ["buyer"] },
  { id: "14", from: ["in_transit"], to: "refunding", trigger: "carrier_failure", actors: ["carrier", "system"], mode: "stripe", itemStatus: "deleted" },
  { id: "14b", from: ["in_transit"], to: "cancelled", trigger: "carrier_failure", actors: ["carrier", "system"], mode: "off_platform", itemStatus: "deleted" },
  { id: "14c", from: ["in_transit"], to: "refunding", trigger: "stuck_transit", actors: ["system"], mode: "stripe", itemStatus: "active" },
  { id: "14d", from: ["in_transit"], to: "cancelled", trigger: "stuck_transit", actors: ["system"], mode: "off_platform", itemStatus: "active" },
  { id: "15", from: ["delivered"], to: "disputed", trigger: "open_dispute", actors: ["buyer"] },
  { id: "16", from: ["delivered"], to: "payout_pending", trigger: "dispute_window_elapsed", actors: ["system"], mode: "stripe" },
  { id: "16b", from: ["delivered"], to: "completed", trigger: "dispute_window_elapsed", actors: ["system"], mode: "off_platform" },
  { id: "17", from: ["delivered"], to: "payout_pending", trigger: "release_funds", actors: ["buyer"], mode: "stripe" },
  { id: "17b", from: ["delivered"], to: "completed", trigger: "release_funds", actors: ["buyer"], mode: "off_platform" },
  { id: "18", from: ["disputed"], to: "refunding", trigger: "admin_refund", actors: ["admin"], mode: "stripe", itemStatus: "active" },
  // #18a — §11.3 rule 8 stripe arm: disputed with no recorded tracking past
  // DISPUTE_AUTOREFUND_HOURS → full auto-refund (never-shipped; system actor).
  { id: "18a", from: ["disputed"], to: "refunding", trigger: "dispute_autoresolve", actors: ["system", "admin"], mode: "stripe", itemStatus: "active" },
  { id: "18b", from: ["disputed"], to: "cancelled", trigger: "admin_refund", actors: ["admin"], mode: "off_platform", itemStatus: "active" },
  { id: "18c", from: ["disputed"], to: "cancelled", trigger: "dispute_autoresolve", actors: ["system", "admin"], mode: "off_platform", itemStatus: "active" },
  { id: "19", from: ["disputed"], to: "payout_pending", trigger: "admin_release", actors: ["admin"], mode: "stripe" },
  { id: "19b", from: ["disputed"], to: "completed", trigger: "admin_release", actors: ["admin"], mode: "off_platform" },
  { id: "20", from: ["payout_pending"], to: "paid_out", trigger: "transfer_paid", actors: ["stripe"], mode: "stripe" },
  { id: "21", from: ["refunding"], to: "refunded", trigger: "refund_confirmed", actors: ["stripe"], mode: "stripe" },
  // #22: a chargeback disputes from ANY non-terminal state except refunding
  // (a refund already in flight is the correct chargeback remedy — F3).
  { id: "22", from: NON_TERMINAL_EXCEPT_REFUNDING, to: "disputed", trigger: "chargeback", actors: ["stripe"], mode: "stripe" },
  // #22r: representment won (§6.5) — restore the recorded pre-dispute state.
  { id: "22r", from: ["disputed"], to: "pre_dispute", trigger: "dispute_won", actors: ["stripe"], mode: "stripe" },
  // #23 (tracking correction while still pre-transit) is not a state change;
  // PR-5 records it as an order_events row without calling applyTransition.
];

export interface OrderRow {
  id: string;
  item_id: string;
  seller_id: string;
  buyer_id: string;
  status: OrderStatus;
  payment_mode: PaymentMode;
  price_cents: number;
  shipping_price_cents: number;
  currency: string;
  fulfillment: "shipping" | "pickup";
  shipping_address: Record<string, unknown>;
  carrier: string | null;
  tracking_code: string | null;
  tracker_id: string | null;
  label_url: string | null;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  transfer_id: string | null;
  refund_id: string | null;
  payment_deadline: Date | null;
  dispute_deadline: Date | null;
  status_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** Columns applyTransition may set alongside the status change (allowlist). */
export type TransitionSet =
  | "carrier" | "tracking_code" | "tracker_id" | "label_url"
  | "checkout_session_id" | "payment_intent_id" | "transfer_id" | "refund_id"
  | "payment_deadline" | "dispute_deadline" | "shipping_address";

export type TransitionSets = Partial<Record<TransitionSet, string | Date | Record<string, unknown>>>;

export class IllegalTransitionError extends Error {
  readonly code = "invalid_transition";
  constructor(
    readonly orderId: string,
    readonly currentStatus: OrderStatus,
    readonly trigger: TransitionTrigger,
    readonly allowed: string[],
  ) {
    super(
      `invalid_transition: order ${orderId} is ${currentStatus}; ` +
        (allowed.length
          ? `allowed triggers from here: ${allowed.join(", ")}`
          : "no transitions leave this state") +
        ` (requested: ${trigger})`,
    );
    this.name = "IllegalTransitionError";
  }
}

/** All transitions whose `from` includes `status` (and match `mode` when restricted). */
export function transitionsFrom(status: OrderStatus, mode: PaymentMode): readonly TransitionSpec[] {
  return TRANSITIONS.filter((t) => t.from.includes(status) && (t.mode === undefined || t.mode === mode));
}

function findTransition(
  status: OrderStatus,
  trigger: TransitionTrigger,
  mode: PaymentMode,
  actor: ActorType,
): TransitionSpec | undefined {
  return transitionsFrom(status, mode).find(
    (t) => t.trigger === trigger && t.actors.includes(actor),
  );
}

export interface ApplyTransitionInput {
  orderId: string;
  trigger: TransitionTrigger;
  actor: { type: ActorType; id?: string };
  reason?: string;
  /** Idempotency for system/webhook writers: sweep:{rule}:{order_id}, stripe:{event_id}, carrier:{event_id}. */
  dedupeKey?: string;
  /** Extra column updates applied in the same transaction (allowlisted). */
  sets?: TransitionSets;
  /** Overrides the transition's items.status side effect (e.g. #14 lost → deleted vs RTS → active). */
  itemStatusOverride?: ItemStatus;
  /** #22r only: the recorded pre-dispute status to restore (validated against RESTORE_TARGETS). */
  restoreTo?: OrderStatus;
  /** Join a caller-owned transaction (webhook handlers); otherwise a new one is used. */
  client?: PoolClient;
}

/**
 * Applies the one transition named by `trigger` from the order's current
 * status, per the normative protocol. Throws IllegalTransitionError for
 * anything not in TRANSITIONS (including wrong actor or payment mode) and
 * when the conditional UPDATE loses a race. Returns the updated order.
 */
export async function applyTransition(input: ApplyTransitionInput): Promise<OrderRow> {
  const run = async (db: PoolClient, ownTx: boolean): Promise<OrderRow> => {
    // ownTx=false → caller owns the transaction: wrap in a savepoint so a
    // failure here never poisons the caller's transaction.
    const begin = ownTx ? "BEGIN" : "SAVEPOINT order_transition";
    const commit = ownTx ? "COMMIT" : "RELEASE SAVEPOINT order_transition";
    const rollback = ownTx ? "ROLLBACK" : "ROLLBACK TO SAVEPOINT order_transition";

    const current = await db.query<OrderRow>(
      "SELECT * FROM orders WHERE id = $1",
      [input.orderId],
    );
    const order = current.rows[0];
    if (!order) throw new IllegalTransitionError(input.orderId, "pending" as OrderStatus, input.trigger, []);

    const spec = findTransition(order.status, input.trigger, order.payment_mode, input.actor.type);
    if (!spec) {
      const allowed = [...new Set(transitionsFrom(order.status, order.payment_mode).map((t) => t.trigger))];
      throw new IllegalTransitionError(input.orderId, order.status, input.trigger, allowed);
    }

    let target: OrderStatus;
    if (spec.to === "pre_dispute") {
      if (!input.restoreTo || !RESTORE_TARGETS.includes(input.restoreTo)) {
        throw new IllegalTransitionError(input.orderId, order.status, input.trigger, []);
      }
      target = input.restoreTo;
    } else {
      target = spec.to;
    }

    await db.query(begin);
    try {
      const setCols: string[] = ["status = $3", "status_changed_at = now()"];
      const values: unknown[] = [input.orderId, order.status, target];
      let p = 4;
      for (const [col, val] of Object.entries(input.sets ?? {})) {
        setCols.push(`${col} = $${p}`);
        values.push(val);
        p += 1;
      }
      const updated = await db.query<OrderRow>(
        `UPDATE orders SET ${setCols.join(", ")} WHERE id = $1 AND status = $2 RETURNING *`,
        values,
      );
      if (updated.rowCount !== 1) {
        // A racing writer (tool vs sweep vs webhook) moved the row first —
        // the loser is treated exactly like an illegal transition.
        throw new IllegalTransitionError(input.orderId, order.status, input.trigger, []);
      }
      const next = updated.rows[0];

      if (input.itemStatusOverride ?? spec.itemStatus) {
        await db.query("UPDATE items SET status = $2, updated_at = now() WHERE id = $1", [
          order.item_id,
          input.itemStatusOverride ?? spec.itemStatus,
        ]);
      }

      try {
        await db.query(
          `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, actor_id, reason, dedupe_key)
           VALUES ($1, 'transition', $2, $3, $4, $5, $6, $7)`,
          [
            input.orderId, order.status, target, input.actor.type,
            input.actor.id ?? null, input.reason ?? null, input.dedupeKey ?? null,
          ],
        );
      } catch (err) {
        // dedupe_key already used: the transition was applied by a racing
        // writer — roll back and surface the current row, replay-safe.
        if ((err as { code?: string }).code === "23505") {
          await db.query(rollback);
          const r = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [input.orderId]);
          return r.rows[0];
        }
        throw err;
      }

      await db.query(commit);
      return next;
    } catch (err) {
      await db.query(rollback).catch(() => {});
      throw err;
    }
  };

  if (input.client) return run(input.client, false);
  const db = await pool.connect();
  try {
    return await run(db, true);
  } finally {
    db.release();
  }
}
