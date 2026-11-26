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
 *  `reversalImpl` simulates transfer.createReversal failures (A2 race arm). */
function fakeStripe(refundImpl?: () => unknown, reversalImpl?: () => unknown): Stripe {
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
    charges: {
      // A2: a lost dispute auto-refunds the charge — the id rides on the charge
      retrieve: async () => ({ id: "ch_lost", refunds: { data: [{ id: `re_${n0}` }] } }),
    },
    transfers: {
      createReversal: async () => {
        if (reversalImpl) await reversalImpl();
        return { id: "tr_reversal", amount: 10500 };
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
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers, email_outbox RESTART IDENTITY CASCADE");
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

  it("transfer.reversed: durable order_events.transfer_reversed marker, no transition (A6/THI-1624)", async () => {
    const order = await seedOrder();
    await db.query("UPDATE orders SET status = 'paid_out', transfer_id = 'tr_9', payment_intent_id = 'pi_9' WHERE id = $1", [order.id]);
    const ev = event("transfer.reversed", {
      id: "tr_9", object: "transfer", amount: 7300, amount_reversed: 7300, currency: "eur",
    });
    const r = await post(app, JSON.stringify(ev));
    expect(r.status).toBe(200);
    const rows = await db.query(
      "SELECT event_type, actor_type, actor_id, payload FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversed'",
      [order.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].actor_id).toBe(ev.id);
    const payload = rows.rows[0].payload as Record<string, unknown>;
    expect(payload.transfer_id).toBe("tr_9");
    expect(payload.amount_reversed).toBe(7300);
    // No order transition: the refund/dispute path already settled the state.
    const ord = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(ord.rows[0].status).toBe("paid_out");
    // Replay-safe: a duplicate event id adds no second marker.
    await post(app, JSON.stringify(ev));
    const again = await db.query(
      "SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversed'",
      [order.id],
    );
    expect(again.rows[0].n).toBe(1);
    // Unknown transfer: stored, 200, no marker.
    const stranger = event("transfer.reversed", { id: "tr_stranger", object: "transfer", amount_reversed: 100 });
    const r2 = await post(app, JSON.stringify(stranger));
    expect(r2.status).toBe(200);
    const none = await db.query("SELECT count(*)::int AS n FROM order_events WHERE event_type = 'transfer_reversed' AND payload->>'transfer_id' = 'tr_stranger'");
    expect(none.rows[0].n).toBe(0);
  });

  it("payout.failed: deduped operator alert row; replay and re-delivery never duplicate (A6/THI-1624)", async () => {
    const order = await seedOrder(); // seeds the seller with stripe_account_id acct_<n>
    const acct = (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = $1", [order.seller_id])).rows[0].stripe_account_id;
    process.env.OPERATOR_ALERT_EMAIL = "ops@t.dev";
    try {
      const ev = event("payout.failed", {
          id: "po_1", object: "payout", amount: 7300, currency: "eur",
          failure_code: "account_closed", failure_message: "The bank account has been closed.",
        });
      const withAccount = { ...ev, account: acct } as Stripe.Event;
      const r = await post(app, JSON.stringify(withAccount));
      expect(r.status).toBe(200);
      const outbox = await db.query(
        "SELECT to_email, subject, template, dedupe_key, payload FROM email_outbox WHERE dedupe_key = $1",
        ["opalert:payout_failed:po_1"],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].template).toBe("operator.payout_failed.v1");
      expect(outbox.rows[0].to_email).toBe("ops@t.dev");
      const payload = outbox.rows[0].payload as Record<string, unknown>;
      expect(payload.kind).toBe("payout_failed");
      expect(JSON.stringify(payload)).toContain(acct);
      expect(JSON.stringify(payload)).toContain(order.seller_id);
      // Same payout, DIFFERENT event id (Stripe retry semantics vary): the
      // outbox dedupe key keeps it at-most-once per payout.
      const secondDelivery = event(
        "payout.failed",
        { id: "po_1", object: "payout", amount: 7300, currency: "eur", failure_code: "account_closed" },
      );
      await post(app, JSON.stringify({ ...secondDelivery, account: acct } as Stripe.Event));
      const still = await db.query("SELECT count(*)::int AS n FROM email_outbox WHERE dedupe_key = $1", ["opalert:payout_failed:po_1"]);
      expect(still.rows[0].n).toBe(1);
    } finally {
      delete process.env.OPERATOR_ALERT_EMAIL;
    }
  });

  it("payout.failed with no OPERATOR_ALERT_EMAIL stays log-only — no outbox row, still 200 (A6)", async () => {
    await seedOrder();
    delete process.env.OPERATOR_ALERT_EMAIL;
    const ev = event("payout.failed", { id: "po_2", object: "payout", amount: 500, currency: "eur", failure_code: "account_closed" });
    const r = await post(app, JSON.stringify({ ...ev, account: (await db.query<{ stripe_account_id: string }>("SELECT stripe_account_id FROM sellers WHERE id = (SELECT seller_id FROM orders ORDER BY created_at DESC LIMIT 1)")).rows[0].stripe_account_id } as Stripe.Event));
    expect(r.status).toBe(200);
    const outbox = await db.query("SELECT count(*)::int AS n FROM email_outbox WHERE template = 'operator.payout_failed.v1'");
    expect(outbox.rows[0].n).toBe(0);
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

  // --- A2 (THI-1611): lost chargebacks reach a terminal state; release refused

  it("A2: dispute.closed lost → refunded terminal; item active; refund_id recorded; alert fired; admin_release refused", async () => {
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET status = 'delivered', payment_intent_id = 'pi_a2', dispute_deadline = now() + interval '1 day' WHERE id = $1",
      [order.id],
    );
    const created = event("charge.dispute.created", { id: "dp_a2", object: "dispute", payment_intent: "pi_a2", reason: "product_not_received" });
    await post(app, JSON.stringify(created));
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("disputed");

    process.env.OPERATOR_ALERT_EMAIL = "ops-a2@test.dev";
    try {
      const closed = event("charge.dispute.closed", { id: "dp_a2", object: "dispute", payment_intent: "pi_a2", status: "lost", charge: "ch_a2" });
      const r = await post(app, JSON.stringify(closed));
      expect(r.status).toBe(200);
    } finally {
      delete process.env.OPERATOR_ALERT_EMAIL;
    }

    const row = (await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id])).rows[0];
    expect(row.status).toBe("refunded"); // terminal from the moment the verdict lands
    expect(row.refund_id).toBe(`re_${n0}`); // Stripe-provided refund id recorded
    const item = await db.query("SELECT status FROM items WHERE id = $1", [order.item_id]);
    expect(item.rows[0].status).toBe("active"); // seller may relist
    const transition = await db.query(
      "SELECT count(*)::int AS c FROM order_events WHERE order_id = $1 AND event_type = 'transition' AND to_status = 'refunded' AND reason LIKE '%dp_a2 lost%'",
      [order.id],
    );
    expect(transition.rows[0].c).toBe(1); // durable order_events entry
    const alert = await db.query(
      "SELECT count(*)::int AS c FROM email_outbox WHERE dedupe_key = $1 AND template = 'operator.dispute_lost.v1'",
      [`opalert:${order.id}`],
    );
    expect(alert.rows[0].c).toBe(1); // operator alert fired

    // Release attempt refused: refunded is terminal — #19 has no edge from it.
    await expect(
      applyTransition({ orderId: order.id, trigger: "admin_release", actor: { type: "admin", id: "op" } }),
    ).rejects.toThrow(/invalid_transition/);
  });

  it("A2 race: lost verdict on payout_pending → refunded + in-flight transfer reversed (durable record)", async () => {
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET status = 'payout_pending', payment_intent_id = 'pi_race', transfer_id = 'tr_race' WHERE id = $1",
      [order.id],
    );
    const closed = event("charge.dispute.closed", { id: "dp_race", object: "dispute", payment_intent: "pi_race", status: "lost", charge: "ch_race" });
    const r = await post(app, JSON.stringify(closed));
    expect(r.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("refunded");
    const reversed = await db.query(
      "SELECT payload FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversed' AND dedupe_key = $2",
      [order.id, `dispute_lost_reversal:${order.id}`],
    );
    expect(reversed.rows.length).toBe(1);
    expect(reversed.rows[0].payload).toMatchObject({ transfer_id: "tr_race" });
  });

  it("A2: charge_refunded closure (dispute settled by refund) → refunded terminal; refund id optional", async () => {
    const order = await seedOrder();
    await db.query("UPDATE orders SET status = 'disputed', payment_intent_id = 'pi_cr' WHERE id = $1", [order.id]);
    const closed = event("charge.dispute.closed", { id: "dp_cr", object: "dispute", payment_intent: "pi_cr", status: "charge_refunded" });
    const r = await post(app, JSON.stringify(closed));
    expect(r.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("refunded");
  });

  it("A2: failed in-flight reversal is recorded durably; the order still terminals (tracked debt, not a log line)", async () => {
    setStripeForTests(fakeStripe(undefined, () => { throw new Error("reversal declined"); }));
    const order = await seedOrder();
    await db.query(
      "UPDATE orders SET status = 'payout_pending', payment_intent_id = 'pi_revfail', transfer_id = 'tr_fail' WHERE id = $1",
      [order.id],
    );
    const closed = event("charge.dispute.closed", { id: "dp_rf", object: "dispute", payment_intent: "pi_revfail", status: "lost", charge: "ch_rf" });
    const r = await post(app, JSON.stringify(closed));
    expect(r.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("refunded");
    const failed = await db.query(
      "SELECT reason FROM order_events WHERE order_id = $1 AND event_type = 'transfer_reversal_failed'",
      [order.id],
    );
    expect(failed.rows.length).toBe(1);
    expect(failed.rows[0].reason).toContain("tr_fail");
  });

  it("A2: lost verdict on a refunding order is stale — the refund path owns it (§5.4 rule 4)", async () => {
    const order = await seedOrder();
    await db.query("UPDATE orders SET status = 'refunding', payment_intent_id = 'pi_stale', refund_id = 're_stale' WHERE id = $1", [order.id]);
    const closed = event("charge.dispute.closed", { id: "dp_st", object: "dispute", payment_intent: "pi_stale", status: "lost", charge: "ch_st" });
    const r = await post(app, JSON.stringify(closed));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ stale: true });
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status).toBe("refunding");
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
});
