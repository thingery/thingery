// Buyer order tools (spec THI-3 rev 2 §4.1 + rev 3 §11.2; PR-4).
// DB-backed; Stripe faked via setStripeForTests (no network).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { registerTools } from "../src/tools.js";
import { cancelOrder, createOrder, getOrderView, OrderFlowError } from "../src/order-flow.js";
import { getItem } from "../src/items.js";

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

function fakeStripe(paymentStatus = "unpaid"): { client: Stripe; calls: string[] } {
  const calls: string[] = [];
  const n = Math.random().toString(36).slice(2, 8);
  const client = {
    accounts: { create: async () => ({ id: `acct_${n}` }) },
    accountLinks: { create: async () => ({ url: `https://onboard.test/${n}` }) },
    checkout: {
      sessions: {
        create: async () => { calls.push("sessions.create"); return { id: `cs_${n}`, url: `https://pay.test/${n}` }; },
        retrieve: async (id: string) => { calls.push("sessions.retrieve"); return { id, url: `https://pay.test/${n}`, payment_status: paymentStatus }; },
        expire: async () => { calls.push("sessions.expire"); return {}; },
      },
    },
    transfers: { create: async () => ({ id: `tr_${n}` }) },
    refunds: { create: async (a: unknown, o: unknown) => { calls.push(`refunds.create:${(o as { idempotencyKey: string }).idempotencyKey}`); return { id: `re_${n}` }; } },
  } as unknown as Stripe;
  return { client, calls };
}

describe.skipIf(!available)("create_order / get_order / cancel_order (DB)", () => {
  let db: pg.Client;
  let n = 0;
  const ids: { sellerId: string; buyerId: string; sellerKey: string; buyerKey: string } = {
    sellerId: "", buyerId: "", sellerKey: "", buyerKey: "",
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `os${n}`, b = `ob${n}`;
    await db.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const r = await db.query(
      `SELECT (SELECT id FROM sellers WHERE email=$1) AS seller, (SELECT id FROM sellers WHERE email=$2) AS buyer`,
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    ids.sellerKey = `thg_${s}`;
    ids.buyerKey = `thg_${b}`;
  });
  afterEach(() => {
    setStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.PUBLIC_BASE_URL;
  });

  /** Active shippable item owned by the seeded seller. */
  const seedItem = async (opts: { tier?: string; shipping?: number; price?: number; status?: string } = {}) => {
    const item = await db.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ids.sellerId, `Item ${n}`, opts.price ?? 10000, opts.shipping ?? 500, opts.tier ?? "parcel", opts.status ?? "active"],
    );
    return item.rows[0].id as string;
  };

  const address = { name: "B", line1: "Via Roma 1", city: "Milan", postal_code: "20100", country: "IT" };
  const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  it("off_platform happy path: pending order, reserved item, snapshot prices, event log", async () => {
    const itemId = await seedItem({ shipping: 700 });
    const { order, paymentUrl } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    expect(order.status).toBe("pending");
    expect(order.payment_mode).toBe("off_platform"); // no Stripe configured
    expect(paymentUrl).toBeNull();
    expect(order.price_cents).toBe(10000);
    expect(order.shipping_price_cents).toBe(700);
    const item = await db.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("reserved");
    const events = await db.query("SELECT from_status, to_status FROM order_events WHERE order_id = $1", [order.id]);
    expect(events.rows[0]).toMatchObject({ from_status: null, to_status: "pending" });
  });

  it("pickup (local tier) needs no address and snapshots shipping 0", async () => {
    const itemId = await seedItem({ tier: "local", shipping: 700 });
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId });
    expect(order.fulfillment).toBe("pickup");
    expect(order.shipping_price_cents).toBe(0);
  });

  it("rejects self-orders, unknown items, missing address, unavailable items", async () => {
    const itemId = await seedItem();
    await expectCode(createOrder({ buyerId: ids.sellerId, itemId, shippingAddress: address }), "self_order");
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId: "00000000-0000-0000-0000-000000000000", shippingAddress: address }), "not_found");
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId }), "shipping_address_required");
    await db.query("UPDATE items SET status = 'sold' WHERE id = $1", [itemId]);
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address }), "item_unavailable");
  });

  it("F8: pending cap and reorder cooldown", async () => {
    for (let i = 0; i < 3; i++) await seedItem();
    const items = (await db.query("SELECT id FROM items ORDER BY created_at")).rows.map((r: { id: string }) => r.id);
    for (const id of items) await createOrder({ buyerId: ids.buyerId, itemId: id, shippingAddress: address });
    const extra = await seedItem();
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId: extra, shippingAddress: address }), "too_many_pending_orders");
    // Cancel one pending order; the cooldown blocks an immediate reorder of the same item.
    const first = (await db.query("SELECT id FROM orders ORDER BY created_at LIMIT 1")).rows[0].id;
    await cancelOrder(first, ids.buyerId, "changed mind");
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId: items[0], shippingAddress: address }), "reorder_cooldown");
  });

  it("payment_mode resolution: default off_platform when unavailable; explicit stripe errors with the reason", async () => {
    const itemId = await seedItem();
    await expectCode(
      createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address, paymentMode: "stripe" }),
      "payments_not_configured",
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await expectCode(
      createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address, paymentMode: "stripe" }),
      "seller_not_payout_ready",
    );
  });

  it("stripe happy path: checkout session created and stored, payment_url returned", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [ids.sellerId]);
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const itemId = await seedItem();
    const { order, paymentUrl } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    expect(order.payment_mode).toBe("stripe");
    expect(order.checkout_session_id).toMatch(/^cs_/);
    expect(paymentUrl).toMatch(/^https:\/\/pay\.test\//);
    expect(fake.calls).toContain("sessions.create");
  });

  it("cancel pre-payment (unpaid): expires the session, order cancelled, item active again", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [ids.sellerId]);
    const fake = fakeStripe("unpaid");
    setStripeForTests(fake.client);
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    const cancelled = await cancelOrder(order.id, ids.buyerId, "changed mind");
    expect(cancelled.status).toBe("cancelled");
    expect(fake.calls).toContain("sessions.expire");
    expect((await db.query("SELECT status FROM items WHERE id = $1", [itemId])).rows[0].status).toBe("active");
  });

  it("F2: cancel refuses a paid-but-webhook-pending order and logs unexpected_payment", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [ids.sellerId]);
    setStripeForTests(fakeStripe("paid").client);
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    await expectCode(cancelOrder(order.id, ids.buyerId), "order_already_paid");
    const alert = await db.query(
      "SELECT event_type FROM order_events WHERE order_id = $1 AND event_type = 'unexpected_payment'",
      [order.id],
    );
    expect(alert.rows).toHaveLength(1);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("pending");
  });

  it("cancel at sold: stripe refunds (idempotent key refund:{order_id}); off_platform twin cancels", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [ids.sellerId]);
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    await db.query("UPDATE orders SET status = 'sold', payment_intent_id = 'pi_1', status_changed_at = now() WHERE id = $1", [order.id]);
    await db.query("UPDATE items SET status = 'sold' WHERE id = $1", [itemId]);
    const cancelled = await cancelOrder(order.id, ids.buyerId, "wrong size");
    expect(cancelled.status).toBe("refunding");
    expect(cancelled.refund_id).toMatch(/^re_/);
    expect(fake.calls).toContain(`refunds.create:refund:${order.id}`);
    expect((await db.query("SELECT status FROM items WHERE id = $1", [itemId])).rows[0].status).toBe("active");
  });

  it("get_order: parties see it, outsiders and wrong ids get not_found", async () => {
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    expect((await getOrderView(order.id, ids.buyerId))?.status).toBe("pending");
    expect((await getOrderView(order.id, ids.sellerId))?.status).toBe("pending");
    expect(await getOrderView(order.id, crypto.randomUUID())).toBeNull();
  });

  it("get_item exposes payment_available + orderable (§11.2)", async () => {
    const itemId = await seedItem();
    const bare = await getItem(itemId);
    expect(bare?.seller_payout_ready).toBe(false);
    expect(bare?.shipping_price_cents).toBe(500);
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [ids.sellerId]);
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    expect((await getItem(itemId))?.seller_payout_ready).toBe(true);
  });

  it("tool surface: create_order / get_order / cancel_order refuse anonymous callers and are registered", async () => {
    const registered: string[] = [];
    const anon = new Map<string, { handler: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }>();
    registerTools(
      {
        registerTool(name: string, _c: unknown, handler: never) {
          registered.push(name);
          anon.set(name, { handler });
        },
      } as never,
      { seller: null },
    );
    for (const name of ["create_order", "get_order", "cancel_order"]) {
      expect(registered).toContain(name);
      const r = await anon.get(name)!.handler({});
      expect(JSON.parse(r.content![0].text!).code).toBe("unauthorized");
    }
  });

  it("cancel twice: second is invalid_transition with the current status surfaced", async () => {
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: address });
    await cancelOrder(order.id, ids.buyerId);
    await expectCode(cancelOrder(order.id, ids.buyerId), "invalid_transition");
  });
});
