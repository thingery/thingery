// Admin dispute pages (spec docs/specs/admin-dispute-ui.md, THI-562 work
// item 3, PR-B): GET /admin/disputes list (cap 50, empty state) and
// GET /admin/disputes/:id detail (order_events history, read-only order
// messages when present, masked address + logged reveal). Uniform 404 for
// non-disputed / non-existent / malformed ids; output encoding (B2) and
// no-store (B3) pinned per the THI-566 review. DB-backed over real HTTP.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, adminAttemptLimiter, adminPageLimiter, signAdminSession } from "../src/routes.js";
import { applyTransition } from "../src/orders.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET ??= "s".repeat(64);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
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

describe.skipIf(!available)("admin dispute pages (spec admin-dispute-ui PR-B)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let cookie: string;
  let csrf: string;
  let consoleLog: ReturnType<typeof spyLog>;
  let createdMessagesTable = false;

  function spyLog() {
    return vi.spyOn(console, "log").mockImplementation(() => {});
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    process.env.ADMIN_API_KEY = "a".repeat(40);
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
    const s = signAdminSession();
    cookie = `admin_session=${s.cookie}`;
    csrf = s.csrf;
  });
  afterAll(async () => {
    if (createdMessagesTable) await db.query("DROP TABLE IF EXISTS order_messages").catch(() => {});
    consoleLog?.mockRestore();
    delete process.env.ADMIN_API_KEY;
    server.close();
    await db.end();
  });
  beforeEach(() => {
    adminAttemptLimiter.reset();
    adminPageLimiter.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (pathName: string, withSession = true) =>
    fetch(`${base}${pathName}`, { redirect: "manual", headers: withSession ? { cookie } : {} });
  const postForm = (pathName: string, body: Record<string, string>, withSession = true) =>
    fetch(`${base}${pathName}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(withSession ? { cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });

  let n = 0;
  /** Walks a real order to disputed via the state machine (audit trail included). */
  async function seedDisputed(opts: { title?: string; buyerName?: string } = {}): Promise<string> {
    n += 1;
    const s = `bps${n}`;
    const b = `bpb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
      [`thg_${s}`, opts.sellerName ?? s, `${s}@t.dev`, `thg_${b}`, opts.buyerName ?? b, `${b}@t.dev`],
    );
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) SELECT id, $1, 10000, 500 FROM sellers WHERE email = $2 RETURNING id",
      [opts.title ?? `B item ${n}`, `${s}@t.dev`],
    );
    const order = await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, shipping_address)
       SELECT $1, s.id, b.id, 10000, 500, 'EUR', 'shipping', 'off_platform', $2::jsonb
       FROM sellers s, sellers b WHERE s.email = $3 AND b.email = $4 RETURNING id`,
      [
        item.rows[0].id,
        JSON.stringify({ name: "Ada Lovelace", line1: "1 Analysis Way", city: "Dublin", postal_code: "D01 X1X1", country: "IE" }),
        `${s}@t.dev`,
        `${b}@t.dev`,
      ],
    );
    const orderId = order.rows[0].id as string;
    const sellerId = (await db.query("SELECT id FROM sellers WHERE email = $1", [`${s}@t.dev`])).rows[0].id;
    await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: sellerId } });
    await applyTransition({ orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    await applyTransition({ orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "never arrived" });
    return orderId;
  }

  it("list: requires a session (no cookie → redirect to login)", async () => {
    const r = await get("/admin/disputes", false);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/login");
  });

  it("list: empty state when nothing is disputed", async () => {
    const r = await get("/admin/disputes");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("No disputed orders right now.");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("list: shows disputed orders with item, total, parties, since — newest first; B2 escaping", async () => {
    const older = await seedDisputed({ title: "Older <script>alert(1)</script> dispute" });
    const newer = await seedDisputed({ title: "Newer dispute" });
    const r = await get("/admin/disputes");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Newer dispute");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // escaped, not live
    expect(html).not.toContain("<script>alert(1)"); // no raw attacker HTML anywhere
    expect(html).toContain("105.00 EUR");
    expect(html.indexOf(newer)).toBeLessThan(html.indexOf(older)); // newest first
    expect(html).toContain(`/admin/disputes/${older}`);
  });

  it("list: caps at 50 with a note when more exist (OQ2)", async () => {
    // Direct rows for volume: one seller/item, 52 disputed orders.
    await db.query("INSERT INTO sellers (api_key_hash, display_name, email) VALUES ('thg_cap', 'cap', 'cap@t.dev')");
    const items = await db.query(
      "INSERT INTO items (seller_id, title, price_cents) SELECT id, 'Cap item ' || g, 100 FROM sellers, generate_series(1, 52) g WHERE email = 'cap@t.dev' RETURNING id",
    );
    for (const row of items.rows) {
      await db.query(
        `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, currency, fulfillment, payment_mode, status, status_changed_at)
         SELECT $1, id, id, 100, 'EUR', 'pickup', 'off_platform', 'disputed', now() - ($2 || ' seconds')::interval
         FROM sellers WHERE email = 'cap@t.dev'`,
        [row.id, items.rows.indexOf(row) * 3],
      );
    }
    const r = await get("/admin/disputes");
    const html = await r.text();
    expect((html.match(/\/admin\/disputes\/[0-9a-f-]{36}/g) ?? []).length).toBe(50);
    expect(html).toContain("More than 50 disputed orders — showing the 50 most recent.");
    // Cleanup the volume rows.
    await db.query("DELETE FROM orders WHERE status = 'disputed' AND item_id = ANY($1::uuid[])", [items.rows.map((x: { id: string }) => x.id)]);
    await db.query("DELETE FROM items WHERE id = ANY($1::uuid[])", [items.rows.map((x: { id: string }) => x.id)]);
    await db.query("DELETE FROM sellers WHERE email = 'cap@t.dev'");
  });

  it("detail: disputed order renders context, events history, masked address; no-store", async () => {
    const orderId = await seedDisputed();
    const r = await get(`/admin/disputes/${orderId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Thingery admin");
    expect(html).toContain("105.00 EUR");
    expect(html).toContain("off-platform");
    // order_events history: the dispute transition with its reason is visible.
    expect(html).toContain("delivered → disputed");
    expect(html).toContain("never arrived");
    // Address masked by default: city/country visible, street + name not.
    expect(html).toContain("Dublin");
    expect(html).toContain("IE");
    expect(html).not.toContain("1 Analysis Way");
    expect(html).not.toContain("Ada Lovelace");
    expect(html).toContain("Reveal address");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("detail: uniform 404 for malformed, non-existent and non-disputed ids", async () => {
    expect((await get("/admin/disputes/not-a-uuid")).status).toBe(404);
    expect((await get("/admin/disputes/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const orderId = await seedDisputed();
    await db.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [orderId]);
    const r = await get(`/admin/disputes/${orderId}`);
    expect(r.status).toBe(404);
    // Uniform: identical body shape for the non-disputed and missing cases.
    const missing = await get("/admin/disputes/00000000-0000-0000-0000-000000000000");
    expect(await r.text()).toBe(await missing.text());
  });

  it("detail: order messages render read-only when the table exists, bodies escaped (B2)", async () => {
    const orderId = await seedDisputed();
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.order_messages') AS t");
    if (!exists.rows[0]?.t) {
      await db.query(
        `CREATE TABLE IF NOT EXISTS order_messages (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           order_id UUID NOT NULL REFERENCES orders(id),
           sender_id UUID NOT NULL REFERENCES sellers(id),
           sender_role TEXT NOT NULL CHECK (sender_role IN ('buyer','seller')),
           body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
           created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      createdMessagesTable = true;
    }
    const buyerId = (await db.query("SELECT buyer_id FROM orders WHERE id = $1", [orderId])).rows[0].buyer_id;
    await db.query("INSERT INTO order_messages (order_id, sender_id, sender_role, body) VALUES ($1, $2, 'buyer', $3)", [
      orderId,
      buyerId,
      "Item never arrived <script>alert('xss')</script> \"quoted\"",
    ]);
    const r = await get(`/admin/disputes/${orderId}`);
    const html = await r.text();
    expect(html).toContain("Messages between the parties");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    // Read-only: no compose form for messages (name="body" input / messages action).
    expect(html).not.toContain('name="body"');
    expect(html).not.toContain("/messages");
    // No rows → section absent entirely.
    await db.query("DELETE FROM order_messages WHERE order_id = $1", [orderId]);
    const after = await get(`/admin/disputes/${orderId}`);
    expect((await after.text())).not.toContain("Messages between the parties");
  });

  it("reveal: requires session + CSRF; logs admin_pii_reveal with the order id; re-masks on fresh GET", async () => {
    const orderId = await seedDisputed();
    const noSession = await fetch(`${base}/admin/disputes/${orderId}/reveal`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("location")).toBe("/admin/login");

    const badCsrf = await postForm(`/admin/disputes/${orderId}/reveal`, { csrf: "wrong" });
    expect(badCsrf.status).toBe(400);

    consoleLog = spyLog();
    const ok = await postForm(`/admin/disputes/${orderId}/reveal`, { csrf });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("1 Analysis Way"); // unmasked in the POST response
    expect(html).toContain("Ada Lovelace");
    const events = consoleLog.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string" && v.includes('"admin_pii_reveal"'))
      .map((line) => JSON.parse(line) as { type: string; orderId: string });
    expect(events.at(-1)).toMatchObject({ type: "admin_pii_reveal", orderId });
    expect(JSON.stringify(events.at(-1))).not.toContain("Ada"); // the address itself never logged
    consoleLog.mockRestore();

    const fresh = await get(`/admin/disputes/${orderId}`);
    const freshHtml = await fresh.text();
    expect(freshHtml).not.toContain("1 Analysis Way"); // masked again
  });

  it("reveal: uniform 404 for non-disputed order; strict limiter applies (B1)", async () => {
    const orderId = await seedDisputed();
    await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
    const r = await postForm(`/admin/disputes/${orderId}/reveal`, { csrf });
    expect(r.status).toBe(404);
    await db.query("UPDATE orders SET status = 'disputed' WHERE id = $1", [orderId]);
    let last = 200;
    for (let i = 0; i < 11 && last !== 429; i++) {
      const rr = await postForm(`/admin/disputes/${orderId}/reveal`, { csrf });
      last = rr.status;
    }
    expect(last).toBe(429);
  });
});
