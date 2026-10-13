// Carrier (EasyPost) webhook endpoint (spec THI-3 rev 2 §4.3/§5.2–§5.4; PR-7).
//
// Mount BEFORE the global express.json() (index.ts, same as the Stripe
// webhook) — the HMAC signature is computed over raw bytes, so this router
// consumes express.raw({ application/json, 512kb }) itself (F12).
//
// Protocol (§5.4 — verify → store → process → mark):
//   1. HMAC-SHA256 over the raw body via the `X-Hmac-Signature` header,
//      compared with crypto.timingSafeEqual on the digests (never === on
//      strings); the length-mismatch throw is caught → 400 (F12). Current
//      secret, then EASYPOST_WEBHOOK_SECRET_PREVIOUS during rotation (F13).
//      JSON is parsed only AFTER verification succeeds (§5.3).
//   2. Store REDACTED (F6): EasyPost `tracking_details` carry signed-for
//      names and free-text facility descriptions — they never touch the
//      store. Only description/mode/tracker ids/status/timestamps persist.
//      Dedupe: EasyPost tracker webhooks carry no per-delivery event id, so
//      external_id is a deterministic content hash (sha256 of the raw body)
//      — a byte-identical redelivery dedupes to one row; any content change
//      is a new event, and the transition guard keeps re-application a no-op.
//   3. Process transactionally: event→order resolution (F4, §5.2) —
//      `tracker_id` first (UNIQUE, unambiguous); `(carrier, tracking_code)`
//      fallback only with EXACTLY ONE live (non-terminal) match; zero →
//      skip, multiple → skip + operator alert; never guess. Then the
//      normalized status drives #10/#12/#14/#14b via the PR-2 core.
//   4. Stale-but-valid transitions (late/duplicate/out-of-order) are NOT
//      errors — 200, no state change; the machine is the arbiter. Real
//      failures set process_error and return 500 so EasyPost retries
//      (sweep rule 6, PR-8, reprocesses stored-but-errored rows).

import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { orderFlowConfig, type OrderFlowConfig } from "./config.js";
import { applyTransition, IllegalTransitionError, type ItemStatus, type OrderRow } from "./orders.js";
import { createRefundForOrder, getStripe } from "./stripe.js";

/** F4 ambiguous resolution: multiple live orders match (carrier, tracking_code)
 * — the event is stored with process_error (operator alert + sweep rule 6
 * reprocessing once the collision is fixed) and acknowledged so EasyPost does
 * not retry-loop. Never guess. */
export class AmbiguousResolutionError extends Error {}

/** Normalized carrier status (§5.2) — the carrier never leaks into the machine. */
type NormalizedStatus =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "return_to_sender"
  | "failure"
  | "unknown";

/** EasyPost tracker statuses → normalized (§5.2). `available_for_pickup` is
 * still pre-delivery (the parcel waits at a location) → out_for_delivery
 * bucket → #10. Tracker-level `cancelled`/`error` (bad code, not carrier
 * failure) and anything unrecognized → unknown — logged, never a transition. */
const EASYPOST_STATUS_MAP: Readonly<Record<string, NormalizedStatus>> = Object.freeze({
  pre_transit: "pre_transit",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  available_for_pickup: "out_for_delivery",
  delivered: "delivered",
  return_to_sender: "return_to_sender",
  failure: "failure",
});

/** Non-terminal statuses — the live set for fallback resolution (F4). */
const LIVE_STATUSES = [
  "pending", "sold", "label_issued", "in_transit", "delivered",
  "disputed", "refunding", "payout_pending",
] as const;

function normalizeStatus(raw: string | undefined): NormalizedStatus {
  return (raw && EASYPOST_STATUS_MAP[raw]) || "unknown";
}

/** §5.3: timing-safe HMAC-SHA256 (hex) compare; catches the length-mismatch
 * throw — both digests and header are attacker-controlled lengths. */
function verifyEasyPostSignature(raw: Buffer, header: string, secret: string): boolean {
  try {
    const digest = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
    const provided = Buffer.from(header.trim().toLowerCase(), "utf8");
    return digest.length === provided.length && crypto.timingSafeEqual(digest, provided);
  } catch {
    return false;
  }
}

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

  const signature = req.headers["x-hmac-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "missing X-Hmac-Signature header" });
    return;
  }
  // A3 (THI-66): surface old-secret verification so rotation completion is
  // visible in logs, mirroring the Stripe handler (F13).
  const verifiedCurrent = verifyEasyPostSignature(req.body, signature, cfg.easypostWebhookSecret!);
  const verifiedPrevious =
    !verifiedCurrent &&
    cfg.easypostWebhookSecretPrevious !== undefined &&
    verifyEasyPostSignature(req.body, signature, cfg.easypostWebhookSecretPrevious);
  if (verifiedPrevious) {
    console.warn("[webhooks:carrier] verified with EASYPOST_WEBHOOK_SECRET_PREVIOUS — finish the rotation");
  }
  if (!verifiedCurrent && !verifiedPrevious) {
    res.status(400).json({ error: "signature verification failed" });
    return;
  }

  // Parse only after verification (§5.3). Invalid JSON with a valid
  // signature is still a 400 — nothing was verifiable content.
  let parsed: EasyPostWebhook;
  try {
    parsed = JSON.parse(req.body.toString("utf8")) as EasyPostWebhook;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  // Deterministic content id: EasyPost tracker webhooks carry no per-delivery
  // event id, so dedupe on the raw bytes' sha256 (see file header).
  const externalId = `easypost:${crypto.createHash("sha256").update(req.body).digest("hex")}`;
  onExternalId(externalId);

  // F6: REDACT at ingest — tracking_details (signed-for names, facility
  // free text) never touch the store; only ids, statuses, timestamps.
  const result = parsed.result;
  const lastDetail = Array.isArray(result?.tracking_details) ? result.tracking_details.at(-1) : undefined;
  const payload = {
    description: typeof parsed.description === "string" ? parsed.description : null,
    mode: parsed.mode === "test" || parsed.mode === "production" ? parsed.mode : null,
    tracker_id: typeof result?.id === "string" ? result.id : null,
    tracking_code: typeof result?.tracking_code === "string" ? result.tracking_code : null,
    carrier: typeof result?.carrier === "string" ? result.carrier : null,
    carrier_status: typeof result?.status === "string" ? result.status : null,
    status: result ? normalizeStatus(result.status) : null,
    occurred_at: typeof lastDetail?.datetime === "string" ? lastDetail.datetime : null,
  };

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

interface EasyPostTrackingDetail {
  status?: string;
  message?: string;
  datetime?: string;
}

interface EasyPostWebhook {
  description?: string;
  mode?: string;
  result?: {
    id?: string;
    tracking_code?: string;
    carrier?: string;
    status?: string;
    tracking_details?: EasyPostTrackingDetail[];
  };
}

interface RedactedCarrierEvent {
  description: string | null;
  mode: string | null;
  tracker_id: string | null;
  tracking_code: string | null;
  carrier: string | null;
  carrier_status: string | null;
  status: NormalizedStatus | null;
  occurred_at: string | null;
}

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

async function processCarrierEvent(
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
      const sets: { refund_id?: string } = {};
      if (order.payment_mode === "stripe" && !order.refund_id) {
        if (!order.payment_intent_id) {
          throw new Error(`order ${order.id} is paid but has no payment_intent_id; refusing to refund blindly`);
        }
        const stripe = getStripe();
        if (!stripe) throw new Error("stripe unavailable for carrier-failure refund");
        const refund = await createRefundForOrder(order, order.payment_intent_id, stripe);
        sets.refund_id = refund.id;
      }
      const override: { itemStatusOverride?: ItemStatus } =
        ev.status === "return_to_sender" ? { itemStatusOverride: "active" as ItemStatus } : {};
      await applyTransition({
        orderId: order.id, trigger: "carrier_failure", actor,
        reason: `carrier reported ${ev.status}`,
        dedupeKey: `carrier:${externalId}`, ...(sets.refund_id ? { sets } : {}), ...override, client: db,
      });
      return;
    }
  }
}
