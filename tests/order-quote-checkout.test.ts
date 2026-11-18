// Buyer-paid shipping — quote-at-checkout integration (spec
// docs/specs/buyer-paid-shipping.md §2–§3). End-to-end through the real
// createOrder transaction: the quote decision (rate row, flat fallback with a
// named reason, event ledger) and the Checkout session shape (label line,
// metadata split). Postgres-backed; EasyPost and Stripe are stubbed at the
// network/client boundary exactly as tests/fulfillment.test.ts does.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db.js";
import { createOrder } from "../src/order-flow.js";
import { setStripeForTests } from "../src/stripe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString = process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

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

const BUYER_ADDRESS = { name: "Buyer", line1: "Via Dest 9", city: "Milan", postal_code: "20121", country: "IT" };
const SELLER_ADDRESS = { name: "Seller", line1: "Via Orig 1", city: "Turin", postal_code: "10121", country: "IT" };

/** EasyPost POST /v2/shipments success payload: one EUR rate at €7.33. */
const EASYPOST_OK = {
  id: "shp_quote_1",
  rates: [
    { id: "rate_std", carrier: "DPD", service: "Classic", rate: "12.50", currency: "EUR" },
    { id: "rate_pick", carrier: "DPD", service: "Classic", rate: "7.33", currency: "EUR" }, // cheapest wins
    { id: "rate_baddollar", carrier: "USD Carrier", service: "Whatever", rate: "1.00", currency: "USD" }, // wrong currency
  ],
};

describe.skipIf(!available)("createOrder buyer-paid shipping quote (DB)", () => {
  let db: pg.Client;
  let n = 0;
  let sellerId = "";
  let buyerId = "";
  /** Captured Checkout sessions.create params across the fake Stripe client. */
  let sessionParams: Stripe.Checkout.SessionCreateParams | undefined;

  const fakeFetch = (impl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => impl() as never);

  const easypostOk = () => fakeFetch(async () => ({ ok: true, json: async () => EASYPOST_OK }));
  const easypostDown = () => fakeFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "down" } }) }));

  /** Stripe fake: only checkout.sessions.create is on the money path here. */
  const fakeStripe = () =>
    ({
      checkout: {
        sessions: {
          create: async (p: Stripe.Checkout.SessionCreateParams) => {
            sessionParams = p;
            return { id: `cs_q${n}`, url: `https://pay.test/q${n}` };
          },
        },
      },
    }) as unknown as Stripe;

  async function seed(opts: { weightGrams?: number | null; defaultAddress?: boolean; shippingTier?: string } = {}) {
    n += 1;
    const s = `qs${n}`, b = `qb${n}`;
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
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query("UPDATE sellers SET stripe_account_id = $2, stripe_onboarded_at = now() WHERE id = $1", [sellerId, `acct_${n}`]);
    if (opts.defaultAddress) {
      await db.query(
        `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
         VALUES ($1, 'Home', $2, $3, $4, $5, $6, true)`,
        [sellerId, SELLER_ADDRESS.name, SELLER_ADDRESS.line1, SELLER_ADDRESS.city, SELLER_ADDRESS.postal_code, SELLER_ADDRESS.country],
      );
    }
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, weight_grams)
       VALUES ($1,$2,10000,500,$3,$4) RETURNING id`,
      [sellerId, `Item ${n}`, opts.shippingTier ?? "parcel", opts.weightGrams === undefined ? 2000 : opts.weightGrams],
    );
    return item.rows[0].id;
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
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers, account_addresses RESTART IDENTITY CASCADE");
    sessionParams = undefined;
    process.env.EASYPOST_API_KEY = "EZAK_test_quote";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    delete process.env.LABEL_MAX_COST_CENTS;
    setStripeForTests(fakeStripe());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EASYPOST_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    setStripeForTests(null);
  });

  it("quotes at checkout: cheapest in-currency rate becomes the label line, flat is zeroed", async () => {
    easypostOk();
    const itemId = await seed({ defaultAddress: true });
    const { order, paymentUrl } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });

    // Row: §2 snapshot with both party addresses (private), flat stored 0 (§3).
    expect(order.label_quote).toMatchObject({
      shipment_id: "shp_quote_1", rate_id: "rate_pick", carrier: "DPD", service: "Classic",
      amount_cents: 733, currency: "EUR", weight_grams: 2000,
      origin: { country: "IT", postal_code: "10121" },
      destination: { country: "IT", postal_code: "20121" },
    });
    expect(order.shipping_price_cents).toBe(0);
    const row = await db.query("SELECT label_quote->>'amount_cents' AS amt, shipping_price_cents FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0].amt).toBe("733");
    expect(row.rows[0].shipping_price_cents).toBe(0);

    // Checkout: item + label lines only, metadata carries the split (§3).
    const amounts = sessionParams!.line_items!.map((l) => l.price_data!.unit_amount);
    expect(amounts).toEqual([10000, 733]);
    expect(sessionParams!.line_items![1].price_data!.product_data!.name).toBe("Shipping");
    expect(sessionParams!.metadata).toEqual({ order_id: order.id, label_quote_amount_cents: "733" });
    expect(paymentUrl).toBe(`https://pay.test/q${n}`);

    // Event ledger: amounts/carrier only — the payload must not echo addresses.
    const ev = await db.query("SELECT event_type, reason, payload FROM order_events WHERE event_type LIKE 'label_quote%' AND order_id = $1", [order.id]);
    expect(ev.rows).toEqual([
      { event_type: "label_quote_created", reason: "buyer_paid_quote", payload: { carrier: "DPD", amount_cents: 733 } },
    ]);
    expect(JSON.stringify(ev.rows[0].payload)).not.toContain("Via Dest");
    expect(JSON.stringify(ev.rows[0].payload)).not.toContain("Via Orig");
  });

  it("falls back to flat with a named reason when the item has no weight", async () => {
    easypostOk(); // must never be reached
    const itemId = await seed({ weightGrams: null, defaultAddress: true });
    const { order } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });
    expect(order.label_quote).toBeNull();
    expect(order.shipping_price_cents).toBe(500);
    const amounts = sessionParams!.line_items!.map((l) => l.price_data!.unit_amount);
    expect(amounts).toEqual([10000, 500]);
    expect(sessionParams!.metadata).toEqual({ order_id: order.id }); // no label split
    const ev = await db.query("SELECT event_type, reason FROM order_events WHERE event_type LIKE 'label_quote%' AND order_id = $1", [order.id]);
    expect(ev.rows).toEqual([{ event_type: "label_quote_fallback", reason: "no_weight" }]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("falls back when the seller has no default origin address", async () => {
    easypostOk();
    const itemId = await seed({ defaultAddress: false });
    const { order } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });
    expect(order.label_quote).toBeNull();
    const ev = await db.query("SELECT reason FROM order_events WHERE event_type = 'label_quote_fallback' AND order_id = $1", [order.id]);
    expect(ev.rows[0].reason).toBe("no_seller_default_address");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("falls back when the provider errors — quoting never fails the order", async () => {
    easypostDown();
    const itemId = await seed({ defaultAddress: true });
    const { order, paymentUrl } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });
    expect(order.label_quote).toBeNull();
    expect(order.shipping_price_cents).toBe(500);
    expect(paymentUrl).toBeTruthy(); // order still proceeds to Checkout
    const ev = await db.query("SELECT reason FROM order_events WHERE event_type = 'label_quote_fallback' AND order_id = $1", [order.id]);
    expect(ev.rows[0].reason).toBe("quote_failed");
  });

  it("falls back when the cheapest allowed rate exceeds the cap", async () => {
    process.env.LABEL_MAX_COST_CENTS = "100";
    easypostOk();
    const itemId = await seed({ defaultAddress: true });
    const { order } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });
    expect(order.label_quote).toBeNull();
    const ev = await db.query("SELECT reason FROM order_events WHERE event_type = 'label_quote_fallback' AND order_id = $1", [order.id]);
    expect(ev.rows[0].reason).toBe("rate_above_cap");
  });

  it("never quotes a local-pickup order (no quote events at all)", async () => {
    easypostOk();
    const itemId = await seed({ shippingTier: "local", defaultAddress: true });
    const { order } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "stripe",
    });
    expect(order.shipping_price_cents).toBe(0);
    expect(order.label_quote).toBeNull();
    const ev = await db.query("SELECT count(*)::int AS c FROM order_events WHERE event_type LIKE 'label_quote%' AND order_id = $1", [order.id]);
    expect(ev.rows[0].c).toBe(0);
    expect(sessionParams!.line_items).toHaveLength(1); // item line only
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("never quotes an off-platform order (no payment, no EasyPost call)", async () => {
    easypostOk();
    const itemId = await seed({ defaultAddress: true });
    const { order, paymentUrl } = await createOrder({
      buyerId, itemId, shippingAddress: BUYER_ADDRESS, paymentMode: "off_platform",
    });
    expect(paymentUrl).toBeNull();
    expect(order.label_quote).toBeNull();
    const ev = await db.query("SELECT count(*)::int AS c FROM order_events WHERE event_type LIKE 'label_quote%' AND order_id = $1", [order.id]);
    expect(ev.rows[0].c).toBe(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
