// Carrier webhook endpoint (spec THI-3 rev 2 §4.3/§5.2–§5.4; PR-7).
// HTTP-level against a real express app; HMACs minted with node:crypto.
// Postgres-backed — same harness shape as stripe-webhook.test.ts.

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
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
import { carrierWebhookRouter } from "../src/webhooks-carrier.js";
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

const SECRET = "ezp_test_secret";
const PREVIOUS = "ezp_old_secret";
const stripe = new StripeCtor("sk_test_k1");

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function trackerEvent(status: string, trackerId: string, opts: { code?: string; carrier?: string; details?: unknown[] } = {}): string {
  return JSON.stringify({
    description: "tracker.updated",
    mode: "test",
    result: {
      id: trackerId,
      object: "Tracker",
      tracking_code: opts.code ?? "9400111899223197428490",
      carrier: opts.carrier ?? "USPS",
      status,
      tracking_details: opts.details ?? [
        { status: "pre_transit", message: "INFO RECEIVED", datetime: "2026-10-13T10:00:00Z" },
        { status, message: `Signed by J. DOE (${status})`, datetime: "2026-10-13T12:00:00Z" },
      ],
    },
  });
}

function buildApp(cfg?: Partial<OrderFlowConfig>): express.Express {
  const app = express();
  app.use(
    carrierWebhookRouter({
      carrierWebhookReady: true,
      easypostWebhookSecret: SECRET,
      easypostWebhookSecretPrevious: PREVIOUS,
      disputeWindowHours: 48,
      ...cfg,
    } as unknown as OrderFlowConfig),
  );
  return app;
}

async function post(
  app: express.Express,
  body: string | Buffer,
  opts: { secret?: string; ct?: string; sig?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const res = await fetch(`http://127.0.0.1:${(app as unknown as { _port: number })._port}/api/webhooks/carrier`, {
    method: "POST",
    headers: {
      "Content-Type": opts.ct ?? "application/json",
      "X-Hmac-Signature": opts.sig ?? sign(payload, opts.secret ?? SECRET),
    },
    body: payload,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe.skipIf(!available)("Carrier webhook endpoint (HTTP)", () => {
  let db: pg.Client;
  let app: express.Express;
  let server: Server;
  let n = 0;

  /** Seeds a stripe-mode order and walks it to `label_issued` (tracking set),
   * unless `at` says otherwise. Returns the order row + party ids. */
  async function seedOrder(
    at: "label_issued" | "in_transit" = "label_issued",
    opts: { trackerId?: string | null; mode?: "stripe" | "off_platform" } = {},
  ): Promise<{ order: OrderRow; sellerId: string; buyerId: string; itemId: string }> {
    n += 1;
    const s = `cs${n}`, b = `cb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const ids = await db.query<{ s: string; b: string }>(
      "SELECT (SELECT id FROM sellers WHERE email=$1) AS s, (SELECT id FROM sellers WHERE email=$2) AS b",
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    const sellerId = ids.rows[0].s;
    const buyerId = ids.rows[0].b;
    if ((opts.mode ?? "stripe") === "stripe") {
      process.env.STRIPE_SECRET_KEY = "sk_test_k1";
      await db.query("UPDATE sellers SET stripe_account_id=$2, stripe_onboarded_at=now() WHERE id=$1", [sellerId, `acct_${n}`]);
    }
    const item = await db.query<{ id: string }>(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier) VALUES ($1,$2,10000,500,'parcel') RETURNING id",
      [sellerId, `Item ${n}`],
    );
    const { order } = await createOrder({
      buyerId,
      itemId: item.rows[0].id,
      shippingAddress: { name: "B", line1: "1 St", city: "C", postal_code: "00", country: "IT" },
      paymentMode: opts.mode ?? "stripe",
    });
    await applyTransition({
      orderId: order.id,
      trigger: (opts.mode ?? "stripe") === "stripe" ? "stripe_payment" : "confirm_payment",
      actor: (opts.mode ?? "stripe") === "stripe" ? { type: "stripe" } : { type: "seller", id: sellerId },
      sets: { payment_intent_id: `pi_${n}` },
    });
    const sold = await applyTransition({
      orderId: order.id, trigger: "record_tracking", actor: { type: "seller", id: sellerId },
      sets: { carrier: "USPS", tracking_code: `940011189922319742849${n}`, ...(opts.trackerId === null ? {} : { tracker_id: opts.trackerId ?? `trk_${n}` }) },
    });
    let current = sold;
    if (at === "in_transit") {
      current = await applyTransition({
        orderId: order.id, trigger: "carrier_update", actor: { type: "carrier", id: opts.trackerId ?? `trk_${n}` },
      });
    }
    return { order: current, sellerId, buyerId, itemId: item.rows[0].id };
  }

  async function orderRow(id: string): Promise<OrderRow> {
    const { rows } = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]);
    return rows[0];
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        (app as unknown as { _port: number })._port = (server.address() as net.AddressInfo).port;
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
    const n0 = Math.random().toString(36).slice(2, 8);
    let csSeq = 0;
    setStripeForTests({
      webhooks: stripe.webhooks,
      checkout: {
        sessions: {
          create: async () => ({ id: `cs_${n0}_${++csSeq}`, url: `https://pay.test/${n0}/${csSeq}` }),
          expire: async () => ({}),
          retrieve: async () => ({ payment_status: "unpaid" }),
        },
      },
      refunds: { create: async () => ({ id: `re_${n0}_${Math.random().toString(36).slice(2, 6)}` }) },
    } as unknown as Stripe);
  });

  it("rejects non-JSON, empty bodies, missing/wrong/tampered/malformed signatures with 400 — and writes nothing (F12, §5.3)", async () => {
    const body = trackerEvent("in_transit", "trk_x");
    const cases: { opts: Parameters<typeof post>[2] }[] = [
      { opts: { ct: "text/plain" } },
      { opts: { sig: "" } },
      { opts: { secret: "ezp_wrong" } },
      { opts: { sig: "deadbeef" } }, // length-mismatch throw must be caught, not crash
      { opts: { sig: sign("tampered body") } }, // valid HMAC, wrong payload
    ];
    for (const { opts } of cases) {
      const r = await post(app, body, opts);
      expect(r.status).toBe(400);
    }
    const count = await db.query("SELECT count(*)::int AS c FROM webhook_events");
    expect(count.rows[0].c).toBe(0);
  });

  it("rejects invalid JSON even with a valid signature (400, no write)", async () => {
    const bad = "{not json";
    const r = await post(app, bad);
    expect(r.status).toBe(400);
    const count = await db.query("SELECT count(*)::int AS c FROM webhook_events");
    expect(count.rows[0].c).toBe(0);
  });

  it("accepts the previous secret during rotation (F13)", async () => {
    const r = await post(app, trackerEvent("pre_transit", "trk_none"), { secret: PREVIOUS });
    expect(r.status).toBe(200);
  });

  it("returns 503 with no write when the webhook is not configured (F1)", async () => {
    const uncfg = buildApp({ carrierWebhookReady: false, easypostWebhookSecret: undefined });
    await new Promise<void>((resolve) => {
      const srv = uncfg.listen(0, "127.0.0.1", () => {
        (uncfg as unknown as { _port: number })._port = (srv.address() as net.AddressInfo).port;
        resolve();
      });
    });
    try {
      const r = await post(uncfg, trackerEvent("in_transit", "trk_x"));
      expect(r.status).toBe(503);
    } finally {
      (uncfg as unknown as { _port: number })._port && void 0;
      uncfg.close?.();
    }
  });

  it("resolves via tracker_id and advances label_issued → in_transit (#10)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_10" });
    const r = await post(app, trackerEvent("in_transit", "trk_10"));
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("in_transit");
  });

  it("delivered sets dispute_deadline (in_transit → delivered, #12)", async () => {
    const { order } = await seedOrder("in_transit", { trackerId: "trk_12" });
    const r = await post(app, trackerEvent("delivered", "trk_12"));
    expect(r.status).toBe(200);
    const after = await orderRow(order.id);
    expect(after.status).toBe("delivered");
    expect(after.dispute_deadline).not.toBeNull();
    // carrier-confirmed → standard window, not the system-confirm long one (F10)
    expect(new Date(after.dispute_deadline!).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
  });

  it("maps available_for_pickup to the pre-delivery bucket (#10, §5.2 normalization)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_pickup" });
    const r = await post(app, trackerEvent("available_for_pickup", "trk_pickup"));
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("in_transit");
  });

  it("falls back to (carrier, tracking_code) with exactly one live match (F4)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: null });
    const code = (await orderRow(order.id)).tracking_code!;
    const r = await post(app, trackerEvent("in_transit", "trk_unregistered", { code, carrier: "USPS" }));
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("in_transit");
  });

  it("skips + operator-alerts on ambiguous (carrier, tracking_code) matches — never guesses (F4)", async () => {
    // Two live orders sharing carrier+code, both without tracker ids.
    const a = await seedOrder("label_issued", { trackerId: null });
    const b = await seedOrder("label_issued", { trackerId: null });
    const code = (await orderRow(a.order.id)).tracking_code!;
    await db.query("UPDATE orders SET carrier='USPS', tracking_code=$1 WHERE id=$2", [code, b.order.id]);
    const r = await post(app, trackerEvent("in_transit", "trk_amb", { code, carrier: "USPS" }));
    expect(r.status).toBe(200);
    expect(r.json.skipped).toBe(true);
    expect((await orderRow(a.order.id)).status).toBe("label_issued");
    expect((await orderRow(b.order.id)).status).toBe("label_issued");
    const ev = await db.query<{ process_error: string | null; processed_at: Date | null }>(
      "SELECT process_error, processed_at FROM webhook_events WHERE source='carrier'",
    );
    expect(ev.rows[0].process_error).toMatch(/^skipped: ambiguous/);
    expect(ev.rows[0].processed_at).toBeNull(); // sweep rule 6 recovery path
  });

  it("carrier failure refunds first and marks the item deleted (in_transit → refunding, #14, F3)", async () => {
    const { order, itemId } = await seedOrder("in_transit", { trackerId: "trk_fail" });
    const r = await post(app, trackerEvent("failure", "trk_fail"));
    expect(r.status).toBe(200);
    const after = await orderRow(order.id);
    expect(after.status).toBe("refunding");
    expect(after.refund_id).toMatch(/^re_/); // refund:{order_id} idempotent create
    const item = await db.query<{ status: string }>("SELECT status FROM items WHERE id=$1", [itemId]);
    expect(item.rows[0].status).toBe("deleted"); // lost — goods presumed gone
  });

  it("return_to_sender returns the item to active (#14 RTS override)", async () => {
    const { order, itemId } = await seedOrder("in_transit", { trackerId: "trk_rts" });
    const r = await post(app, trackerEvent("return_to_sender", "trk_rts"));
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("refunding");
    const item = await db.query<{ status: string }>("SELECT status FROM items WHERE id=$1", [itemId]);
    expect(item.rows[0].status).toBe("active");
  });

  it("off_platform failure cancels without any money call (#14b)", async () => {
    const { order, itemId } = await seedOrder("in_transit", { trackerId: "trk_off", mode: "off_platform" });
    const r = await post(app, trackerEvent("failure", "trk_off"));
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("cancelled");
    const item = await db.query<{ status: string }>("SELECT status FROM items WHERE id=$1", [itemId]);
    expect(item.rows[0].status).toBe("deleted");
  });

  it("stale events are 200/stale, no state change (§5.4 rule 4)", async () => {
    const { order } = await seedOrder("in_transit", { trackerId: "trk_stale" });
    const first = await post(app, trackerEvent("delivered", "trk_stale"));
    expect(first.status).toBe(200);
    // a second, DIFFERENT delivered event (new detail → new content hash)
    const again = await post(app, trackerEvent("delivered", "trk_stale", {
      details: [{ status: "delivered", message: "Signed by A. SMITH", datetime: "2026-10-13T18:00:00Z" }],
    }));
    expect(again.status).toBe(200);
    expect(again.json.stale).toBe(true);
    expect((await orderRow(order.id)).status).toBe("delivered"); // unchanged
  });

  it("byte-identical redelivery dedupes to one row and one transition (§5.4 rule 1)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_dup" });
    const body = trackerEvent("in_transit", "trk_dup");
    const r1 = await post(app, body);
    const r2 = await post(app, body);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.json.duplicate).toBe(true);
    const rows = await db.query("SELECT count(*)::int AS c FROM webhook_events WHERE source='carrier'");
    expect(rows.rows[0].c).toBe(1);
    const events = await db.query(
      "SELECT count(*)::int AS c FROM order_events WHERE order_id=$1 AND event_type='transition'",
      [order.id],
    );
    expect(events.rows[0].c).toBeGreaterThanOrEqual(1);
    expect((await orderRow(order.id)).status).toBe("in_transit");
  });

  it("stores REDACTED payloads — no tracking_details, no signed-for names (F6)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_redact" });
    const r = await post(app, trackerEvent("in_transit", "trk_redact"));
    expect(r.status).toBe(200);
    const ev = await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM webhook_events WHERE source='carrier'",
    );
    const stored = JSON.stringify(ev.rows[0].payload);
    expect(stored).not.toContain("tracking_details");
    expect(stored).not.toContain("DOE");
    expect(stored).not.toContain("Signed by");
    expect(ev.rows[0].payload.status).toBe("in_transit");
    expect((await orderRow(order.id)).status).toBe("in_transit");
  });

  it("pre_transit and unknown statuses are timeline-logged, never transitions (§5.2)", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_pre" });
    const r1 = await post(app, trackerEvent("pre_transit", "trk_pre"));
    expect(r1.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("label_issued");
    const r2 = await post(app, trackerEvent("error", "trk_pre", {
      details: [{ status: "error", message: "bad code", datetime: "2026-10-13T09:00:00Z" }],
    }));
    expect(r2.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("label_issued");
    const logged = await db.query(
      "SELECT count(*)::int AS c FROM order_events WHERE order_id=$1 AND event_type='carrier_update'",
      [order.id],
    );
    expect(logged.rows[0].c).toBeGreaterThanOrEqual(1);
  });

  it("acks and stores non-tracker EasyPost events without touching orders", async () => {
    const { order } = await seedOrder("label_issued", { trackerId: "trk_keep" });
    const batch = JSON.stringify({ description: "batch.created", mode: "test", result: { id: "batch_1", object: "Batch" } });
    const r = await post(app, batch);
    expect(r.status).toBe(200);
    expect((await orderRow(order.id)).status).toBe("label_issued");
    const rows = await db.query("SELECT payload->>'description' AS d FROM webhook_events WHERE source='carrier'");
    expect(rows.rows[0].d).toBe("batch.created");
  });

  it("skips zero-match events quietly (200, stored, no alert path)", async () => {
    const r = await post(app, trackerEvent("in_transit", "trk_unknown_everywhere", { code: "NOPE", carrier: "DHL" }));
    expect(r.status).toBe(200);
    const ev = await db.query<{ process_error: string | null; processed_at: Date | null }>(
      "SELECT process_error, processed_at FROM webhook_events WHERE source='carrier'",
    );
    expect(ev.rows[0].process_error).toBeNull();
    expect(ev.rows[0].processed_at).not.toBeNull();
  });
});
