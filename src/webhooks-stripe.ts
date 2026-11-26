// Stripe webhook endpoint (spec THI-3 rev 2 §4.3/§5.4/§6.5; PR-6).
//
// Mount BEFORE the global express.json() (index.ts) — signatures are computed
// over raw bytes, so this router consumes express.raw({ application/json,
// 512kb }) itself (F12: the 100kb default would 413 on provider payloads
// and cause retry loops).
//
// Protocol (§5.4, webhook idempotency lens):
//   verify → store → process → mark, in that order:
//   1. constructEvent (timing-safe, 5-min tolerance) — tried against each
//      configured secret in a fixed order (THI-1611 A1): platform endpoint
//      secret STRIPE_WEBHOOK_SECRET, then the 'Connected accounts'-scoped
//      STRIPE_CONNECT_WEBHOOK_SECRET, then the STRIPE_*_PREVIOUS rotation
//      twins (F13). Bad signature, non-JSON body, empty body → 400, never a
//      crash, never a write (F12).
//   2. Insert into webhook_events (source='stripe', external_id UNIQUE,
//      REDACTED payload, F6) — UNIQUE conflict = already seen → 200, no
//      reprocessing (replay-safe).
//   3. Process transactionally: the transition (conditional UPDATE via the
//      PR-2 core), order_events, column sets, and processed_at commit
//      together. Stale-but-valid transitions (late/duplicate/out-of-order)
//      are NOT errors — 200, no state change; the machine is the arbiter.
//   4. Real failures set process_error and return 500 so Stripe retries.
//
// Acceptance criteria (F5): livemode must match the configured key mode;
// checkout sessions must match the order's stored session id AND
// amount+currency; account.updated only for known connected accounts.

import express, { type Request, type Response, type Router } from "express";
import type Stripe from "stripe";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { orderFlowConfig, type OrderFlowConfig } from "./config.js";
import { getStripe, createRefundForOrder, isNothingDueRefund, chargeTotalCents } from "./stripe.js";
import { planAccountNotification } from "./notify/items.js";
import { planOperatorAlert } from "./notify/operator.js";
import { applyTransition, IllegalTransitionError, type OrderRow, type OrderStatus } from "./orders.js";

/** Spec §6.5 acceptance failure (F5): stored + logged, NO state change, 2xx —
 *  retrying a config mismatch would only produce the same rejection. */
export class WebhookRejectError extends Error {}

export function stripeWebhookRouter(cfg: OrderFlowConfig = orderFlowConfig()): Router {
  const router = express.Router();
  router.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "512kb" }),
    (req, res) => {
      void handleStripeWebhook(req, res, cfg);
    },
  );
  return router;
}

async function handleStripeWebhook(req: Request, res: Response, cfg: OrderFlowConfig): Promise<void> {
  // THI-64 V1 fix: this handler is void-mounted, so a rejection escaping the
  // body would be an unhandled rejection — Node >= 15 crashes the whole
  // process (THI-58 class) on any DB fault during a Stripe delivery. One
  // barrier around the entire body: log, best-effort mark, 500 (Stripe
  // redelivers). `ingest failed:` marks the row for sweep rule 6 (PR-8) so a
  // stored-but-unprocessed row is never swallowed by the dedupe path.
  let eventId: string | null = null;
  try {
    await ingestStripeWebhook(req, res, cfg, (id) => (eventId = id));
  } catch (err) {
    console.error("[webhooks:stripe] ingest failed:", (err as Error).message);
    if (eventId) {
      await pool
        .query(
          "UPDATE webhook_events SET process_error = $2 WHERE source = 'stripe' AND external_id = $1 AND processed_at IS NULL",
          [eventId, `ingest failed: ${(err as Error).message}`.slice(0, 500)],
        )
        .catch(() => undefined);
    }
    if (!res.headersSent) res.status(500).json({ error: "processing failed" });
  }
}

async function ingestStripeWebhook(
  req: Request,
  res: Response,
  cfg: OrderFlowConfig,
  onEventId: (id: string) => void,
): Promise<void> {
  if (!cfg.stripeWebhookReady) {
    // Fail-closed 503 stub (F1): key set but webhook secret unset.
    res.status(503).json({ error: "stripe webhook not configured" });
    return;
  }

  // F12: non-JSON content-type, empty body → 400 before anything is written.
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json") || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "expected application/json body" });
    return;
  }

  const stripe = getStripe();
  const signature = req.headers["stripe-signature"];
  if (!stripe || typeof signature !== "string") {
    res.status(400).json({ error: "missing or invalid signature header" });
    return;
  }

  // F13 + THI-1611 A1: connected-account events (account.updated — the only
  // writer of sellers.stripe_onboarded_at) arrive from the 'Connected
  // accounts'-scoped endpoint and carry its signing secret. Try each
  // configured secret in a fixed order — platform current, Connect current,
  // then the two _PREVIOUS rotation twins — every attempt is the SDK's
  // timing-safe constructEvent; the first success wins; all-fail → 400 and
  // nothing is written (F12). An unset Connect secret yields exactly the
  // old single-secret behavior (platform current, then platform previous).
  const candidateSecrets = (
    [
      ["STRIPE_WEBHOOK_SECRET", cfg.stripeWebhookSecret],
      ["STRIPE_CONNECT_WEBHOOK_SECRET", cfg.stripeConnectWebhookSecret],
      ["STRIPE_WEBHOOK_SECRET_PREVIOUS", cfg.stripeWebhookSecretPrevious],
      ["STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS", cfg.stripeConnectWebhookSecretPrevious],
    ] as Array<[name: string, secret: string | undefined]>
  ).filter((entry): entry is [string, string] => entry[1] !== undefined);

  let event: Stripe.Event | null = null;
  for (const [name, secret] of candidateSecrets) {
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
      if (name.endsWith("_PREVIOUS")) {
        console.warn(`[webhooks:stripe] verified with ${name} — finish the rotation`);
      }
      break;
    } catch {
      /* try the next configured secret; all-fail → 400 below */
    }
  }

  if (!event) {
    res.status(400).json({ error: "signature verification failed" });
    return;
  }

  // F6: REDACT at ingest — event id, type, mode, and the object ids handlers
  // need. customer_details, addresses, names never touch the store.
  onEventId(event.id);
  const payload = {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    object_id: (event.data.object as { id?: string }).id ?? null,
    object_type: event.data.object.object,
  };

  // F5 acceptance: a test-mode event must never touch live orders (§6.7).
  if (event.livemode !== (cfg.stripeMode === "live")) {
    await pool.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error)
       VALUES ('stripe', $1, $2::jsonb, $3) ON CONFLICT (source, external_id) DO NOTHING`,
      [event.id, JSON.stringify(payload), "rejected: livemode mismatch"],
    );
    res.status(200).json({ received: true, rejected: "livemode mismatch" });
    return;
  }

  // Verify → store: UNIQUE conflict means already seen → 200, no reprocessing.
  const stored = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (source, external_id, payload)
     VALUES ('stripe', $1, $2::jsonb) ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
    [event.id, JSON.stringify(payload)],
  );
  const storedId = stored.rows[0]?.id;
  if (!storedId) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      await processStripeEvent(event, db, cfg);
      await db.query("UPDATE webhook_events SET processed_at = now() WHERE id = $1", [storedId]);
      await db.query("COMMIT");
      res.status(200).json({ received: true });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        // Stale-but-valid (§5.4 rule 4): late or out-of-order — not an error.
        await db.query("UPDATE webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1", [
          storedId,
          `stale: ${err.message}`.slice(0, 500),
        ]);
        await db.query("COMMIT");
        res.status(200).json({ received: true, stale: true });
        return;
      }
      if (err instanceof WebhookRejectError) {
        await db.query("UPDATE webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1", [
          storedId,
          `rejected: ${err.message}`.slice(0, 500),
        ]);
        await db.query("COMMIT");
        res.status(200).json({ received: true, rejected: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    // Retry-safe: record the failure so sweep rule 6 can reprocess (PR-8);
    // 500 tells Stripe to redeliver.
    await pool
      .query("UPDATE webhook_events SET process_error = $2 WHERE id = $1", [storedId, (err as Error).message.slice(0, 500)])
      .catch(() => undefined);
    res.status(500).json({ error: "processing failed" });
  } finally {
    db.release();
  }
}

// ---------------------------------------------------------------------------
// Event handlers

async function orderBySession(db: PoolClient, sessionId: string): Promise<OrderRow | undefined> {
  const { rows } = await db.query<OrderRow>("SELECT * FROM orders WHERE checkout_session_id = $1", [sessionId]);
  return rows[0];
}

async function orderByPaymentIntent(db: PoolClient, paymentIntentId: string): Promise<OrderRow | undefined> {
  const { rows } = await db.query<OrderRow>("SELECT * FROM orders WHERE payment_intent_id = $1", [paymentIntentId]);
  return rows[0];
}

/**
 * checkout.session.completed / payment_intent.succeeded: pending → sold (#2).
 * On a cancelled order this is NEVER a no-op (F2): full auto-refund under
 * refund:{order_id} idempotency + an unexpected_payment operator alert.
 */
async function handlePaymentSuccess(db: PoolClient, event: Stripe.Event, cfg: OrderFlowConfig, session?: Stripe.Checkout.Session): Promise<void> {
  const paymentIntentId =
    session?.payment_intent ?? ((event.data.object as Stripe.PaymentIntent).id as string | undefined);
  if (!paymentIntentId) return;

  let order = session ? await orderBySession(db, session.id) : undefined;
  if (!order && paymentIntentId) order = await orderByPaymentIntent(db, String(paymentIntentId));
  if (!order) return; // not our session — stored, logged, nothing to do

  if (session) {
    // F5 defense in depth: the session must match the order's stored
    // checkout_session_id (checked by resolution) AND the amount+currency.
    // chargeTotalCents (§3): flat orders price+shipping, quote-mode orders
    // price+label — the exact figure the Checkout lines were built from.
    const sessionAmount = (session as unknown as { amount_total?: number }).amount_total;
    const sessionCurrency = (session as unknown as { currency?: string }).currency;
    if (sessionAmount !== chargeTotalCents(order) || sessionCurrency !== order.currency.toLowerCase()) {
      throw new WebhookRejectError(
        `session amount/currency mismatch: expected ${chargeTotalCents(order)} ${order.currency}, got ${sessionAmount} ${sessionCurrency}`,
      );
    }
  }

  if (order.status === "pending") {
    await applyTransition({
      orderId: order.id,
      trigger: "stripe_payment",
      actor: { type: "stripe", id: event.id },
      reason: `paid (${event.type})`,
      sets: { payment_intent_id: String(paymentIntentId) },
      client: db,
    });
    return;
  }

  if (order.status === "cancelled" && !order.refund_id) {
    // F2: late payment on a cancelled order — refund, never strand money.
    // §6 policy include_label: this order was cancelled from `pending` —
    // no label can have been bought, so the full charge (label line
    // included) goes back to the buyer.
    const stripe = getStripe();
    if (!stripe) throw new Error("stripe unavailable for unexpected-payment refund");
    const refund = await createRefundForOrder(order, String(paymentIntentId), stripe, "include_label");
    // B1 (THI-1013): a nothing-due remainder (another site already returned
    // the full charge) settles with no new refund — the event records the
    // outcome; writing a null refund_id onto the row would be a no-op anyway.
    const nothingDue = isNothingDueRefund(refund);
    if (refund.id) {
      await db.query("UPDATE orders SET refund_id = $2 WHERE id = $1", [order.id, refund.id]);
    }
    await db.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'unexpected_payment', 'stripe', $2, 'auto-refund on cancelled order', $3::jsonb)`,
      [order.id, event.id, JSON.stringify({ refund_id: refund.id, nothing_due: nothingDue })],
    );
    console.error(
      nothingDue
        ? `[webhooks:stripe] operator alert: unexpected payment on cancelled order ${order.id} — nothing due (charge already returned), no new refund`
        : `[webhooks:stripe] operator alert: unexpected payment on cancelled order ${order.id} — auto-refunded ${refund.id}`,
    );
    return;
  }

  // sold (replay across types), refunding, disputed… — the machine already
  // recorded the state; nothing to do.
}

// Exported for sweep rule 6 reprocessing (§4.5): re-fetches the event by id
// from the Stripe API (the stored payload is redacted, F6) and re-applies it.
export async function processStripeEvent(event: Stripe.Event, db: PoolClient, cfg: OrderFlowConfig): Promise<void> {
  // SDK v23's event union predates/omits some transfer event names — the
  // spec names transfer.paid; Stripe's API emits transfer.created/updated
  // when funds land. All three map to #20; the transition is the arbiter.
  const type = event.type as string;
  const object = event.data.object as unknown as Record<string, unknown>;
  switch (type) {
    case "checkout.session.completed": {
      const session = event.data.object as unknown as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") return; // F5: processing ≠ paid
      await handlePaymentSuccess(db, event, cfg, session);
      return;
    }
    case "payment_intent.succeeded": {
      await handlePaymentSuccess(db, event, cfg);
      return;
    }
    case "charge.refunded": {
      // The event object is the Charge; the Refund rides in charge.refunds.
      const charge = object as unknown as Stripe.Charge & { refunds?: { data?: Array<{ id?: string }> } };
      const refundId = charge.refunds?.data?.[0]?.id ?? null;
      const paymentIntentId = (charge.payment_intent as string | null) ?? null;
      const { rows } = await db.query<OrderRow>(
        "SELECT * FROM orders WHERE refund_id = $1 OR payment_intent_id = $2",
        [refundId, paymentIntentId],
      );
      const order = rows[0];
      if (!order) return;
      await applyTransition({
        orderId: order.id,
        trigger: "refund_confirmed",
        actor: { type: "stripe", id: event.id },
        ...(order.refund_id || !refundId ? {} : { sets: { refund_id: refundId } }),
        client: db,
      });
      return;
    }
    case "transfer.paid":
    case "transfer.created":
    case "transfer.updated": {
      const transfer = object as unknown as Stripe.Transfer;
      const { rows } = await db.query<OrderRow>("SELECT * FROM orders WHERE transfer_id = $1", [transfer.id]);
      if (!rows[0]) return;
      await applyTransition({
        orderId: rows[0].id,
        trigger: "transfer_paid",
        actor: { type: "stripe", id: event.id },
        client: db,
      });
      return;
    }
    case "account.updated": {
      const account = object as unknown as Stripe.Account & { capabilities?: { transfers?: string } };
      const transfers = account.capabilities?.transfers === "active";
      // F5: known connected accounts only — unknown ids change nothing.
      // THI-780 PR 3: badge the seller exactly once per Stripe account on the
      // NULL→set flip (plan §5): re-off cycles never re-badge, and the
      // notification is idempotent under webhook redelivery.
      const flipped = await db.query<{ id: string; email: string | null }>(
        `UPDATE sellers SET stripe_onboarded_at = $2
          WHERE stripe_account_id = $1 AND $2::timestamptz IS NOT NULL AND stripe_onboarded_at IS NULL
          RETURNING id, email`,
        [account.id, transfers ? new Date() : null],
      );
      if (!transfers) {
        await db.query(
          "UPDATE sellers SET stripe_onboarded_at = NULL WHERE stripe_account_id = $1",
          [account.id],
        );
        return;
      }
      if (flipped.rows[0]) {
        await planAccountNotification({
          recipientId: flipped.rows[0].id,
          toEmail: flipped.rows[0].email,
          eventType: "seller.payouts_enabled",
          role: "seller",
          subject: "Payouts enabled — Thingery",
          payload: {},
          dedupeKey: `payouts_enabled:${account.id}`,
          client: db,
        });
      }
      return;
    }
    case "charge.dispute.created": {
      const dispute = object as unknown as Stripe.Dispute;
      const { rows } = await db.query<OrderRow>(
        "SELECT * FROM orders WHERE payment_intent_id = $1",
        [dispute.payment_intent as string | null],
      );
      if (!rows[0]) return;
      await applyTransition({
        orderId: rows[0].id,
        trigger: "chargeback",
        actor: { type: "stripe", id: event.id },
        reason: `dispute ${dispute.id} (${dispute.reason ?? "unspecified"})`,
        client: db,
      });
      return;
    }
    case "charge.dispute.closed": {
      const dispute = object as unknown as Stripe.Dispute;
      if (dispute.status !== "won") {
        // A2 (THI-1611): a lost / charge_refunded closure is the buyer winning
        // the chargeback — Stripe has refunded (or is refunding) the charge, so
        // the refund path does NOT own this unwind. The verdict itself must
        // terminalize the order (see handleDisputeLost). warning closures
        // (never a dispute on Stripe's books) stay stored no-ops.
        if (dispute.status === "lost" || dispute.status === "charge_refunded") {
          await handleDisputeLost(db, event, dispute);
        }
        return;
      }
      const { rows } = await db.query<OrderRow>(
        "SELECT * FROM orders WHERE payment_intent_id = $1",
        [dispute.payment_intent as string | null],
      );
      const order = rows[0];
      if (!order || order.status !== "disputed") return;
      // Restore the recorded pre-dispute state (§2.3 #22 note): the #22
      // transition event carries from_status; pending chargebacks restore
      // to sold (the charge completing is what made it disputable).
      const origin = await db.query<{ from_status: string }>(
        `SELECT from_status FROM order_events
         WHERE order_id = $1 AND event_type = 'transition' AND to_status = 'disputed'
         ORDER BY created_at DESC LIMIT 1`,
        [order.id],
      );
      const from = origin.rows[0]?.from_status as OrderStatus | undefined;
      if (!from) return;
      const target = from === "pending" ? "sold" : from;
      await applyTransition({
        orderId: order.id,
        trigger: "dispute_won",
        actor: { type: "stripe", id: event.id },
        reason: `dispute ${dispute.id} won — restoring ${target}`,
        restoreTo: target,
        client: db,
      });
      return;
    }
    default:
      // Unhandled types are stored (redacted) and acknowledged — providers
      // retry anything that isn't a 2xx.
      return;
  }
}

/**
 * A2 (THI-1611): charge.dispute.closed with status `lost` / `charge_refunded`
 * — the buyer won the chargeback and Stripe returns the money. The order goes
 * to the `refunded` terminal (#22l) the moment the verdict lands: admin
 * release (#19) and the payout sweep become impossible on it, the item frees
 * for relist (same rationale as #18), the refund id is recorded when Stripe
 * provides one, and the operator is alerted. An in-flight transfer (the
 * verdict can land after #19 release or #16 window elapsed moved the order to
 * payout_pending) is reversed best-effort with a durable outcome record — a
 * failed reversal is tracked debt for the A4 retry/reconcile machinery, never
 * a reason to keep the order releasable. Stale verdicts (already terminal, or
 * refunding — the refund path owns those) surface as IllegalTransitionError →
 * §5.4 stale, 200.
 */
async function handleDisputeLost(db: PoolClient, event: Stripe.Event, dispute: Stripe.Dispute): Promise<void> {
  const { rows } = await db.query<OrderRow>(
    "SELECT * FROM orders WHERE payment_intent_id = $1",
    [dispute.payment_intent as string | null],
  );
  const order = rows[0];
  if (!order) return; // not our charge — stored, logged, nothing to do
  const refundId = await lostDisputeRefundId(dispute);
  await applyTransition({
    orderId: order.id,
    trigger: "dispute_lost",
    actor: { type: "stripe", id: event.id },
    reason: `dispute ${dispute.id} ${dispute.status} — terminal refund, release refused`,
    ...(refundId ? { sets: { refund_id: refundId } } : {}),
    client: db,
  });
  if (order.transfer_id) await reverseInFlightTransfer(db, event, dispute, order);
  console.error(
    `[webhooks:stripe] operator alert: order ${order.id} — dispute ${dispute.id} ${dispute.status}; ` +
      `refunded terminal, release refused${order.transfer_id ? ` (transfer ${order.transfer_id} reversal recorded)` : ""}`,
  );
  await planOperatorAlert({
    kind: "dispute_lost",
    ref: order.id,
    subject: `Chargeback lost: order ${order.id} refunded, release refused — Thingery`,
    payload: {
      title: `Chargeback lost (${dispute.status}): order ${order.id} → refunded`,
      lines: [
        `Order: ${order.id}`,
        `Dispute: ${dispute.id} (${dispute.status})`,
        `Refund: ${refundId ?? "by Stripe (auto)"}`,
        ...(order.transfer_id ? [`Transfer ${order.transfer_id}: reversal attempted — see order events if it failed`] : []),
        "Action: none, unless a transfer_reversal_failed event follows",
      ],
    },
    client: db,
  });
}

/** Best-effort: the dispute object carries no refund id — the auto-refund
 * rides on the charge. Any failure keeps the verdict authoritative: the
 * order still terminalizes (#22l), only the id stays unset. */
async function lostDisputeRefundId(dispute: Stripe.Dispute): Promise<string | null> {
  const stripe = getStripe();
  const charge = dispute.charge;
  const chargeId = typeof charge === "string" ? charge : (charge?.id ?? null);
  if (!stripe || !chargeId) return null;
  try {
    const full = await stripe.charges.retrieve(chargeId);
    return full.refunds?.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** The race arm: the lost verdict can land while a payout is already in
 * flight (#19 release / #16 window elapsed precede it). Reverse the transfer
 * (idempotency key `reversal:{order_id}` — shared with the admin refund
 * path, so at most one reversal per order exists at Stripe) and record the
 * outcome durably; a failure alerts and is retried by the A4 machinery. */
async function reverseInFlightTransfer(
  db: PoolClient,
  event: Stripe.Event,
  dispute: Stripe.Dispute,
  order: OrderRow,
): Promise<void> {
  const transferId = order.transfer_id;
  const stripe = getStripe();
  if (!stripe || !transferId) return;
  try {
    const reversal = await stripe.transfers.createReversal(transferId, {}, { idempotencyKey: `reversal:${order.id}` });
    await db.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload, dedupe_key)
       VALUES ($1, 'transfer_reversed', 'stripe', $2, 'dispute lost — in-flight transfer reversed', $3::jsonb, $4)`,
      [
        order.id,
        event.id,
        JSON.stringify({ transfer_id: transferId, dispute_id: dispute.id, reversal_id: reversal.id ?? null, amount: reversal.amount ?? null }),
        `dispute_lost_reversal:${order.id}`,
      ],
    );
  } catch (err) {
    // Durable failure record + alert; the terminal order state already
    // blocks release — this is tracked debt, not a lost log line.
    await db
      .query(
        `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload, dedupe_key)
       VALUES ($1, 'transfer_reversal_failed', 'stripe', $2, $3, $4::jsonb, $5)`,
        [
          order.id,
          event.id,
          `dispute lost — transfer ${transferId} reversal failed`,
          JSON.stringify({ transfer_id: transferId, dispute_id: dispute.id, error: (err as Error).message.slice(0, 200) }),
          `dispute_lost_reversal_failed:${order.id}`,
        ],
      )
      .catch(() => undefined);
    console.error(
      `[webhooks:stripe] order ${order.id}: transfer ${transferId} reversal failed after lost dispute ${dispute.id}: ` +
        `${(err as Error).message} — tracked debt, needs operator action`,
    );
  }
}
