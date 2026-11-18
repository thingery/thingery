// THI-760 plan Phase 2 / THI-780 PR 3: item/account-level notifications that
// are NOT order transitions — payout onboarding badge (Stripe account.updated),
// stale-sale / stuck-transit warnings (sweep rules 2/3 pre-checks), moderation
// takedown. These plan a notification + email outbox row directly (the digest
// pattern) because they are time- or webhook-derived, not order_events. Every
// insert is ON CONFLICT (dedupe_key) DO NOTHING — at-most-once per subject,
// replay-safe (webhook-idempotency lens). The delivery sweep remains the
// single choke point: all of these are orders-class, so the seller's
// transactional_orders pref applies, and the account gate (verified, not
// bounced) applies before any send.

import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { templateKeyFor } from "./templates.js";

/** Plan one notification + one outbox email. At-most-once per dedupe_key.
 * Returns the notification id when newly inserted, null when deduped.
 * `client` lets callers ride an existing transaction (e.g. the Stripe
 * webhook handler — the badge commits or rolls back with the event). */
export async function planAccountNotification(p: {
  recipientId: string;
  toEmail: string | null | undefined;
  eventType: string;
  role: "buyer" | "seller";
  subject: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  client?: PoolClient;
}): Promise<string | null> {
  const own = !p.client;
  const client = p.client ?? (await pool.connect());
  try {
    if (own) await client.query("BEGIN");
    const notif = await client.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [p.recipientId, p.eventType, p.role, JSON.stringify(p.payload), p.dedupeKey],
    );
    if (!notif.rows[0]) {
      if (own) await client.query("COMMIT"); // already planned — replay-safe no-op
      return null;
    }
    await client.query(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [notif.rows[0].id, p.toEmail ?? "", p.subject, templateKeyFor(p.eventType), JSON.stringify(p.payload), `${notif.rows[0].id}`],
    );
    if (own) await client.query("COMMIT");
    return notif.rows[0].id;
  } catch (err) {
    if (own) await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    if (own) client.release();
  }
}
