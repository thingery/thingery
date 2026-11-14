// THI-760 plan Phase 1 / THI-763, PR 3: fan-out sweep. Two layers:
//  - pure mapOrderEvent tests (no DB — run everywhere): every transition
//    classification per plan §1, incl. actor disambiguation and the
//    in-transit in-app-only rule;
//  - DB tests (skip without Postgres; CI runs them): watermark cutover,
//    idempotent replay, crash-recovery by watermark rollback, dedupe keys,
//    deadline reminder once-per-order.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mapOrderEvent, runNotifyFanout, type OrderEventRow } from "../src/notify/fanout.js";
import { orderFlowConfig } from "../src/config.js";
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
const flow = orderFlowConfig();

function event(over: Partial<OrderEventRow>): OrderEventRow {
  return {
    id: crypto.randomUUID(),
    order_id: crypto.randomUUID(),
    event_type: "transition",
    from_status: "pending",
    to_status: "sold",
    actor_type: "stripe",
    reason: null,
    created_at: new Date(),
    buyer_id: "buyer-1",
    seller_id: "seller-1",
    item_id: "item-1",
    item_title: "Vintage denim jacket",
    price_cents: 1000,
    shipping_price_cents: 234,
    currency: "EUR",
    payment_mode: "stripe",
    payment_deadline: null,
    tracking_code: null,
    carrier: null,
    ...over,
  };
}

describe("mapOrderEvent (THI-763 PR 3 — pure)", () => {
  it("#1 create_order: buyer order_placed; off-platform adds seller confirmation", () => {
    const stripe = mapOrderEvent(event({ to_status: "pending", from_status: null, actor_type: "buyer", payment_mode: "stripe" }), flow);
    expect(stripe.map((n) => n.eventType)).toEqual(["buyer.order_placed"]);
    expect(stripe[0].email).toBe(true);
    const off = mapOrderEvent(event({ to_status: "pending", from_status: null, actor_type: "buyer", payment_mode: "off_platform" }), flow);
    expect(off.map((n) => n.eventType)).toEqual(["buyer.order_placed", "seller.off_platform_order"]);
  });

  it("#2/#24 payment: buyer receipt + seller item_sold (the money moment)", () => {
    const plans = mapOrderEvent(event({}), flow);
    expect(plans.map((n) => n.eventType)).toEqual(["buyer.payment_received", "seller.item_sold"]);
    expect(plans[0].payload.amount_cents).toBe(1234);
  });

  it("#4 payment_expired vs #3 cancels — actor disambiguates; counterpart always notified", () => {
    const sys = mapOrderEvent(event({ to_status: "cancelled", actor_type: "system" }), flow);
    expect(sys.map((n) => n.eventType)).toEqual(["buyer.order_cancelled"]);
    expect(sys[0].payload.reason).toBe("payment_deadline_passed");
    const byBuyer = mapOrderEvent(event({ to_status: "cancelled", actor_type: "buyer" }), flow);
    expect(byBuyer.map((n) => n.eventType)).toEqual(["buyer.order_cancelled", "seller.order_cancelled_by_buyer"]);
    const bySeller = mapOrderEvent(event({ to_status: "cancelled", actor_type: "seller" }), flow);
    expect(bySeller.map((n) => n.eventType)).toEqual(["buyer.order_cancelled"]);
    expect(bySeller[0].payload.reason).toBe("seller_cancelled");
  });

  it("#5 shipped, #10 in-transit (in-app ONLY), #12 delivered with dispute window", () => {
    const shipped = mapOrderEvent(event({ from_status: "sold", to_status: "label_issued" }), flow);
    expect(shipped.map((n) => n.eventType)).toEqual(["buyer.item_shipped"]);
    const transit = mapOrderEvent(event({ from_status: "label_issued", to_status: "in_transit", actor_type: "carrier" }), flow);
    expect(transit.map((n) => n.eventType)).toEqual(["buyer.in_transit"]);
    expect(transit[0].email).toBe(false); // plan §1.1: intermediate scans never email
    const delivered = mapOrderEvent(event({ from_status: "in_transit", to_status: "delivered", actor_type: "carrier" }), flow);
    expect(delivered[0].eventType).toBe("buyer.order_delivered");
    expect(delivered[0].payload.dispute_window_hours).toBe(flow.disputeWindowHours);
  });

  it("#15 dispute vs #22 chargeback — seller-side security events", () => {
    const dispute = mapOrderEvent(event({ from_status: "delivered", to_status: "disputed", actor_type: "buyer" }), flow);
    expect(dispute.map((n) => n.eventType)).toEqual(["seller.dispute_opened"]);
    const cb = mapOrderEvent(event({ from_status: "delivered", to_status: "disputed", actor_type: "stripe" }), flow);
    expect(cb.map((n) => n.eventType)).toEqual(["seller.chargeback"]);
  });

  it("refund paths: #21 confirmed (money), #8 buyer-requested notifies seller, #9 system refund", () => {
    const confirmed = mapOrderEvent(event({ from_status: "refunding", to_status: "refunded", actor_type: "stripe" }), flow);
    expect(confirmed.map((n) => n.eventType)).toEqual(["buyer.refund_confirmed"]);
    const buyerReq = mapOrderEvent(event({ from_status: "sold", to_status: "refunding", actor_type: "buyer" }), flow);
    expect(buyerReq.map((n) => n.eventType)).toEqual(["buyer.refund_initiated", "seller.order_cancelled_by_buyer"]);
    const sys = mapOrderEvent(event({ from_status: "sold", to_status: "refunding", actor_type: "system" }), flow);
    expect(sys.map((n) => n.eventType)).toEqual(["buyer.refund_initiated"]);
  });

  it("dispute outcomes notify BOTH parties; #16/#17 bookkeeping is silent; #20 payout pays seller", () => {
    const release = mapOrderEvent(event({ from_status: "disputed", to_status: "payout_pending", actor_type: "admin" }), flow);
    expect(release.map((n) => n.eventType)).toEqual(["buyer.dispute_outcome", "seller.dispute_resolved"]);
    const window = mapOrderEvent(event({ from_status: "delivered", to_status: "payout_pending", actor_type: "system" }), flow);
    expect(window).toEqual([]);
    const payout = mapOrderEvent(event({ from_status: "payout_pending", to_status: "paid_out", actor_type: "stripe" }), flow);
    expect(payout.map((n) => n.eventType)).toEqual(["seller.payout_paid"]);
  });

  it("non-transition rows and #22r restores emit nothing", () => {
    expect(mapOrderEvent(event({ event_type: "carrier_update" }), flow)).toEqual([]);
    expect(mapOrderEvent(event({ event_type: "operator_alert" }), flow)).toEqual([]);
    expect(mapOrderEvent(event({ from_status: "disputed", to_status: "in_transit", actor_type: "stripe" }), flow)).toEqual([]);
  });
});

describe.skipIf(!available)("notify fan-out (THI-763 PR 3 — DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  const BASE = "https://thingery.test";

  async function seedOrder(over: { status?: string; mode?: string; deadline?: Date | null }) {
    const email = `thi763-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'THI-763 Seller') RETURNING id`, [email],
    );
    const buyerEmail = `thi763b-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const buyer = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'THI-763 Buyer') RETURNING id`, [buyerEmail],
    );
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, category, price_cents, currency) VALUES ($1, 'Vintage denim jacket', 'other', 1000, 'EUR') RETURNING id`,
      [seller.rows[0].id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, payment_mode, price_cents, shipping_price_cents, currency, fulfillment, shipping_address, payment_deadline, status_changed_at)
       VALUES ($1, $2, $3, $4, $5, 1000, 234, 'EUR', 'shipping', '{}'::jsonb, $6, now()) RETURNING id`,
      [item.rows[0].id, seller.rows[0].id, buyer.rows[0].id, over.status ?? "pending", over.mode ?? "stripe", over.deadline ?? null],
    );
    return { orderId: order.rows[0].id, buyerId: buyer.rows[0].id, sellerId: seller.rows[0].id };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");
    await db.query(schema);
    // Isolate this run: fresh watermark (clean cutover path).
    await db.query("DELETE FROM notify_watermarks WHERE name = 'order-events'");
  });
  afterAll(async () => {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("first run initializes the watermark without notifying on history", async () => {
    const before = await db.query<{ c: string }>("SELECT count(*)::text AS c FROM notifications");
    const r = await runNotifyFanout(flow, new Date(), BASE);
    expect(r.initialized).toBe(true);
    expect(r.notificationsInserted).toBe(0);
    const after = await db.query<{ c: string }>("SELECT count(*)::text AS c FROM notifications");
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it("new events fan out; replay is a no-op (idempotent); crash-recovery replays clean", async () => {
    const seed = await seedOrder({});
    await db.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, dedupe_key)
       VALUES ($1, 'transition', NULL, 'pending', 'buyer', $2)`,
      [seed.orderId, `test:create:${seed.orderId}`],
    );
    const r1 = await runNotifyFanout(flow, new Date(Date.now() + 10_000), BASE);
    expect(r1.notificationsInserted).toBe(1); // buyer.order_placed only (stripe)
    expect(r1.outboxInserted).toBe(1);

    const r2 = await runNotifyFanout(flow, new Date(Date.now() + 20_000), BASE); // replay
    expect(r2.notificationsInserted).toBe(0);
    expect(r2.outboxInserted).toBe(0);

    // Crash simulation: roll the watermark back behind the event, replay.
    await db.query(
      `UPDATE notify_watermarks SET last_event_at = now() - interval '10 minutes' WHERE name = 'order-events'`,
    );
    const r3 = await runNotifyFanout(flow, new Date(Date.now() + 30_000), BASE);
    expect(r3.eventsProcessed).toBeGreaterThanOrEqual(1);
    expect(r3.notificationsInserted).toBe(0); // dedupe keys absorbed the replay

    const rows = await db.query(
      `SELECT event_type, role, dedupe_key, payload FROM notifications WHERE order_id = $1`,
      [seed.orderId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].event_type).toBe("buyer.order_placed");
    expect(rows.rows[0].dedupe_key).toMatch(/^buyer\.order_placed:[0-9a-f-]{36}$/); // {event_type}:{order_events.id}
    const payload = rows.rows[0].payload;
    expect(payload.item_title).toBe("Vintage denim jacket");
    expect(payload.amount_cents).toBe(1234);
    // F6: no address-ish keys anywhere in the payload.
    expect(Object.keys(payload).join(",")).not.toMatch(/address|street|phone|contact/);
  });

  it("outbox row carries the rendered subject and template key; at-most-once per notification", async () => {
    const seed = await seedOrder({});
    await db.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, dedupe_key)
       VALUES ($1, 'transition', NULL, 'pending', 'buyer', $2)`,
      [seed.orderId, `test:create3:${seed.orderId}`],
    );
    await runNotifyFanout(flow, new Date(Date.now() + 10_000), BASE);
    const rows = await db.query(
      `SELECT o.subject, o.template, o.to_email, o.dedupe_key, o.status, o.attempts
         FROM email_outbox o JOIN notifications n ON n.id = o.notification_id
        WHERE n.order_id = $1`,
      [seed.orderId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].subject).toBe("Order placed: Vintage denim jacket — Thingery");
    expect(rows.rows[0].template).toBe("buyer.order_placed.v1");
    expect(rows.rows[0].to_email).toContain("@example.test"); // seeded buyer address
    expect(rows.rows[0].status).toBe("pending");
    expect(rows.rows[0].attempts).toBe(0);
  });

  it("payment-deadline reminder: exactly once per order, in the 4h window only", async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000); // 2h out — inside the window
    const seed = await seedOrder({ deadline: soon });
    const r1 = await runNotifyFanout(flow, new Date(), BASE);
    expect(r1.remindersPlanned).toBeGreaterThanOrEqual(1);
    const r2 = await runNotifyFanout(flow, new Date(Date.now() + 60_000), BASE);
    expect(r2.remindersPlanned).toBe(0); // dedupe per order
    const far = await seedOrder({ deadline: new Date(Date.now() + 20 * 3_600_000) });
    const r3 = await runNotifyFanout(flow, new Date(Date.now() + 120_000), BASE);
    const reminded = await db.query(
      `SELECT count(*)::int AS c FROM notifications WHERE event_type = 'buyer.payment_deadline_reminder' AND order_id = $1`,
      [far.orderId],
    );
    expect(reminded.rows[0].c).toBe(0); // outside the window → no reminder
    expect(r3.remindersPlanned).toBe(0);
  });
});
