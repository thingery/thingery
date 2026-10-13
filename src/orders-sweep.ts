// Deadline sweeps + webhook reprocessing — THI-3 spec §4.5 rules 1–7,
// rev 3 §11.3 rules 8–9. One in-process sweep, boot run + setInterval
// (single-instance posture; same as the in-memory RateLimiter).
//
// Every rule is idempotent by construction: transitions carry
// order_events.dedupe_key = sweep:{rule}:{order_id} (UNIQUE — at most once per
// order, not per run, F9) and the conditional-UPDATE guard arbitrates races
// against webhooks/tools. Alert-only rules (7, 9) never change state.

import { pool } from "./db.js";
import { orderFlowConfig, type OrderFlowConfig } from "./config.js";
import {
  applyTransition,
  IllegalTransitionError,
  type OrderRow,
} from "./orders.js";
import {
  getStripe,
  getCheckoutPaymentStatus,
  expireCheckoutSession,
  createRefundForOrder,
  createTransferForOrder,
} from "./stripe.js";
import { processCarrierEvent } from "./webhooks-carrier.js";
import { processStripeEvent } from "./webhooks-stripe.js";

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
 * the transition that records it; a replay retrieves the same refund. */
async function refundFirst(order: OrderRow): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  if (!order.payment_intent_id) throw new Error("inconsistent_state: paid order missing payment intent");
  const refund = await createRefundForOrder(order, order.payment_intent_id, stripe);
  return refund.id;
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

// --- Rule 2: sold past STALE_SOLD_DAYS without tracking → refunding (#9) /
// cancelled (#9b off_platform). Item → active either way (dead seller relists).
async function rule2(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "2-stale-sale");
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'sold' AND tracking_code IS NULL AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.staleSoldDays))],
  );
  for (const order of rows) {
    try {
      const sets = order.payment_mode === "stripe" ? { refund_id: await refundFirst(order) } : undefined;
      await applyTransition({
        orderId: order.id,
        trigger: "stale_sale",
        actor: SYSTEM,
        reason: "no tracking recorded within STALE_SOLD_DAYS",
        dedupeKey: `sweep:2:${order.id}`,
        ...(sets ? { sets } : {}),
      });
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
async function rule3(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, "3-stuck-transit");
  const { rows } = await pool.query<OrderRow>(
    "SELECT * FROM orders WHERE status = 'in_transit' AND status_changed_at < $1",
    [new Date(now.getTime() - days(cfg.inTransitStuckDays))],
  );
  for (const order of rows) {
    try {
      const sets = order.payment_mode === "stripe" ? { refund_id: await refundFirst(order) } : undefined;
      await applyTransition({
        orderId: order.id,
        trigger: "stuck_transit",
        actor: SYSTEM,
        reason: "in_transit without carrier events for IN_TRANSIT_STUCK_DAYS",
        dedupeKey: `sweep:3:${order.id}`,
        ...(sets ? { sets } : {}),
      });
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
const RETRY_RULE6 = "6-reprocess";
const ATTEMPT_RE = /\[attempt (\d+) @ ([^\]]+)\]$/;

function attemptTagOf(error: string): { n: number; at: number } {
  const m = error.match(ATTEMPT_RE);
  if (!m) return { n: 0, at: 0 };
  return { n: parseInt(m[1], 10), at: Date.parse(m[2]) || 0 };
}

async function rule6(report: SweepReport, cfg: OrderFlowConfig, now: Date) {
  open(report, RETRY_RULE6);
  const { rows } = await pool.query<{ id: string; source: "stripe" | "carrier"; external_id: string; payload: unknown; process_error: string }>(
    `SELECT id, source, external_id, payload, process_error FROM webhook_events
     WHERE processed_at IS NULL AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%'
     ORDER BY received_at LIMIT 100`,
  );
  const stripe = getStripe();
  for (const ev of rows) {
    const { n, at } = attemptTagOf(ev.process_error);
    const backoffMs = Math.min(15 * 60_000 * 2 ** n, hours(6));
    if (n > 0 && now.getTime() - at < backoffMs) {
      tally(report, RETRY_RULE6, "skipped");
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
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
}

// --- Rule 7: stuck-money alert (F11) — payout_pending/refunding beyond N
// days. Alert-only (operator acts via Stripe dashboard / admin route).
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
      const sets = order.payment_mode === "stripe" ? { refund_id: await refundFirst(order) } : undefined;
      await applyTransition({
        orderId: order.id,
        trigger: "dispute_autoresolve",
        actor: SYSTEM,
        reason: "never_shipped: dispute with no recorded tracking past DISPUTE_AUTOREFUND_HOURS",
        dedupeKey: `sweep:8:${order.id}`,
        ...(sets ? { sets } : {}),
      });
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
// resolve everything else on the admin route (PR-9).
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
  }
  report["9-stale-dispute"] = { acted: rows.length, skipped: 0, errored:0 };
}

/** One pass of every rule. A rule failure never blocks the others. */
export async function runSweeps(cfg: OrderFlowConfig = orderFlowConfig(), now: Date = new Date()): Promise<SweepReport> {
  const report: SweepReport = {};
  const rules: Array<[string, (r: SweepReport, c: OrderFlowConfig, n: Date) => Promise<void>]> = [
    ["1", rule1], ["2", rule2], ["3", rule3], ["4", rule4],
    ["5", rule5], ["6", rule6], ["7", rule7], ["8", rule8], ["9", rule9],
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
