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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { pool } from "../src/db.js";
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
// THI-1611 A1: the 'Connected accounts'-scoped endpoint has its own signing
// secret (and a rotation twin) — distinct values from the platform endpoint's.
const CONNECT_SECRET = "whsec_connect_secret";
const CONNECT_PREVIOUS = "whsec_connect_old_secret";
const stripe = new StripeCtor("sk_test_k1");

const n0 = Math.random().toString(36).slice(2, 8);

/** Fake Stripe client: real constructEvent (crypto), fake money calls.
 *  `transfersImpl` (A3 tests) overrides the transfer recovery calls — default
 *  retrieve reports an unreversed transfer, createReversal succeeds. */
function fakeStripe(
  refundImpl?: () => unknown,
  transfersImpl?: { retrieve?: (id: string) => unknown; createReversal?: (id: string) => unknown },
): Stripe {
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
    transfers: {
      retrieve: async (id: string) =>
        transfersImpl?.retrieve ? transfersImpl.retrieve(id) : { id, amount_reversed: false },
      createReversal: async (id: string) =>
        transfersImpl?.createReversal ? transfersImpl.createReversal(id) : { id: `trr_${id}` },
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
function buildApp(withConnectSecret = true): express.Express {
  const app = express();
  const cfg = {
    stripePaymentsEnabled: true, stripeMode: "test",
    stripeWebhookReady: true, stripeWebhookSecret: SECRET, stripeWebhookSecretPrevious: PREVIOUS,
    ...(withConnectSecret ? { stripeConnectWebhookSecret: CONNECT_SECRET, stripeConnectWebhookSecretPrevious: CONNECT_PREVIOUS } : {}),
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
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
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

  it("returns 500 with no unhandled rejection when the DB fails at ingest — dedupe store (THI-64 V1 regression)", async () => {
    const spy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("ECONNREFUSED db down"));
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = await post(app, JSON.stringify(event("checkout.session.completed", { id: "cs_ing1", payment_status: "paid" })));
      expect(r.status).toBe(500);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      spy.mockRestore();
    }
    expect(unhandled).toBeNull();
  });

  it("returns 500 with no unhandled rejection when pool.connect fails; row marked for sweep rule 6 (THI-64 V1 regression)", async () => {
    // Pre-store the dedupe row (the mocked dedupe query below hands the
    // handler this id) — note node-pg's pool.query internally acquires via
    // connect(), so the connect spy must only see the handler's explicit
    // pool.connect() call, never a query's internal callback-style one.
    const evt = event("checkout.session.completed", { id: "cs_ing2", payment_status: "paid" });
    const pre = await db.query<{ id: string }>(
      "INSERT INTO webhook_events (source, external_id, payload) VALUES ('stripe', $1, '{}'::jsonb) RETURNING id",
      [evt.id],
    );
    const querySpy = vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [{ id: pre.rows[0].id }] } as never);
    const connectSpy = vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("pool exhausted"));
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = await post(app, JSON.stringify(evt));
      expect(r.status).toBe(500);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      querySpy.mockRestore();
      connectSpy.mockRestore();
    }
    expect(unhandled).toBeNull();
    // stored-but-unprocessed row must be marked so rule 6 reprocesses it —
    // the dedupe path would otherwise swallow it as `duplicate`.
    const row = await db.query<{ process_error: string | null; processed_at: Date | null }>(
      "SELECT process_error, processed_at FROM webhook_events WHERE source = 'stripe'",
    );
    expect(row.rows[0].process_error).toMatch(/^ingest failed/);
    expect(row.rows[0].processed_at).toBeNull();
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

  it("quote-mode F5 (buyer-paid shipping §3): amount_total = price + label is accepted; price-only is a mismatch", async () => {
    const order = await seedOrder();
    // Turn the seeded order into a quote-mode row exactly as createOrder
    // would have: label_quote set, flat amount stored 0.
    await db.query(
      "UPDATE orders SET label_quote = $2::jsonb, shipping_price_cents = 0 WHERE id = $1",
      [order.id, JSON.stringify({ shipment_id: "shp_1", rate_id: "rate_1", carrier: "DPD", service: "Classic", amount_cents: 733, currency: "EUR", weight_grams: 2000, dimensions_mm: null, origin: { name: "S", line1: "1", city: "C", postal_code: "00", country: "IT" }, destination: { name: "B", line1: "1", city: "C", postal_code: "00", country: "IT" }, quoted_at: "2026-11-18T00:00:00Z" })],
    );
    const good = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_q", amount_total: 10733, currency: "eur",
    });
    const r1 = await post(app, JSON.stringify(good));
    expect(r1.status).toBe(200);
    const row = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("sold");
    expect(row.rows[0].payment_intent_id).toBe("pi_q");
  });

  it("quote-mode F5: a session that omits the label line (price-only amount) is rejected", async () => {
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET label_quote = $2::jsonb, shipping_price_cents = 0 WHERE id = $1",
      [order.id, JSON.stringify({ shipment_id: "shp_1", rate_id: "rate_1", carrier: "DPD", service: "Classic", amount_cents: 733, currency: "EUR", weight_grams: 2000, dimensions_mm: null, origin: { name: "S", line1: "1", city: "C", postal_code: "00", country: "IT" }, destination: { name: "B", line1: "1", city: "C", postal_code: "00", country: "IT" }, quoted_at: "2026-11-18T00:00:00Z" })],
    );
    const bad = event("checkout.session.completed", {
      id: order.checkout_session_id, object: "checkout_session",
      payment_status: "paid", payment_intent: "pi_q2", amount_total: 10000, currency: "eur",
    });
    const r1 = await post(app, JSON.stringify(bad));
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ rejected: expect.stringContaining("mismatch") });
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].status).toBe("pending");
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

  // --- THI-1611 A1: Connect-scoped endpoint secret -------------------------

  it("connect-scoped account.updated (signed with STRIPE_CONNECT_WEBHOOK_SECRET) flips stripe_onboarded_at — the payout-ready path (THI-1611 A1)", async () => {
    const order = await seedOrder();
    // seedOrder() pre-boards; reset to the un-onboarded state under test.
    await db.query("UPDATE sellers SET stripe_onboarded_at = NULL WHERE id = $1", [sellerId]);
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId])).rows[0].stripe_account_id;
    const on = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "active" } });
    const r = await post(app, JSON.stringify(on), { secret: CONNECT_SECRET });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ received: true });
    const set = await db.query("SELECT stripe_onboarded_at IS NOT NULL AS ok FROM sellers WHERE id = $1", [sellerId]);
    expect(set.rows[0].ok).toBe(true);
    // The flip (NULL→set) is also the seller notification trigger — exercised,
    // not just the column write.
    const notified = await db.query("SELECT count(*)::int AS c FROM notifications WHERE event_type = 'seller.payouts_enabled'");
    expect(notified.rows[0].c).toBe(1);
    expect(order.status).toBe("pending"); // untouched by onboarding
  });

  it("a bad Connect secret is a 400 and never writes (THI-1611 A1: 400-on-all-fail, F12)", async () => {
    await seedOrder();
    await db.query("UPDATE sellers SET stripe_onboarded_at = NULL WHERE id = $1", [sellerId]);
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId])).rows[0].stripe_account_id;
    const on = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "active" } });
    const r = await post(app, JSON.stringify(on), { secret: "whsec_wrong_connect_secret" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "signature verification failed" });
    const rows = await db.query("SELECT count(*)::int AS c FROM webhook_events");
    expect(rows.rows[0].c).toBe(0); // no ingest on a bad signature
    const flag = await db.query("SELECT stripe_onboarded_at IS NULL AS ok FROM sellers WHERE id = $1", [sellerId]);
    expect(flag.rows[0].ok).toBe(true); // no state change either
  });

  it("accepts the Connect PREVIOUS secret during rotation (F13, THI-1611 A1)", async () => {
    await seedOrder();
    await db.query("UPDATE sellers SET stripe_onboarded_at = NULL WHERE id = $1", [sellerId]);
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId])).rows[0].stripe_account_id;
    const on = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "active" } });
    const r = await post(app, JSON.stringify(on), { secret: CONNECT_PREVIOUS });
    expect(r.status).toBe(200);
    const set = await db.query("SELECT stripe_onboarded_at IS NOT NULL AS ok FROM sellers WHERE id = $1", [sellerId]);
    expect(set.rows[0].ok).toBe(true);
  });

  it("without STRIPE_CONNECT_WEBHOOK_SECRET configured, a Connect-signed delivery 400s exactly as before (self-hosters unchanged)", async () => {
    await seedOrder();
    await db.query("UPDATE sellers SET stripe_onboarded_at = NULL WHERE id = $1", [sellerId]);
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId])).rows[0].stripe_account_id;
    const on = event("account.updated", { id: acct, object: "account", capabilities: { transfers: "active" } });
    const bare = buildApp(false);
    let closeBare = () => {};
    await new Promise<void>((resolve) => {
      const s = bare.listen(0, "127.0.0.1", () => {
        (bare as unknown as { _port: number })._port = (s.address() as net.AddressInfo).port;
        closeBare = () => s.close();
        resolve();
      });
    });
    try {
      const r = await post(bare, JSON.stringify(on), { secret: CONNECT_SECRET });
      expect(r.status).toBe(400);
      const rows = await db.query("SELECT count(*)::int AS c FROM webhook_events");
      expect(rows.rows[0].c).toBe(0);
    } finally {
      closeBare();
    }
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

  // --- A3 (THI-1611 §A3): disputes on terminal orders — never a silent drop.

  /** Seed a paid_out stripe order with a transfer on record. */
  async function seedPaidOut(pi: string, transfer: string): Promise<OrderRow> {
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET status = 'paid_out', payment_intent_id = $2, transfer_id = $3 WHERE id = $1",
      [order.id, pi, transfer],
    );
    return order as OrderRow;
  }

  it("A3: charge.dispute.created on paid_out — durable alert + automatic transfer reversal, order stays paid_out", async () => {
    const order = await seedPaidOut("pi_a3c", "tr_a3c");
    process.env.OPERATOR_ALERT_EMAIL = "ops@t.dev";
    const reversals: string[] = [];
    setStripeForTests(fakeStripe(undefined, { createReversal: async (id) => { reversals.push(id); return { id: `trr_${id}` }; } }));
    try {
      const ev = event("charge.dispute.created", { id: "dp_a3c", object: "dispute", payment_intent: "pi_a3c", reason: "product_not_received", status: "under_review" });
      const r = await post(app, JSON.stringify(ev));
      expect(r.status).toBe(200);
      // Terminal order untouched, event processed (not stale-marked)
      expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("paid_out");
      const we = await db.query("SELECT process_error FROM webhook_events WHERE external_id = $1", [ev.id]);
      expect(we.rows[0].process_error).toBeNull();
      // Durable record + recorded reversal outcome
      const evs = await db.query(
        "SELECT event_type, payload->>'outcome' AS outcome, payload->>'reversal_id' AS rid FROM order_events WHERE order_id = $1 AND event_type IN ('terminal_dispute','transfer_reversal')",
        [order.id],
      );
      expect(evs.rows.map((x) => x.event_type).sort()).toEqual(["terminal_dispute", "transfer_reversal"]);
      const rev = evs.rows.find((x) => x.event_type === "transfer_reversal");
      expect(rev.outcome).toBe("succeeded");
      expect(rev.rid).toBe("trr_tr_a3c");
      expect(reversals).toEqual(["tr_a3c"]); // §6.6 idempotency key — one call
      // Operator alert mirrored to the outbox
      const alert = await db.query("SELECT template FROM email_outbox WHERE dedupe_key = $1", [`opalert:post_payout_chargeback:${ev.id}`]);
      expect(alert.rows.length).toBe(1);
      expect(alert.rows[0].template).toBe("operator.post_payout_chargeback.v1");
    } finally {
      delete process.env.OPERATOR_ALERT_EMAIL;
    }
  });

  it("A3: charge.dispute.closed (lost) on paid_out with already-reversed transfer — recorded, no duplicate reversal", async () => {
    const order = await seedPaidOut("pi_a3l", "tr_a3l");
    process.env.OPERATOR_ALERT_EMAIL = "ops@t.dev";
    let reversalCalls = 0;
    setStripeForTests(fakeStripe(undefined, {
      retrieve: async (id) => ({ id, amount_reversed: true }),
      createReversal: async () => { reversalCalls += 1; return { id: "trr_never" }; },
    }));
    try {
      const ev = event("charge.dispute.closed", { id: "dp_a3l", object: "dispute", payment_intent: "pi_a3l", status: "lost" });
      const r = await post(app, JSON.stringify(ev));
      expect(r.status).toBe(200);
      const rev = await db.query(
        "SELECT payload->>'outcome' AS outcome FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversal'",
        [order.id],
      );
      expect(rev.rows[0].outcome).toBe("already_reversed");
      expect(reversalCalls).toBe(0);
      const escalate = await db.query("SELECT 1 FROM email_outbox WHERE dedupe_key = $1", [`opalert:reversal_failed:${order.id}`]);
      expect(escalate.rows.length).toBe(0); // benign outcome — no escalation
    } finally {
      delete process.env.OPERATOR_ALERT_EMAIL;
    }
  });

  it("A3: failed reversal escalates — durable failed outcome + reversal_failed alert", async () => {
    const order = await seedPaidOut("pi_a3f", "tr_a3f");
    process.env.OPERATOR_ALERT_EMAIL = "ops@t.dev";
    setStripeForTests(fakeStripe(undefined, { createReversal: async () => { throw new Error("insufficient funds"); } }));
    try {
      const ev = event("charge.dispute.created", { id: "dp_a3f", object: "dispute", payment_intent: "pi_a3f", reason: "fraudulent", status: "under_review" });
      const r = await post(app, JSON.stringify(ev));
      expect(r.status).toBe(200);
      const rev = await db.query(
        "SELECT payload->>'outcome' AS outcome, payload->>'error' AS err FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversal'",
        [order.id],
      );
      expect(rev.rows[0].outcome).toBe("failed");
      expect(rev.rows[0].err).toContain("insufficient funds");
      const escalate = await db.query("SELECT template FROM email_outbox WHERE dedupe_key = $1", [`opalert:reversal_failed:${order.id}`]);
      expect(escalate.rows.length).toBe(1);
      expect(escalate.rows[0].template).toBe("operator.reversal_failed.v1");
    } finally {
      delete process.env.OPERATOR_ALERT_EMAIL;
    }
  });

  it("A3: charge.dispute.closed (won) on paid_out — alert only, no clawback", async () => {
    const order = await seedPaidOut("pi_a3w", "tr_a3w");
    let reversalCalls = 0;
    setStripeForTests(fakeStripe(undefined, { createReversal: async () => { reversalCalls += 1; return { id: "trr_never" }; } }));
    const ev = event("charge.dispute.closed", { id: "dp_a3w", object: "dispute", payment_intent: "pi_a3w", status: "won" });
    const r = await post(app, JSON.stringify(ev));
    expect(r.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("paid_out");
    const dispute = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'terminal_dispute'", [order.id]);
    expect(dispute.rows.length).toBe(1); // recorded + alerted even though nothing reverses
    const rev = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversal'", [order.id]);
    expect(rev.rows.length).toBe(0); // won representment — payout stands
    expect(reversalCalls).toBe(0);
  });
});
