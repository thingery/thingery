// Stripe webhook endpoint (spec THI-3 rev 2 §4.3/§5.4/§6.5; PR-6).
//
// Mount BEFORE the global express.json() (index.ts) — signatures are computed
// over raw bytes, so this router consumes express.raw({ application/json,
// 512kb }) itself (F12: the 100kb default would 413 on provider payloads
// and cause retry loops).
//
// Protocol (§5.4, webhook idempotency lens):
//   verify → store → process → mark, in that order:
//   1. constructEvent (timing-safe, 5-min tolerance) — current secret, then
//      STRIPE_WEBHOOK_SECRET_PREVIOUS during rotation (F13). Bad signature,
//      non-JSON body, empty body → 400, never a crash, never a write (F12).
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
import { applyTransition, IllegalTransitionError, TERMINAL_STATUSES, type OrderRow, type OrderStatus } from "./orders.js";

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

  // F13: accept the previous secret during rotation.
  let event: Stripe.Event | null = null;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, cfg.stripeWebhookSecret!);
  } catch {
    if (cfg.stripeWebhookSecretPrevious) {
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, cfg.stripeWebhookSecretPrevious);
        console.warn("[webhooks:stripe] verified with STRIPE_WEBHOOK_SECRET_PREVIOUS — finish the rotation");
      } catch {
        /* fall through to 400 */
      }
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
      const order = rows[0];
      if (!order) return;
      // A3 (THI-1611 §A3): on a terminal order #22 has no legal transition —
      // but the event must never drop silently: durable record + operator
      // alert + transfer recovery attempt (handleTerminalOrderDispute).
      if (TERMINAL_STATUSES.includes(order.status)) {
        await handleTerminalOrderDispute(db, order, dispute, event, "created");
        return;
      }
      await applyTransition({
        orderId: order.id,
        trigger: "chargeback",
        actor: { type: "stripe", id: event.id },
        reason: `dispute ${dispute.id} (${dispute.reason ?? "unspecified"})`,
        client: db,
      });
      return;
    }
    case "charge.dispute.closed": {
      const dispute = object as unknown as Stripe.Dispute;
      const { rows } = await db.query<OrderRow>(
        "SELECT * FROM orders WHERE payment_intent_id = $1",
        [dispute.payment_intent as string | null],
      );
      const order = rows[0];
      if (!order) return;
      // A3 (THI-1611 §A3): a closure landing on a terminal order is the same
      // never-silent story as created (alert + recovery; a WON representment
      // skips the reversal — the charge stood, the payout is legitimate).
      if (TERMINAL_STATUSES.includes(order.status)) {
        await handleTerminalOrderDispute(db, order, dispute, event, "closed");
        return;
      }
      if (dispute.status !== "won") return; // lost → the refund path owns it (A2)
      if (order.status !== "disputed") return;
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

// ---------------------------------------------------------------------------
// A3 (THI-1611 spec §A3): disputes landing on terminal orders.

/**
 * A dispute event whose order is already terminal (paid_out, refunded,
 * cancelled, completed): transition #22 correctly refuses non-terminal-only
 * sources, but the money story is not over — on paid_out the seller keeps the
 * payout on a charge the buyer is disputing. Defined handling, never a silent
 * drop:
 *
 *   1. Durable record (order_events `terminal_dispute`) + operator alert —
 *      on created AND closed phases, any closure status.
 *   2. Recovery: full `transfers.createReversal` of the order's transfer —
 *      Stripe lands it as a negative connected-account balance recovered from
 *      the seller's future earnings. The attempt outcome is recorded durably
 *      on the order (`transfer_reversal` row: succeeded | already_reversed |
 *      failed); a failed reversal escalates with its own always-firing alert —
 *      real money, not a log line.
 *
 * Reversal is skipped when: the representment was WON (the charge stood —
 * clawing back would strand the seller; the alert still fires), the buyer was
 * already refunded (refund_id — a reversal on top would double-recover), or
 * there is no transfer to pull from.
 *
 * Replay-safety (webhook idempotency lens): order_events rows dedupe per
 * Stripe event id (`terminal_dispute:{event.id}`, `reversal_attempt:{event.id}`)
 * so rule-6 reprocessing never double-writes; the Stripe call reuses the §6.6
 * idempotency key `reversal:{order_id}` so every path (this recovery and the
 * admin refund-after-transfer) replays the SAME reversal, never a second one.
 * Alerts dedupe per event id (post-payout) / per order (escalation).
 */
async function handleTerminalOrderDispute(
  db: PoolClient,
  order: OrderRow,
  dispute: Stripe.Dispute,
  event: Stripe.Event,
  phase: "created" | "closed",
): Promise<void> {
  const disputeStatus = dispute.status ?? "unspecified";
  await db.query(
    `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload, dedupe_key)
     VALUES ($1, 'terminal_dispute', 'stripe', $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      order.id,
      event.id,
      `dispute ${dispute.id} (${dispute.reason ?? "unspecified"}, ${disputeStatus}) ${phase} on ${order.status} order`,
      JSON.stringify({
        dispute_id: dispute.id,
        dispute_status: disputeStatus,
        reason: dispute.reason ?? null,
        phase,
        order_status: order.status,
      }),
      `terminal_dispute:${event.id}`,
    ],
  );
  const lines = [
    `Order: ${order.id} (${order.status})`,
    `Dispute: ${dispute.id} (${dispute.reason ?? "unspecified"}, ${disputeStatus}) — ${phase}`,
    "Action: inspect in Stripe dashboard — payout recovery engaged (docs/deploy-vps.md §5.3)",
  ];
  console.error(
    `[webhooks:stripe] operator alert: dispute ${dispute.id} (${disputeStatus}) ${phase} on terminal order ${order.id} (${order.status})`,
  );
  await planOperatorAlert({
    kind: "post_payout_chargeback",
    ref: `post_payout_chargeback:${event.id}`,
    subject: `Chargeback on ${order.status} order ${order.id} — Thingery`,
    payload: { title: "Chargeback on a terminal order — payout recovery engaged", lines },
    client: db,
  });

  if (phase === "closed" && disputeStatus === "won") return; // charge stood — payout is legitimate
  if (order.payment_mode !== "stripe" || !order.transfer_id || order.refund_id) return;
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");

  let outcome: "succeeded" | "already_reversed" | "failed";
  let reversalId: string | null = null;
  let error: string | null = null;
  try {
    const transfer = await stripe.transfers.retrieve(order.transfer_id);
    if (transfer.amount_reversed) {
      outcome = "already_reversed"; // reconcile-don't-recreate (F3)
    } else {
      // §6.6 idempotency key: dispute recovery and admin refund replay the
      // same reversal — never a second money movement for one order.
      const reversal = await stripe.transfers.createReversal(
        order.transfer_id,
        {},
        { idempotencyKey: `reversal:${order.id}` },
      );
      reversalId = reversal.id ?? null;
      outcome = "succeeded";
    }
  } catch (err) {
    outcome = "failed";
    error = (err as Error).message.slice(0, 300);
  }
  await db.query(
    `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload, dedupe_key)
     VALUES ($1, 'transfer_reversal', 'stripe', $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      order.id,
      event.id,
      `reversal of transfer ${order.transfer_id}: ${outcome}${error ? ` (${error})` : ""}`,
      JSON.stringify({
        transfer_id: order.transfer_id,
        reversal_id: reversalId,
        outcome,
        error,
        dispute_id: dispute.id,
      }),
      `reversal_attempt:${event.id}`,
    ],
  );
  if (outcome === "failed") {
    console.error(
      `[webhooks:stripe] operator alert: reversal of ${order.transfer_id} FAILED on charged-back order ${order.id} — ${error} (manual recovery via Stripe dashboard; the seller's future earnings carry the negative balance)`,
    );
    await planOperatorAlert({
      kind: "reversal_failed",
      ref: `reversal_failed:${order.id}`,
      subject: `REVERSAL FAILED: order ${order.id} — Thingery`,
      payload: {
        title: "Transfer reversal failed on a charged-back order — money is still with the seller",
        lines: [
          ...lines,
          `Transfer: ${order.transfer_id}`,
          `Error: ${error}`,
          "Action: reverse manually via Stripe dashboard / reconcile — escalate, real money at stake",
        ],
      },
      client: db,
    });
  }
}
