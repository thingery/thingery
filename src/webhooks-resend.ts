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
//      THI-1537: during a rotation window RESEND_WEBHOOK_SECRET_PREVIOUS is
//      accepted as a fallback (zero-downtime rotation, F13 pattern).
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
//   5. THI-1537: after the suppression writes, anomaly alerting —
//      self-suppression of OPERATOR_ALERT_EMAIL and windowed suppression
//      volume both plan a deduped operator.* alert row (log-only when the
//      mailbox is unset).
//
// Idempotency: all writes are guarded conditional UPDATEs — a redelivered
// bounce is a no-op (webhook-idempotency lens).

import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { notifyConfig, type NotifyConfig } from "./config.js";
import { pool } from "./db.js";
import { planOperatorAlert } from "./notify/operator.js";

/** Replay tolerance for the signed timestamp (seconds). */
const TIMESTAMP_TOLERANCE_S = 5 * 60;

/** THI-1537: suppression-anomaly alerting. Distinct accounts newly
 * suppressed (sellers.email_bounced_at) within this window before the
 * volume alert fires — email_bounced_at is set only by this webhook, so
 * the count is exactly "addresses this channel suppressed in the window".
 * A mass real bounce (provider incident) and a forged-bounce flood look
 * identical here; the operator alert body says to check the per-event log
 * lines before acting. */
const SUPPRESSION_VOLUME_WINDOW_H = 1;
/** Alert threshold for the window above. Generous for this platform's
 * mail volume (suppressions are normally a trickle); low enough that a
 * forged-bounce flood against distinct accounts trips inside the first
 * batch. Exported for the regression tests. */
export const SUPPRESSION_VOLUME_ALERT_THRESHOLD = 10;

/** UTC hour bucket ("2026-11-26T01") for alert dedupe refs: redelivered
 * webhook events within the hour dedupe to one alert; a re-attack or a
 * still-anomalous next hour re-alerts (at-most-once per period, the same
 * cadence idea as the digest sweep). */
function hourBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 13);
}

/** THI-1537: forged-bounce observability. Suppression events used to be
 * one silent container log line — a forged bounce/complaint durably
 * suppressed a chosen address with no operator-visible signal. Two
 * triggers, both best-effort AFTER the suppression writes (the writes are
 * the job; the alert is telemetry — a failure here surfaces as a 500 so
 * Resend redelivers, and idempotency makes the retry safe):
 *  - self-suppression: the event hit OPERATOR_ALERT_EMAIL itself — the
 *    blinding attack (pending operator rows to that address were just
 *    flipped to skipped). The alert row still delivers: account-less
 *    operator.* rows bypass the delivery account gates.
 *  - volume anomaly: ≥ SUPPRESSION_VOLUME_ALERT_THRESHOLD distinct
 *    accounts suppressed in the window. PII-minimal body (count, window,
 *    marker — never the tripping address).
 * Unset OPERATOR_ALERT_EMAIL ⇒ planOperatorAlert plans nothing (log-only
 * posture, same dark default as every other operator alert). */
async function alertOnSuppressionAnomaly(
  cfg: NotifyConfig,
  p: { email: string; marker: string; accountsMatched: number; pendingSkipped: number },
): Promise<void> {
  const operatorAddress = cfg.operatorAlertEmail?.trim().toLowerCase() ?? null;
  if (operatorAddress && p.email === operatorAddress) {
    console.warn("[webhooks:resend] suppression hit the operator alert address:", p.email);
    await planOperatorAlert({
      kind: "suppression_self",
      ref: `suppression-self:${p.marker}:${p.email}:${hourBucket()}`,
      subject: "Email suppression hit the operator alert address — Thingery",
      payload: {
        title: "A bounce/complaint suppression event hit the operator alert mailbox",
        lines: [
          `Event: email.${p.marker}`,
          `Address: ${p.email} (the operator alert mailbox)`,
          `Sellers rows matched: ${p.accountsMatched}`,
          `Pending outbox rows skipped: ${p.pendingSkipped}`,
          "If this was not a real provider bounce it is a forged suppression —",
          "re-arm the address (clear sellers.email_bounced_at) and rotate the",
          "webhook secret if the source is unknown. This alert row itself",
          "bypasses the account gates, so it still delivers.",
        ],
      },
    });
  }
  const recent = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM sellers
      WHERE email_bounced_at > now() - make_interval(hours => $1)`,
    [SUPPRESSION_VOLUME_WINDOW_H],
  );
  const suppressed = Number(recent.rows[0]?.c ?? 0);
  if (suppressed >= SUPPRESSION_VOLUME_ALERT_THRESHOLD) {
    console.warn(
      `[webhooks:resend] suppression volume anomaly: ${suppressed} accounts in ${SUPPRESSION_VOLUME_WINDOW_H}h`,
    );
    await planOperatorAlert({
      kind: "suppression_volume",
      ref: `suppression-volume:${hourBucket()}`,
      subject: `Suppression volume anomaly: ${suppressed} accounts in ${SUPPRESSION_VOLUME_WINDOW_H}h — Thingery`,
      payload: {
        title: "Bounce/complaint suppression volume is anomalous",
        lines: [
          `Accounts newly suppressed in the last ${SUPPRESSION_VOLUME_WINDOW_H}h: ${suppressed}`,
          `Alert threshold: ${SUPPRESSION_VOLUME_ALERT_THRESHOLD}`,
          `Last event: email.${p.marker} (address withheld — check the [webhooks:resend] log lines)`,
          "A mass real bounce (provider incident) and a forged-bounce flood both",
          "look like this: read the per-event suppressed log lines before acting.",
        ],
      },
    });
  }
}

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
  const cfg = notifyConfig();
  const secret = cfg.resendWebhookSecret;
  if (!secret) {
    // Fail-closed stub: an unconfigured deployment has no live webhook to
    // trust — indistinguishable from absent (F1, admin-route pattern).
    // RESEND_WEBHOOK_SECRET_PREVIOUS never bypasses this (config gates it
    // on the current secret; the check order makes it unreachable anyway).
    res.status(503).json({ error: "resend webhook not configured" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json") || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "expected application/json body" });
    return;
  }
  if (!verifyResendSignature(req.body, req.headers["resend-signature"] as string | undefined, secret)) {
    // THI-1537: zero-downtime rotation tolerance — accept the previous
    // secret during a rotation window (mirrors STRIPE_WEBHOOK_SECRET_PREVIOUS
    // / F13 in webhooks-stripe.ts). Current secret stays authoritative:
    // unset previous ⇒ exactly today's single-secret 400 path.
    const previous = cfg.resendWebhookSecretPrevious;
    if (!previous || !verifyResendSignature(req.body, req.headers["resend-signature"] as string | undefined, previous)) {
      res.status(400).json({ error: "signature verification failed" });
      return;
    }
    console.warn("[webhooks:resend] verified with RESEND_WEBHOOK_SECRET_PREVIOUS — finish the rotation");
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
  // THI-1537: operator visibility for the suppression channel — see
  // alertOnSuppressionAnomaly. Runs after the idempotent writes, so a
  // redelivery-only retry is a no-op for the suppression itself.
  await alertOnSuppressionAnomaly(cfg, {
    email,
    marker,
    accountsMatched: account.rows.length,
    pendingSkipped: pending.rows.length,
  });
  res.json({ ok: true, suppressed: true });
}
