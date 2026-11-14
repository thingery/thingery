// Email-outbox delivery sweep (THI-760 plan Phase 1 / THI-763 PR 4; plan
// §2.2/§4 sweep 2). Claims due outbox rows and walks each through the
// explicit state machine:
//
//   pending --send ok--> sent
//   pending --permanent skip (no address / unverified)--> skipped
//   pending --send fail, attempts < MAX--> pending (next_attempt_at = now + backoff)
//   pending --send fail, attempts >= MAX--> dead
//
// Every transition is one guarded UPDATE; rows are claimed with
// FOR UPDATE SKIP LOCKED so a second app instance can never double-send, and
// the claim itself is inside the sweep transaction. Rate caps
// (per-recipient/hour, per-run) leave rows pending — an over-cap recipient is
// never burned an attempt. With NOTIFY_EMAIL_ENABLED=false (the default)
// the sweep claims nothing: outbox rows accumulate pending — the dark-deploy
// posture the board asked for.

import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { notifyConfig, type NotifyConfig } from "../config.js";
import type { Mailer, MailSendResult } from "../mailer.js";
import { renderOrderEmail } from "./templates.js";

/** Claim batch per pass (plan §4: "small batches"; per-run cap default 50
 *  bounds it further). */
const CLAIM_BATCH = 50;
/** Dead-letter after this many failed attempts (plan §2.2: 1m→…→6h ladder). */
export const MAX_ATTEMPTS = 8;
/** Exponential backoff: 1m, 2m, 4m, … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), 6 * 3_600_000);
}

interface OutboxRow {
  id: string;
  notification_id: string | null;
  to_email: string;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface DeliveryReport {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  dead: number;
  rateLimited: number;
}

type SkipReason = "no_address" | "not_verified";

// All three markers run on the sweep's transaction client: the claim holds
// FOR UPDATE locks on these rows, so a pool connection would deadlock
// against the sweep's own transaction (and then hit the pool's 3s
// statement_timeout) — same-connection updates never block.
async function markSent(db: PoolClient, id: string, providerMessageId?: string): Promise<void> {
  await db.query(
    `UPDATE email_outbox SET status = 'sent', sent_at = now(), provider_message_id = $2,
            attempts = attempts + 1, last_error = NULL WHERE id = $1`,
    [id, providerMessageId ?? null],
  );
}

async function markSkipped(db: PoolClient, id: string, reason: SkipReason): Promise<void> {
  await db.query(
    `UPDATE email_outbox SET status = 'skipped', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, `skipped:${reason}`],
  );
}

async function markFailure(db: PoolClient, row: OutboxRow, error: string): Promise<"retried" | "dead"> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE email_outbox SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`,
      [row.id, attempts, error],
    );
    return "dead";
  }
  await db.query(
    `UPDATE email_outbox SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval
      WHERE id = $1`,
    [row.id, attempts, error, String(backoffMs(attempts))],
  );
  return "retried";
}

/**
 * One delivery pass. Pure-ish seams: `mailer` and `now` are injectable so
 * tests drive every transition without a provider.
 */
export async function runNotifyDelivery(
  cfg: NotifyConfig = notifyConfig(),
  mailer: Mailer,
  now: Date = new Date(),
): Promise<DeliveryReport> {
  const report: DeliveryReport = { claimed: 0, sent: 0, skipped: 0, retried: 0, dead: 0, rateLimited: 0 };
  if (!cfg.emailEnabled) return report; // dark deploy: claim nothing

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Claim due rows (SKIP LOCKED: multi-instance safe), oldest first.
    const claimed = await client.query<OutboxRow>(
      `SELECT id, notification_id, to_email, subject, template, payload, attempts
         FROM email_outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [Math.min(CLAIM_BATCH, cfg.maxSendsPerSweep)],
    );
    report.claimed = claimed.rows.length;
    if (claimed.rows.length === 0) {
      await client.query("COMMIT");
      return report;
    }

    // Group by recipient — per-recipient hourly cap (default 6/h) counts
    // sends already recorded in this hour; over-cap rows stay pending
    // WITHOUT burning an attempt.
    const sentThisHour = new Map<string, number>();
    if (cfg.maxEmailsPerRecipientPerHour > 0) {
      const counts = await client.query<{ to_email: string; c: string }>(
        `SELECT to_email, count(*)::text AS c FROM email_outbox
          WHERE status = 'sent' AND sent_at > now() - interval '1 hour'
          GROUP BY to_email`,
      );
      for (const r of counts.rows) sentThisHour.set(r.to_email, Number(r.c));
    }

    for (const row of claimed.rows) {
      if (row.to_email === "") {
        await markSkipped(client, row.id, "no_address");
        report.skipped++;
        continue;
      }
      // Verification gate (Phase 0's email_verified_at): one join per row —
      // the recipient snapshot lives on the notification.
      const verified = await client.query<{ verified: boolean }>(
        `SELECT (s.email_verified_at IS NOT NULL) AS verified
           FROM notifications n JOIN sellers s ON s.id = n.recipient_id
          WHERE n.id = $1`,
        [row.notification_id],
      );
      if (!verified.rows[0]?.verified) {
        await markSkipped(client, row.id, "not_verified");
        report.skipped++;
        continue;
      }
      const used = sentThisHour.get(row.to_email) ?? 0;
      if (used >= cfg.maxEmailsPerRecipientPerHour) {
        report.rateLimited++; // leave pending; next sweep re-claims
        continue;
      }

      let result: MailSendResult;
      try {
        const rendered = renderOrderEmail(row.template.replace(/\.v1$/, ""), row.payload, cfg.publicBaseUrl);
        result = await mailer.send({
          to: row.to_email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          idempotencyKey: `outbox-${row.id}`, // stable across retries
        });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        await markSent(client, row.id, result.providerMessageId);
        sentThisHour.set(row.to_email, used + 1);
        report.sent++;
      } else {
        const outcome = await markFailure(client, row, result.error);
        report[outcome]++;
      }
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

/** Boot run + interval, same posture as the fan-out timer. */
export function startNotifyDeliveryTimer(cfg: NotifyConfig = notifyConfig(), mailer: Mailer): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runNotifyDelivery(cfg, mailer);
      if (r.claimed > 0) console.log(`[notify-delivery] ${JSON.stringify(r)}`);
    } catch (err) {
      console.error("[notify-delivery] sweep failed:", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), cfg.sweepIntervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
