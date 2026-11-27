// Deadline sweeps + webhook reprocessing (spec THI-3 §4.5 rules 1–7,
// rev 3 §11.3 rules 8–9; PR-8). DB-backed; Stripe faked via setStripeForTests.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests, chargeTotalCents } from "../src/stripe.js";
import { runSweeps } from "../src/orders-sweep.js";
import { confirmReceipt } from "../src/fulfillment.js";
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
  /** THI-1698: v2 reprocessor seam — the related-account GET
   *  (stripe.v2.core.accounts.retrieve, the v2 API path). */
  v2Account?: unknown;
  v2AccountError?: string;
} = {}) {
  const calls: string[] = [];
  const refundAmounts: (number | undefined)[] = [];
  const n = Math.random().toString(36).slice(2, 8);
  const client = {
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
      create: async (a: unknown, o: unknown) => {
        calls.push(`refunds.create:${(o as { idempotencyKey: string }).idempotencyKey}`);
        refundAmounts.push((a as { amount?: number }).amount);
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
    v2: {
      core: {
        accounts: {
          retrieve: async (id: string) => {
            calls.push(`v2.core.accounts.retrieve:${id}`);
            if (opts.v2AccountError) throw new Error(opts.v2AccountError);
            if (!opts.v2Account) throw new Error("no v2 account fixture");
            return opts.v2Account;
          },
        },
      },
    },
  } as unknown as Stripe;
  return { client, calls, refundAmounts };
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

  it("rule 2 + buyer-paid shipping §6: stale quote-mode order with no label bought refunds the buyer's full charge (label included)", async () => {
    // Stale sale ⇒ record_tracking never ran ⇒ no platform label ⇒ the
    // deployment never spent: the buyer's whole charge, label line included,
    // goes back. exclude_label policy + lineRetained=false ⇒ no deduction.
    const { client, refundAmounts } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await db.query(
      "UPDATE orders SET label_quote = $2::jsonb, shipping_price_cents = 0 WHERE id = $1",
      [a.orderId, JSON.stringify({ amount_cents: 733, currency: "EUR" })],
    );
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2",
      [String(cfg.staleSoldDays + 1), a.orderId],
    );
    const report = await runSweeps(cfg);
    expect((await order(a.orderId)).status).toBe("refunding");
    expect(report["2-stale-sale"].acted).toBe(1);
    expect(refundAmounts).toEqual([10733]);
  });

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

  it("rule 4 B1-sibling (THI-1013): zero payout base (free listing) settles paid_out with an operator note, no transfer", async () => {
    // Free listing in quote mode: the charge is the label line only, which
    // never enters the payout base. Pre-fix, netting threw
    // payout_netting_unavailable forever (nothing could ever satisfy it) and
    // the order wedged in payout_pending with rule-7 noise. Now the sweep
    // settles it paid_out with a payout_zero_base note and no Stripe call.
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const seed1 = await seed("stripe");
    await db.query("UPDATE items SET price_cents = 0 WHERE id = $1", [seed1.itemId]);
    await db.query(
      `UPDATE orders SET price_cents = 0, shipping_price_cents = 0, label_quote = '{"amount_cents":733}' WHERE id = $1`,
      [seed1.orderId],
    );
    await toSold(seed1.orderId, seed1.sellerEmail);
    await applyTransition({ orderId: seed1.orderId, trigger: "record_tracking", actor: { type: "seller", id: "s" }, sets: { carrier: "DHL", tracking_code: "T5", tracker_id: "trk_5" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_5" } });
    await applyTransition({ orderId: seed1.orderId, trigger: "carrier_update", actor: { type: "carrier", id: "trk_5" } });
    await db.query("UPDATE orders SET dispute_deadline = now() - interval '1 hour' WHERE id = $1", [seed1.orderId]);
    await runSweeps(cfg);
    const o = await order(seed1.orderId);
    expect(o.status).toBe("paid_out"); // settled — not wedged in payout_pending
    expect(o.transfer_id).toBeNull(); // nothing exists at Stripe to reconcile
    expect(calls.some((c) => c.startsWith("transfers.create:"))).toBe(false);
    const ev = await db.query("SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'payout_zero_base'", [seed1.orderId]);
    expect(ev.rowCount).toBe(1); // operator note recorded once (deduped)
  });

  // --- THI-1625 B-3: pickup orders without tracking (card-only native ---
  // every pickup is now card-paid; pickups never carry tracking, so every
  // deadline below is proven independent of the shipping-only rules).

  it("rule 2 (THI-1625 B-3): pickup sold past STALE_SOLD_DAYS is never stale-sale — exclusion holds even when pickupAutoconfirmDays > staleSoldDays", async () => {
    // Pickups survived rule 2 only because the defaults keep 14 < 21 — a
    // config accident. This test breaks that relationship (autoconfirm AFTER
    // the stale window) to prove the explicit fulfillment <> 'pickup'
    // exclusion carries the guarantee. The pickup's real deadline is rule 5.
    const { client, calls } = fakeStripe();
    setStripeForTests(client);
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [a.orderId]);
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2",
      ["25", a.orderId], // past staleSoldDays=21, before pickupAutoconfirmDays=30
    );
    const late = { ...cfg, staleSoldDays: 21, pickupAutoconfirmDays: 30 };
    const report = await runSweeps(late);
    expect((await order(a.orderId)).status).toBe("sold"); // neither rule acted
    expect(report["2-stale-sale"].acted).toBe(0);
    expect(report["5-pickup-autoconfirm"].acted).toBe(0);
    expect(calls.some((c) => c.startsWith("refunds.create:"))).toBe(false);
    // aging past the autoconfirm window confirms rule 5 is the pickup deadline
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2",
      ["31", a.orderId],
    );
    await runSweeps(late);
    expect((await order(a.orderId)).status).toBe("delivered");
  });

  it("rule 2 (THI-1625 B-3): pickup in the stale warning band gets no stale_sale warning when autoconfirm is later", async () => {
    // Pins the pickup exclusion on the warning arm too (post THI-1803 fix
    // this query becomes load-bearing: the shipping-side warning arm was
    // shipped dead in THI-780 PR 3 — swapped bind params make its window
    // empty — tracked separately; not a pickup defect).
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [a.orderId]);
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2",
      ["15", a.orderId], // inside [staleSoldDays/2, staleSoldDays) = [10.5, 21)
    );
    const late = { ...cfg, staleSoldDays: 21, pickupAutoconfirmDays: 30 };
    await runSweeps(late);
    expect((await order(a.orderId)).status).toBe("sold");
    const warned = await db.query(
      "SELECT 1 FROM notifications WHERE dedupe_key = $1",
      [`warn:stale_sale:${a.orderId}`],
    );
    expect(warned.rowCount).toBe(0);
  });

  it("rule 1 (THI-1625 B-3): card-paid pickup past payment deadline → cancelled (stripe arm is fulfillment-agnostic)", async () => {
    const { client, calls } = fakeStripe({ sessionPaymentStatus: "unpaid" });
    setStripeForTests(client);
    const a = await seed("stripe");
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [a.orderId]);
    await db.query("UPDATE orders SET payment_deadline = now() - interval '1 hour' WHERE id = $1", [a.orderId]);
    await runSweeps(cfg);
    expect((await order(a.orderId)).status).toBe("cancelled");
    expect(calls).toContain("sessions.retrieve");
    expect(calls).toContain("sessions.expire");
  });

  it("rule 5 (THI-1625 B-3): card-paid pickup arms auto-confirm identically (delivered + F10 long window)", async () => {
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [a.orderId]);
    await db.query(
      "UPDATE orders SET status_changed_at = now() - ($1 || ' days')::interval WHERE id = $2",
      [String(cfg.pickupAutoconfirmDays + 1), a.orderId],
    );
    await runSweeps(cfg);
    const o = await order(a.orderId);
    expect(o.status).toBe("delivered");
    const expectLong = Date.now() + cfg.systemConfirmedDisputeWindowHours * 3_600_000;
    expect(new Date(o.dispute_deadline).getTime()).toBeGreaterThan(expectLong - 10 * 60_000);
  });

  it("confirm_receipt (THI-1625 B-3): card-paid pickup sold → delivered with the short (48h) window", async () => {
    const a = await seed("stripe");
    await toSold(a.orderId, a.sellerEmail);
    await db.query("UPDATE orders SET fulfillment = 'pickup' WHERE id = $1", [a.orderId]);
    const buyerId = (await order(a.orderId)).buyer_id as string;
    const delivered = await confirmReceipt(a.orderId, buyerId);
    expect(delivered.status).toBe("delivered");
    const hours = (new Date(delivered.dispute_deadline!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
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
      livemode: false, // real Stripe events always carry it; the gate (THI-1694 R2) checks it
      data: { object: { id: o.checkout_session_id, payment_status: "paid", payment_intent: `pi_r${n}`, amount_total: chargeTotalCents(o), currency: "eur", metadata: { order_id: o.id } } },
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

  it("rule 6: rejected: livemode mismatch is final — never re-fetched; transient errors still reprocess (THI-1694 R2)", async () => {
    // Transient row (the real recovery path): re-applies a paid checkout to a pending order.
    const seed1 = await seed("stripe");
    await db.query("UPDATE orders SET payment_deadline = now() + interval '1 day' WHERE id = $1", [seed1.orderId]);
    const o = await order(seed1.orderId);
    const evt = {
      id: `evt_r6t${n}`,
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: o.checkout_session_id, payment_status: "paid", payment_intent: `pi_r6t${n}`, amount_total: chargeTotalCents(o), currency: "eur" } },
    } as unknown as Stripe.Event;
    const { client, calls } = fakeStripe({ retrieveEvent: evt });
    setStripeForTests(client);
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, '{}'::jsonb, 'ingest failed: db fault')`,
      [evt.id],
    );
    // Final rejection (ingest livemode gate, F5/§6.7): stored unprocessed, 200 —
    // rule 6 used to select it forever (THI-1694 R2).
    const rejectedId = `evt_r6rej${n}`;
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, '{}'::jsonb, 'rejected: livemode mismatch')`,
      [rejectedId],
    );

    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(1); // exactly the transient row
    expect(calls).toContain(`events.retrieve:${evt.id}`);
    expect(calls).not.toContain(`events.retrieve:${rejectedId}`); // never even fetched
    expect((await order(seed1.orderId)).status).toBe("sold");
    const done = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [evt.id])).rows[0];
    expect(done.processed_at).toBeTruthy();
    expect(done.process_error).toBeNull();
    const rej = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [rejectedId])).rows[0];
    expect(rej.processed_at).toBeNull();
    expect(rej.process_error).toBe("rejected: livemode mismatch"); // untouched: no retry, no attempt tag

    // A later sweep still ignores it (final, not retryable).
    await runSweeps(cfg);
    const rej2 = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [rejectedId])).rows[0];
    expect(rej2.processed_at).toBeNull();
    expect(rej2.process_error).toBe("rejected: livemode mismatch");
  });

  it("rule 6: a rejection whose re-fetch would succeed same-mode is still NOT processed (THI-1694 R2)", async () => {
    // The rejection is final even when events.retrieve would return a
    // matching-mode event (e.g. the configured key mode flipped after the
    // rejection) — a settled rejection is never re-litigated by the sweep.
    const seed1 = await seed("stripe");
    await db.query("UPDATE orders SET payment_deadline = now() + interval '1 day' WHERE id = $1", [seed1.orderId]);
    const o = await order(seed1.orderId);
    const evt = {
      id: `evt_r6s${n}`,
      type: "checkout.session.completed",
      livemode: false, // matches the configured (test) mode — fetch would succeed
      data: { object: { id: o.checkout_session_id, payment_status: "paid", payment_intent: `pi_r6s${n}`, amount_total: chargeTotalCents(o), currency: "eur" } },
    } as unknown as Stripe.Event;
    const { client, calls } = fakeStripe({ retrieveEvent: evt });
    setStripeForTests(client);
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, '{}'::jsonb, 'rejected: livemode mismatch')`,
      [evt.id],
    );
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(0);
    expect(calls).not.toContain(`events.retrieve:${evt.id}`);
    expect((await order(seed1.orderId)).status).toBe("pending"); // untouched
    const rej = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [evt.id])).rows[0];
    expect(rej.processed_at).toBeNull();
    expect(rej.process_error).toBe("rejected: livemode mismatch");
  });

  // --- THI-1698: v2-aware reprocessing (THI-1696 R1) -------------------------

  /** A v2 event-destination notification exactly the way the THI-1681 v2
   *  endpoint stores it (F6 ids-only payload) + the stranded-flip error the
   *  finding describes (transient ingest failure → 500). */
  async function seedV2WebhookEvent(
    notifId: string,
    objectId: string,
    opts: { livemode?: boolean; type?: string; error?: string; payload?: unknown } = {},
  ) {
    const payload = opts.payload ?? {
      id: notifId,
      type: opts.type ?? "v2.core.account[configuration.recipient].capability_status_updated",
      livemode: opts.livemode ?? false,
      object_id: objectId,
      object_type: "v2.core.account",
    };
    await db.query(
      `INSERT INTO webhook_events (source, external_id, payload, process_error) VALUES ('stripe', $1, $2::jsonb, $3)`,
      [`v2:${notifId}`, JSON.stringify(payload), opts.error ?? "ingest failed: fetchRelatedObject network error"],
    );
  }

  /** Related account the way the SDK's v2 accounts.retrieve returns it. */
  const v2AccountFixture = (acctId: string, transfersStatus = "active") => ({
    id: acctId,
    object: "v2.core.account",
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: transfersStatus } } } } },
  });

  it("rule 6: recovers a stranded v2 capability notification — re-fetch by object_id flips the seller (THI-1698)", async () => {
    n += 1;
    const acct = `acct_v2_sweep_${n}`;
    await db.query("INSERT INTO sellers (api_key_hash, display_name, email, stripe_account_id) VALUES ($1,$2,$3,$4)", [
      `thg_v2sw${n}`, `v2sw${n}`, `v2sw${n}@t.dev`, acct,
    ]);
    await seedV2WebhookEvent(`evt_v2_sweep_${n}`, acct);
    const { client, calls } = fakeStripe({ v2Account: v2AccountFixture(acct, "active") });
    setStripeForTests(client);
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(1);
    expect(calls).toContain(`v2.core.accounts.retrieve:${acct}`); // v2 API path, by the stored object_id
    expect(calls.filter((c) => c.startsWith("events.retrieve:"))).toEqual([]); // never the v1 API for a v2 row
    const seller = await db.query("SELECT stripe_onboarded_at FROM sellers WHERE api_key_hash = $1", [`thg_v2sw${n}`]);
    expect(seller.rows[0].stripe_onboarded_at).not.toBeNull();
    const row = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [`v2:evt_v2_sweep_${n}`])).rows[0];
    expect(row.processed_at).not.toBeNull();
    expect(row.process_error).toBeNull();
    const badge = await db.query("SELECT count(*)::int AS c FROM notifications WHERE dedupe_key = $1", [`payouts_enabled:${acct}`]);
    expect(badge.rows[0].c).toBe(1);
  });

  it("rule 6: v2 row with an unknown object_id fails safe — stays unprocessed, no flip, backoff honored (THI-1698)", async () => {
    await db.query("DELETE FROM webhook_events WHERE external_id = 'evt_bump'"); // earlier backoff test's leftover — keep skip counts exact
    n += 1;
    const acct = `acct_v2_ghost_${n}`;
    await db.query("INSERT INTO sellers (api_key_hash, display_name, email, stripe_account_id) VALUES ($1,$2,$3,$4)", [
      `thg_v2gh${n}`, `v2gh${n}`, `v2gh${n}@t.dev`, acct,
    ]);
    await seedV2WebhookEvent(`evt_v2_ghost_${n}`, acct);
    const { client, calls } = fakeStripe({ v2AccountError: `No such account: ${acct}` });
    setStripeForTests(client);
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].errored).toBe(1);
    expect(calls.filter((c) => c.startsWith("events.retrieve:"))).toEqual([]);
    expect((await db.query("SELECT stripe_onboarded_at FROM sellers WHERE api_key_hash = $1", [`thg_v2gh${n}`])).rows[0].stripe_onboarded_at).toBeNull();
    const row = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [`v2:evt_v2_ghost_${n}`])).rows[0];
    expect(row.processed_at).toBeNull();
    expect(row.process_error).toMatch(/fetchRelatedObject network error \[attempt 1 @ /);

    // Inside the 15-minute backoff → skipped, attempt unchanged.
    const again = await runSweeps(cfg);
    expect(again["6-reprocess"].skipped).toBe(1);
    const row2 = (await db.query("SELECT process_error FROM webhook_events WHERE external_id = $1", [`v2:evt_v2_ghost_${n}`])).rows[0];
    expect(row2.process_error).toBe(row.process_error);
  });

  it("rule 6: cross-mode v2 payload is terminal-rejected — no platform-key fetch, no flip (THI-1698 F5 re-screen)", async () => {
    n += 1;
    const acct = `acct_v2_live_${n}`;
    await db.query("INSERT INTO sellers (api_key_hash, display_name, email, stripe_account_id) VALUES ($1,$2,$3,$4)", [
      `thg_v2lv${n}`, `v2lv${n}`, `v2lv${n}@t.dev`, acct,
    ]);
    await seedV2WebhookEvent(`evt_v2_live_${n}`, acct, { livemode: true, error: "rejected: livemode mismatch" });
    const { client, calls } = fakeStripe({ v2Account: v2AccountFixture(acct, "active") });
    setStripeForTests(client);
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(1); // terminal disposition, not a retry loop
    expect(calls.filter((c) => c.startsWith("v2.core.accounts.retrieve:") || c.startsWith("events.retrieve:"))).toEqual([]);
    expect((await db.query("SELECT stripe_onboarded_at FROM sellers WHERE api_key_hash = $1", [`thg_v2lv${n}`])).rows[0].stripe_onboarded_at).toBeNull();
    const row = (await db.query("SELECT processed_at, process_error FROM webhook_events WHERE external_id = $1", [`v2:evt_v2_live_${n}`])).rows[0];
    expect(row.processed_at).not.toBeNull();
    expect(row.process_error).toBe("rejected: livemode mismatch");
  });

  it("rule 6: non-capability v2 row reprocesses as an ingest-mirroring no-op (THI-1698)", async () => {
    n += 1;
    await seedV2WebhookEvent(`evt_v2_other_${n}`, `acct_v2_other_${n}`, {
      type: "v2.core.some_other_event",
      error: "ingest failed: db fault",
    });
    const { client, calls } = fakeStripe({});
    setStripeForTests(client);
    const report = await runSweeps(cfg);
    expect(report["6-reprocess"].acted).toBe(1);
    expect(calls.filter((c) => c.startsWith("v2.core.accounts.retrieve:") || c.startsWith("events.retrieve:"))).toEqual([]);
    const row = (await db.query("SELECT processed_at FROM webhook_events WHERE external_id = $1", [`v2:evt_v2_other_${n}`])).rows[0];
    expect(row.processed_at).not.toBeNull();
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
