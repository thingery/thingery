// Stripe webhook endpoint (spec THI-3 rev 2 §4.3/§5.4/§6.5; PR-6).
// HTTP-level against a real express app; signatures minted with the SDK's
// generateTestHeaderString. Postgres-backed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import net from "node:net";
import pg from "pg";
import type Stripe from "stripe";
import StripeCtor from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { stripeWebhookRouter } from "../src/webhooks-stripe.js";
import { createOrder } from "../src/order-flow.js";
import { applyTransition, type OrderRow } from "../src/orders.js";
import type { OrderFlowConfig } from "../src/config.js";

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

const SECRET = "whsec_test_secret";
const PREVIOUS = "whsec_old_secret";
const stripe = new StripeCtor("sk_test_k1");

const n0 = Math.random().toString(36).slice(2, 8);

/** Fake Stripe client: real constructEvent (crypto), fake money calls. */
function fakeStripe(refundImpl?: () => unknown): Stripe {
  return {
    webhooks: stripe.webhooks, // real verification
    checkout: {
      sessions: {
        create: async () => ({ id: `cs_${n0}`, url: `https://pay.test/${n0}` }),
        expire: async () => ({}),
        retrieve: async () => ({ payment_status: "unpaid" }),
      },
    },
    refunds: {
      create: async () => {
        if (refundImpl) await refundImpl();
        return { id: `re_${n0}` };
      },
    },
  } as unknown as Stripe;
}

function event(type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2, 10)}`): Stripe.Event {
  return {
    id, type, livemode: false, api_version: null, created: 1, object: "event",
    data: { object: { object: type.split(".")[0], ...object } as never },
    request: null, pending_webhooks: 0,
  } as unknown as Stripe.Event;
}

/** express strips nothing here — mount exactly like index.ts does. */
function buildApp(): express.Express {
  const app = express();
  const cfg = {
    stripePaymentsEnabled: true, stripeMode: "test",
    stripeWebhookReady: true, stripeWebhookSecret: SECRET, stripeWebhookSecretPrevious: PREVIOUS,
  } as unknown as OrderFlowConfig;
  app.use(stripeWebhookRouter(cfg));
  return app;
}

async function post(app: express.Express, body: string, opts: { secret?: string; ct?: string; sig?: string } = {}) {
  const payload = Buffer.from(body, "utf8");
  const sig =
    opts.sig ??
    stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? SECRET, timestamp: Math.floor(Date.now() / 1000) });
  const res = await fetch(`http://127.0.0.1:${(app as unknown as { _port: number })._port}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": opts.ct ?? "application/json", "Stripe-Signature": sig },
    body: payload,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe.skipIf(!available)("Stripe webhook endpoint (HTTP)", () => {
  let db: pg.Client;
  let app: express.Express;
  let server: Server;
  let port = 0;
  let n = 0;
  let sellerId = "";
  let buyerId = "";

  async function seedOrder(mode: "stripe" | "off_platform" = "stripe"): Promise<OrderRow> {
    n += 1;
    const s = `ws${n}`, b = `wb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const ids = await db.query<{ s: string; b: string }>(
      "SELECT (SELECT id FROM sellers WHERE email=$1) AS s, (SELECT id FROM sellers WHERE email=$2) AS b",
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    sellerId = ids.rows[0].s;
    buyerId = ids.rows[0].b;
    if (mode === "stripe") {
      process.env.STRIPE_SECRET_KEY = "sk_test_k1";
      await db.query("UPDATE sellers SET stripe_account_id = $2, stripe_onboarded_at = now() WHERE id = $1", [sellerId, `acct_${n}`]);
    }
    const item = await db.query<{ id: string }>(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier) VALUES ($1,$2,10000,500,'parcel') RETURNING id",
      [sellerId, `Item ${n}`],
    );
    const { order } = await createOrder({
      buyerId,
      itemId: item.rows[0].id,
      shippingAddress: { name: "B", line1: "1 St", city: "C", postal_code: "00", country: "IT" },
      paymentMode: mode,
    });
    return order as OrderRow;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        (app as unknown as { _port: number })._port = port;
        resolve();
      });
    });
  });
  afterAll(async () => {
    server.close();
    await db.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    delete process.env.STRIPE_SECRET_KEY;
    setStripeForTests(fakeStripe());
  });

  it("rejects non-JSON, empty bodies, and bad signatures with 400 — and writes nothing (F12)", async () => {
    const ev = event("checkout.session.completed", { id: "cs_x" });
    const body = JSON.stringify(ev);
    const r1 = await post(app, body, { ct: "text/plain" });
    expect(r1.status).toBe(400);
    const r2 = await post(app, "", { });
    expect(r2.status).toBe(400);
    const r3 = await post(app, body, { secret: "whsec_wrong" });
    expect(r3.status).toBe(400);
    const r4 = await post(app, body, { sig: "t=1,v1=deadbeef" });
    expect(r4.status).toBe(400);
    const count = await db.query("SELECT count(*)::int AS c FROM webhook_events");
    expect(count.rows[0].c).toBe(0);
  });

  it("accepts the previous secret during rotation (F13)", async () => {
    const ev = event("account.updated", { id: `acct_unknown_${n0}` });
    const r = await post(app, JSON.stringify(ev), { secret: PREVIOUS });
    expect(r.status).toBe(200);
  });

  it("checkout.session.completed: pending → sold, payment_intent stored, amount verified", async () => {
    const order = await seedOrder();
    const ev = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_1", amount_total: 10500, currency: "eur",
    });
    const r = await post(app, JSON.stringify(ev));
    expect(r.status).toBe(200);
    const row = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("sold");
    expect(row.rows[0].payment_intent_id).toBe("pi_1");
    const item = await db.query("SELECT status FROM items WHERE id = $1", [order.item_id]);
    expect(item.rows[0].status).toBe("sold");
  });

  it("amount mismatch is a 2xx rejection with no state change; processing payment_status is ignored (F5)", async () => {
    const order = await seedOrder();
    const bad = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_2", amount_total: 100, currency: "eur",
    });
    const r1 = await post(app, JSON.stringify(bad));
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ rejected: expect.stringContaining("mismatch") });
    const processing = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "processing", payment_intent: "pi_3", amount_total: 10500, currency: "eur",
    });
    const r2 = await post(app, JSON.stringify(processing));
    expect(r2.status).toBe(200);
    const row = await db.query("SELECT status, payment_intent_id FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].payment_intent_id).toBeNull();
    const we = await db.query("SELECT process_error FROM webhook_events WHERE external_id = $1", [bad.id]);
    expect(we.rows[0].process_error).toContain("rejected");
  });

  it("duplicate event id is a 200 no-op (replay-safe, §5.4)", async () => {
    const order = await seedOrder();
    const ev = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_1", amount_total: 10500, currency: "eur",
    }, "evt_dup");
    await post(app, JSON.stringify(ev));
    const r2 = await post(app, JSON.stringify(ev));
    expect(r2.status).toBe(200);
    expect(r2.json).toEqual({ received: true, duplicate: true });
    const we = await db.query("SELECT count(*)::int AS c FROM webhook_events WHERE external_id = 'evt_dup'");
    expect(we.rows[0].c).toBe(1);
  });

  it("late payment on a cancelled order auto-refunds and alerts (F2) — never a stranded payment", async () => {
    const order = await seedOrder();
    await applyTransition({ orderId: order.id, trigger: "cancel_order", actor: { type: "buyer", id: buyerId } });
    const ev = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_late", amount_total: 10500, currency: "eur",
    });
    const r = await post(app, JSON.stringify(ev));
    expect(r.status).toBe(200);
    const row = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("cancelled"); // terminal state preserved
    expect(row.rows[0].refund_id).toBe(`re_${n0}`);
    const alert = await db.query("SELECT count(*)::int AS c FROM order_events WHERE order_id = $1 AND event_type = 'unexpected_payment'", [order.id]);
    expect(alert.rows[0].c).toBe(1);
  });

  it("transfer.paid: payout_pending → paid_out; unknown transfers are stored no-ops", async () => {
    const order = await seedOrder();
    await db.query("UPDATE orders SET status = 'payout_pending', payment_intent_id = 'pi_9' WHERE id = $1", [order.id]);
    const ev = event("transfer.paid", { id: "tr_1", object: "transfer" });
    const r0 = await post(app, JSON.stringify(ev)); // unknown transfer → stored, 200
    expect(r0.status).toBe(200);
    await db.query("UPDATE orders SET transfer_id = 'tr_1' WHERE id = $1", [order.id]);
    const ev2 = event("transfer.paid", { id: "tr_1", object: "transfer" });
    const r = await post(app, JSON.stringify(ev2));
    expect(r.status).toBe(200);
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("paid_out");
  });

  it("charge.refunded: refunding → refunded", async () => {
    const order = await seedOrder();
    await db.query("UPDATE orders SET status = 'refunding', payment_intent_id = 'pi_5', refund_id = 're_9' WHERE id = $1", [order.id]);
    // SDK shape: the event object is the Charge; the Refund rides in refunds.data
    const ev = event("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_5", refunds: { data: [{ id: "re_9" }] } });
    const r = await post(app, JSON.stringify(ev));
    expect(r.status).toBe(200);
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("refunded");
  });

  it("charge.dispute.created → disputed from delivered; closed-won restores the pre-dispute state (#22r)", async () => {
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET status = 'delivered', payment_intent_id = 'pi_7', dispute_deadline = now() + interval '1 day' WHERE id = $1",
      [order.id],
    );
    const created = event("charge.dispute.created", { id: "dp_1", object: "dispute", payment_intent: "pi_7", reason: "fraudulent" });
    const r1 = await post(app, JSON.stringify(created));
    expect(r1.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("disputed");

    const closed = event("charge.dispute.closed", { id: "dp_1", object: "dispute", payment_intent: "pi_7", status: "won" });
    const r2 = await post(app, JSON.stringify(closed));
    expect(r2.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("delivered");
  });

  it("account.updated: known connected accounts set/clear stripe_onboarded_at; unknown ids change nothing (F5)", async () => {
    const order = await seedOrder();
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId])).rows[0].stripe_account_id;
    const on = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "active" } });
    await post(app, JSON.stringify(on));
    const set = await db.query("SELECT stripe_onboarded_at IS NOT NULL AS ok FROM sellers WHERE id = $1", [sellerId]);
    expect(set.rows[0].ok).toBe(true);

    const off = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "pending" } });
    await post(app, JSON.stringify(off));
    const cleared = await db.query("SELECT stripe_onboarded_at IS NULL AS ok FROM sellers WHERE id = $1", [sellerId]);
    expect(cleared.rows[0].ok).toBe(true);

    const unknown = event("account.updated", { id: "acct_stranger", object: "account", capabilities: { transfers: "active" } });
    await post(app, JSON.stringify(unknown));
    const unchanged = await db.query("SELECT count(*)::int AS c FROM sellers WHERE stripe_account_id IS NOT NULL AND stripe_onboarded_at IS NOT NULL");
    expect(unchanged.rows[0].c).toBe(0);
  });

  it("livemode mismatch is stored redacted and never processed (F5/§6.7)", async () => {
    const ev = event("checkout.session.completed", {
      id: "cs_live_x", object: "checkout_session", payment_status: "paid",
      payment_intent: "pi_live", amount_total: 10500, currency: "eur",
    });
    const live = { ...ev, livemode: true } as Stripe.Event;
    const r = await post(app, JSON.stringify(live));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ received: true, rejected: "livemode mismatch" });
    const we = await db.query("SELECT payload->>'id' AS id, process_error FROM webhook_events WHERE external_id = $1", [ev.id]);
    expect(we.rows[0].id).toBe(ev.id);
    expect(we.rows[0].process_error).toContain("livemode");
  });

  it("redaction at ingest (F6): no customer_details or free text is stored", async () => {
    const order = await seedOrder();
    const ev = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session", payment_status: "paid",
      payment_intent: "pi_r", amount_total: 10500, currency: "eur",
      customer_details: { email: "buyer@example.com", address: { line1: "1 Privy St" } },
    });
    await post(app, JSON.stringify(ev));
    const we = await db.query("SELECT payload::text AS p FROM webhook_events WHERE external_id = $1", [ev.id]);
    expect(we.rows[0].p).not.toContain("buyer@example.com");
    expect(we.rows[0].p).not.toContain("Privy");
  });
});
