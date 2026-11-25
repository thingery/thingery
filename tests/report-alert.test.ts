// THI-1451 (THI-1479 plan Phase C): item report → report@thingery.dev alias
// email. DB-backed (skips without Postgres — CI runs it). Invariants:
// unset REPORT_ALERT_EMAIL ⇒ log-only, zero outbox rows (dark default — a
// self-hosted deployment must never mail the Thingery project alias);
// set ⇒ exactly one account-less ops.item_reported.v1 row per report
// (dedupe report:{id} absorbs any replay), written in the report INSERT
// transaction; the delivery sweep sends it PAST the Phase 0 verified-
// recipient gate (account-less ops.* rows are internal mail, not account
// mail) as notifications@; the body is PII-minimal (no motivation).
// Review reports intentionally mirror nothing.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createItemReport, createReviewReport, itemReportLimiter } from "../src/reports.js";
import { runNotifyDelivery } from "../src/notify/delivery.js";
import { renderOrderEmail } from "../src/notify/templates.js";
import { notifyConfig } from "../src/config.js";
import type { MailMessage, Mailer, MailSendResult } from "../src/mailer.js";

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

const ALERT_TO = "report-thi1451@example.test";

/** Mailer double: records every send (kind "provider" — THI-1046 refuses to
 *  claim from a dry_run mailer). */
class RecordingMailer implements Mailer {
  readonly kind = "provider" as const;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push({ ...message });
    return { ok: true, providerMessageId: `thi1451-${this.sent.length}` };
  }
}

describe("renderOrderEmail ops.item_reported (THI-1451 — pure)", () => {
  it("PII-minimal body: ids + item URL + reason + timestamp, canonical footer", () => {
    const r = renderOrderEmail(
      "ops.item_reported",
      {
        report_id: "rep-1",
        item_id: "itm-2",
        reason: "scam_fraud",
        created_at: "2026-11-25T12:00:00.000Z",
      },
      "https://thingery.test",
    );
    expect(r.subject).toBe("New item report — Thingery");
    expect(r.text).toContain("Report: rep-1");
    expect(r.text).toContain("Item: https://thingery.test/item/itm-2");
    expect(r.text).toContain("Reason: scam_fraud");
    expect(r.text).toContain("Reported at: 2026-11-25T12:00:00.000Z");
    expect(r.text).toContain("open item database and MCP server");
    // No free-text field exists in the payload by construction — assert the
    // body is exactly the four alert lines + footer (no motivation carrier).
    expect(r.text.match(/Report:|Item:|Reason:|Reported at:/g)).toHaveLength(4);
  });

  it("REPORT_ALERT_EMAIL config: unset/blank ⇒ undefined (dark default), set ⇒ value", () => {
    expect(notifyConfig({}).reportAlertEmail).toBeUndefined();
    expect(notifyConfig({ REPORT_ALERT_EMAIL: " " }).reportAlertEmail).toBeUndefined(); // F1 empty-is-unset
    expect(notifyConfig({ REPORT_ALERT_EMAIL: "report@thingery.dev" }).reportAlertEmail).toBe("report@thingery.dev");
  });
});

describe.skipIf(!available)("planItemReportEmail + createItemReport (THI-1451 — DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  async function mkSeller(name: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`thi1451-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
    );
    return r.rows[0].id;
  }

  async function mkItem(ownerId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'thi1451 fixture', 100, 'other') RETURNING id`,
      [ownerId],
    );
    return r.rows[0].id;
  }

  async function alertRows(): Promise<Array<Record<string, unknown>>> {
    const r = await db.query(
      "SELECT notification_id, to_email, template, payload, dedupe_key FROM email_outbox WHERE template = 'ops.item_reported.v1' AND to_email = $1",
      [ALERT_TO],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));
  });
  afterEach(async () => {
    // Row-level isolation: the suite shares the DB with the whole CI run,
    // so each test starts with a clean ops.item_reported.v1 slate.
    await db.query("DELETE FROM email_outbox WHERE template = 'ops.item_reported.v1' AND to_email = $1", [ALERT_TO]);
  });

  afterAll(async () => {
    consoleError.mockRestore();
    delete process.env.REPORT_ALERT_EMAIL;
    await db.end().catch(() => {});
  });

  it("unset REPORT_ALERT_EMAIL ⇒ log-only: no row, report still succeeds", async () => {
    delete process.env.REPORT_ALERT_EMAIL;
    const reporter = await mkSeller("Reporter dark");
    const seller = await mkSeller("Seller dark");
    const itemId = await mkItem(seller);
    const report = await createItemReport(
      { itemId, reporterAccountId: reporter, reason: "other", motivation: "dark default: no email please" },
      itemReportLimiter,
    );
    expect(await alertRows()).toHaveLength(0);
    void report;
  });

  it("set ⇒ exactly one account-less row, atomic with the report, PII-minimal payload", async () => {
    process.env.REPORT_ALERT_EMAIL = ALERT_TO;
    const reporter = await mkSeller("Reporter");
    const seller = await mkSeller("Seller");
    const itemId = await mkItem(seller);
    const report = await createItemReport(
      { itemId, reporterAccountId: reporter, reason: "scam_fraud", motivation: "motivation stays in the table" },
      itemReportLimiter,
    );
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.notification_id).toBeNull(); // account-less: bypasses the Phase 0 gate
    expect(row.to_email).toBe(ALERT_TO);
    expect(row.template).toBe("ops.item_reported.v1");
    expect(row.dedupe_key).toBe(`report:${report.id}`);
    const payload = row.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["created_at", "item_id", "reason", "report_id"]);
    expect(payload.report_id).toBe(report.id);
    expect(payload.item_id).toBe(itemId);
    expect(payload.reason).toBe("scam_fraud");
    expect(typeof payload.created_at).toBe("string");
    expect(JSON.stringify(payload)).not.toContain("motivation");
  });

  it("duplicate report ⇒ no second row (dedupe report:{id})", async () => {
    const reporter = await mkSeller("Reporter dup");
    const seller = await mkSeller("Seller dup");
    const itemId = await mkItem(seller);
    await createItemReport(
      { itemId, reporterAccountId: reporter, reason: "other", motivation: "first report in this test" },
      itemReportLimiter,
    );
    await expect(
      createItemReport(
        { itemId, reporterAccountId: reporter, reason: "other", motivation: "second report must dedupe" },
        itemReportLimiter,
      ),
    ).rejects.toMatchObject({ code: "duplicate" });
    expect(await alertRows()).toHaveLength(1);
  });

  it("review report ⇒ no ops.item_reported row (scope: item reports only)", async () => {
    const reporter = await mkSeller("Reporter rev");
    const author = await mkSeller("Review author");
    const item = await mkItem(author);
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, payment_mode, price_cents, shipping_price_cents, currency, fulfillment, status_changed_at)
       VALUES ($1, $2, $3, 'completed', 'off_platform', 100, 0, 'EUR', 'shipping', now()) RETURNING id`,
      [item, author, reporter],
    );
    const review = await db.query<{ id: string }>(
      `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, text, buyer_first_name, item_title)
       VALUES ($1, $2, $2, $3, 5, 'fine', 'Rev', 'Fixture title thi1451') RETURNING id`,
      [order.rows[0].id, author, item],
    );
    await createReviewReport(
      { reviewId: review.rows[0].id, reporterAccountId: reporter, reason: "other", motivation: "review reports stay email-less" },
      itemReportLimiter,
    );
    expect(await alertRows()).toHaveLength(0);
  });

  it("delivery sweep sends the ops row past the verified gate, as notifications@", async () => {
    process.env.REPORT_ALERT_EMAIL = ALERT_TO;
    const reporter = await mkSeller("Reporter sweep");
    const seller = await mkSeller("Seller sweep");
    const itemId = await mkItem(seller);
    await createItemReport(
      { itemId, reporterAccountId: reporter, reason: "explicit_images", motivation: "sweep delivery assertion" },
      itemReportLimiter,
    );
    // ALERT_TO matches no sellers row — an account mail row would skip as
    // not_verified; the account-less ops.* row must deliver anyway.
    const cfg = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });
    const mailer = new RecordingMailer();
    const r = await runNotifyDelivery(cfg, mailer);
    const mine = mailer.sent.filter((m) => m.to === ALERT_TO);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0].from).toBe(cfg.digestFromAddress); // notifications@ — internal stream (THI-1280)
    expect(mine[0].subject).toBe("New item report — Thingery");
    expect(mine[0].text).toContain("/item/");
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const status = await db.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM email_outbox WHERE to_email = $1 AND template = 'ops.item_reported.v1'",
      [ALERT_TO],
    );
    expect(status.rows.every((x) => x.status === "sent")).toBe(true);
  });
});
