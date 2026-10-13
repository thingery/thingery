// HTTP tests for the order payment-return pages (spec THI-3 §4.3, finding F15):
// - /order/:id is a capability URL: status-only rendering (no item title,
//   price, or party names), Cache-Control: no-store, Referrer-Policy:
//   same-origin, and identical page shape for known/unknown/malformed ids
//   (no order-existence oracle).
// - /order/payout-setup is a distinct page not captured by the :id route.
// Requires Postgres; skips otherwise.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import net from "node:net";
import pg from "pg";
import { orderReturnPage, payoutSetupReturnPage } from "../src/web-pages.js";
import { pool } from "../src/db.js";

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

describe.skipIf(!available)("/order payment-return pages (F15)", () => {
  let server: Server;
  let baseUrl: string;
  let client: pg.Client;
  let orderId: string;

  beforeAll(async () => {
    // Route order mirrors src/index.ts: literal payout-setup before :id.
    const app = express();
    app.get("/order/payout-setup", payoutSetupReturnPage);
    app.get("/order/:id", orderReturnPage);
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    client = new pg.Client({ connectionString });
    await client.connect();
    let n = 0;
    // Re-seed with a unique tag if the fixture collides with an earlier run.
    for (let attempt = 0; !orderId && attempt < 3; attempt += 1) {
      n += 1;
      const tag = `ordpage${Date.now()}${n}`;
      try {
        await client.query(
          "INSERT INTO sellers (api_key, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
          [`thg_${tag}s`, `${tag}s`, `${tag}s@t.dev`, `thg_${tag}b`, `${tag}b`, `${tag}b@t.dev`],
        );
        const item = await client.query(
          "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) SELECT id, $1, 10000, 500 FROM sellers WHERE email = $2 RETURNING id",
          [`Secret Title ${tag}`, `${tag}s@t.dev`],
        );
        const order = await client.query(
          `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode)
           SELECT $1, s.id, b.id, 10000, 500, 'EUR', 'shipping', 'stripe'
           FROM sellers s, sellers b WHERE s.email = $2 AND b.email = $3 RETURNING id`,
          [item.rows[0].id, `${tag}s@t.dev`, `${tag}b@t.dev`],
        );
        orderId = order.rows[0].id;
      } catch {
        orderId = ""; // unique violation → retry with a fresh tag
      }
    }
    expect(orderId, "could not seed a test order").toBeTruthy();
  });

  afterAll(async () => {
    server.close();
    await client.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("renders status only for a valid order — never title, price, or parties", async () => {
    const res = await fetch(`${baseUrl}/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const body = await res.text();
    expect(body).toContain("Awaiting payment"); // pending status label
    expect(body).not.toContain("Secret Title");
    expect(body).not.toContain("100.00"); // price never rendered
  });

  it("renders the same template for unknown and malformed ids, leaking nothing", async () => {
    const unknown = await fetch(`${baseUrl}/order/00000000-0000-4000-8000-000000000000`);
    const malformed = await fetch(`${baseUrl}/order/not-a-uuid`);
    for (const res of [unknown, malformed]) {
      expect(res.status).toBe(200); // never a 500/stack trace on bad input
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      const body = await res.text();
      expect(body).toContain("Order not found");
      // Same page template as the known-id render (structural markers), and
      // never any order data — there is none to leak for a nonexistent id.
      expect(body).toContain("<h1>Order status</h1>");
      expect(body).not.toContain("Secret Title");
    }
  });

  it("serves /order/payout-setup as its own page, not as an order id", async () => {
    const res = await fetch(`${baseUrl}/order/payout-setup`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Payout setup");
    expect(body).not.toContain("Order not found");
  });
});

// Keep net import referenced for parity with the other HTTP test files.
void net;
