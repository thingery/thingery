// Carrier webhook endpoint (spec THI-3 rev 2 §4.3/§5.2–§5.4; PR-7; provider
// seam THI-1246). Provider-agnostic since THI-1246: the EasyPost-specific
// wire details (signature scheme `X-Hmac-Signature`, status map, F6
// redaction, `easypost:<sha256>` dedupe) live in the ShippingProvider
// adapter (src/shipping/easypost-adapter.ts → src/easypost.ts); this route
// drives the protocol below through the interface (spec
// docs/specs/shipping-provider-layer.md).
//
// Mount BEFORE the global express.json() (index.ts, same as the Stripe
// webhook) — the HMAC signature is computed over raw bytes, so this router
// consumes express.raw({ application/json, 512kb }) itself (F12).
//
// Protocol (§5.4 — verify → store → process → mark):
//   1. Verify over the raw body via the provider's signature header,
//      timing-safe (never === on strings). Current secret, then the
//      ${ID}_WEBHOOK_SECRET_PREVIOUS rotation secret (F13). The body is
//      parsed only AFTER verification succeeds (§5.3).
//   2. Store REDACTED (F6, in the adapter): free-text tracking details never
//      touch the store — only description/mode/tracker ids/status/timestamps
//      persist. Dedupe (in the adapter): external_id is a deterministic
//      content hash — a byte-identical redelivery dedupes to one row; any
//      content change is a new event, and the transition guard keeps
//      re-application a no-op.
//   3. Process transactionally: event→order resolution (F4, §5.2) —
//      `tracker_id` first (UNIQUE, unambiguous); `(carrier, tracking_code)`
//      fallback only with EXACTLY ONE live (non-terminal) match; zero →
//      skip, multiple → skip + operator alert; never guess. Then the
//      normalized status drives #10/#12/#14/#14b via the PR-2 core.
//   4. Stale-but-valid transitions (late/duplicate/out-of-order) are NOT
//      errors — 200, no state change; the machine is the arbiter. Real
//      failures set process_error and return 500 so the carrier retries
//      (sweep rule 6, PR-8, reprocesses stored-but-errored rows).

import express, { type Request, type Response, type Router } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { orderFlowConfig, type OrderFlowConfig } from "./config.js";
import { applyTransition, IllegalTransitionError, settleNothingDueRefund, type ItemStatus, type OrderRow } from "./orders.js";
import { createRefundForOrder, getStripe } from "./stripe.js";
import { verifyEasyPostSignature } from "./easypost.js";
import { getShippingProvider } from "./shipping/registry.js";
import {
  VerificationError,
  WebhookParseError,
  type NormalizedStatus,
  type RedactedCarrierEvent,
} from "./shipping/provider.js";

// Old export path (tests, potential embedders): the implementation moved to
// src/easypost.ts with the rest of the EasyPost wire details (THI-1246).
export { verifyEasyPostSignature };

/** F4 ambiguous resolution: multiple live orders match (carrier, tracking_code)
 * — the event is stored with process_error (operator alert + sweep rule 6
 * reprocessing once the collision is fixed) and acknowledged so the carrier
 * does not retry-loop. Never guess. */
export class AmbiguousResolutionError extends Error {}

/** Non-terminal statuses — the live set for fallback resolution (F4). */
const LIVE_STATUSES = [
  "pending", "sold", "label_issued", "in_transit", "delivered",
  "disputed", "refunding", "payout_pending",
] as const;

export function carrierWebhookRouter(cfg: OrderFlowConfig = orderFlowConfig()): Router {
  const router = express.Router();
  router.post(
    "/api/webhooks/carrier",
    express.raw({ type: "application/json", limit: "512kb" }),
    (req, res) => {
      void handleCarrierWebhook(req, res, cfg);
    },
  );
  return router;
}

async function handleCarrierWebhook(req: Request, res: Response, cfg: OrderFlowConfig): Promise<void> {
  // THI-66 V1 fix: void-mounted async handler — a rejection escaping the
  // body is an unhandled rejection, and Node >= 15 crashes the whole process
  // (THI-58 class) on any DB fault during an EasyPost delivery. One barrier
  // around the entire ingest body: log, best-effort mark, 500 (EasyPost
  // redelivers). 'ingest failed:' marks the row for sweep rule 6 (PR-8) so a
  // stored-but-unprocessed row is never swallowed by the dedupe path.
  let externalId: string | null = null;
  try {
    await ingestCarrierWebhook(req, res, cfg, (id) => (externalId = id));
  } catch (err) {
    console.error("[webhooks:carrier] ingest failed:", (err as Error).message);
    if (externalId) {
      await pool
        .query(
          "UPDATE webhook_events SET process_error = $2 WHERE source = 'carrier' AND external_id = $1 AND processed_at IS NULL",
          [externalId, `ingest failed: ${(err as Error).message}`.slice(0, 500)],
        )
        .catch(() => undefined);
    }
    if (!res.headersSent) res.status(500).json({ error: "processing failed" });
  }
}

async function ingestCarrierWebhook(
  req: Request,
  res: Response,
  cfg: OrderFlowConfig,
  onExternalId: (id: string) => void,
): Promise<void> {
  if (!cfg.carrierWebhookReady) {
    // Fail-closed 503 stub (F1): API key set but webhook secret unset.
    res.status(503).json({ error: "carrier webhook not configured" });
    return;
  }

  // F12: non-JSON content-type, empty body → 400 before anything is written.
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json") || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "expected application/json body" });
    return;
  }

  const provider = getShippingProvider(cfg);

  // Verify over RAW bytes via the provider (A3/F13 rotation handled inside
  // the adapter, including the old-secret warning). VerificationError's
  // wireMessage keeps every 400 body byte-identical to the pre-interface
  // endpoint. Nothing is written before verification succeeds.
  try {
    provider.verifyWebhook(req.body, req.headers as Record<string, string | undefined>);
  } catch (err) {
    if (err instanceof VerificationError) {
      res.status(400).json({ error: err.wireMessage });
      return;
    }
    throw err; // unexpected — caught by the ingest barrier → 500
  }

  // Parse only after verification (§5.3) and REDACT at parse (F6, adapter):
  // free-text tracking details never leave the adapter; only ids, statuses,
  // timestamps reach the store.
  let ev: RedactedCarrierEvent;
  try {
    ev = provider.parseWebhook(req.body);
  } catch (err) {
    if (err instanceof WebhookParseError) {
      res.status(400).json({ error: err.wireMessage });
      return;
    }
    throw err;
  }

  // Deterministic content id (adapter): a byte-identical redelivery dedupes
  // to one row; any content change is a new event (see file header).
  const externalId = provider.dedupeId(req.body);
  onExternalId(externalId);

  const payload = ev;

  const stored = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (source, external_id, payload)
     VALUES ('carrier', $1, $2::jsonb) ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
    [externalId, JSON.stringify(payload)],
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
      await processCarrierEvent(payload, externalId, db, cfg);
      await db.query("UPDATE webhook_events SET processed_at = now() WHERE id = $1", [storedId]);
      await db.query("COMMIT");
      res.status(200).json({ received: true });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        // Stale-but-valid (§5.4 rule 4): late/out-of-order — not an error.
        await db.query("UPDATE webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1", [
          storedId,
          `stale: ${err.message}`.slice(0, 500),
        ]);
        await db.query("COMMIT");
        res.status(200).json({ received: true, stale: true });
        return;
      }
      if (err instanceof AmbiguousResolutionError) {
        // F4: skip + operator alert. processed_at stays NULL so sweep rule 6
        // (PR-8) reprocesses this row once the collision is resolved.
        await db.query("UPDATE webhook_events SET process_error = $2 WHERE id = $1", [
          storedId,
          `skipped: ${err.message}`.slice(0, 500),
        ]);
        await db.query("COMMIT");
        res.status(200).json({ received: true, skipped: true });
        return;
      }
      throw err;
    }
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    // Retry-safe: record the failure so sweep rule 6 can reprocess (PR-8);
    // 500 tells EasyPost to redeliver.
    await pool
      .query("UPDATE webhook_events SET process_error = $2 WHERE id = $1", [storedId, (err as Error).message.slice(0, 500)])
      .catch(() => undefined);
    res.status(500).json({ error: "processing failed" });
  } finally {
    db.release();
  }
}

// ---------------------------------------------------------------------------
// Event processing

/** F4 resolution: tracker_id first; (carrier, tracking_code) fallback only
 * on exactly one live match. Zero → skip; multiple → skip + operator alert. */
async function resolveOrder(
  db: PoolClient,
  ev: RedactedCarrierEvent,
): Promise<{ order: OrderRow | undefined; note: string | undefined }> {
  if (ev.tracker_id) {
    const { rows } = await db.query<OrderRow>("SELECT * FROM orders WHERE tracker_id = $1", [ev.tracker_id]);
    if (rows[0]) return { order: rows[0], note: undefined };
  }
  if (!ev.carrier || !ev.tracking_code) return { order: undefined, note: undefined };
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE carrier = $1 AND tracking_code = $2
       AND status = ANY($3) ORDER BY created_at`,
    [ev.carrier, ev.tracking_code, LIVE_STATUSES],
  );
  if (rows.length === 1) return { order: rows[0], note: undefined };
  if (rows.length > 1) {
    console.error(
      `[webhooks:carrier] operator alert: ambiguous tracking resolution — ${rows.length} live orders match ` +
        `${ev.carrier} ${ev.tracking_code}; event skipped, never guessed (F4)`,
    );
    return { order: undefined, note: `ambiguous: ${rows.length} live orders match carrier+tracking_code` };
  }
  return { order: undefined, note: "no live order matches carrier+tracking_code" };
}

// Exported for sweep rule 6 reprocessing (§4.5): the stored payload is the
// redacted carrier event, sufficient for reprocessing without the provider.
export async function processCarrierEvent(
  ev: RedactedCarrierEvent,
  externalId: string,
  db: PoolClient,
  cfg: OrderFlowConfig,
): Promise<void> {
  if (!ev.tracker_id) return; // non-tracker EasyPost event — stored, acked

  const { order, note } = await resolveOrder(db, ev);
  if (!order) {
    if (note?.startsWith("ambiguous")) {
      throw new AmbiguousResolutionError(note);
    }
    return; // not ours (or terminal via tracker_id lookup path) — stored, acked
  }

  const actor = { type: "carrier" as const, id: ev.tracker_id };
  const eventPayload = { status: ev.status, occurred_at: ev.occurred_at, tracker_id: ev.tracker_id };

  switch (ev.status) {
    case "pre_transit":
    case "unknown":
      // Logged on the timeline; no transition (§5.2).
      await db.query(
        `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload, dedupe_key)
         VALUES ($1, 'carrier_update', 'carrier', $2, $3::jsonb, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [order.id, ev.tracker_id, JSON.stringify(eventPayload), `carrier:${externalId}`],
      );
      return;
    case "in_transit":
    case "out_for_delivery":
      // #10 label_issued → in_transit
      await applyTransition({ orderId: order.id, trigger: "carrier_update", actor, dedupeKey: `carrier:${externalId}`, client: db });
      return;
    case "delivered": {
      // #12 in_transit → delivered; carrier-confirmed → standard window (F10
      // long window is for system auto-confirms only).
      const disputeDeadline = new Date(Date.now() + cfg.disputeWindowHours * 3600_000);
      await applyTransition({
        orderId: order.id, trigger: "carrier_update", actor,
        dedupeKey: `carrier:${externalId}`, sets: { dispute_deadline: disputeDeadline }, client: db,
      });
      return;
    }
    case "return_to_sender":
    case "failure": {
      // #14/#14b in_transit → refunding|cancelled. Lost/failure → item
      // deleted (goods presumed gone); RTS → item back active (spec table).
      // Stripe mode: refund FIRST under refund:{order_id} idempotency (F3) —
      // reconcile, never recreate, if a refund already exists.
      // §6 carrier-failure split: with a platform label the buyer's line is
      // refunded (the deployment's procurement failed — carrier claim is the
      // remedy); after own-label record_tracking the line was already
      // refunded via labelrefund, and the settle-aware helper deducts it.
      const sets: { refund_id?: string } = {};
      let refund: Awaited<ReturnType<typeof createRefundForOrder>> | null = null;
      if (order.payment_mode === "stripe" && !order.refund_id) {
        if (!order.payment_intent_id) {
          throw new Error(`order ${order.id} is paid but has no payment_intent_id; refusing to refund blindly`);
        }
        const stripe = getStripe();
        if (!stripe) throw new Error("stripe unavailable for carrier-failure refund");
        refund = await createRefundForOrder(order, order.payment_intent_id, stripe, "include_label");
        // B1 (THI-1013): a zero remainder settles with no refund_id — the
        // transition must still fire; nothing_due replays stay idempotent.
        if (refund.id) sets.refund_id = refund.id;
      }
      const override: { itemStatusOverride?: ItemStatus } =
        ev.status === "return_to_sender" ? { itemStatusOverride: "active" as ItemStatus } : {};
      const next = await applyTransition({
        orderId: order.id, trigger: "carrier_failure", actor,
        reason: `carrier reported ${ev.status}`,
        dedupeKey: `carrier:${externalId}`, ...(sets.refund_id ? { sets } : {}), ...override, client: db,
      });
      // B1 (THI-1013): a nothing-due refund never produces the webhook that
      // would confirm it — settle the unwind inline instead of wedging in
      // `refunding` until the rule-7 alert.
      await settleNothingDueRefund(next, refund);
      return;
    }
  }
}
