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
import { emailAllowedByPrefs, parseNotificationPrefs } from "./prefs.js";
import { planOperatorAlert } from "./operator.js";

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

type SkipReason = "no_address" | "not_verified" | "bounced" | "opted_out";

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

/** Account gates resolved by `to_email` (unique in sellers): one lookup
 *  returns verification, bounce suppression, and preferences together —
 *  THE one place plan §5's policy classes are enforced (Phase 2 / THI-780):
 *  unverified → skip (Phase 0 gate), bounced → skip (never hammer a
 *  bouncing address), opted-out per class → skip (money class locked on).
 *  Rows whose address matches no account (stale snapshot, removed account)
 *  skip as not_verified — fail closed. */
async function accountGate(
  db: PoolClient,
  row: OutboxRow,
): Promise<{ ok: true } | { ok: false; reason: SkipReason }> {
  // Internal operator rows (notification_id NULL, operator.* template) ride
  // the outbox for delivery/retry but are not account mail — no account
  // gates apply (operator-alerts PR of this phase).
  if (row.notification_id === null && row.template.startsWith("operator.")) return { ok: true };
  const acct = await db.query<{ verified: boolean; bounced: boolean; prefs: unknown }>(
    `SELECT (email_verified_at IS NOT NULL) AS verified,
            (email_bounced_at IS NOT NULL) AS bounced,
            profile->'notification_prefs' AS prefs
       FROM sellers WHERE email = $1`,
    [row.to_email],
  );
  const a = acct.rows[0];
  if (!a || !a.verified) return { ok: false, reason: "not_verified" };
  if (a.bounced) return { ok: false, reason: "bounced" };
  if (!emailAllowedByPrefs(parseNotificationPrefs(a.prefs), row.template)) {
    return { ok: false, reason: "opted_out" };
  }
  return { ok: true };
}

async function markFailure(db: PoolClient, row: OutboxRow, error: string): Promise<"retried" | "dead"> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE email_outbox SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`,
      [row.id, attempts, error],
    );
    // THI-780 PR 4: dead-letters surface in the operator mailbox too (once
    // per outbox row, opalert dedupe; same transaction — the alert and the
    // dead status commit together). Log-only posture when the env is unset.
    await planOperatorAlert({
      kind: "dead_letter",
      ref: row.id,
      subject: `Email dead-lettered (${row.template}) — Thingery`,
      payload: {
        title: `Outbox row dead after ${MAX_ATTEMPTS} attempts`,
        lines: [
          `Outbox: ${row.id}`,
          `To: ${row.to_email || "(no address)"}`,
          `Template: ${row.template}`,
          `Error: ${error.slice(0, 300)}`,
        ],
      },
      client: db,
    });
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
      // Account gates — Phase 0 verification, bounce suppression, and the
      // Phase 2 preference policy classes, all in one place (accountGate):
      // not_verified / bounced / opted_out are permanent skips.
      const gate = await accountGate(client, row);
      if (!gate.ok) {
        await markSkipped(client, row.id, gate.reason);
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
        // THI-780 PR 2: opt-in mail (digests) carries a one-click unsubscribe
        // URL in its payload — stamp the standard headers when present. The
        // body always carries the link too (provider header-stripping hedge).
        const unsubscribeUrl =
          typeof row.payload.unsubscribe_url === "string" ? row.payload.unsubscribe_url : undefined;
        result = await mailer.send({
          to: row.to_email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          idempotencyKey: `outbox-${row.id}`, // stable across retries
          ...(unsubscribeUrl
            ? {
                headers: {
                  "List-Unsubscribe": `<${unsubscribeUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
              }
            : {}),
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
