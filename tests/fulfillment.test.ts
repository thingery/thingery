// Fulfillment + dispute tools (spec THI-3 rev 2 §4.2/§5.2 + rev 3 §11.2; PR-5).
// DB-backed; Stripe faked via setStripeForTests, EasyPost via a fetch stub.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { applyTransition } from "../src/orders.js";
import { createOrder } from "../src/order-flow.js";
import { OrderFlowError, confirmPayment, confirmReceipt, openDispute, recordTracking, releaseFunds } from "../src/fulfillment.js";
import { registerTools } from "../src/tools.js";

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

const n0 = Math.random().toString(36).slice(2, 8);
function fakeStripe(transferImpl?: () => Promise<unknown>): { client: Stripe; calls: string[] } {
  const calls: string[] = [];
  const client = {
    checkout: { sessions: { create: async () => ({ id: `cs_${n0}`, url: `https://pay.test/${n0}` }) } },
    paymentIntents: {
      retrieve: async () => ({
        // THI-374 netting read: expanded PI → succeeded charge → balance
        // transaction. Test orders are 10000 + 500 = 10500 gross (eur);
        // fee 182 → seller transfer 10318, platform keeps 0.
        latest_charge: {
          id: "ch_net",
          status: "succeeded",
          balance_transaction: { amount: 10500, currency: "eur", fee: 182 },
        },
      }),
    },
    transfers: {
      create: async (a: unknown, o: unknown) => {
        calls.push(`transfers.create:${(o as { idempotencyKey: string }).idempotencyKey}:${(a as { amount: number }).amount}`);
        if (transferImpl) return transferImpl();
        return { id: `tr_${n0}` };
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

describe.skipIf(!available)("fulfillment tools (DB)", () => {
  let db: pg.Client;
  let n = 0;
  let sellerId = "";
  let buyerId = "";

  const accountBy = async (email: string) =>
    (await db.query<{ id: string }>("SELECT id FROM sellers WHERE email = $1", [email])).rows[0].id;

  /** Seeds seller+buyer+buyer-ordered item; returns the created order. */
  async function seedOrder(opts: { tier?: "standard" | "local"; mode?: "stripe" | "off_platform"; onboarded?: boolean } = {}) {
    n += 1;
    const s = `fs${n}`, b = `fb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    sellerId = await accountBy(`${s}@t.dev`);
    buyerId = await accountBy(`${b}@t.dev`);
    if (opts.onboarded) {
      process.env.STRIPE_SECRET_KEY = "sk_test_k1";
      await db.query("UPDATE sellers SET stripe_account_id = 'acct_s', stripe_onboarded_at = now() WHERE id = $1", [sellerId]);
      // getStripe() singleton may already be cached null from beforeEach —
      // checkout creation inside createOrder needs a client now.
      setStripeForTests(fakeStripe().client);
    }
    const item = await db.query<{ id: string }>(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier) VALUES ($1,$2,10000,500,$3) RETURNING id",
      [sellerId, `Item ${n}`, opts.tier ?? "parcel"],
    );
    const { order } = await createOrder({
      buyerId,
      itemId: item.rows[0].id,
      ...(opts.tier === "local" ? {} : { shippingAddress: { name: "B", line1: "1 St", city: "C", postal_code: "00", country: "IT" } }),
      ...(opts.mode ? { paymentMode: opts.mode } : {}),
    });
    return order as { id: string; item_id: string; payment_mode: string; fulfillment: string };
  }

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
    delete process.env.EASYPOST_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    setStripeForTests(null);
  });
  afterEach(() => {
    setStripeForTests(null);
  });

  it("record_tracking: sold → label_issued (degraded mode, no tracker)", async () => {
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId, "cash");
    const result = await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "JD0001" });
    expect(result.order.status).toBe("label_issued");
    expect(result.order.carrier).toBe("DHL");
    expect(result.order.tracking_code).toBe("JD0001");
    expect(result.trackerRegistered).toBe(false);
    expect(result.order.tracker_id).toBeNull();
  });

  it("record_tracking registers an EasyPost tracker and stores tracker_id (F4)", async () => {
    process.env.EASYPOST_API_KEY = "EZTK_TEST_KEY";
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ id: "trk_123" }) })) as typeof fetch;
    try {
      const result = await recordTracking(order.id, sellerId, { carrier: "DPD", trackingCode: "DPD9" });
      expect(result.trackerRegistered).toBe(true);
      expect(result.order.tracker_id).toBe("trk_123");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("tracker registration failure is non-fatal: order advances, failure event-logged", async () => {
    process.env.EASYPOST_API_KEY = "EZTK_TEST_KEY";
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as typeof fetch;
    try {
      const result = await recordTracking(order.id, sellerId, { carrier: "UPS", trackingCode: "1Z9" });
      expect(result.order.status).toBe("label_issued");
      expect(result.order.tracker_id).toBeNull();
      expect(result.note).toContain("retry");
      const evt = await db.query("SELECT event_type FROM order_events WHERE order_id = $1 AND event_type = 'tracker_registration_failed'", [order.id]);
      expect(evt.rowCount).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("#23 correction replaces tracking — and the stale tracker_id (F4 hazard)", async () => {
    process.env.EASYPOST_API_KEY = "EZTK_TEST_KEY";
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    let seq = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { seq += 1; return { ok: true, json: async () => ({ id: `trk_${seq}` }) }; }) as typeof fetch;
    try {
      await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "OLD1" });
      const corrected = await recordTracking(order.id, sellerId, { carrier: "GLS", trackingCode: "NEW2" });
      expect(corrected.order.status).toBe("label_issued"); // no state change
      expect(corrected.order.tracking_code).toBe("NEW2");
      expect(corrected.order.tracker_id).toBe("trk_2"); // replaced, not COALESCEd
      const evt = await db.query("SELECT count(*)::int AS c FROM order_events WHERE order_id = $1 AND event_type = 'tracking_corrected'", [order.id]);
      expect(evt.rows[0].c).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("record_tracking refuses pickup orders (fulfillment_mismatch)", async () => {
    const order = await seedOrder({ tier: "local" });
    await confirmPayment(order.id, sellerId);
    const err = await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "X" }).catch((e: unknown) => e as OrderFlowError);
    expect((err as OrderFlowError).code).toBe("fulfillment_mismatch");
  });

  it("confirm_payment: off_platform pending → sold; stripe order and non-party seller rejected", async () => {
    const order = await seedOrder();
    const done = await confirmPayment(order.id, sellerId, "cash");
    expect(done.status).toBe("sold");
    const item = await db.query<{ status: string }>("SELECT status FROM items WHERE id = $1", [order.item_id]);
    expect(item.rows[0].status).toBe("sold");

    const stripeOrder = await seedOrder({ mode: "stripe", onboarded: true });
    const stripeErr = await confirmPayment(stripeOrder.id, sellerId).catch((e: unknown) => e as OrderFlowError);
    expect((stripeErr as OrderFlowError).code).toBe("invalid_transition");

    await seedOrder(); // another seller's order
    const other = await db.query<{ id: string }>("SELECT id FROM sellers LIMIT 1");
    const outsider = await db.query<{ id: string }>("SELECT o.id FROM orders o WHERE o.seller_id <> $1 LIMIT 1", [other.rows[0].id]);
    const wrong = await confirmPayment(outsider.rows[0].id, other.rows[0].id).catch((e: unknown) => e as OrderFlowError);
    expect((wrong as OrderFlowError).code).toBe("not_found");
  });

  it("pickup happy path: confirm_receipt sold → delivered, dispute window opens", async () => {
    const order = await seedOrder({ tier: "local" });
    await confirmPayment(order.id, sellerId);
    const delivered = await confirmReceipt(order.id, buyerId);
    expect(delivered.status).toBe("delivered");
    expect(delivered.dispute_deadline).not.toBeNull();
    const hours = (new Date(delivered.dispute_deadline!).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  it("confirm_receipt guards: not before shipping; works from in_transit (#13); outsiders not_found", async () => {
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    const early = await confirmReceipt(order.id, buyerId).catch((e: unknown) => e as OrderFlowError);
    expect((early as OrderFlowError).code).toBe("fulfillment_mismatch");

    await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "T1" });
    await applyTransition({ orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: "evt" } });
    const delivered = await confirmReceipt(order.id, buyerId); // #13 early confirm
    expect(delivered.status).toBe("delivered");

    const outsider = await confirmReceipt(order.id, sellerId).catch((e: unknown) => e as OrderFlowError); // seller is not the buyer
    expect((outsider as OrderFlowError).code).toBe("not_found");
  });

  it("open_dispute: within window → disputed; after window → dispute_window_closed", async () => {
    const order = await seedOrder({ tier: "local" });
    await confirmPayment(order.id, sellerId);
    await confirmReceipt(order.id, buyerId);
    const disputed = await openDispute(order.id, buyerId, "item is a different model");
    expect(disputed.status).toBe("disputed");

    const order2 = await seedOrder({ tier: "local" });
    await confirmPayment(order2.id, sellerId);
    await confirmReceipt(order2.id, buyerId);
    await db.query("UPDATE orders SET dispute_deadline = now() - interval '1 hour' WHERE id = $1", [order2.id]);
    const late = await openDispute(order2.id, buyerId, "too late").catch((e: unknown) => e as OrderFlowError);
    expect((late as OrderFlowError).code).toBe("dispute_window_closed");
  });

  it("release_funds off_platform: delivered → completed", async () => {
    const order = await seedOrder({ tier: "local" });
    await confirmPayment(order.id, sellerId);
    await confirmReceipt(order.id, buyerId);
    const result = await releaseFunds(order.id, buyerId);
    expect(result.order.status).toBe("completed");
  });

  it("release_funds stripe: delivered → payout_pending + transfer under payout:{order_id}, transfer_id stored", async () => {
    const order = await seedOrder({ mode: "stripe", onboarded: true });
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    await applyTransition({ orderId: order.id, trigger: "stripe_payment", actor: { type: "stripe", id: "evt" }, sets: { payment_intent_id: "pi_1" } });
    await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "T9" });
    await applyTransition({ orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: "evt" } });
    await applyTransition({ orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: "evt2" } }); // delivered
    const result = await releaseFunds(order.id, buyerId);
    expect(result.order.status).toBe("payout_pending");
    expect(result.order.transfer_id).toBe(`tr_${n0}`);
    expect(calls).toEqual([`transfers.create:payout:${order.id}:10318`]); // net of the 182c fee (THI-374)
  });

  it("release_funds stripe: transfer failure keeps payout_pending, logs payout_attempt_failed", async () => {
    const order = await seedOrder({ mode: "stripe", onboarded: true });
    const { client } = fakeStripe(async () => {
      throw new Error("stripe down");
    });
    setStripeForTests(client);
    await applyTransition({ orderId: order.id, trigger: "stripe_payment", actor: { type: "stripe", id: "evt" }, sets: { payment_intent_id: "pi_1" } });
    await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "T9" });
    await applyTransition({ orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: "evt" } });
    await applyTransition({ orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: "evt2" } });
    const result = await releaseFunds(order.id, buyerId);
    expect(result.order.status).toBe("payout_pending");
    expect(result.note).toContain("retried automatically");
    const evt = await db.query("SELECT count(*)::int AS c FROM order_events WHERE order_id = $1 AND event_type = 'payout_attempt_failed'", [order.id]);
    expect(evt.rows[0].c).toBe(1);
  });

  it("tool surface: five tools registered, anonymous callers get unauthorized", async () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => registered.push(name),
    };
    registerTools(fakeServer as never, { seller: null });
    for (const t of ["record_tracking", "confirm_payment", "confirm_receipt", "open_dispute", "release_funds"]) {
      expect(registered).toContain(t);
    }
    const { PROTECTED_TOOLS } = await import("../src/tools.js");
    for (const t of ["record_tracking", "confirm_payment", "confirm_receipt", "open_dispute", "release_funds"]) {
      expect(PROTECTED_TOOLS.has(t)).toBe(true);
    }
  });
});
