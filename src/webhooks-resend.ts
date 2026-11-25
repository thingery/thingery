// Resend bounce webhook (THI-760 plan Phase 2 / THI-780; plan §2.2/§5
// bounce suppression). Mounted BEFORE the global express.json() (index.ts,
// same as the Stripe/carrier webhooks) — the HMAC is computed over raw
// bytes, so this router consumes express.raw({ application/json, 256kb })
// itself.
//
// Protocol (Resend signs `t=<unix>,v1=<base64 hmac>` over `<t>.<rawBody>`):
//   1. Fail-closed 503 stub until RESEND_WEBHOOK_SECRET is set (F1 — same
//      posture as the other webhook routers).
//   2. Verify the HMAC-SHA256 signature with crypto.timingSafeEqual on the
//      digests (never === on strings); reject stale timestamps (> 5 min) so
//      a captured payload cannot be replayed forever.
//   3. JSON is parsed only AFTER verification (§5.3 discipline).
//   4. `email.bounced` and `email.complained` (THI-1486) → suppress: set
//      sellers.email_bounced_at (once — idempotent UPDATE … WHERE NULL)
//      and flip that address's pending outbox rows to skipped with a
//      type-specific marker (skipped:bounced / skipped:complained).
//      email_bounced_at is the GENERAL email-suppression timestamp: the
//      delivery sweep's accountGate (src/notify/delivery.ts) and the
//      verification re-arm gate (src/auth.ts issueEmailVerification) both
//      read it, so a complained address stops receiving every account
//      mail class too. The trigger source stays observable via the outbox
//      marker + the log line. Every other event type is acknowledged 200
//      without action (Resend must not retry-loop on events we
//      deliberately ignore).
//
// Idempotency: all writes are guarded conditional UPDATEs — a redelivered
// bounce is a no-op (webhook-idempotency lens).

import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { notifyConfig } from "./config.js";
import { pool } from "./db.js";

/** Replay tolerance for the signed timestamp (seconds). */
const TIMESTAMP_TOLERANCE_S = 5 * 60;

export function resendWebhookRouter(): Router {
  const router = express.Router();
  router.post(
    "/api/webhooks/resend",
    express.raw({ type: "application/json", limit: "256kb" }),
    (req, res) => {
      void handleResendWebhook(req, res).catch((err) => {
        // Void-mounted: never let a DB fault become an unhandled rejection
        // (THI-58 class) — answer 500 so Resend redelivers.
        console.error("[webhooks:resend] handler failed:", err);
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      });
    },
  );
  return router;
}

/** Pure signature check, exported for tests. The header is
 *  `t=<unix seconds>,v1=<base64(HMAC-SHA256(secret, `${t}.${rawBody}`))>`. */
export function verifyResendSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!header) return false;
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("=");
    const val = rest.join("=").trim();
    if (k?.trim() === "t") t = val;
    else if (k?.trim() === "v1") v1 = val;
  }
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TIMESTAMP_TOLERANCE_S) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleResendWebhook(req: Request, res: Response): Promise<void> {
  const secret = notifyConfig().resendWebhookSecret;
  if (!secret) {
    // Fail-closed stub: an unconfigured deployment has no live webhook to
    // trust — indistinguishable from absent (F1, admin-route pattern).
    res.status(503).json({ error: "resend webhook not configured" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json") || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "expected application/json body" });
    return;
  }
  if (!verifyResendSignature(req.body, req.headers["resend-signature"] as string | undefined, secret)) {
    res.status(400).json({ error: "signature verification failed" });
    return;
  }

  let event: { type?: string; data?: { email?: string } };
  try {
    event = JSON.parse(req.body.toString("utf8")) as { type?: string; data?: { email?: string } };
  } catch {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }

  // Suppression-class events (THI-780 bounces, THI-1486 complaints): the
  // marker is the type-specific last_error tag recorded on skipped rows.
  const marker = event.type === "email.bounced" ? "bounced" : event.type === "email.complained" ? "complained" : null;
  if (!marker) {
    res.json({ ok: true, ignored: event.type ?? "unknown" });
    return;
  }
  const email = typeof event.data?.email === "string" ? event.data.email.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ error: "suppression event without email" });
    return;
  }
  // Suppress: mark the account once; cancel everything still pending to the
  // address. Idempotent — redelivery changes nothing.
  const account = await pool.query<{ id: string }>(
    "UPDATE sellers SET email_bounced_at = now() WHERE email = $1 AND email_bounced_at IS NULL RETURNING id",
    [email],
  );
  const pending = await pool.query(
    `UPDATE email_outbox SET status = 'skipped', last_error = $2
      WHERE to_email = $1 AND status = 'pending' RETURNING id`,
    [email, `skipped:${marker}`],
  );
  console.log(
    `[webhooks:resend] ${marker} suppressed: email=${email} account=${account.rows.length > 0 ? account.rows[0].id : "none"} ` +
      `pending_skipped=${pending.rows.length}`,
  );
  res.json({ ok: true, suppressed: true });
}
