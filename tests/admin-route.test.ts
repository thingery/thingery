// Admin dispute-resolution route (spec THI-3 §4.3, PR-9): auth hardening
// (timing-safe key, per-IP rate limit, boot-disabled route), both outcomes in
// both payment modes, refund-after-transfer reconcile (§6.6, F3), 409 on
// non-disputed orders. DB-backed over real HTTP.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import type Stripe from "stripe";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, adminAttemptLimiter } from "../src/routes.js";
import { setStripeForTests } from "../src/stripe.js";
import { applyTransition } from "../src/orders.js";

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

function fakeStripe(opts: { reversalFails?: boolean } = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const calls: string[] = [];
  const client = {
    refunds: {
      create: async (_a: unknown, o: unknown) => {
        calls.push(`refunds.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
        return { id: `re_${n}` };
      },
    },
    transfers: {
      create: async (_a: unknown, o: unknown) => {
        calls.push(`transfers.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
        return { id: `tr_${n}` };
      },
      createReversal: async (id: string, _a: unknown, o: unknown) => {
        calls.push(`reversal:${(o as { idempotencyKey: string }).idempotencyKey}:${id}`);
        if (opts.reversalFails) throw new Error("already reversed");
        return { id: `trr_${n}` };
      },
      retrieve: async (id: string) => {
        calls.push(`transfers.retrieve:${id}`);
        return { id, amount_reversed: 0 };
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

describe.skipIf(!available)("admin resolve-dispute route (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;
  const KEY = "a".repeat(40);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    process.env.ADMIN_API_KEY = KEY;
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
    setStripeForTests(null);
    delete process.env.ADMIN_API_KEY;
    server.close();
    await db.end();
  });
  beforeEach(() => {
    setStripeForTests(null);
    adminAttemptLimiter.reset();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/admin/orders/x/resolve-dispute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  type Seed = { orderId: string; sellerEmail: string };
  /** Seeds an order and walks it to delivered (`dispute=false`) or `disputed`. */
  async function seedDisputed(mode: "stripe" | "off_platform", shipped: boolean, dispute = true): Promise<Seed> {
    n += 1;
    const s = `ads${n}`;
    const b = `adb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) SELECT id, $1, 10000, 500 FROM sellers WHERE email = $2 RETURNING id",
      [`Admin item ${n}`, `${s}@t.dev`],
    );
    const order = await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, payment_intent_id)
       SELECT $1, s.id, b.id, 10000, 500, 'EUR', 'shipping', $2, $3
       FROM sellers s, sellers b WHERE s.email = $4 AND b.email = $5 RETURNING *`,
      [item.rows[0].id, mode, mode === "stripe" ? `pi_${n}` : null, `${s}@t.dev`, `${b}@t.dev`],
    );
    const orderId = order.rows[0].id as string;
    const sellerId = (await db.query("SELECT id FROM sellers WHERE email = $1", [`${s}@t.dev`])).rows[0].id;
    await db.query("UPDATE sellers SET stripe_account_id = $2 WHERE id = $1", [sellerId, `acct_${n}`]);
    if (mode === "stripe") {
      await applyTransition({ orderId, trigger: "stripe_payment", actor: { type: "stripe", id: "evt" }, sets: { payment_intent_id: `pi_${n}` } });
    } else {
      await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: sellerId } });
    }
    if (shipped) {
      await applyTransition({ orderId, trigger: "record_tracking", actor: { type: "seller", id: sellerId }, sets: { carrier: "DHL", tracking_code: `T${n}`, tracker_id: `trk_${n}` } });
      await applyTransition({ orderId, trigger: "carrier_update", actor: { type: "carrier", id: `trk_${n}` } });
      await applyTransition({ orderId, trigger: "carrier_update", actor: { type: "carrier", id: `trk_${n}` } });
    } else {
      await applyTransition({ orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    }
    if (dispute) {
      await applyTransition({ orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "test dispute" });
    }
    return { orderId, sellerEmail: `${s}@t.dev` };
  }

  const resolve = (id: string, body: unknown, key = KEY) =>
    fetch(`${base}/api/admin/orders/${id}/resolve-dispute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  const status = async (id: string) =>
    (await db.query("SELECT status, refund_id, transfer_id FROM orders WHERE id = $1", [id])).rows[0];

  it("401 wrong or missing key; no state change", async () => {
    const seed1 = await seedDisputed("stripe", false);
    const wrong = await post({ outcome: "refund", note: "x" }, { authorization: `Bearer ${"b".repeat(40)}` });
    expect(wrong.status).toBe(401);
    const none = await post({ outcome: "refund", note: "x" });
    expect(none.status).toBe(401);
    expect((await status(seed1.orderId)).status).toBe("disputed");
  });

  it("400 on malformed body", async () => {
    const r = await post({ outcome: "keep", note: "" }, { authorization: `Bearer ${KEY}` });
    expect(r.status).toBe(400);
  });

  it("404 unknown order (malformed or well-formed id), 409 non-disputed order", async () => {
    const malformed = await post({ outcome: "refund", note: "x" }, { authorization: `Bearer ${KEY}` });
    expect(malformed.status).toBe(404);
    const r = await fetch(`${base}/api/admin/orders/00000000-0000-0000-0000-000000000000/resolve-dispute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ outcome: "refund", note: "x" }),
    });
    expect(r.status).toBe(404);
    const seed1 = await seedDisputed("off_platform", false);
    await db.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [seed1.orderId]);
    const conflict = await resolve(seed1.orderId, { outcome: "refund", note: "x" });
    expect(conflict.status).toBe(409);
  });

  it("outcome=refund (stripe): refund-first then refunding; audit note recorded", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("stripe", true);
    const r = await resolve(seed1.orderId, { outcome: "refund", note: "damaged in transit" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; refund_id: string };
    expect(body.status).toBe("refunding"); // #18
    expect(body.refund_id).toBeTruthy();
    expect(calls.some((c) => c.startsWith("refunds.create:refund:"))).toBe(true);
    const ev = await db.query(
      "SELECT reason FROM order_events WHERE order_id = $1 AND event_type = 'transition' AND to_status = 'refunding'",
      [seed1.orderId],
    );
    expect(ev.rows[0].reason).toBe("damaged in transit");
    const item = await db.query("SELECT status FROM items WHERE id = (SELECT item_id FROM orders WHERE id = $1)", [seed1.orderId]);
    expect(item.rows[0].status).toBe("active");
  });

  it("outcome=refund (off_platform): cancelled, no Stripe call", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("off_platform", false);
    const r = await resolve(seed1.orderId, { outcome: "refund", note: "no show" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("cancelled"); // #18b
    expect(calls.length).toBe(0);
  });

  it("outcome=refund after a transfer exists: reversal + refund, operator alerted (§6.6)", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    // delivered (shipped) → past dispute deadline → sweep pays out → chargeback.
    const seed1 = await seedDisputed("stripe", true, false);
    expect((await status(seed1.orderId)).status).toBe("delivered");
    await db.query("UPDATE orders SET dispute_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    const { runSweeps } = await import("../src/orders-sweep.js");
    const { orderFlowConfig } = await import("../src/config.js");
    const idle = { ...orderFlowConfig(), disputeStaleDays: 999, disputeAutorefundHours: 999, staleSoldDays: 999, inTransitStuckDays: 999, pickupAutoconfirmDays: 999, stuckMoneyAlertDays: 999 };
    await runSweeps(idle);
    expect((await status(seed1.orderId)).status).toBe("payout_pending");
    await applyTransition({ orderId: seed1.orderId, trigger: "chargeback", actor: { type: "stripe", id: "dp_" }, restoreTo: "delivered" });
    expect((await status(seed1.orderId)).status).toBe("disputed");
    consoleError.mockClear();
    const r = await resolve(seed1.orderId, { outcome: "refund", note: "chargeback won by buyer" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("refunding");
    expect(calls.some((c) => c.startsWith("reversal:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("refunds.create:"))).toBe(true);
    expect(consoleError).toHaveBeenCalled(); // shortfall alert
  });

  it("outcome=release (stripe): payout_pending + transfer created", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("stripe", true);
    const r = await resolve(seed1.orderId, { outcome: "release", note: "tracking shows delivery" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; transfer_id: string };
    expect(body.status).toBe("payout_pending"); // #19
    expect(body.transfer_id).toBeTruthy();
    expect(calls.some((c) => c.startsWith("transfers.create:payout:"))).toBe(true);
  });

  it("outcome=release with existing transfer: reconcile, never recreate (F3)", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("stripe", true);
    await db.query("UPDATE orders SET transfer_id = 'tr_existing', dispute_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    const r = await resolve(seed1.orderId, { outcome: "release", note: "paid already" });
    expect(r.status).toBe(200);
    // Transfer already landed → #20 fires immediately via reconcile.
    expect(((await r.json()) as { status: string }).status).toBe("paid_out");
    expect(calls.some((c) => c.startsWith("transfers.create:"))).toBe(false);
    expect(calls).toContain("transfers.retrieve:tr_existing");
    const after = await status(seed1.orderId);
    expect(after.transfer_id).toBe("tr_existing");
  });

  it("outcome=release (off_platform): completed, no Stripe call", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("off_platform", false);
    const r = await resolve(seed1.orderId, { outcome: "release", note: "buyer satisfied" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("completed"); // #19b
    expect(calls.length).toBe(0);
  });

  it("per-IP rate limit kicks in (F7)", async () => {
    const seed1 = await seedDisputed("off_platform", false);
    let last = 200;
    for (let i = 0; i < 12 && last !== 429; i++) {
      const r = await resolve(seed1.orderId, { outcome: "release", note: `n${i}` });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  // --- THI-70 hardening: cross-outcome race (A1) + env read consistency (A2) ---

  it("A2: whitespace-padded ADMIN_API_KEY authenticates like the enable-gate (envValue read)", async () => {
    const prev = process.env.ADMIN_API_KEY;
    // Trimmed value is still >=32 chars, so the boot gate enables the route;
    // the route's compare must see the trimmed key too, or every request 401s.
    process.env.ADMIN_API_KEY = `${KEY}  \n`;
    try {
      const seed1 = await seedDisputed("off_platform", false);
      const r = await resolve(seed1.orderId, { outcome: "release", note: "padded key" });
      expect(r.status).toBe(200); // was 401 against raw process.env (length mismatch)
      expect(((await r.json()) as { status: string }).status).toBe("completed");
    } finally {
      process.env.ADMIN_API_KEY = prev;
    }
  });

  it("A1(b): admin_release on a disputed order with refund_id set → 409, no transfer", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seedDisputed("stripe", true);
    // Simulates a concurrent refund outcome that already created its Stripe
    // refund and persisted refund_id (A1(a)) while its transition is pending.
    await db.query("UPDATE orders SET refund_id = 're_race' WHERE id = $1", [seed1.orderId]);
    const r = await resolve(seed1.orderId, { outcome: "release", note: "concurrent refund" });
    expect(r.status).toBe(409);
    const after = await status(seed1.orderId);
    expect(after.status).toBe("disputed"); // nothing moved
    expect(calls.some((c) => c.startsWith("transfers.create:"))).toBe(false); // no money moved
  });

  it("A1(a): refund that loses the cross-outcome race still persists refund_id — no orphaned Stripe refund", async () => {
    // Deterministic interleave of the THI-69 A1 race: the refund request parks
    // inside the Stripe refund call; release wins the status CAS and pays out;
    // when the refund call resolves, its admin_refund transition loses (409)
    // but refund_id must already be on the row — visible to ops instead of
    // orphaned at Stripe.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const m = Math.random().toString(36).slice(2, 8);
    const calls: string[] = [];
    const client = {
      refunds: {
        create: async (_a: unknown, o: unknown) => {
          calls.push(`refunds.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
          await gate; // hold the refund request inside the Stripe-call window
          return { id: `re_${m}` };
        },
      },
      transfers: {
        create: async (_a: unknown, o: unknown) => {
          calls.push(`transfers.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
          return { id: `tr_${m}` };
        },
        createReversal: async (id: string, _a: unknown, o: unknown) => {
          calls.push(`reversal:${(o as { idempotencyKey: string }).idempotencyKey}:${id}`);
          return { id: `trr_${m}` };
        },
        retrieve: async (id: string) => {
          calls.push(`transfers.retrieve:${id}`);
          return { id, amount_reversed: 0 };
        },
      },
    } as unknown as Stripe;
    setStripeForTests(client);
    const seed1 = await seedDisputed("stripe", true);
    const refundP = resolve(seed1.orderId, { outcome: "refund", note: "race refund" });
    await new Promise((r) => setTimeout(r, 50)); // refund request is parked at the gate
    const release = await resolve(seed1.orderId, { outcome: "release", note: "race release" });
    expect(release.status).toBe(200); // release wins the disputed → payout_pending CAS
    openGate(); // let the parked refund call finish
    const refund = await refundP;
    expect(refund.status).toBe(409); // its transition loses the race …
    const after = await status(seed1.orderId);
    expect(after.status).toBe("payout_pending");
    expect(after.refund_id).toBe(`re_${m}`); // … but the refund is persisted, not orphaned
    expect(calls.some((c) => c.startsWith("refunds.create:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("transfers.create:"))).toBe(true);
  });
});
