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
import type Stripe from "stripe";
import net from "node:net";
import pg from "pg";
import { orderReturnPage, payoutSetupReturnPage } from "../src/web-pages.js";
import { getPayableCheckoutUrl } from "../src/order-flow.js";
import { setStripeForTests } from "../src/stripe.js";
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

// --- THI-1605 pay step (spec docs/specs/order-page-pay-step.md) -------------
// The page renders a pay button ONLY for a pending stripe order whose live
// Checkout session it can retrieve (read-only reuse of the get_order
// payment_url path — no second payment path). Every other shape is exactly
// the status-only F15 render. Stripe is faked via setStripeForTests.

type FakeSession = { url: string | null } | { fail: true } | { spyOnly: true };

function fakeStripeWithSession(session: FakeSession): { client: Stripe; state: { retrieveCalls: number } } {
  const state = { retrieveCalls: 0 };
  const client = {
    checkout: {
      sessions: {
        retrieve: async (id: string) => {
          state.retrieveCalls += 1;
          if ("fail" in session && session.fail) throw new Error("stripe down");
          if ("spyOnly" in session && session.spyOnly) return { id };
          return { id, url: (session as { url: string | null }).url };
        },
      },
    },
  } as unknown as Stripe;
  return { client, state };
}

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
          "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
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

  // --- THI-1605 pay step (spec docs/specs/order-page-pay-step.md) ---------
  // The page renders a pay button ONLY for a pending stripe order whose live
  // Checkout session it can retrieve (read-only reuse of the get_order
  // payment_url path — no second payment path). Every other shape is exactly
  // the status-only F15 render. Stripe is faked via setStripeForTests.

  it("renders no pay step while the order has no checkout session", async () => {
    const res = await fetch(`${baseUrl}/order/${orderId}`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Awaiting payment");
    expect(body).not.toContain("Pay for this order");
    expect(body).not.toContain("stripe.com");
  });

  it("renders the pay step for a pending stripe order with a live session — and nothing else new", async () => {
    const url = "https://pay.stripe.com/session/thi1605";
    await client.query("UPDATE orders SET checkout_session_id = $1 WHERE id = $2", ["cs_thi1605", orderId]);
    setStripeForTests(fakeStripeWithSession({ url }).client);
    try {
      const res = await fetch(`${baseUrl}/order/${orderId}`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(body).toContain("Awaiting payment");
      expect(body).toContain("Pay for this order");
      expect(body).toContain(`href="${url}"`);
      expect(body).toContain("You'll come back here after paying.");
      // F15 data discipline unchanged: the button adds a link, never data.
      expect(body).not.toContain("Quiet Title");
      expect(body).not.toContain("100.00");
    } finally {
      setStripeForTests(null);
      await client.query("UPDATE orders SET checkout_session_id = NULL WHERE id = $1", [orderId]);
    }
  });

  it("renders status-only when the session is expired (url null) or retrieval fails", async () => {
    await client.query("UPDATE orders SET checkout_session_id = $1 WHERE id = $2", ["cs_thi1605b", orderId]);
    try {
      setStripeForTests(fakeStripeWithSession({ url: null }).client);
      let res = await fetch(`${baseUrl}/order/${orderId}`);
      let body = await res.text();
      expect(body).toContain("Awaiting payment");
      expect(body).not.toContain("Pay for this order");
      expect(body).toContain("ask it to check the order status");

      setStripeForTests(fakeStripeWithSession({ fail: true }).client);
      res = await fetch(`${baseUrl}/order/${orderId}`);
      body = await res.text();
      expect(res.status).toBe(200);
      expect(body).not.toContain("Pay for this order");
    } finally {
      setStripeForTests(null);
      await client.query("UPDATE orders SET checkout_session_id = NULL WHERE id = $1", [orderId]);
    }
  });

  it("renders status-only when Stripe is unconfigured (kill switch)", async () => {
    await client.query("UPDATE orders SET checkout_session_id = $1 WHERE id = $2", ["cs_thi1605c", orderId]);
    try {
      // No setStripeForTests call — the client stays null (test default).
      const res = await fetch(`${baseUrl}/order/${orderId}`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("Awaiting payment");
      expect(body).not.toContain("Pay for this order");
    } finally {
      await client.query("UPDATE orders SET checkout_session_id = NULL WHERE id = $1", [orderId]);
    }
  });

  it("never renders the pay step once the order is no longer pending", async () => {
    await client.query("UPDATE orders SET checkout_session_id = $1, status = 'sold' WHERE id = $2", ["cs_thi1605d", orderId]);
    setStripeForTests(fakeStripeWithSession({ url: "https://pay.stripe.com/session/sold" }).client);
    try {
      const res = await fetch(`${baseUrl}/order/${orderId}`);
      const body = await res.text();
      expect(body).toContain("Paid — awaiting shipment");
      expect(body).not.toContain("Pay for this order");
    } finally {
      setStripeForTests(null);
      await client.query("UPDATE orders SET checkout_session_id = NULL, status = 'pending' WHERE id = $1", [orderId]);
    }
  });

  it("maps ?canceled=1 to fixed copy — reflects nothing, button only when payable", async () => {
    // Not payable: fixed copy, no button, no echo of arbitrary query values.
    let res = await fetch(`${baseUrl}/order/${orderId}?canceled=1&x=%3Cscript%3E`);
    let body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Payment was canceled — you can still complete it; ask your assistant to resume checkout.");
    expect(body).not.toContain("Pay for this order");
    expect(body).not.toContain("<script>");

    // Payable: the note points at the button below it.
    await client.query("UPDATE orders SET checkout_session_id = $1 WHERE id = $2", ["cs_thi1605e", orderId]);
    setStripeForTests(fakeStripeWithSession({ url: "https://pay.stripe.com/session/canceled" }).client);
    try {
      res = await fetch(`${baseUrl}/order/${orderId}?canceled=1`);
      body = await res.text();
      expect(body).toContain("Payment was canceled — you can still complete it below.");
      expect(body).toContain("Pay for this order");
    } finally {
      setStripeForTests(null);
      await client.query("UPDATE orders SET checkout_session_id = NULL WHERE id = $1", [orderId]);
    }
  });

  it("getPayableCheckoutUrl(null) makes no Stripe call at all", async () => {
    const fake = fakeStripeWithSession({ spyOnly: true });
    setStripeForTests(fake.client);
    try {
      expect(await getPayableCheckoutUrl(null)).toBeNull();
      expect(await getPayableCheckoutUrl("")).toBeNull();
      expect(fake.state.retrieveCalls).toBe(0);
    } finally {
      setStripeForTests(null);
    }
  });
});

// Keep net import referenced for parity with the other HTTP test files.
void net;
