// Stripe client module + get_payout_setup tool tests (spec THI-3 §6; PR-3).
// The Stripe SDK client is faked (setStripeForTests) — no network. The
// tool-registration surface (unauthorized for anonymous callers, F7 set
// membership) is additionally enforced by tests/protected-tools.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  getOrCreateStripeAccount,
  ensureTransferable,
  chargeTotalCents,
  payoutBaseCents,
  payoutSetupLimiter,
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

/** Records every Stripe call the module makes; returns canned objects.
 *  THI-1681: account creation + links are on the v2 surface
 *  (stripe.v2.core.*) — v1 accounts.create is gone from this module; the
 *  v1-shaped accounts.retrieve stays (works for v1 AND v2 ids) and defaults
 *  to a v2-account view (type "none"), overridable per test. */
function fakeStripe(): { client: Stripe; calls: Array<{ method: string; arg: unknown; opts: unknown }> } {
  const calls: Array<{ method: string; arg: unknown; opts: unknown }> = [];
  const rec = (method: string) => (arg: unknown, opts?: unknown) => {
    calls.push({ method, arg, opts });
    if (method === "v2.core.accounts.create") return { id: `acct_${calls.length}` };
    if (method === "v2.core.accountLinks.create") return { url: `https://onboard.test/${calls.length}` };
    if (method === "accounts.retrieve") return { id: "acct_r", type: "none", country: "EE", capabilities: {} };
    if (method === "checkout.sessions.create") return { id: "cs_test_1", url: "https://pay.test/cs1" };
    return {};
  };
  const client = {
    accounts: { retrieve: rec("accounts.retrieve") },
    v2: {
      core: {
        accounts: { create: rec("v2.core.accounts.create"), update: rec("v2.core.accounts.update") },
        accountLinks: { create: rec("v2.core.accountLinks.create") },
      },
    },
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

describe("charge/payout money helpers (rev 3 §11.4 + buyer-paid-shipping §3)", () => {
  it("flat orders: buyer charge and payout base are both price + shipping", () => {
    expect(chargeTotalCents({ price_cents: 10000, shipping_price_cents: 500 })).toBe(10500);
    expect(payoutBaseCents({ price_cents: 10000, shipping_price_cents: 500 })).toBe(10500);
    expect(chargeTotalCents({ price_cents: 10000, shipping_price_cents: 0 })).toBe(10000);
  });

  it("quote-mode orders: the label line joins the charge, never the payout base", () => {
    const order = {
      price_cents: 10000,
      shipping_price_cents: 0, // stored 0 in quote mode (§3)
      label_quote: { amount_cents: 733 },
    };
    expect(chargeTotalCents(order)).toBe(10733);
    expect(payoutBaseCents(order)).toBe(10000);
  });

  it("a null/absent label_quote (pre-feature and flat orders) adds nothing", () => {
    expect(chargeTotalCents({ price_cents: 10000, shipping_price_cents: 500, label_quote: null })).toBe(10500);
    expect(chargeTotalCents({ price_cents: 10000, shipping_price_cents: 500, label_quote: undefined })).toBe(10500);
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
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ('thg_p1', 'p1', 'p1@t.dev')",
    );
    sellerId = (await client.query<{ id: string }>("SELECT id FROM sellers WHERE email = 'p1@t.dev'")).rows[0].id;
    registerTools(
      {
        registerTool(name: string, config: { description?: string }, handler: never) {
          registered.set(name, { config, handler });
        },
      } as never,
      { seller: { id: sellerId, display_name: "p1" } },
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

  it("configured: creates the v2 recipient account once (with country + contact email) and returns the onboarding URL", async () => {
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
    // THI-1681: v2 recipient shape — transfers-only capability, Express
    // dashboard, platform collects fees AND bears losses, seller's country
    // prefilled (p1 has no address → platform default EE), Stripe contact
    // email from the account.
    const create = fake.calls.find((c) => c.method === "v2.core.accounts.create")!;
    expect(create.arg).toMatchObject({
      dashboard: "express",
      identity: { country: "EE" },
      contact_email: "p1@t.dev",
      defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    });
    expect(fake.calls.filter((c) => c.method === "accounts.create")).toHaveLength(0); // v1 create is gone
    // Second call reuses the stored account — exactly one v2 create.
    await callTool("get_payout_setup");
    expect(fake.calls.filter((c) => c.method === "v2.core.accounts.create")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "v2.core.accountLinks.create")).toHaveLength(2);
  });

  it("THI-1681: seller with no email → email_required, no account created", async () => {
    await client.query("INSERT INTO sellers (api_key_hash, display_name) VALUES ('thg_noemail', 'noemail')");
    const noEmailId = (
      await client.query<{ id: string }>("SELECT id FROM sellers WHERE api_key_hash = 'thg_noemail'")
    ).rows[0].id;
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const ctx = new Map<string, { handler: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }>();
    registerTools(
      { registerTool: (name: string, _c: unknown, handler: never) => ctx.set(name, { handler }) } as never,
      { seller: { id: noEmailId, display_name: "noemail" } } as never,
    );
    const r = await ctx.get("get_payout_setup")!.handler({});
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content![0].text!);
    expect(body.code).toBe("email_required");
    expect(fake.calls.filter((c) => c.method === "v2.core.accounts.create")).toHaveLength(0);
  });

  it("THI-1681: seller's address country prefills the v2 account (default address first)", async () => {
    await client.query("INSERT INTO sellers (api_key_hash, display_name, email) VALUES ('thg_de', 'de', 'de@t.dev')");
    const deId = (await client.query<{ id: string }>("SELECT id FROM sellers WHERE api_key_hash = 'thg_de'")).rows[0].id;
    await client.query(
      `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
       VALUES ($1, 'Home', 'DE Seller', 'Street 1', 'Berlin', '10115', 'DE', true),
              ($1, 'Old', 'DE Seller', 'Street 2', 'Wien', '1010', 'AT', false)`,
      [deId],
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    await getOrCreateStripeAccount(deId, fake.client);
    const create = fake.calls.find((c) => c.method === "v2.core.accounts.create")!;
    expect((create.arg as { identity: { country: string } }).identity.country).toBe("DE");
  });

  it("THI-1681: stored account pre-onboarding re-syncs identity.country to the seller's address country; onboarded/legacy accounts untouched", async () => {
    await client.query("INSERT INTO sellers (api_key_hash, display_name, email, stripe_account_id) VALUES ('thg_sync', 'sync', 'sync@t.dev', 'acct_v2_sync')");
    const syncId = (await client.query<{ id: string }>("SELECT id FROM sellers WHERE api_key_hash = 'thg_sync'")).rows[0].id;
    await client.query(
      `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
       VALUES ($1, 'Home', 'S', 'Street 1', 'Paris', '75001', 'FR', true)`,
      [syncId],
    );
    const fake = fakeStripe();
    // v2 account, not yet onboarded, created with stale EE prefill.
    fake.client.accounts.retrieve = (async () => ({ id: "acct_v2_sync", type: "none", country: "EE", capabilities: { transfers: "inactive" } })) as never;
    await getOrCreateStripeAccount(syncId, fake.client as Stripe);
    const upd = fake.calls.find((c) => c.method === "v2.core.accounts.update");
    expect(upd).toBeTruthy();
    expect(upd!.arg).toBe("acct_v2_sync");
    expect((upd!.opts as { identity: { country: string } }).identity.country).toBe("FR");

    // Onboarded (transfers active): no update.
    const fake2 = fakeStripe();
    fake2.client.accounts.retrieve = (async () => ({ id: "acct_v2_sync", type: "none", country: "EE", capabilities: { transfers: "active" } })) as never;
    await getOrCreateStripeAccount(syncId, fake2.client as Stripe);
    expect(fake2.calls.filter((c) => c.method === "v2.core.accounts.update")).toHaveLength(0);

    // Legacy v1 account: never touched.
    const fake3 = fakeStripe();
    fake3.client.accounts.retrieve = (async () => ({ id: "acct_v1_old", type: "express", country: "EE", capabilities: { transfers: "inactive" } })) as never;
    await getOrCreateStripeAccount(syncId, fake3.client as Stripe);
    expect(fake3.calls.filter((c) => c.method === "v2.core.accounts.update")).toHaveLength(0);
  });

  it("THI-1681: ensureTransferable — active/unknown pass, explicitly restricted throws before transfers.create", async () => {
    const mk = (caps: unknown) => {
      const fake = fakeStripe();
      fake.client.accounts.retrieve = (async () => ({ id: "acct_x", capabilities: caps })) as never;
      return fake;
    };
    await expect(ensureTransferable("acct_x", mk({ transfers: "active" }).client as Stripe)).resolves.toBeUndefined();
    // Older v1 shapes without a capabilities block defer to Stripe's rejection.
    await expect(ensureTransferable("acct_x", mk(undefined).client as Stripe)).resolves.toBeUndefined();
    const blocked = mk({ transfers: "inactive" });
    await expect(ensureTransferable("acct_x", blocked.client as Stripe)).rejects.toThrow(/payout_account_not_ready/);
    // The guard throws BEFORE any money moves.
    expect(blocked.calls.filter((c) => c.method === "transfers.create")).toHaveLength(0);
  });

  // THI-875 (residual from the THI-871 security review): get_payout_setup
  // mints a single-use Stripe onboarding link on every call — a provider-side
  // API call. A scripted session looping the tool must hit a server-side cap,
  // not just the web client's per-tab guard. Red-check: against unthrottled
  // code the 11th call succeeds (isError false, a fresh mint) and both
  // assertions below fail.
  it("mint throttle: 11th link within the hour → rate_limited, no mint, per-seller bucket", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    payoutSetupLimiter.reset();
    try {
      for (let i = 0; i < 10; i++) {
        const { isError } = await callTool("get_payout_setup");
        expect(isError).toBe(false);
      }
      expect(fake.calls.filter((c) => c.method === "v2.core.accountLinks.create")).toHaveLength(10);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { isError, body } = await callTool("get_payout_setup");
        expect(isError).toBe(true);
        expect(body.code).toBe("rate_limited");
        expect(body.error).toMatch(/10 per hour/);
        // The rejected call mints nothing — the provider-side call is the
        // abuse surface being capped.
        expect(fake.calls.filter((c) => c.method === "v2.core.accountLinks.create")).toHaveLength(10);
        // THI-112 H4.2: the 429 is a security event on the MCP surface.
        const events = logSpy.mock.calls
          .map((args) => String(args[0]))
          .filter((s) => s.startsWith('{"ts":'))
          .map((s) => JSON.parse(s))
          .filter((o: { type?: string }) => o.type === "rate_limit");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ route: "/mcp", sellerId });
        // Per-seller key (not global): a second seller still mints while p1
        // is throttled.
        await client.query(
          "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ('thg_p2', 'p2', 'p2@t.dev')",
        );
        const p2Id = (await client.query<{ id: string }>("SELECT id FROM sellers WHERE email = 'p2@t.dev'")).rows[0].id;
        const second = new Map<string, { handler: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }>();
        registerTools(
          { registerTool: (name: string, _c: unknown, handler: never) => second.set(name, { handler }) } as never,
          { seller: { id: p2Id, display_name: "p2" } },
        );
        const r = await second.get("get_payout_setup")!.handler({});
        expect(r.isError).not.toBe(true);
        expect(JSON.parse(r.content![0].text!).onboarding_url).toMatch(/^https:\/\/onboard\.test\//);
        // p2 minted its own account + link; p1's mint count is unchanged.
        expect(fake.calls.filter((c) => c.method === "v2.core.accountLinks.create")).toHaveLength(11);
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      payoutSetupLimiter.reset(); // leave the shared bucket clean
    }
  });

  it("getOrCreateStripeAccount arbitration: a stored id wins over a new account", async () => {
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const id = await getOrCreateStripeAccount(sellerId, fake.client);
    expect(id).toBe("acct_1"); // stored earlier, not the fake's acct_2
    expect(fake.calls.filter((c) => c.method === "v2.core.accounts.create")).toHaveLength(0);
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
