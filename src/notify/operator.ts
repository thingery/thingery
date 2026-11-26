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
//
// THI-1451 (THI-1479 plan Phase C): the same mechanism now also mirrors
// committed ITEM reports to the report alias — planItemReportEmail writes
// one account-less ops.item_reported.v1 row (dedupe report:{id}) inside the
// report's own transaction; the sweep delivers it off the request path.
// Same dark-default knob (REPORT_ALERT_EMAIL), same PII-minimal body
// discipline, same at-most-once dedupe.

import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { notifyConfig } from "../config.js";

export type OperatorAlertKind =
  | "stuck_money"
  | "stale_dispute"
  | "dead_letter"
  | "label_refund_stack"
  | "label_line_refund_stuck"
  | "suppression_self"
  | "suppression_volume"
  // THI-1611 §A3: dispute on a terminal order (never a silent drop) and its
  // escalation twin when the automatic transfer reversal fails.
  | "post_payout_chargeback"
  | "reversal_failed";

/** Shared account-less outbox writer: one row (notification_id NULL) with
 *  ON CONFLICT (dedupe_key) DO NOTHING, ride-or-own transaction. Riding
 *  someone else's transaction never breaks the caller's state machine over
 *  an alert — swallow and log; owning (no client) propagates failures so
 *  background callers see them. */
async function planAccountlessEmail(p: {
  to: string | null;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  client?: PoolClient;
  logLabel: string;
}): Promise<void> {
  if (!p.to) return; // log-only posture — no address, no row
  const own = !p.client;
  const client = p.client ?? (await pool.connect());
  try {
    if (own) await client.query("BEGIN");
    await client.query(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key)
       VALUES (NULL, $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [p.to, p.subject, p.template, JSON.stringify(p.payload), p.dedupeKey],
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
    console.error(p.logLabel, err);
  } finally {
    if (own) client.release();
  }
}

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
  await planAccountlessEmail({
    to,
    subject: p.subject,
    template: `operator.${p.kind}.v1`,
    payload: { kind: p.kind, ...p.payload },
    dedupeKey: `opalert:${p.ref}`,
    client: p.client,
    logLabel: "[notify] operator alert insert failed:",
  });
}

/** THI-1451 (THI-1479 plan Phase C): plan the alias email for one committed
 * item report — an account-less ops.item_reported.v1 row to the report
 * alias (REPORT_ALERT_EMAIL, prod: report@thingery.dev). Deliberately
 * bypasses the Phase 0 verified-recipient gate: the report alias is an
 * internal mailbox, not a marketplace account (the delivery gate exempts
 * account-less ops.* rows for the same reason it exempts operator.*).
 * Dedupe key `report:{id}`: at-most-once per report, ever. Pass `client` to
 * ride the report INSERT transaction (createItemReport does — the row
 * commits iff the report commits). Payload is PII-minimal: report id, item
 * id, reason slug, timestamp — never the motivation free-text (UNTRUSTED
 * user content stays in the reports table / triage task, the sources of
 * truth). Unset REPORT_ALERT_EMAIL ⇒ log-only (no row), the same dark
 * default as operator alerts — a self-hosted deployment must not mail the
 * Thingery project alias by default. */
export async function planItemReportEmail(p: {
  reportId: string;
  itemId: string;
  reason: string;
  createdAt: Date;
  client?: PoolClient;
  /** Defaults to notifyConfig() — inject for tests. */
  toEmail?: string | null;
}): Promise<void> {
  const to = p.toEmail !== undefined ? p.toEmail : notifyConfig().reportAlertEmail ?? null;
  await planAccountlessEmail({
    to,
    subject: "New item report — Thingery",
    template: "ops.item_reported.v1",
    payload: {
      report_id: p.reportId,
      item_id: p.itemId,
      reason: p.reason,
      created_at: p.createdAt.toISOString(),
    },
    dedupeKey: `report:${p.reportId}`,
    client: p.client,
    logLabel: "[notify] item report email insert failed:",
  });
}
