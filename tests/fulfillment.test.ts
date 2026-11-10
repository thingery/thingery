// Fulfillment + dispute tools (spec THI-3 rev 2 §4.2/§5.2 + rev 3 §11.2; PR-5).
// DB-backed; Stripe faked via setStripeForTests, EasyPost via a fetch stub.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { applyTransition } from "../src/orders.js";
import { createOrder, shareShippingAddress } from "../src/order-flow.js";
import { OrderFlowError, confirmPayment, confirmReceipt, openDispute, recordTracking, releaseFunds, buyShippingLabel, MAX_LABELS_PER_SELLER_PER_DAY } from "../src/fulfillment.js";
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
  // Tool-capture harness (same pattern as tests/wanted-tools.test.ts) for
  // contract tests that exercise the registered MCP handlers directly.
  type Handler = (args: Record<string, unknown>) => Promise<unknown>;
  interface Captured {
    config: { description?: string; inputSchema: z.ZodRawShape };
    handler: Handler;
  }
  function captureTools(seller: { id: string } | null): Map<string, Captured> {
    const tools = new Map<string, Captured>();
    registerTools(
      { registerTool(name: string, config: Captured["config"], handler: Handler) { tools.set(name, { config, handler }); } },
      { seller: seller as never },
    );
    return tools;
  }
  async function call(tools: Map<string, Captured>, name: string, args: Record<string, unknown> = {}) {
    const result = (await tools.get(name)!.handler(args)) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, any> };
  }

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
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers, seller_label_quota RESTART IDENTITY CASCADE");
    delete process.env.EASYPOST_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.LABEL_MAX_COST_CENTS;
    delete process.env.LABEL_DAILY_BUDGET_CENTS;
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

  // -------------------------------------------------------------------------
  // buy_shipping_label (#5b — spec docs/specs/label-purchase.md, THI-568 PR-B)
  // -------------------------------------------------------------------------

  const FROM_ADDR = { name: "Seller", line1: "Corso Buenos Aires 2", city: "Milan", postalCode: "20122", country: "IT" };
  const RATE_DHL_EUR = { id: "rate_dhl_eur", carrier: "DHLExpress", service: "ExpressWorldwide", rate: "9.90", currency: "EUR" };
  const RATE_USPS_EUR = { id: "rate_usps_eur", carrier: "USPS", service: "Priority", rate: "12.30", currency: "EUR" };

  /** EasyPost fetch stub: quotes `rates` on /v2/shipments, buys on /buy.
   *  `onBuy` runs inside the /buy handler — the hook for the cancel race. */
  function easypostFetch(rates: Array<Record<string, unknown>>, opts: { onBuy?: () => Promise<void>; shipId?: string } = {}) {
    const shipId = opts.shipId ?? `shp_${Math.random().toString(36).slice(2, 8)}`;
    const calls: string[] = [];
    const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith("/v2/shipments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: shipId, rates }), { status: 200 });
      }
      if (/\/v2\/shipments\/[^/]+\/buy$/.test(u)) {
        if (opts.onBuy) await opts.onBuy();
        return new Response(
          JSON.stringify({
            id: shipId,
            selected_rate: rates.find((r) => (r as { id: string }).id === JSON.parse(String(init?.body)).rate.id) ?? rates[0],
            postage_label: { label_url: "https://easypost.test/labels/l1.pdf" },
            tracker: { id: "trk_lp1" },
            tracking_code: "LP0001",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: "unexpected call", code: "UNEXPECTED" } }), { status: 404 });
    }) as typeof fetch;
    return { fetch, calls, shipId, buyCalls: () => calls.filter((c) => c.endsWith("/buy")).length };
  }

  function spyLog() {
    return vi.spyOn(console, "log").mockImplementation(() => {});
  }

  function securityLines(spy: ReturnType<typeof spyLog>, type: string): Record<string, unknown>[] {
    return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
  }

  /** Seeds a sold order + EasyPost key + fetch stub; returns what tests need. */
  async function seedSoldOrderWithLabels(rates: Array<Record<string, unknown>> = [RATE_DHL_EUR, RATE_USPS_EUR], opts: { onBuy?: () => Promise<void>; mode?: "stripe" | "off_platform"; item?: { weightGrams?: number; dimensionsMm?: string }; consent?: boolean } = {}) {
    const order = await seedOrder({ mode: opts.mode, ...(opts.mode === "stripe" ? { onboarded: true } : {}) });
    if (opts.mode === "stripe") {
      await applyTransition({ orderId: order.id, trigger: "stripe_payment", actor: { type: "stripe" }, sets: { payment_intent_id: "pi_lp" } });
    } else {
      await confirmPayment(order.id, sellerId);
      // Off_platform buyers must consent before the seller can see the address
      // (spec §1) — granted by default here; the consent test opts out.
      if (opts.consent !== false) await shareShippingAddress(order.id, buyerId);
    }
    if (opts.item?.weightGrams || opts.item?.dimensionsMm) {
      await db.query("UPDATE items SET weight_grams = $2, dimensions_mm = $3 WHERE id = $1", [
        order.item_id, opts.item?.weightGrams ?? null, opts.item?.dimensionsMm ?? null,
      ]);
    }
    process.env.EASYPOST_API_KEY = "EZTK_TEST_KEY";
    const ep = easypostFetch(rates, { onBuy: opts.onBuy });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ep.fetch;
    return { order, ep, restore: () => { globalThis.fetch = realFetch; } };
  }

  const BUY_INPUT = { fromAddress: FROM_ADDR, weightGrams: 800 };

  it("buy_shipping_label: sold → label_issued with persisted tracker + label snapshot (stripe address visible from sold)", async () => {
    const { order, ep, restore } = await seedSoldOrderWithLabels(undefined, { mode: "stripe" });
    try {
      const result = await buyShippingLabel(order.id, sellerId, BUY_INPUT);
      expect(result.order.status).toBe("label_issued");
      expect(result.order.carrier).toBe("DHLExpress"); // cheapest of the two
      expect(result.order.tracking_code).toBe("LP0001");
      expect(result.order.tracker_id).toBe("trk_lp1");
      expect(result.order.label_url).toBe("https://easypost.test/labels/l1.pdf");
      expect(result.label.cost).toBe("EUR 9.90");
      const snap = result.order.label_purchase as Record<string, unknown>;
      expect(snap.shipment_id).toBe(ep.shipId);
      expect(snap.rate_id).toBe("rate_dhl_eur");
      expect(snap.cost_cents).toBe(990);
      expect(snap.currency).toBe("EUR");
      expect(String(snap.bought_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const quota = await db.query<{ used: number }>("SELECT used FROM seller_label_quota WHERE seller_id = $1", [sellerId]);
      expect(quota.rows[0].used).toBe(1);
      const evt = await db.query("SELECT to_status FROM order_events WHERE order_id = $1 AND event_type = 'transition' AND to_status = 'label_issued'", [order.id]);
      expect(evt.rows[0].to_status).toBe("label_issued");
      expect(ep.buyCalls()).toBe(1);
    } finally {
      restore();
    }
  });

  it("parcel defaults come from the listing (weight_grams + dimensions_mm) when the input omits them", async () => {
    const { order, restore } = await seedSoldOrderWithLabels(undefined, { item: { weightGrams: 800, dimensionsMm: "300x200x150" } });
    try {
      const result = await buyShippingLabel(order.id, sellerId, { fromAddress: FROM_ADDR });
      expect(result.order.status).toBe("label_issued");
    } finally {
      restore();
    }
  });

  it("no usable weight → weight_required (listing has none, input has none)", async () => {
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    try {
      const err = await buyShippingLabel(order.id, sellerId, { fromAddress: FROM_ADDR }).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("weight_required");
      expect(ep.calls).toHaveLength(0); // nothing quoted
    } finally {
      restore();
    }
  });

  it("degraded mode (no EASYPOST_API_KEY): easypost_not_configured, order stays sold, quota untouched", async () => {
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    await shareShippingAddress(order.id, buyerId);
    const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
    expect((err as OrderFlowError).code).toBe("easypost_not_configured");
    const still = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(still.rows[0].status).toBe("sold");
    const quota = await db.query("SELECT count(*)::int AS c FROM seller_label_quota");
    expect(quota.rows[0].c).toBe(0);
  });

  it("off_platform without consent: error names share_shipping_address; after consent the purchase proceeds", async () => {
    const { order, ep, restore } = await seedSoldOrderWithLabels(undefined, { consent: false });
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("shipping_address_not_shared");
      expect((err as OrderFlowError).message).toContain("share_shipping_address");
      expect(ep.calls).toHaveLength(0);
      await shareShippingAddress(order.id, buyerId);
      const result = await buyShippingLabel(order.id, sellerId, BUY_INPUT);
      expect(result.order.status).toBe("label_issued");
    } finally {
      restore();
    }
  });

  it("A1 per-label cap: rate above LABEL_MAX_COST_CENTS → label_cost_exceeds_cap, no /buy issued, no quota consumed", async () => {
    process.env.LABEL_MAX_COST_CENTS = "500";
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_cost_exceeds_cap");
      expect((err as OrderFlowError).message).toContain("LABEL_MAX_COST_CENTS=500");
      expect(ep.buyCalls()).toBe(0); // the cap runs before the spend call
      const quota = await db.query("SELECT count(*)::int AS c FROM seller_label_quota");
      expect(quota.rows[0].c).toBe(0);
    } finally {
      restore();
    }
  });

  it("A2 budget: today's persisted spend + rate over budget → label_budget_exceeded + security event; no /buy", async () => {
    const spy = spyLog();
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    const s1 = sellerId; // seedOrder below rotates the harness seller — pin it
    // Another order already bought 19 500 cents of labels today.
    const other = await seedOrder();
    await confirmPayment(other.id, sellerId);
    await db.query(`UPDATE orders SET label_purchase = $2 WHERE id = $1`, [
      other.id, JSON.stringify({ shipment_id: "shp_x", rate_id: "r", carrier: "X", service: "S", cost_cents: 19500, currency: "EUR", bought_at: new Date().toISOString() }),
    ]);
    try {
      const err = await buyShippingLabel(order.id, s1, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_budget_exceeded");
      expect(ep.buyCalls()).toBe(0);
      const events = securityLines(spy, "label_budget_exceeded");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ cost_cents: 990, daily_total_cents: 19500, budget_cents: 20000 });
      expect(events[0].sellerId).toBe(s1);
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("A2 day aggregation counts only the current UTC day: yesterday's spend does not refuse today", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000 - 60_000).toISOString();
    const { order, restore } = await seedSoldOrderWithLabels();
    const s1 = sellerId;
    const other = await seedOrder();
    await confirmPayment(other.id, sellerId);
    await db.query(`UPDATE orders SET label_purchase = $2 WHERE id = $1`, [
      other.id, JSON.stringify({ shipment_id: "shp_y", rate_id: "r", carrier: "X", service: "S", cost_cents: 19500, currency: "EUR", bought_at: yesterday }),
    ]);
    try {
      const result = await buyShippingLabel(order.id, s1, BUY_INPUT);
      expect(result.order.status).toBe("label_issued");
    } finally {
      restore();
    }
  });

  it("A2 kill switch: LABEL_DAILY_BUDGET_CENTS=0 refuses every purchase (event emitted) while tracker-only flows stay green", async () => {
    process.env.LABEL_DAILY_BUDGET_CENTS = "0";
    const spy = spyLog();
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_budget_exceeded");
      expect((err as OrderFlowError).message).toContain("disabled");
      expect(ep.buyCalls()).toBe(0);
      expect(securityLines(spy, "label_budget_exceeded")[0].budget_cents).toBe(0);
      // tracker-only flow unchanged on the same deployment:
      const other = await seedOrder();
      await confirmPayment(other.id, sellerId);
      const tracked = await recordTracking(other.id, sellerId, { carrier: "DHL", trackingCode: "KS0" });
      expect(tracked.order.status).toBe("label_issued");
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("quota wall: the 11th label of the day → rate_limited naming the reset time, no /buy", async () => {
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    await db.query(
      `INSERT INTO seller_label_quota (seller_id, day, used) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)`,
      [sellerId, MAX_LABELS_PER_SELLER_PER_DAY],
    );
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("rate_limited");
      expect((err as OrderFlowError).message).toMatch(/resets at \d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z/);
      expect(ep.buyCalls()).toBe(0);
    } finally {
      restore();
    }
  });

  it("cancel race: order leaves sold between buy and CAS → orphan alert fired, order untouched, error surfaces", async () => {
    const spy = spyLog();
    let racedOrderId = "";
    const { order, ep, restore } = await seedSoldOrderWithLabels(undefined, {
      onBuy: async () => {
        // The racing cancel wins while /buy is in flight.
        await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [racedOrderId]);
      },
    });
    racedOrderId = order.id;
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("invalid_transition");
      expect((err as OrderFlowError).message).toContain(ep.shipId);
      expect(ep.buyCalls()).toBe(1); // the label WAS bought…
      const events = securityLines(spy, "label_bought_orphan");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ order_id: order.id, shipment_id: ep.shipId });
      // …but nothing was persisted on the order:
      const row = await db.query<{ status: string; label_purchase: unknown; tracking_code: string | null }>(
        "SELECT status, label_purchase, tracking_code FROM orders WHERE id = $1", [order.id]);
      expect(row.rows[0].status).toBe("cancelled");
      expect(row.rows[0].label_purchase).toBeNull();
      expect(row.rows[0].tracking_code).toBeNull();
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("currency selection: non-base-currency rates are skipped (USD cheapest ignored); all-USD → label_no_rate", async () => {
    const usdCheap = { id: "rate_usd", carrier: "USPS", service: "Priority", rate: "1.00", currency: "USD" };
    const { order, restore } = await seedSoldOrderWithLabels([usdCheap, RATE_DHL_EUR]);
    try {
      const result = await buyShippingLabel(order.id, sellerId, BUY_INPUT);
      expect((result.order.label_purchase as Record<string, unknown>).cost_cents).toBe(990); // the EUR one
    } finally {
      restore();
    }
    const onlyUsd = [usdCheap];
    const second = await seedSoldOrderWithLabels(onlyUsd);
    try {
      const err = await buyShippingLabel(second.order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_no_rate");
    } finally {
      second.restore();
    }
  });

  it("carrier preference: cheapest matching rate wins; a matching-nothing preference errors", async () => {
    const { order, restore } = await seedSoldOrderWithLabels();
    try {
      const result = await buyShippingLabel(order.id, sellerId, { ...BUY_INPUT, carrierPreference: "USPS" });
      expect((result.order.label_purchase as Record<string, unknown>).rate_id).toBe("rate_usps_eur");
    } finally {
      restore();
    }
    const fresh = await seedSoldOrderWithLabels();
    try {
      const err = await buyShippingLabel(fresh.order.id, sellerId, { ...BUY_INPUT, carrierPreference: "FedEx" }).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_no_rate");
      expect((err as OrderFlowError).message).toContain("FedEx");
    } finally {
      fresh.restore();
    }
  });

  it("idempotent re-call on label_issued returns the stored label — no second purchase", async () => {
    const { order, ep, restore } = await seedSoldOrderWithLabels();
    try {
      const first = await buyShippingLabel(order.id, sellerId, BUY_INPUT);
      const again = await buyShippingLabel(order.id, sellerId, { ...BUY_INPUT, weightGrams: 900 });
      expect(ep.buyCalls()).toBe(1);
      expect(again.order.status).toBe("label_issued");
      expect(again.label.cost).toBe(first.label.cost);
      expect(again.label.tracking_code).toBe("LP0001");
      expect(again.note).toContain("already purchased");
      const quota = await db.query<{ used: number }>("SELECT used FROM seller_label_quota WHERE seller_id = $1", [sellerId]);
      expect(quota.rows[0].used).toBe(1);
    } finally {
      restore();
    }
  });

  it("label_issued via record_tracking (no purchase) → error directing to the record_tracking correction path", async () => {
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    await recordTracking(order.id, sellerId, { carrier: "DHL", trackingCode: "MAN1" });
    process.env.EASYPOST_API_KEY = "EZTK_TEST_KEY";
    const realFetch = globalThis.fetch;
    globalThis.fetch = easypostFetch([RATE_DHL_EUR]).fetch;
    try {
      const err = await buyShippingLabel(order.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
      expect((err as OrderFlowError).code).toBe("label_already_issued");
      expect((err as OrderFlowError).message).toContain("record_tracking");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("guards: pickup → fulfillment_mismatch; pending → invalid_transition; buyer caller → not_found", async () => {
    const pickup = await seedOrder({ tier: "local" });
    await confirmPayment(pickup.id, sellerId);
    const pickupErr = await buyShippingLabel(pickup.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
    expect((pickupErr as OrderFlowError).code).toBe("fulfillment_mismatch");

    const pending = await seedOrder();
    const pendingErr = await buyShippingLabel(pending.id, sellerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
    expect((pendingErr as OrderFlowError).code).toBe("invalid_transition");

    const sold = await seedOrder();
    await confirmPayment(sold.id, sellerId);
    const buyerErr = await buyShippingLabel(sold.id, buyerId, BUY_INPUT).catch((e: unknown) => e as OrderFlowError);
    expect((buyerErr as OrderFlowError).code).toBe("not_found");
  });

  it("tool surface: six tools registered, anonymous callers get unauthorized", async () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => registered.push(name),
    };
    registerTools(fakeServer as never, { seller: null });
    for (const t of ["record_tracking", "buy_shipping_label", "confirm_payment", "confirm_receipt", "open_dispute", "release_funds"]) {
      expect(registered).toContain(t);
    }
    const { PROTECTED_TOOLS } = await import("../src/tools.js");
    for (const t of ["record_tracking", "buy_shipping_label", "confirm_payment", "confirm_receipt", "open_dispute", "release_funds"]) {
      expect(PROTECTED_TOOLS.has(t)).toBe(true);
    }
  });

  it("buy_shipping_label tool: seller-only surface, F16-strict address, degraded mode surfaces easypost_not_configured", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = easypostFetch([]).fetch; // would quote — must never be reached
    const anon = captureTools(null);
    const anonCall = await call(anon, "buy_shipping_label", {
      order_id: "33333333-3333-4333-8333-333333333333",
      from_address: { name: "S", line1: "1 Main St", city: "Milan", postal_code: "20122", country: "IT" },
    });
    expect(anonCall.isError).toBe(true);
    expect(anonCall.body.code).toBe("unauthorized");
    globalThis.fetch = realFetch;

    // F16 parity: the from_address rejects unknown keys; schema mirrors the buyer's.
    const schema = z.object(captureTools(null).get("buy_shipping_label")!.config.inputSchema);
    const good = { order_id: "33333333-3333-4333-8333-333333333333", from_address: { name: "S", line1: "1 Main St", city: "Milan", postal_code: "20122", country: "IT" } };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, from_address: { ...good.from_address, phone: "+39 333 1112223" } }).success).toBe(true);
    for (const evil of [
      { ...good, from_address: { ...good.from_address, extra: "no" } },
      { ...good, weight_grams: 0 },
      { ...good, weight_grams: 100.5 },
      { ...good, dimensions_mm: { length: 10, width: 10 } },
      { ...good, from_address: { ...good.from_address, country: "ITA" } },
    ]) {
      expect(schema.safeParse(evil).success, JSON.stringify(evil)).toBe(false);
    }

    // Degraded deployment (no EASYPOST_API_KEY): the tool surfaces the
    // service's degraded error, not a generic failure.
    const order = await seedOrder();
    await confirmPayment(order.id, sellerId);
    await shareShippingAddress(order.id, buyerId);
    const authed = captureTools({ id: sellerId } as never);
    const degraded = await call(authed, "buy_shipping_label", {
      order_id: order.id,
      from_address: { name: "S", line1: "1 Main St", city: "Milan", postal_code: "20122", country: "IT" },
      weight_grams: 800,
    });
    expect(degraded.isError).toBe(true);
    expect(degraded.body.code).toBe("easypost_not_configured");
    expect(String(degraded.body.error)).toContain("record_tracking");
  });
});
