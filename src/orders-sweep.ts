// Deadline sweeps + webhook reprocessing — THI-3 spec §4.5 rules 1–7,
// rev 3 §11.3 rules 8–9. One in-process sweep, boot run + setInterval
// (single-instance posture; same as the in-memory RateLimiter).
//
// Every rule is idempotent by construction: transitions carry
// order_events.dedupe_key = sweep:{rule}:{order_id} (UNIQUE — at most once per
// order, not per run, F9) and the conditional-UPDATE guard arbitrates races
// against webhooks/tools. Alert-only rules (7, 9) never change state.

import { pool } from "./db.js";
import type { PoolClient } from "pg";
import type Stripe from "stripe";
import { orderFlowConfig, type OrderFlowConfig } from "./config.js";
import {
  applyTransition,
  IllegalTransitionError,
  settleNothingDueRefund,
  type OrderRow,
} from "./orders.js";
import {
  getStripe,
  getCheckoutPaymentStatus,
  expireCheckoutSession,
  createRefundForOrder,
  createTransferForOrder,
  payoutBaseCents,
} from "./stripe.js";
import { processCarrierEvent } from "./webhooks-carrier.js";
import { processStripeEvent, processStripeV2Notification } from "./webhooks-stripe.js";
import { planAccountNotification } from "./notify/items.js";
import { planOperatorAlert } from "./notify/operator.js";
import { notifyConfig } from "./config.js";
import { refundLabelLineForOrder } from "./fulfillment.js";

const SYSTEM = { type: "system" as const };

export interface SweepReport {
  [rule: string]: { acted: number; skipped: number; errored: number };
}

function tally(report: SweepReport, rule: string, outcome: "acted" | "skipped" | "errored") {
  report[rule] ??= { acted: 0, skipped: 0, errored: 0 };
  report[rule][outcome]++;
}

/** Every rule reports a bucket even when it finds no candidates. */
function open(report: SweepReport, rule: string) {
  report[rule] ??= { acted: 0, skipped: 0, errored: 0 };
}

const hours = (n: number) => n * 3_600_000;
const days = (n: number) => hours(n * 24);

/** Refund-first (F3): full refund under refund:{order_id} idempotency before
 * the transition that records it; a replay retrieves the same refund.
 * §6 policy (stale-sale / never-shipped): a platform label bought for the
 * order is the buyer's — exclude_label; with no label bought the buyer's
 * full charge (label line included) goes back.
 * B1 (THI-1013): a zero remainder settles as nothingDue with a null id —
 * callers omit the refund_id set so the transition still fires, then
 * settle the unwind inline (no webhook can confirm a refund that was
 * never created). */
async function refundFirst(order: OrderRow) {
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  if (!order.payment_intent_id) throw new Error("inconsistent_state: paid order missing payment intent");
  return createRefundForOrder(order, order.payment_intent_id, stripe, "exclude_label");
}

async function alertEvent(orderId: string, type: string, message: string, dedupeKey?: string) {
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, actor_type, reason, payload, dedupe_key)
     VALUES ($1, $2, 'system', $3, '{}'::jsonb, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [orderId, type, message.slice(0, 500), dedupeKey ?? null],
  );
}

// --- Rule 1: pending past payment_deadline → cancelled (#4; off_platform arm
// skips the paid-check — no platform money to strand, rev 3 §11.2).
async function rule1(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "1-payment-expired");
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'pending' AND payment_deadline < $1 ORDER BY created_at",
    [now],
  );
  for (const order of rows) {
    try {
      if (order.payment_mode === "stripe" && order.checkout_session_id) {
        const status = await getCheckoutPaymentStatus(order.checkout_session_id);
        if (status === "paid" || status === "processing" || status === "unknown") {
          // F2: never cancel paid/unclear — webhook (or rule 6) will land it.
          await alertEvent(order.id, "unexpected_payment", `payment-deadline sweep: checkout session ${status}`);
          tally(report, "1-payment-expired", "skipped");
          continue;
        }
        await expireCheckoutSession(order.checkout_session_id); // best-effort
      }
      await applyTransition({
        orderId: order.id,
        trigger: "payment_expired",
        actor: SYSTEM,
        reason: "payment_deadline elapsed",
        dedupeKey: `sweep:1:${order.id}`,
      });
      tally(report, "1-payment-expired", "acted");
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "1-payment-expired", "skipped");
      else {
        console.error(`[sweep:1] order ${order.id}:`, err);
        tally(report, "1-payment-expired", "errored");
      }
    }
  }
}

// THI-780 PR 3: early warning before a hard sweep deadline. One notice per
// order per kind (dedupe warn:{kind}:{order_id}) at half the window elapsed;
// the transition itself still fires at the full window. PII-free payload:
// item title + order id + the hard deadline.
async function deadlineWarning(order: OrderRow, kind: "stale_sale" | "stuck_transit", deadline: Date): Promise<void> {
  await planAccountNotification({
    recipientId: order.seller_id,
    toEmail: await sellerEmail(order.seller_id),
    eventType: kind === "stale_sale" ? "seller.stale_sale_warning" : "seller.stuck_transit_warning",
    role: "seller",
    subject: kind === "stale_sale" ? "Action needed: ship your sale — Thingery" : "Shipping stalled — Thingery",
    payload: {
      item_title: await itemTitle(order.item_id),
      item_id: order.item_id,
      order_id: order.id,
      order_status: order.status,
      amount_cents: order.price_cents + order.shipping_price_cents,
      currency: order.currency,
      deadline: deadline.toISOString(),
    },
    dedupeKey: `warn:${kind}:${order.id}`,
  });
}

async function sellerEmail(sellerId: string): Promise<string | null> {
  const r = await pool.query<{ email: string | null }>("SELECT email FROM sellers WHERE id = $1", [sellerId]);
  return r.rows[0]?.email ?? null;
}

async function itemTitle(itemId: string): Promise<string> {
  const r = await pool.query<{ title: string | null }>("SELECT title FROM items WHERE id = $1", [itemId]);
  return r.rows[0]?.title ?? "your item";
}

// --- Rule 2: sold past STALE_SOLD_DAYS without tracking → refunding (#9) /
// cancelled (#9b off_platform). Item → active either way (dead seller relists).
// THI-780 PR 3: a warning fires at half the window, before the hard cancel.
async function rule2(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "2-stale-sale");
  const half = new Date(now.getTime() - days(cfg.staleSoldDays / 2));
  const warnable = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'sold' AND tracking_code IS NULL AND status_changed_at < $1 AND status_changed_at >= $2",
    [new Date(now.getTime() - days(cfg.staleSoldDays)), half],
  );
  for (const order of warnable.rows) {
    try {
      await deadlineWarning(order, "stale_sale", new Date(order.status_changed_at.getTime() + days(cfg.staleSoldDays)));
    } catch (err) {
      console.error(`[sweep:2] warning for order ${order.id}:`, err);
    }
  }
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'sold' AND tracking_code IS NULL AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.staleSoldDays))],
  );
  for (const order of rows) {
    try {
      const refund = order.payment_mode === "stripe" ? await refundFirst(order) : null;
      const sets = refund?.id ? { refund_id: refund.id } : undefined;
      const next = await applyTransition({
        orderId: order.id,
        trigger: "stale_sale",
        actor: SYSTEM,
        reason: "no tracking recorded within STALE_SOLD_DAYS",
        dedupeKey: `sweep:2:${order.id}`,
        ...(sets ? { sets } : {}),
      });
      await settleNothingDueRefund(next, refund); // B1: nothing-due unwinds complete inline
      tally(report, "2-stale-sale", "acted");
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "2-stale-sale", "skipped");
      else if (err instanceof Error && err.message.startsWith("inconsistent_state")) {
        await alertEvent(order.id, "sweep_blocked", "stale-sale refund blocked: missing payment intent", `sweep:2:${order.id}`);
        tally(report, "2-stale-sale", "errored");
      } else {
        console.error(`[sweep:2] order ${order.id}:`, err);
        tally(report, "2-stale-sale", "errored");
      }
    }
  }
}

// --- Rule 3: in_transit past IN_TRANSIT_STUCK_DAYS without a carrier event.
// in_transit is reachable only via the carrier event (#10), which refreshes
// status_changed_at — so an old status_changed_at *is* "no carrier event since".
// THI-780 PR 3: a warning fires at half the window, before the hard refund.
async function rule3(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "3-stuck-transit");
  const half = new Date(now.getTime() - days(cfg.inTransitStuckDays / 2));
  const warnable = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'in_transit' AND status_changed_at < $1 AND status_changed_at >= $2",
    [new Date(now.getTime() - days(cfg.inTransitStuckDays)), half],
  );
  for (const order of warnable.rows) {
    try {
      await deadlineWarning(order, "stuck_transit", new Date(order.status_changed_at.getTime() + days(cfg.inTransitStuckDays)));
    } catch (err) {
      console.error(`[sweep:3] warning for order ${order.id}:`, err);
    }
  }
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'in_transit' AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.inTransitStuckDays))],
  );
  for (const order of rows) {
    try {
      const refund = order.payment_mode === "stripe" ? await refundFirst(order) : null;
      const sets = refund?.id ? { refund_id: refund.id } : undefined;
      const next = await applyTransition({
        orderId: order.id,
        trigger: "stuck_transit",
        actor: SYSTEM,
        reason: "in_transit without carrier events for IN_TRANSIT_STUCK_DAYS",
        dedupeKey: `sweep:3:${order.id}`,
        ...(sets ? { sets } : {}),
      });
      await settleNothingDueRefund(next, refund); // B1: nothing-due unwinds complete inline
      tally(report, "3-stuck-transit", "acted");
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "3-stuck-transit", "skipped");
      else {
        console.error(`[sweep:3] order ${order.id}:`, err);
        tally(report, "3-stuck-transit", "errored");
      }
    }
  }
}

/** Transfer creation for #16/#17 (and the rule-4 retry arm): reconcile-don't-
 * recreate — payout:{order_id} idempotency; existing transfer_id → retrieve. */
async function attemptPayout(order: OrderRow): Promise<boolean> {
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  // B1-sibling (Security review THI-1013): a zero payout base (free
  // listing) settles here — this rule's retry arm is the convergence point
  // for every payout entry path (release, admin, sweep). No transfer exists
  // or will ever arrive to settle it, and demanding an onboarded seller
  // account would wedge a free listing forever, so settle with an operator
  // note before the destination lookup.
  if (payoutBaseCents(order) <= 0) {
    await alertEvent(
      order.id,
      "payout_zero_base",
      "payout base is 0 (free listing) — settled paid_out without a transfer",
      `payout_zero_base:${order.id}`,
    );
    try {
      await applyTransition({
        orderId: order.id,
        trigger: "transfer_paid",
        actor: { type: "stripe", id: "zero_base" },
        reason: "zero payout base — nothing to transfer",
      });
    } catch (err) {
      // A concurrent settle (admin reconcile) already moved the row — the
      // outcome (paid_out, no transfer) is identical; never re-error the sweep.
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
    return true;
  }
  const dest = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [order.seller_id],
  );
  const destination = dest.rows[0]?.stripe_account_id;
  if (!destination) throw new Error("inconsistent_state: seller payout account missing");
  const transfer = await createTransferForOrder(order, destination, stripe);
  await pool.query("UPDATE orders SET transfer_id = $2 WHERE id = $1", [order.id, transfer.id]);
  return true;
}

// --- Rule 4: delivered past dispute_deadline → payout_pending + transfer
// (#16) / completed (#16b off_platform). Also retries transfer creation for
// payout_pending orders whose transfer never landed (§6.6 payout failure:
// stay payout_pending, retry — rule 7 alerts if it persists).
async function rule4(report: SweepReport, _cfg: OrderFlowConfig, now: Date) {
  open(report, "4-payout");
  const delivered = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'delivered' AND dispute_deadline < $1",
    [now],
  );
  for (const order of delivered.rows) {
    try {
      await applyTransition({
        orderId: order.id,
        trigger: "dispute_window_elapsed",
        actor: SYSTEM,
        reason: "dispute window elapsed without dispute",
        dedupeKey: `sweep:4:${order.id}`,
      });
      tally(report, "4-payout", "acted");
      if (order.payment_mode === "stripe") await payoutOrLog(order);
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "4-payout", "skipped");
      else {
        console.error(`[sweep:4] order ${order.id}:`, err);
        tally(report, "4-payout", "errored");
      }
    }
  }

  const pending = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'payout_pending' AND payment_mode = 'stripe' AND transfer_id IS NULL",
  );
  for (const order of pending.rows) {
    try {
      await payoutOrLog(order);
    } catch (err) {
      console.error(`[sweep:4] payout retry order ${order.id}:`, err);
    }
  }
}

async function payoutOrLog(order: OrderRow) {
  try {
    await attemptPayout(order);
  } catch (err) {
    // Deadline already elapsed; keep payout_pending and surface it once —
    // rule 6-style retry (this rule's retry arm) + rule 7 stale alert.
    await alertEvent(order.id, "payout_attempt_failed", `payout sweep failed: ${(err as Error).message}`, `payout_retry:${order.id}`);
  }
}

// --- Rule 5: sold (pickup) past PICKUP_AUTOCONFIRM_DAYS → delivered (#7)
// with the LONG dispute window (F10 — no handover evidence exists).
async function rule5(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "5-pickup-autoconfirm");
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'sold' AND fulfillment = 'pickup' AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.pickupAutoconfirmDays))],
  );
  for (const order of rows) {
    try {
      await applyTransition({
        orderId: order.id,
        trigger: "pickup_autoconfirm",
        actor: SYSTEM,
        reason: "pickup auto-confirmed by system (PICKUP_AUTOCONFIRM_DAYS)",
        sets: { dispute_deadline: new Date(now.getTime() + hours(cfg.systemConfirmedDisputeWindowHours)) },
        dedupeKey: `sweep:5:${order.id}`,
      });
      tally(report, "5-pickup-autoconfirm", "acted");
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "5-pickup-autoconfirm", "skipped");
      else {
        console.error(`[sweep:5] order ${order.id}:`, err);
        tally(report, "5-pickup-autoconfirm", "errored");
      }
    }
  }
}

// --- Rule 6: webhook reprocessing (F11). The only recovery path for events
// stored but not applied (§5.4 dedupe answers 200 on redelivery, so providers
// stop retrying). Backoff + attempt tracking live in process_error itself
// ("... [attempt N @ ISO]"); repeated failure alerts the operator.
// `skipped:` rows (ambiguous carrier resolution) need an operator data fix
// first and are deliberately excluded — re-running them would alert-loop
// (Security THI-66 advisory A4).
// `rejected:` rows are FINAL (THI-1694 R2): the ingest livemode gate (F5/§6.7)
// settles them with process_error = 'rejected: livemode mismatch' and 200 —
// retrying would re-run processStripeEvent on a settled rejection forever.
// (The spec's defensive `process_error IS NULL` arm is redundant under the
// existing `IS NOT NULL` precondition; kept verbatim from THI-1697.)
const RETRY_RULE6 = "6-reprocess";
const ATTEMPT_RE = /\[attempt (\d+) @ ([^\]]+)\]$/;

function attemptTagOf(error: string): { n: number; at: number } {
  const m = error.match(ATTEMPT_RE);
  if (!m) return { n: 0, at: 0 };
  return { n: parseInt(m[1], 10), at: Date.parse(m[2]) || 0 };
}

interface WebhookEventRow {
  id: string;
  source: "stripe" | "carrier";
  external_id: string;
  payload: unknown;
  process_error: string;
}

const RULE6_CANDIDATES = `SELECT id, source, external_id, payload, process_error FROM webhook_events
  WHERE processed_at IS NULL AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%'`;

/** F11 reprocessing wrapper shared by the v1/carrier loop and the v2
 *  reprocessor (THI-1698): backoff gate, transaction, processed_at flip and
 *  attempt tagging live here ONCE so the two paths cannot drift. */
async function reprocessWebhookEvent(
  report: SweepReport,
  ev: Pick<WebhookEventRow, "id" | "source" | "external_id" | "process_error">,
  now: Date,
  apply: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const { n, at } = attemptTagOf(ev.process_error);
  const backoffMs = Math.min(15 * 60_000 * 2 ** n, hours(6));
  if (n > 0 && now.getTime() - at < backoffMs) {
    tally(report, RETRY_RULE6, "skipped");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await apply(client);
    await client.query("UPDATE webhook_events SET processed_at = now(), process_error = NULL WHERE id = $1 AND processed_at IS NULL", [ev.id]);
    await client.query("COMMIT");
    tally(report, RETRY_RULE6, "acted");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const next = n + 1;
    const msg = `${ev.process_error.replace(ATTEMPT_RE, "").trim()} [attempt ${next} @ ${now.toISOString()}]`;
    await pool.query("UPDATE webhook_events SET process_error = $2 WHERE id = $1 AND processed_at IS NULL", [ev.id, msg]).catch(() => undefined);
    if (next >= 5) {
      console.error(
        `[sweep:6] operator alert: webhook event ${ev.source}/${ev.external_id} failed reprocessing ${next} times — manual action needed:`,
        (err as Error).message,
      );
    }
    tally(report, RETRY_RULE6, "errored");
  } finally {
    client.release();
  }
}

async function rule6(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, RETRY_RULE6);
  // `NOT LIKE 'v2:%'` (THI-1698): v2 event-destination notifications (THI-1681)
  // live in their own id namespace and have their own reprocessor below — the
  // v1 events.retrieve can never resolve a `v2:` id, so letting them through
  // here would only error-loop. `rejected:` rows stay FINAL here too (THI-1694
  // R2): re-running processStripeEvent on a settled rejection is never wanted.
  // The v2 arm below deliberately does NOT inherit this exclusion — it re-screens
  // F5 itself and settles cross-mode rows terminally instead of re-litigating.
  const { rows } = await pool.query<WebhookEventRow>(
    `${RULE6_CANDIDATES} AND external_id NOT LIKE 'v2:%'
       AND (process_error IS NULL OR process_error NOT LIKE 'rejected:%')
     ORDER BY received_at LIMIT 100`,

  );
  const stripe = getStripe();
  for (const ev of rows) {
    await reprocessWebhookEvent(report, ev, now, async (client) => {
      if (ev.source === "stripe") {
        if (!stripe) throw new Error("payments_not_configured");
        // Stored payload is redacted (F6) — re-fetch the event by id and
        // re-apply; re-processing is idempotent (dedupe row already exists;
        // transition guards make re-application a no-op).
        const event = await stripe.events.retrieve(ev.external_id);
        await processStripeEvent(event, client, cfg);
      } else {
        await processCarrierEvent(ev.payload as never, ev.external_id, client, cfg);
      }
    });
  }
  await reprocessStripeV2Events(report, cfg, now);
}

// --- Rule 6 v2 arm (THI-1698, THI-1696 R1): the Accounts v2 event-destination
//  endpoint (THI-1681) stores notifications under the `v2:` id namespace; when
//  their processing fails transiently (e.g. the fetchRelatedObject round-trip
//  → 500) Stripe's redelivery only hits the dedupe (200 duplicate, provider
//  stops retrying) — without this pass the stranded seller flip needs the
//  manual operator path. The stored payload is REDACTED (F6: ids, type,
//  livemode only), so the thin notification is rebuilt from those ids and the
//  related object is re-fetched by the stored object_id on the v2 API path
//  with the same-mode platform key; re-running the exported ingest handler
//  keeps the flip's NULL→set conditional (verify→dedupe semantics, never
//  re-badges).

interface V2StoredPayload {
  id: string;
  type: string;
  livemode: boolean;
  object_id: string | null;
  object_type: string | null;
}

function asV2StoredPayload(raw: unknown): V2StoredPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.type !== "string") return null;
  return {
    id: p.id,
    type: p.type,
    livemode: p.livemode === true,
    object_id: typeof p.object_id === "string" ? p.object_id : null,
    object_type: typeof p.object_type === "string" ? p.object_type : null,
  };
}

/** Thin-notification reconstruction: ids only (the stored payload never held
 *  more); fetchRelatedObject does what the SDK's pulled-event helper does —
 *  GET the related object on the v2 API path — so the ingest handler sees the
 *  account's CURRENT state, exactly as on first delivery. */
function rebuildV2Notification(payload: V2StoredPayload, stripe: Stripe): Stripe.V2.Core.EventNotification {
  const notif = {
    id: payload.id,
    type: payload.type,
    livemode: payload.livemode,
    related_object: { id: payload.object_id, type: payload.object_type, url: null },
    fetchRelatedObject: async () => {
      // Fail safe: a capability row without usable related-object ids (or
      // with a type this code cannot fetch) throws — the shared error path
      // attempt-tags the row and alerts the operator; nothing is applied.
      if (!payload.object_id || !payload.object_type) {
        throw new Error("v2 notification payload carries no related object ids");
      }
      if (payload.object_type !== "v2.core.account") {
        throw new Error(`unsupported v2 related object type: ${payload.object_type}`);
      }
      return stripe.v2.core.accounts.retrieve(payload.object_id);
    },
  };
  return notif as unknown as Stripe.V2.Core.EventNotification;
}

async function reprocessStripeV2Events(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  const { rows } = await pool.query<WebhookEventRow>(
    `${RULE6_CANDIDATES} AND source = 'stripe' AND external_id LIKE 'v2:%' ORDER BY received_at LIMIT 100`,
  );
  if (rows.length === 0) return;
  const stripe = getStripe();
  for (const ev of rows) {
    const payload = asV2StoredPayload(ev.payload);
    if (!payload) {
      // Unreadable stored payload: immutable, so retrying can never succeed —
      // still routed through the error path (attempt tags + operator alert
      // after 5) rather than silently marked: a corrupt row needs eyes.
      await reprocessWebhookEvent(report, ev, now, async () => {
        throw new Error("inconsistent_state: v2 webhook payload is not a stored notification");
      });
      continue;
    }
    // Re-screen F5 (§6.7) against the CURRENT config before touching the v2
    // API: a cross-mode payload must never drive a platform-key fetch or a
    // flip. Terminal, mirroring the ingest endpoint's rejected verdict —
    // retrying a mode mismatch would only re-produce it.
    if (payload.livemode !== (cfg.stripeMode === "live")) {
      await pool
        .query("UPDATE webhook_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL", [ev.id])
        .catch(() => undefined);
      tally(report, RETRY_RULE6, "acted");
      continue;
    }
    await reprocessWebhookEvent(report, ev, now, async (client) => {
      if (!stripe) throw new Error("payments_not_configured");
      await processStripeV2Notification(rebuildV2Notification(payload, stripe), client);
    });
  }
}

// --- Rule 7: stuck-money alert (F11) — payout_pending/refunding beyond N
// days. Alert-only (operator acts via Stripe dashboard / admin route).
// THI-780 PR 4: mirrors to OPERATOR_ALERT_EMAIL when set (once per order,
// opalert dedupe); console.error is always the floor.
async function rule7(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  const { rows } = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM orders WHERE status IN ('payout_pending','refunding') AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.stuckMoneyAlertDays))],
  );
  if (rows.length > 0) {
    console.error(
      `[sweep:7] operator alert: ${rows.length} order(s) stuck in money states beyond ${cfg.stuckMoneyAlertDays}d:`,
      rows.map((r) => `${r.id} (${r.status})`).join(", "),
    );
    if (notifyConfig().operatorAlertEmail) {
      for (const r of rows) {
        await planOperatorAlert({
          kind: "stuck_money",
          ref: r.id,
          subject: `Stuck money: order ${r.id} (${r.status}) — Thingery`,
          payload: {
            title: `Order stuck in ${r.status} beyond ${cfg.stuckMoneyAlertDays} days`,
            lines: [`Order: ${r.id}`, `Status: ${r.status} (since > ${cfg.stuckMoneyAlertDays}d)`, "Action: inspect in Stripe dashboard / admin route"],
          },
        });
      }
    }
  }
  report["7-stuck-money"] = { acted: rows.length, skipped: 0, errored: 0 };
}

// --- Rule 8 (rev 3 §11.3): disputed with no recorded tracking past
// DISPUTE_AUTOREFUND_HOURS → auto-refund (never_shipped). Money moves only on
// unambiguous evidence: a shipped order must have a tracking code.
async function rule8(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "8-never-shipped");
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'disputed' AND tracking_code IS NULL AND status_changed_at < $1",
    [new Date(now.getTime() - hours(cfg.disputeAutorefundHours))],
  );
  for (const order of rows) {
    try {
      const refund = order.payment_mode === "stripe" ? await refundFirst(order) : null;
      const sets = refund?.id ? { refund_id: refund.id } : undefined;
      const next = await applyTransition({
        orderId: order.id,
        trigger: "dispute_autoresolve",
        actor: SYSTEM,
        reason: "never_shipped: dispute with no recorded tracking past DISPUTE_AUTOREFUND_HOURS",
        dedupeKey: `sweep:8:${order.id}`,
        ...(sets ? { sets } : {}),
      });
      await settleNothingDueRefund(next, refund); // B1: nothing-due unwinds complete inline
      console.error(`[sweep:8] operator alert: order ${order.id} auto-refunded (never_shipped, §11.3 rule 8)`);
      tally(report, "8-never-shipped", "acted");
    } catch (err) {
      if (err instanceof IllegalTransitionError) tally(report, "8-never-shipped", "skipped");
      else {
        console.error(`[sweep:8] order ${order.id}:`, err);
        tally(report, "8-never-shipped", "errored");
      }
    }
  }
}

// --- Rule 9 (rev 3 §11.3): stale-dispute escalation — alert only; humans
// resolve everything else on the admin route (PR-9). THI-780 PR 4: mirrors
// to OPERATOR_ALERT_EMAIL when set (once per order).
async function rule9(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM orders WHERE status = 'disputed' AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.disputeStaleDays))],
  );
  if (rows.length > 0) {
    console.error(
      `[sweep:9] operator alert: ${rows.length} dispute(s) unresolved beyond ${cfg.disputeStaleDays}d — resolve via admin route:`,
      rows.map((r) => r.id).join(", "),
    );
    if (notifyConfig().operatorAlertEmail) {
      for (const r of rows) {
        await planOperatorAlert({
          kind: "stale_dispute",
          ref: r.id,
          subject: `Stale dispute: order ${r.id} — Thingery`,
          payload: {
            title: `Dispute unresolved beyond ${cfg.disputeStaleDays} days`,
            lines: [`Order: ${r.id}`, `Status: disputed (since > ${cfg.disputeStaleDays}d)`, "Action: resolve via admin route"],
          },
        });
      }
    }
  }
  report["9-stale-dispute"] = { acted: rows.length, skipped: 0, errored: 0 };
}

// --- Rule 10 (buyer-paid shipping §6): own-label quote-mode orders whose
// label-line refund never completed — retry labelrefund:{order_id} (the
// idempotency key replays the same refund; reconcile-never-recreate). Only
// tracked, un-refunded states are candidates: a full refund (refunding /
// cancelled / payout states) already settled the line under refundCents, and
// firing here would exceed the charge. Escalates to one operator alert per
// order when the retry keeps failing.
async function rule10(report: SweepReport, _cfg: OrderFlowConfig, now: Date) {
  open(report, "10-label-line-refund");
  const { rows } = await pool.query<OrderRow>(
    `SELECT * FROM orders
      WHERE payment_mode = 'stripe' AND payment_intent_id IS NOT NULL
        AND label_quote IS NOT NULL AND label_purchase IS NULL
        AND tracking_code IS NOT NULL
        AND (label_quote->>'line_refund_id') IS NULL
        AND status IN ('label_issued','in_transit','delivered','disputed')
      ORDER BY created_at`,
  );
  for (const order of rows) {
    try {
      await refundLabelLineForOrder(order);
      tally(report, "10-label-line-refund", "acted");
    } catch (err) {
      console.error(`[sweep:10] label line refund failed for order ${order.id}:`, err);
      await planOperatorAlert({
        kind: "label_line_refund_stuck",
        ref: `labelline:${order.id}`,
        subject: `Label line refund stuck: order ${order.id} — Thingery`,
        payload: {
          title: `Buyer shipping-line refund could not complete (order ${order.id})`,
          lines: [`Order: ${order.id}`, `Error: ${(err as Error).message.slice(0, 200)}`, "Action: inspect the Stripe payment intent refunds and reconcile manually"],
        },
      }).catch(() => undefined);
      tally(report, "10-label-line-refund", "errored");
    }
  }
  void now;
}

/** One pass of every rule. A rule failure never blocks the others. */
export async function runSweeps(cfg: OrderFlowConfig = orderFlowConfig(), now: Date = new Date()): Promise<SweepReport> {
  const report: SweepReport = {};
  const rules: Array<[string, (r: SweepReport, c: OrderFlowConfig, n: Date) => Promise<void>]> = [
    ["1", rule1], ["2", rule2], ["3", rule3], ["4", rule4],
    ["5", rule5], ["6", rule6], ["7", rule7], ["8", rule8], ["9", rule9], ["10", rule10],
  ];
  for (const [name, fn] of rules) {
    try {
      await fn(report, cfg, now);
    } catch (err) {
      console.error(`[sweep:${name}] rule failed:`, err);
    }
  }
  const total = Object.values(report).reduce((a, b) => a + b.acted + b.errored, 0);
  if (total > 0) console.log(`[sweep] ${JSON.stringify(report)}`);
  return report;
}

/** Boot run + interval (§4.5). Re-entrant-safe; timer is unref'd. */
export function startSweepScheduler(cfg: OrderFlowConfig = orderFlowConfig()): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSweeps(cfg);
    } catch {
      // runSweeps already isolates rule failures; never throw from a timer.
    } finally {
      running = false;
    }
  };
  void tick(); // boot run
  const timer = setInterval(() => void tick(), cfg.sweepIntervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
