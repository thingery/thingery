// THI-760 plan Phase 2 / THI-780 PR 3: item/account-level notifications.
// Pure template checks first, then DB (skips without Postgres — CI runs it):
// sweep warnings (rules 2/3 half-window pre-checks), the Stripe
// account.updated payout badge (NULL→set flip, once per Stripe account), and
// the moderation takedown admin route.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import { runSweeps } from "../src/orders-sweep.js";
import { orderFlowConfig, type OrderFlowConfig } from "../src/config.js";
import { processStripeEvent } from "../src/webhooks-stripe.js";
import { mountApiRoutes } from "../src/routes.js";
import {
  renderSellerDeadlineWarning,
  renderSellerItemTakenDown,
  renderSellerPayoutsEnabled,
} from "../src/notify/templates.js";

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

describe("item-event templates (THI-780 PR 3 — pure)", () => {
  it("payouts-enabled: canonical footer, no PII", () => {
    const r = renderSellerPayoutsEnabled();
    expect(r.subject).toBe("Payouts enabled — Thingery");
    expect(r.text).toContain("open item database and MCP server");
    expect(r.text).not.toContain("@");
  });
  it("deadline warnings: kind-specific copy, item title, no PII", () => {
    const facts = {
      itemTitle: "Vintage denim jacket", amountCents: 1234, currency: "EUR",
      orderStatus: "sold", orderUrl: "https://thingery.test/order/o1",
    };
    const stale = renderSellerDeadlineWarning({ ...facts, kind: "stale_sale" });
    expect(stale.subject).toContain("Action needed");
    expect(stale.text).toContain("no shipping has been recorded");
    const stuck = renderSellerDeadlineWarning({ ...facts, kind: "stuck_transit", orderStatus: "in_transit" });
    expect(stuck.subject).toContain("Shipping stalled");
    expect(stuck.text).toContain("has not moved");
  });
  it("takedown: states the reason, links the item, no reply-to ask", () => {
    const r = renderSellerItemTakenDown({
      itemTitle: "Lava lamp", itemUrl: "https://thingery.test/item/x", reason: "prohibited item",
    });
    expect(r.subject).toBe("Listing removed: Lava lamp — Thingery");
    expect(r.text).toContain("prohibited item");
    expect(r.text).not.toContain("reply to this email");
    expect(r.text).toContain("open item database and MCP server");
  });
});

describe.skipIf(!available)("item events (THI-780 PR 3 — DB)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let cfg: OrderFlowConfig;
  let sellerEmail = "";
  let sellerId = "";
  let itemId = "";
  let orderId = "";
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  async function seedSeller(): Promise<{ id: string; email: string }> {
    const email = `thi780ie-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-780 ItemEvents', now()) RETURNING id`, [email],
    );
    return { id: r.rows[0].id, email };
  }

  /** Order in `status` with status_changed_at backdated `days` days. */
  async function seedOrder(status: "sold" | "in_transit", days: number, owner: { id: string; email: string }): Promise<string> {
    const buyer = await seedSeller();
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, category, price_cents, currency, status)
       VALUES ($1, $2, 'other', 5000, 'EUR', 'active') RETURNING id`,
      [owner.id, `Item ${runTag} ${crypto.randomUUID().slice(0, 6)}`],
    );
    itemId = item.rows[0].id;
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, payment_mode, price_cents,
                           shipping_price_cents, currency, fulfillment, status_changed_at)
       VALUES ($1, $2, $3, $4, 'off_platform', 5000, 0, 'EUR', 'shipping', now() - ($5 || ' days')::interval)
       RETURNING id`,
      [item.rows[0].id, owner.id, buyer.id, status, String(days)],
    );
    return order.rows[0].id;
  }

  async function notifications(recipientId: string, eventType: string): Promise<number> {
    const r = await db.query(
      "SELECT count(*)::int AS c FROM notifications WHERE recipient_id = $1 AND event_type = $2",
      [recipientId, eventType],
    );
    return r.rows[0].c;
  }
  async function outboxFor(notificationEvent: string, email: string): Promise<Array<{ status: string }>> {
    const r = await db.query(
      `SELECT o.status FROM email_outbox o JOIN notifications n ON n.id = o.notification_id
        WHERE n.event_type = $1 AND o.to_email = $2`, [notificationEvent, email],
    );
    return r.rows;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));
    cfg = orderFlowConfig(); // defaults: staleSoldDays 21, inTransitStuckDays 21

    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    consoleError.mockRestore();
    server?.close();
    await db.end().catch(() => {});
  });

  it("rule 2 warns at half the stale-sale window, before the hard cancel, exactly once", async () => {
    const seller = await seedSeller();
    sellerId = seller.id;
    sellerEmail = seller.email;
    orderId = await seedOrder("sold", 12, seller); // > 10.5d (half of 21), < 21d
    await runSweeps(cfg, new Date());
    expect(await notifications(seller.id, "seller.stale_sale_warning")).toBe(1);
    expect((await outboxFor("seller.stale_sale_warning", seller.email))).toHaveLength(1);
    // Not yet the hard deadline: order stays sold, item untouched.
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status).toBe("sold");
    // Replay: sweep runs every 10 min — still one warning.
    await runSweeps(cfg, new Date());
    expect(await notifications(seller.id, "seller.stale_sale_warning")).toBe(1);
  });

  it("rule 3 warns for stuck-transit at half the window, exactly once", async () => {
    const seller = await seedSeller();
    const id = await seedOrder("in_transit", 12, seller);
    await runSweeps(cfg, new Date());
    expect(await notifications(seller.id, "seller.stuck_transit_warning")).toBe(1);
    await runSweeps(cfg, new Date());
    expect(await notifications(seller.id, "seller.stuck_transit_warning")).toBe(1);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status).toBe("in_transit");
  });

  it("account.updated NULL→set flip badges the seller once per Stripe account", async () => {
    const seller = await seedSeller();
    const acct = `acct_${runTag}_${crypto.randomUUID().slice(0, 8)}`;
    await db.query("UPDATE sellers SET stripe_account_id = $2 WHERE id = $1", [seller.id, acct]);
    const ev = {
      id: `evt_${crypto.randomUUID().slice(0, 10)}`, type: "account.updated", livemode: false,
      data: { object: { id: acct, capabilities: { transfers: "active" } } },
    } as unknown as Stripe.Event;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await processStripeEvent(ev, client, cfg);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await db.query<{ ok: boolean }>("SELECT stripe_onboarded_at IS NOT NULL AS ok FROM sellers WHERE id = $1", [seller.id])).rows[0].ok).toBe(true);
    expect(await notifications(seller.id, "seller.payouts_enabled")).toBe(1);

    // Redelivery of the same event: no second badge.
    const client2 = await db.connect();
    try {
      await client2.query("BEGIN");
      await processStripeEvent(ev, client2, cfg);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    expect(await notifications(seller.id, "seller.payouts_enabled")).toBe(1);

    // Transfers revoked: timestamp cleared, no badge churn.
    const off = {
      id: `evt_${crypto.randomUUID().slice(0, 10)}`, type: "account.updated", livemode: false,
      data: { object: { id: acct, capabilities: { transfers: "pending" } } },
    } as unknown as Stripe.Event;
    const client3 = await db.connect();
    try {
      await client3.query("BEGIN");
      await processStripeEvent(off, client3, cfg);
      await client3.query("COMMIT");
    } finally {
      client3.release();
    }
    expect((await db.query<{ ok: boolean }>("SELECT stripe_onboarded_at IS NULL AS ok FROM sellers WHERE id = $1", [seller.id])).rows[0].ok).toBe(true);
    expect(await notifications(seller.id, "seller.payouts_enabled")).toBe(1);
  });

  it("takedown route: auth matrix + item removed + seller notified once", async () => {
    process.env.ADMIN_API_KEY = `k-${crypto.randomBytes(24).toString("hex")}`;
    try {
      const seller = await seedSeller();
      const item = await db.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, category, price_cents, currency, status)
         VALUES ($1, $2, 'other', 5000, 'EUR', 'active') RETURNING id`,
        [seller.id, `Takedown ${runTag}`],
      );
      const url = `${base}/api/admin/items/${item.rows[0].id}/takedown`;

      // Wrong key → 401.
      expect((await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x" }) })).status).toBe(401);
      // Missing reason → 400.
      expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(400);

      // Happy path → item deleted, seller notified.
      const ok = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ reason: "prohibited item" }) });
      expect(ok.status).toBe(200);
      expect((await ok.json()).status).toBe("deleted");
      expect((await db.query("SELECT status FROM items WHERE id = $1", [item.rows[0].id])).rows[0].status).toBe("deleted");
      expect(await notifications(seller.id, "seller.item_taken_down")).toBe(1);
      expect((await outboxFor("seller.item_taken_down", seller.email))).toHaveLength(1);

      // Idempotent replay of the takedown → 404 (already deleted).
      expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ reason: "prohibited item" }) })).status).toBe(404);
      expect(await notifications(seller.id, "seller.item_taken_down")).toBe(1);
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("takedown route: unset admin key → 404 (route indistinguishable from absent)", async () => {
    const had = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      const res = await fetch(`${base}/api/admin/items/00000000-0000-0000-0000-000000000000/takedown`, { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      if (had) process.env.ADMIN_API_KEY = had;
    }
  });
});
