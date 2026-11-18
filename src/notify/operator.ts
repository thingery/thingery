// THI-760 plan Phase 2 / THI-780 PR 4: operator alerts. Sweep rules 7/9 and
// the delivery sweep's dead-letters already console.error; this PR mirrors
// them into the operator's mailbox when OPERATOR_ALERT_EMAIL is set —
// as account-less outbox rows (notification_id NULL, template operator.*),
// which the delivery gate deliberately bypasses (an operator address is not
// a marketplace account). Unset ⇒ log-only, exactly the Phase 1 behavior:
// the knob is dark by default (DevOps enablement wires it with the other
// notify env). At-most-once per subject via ON CONFLICT (dedupe_key
// opalert:{ref}) — a stuck order alerts once, not once per 10-minute sweep
// run (webhook-idempotency lens). Bodies are PII-free: ids, statuses,
// error strings.

import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { notifyConfig } from "../config.js";

export type OperatorAlertKind = "stuck_money" | "stale_dispute" | "dead_letter" | "label_refund_stack";

/** Plan one operator alert email. `ref` is the stable subject of the alert
 * (order id / outbox id); the dedupe key absorbs sweep re-runs and webhook
 * replays. Pass `client` to ride an existing transaction (the delivery
 * sweep's dead-letter path — same row, same commit). */
export async function planOperatorAlert(p: {
  kind: OperatorAlertKind;
  ref: string;
  subject: string;
  payload: Record<string, unknown>;
  client?: PoolClient;
  /** Defaults to notifyConfig() — inject for tests. */
  toEmail?: string | null;
}): Promise<void> {
  const to = p.toEmail !== undefined ? p.toEmail : notifyConfig().operatorAlertEmail ?? null;
  if (!to) return; // log-only posture (Phase 1) — no address, no row
  const own = !p.client;
  const client = p.client ?? (await pool.connect());
  try {
    if (own) await client.query("BEGIN");
    await client.query(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key)
       VALUES (NULL, $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [to, p.subject, `operator.${p.kind}.v1`, JSON.stringify({ kind: p.kind, ...p.payload }), `opalert:${p.ref}`],
    );
    if (own) await client.query("COMMIT");
  } catch (err) {
    if (own) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    // Riding someone else's transaction: never break the caller's state
    // machine over an alert — swallow and log (the console.error above the
    // call site is the floor).
    console.error("[notify] operator alert insert failed:", err);
  } finally {
    if (own) client.release();
  }
}
