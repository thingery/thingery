// THI-760 plan Phase 2 / THI-780 PR 1: policy gating inside the delivery
// sweep — THE one place preferences are enforced (plan §5). DB-backed (skips
// without Postgres; CI runs it). Cases: ordinary opt-out → skipped:opted_out,
// locked money class ignores the opt-out and sends, bounced address →
// skipped:bounced with pending rows cancelled, operator rows bypass account
// gates, address that matches no account fails closed to not_verified.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runNotifyDelivery } from "../src/notify/delivery.js";
import type { Mailer, MailMessage, MailSendResult } from "../src/mailer.js";
import { notifyConfig } from "../src/config.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

class ScriptedMailer implements Mailer {
  readonly kind = "dry_run" as const;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push({ ...message });
    return { ok: true };
  }
}

describe.skipIf(!available)("delivery preference gating (THI-780 PR 1 — DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  const cfg = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });

  async function seedAccount(opts: {
    verified?: boolean;
    bounced?: boolean;
    prefs?: unknown;
  } = {}): Promise<{ id: string; email: string }> {
    const email = `thi780g-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const profile = opts.prefs === undefined ? "{}" : JSON.stringify({ notification_prefs: opts.prefs });
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at, email_bounced_at, profile)
       VALUES ($1, 'x', 'THI-780 Gate', $2, $3, $4::jsonb) RETURNING id`,
      [email, opts.verified === false ? null : new Date(), opts.bounced ? new Date() : null, profile],
    );
    return { id: r.rows[0].id, email };
  }

  async function seedOutbox(account: { id: string; email: string }, template: string): Promise<string> {
    const payload = JSON.stringify({
      order_id: crypto.randomUUID(), item_id: crypto.randomUUID(), item_title: "Vintage denim jacket",
      amount_cents: 1234, currency: "EUR", order_status: "pending",
    });
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, $2, 'buyer', $3::jsonb, $4) RETURNING id`,
      [account.id, template.replace(/\.v1$/, ""), payload, `thi780g:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
       VALUES ($1, $2, 's', $3, $4::jsonb, $5, now() - interval '1 minute') RETURNING id`,
      [notif.rows[0].id, account.email, template, payload, notif.rows[0].id],
    );
    return outbox.rows[0].id;
  }

  async function status(id: string): Promise<{ status: string; last_error: string | null }> {
    const r = await db.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [id],
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));
  });
  afterAll(async () => {
    await db.end().catch(() => {});
  });

  it("ordinary transactional + opted out → skipped:opted_out", async () => {
    const account = await seedAccount({ prefs: { transactional_orders: "in_app" } });
    const id = await seedOutbox(account, "seller.item_sold.v1");
    const mailer = new ScriptedMailer();
    const report = await runNotifyDelivery(cfg, mailer);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    const s = await status(id);
    expect(s.status).toBe("skipped");
    expect(s.last_error).toBe("skipped:opted_out");
    expect(mailer.sent).toHaveLength(0);
  });

  it("locked money class ignores the opt-out and sends", async () => {
    const account = await seedAccount({ prefs: { transactional_orders: "in_app" } });
    const id = await seedOutbox(account, "buyer.refund_confirmed.v1");
    const mailer = new ScriptedMailer();
    await runNotifyDelivery(cfg, mailer);
    expect(await status(id)).toMatchObject({ status: "sent", last_error: null });
    expect(mailer.sent.some((m) => m.to === account.email)).toBe(true);
  });

  it("bounced address → skipped:bounced (even money class — a bouncing address never gets hammered)", async () => {
    const account = await seedAccount({ bounced: true });
    const id = await seedOutbox(account, "buyer.refund_confirmed.v1");
    const mailer = new ScriptedMailer();
    await runNotifyDelivery(cfg, mailer);
    expect(await status(id)).toMatchObject({ status: "skipped", last_error: "skipped:bounced" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("to_email matching no account fails closed to skipped:not_verified", async () => {
    const account = await seedAccount();
    const id = await seedOutbox(account, "seller.item_sold.v1");
    await db.query("UPDATE email_outbox SET to_email = 'stale-thi780@example.test' WHERE id = $1", [id]);
    await runNotifyDelivery(cfg, new ScriptedMailer());
    expect(await status(id)).toMatchObject({ status: "skipped", last_error: "skipped:not_verified" });
  });

  it("operator rows (notification_id NULL, operator.* template) bypass account gates", async () => {
    // Not an account address at all — the gate must pass it to the send
    // attempt (the template renders in the operator-alerts PR; here the
    // render error leaves it pending, proving it was NOT account-skipped).
    const r = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
       VALUES (NULL, 'ops-thi780@example.test', 'operator alert', 'operator.stuck_money.v1', '{}'::jsonb, $1, now() - interval '1 minute')
       RETURNING id`,
      [`operator:${crypto.randomUUID()}`],
    );
    await runNotifyDelivery(cfg, new ScriptedMailer());
    const s = await status(r.rows[0].id);
    expect(s.status).toBe("pending"); // attempted, not skipped:not_verified
    expect(s.last_error).not.toContain("skipped:");
  });

  it("Phase 0 gate unchanged: unverified → skipped:not_verified", async () => {
    const account = await seedAccount({ verified: false });
    const id = await seedOutbox(account, "seller.item_sold.v1");
    await runNotifyDelivery(cfg, new ScriptedMailer());
    expect(await status(id)).toMatchObject({ status: "skipped", last_error: "skipped:not_verified" });
  });
});
