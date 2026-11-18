// Order-time address verification — DB-backed integration (docs/specs/
// order-address-verification.md): the createOrder gate, the suggested branch
// (no order, no reservation, no payment clock), the accept/keep/verified
// storage shapes, degraded mode (key unset → NULL column), and the tool
// surface's suggested result. Provider responses are scripted by stubbing
// global fetch (the easypost client resolves `fetch` at call time); Stripe is
// faked via setStripeForTests exactly like the other order suites.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { registerTools } from "../src/tools.js";
import { createOrder } from "../src/order-flow.js";
import { __resetAddressVerificationForTests, verifyOrderAddress } from "../src/address-verification.js";

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

function fakeStripe(): { client: Stripe } {
  const n = Math.random().toString(36).slice(2, 8);
  const client = {
    checkout: {
      sessions: {
        create: async () => ({ id: `cs_${n}`, url: `https://pay.test/${n}` }),
        retrieve: async (id: string) => ({ id, url: `https://pay.test/${n}`, payment_status: "unpaid" }),
        expire: async () => ({}),
      },
    },
  } as unknown as Stripe;
  return { client };
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status }) as Response;

const resVerified = () =>
  jsonRes({
    id: "adr_1", street1: "Via Roma 1", city: "Milano", zip: "20100", country: "IT",
    verifications: { delivery: { success: true } },
  });
const resSuggested = () =>
  jsonRes({
    id: "adr_2", street1: "Via Roma 1/A", city: "Milano", zip: "20121", country: "IT",
    verifications: { delivery: { success: false, errors: [{ message: "Address not found" }] } },
  });

/** Provider fixture for the next N fetch calls. Returns the call counter. */
function stubProvider(res: () => Response) {
  const calls = { count: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls.count += 1;
      return res();
    }),
  );
  return calls;
}

const ADDRESS = { name: "Mario Rossi", line1: "Via Roma 1", city: "Milano", postal_code: "20100", country: "IT" };
const SUGGESTED = { ...ADDRESS, line1: "Via Roma 1/A", postal_code: "20121" };

describe.skipIf(!available)("order-time address verification (DB)", () => {
  let db: pg.Client;
  let n = 0;
  const ids = { sellerId: "", buyerId: "" };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `av${n}`, b = `ab${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const r = await db.query(
      `SELECT (SELECT id FROM sellers WHERE email=$1) AS seller, (SELECT id FROM sellers WHERE email=$2) AS buyer`,
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    __resetAddressVerificationForTests();
    delete process.env.ADDRESS_VERIFICATION_DAILY_CAP;
    delete process.env.EASYPOST_API_KEY;
  });
  afterEach(() => {
    setStripeForTests(null);
    vi.unstubAllGlobals();
    delete process.env.ADDRESS_VERIFICATION_DAILY_CAP;
    delete process.env.EASYPOST_API_KEY;
  });

  const seedItem = async (tier = "parcel") => {
    const item = await db.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, status)
       VALUES ($1, $2, 10000, 500, $3, 'active') RETURNING id`,
      [ids.sellerId, `Item ${n}`, tier],
    );
    return item.rows[0].id as string;
  };
  const orderCount = async () =>
    Number((await db.query("SELECT count(*)::int AS c FROM orders")).rows[0].c);
  const verificationOf = async (orderId: string) =>
    (await db.query("SELECT shipping_verification FROM orders WHERE id = $1", [orderId])).rows[0]
      .shipping_verification;

  it("degraded mode (key unset): order unchanged, column NULL, zero provider calls", async () => {
    const itemId = await seedItem();
    const { order, paymentUrl } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS });
    expect(order.status).toBe("pending");
    expect(paymentUrl).toBeNull();
    expect(await verificationOf(order.id)).toBeNull();
    const events = await db.query("SELECT count(*)::int AS c FROM order_events WHERE order_id = $1", [order.id]);
    expect(events.rows[0].c).toBe(1); // plain creation event, nothing else
  });

  it("kill switch (cap 0): key set but no checks run", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    process.env.ADDRESS_VERIFICATION_DAILY_CAP = "0";
    const calls = stubProvider(resVerified);
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS });
    expect(await verificationOf(order.id)).toBeNull();
    expect(calls.count).toBe(0);
  });

  it("verified: order created with the record stored; pickup orders never check", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    const calls = stubProvider(resVerified);
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS });
    expect(await verificationOf(order.id)).toEqual({ status: "verified", checked_at: expect.any(String) });
    expect(calls.count).toBe(1);

    const pickupId = await seedItem("local");
    const pickup = await createOrder({ buyerId: ids.buyerId, itemId: pickupId });
    expect(await verificationOf(pickup.order.id)).toBeNull();
    expect(calls.count).toBe(1); // pickup: no provider interaction
  });

  it("suggested branch: no order, no reservation, no payment clock — item stays active", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    const calls = stubProvider(resSuggested);
    const itemId = await seedItem();
    const err = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS }).catch((e) => e);
    expect(err.code).toBe("address_verification_suggested");
    expect(err instanceof Error && err.name).toBe("AddressSuggestedError");
    // No address values in the message — the suggestion rides in data.
    expect(err.message).not.toContain("Via Roma");
    expect(err.message).not.toContain("20100");
    expect(err.verification).toEqual({ status: "suggested", suggestion: SUGGESTED, checked_at: expect.any(String) });
    // Transaction rolled back having touched nothing:
    expect(await orderCount()).toBe(0);
    expect((await db.query("SELECT status FROM items WHERE id = $1", [itemId])).rows[0].status).toBe("active");
    const events = await db.query("SELECT count(*)::int AS c FROM order_events");
    expect(events.rows[0].c).toBe(0);
    expect(calls.count).toBe(1); // exactly one provider call
  });

  it("accept path: resubmitting the suggested address orders it, stored suggested/accepted, one provider call total", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    const calls = stubProvider(resSuggested);
    const itemId = await seedItem();
    await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS }).catch(() => undefined);
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: SUGGESTED });
    expect(order.status).toBe("pending");
    expect(calls.count).toBe(1); // accept = cache hit, no second provider call
    expect(await verificationOf(order.id)).toEqual({
      status: "suggested",
      accepted: true,
      checked_at: expect.any(String),
    });
    const stored = (await db.query("SELECT shipping_address FROM orders WHERE id = $1", [order.id])).rows[0].shipping_address;
    expect(stored).toEqual(SUGGESTED); // the order ships to the buyer's chosen address
    expect((await db.query("SELECT status FROM items WHERE id = $1", [itemId])).rows[0].status).toBe("reserved");
  });

  it("keep path: verification_choice orders the typed address with suggested/kept stored", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    const calls = stubProvider(resSuggested);
    const itemId = await seedItem();
    await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS }).catch(() => undefined);
    const { order } = await createOrder({
      buyerId: ids.buyerId,
      itemId,
      shippingAddress: ADDRESS,
      verificationChoice: "keep_original",
    });
    expect(calls.count).toBe(1); // honored from cache, no re-check
    expect(await verificationOf(order.id)).toEqual({
      status: "suggested",
      kept: true,
      suggestion: SUGGESTED,
      checked_at: expect.any(String),
    });
    const stored = (await db.query("SELECT shipping_address FROM orders WHERE id = $1", [order.id])).rows[0].shipping_address;
    expect(stored).toEqual(ADDRESS); // the buyer's typed address ships
  });

  it("keep_original without a cached suggestion is a no-op: fresh check runs", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    const calls = stubProvider(resVerified);
    const itemId = await seedItem();
    const { order } = await createOrder({
      buyerId: ids.buyerId,
      itemId,
      shippingAddress: ADDRESS,
      verificationChoice: "keep_original",
    });
    expect(calls.count).toBe(1);
    expect(await verificationOf(order.id)).toEqual({ status: "verified", checked_at: expect.any(String) });
  });

  it("provider failure → not_checked: order proceeds, column NULL", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    stubProvider(() => jsonRes({ error: {} }, 500));
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS });
    expect(order.status).toBe("pending");
    expect(await verificationOf(order.id)).toBeNull();
  });

  it("over-cap account → not_checked: order proceeds unverified", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    stubProvider(resVerified);
    // Exhaust this buyer's 20/day bucket directly through the shared module
    // (the bucket createOrder spends from) — going through createOrder itself
    // would trip the platform's pending-order cap long before the budget.
    for (let i = 0; i < 20; i++) {
      await verifyOrderAddress({ accountId: ids.buyerId, address: { ...ADDRESS, line1: `Via ${i}` } });
    }
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, shippingAddress: ADDRESS });
    expect(order.status).toBe("pending");
    expect(await verificationOf(order.id)).toBeNull(); // 21st → not_checked, order fine
  });

  it("tool surface: suggested branch is an isError result with code + validated suggestion only", async () => {
    process.env.EASYPOST_API_KEY = "test-key";
    stubProvider(resSuggested);
    const itemId = await seedItem();
    let createOrderTool!: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    registerTools(
      {
        registerTool(name: string, _c: unknown, handler: typeof createOrderTool) {
          if (name === "create_order") createOrderTool = handler;
        },
      },
      { seller: { id: ids.buyerId } as never },
    );
    const result = await createOrderTool({ item_id: itemId, shipping_address: ADDRESS });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.code).toBe("address_verification_suggested");
    expect(payload.error).not.toContain("Via Roma");
    expect(payload.verification).toEqual({
      status: "suggested",
      suggestion: SUGGESTED,
      checked_at: expect.any(String),
    });
    // The stripe-mode twin never runs: no session exists for a non-created order.
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    setStripeForTests(fakeStripe().client);
    await expect(
      createOrderTool({ item_id: itemId, shipping_address: ADDRESS, payment_mode: "stripe" }),
    ).resolves.toMatchObject({ isError: true });
    expect(await orderCount()).toBe(0);
  });
});
