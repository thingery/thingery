// Stripe client module + get_payout_setup tool tests (spec THI-3 §6; PR-3).
// The Stripe SDK client is faked (setStripeForTests) — no network. The
// tool-registration surface (unauthorized for anonymous callers, F7 set
// membership) is additionally enforced by tests/protected-tools.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  getOrCreateStripeAccount,
  orderAmountCents,
  setStripeForTests,
  createCheckoutSession,
} from "../src/stripe.js";
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

/** Records every Stripe call the module makes; returns canned objects. */
function fakeStripe(): { client: Stripe; calls: Array<{ method: string; arg: unknown; opts: unknown }> } {
  const calls: Array<{ method: string; arg: unknown; opts: unknown }> = [];
  const rec = (method: string) => (arg: unknown, opts?: unknown) => {
    calls.push({ method, arg, opts });
    if (method === "accounts.create") return { id: `acct_${calls.length}` };
    if (method === "accountLinks.create") return { url: `https://onboard.test/${calls.length}` };
    if (method === "checkout.sessions.create") return { id: "cs_test_1", url: "https://pay.test/cs1" };
    return {};
  };
  const client = {
    accounts: { create: rec("accounts.create") },
    accountLinks: { create: rec("accountLinks.create") },
    checkout: { sessions: { create: rec("checkout.sessions.create"), expire: rec("checkout.sessions.expire") } },
    transfers: { create: rec("transfers.create") },
    refunds: { create: rec("refunds.create") },
  } as unknown as Stripe;
  return { client, calls };
}

afterEach(() => {
  setStripeForTests(null); // reset singleton; env decides next
  delete process.env.STRIPE_SECRET_KEY;
});

describe("orderAmountCents (rev 3 §11.4)", () => {
  it("buyer pays and seller receives price + shipping", () => {
    expect(orderAmountCents({ price_cents: 10000, shipping_price_cents: 500 })).toBe(10500);
    expect(orderAmountCents({ price_cents: 10000, shipping_price_cents: 0 })).toBe(10000);
  });
});

describe.skipIf(!available)("get_payout_setup (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    await client.end();
  });

  const registered = new Map<string, { config: { description?: string }; handler: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }>();
  let sellerId = "";

  beforeAll(async () => {
    await client.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ('thg_p1', 'p1', 'p1@t.dev')",
    );
    sellerId = (await client.query<{ id: string }>("SELECT id FROM sellers WHERE email = 'p1@t.dev'")).rows[0].id;
    registerTools(
      {
        registerTool(name: string, config: { description?: string }, handler: never) {
          registered.set(name, { config, handler });
        },
      } as never,
      { seller: { id: sellerId, api_key: "thg_p1", display_name: "p1" } },
    );
  });

  const callTool = async (name: string) => {
    const result = await registered.get(name)!.handler({});
    return {
      isError: result.isError === true,
      body: result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null,
    };
  };

  it("refuses anonymous callers (F7 surface — protected-tools.test.ts enforces the set)", async () => {
    const anon = new Map<string, { handler: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }>();
    registerTools(
      { registerTool: (name: string, _c: unknown, handler: never) => anon.set(name, { handler }) } as never,
      { seller: null },
    );
    const r = await anon.get("get_payout_setup")!.handler({});
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content![0].text!).code).toBe("unauthorized");
  });

  it("kill switch: no STRIPE_SECRET_KEY → payments_not_configured, no Stripe call", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    setStripeForTests(null);
    const { isError, body } = await callTool("get_payout_setup");
    expect(isError).toBe(true);
    expect(body.code).toBe("payments_not_configured");
    expect(body.error).toMatch(/off-platform/);
  });

  it("configured: creates the Express account once and returns the onboarding URL", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const { isError, body } = await callTool("get_payout_setup");
    expect(isError).toBe(false);
    expect(body.onboarding_url).toMatch(/^https:\/\/onboard\.test\//);
    expect(body.onboarded).toBe(false);
    expect(body.stripe_account_id).toBe("acct_1");
    const stored = await client.query<{ stripe_account_id: string }>(
      "SELECT stripe_account_id FROM sellers WHERE id = $1", [sellerId],
    );
    expect(stored.rows[0].stripe_account_id).toBe("acct_1");
    // Second call reuses the stored account — exactly one accounts.create.
    await callTool("get_payout_setup");
    expect(fake.calls.filter((c) => c.method === "accounts.create")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "accountLinks.create")).toHaveLength(2);
  });

  it("getOrCreateStripeAccount arbitration: a stored id wins over a new account", async () => {
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const id = await getOrCreateStripeAccount(sellerId, fake.client);
    expect(id).toBe("acct_1"); // stored earlier, not the fake's acct_2
    expect(fake.calls.filter((c) => c.method === "accounts.create")).toHaveLength(0);
  });
});

describe.skipIf(!available)("createCheckoutSession (DB-independent, §6.2 + §11.4)", () => {
  it("adds the explicit Shipping line item only when shipping_price_cents > 0", async () => {
    const fake = fakeStripe();
    const base = {
      orderId: "ord-1",
      item: { title: "Nike Air Max 90", currency: "EUR", price_cents: 10000 },
      expiresAt: new Date("2026-01-02T03:04:05Z"),
      baseUrl: "https://thingery.dev",
    };
    const withShipping = await createCheckoutSession({ ...base, shippingPriceCents: 500 }, fake.client);
    expect(withShipping).toBeTruthy();
    const call = fake.calls.find((c) => c.method === "checkout.sessions.create")!;
    const params = call.arg as { line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } } }>; metadata: Record<string, string>; payment_method_types: string[] };
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items.map((l) => l.price_data.product_data.name)).toEqual(["Nike Air Max 90", "Shipping"]);
    expect(params.line_items[1].price_data.unit_amount).toBe(500);
    expect(params.metadata.order_id).toBe("ord-1");
    expect(params.allowed_payment_method_types).toEqual(["card"]); // sync card only (F5)

    const pickup = await createCheckoutSession({ ...base, shippingPriceCents: 0 }, fake.client);
    expect(pickup).toBeTruthy();
    const pickupCall = fake.calls.filter((c) => c.method === "checkout.sessions.create")[1];
    expect((pickupCall.arg as { line_items: unknown[] }).line_items).toHaveLength(1);
  });
});
