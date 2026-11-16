// THI-760 plan Phase 2 / THI-780 PR 4: operator alerts. DB-backed (skips
// without Postgres — CI runs it). Invariants: unset OPERATOR_ALERT_EMAIL ⇒
// log-only, zero outbox rows (Phase 1 posture); set ⇒ one account-less
// operator.* row per subject (opalert dedupe absorbs sweep re-runs);
// dead-letter alerts ride the delivery transaction.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runSweeps } from "../src/orders-sweep.js";
import { orderFlowConfig, type OrderFlowConfig } from "../src/config.js";
import { runNotifyDelivery, MAX_ATTEMPTS } from "../src/notify/delivery.js";
import { planOperatorAlert } from "../src/notify/operator.js";
import { renderOperatorAlert } from "../src/notify/templates.js";
import { notifyConfig } from "../src/config.js";
import type { Mailer, MailMessage, MailSendResult } from "../src/mailer.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
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

const OPS = "ops-thi780@example.test";

class FailingMailer implements Mailer {
  readonly kind = "dry_run" as const;
  async send(_message: MailMessage): Promise<MailSendResult> {
    return { ok: false, error: "permanent provider failure" };
  }
}

describe("renderOperatorAlert (THI-780 PR 4 — pure)", () => {
  it("title + lines + canonical footer, PII-free shape", () => {
    const r = renderOperatorAlert({ title: "Order stuck in payout_pending", lines: ["Order: 123", "Action: inspect"] });
    expect(r.subject).toBe("Order stuck in payout_pending");
    expect(r.text).toContain("Order: 123");
    expect(r.text).toContain("open item database and MCP server");
  });
});

describe.skipIf(!available)("operator alerts (THI-780 PR 4 — DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  let cfg: OrderFlowConfig;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  async function seedSeller(): Promise<string> {
    const email = `thi780op-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-780 Ops', now()) RETURNING id`, [email],
    );
    return r.rows[0].id;
  }

  async function seedOrder(status: string, days: number): Promise<string> {
    const seller = await seedSeller();
    const buyer = await seedSeller();
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, category, price_cents, currency, status)
       VALUES ($1, $2, 'other', 5000, 'EUR', 'active') RETURNING id`,
      [seller, `Ops ${runTag} ${crypto.randomUUID().slice(0, 6)}`],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, payment_mode, price_cents,
                           shipping_price_cents, currency, fulfillment, status_changed_at)
       VALUES ($1, $2, $3, $4, 'off_platform', 5000, 0, 'EUR', 'shipping', now() - ($5 || ' days')::interval)
       RETURNING id`,
      [item.rows[0].id, seller, buyer, status, String(days)],
    );
    return order.rows[0].id;
  }

  async function operatorRows(): Promise<Array<{ template: string; to_email: string }>> {
    const r = await db.query(
      "SELECT template, to_email FROM email_outbox WHERE template LIKE 'operator.%' AND to_email = $1", [OPS],
    );
    return r.rows;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));
    cfg = orderFlowConfig();
  });
  afterAll(async () => {
    consoleError.mockRestore();
    delete process.env.OPERATOR_ALERT_EMAIL;
    await db.end().catch(() => {});
  });

  it("unset OPERATOR_ALERT_EMAIL ⇒ log-only: no rows ever", async () => {
    delete process.env.OPERATOR_ALERT_EMAIL;
    await planOperatorAlert({ kind: "stuck_money", ref: `unset-${runTag}`, subject: "s", payload: {}, toEmail: notifyConfig().operatorAlertEmail });
    expect(notifyConfig().operatorAlertEmail).toBeUndefined();
    const before = await operatorRows();
    await runSweeps(cfg, new Date());
    expect(await operatorRows()).toHaveLength(before.length);
  });

  it("rule 7 (stuck money) → one operator.stuck_money row per order, once", async () => {
    process.env.OPERATOR_ALERT_EMAIL = OPS;
    const stuck = await seedOrder("payout_pending", 8); // > 7d default
    await runSweeps(cfg, new Date());
    const rows = await operatorRows();
    const mine = rows.filter((r) => r.template === "operator.stuck_money.v1");
    expect(mine.length).toBeGreaterThanOrEqual(1);
    // Replay: the 10-minute sweep must not re-alert.
    await runSweeps(cfg, new Date());
    expect((await operatorRows()).filter((r) => r.template === "operator.stuck_money.v1")).toHaveLength(mine.length);
    void stuck;
  });

  it("rule 9 (stale dispute) → one operator.stale_dispute row per order, once", async () => {
    await seedOrder("disputed", 8);
    await runSweeps(cfg, new Date());
    const rows = (await operatorRows()).filter((r) => r.template === "operator.stale_dispute.v1");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await runSweeps(cfg, new Date());
    expect((await operatorRows()).filter((r) => r.template === "operator.stale_dispute.v1")).toHaveLength(rows.length);
  });

  it("delivery dead-letter → operator.dead_letter row, same transaction", async () => {
    const seller = await seedSeller();
    const email = (await db.query<{ email: string }>("SELECT email FROM sellers WHERE id = $1", [seller])).rows[0].email;
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'seller.item_sold', 'seller', '{}'::jsonb, $2) RETURNING id`,
      [seller, `thi780op:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, attempts, next_attempt_at)
       VALUES ($1, $2, 's', 'seller.item_sold.v1', '{}'::jsonb, $3, $4, now() - interval '1 minute') RETURNING id`,
      [notif.rows[0].id, email, notif.rows[0].id, MAX_ATTEMPTS - 1],
    );
    const cfgOn = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });
    const r = await runNotifyDelivery(cfgOn, new FailingMailer());
    expect(r.dead).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ status: string }>("SELECT status FROM email_outbox WHERE id = $1", [outbox.rows[0].id]);
    expect(row.rows[0].status).toBe("dead");
    const dead = (await operatorRows()).filter((x) => x.template === "operator.dead_letter.v1");
    expect(dead.length).toBeGreaterThanOrEqual(1);
  });
});
