// Deadline sweeps + webhook reprocessing (spec THI-3 §4.5 rules 1–7,
// rev 3 §11.3 rules 8–9; PR-8). DB-backed; Stripe faked via setStripeForTests.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests, orderAmountCents } from "../src/stripe.js";
import { runSweeps } from "../src/orders-sweep.js";
import { orderFlowConfig, type OrderFlowConfig } from "../src/config.js";
import { applyTransition, type PaymentMode } from "../src/orders.js";

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

/** Stripe fake shaped for the paths the sweeps touch. */
function fakeStripe(opts: {
  sessionPaymentStatus?: string;
  transferFails?: boolean;
  retrieveEvent?: Stripe.Event;
} = {}) {
  const calls: string[] = [];
  const n = Math.random().toString(36).slice(2, 8);
  const client = {
    checkout: {
      sessions: {
        retrieve: async () => {
          calls.push("sessions.retrieve");
          return { id: `cs_${n}`, payment_status: opts.sessionPaymentStatus ?? "unpaid" };
        },
        expire: async () => {
          calls.push("sessions.expire");
          return { id: `cs_${n}` };
        },
      },
    },
    refunds: {
      create: async (_a: unknown, o: unknown) => {
        calls.push(`refunds.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
        return { id: `re_${n}` };
      },
    },
    transfers: {
      create: async (_a: unknown, o: unknown) => {
        calls.push(`transfers.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
        if (opts.transferFails) throw new Error("insufficient platform balance");
        return { id: `tr_${n}` };
      },
    },
    events: {
      retrieve: async (id: string) => {
        calls.push(`events.retrieve:${id}`);
        if (!opts.retrieveEvent) throw new Error("no event");
        return opts.retrieveEvent;
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

describe.skipIf(!available)("deadline sweeps (DB)", () => {
  let db: pg.Client;
  let n = 0;
  let cfg: OrderFlowConfig;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    cfg = { ...orderFlowConfig() };
  });
  afterAll(async () => {
    consoleError.mockRestore();
    setStripeForTests(null);
    await db.end();
  });
  beforeEach(() => setStripeForTests(null));

  type Seed = { orderId: string; itemId: string; sellerEmail: string; buyerEmail: string };
  /** Seeds a pending order in `mode`; caller walks status via applyTransition. */
  async function seed(mode: PaymentMode): Promise<Seed> {
    n += 1;
    const s = `sws${n}`;
    const b = `swb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) SELECT id, $1, 10000, 500 FROM sellers WHERE email = $2 RETURNING id",
      [`Sweep item ${n}`, `${s}@t.dev`],
    );
    const order = await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, checkout_session_id)
       SELECT $1, s.id, b.id, 10000, 500, 'EUR', 'shipping', $2, $3
       FROM sellers s, sellers b WHERE s.email = $4 AND b.email = $5 RETURNING id`,
      [item.rows[0].id, mode, `cs_${n}`, `${s}@t.dev`, `${b}@t.dev`],
    );
    await db.query("UPDATE items SET status = 'reserved' WHERE id = $1", [item.rows[0].id]);
    return { orderId: order.rows[0].id, itemId: item.rows[0].id, sellerEmail: `${s}@t.dev`, buyerEmail: `${b}@t.dev` };
  }

  const sellerId = async (email: string) =>
    (await db.query<{ id: string }>("SELECT id FROM sellers WHERE email = $1", [email])).rows[0].id;
  const order = async (id: string) => (await db.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
  const item = async (id: string) => (await db.query("SELECT status FROM items WHERE id = $1", [id])).rows[0];

  /** Marks the seller payout-ready (rule 4 needs a destination account). */
  const payoutReady = async (email: string) =>
    db.query("UPDATE sellers SET stripe_account_id = $2, stripe_onboarded_at = now() WHERE email = $1", [email, `acct_${email}`]);

  it("rule 1: off_platform pending past deadline → cancelled, no Stripe calls", async () => {
    const seed1 = await seed("off_platform");
    await db.query("UPDATE orders SET payment_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    const report = await runSweeps(cfg);
    expect(report["1-payment-expired"].acted).toBe(1);
    expect((await order(seed1.orderId)).status).toBe("cancelled");
    expect((await item(seed1.itemId)).status).toBe("active");
  });

  it("rule 1: stripe unpaid session → cancelled after paid-check + expire", async () => {
    const { client, calls } = fakeStripe({ sessionPaymentStatus: "unpaid" });
    setStripeForTests(client);
    const seed1 = await seed("stripe");
    await db.query("UPDATE orders SET payment_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    await runSweeps(cfg);
    expect((await order(seed1.orderId)).status).toBe("cancelled");
    expect(calls).toContain("sessions.retrieve");
    expect(calls).toContain("sessions.expire");
  });

  it("rule 1: paid/unclear session (F2) → never cancelled, alert logged", async () => {
    const { client } = fakeStripe({ sessionPaymentStatus: "paid" });
    setStripeForTests(client);
    const seed1 = await seed("stripe");
    await db.query("UPDATE orders SET payment_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    await runSweeps(cfg);
    expect((await order(seed1.orderId)).status).toBe("pending");
    const ev = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'unexpected_payment'", [seed1.orderId]);
    expect(ev.rowCount).toBe(1);
  });

  const toSold = async (orderId: string, email: string) => {
    await applyTransition({ orderId, trigger: "stripe_payment", actor: { type: "stripe", id: "evt_t" }, sets: { payment_intent_id: `pi_${n}` } });
    await payoutReady(email);
  };

  it("rule 2: stale sold (no tracking) stripe → refunding + refund-first; off_platform → cancelled", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    const b = await seed("off_platform");
    await applyTransition({ orderId: b.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(b.sellerEmail) } });
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id IN ($2, $3)",
      [String(cfg.staleSoldDays + 1), a.orderId, b.orderId],
    );
    const report = await runSweeps(cfg);
    expect((await order(a.orderId)).status).toBe("refunding");
    expect(calls.some((c) => c.startsWith("refunds.create:"))).toBe(true);
    expect((await order(b.orderId)).status).toBe("cancelled");
    expect((await item(a.itemId)).status).toBe("active");
    expect((await item(b.itemId)).status).toBe("active");
    expect(report["2-stale-sale"].acted).toBe(2);

    // Second pass: dedupe — nothing fires twice.
    const again = await runSweeps(cfg);
    expect(again["2-stale-sale"].acted).toBe(0);
    expect(calls.filter((c) => c.startsWith("refunds.create:")).length).toBe(1);
  });

  it("rule 3: stuck in_transit → refunding (stripe) / cancelled (off_platform)", async () => {
    const { client } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await applyTransition({ orderId: a.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T1", tracker_id: "trk_1" } });
    await applyTransition({ orderId: a.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_1" } });
    const b = await seed("off_platform");
    await applyTransition({ orderId: b.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(b.sellerEmail) } });
    await applyTransition({ orderId: b.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T2" } });
    await applyTransition({ orderId: b.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "x" } });
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id IN ($2, $3)",
      [String(cfg.inTransitStuckDays + 1), a.orderId, b.orderId],
    );
    await runSweeps(cfg);
    expect((await order(a.orderId)).status).toBe("refunding"); // #14c
    expect((await order(b.orderId)).status).toBe("cancelled"); // #14d
    expect((await item(a.itemId)).status).toBe("active");
  });

  it("rule 4: delivered past dispute deadline → payout_pending + transfer (stripe) / completed (off_platform)", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await applyTransition({ orderId: a.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T3", tracker_id: "trk_3" } });
    await applyTransition({ orderId: a.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_3" } }); // label_issued → in_transit
    await applyTransition({ orderId: a.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_3" } }); // → delivered
    const b = await seed("off_platform");
    await applyTransition({ orderId: b.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(b.sellerEmail) } });
    await applyTransition({ orderId: b.orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    await db.query("UPDATE orders SET dispute_deadline = now() - interval '1 hour' WHERE id IN ($1, $2)", [a.orderId, b.orderId]);
    await runSweeps(cfg);
    const oa = await order(a.orderId);
    expect(oa.status).toBe("payout_pending");
    expect(oa.transfer_id).toBeTruthy();
    expect(calls.some((c) => c.startsWith("transfers.create:"))).toBe(true);
    expect((await order(b.orderId)).status).toBe("completed");
    expect((await item(a.itemId)).status).toBe("sold");
  });

  it("rule 4: transfer failure stays payout_pending with a payout_attempt_failed event, then retries", async () => {
    const fail = fakeStripe({ transferFails: true });
    setStripeForTests(fail.client);
    const seed1 = await seed("stripe");
    await toSold(seed1.orderId, seed1.sellerEmail);
    await applyTransition({ orderId: seed1.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T4", tracker_id: "trk_4" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_4" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_4" } });
    await db.query("UPDATE orders SET dispute_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    await runSweeps(cfg);
    expect((await order(seed1.orderId)).status).toBe("payout_pending");
    let ev = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'payout_attempt_failed'", [seed1.orderId]);
    expect(ev.rowCount).toBe(1);

    // Retry arm: next pass retries the transfer once the balance recovers.
    const ok = fakeStripe();
    setStripeForTests(ok.client);
    await runSweeps(cfg);
    const o = await order(seed1.orderId);
    expect(o.transfer_id).toBeTruthy();
    ev = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'payout_attempt_failed'", [seed1.orderId]);
    expect(ev.rowCount).toBe(1); // deduped — one failure record, not one per pass
  });

  it("rule 5: pickup sold past autoconfirm → delivered with the long (F10) window", async () => {
    const seed1 = await seed("off_platform");
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [seed1.orderId]);
    await applyTransition({ orderId: seed1.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(seed1.sellerEmail) } });
    await db.query("UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2", [String(cfg.pickupAutoconfirmDays + 1), seed1.orderId]);
    await runSweeps(cfg);
    const o = await order(seed1.orderId);
    expect(o.status).toBe("delivered");
    const expectLong = Date.now() + cfg.systemConfirmedDisputeWindowHours * 3_600_000;
    expect(new Date(o.dispute_deadline).getTime()).toBeGreaterThan(expectLong - 10 * 60_000);
  });

  it("rule 6: reprocesses a stored-but-unapplied stripe event via events.retrieve", async () => {
    const seed1 = await seed("stripe");
    await db.query("UPDATE orders SET payment_deadline = now() + interval '1 day' WHERE id = $1", [seed1.orderId]);
    const o = await order(seed1.orderId);
    const evt = {
      id: `evt_${n}`,
      type: "checkout.session.completed",
      data: { object: { id: o.checkout_session_id, payment_status: "paid", payment_intent: `pi_r${n}`, amount_total: orderAmountCents(o), currency: "eur", metadata: { order_id: o.id } } },
    } as unknown as Stripe.Event;
    const { client, calls } = fakeStripe({ retrieveEvent: evt });
    setStripeForTests(client);
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, '{}'::jsonb, 'ingest failed: db fault')`,
      [evt.id],
    );
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(1);
    expect(calls).toContain(`events.retrieve:${evt.id}`);
    expect((await order(seed1.orderId)).status).toBe("sold");
    const row = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [evt.id])).rows[0];
    expect(row.processed_at).toBeTruthy();
    expect(row.process_error).toBeNull();
  });

  it("rule 6: reprocesses a carrier event from its stored redacted payload", async () => {
    const seed1 = await seed("stripe");
    await toSold(seed1.orderId, seed1.sellerEmail);
    await applyTransition({ orderId: seed1.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T6", tracker_id: "trk_6" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_6" } }); // label_issued → in_transit
    const payload = { description: null, mode: "test", tracker_id: "trk_6", tracking_code: "T6", carrier: "DHL", carrier_status: "delivered", status: "delivered", occurred_at: new Date().toISOString() };
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('carrier', $1, $2::jsonb, 'ingest failed: db fault')`,
      [`easypost:${"x".repeat(64)}`, JSON.stringify(payload)],
    );
    await runSweeps(cfg);
    expect((await order(seed1.orderId)).status).toBe("delivered");
    const row = (await db.query("SELECT processed_at FROM webhook_events WHERE payload = $1::jsonb", [JSON.stringify(payload)])).rows[0];
    expect(row.processed_at).toBeTruthy();
  });

  it("rule 6: skipped:ambiguous rows are operator-action, never auto-retried (THI-66 A4)", async () => {
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('carrier', $1, '{}'::jsonb, 'skipped: ambiguous: 2 live orders match')`,
      [`easypost:${"a".repeat(64)}`],
    );
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(0);
    const row = (await db.query("SELECT processed_at FROM webhook_events WHERE external_id = $1", [`easypost:${"a".repeat(64)}`])).rows[0];
    expect(row.processed_at).toBeNull();
  });

  it("rule 6: first failure stamps attempt 1; inside backoff it is skipped, never hammered", async () => {
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, '{}'::jsonb, 'ingest failed: db fault')`,
      ["evt_bump"],
    );
    const { client } = fakeStripe({}); // events.retrieve throws → attempt 1
    setStripeForTests(client);
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].errored).toBe(1);
    const row = (await db.query("SELECT process_error FROM webhook_events WHERE external_id = 'evt_bump'")).rows[0];
    expect(row.process_error).toMatch(/ingest failed: db fault \[attempt 1 @ /);

    // Still inside the 15-minute backoff → skipped, attempt unchanged.
    const again = await runSweeps(cfg);
    expect(again["6-reprocess"].skipped).toBe(1);
    const row2 = (await db.query("SELECT process_error FROM webhook_events WHERE external_id = 'evt_bump'")).rows[0];
    expect(row2.process_error).toBe(row.process_error);
  });

  it("rule 7: stuck refunding past the alert window raises an operator alert", async () => {
    const seed1 = await seed("stripe");
    await toSold(seed1.orderId, seed1.sellerEmail);
    await applyTransition({ orderId: seed1.orderId, trigger: "cancel_order", actor: { type: "seller", id: "s" } });
    await db.query("UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2", [String(cfg.stuckMoneyAlertDays + 1), seed1.orderId]);
    consoleError.mockClear();
    const report = await runSweeps(cfg);
    expect(report["7-stuck-money"].acted).toBeGreaterThanOrEqual(1);
    expect(consoleError).toHaveBeenCalled();
    expect((await order(seed1.orderId)).status).toBe("refunding"); // alert-only
  });

  it("rule 8: never-shipped dispute auto-resolves (stripe refund / off_platform cancel)", async () => {
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await applyTransition({ orderId: a.orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    await applyTransition({ orderId: a.orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "no show" });
    const b = await seed("off_platform");
    await applyTransition({ orderId: b.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(b.sellerEmail) } });
    await applyTransition({ orderId: b.orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    await applyTransition({ orderId: b.orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "no show" });
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' hours')::interval WHERE id IN ($2, $3)",
      [String(cfg.disputeAutorefundHours + 1), a.orderId, b.orderId],
    );
    const report = await runSweeps(cfg);
    const oa = await order(a.orderId);
    expect(oa.status).toBe("refunding"); // #18a (matrix gap closed, §11.3 stripe arm)
    expect(oa.refund_id).toBeTruthy();
    expect(calls.some((c) => c.startsWith("refunds.create:"))).toBe(true);
    expect((await order(b.orderId)).status).toBe("cancelled"); // #18c
    expect((await item(a.itemId)).status).toBe("active");
    expect(report["8-never-shipped"].acted).toBe(2);
  });

  it("rule 8: shipped disputes are never auto-refunded", async () => {
    const seed1 = await seed("stripe");
    await toSold(seed1.orderId, seed1.sellerEmail);
    await applyTransition({ orderId: seed1.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T8", tracker_id: "trk_8" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_8" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_8" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "not as described" });
    await db.query("UPDATE orders SET status_changed_at = now() - ($1 || ' hours')::interval WHERE id = $2", [String(cfg.disputeAutorefundHours + 1), seed1.orderId]);
    await runSweeps(cfg);
    expect((await order(seed1.orderId)).status).toBe("disputed"); // human admin route owns it
  });

  it("rule 9: stale dispute alerts without changing state", async () => {
    const seed1 = await seed("off_platform");
    await applyTransition({ orderId: seed1.orderId, trigger: "confirm_payment", actor: { type: "seller", id: await sellerId(seed1.sellerEmail) } });
    await applyTransition({ orderId: seed1.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T9" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "x" } }); // in_transit
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "x" } }); // delivered (tracking recorded → rule 8 will not grab it)
    await applyTransition({ orderId: seed1.orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "damaged" });
    await db.query("UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2", [String(cfg.disputeStaleDays + 1), seed1.orderId]);
    consoleError.mockClear();
    const report = await runSweeps(cfg);
    expect(report["9-stale-dispute"].acted).toBeGreaterThanOrEqual(1);
    expect(consoleError).toHaveBeenCalled();
    expect((await order(seed1.orderId)).status).toBe("disputed");
  });
});
