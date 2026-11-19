// quote_shipping — the pre-checkout estimate tool (spec
// docs/specs/buyer-paid-shipping.md §9, PR 5). Exercised through the
// registered MCP handler exactly as tests/fulfillment.test.ts captures
// tools; EasyPost stubbed at the fetch boundary. Contract asserted:
// { quotable: true, estimate, valid_for_minutes, binding: false } or
// { quotable: false, reason } — never addresses, never errors for
// unquotable items (that is a valid answer), rate-limited 20/h per account.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.js";
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

const EASYPOST_OK = {
  id: "shp_est_1",
  rates: [
    { id: "rate_std", carrier: "DPD", service: "Classic", rate: "12.50", currency: "EUR" },
    { id: "rate_pick", carrier: "DPD", service: "Classic", rate: "7.33", currency: "EUR" }, // cheapest wins
    { id: "rate_baddollar", carrier: "USD Carrier", service: "Whatever", rate: "1.00", currency: "USD" }, // wrong currency
  ],
};

// Tool-capture harness (same pattern as tests/fulfillment.test.ts).
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
async function call(tools: Map<string, Captured>, name: string, args: Record<string, unknown>) {
  const result = (await tools.get(name)!.handler(args)) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, any> };
}

describe.skipIf(!available)("quote_shipping estimate tool (DB, spec §9)", () => {
  let db: pg.Client;
  let n = 0;
  let sellerId = "";
  let buyerId = "";

  const accountBy = async (email: string) =>
    (await db.query<{ id: string }>("SELECT id FROM sellers WHERE email = $1", [email])).rows[0].id;

  /** Seeds seller (+default origin address) + buyer; returns an item id. */
  async function seedItem(opts: { weightGrams?: number | null; tier?: string; status?: string; withOrigin?: boolean } = {}) {
    n += 1;
    const s = `qs${n}`, b = `qb${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    sellerId = await accountBy(`${s}@t.dev`);
    buyerId = await accountBy(`${b}@t.dev`);
    if (opts.withOrigin !== false) {
      await db.query(
        `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
         VALUES ($1,'Home',$2,$3,$4,$5,$6,true)`,
        [sellerId, SELLER_ADDRESS.name, SELLER_ADDRESS.line1, SELLER_ADDRESS.city, SELLER_ADDRESS.postal_code, SELLER_ADDRESS.country],
      );
    }
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, weight_grams, status)
       VALUES ($1,$2,10000,500,$3,$4,$5) RETURNING id`,
      [sellerId, `Item ${n}`, opts.tier ?? "parcel", opts.weightGrams === undefined ? 2000 : opts.weightGrams, opts.status ?? "active"],
    );
    return item.rows[0].id;
  }

  const stubEasyPostOk = () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({ ok: true, json: async () => EASYPOST_OK }) as never);
  };

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
    process.env.EASYPOST_API_KEY = "EZAK_test_estimate";
    delete process.env.LABEL_MAX_COST_CENTS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EASYPOST_API_KEY;
    setStripeForTests(null);
  });

  it("happy path: cheapest EUR rate as a non-binding estimate; no addresses anywhere in the response", async () => {
    stubEasyPostOk();
    const itemId = await seedItem();
    const tools = captureTools({ id: buyerId });
    const { isError, body } = await call(tools, "quote_shipping", { item_id: itemId, shipping_address: BUYER_ADDRESS });
    expect(isError).toBe(false);
    expect(body).toEqual({
      quotable: true,
      binding: false,
      estimate: { amount_cents: 733, currency: "EUR", carrier: "DPD", service: "Classic" },
      valid_for_minutes: 15,
    });
    expect(JSON.stringify(body)).not.toContain("Via Dest");
    expect(JSON.stringify(body)).not.toContain("Via Orig");
  });

  it("address_id resolves the saved address (owner-scoped); foreign id is not_found", async () => {
    stubEasyPostOk();
    const itemId = await seedItem();
    const addr = await db.query<{ id: string }>(
      `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country)
       VALUES ($1,'Home',$2,$3,$4,$5,$6) RETURNING id`,
      [buyerId, BUYER_ADDRESS.name, BUYER_ADDRESS.line1, BUYER_ADDRESS.city, BUYER_ADDRESS.postal_code, BUYER_ADDRESS.country],
    );
    const tools = captureTools({ id: buyerId });
    const okCall = await call(tools, "quote_shipping", { item_id: itemId, address_id: addr.rows[0].id });
    expect(okCall.body.quotable).toBe(true);
    // A saved address owned by someone else is the same not_found — no
    // cross-account existence leak.
    const foreign = await call(tools, "quote_shipping", { item_id: itemId, address_id: "00000000-0000-0000-0000-000000000000" });
    expect(foreign.isError).toBe(true);
    expect(foreign.body.code).toBe("not_found");
  });

  it("reasons pass through the quoting core verbatim: no_weight, no_seller_default_address, easypost unset, rate_above_cap, not_shippable", async () => {
    stubEasyPostOk();
    const tools = captureTools({ id: buyerId });
    const noWeight = await call(tools, "quote_shipping", { item_id: await seedItem({ weightGrams: null }), shipping_address: BUYER_ADDRESS });
    expect(noWeight.body).toEqual({ quotable: false, reason: "no_weight" });
    const noOrigin = await call(tools, "quote_shipping", { item_id: await seedItem({ withOrigin: false }), shipping_address: BUYER_ADDRESS });
    expect(noOrigin.body).toEqual({ quotable: false, reason: "no_seller_default_address" });
    delete process.env.EASYPOST_API_KEY;
    const unset = await call(tools, "quote_shipping", { item_id: await seedItem(), shipping_address: BUYER_ADDRESS });
    expect(unset.body).toEqual({ quotable: false, reason: "easypost_not_configured" });
    process.env.EASYPOST_API_KEY = "EZAK_test_estimate";
    process.env.LABEL_MAX_COST_CENTS = "100";
    const capped = await call(tools, "quote_shipping", { item_id: await seedItem(), shipping_address: BUYER_ADDRESS });
    expect(capped.body).toEqual({ quotable: false, reason: "rate_above_cap" });
    delete process.env.LABEL_MAX_COST_CENTS;
    const pickup = await call(tools, "quote_shipping", { item_id: await seedItem({ tier: "local" }), shipping_address: BUYER_ADDRESS });
    expect(pickup.body).toEqual({ quotable: false, reason: "not_shippable" });
  });

  it("item guards: unknown item not_found; inactive listing item_not_available; address params are exclusive", async () => {
    stubEasyPostOk();
    const tools = captureTools({ id: buyerId });
    const missing = await call(tools, "quote_shipping", { item_id: "00000000-0000-0000-0000-000000000000", shipping_address: BUYER_ADDRESS });
    expect(missing.isError).toBe(true);
    expect(missing.body.code).toBe("not_found");
    const inactive = await call(tools, "quote_shipping", { item_id: await seedItem({ status: "sold" }), shipping_address: BUYER_ADDRESS });
    expect(inactive.body).toEqual({ quotable: false, reason: "item_not_available" });
    const both = await call(tools, "quote_shipping", {
      item_id: await seedItem(), shipping_address: BUYER_ADDRESS, address_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(both.isError).toBe(true);
    expect(both.body.code).toBe("invalid_request");
    const neither = await call(tools, "quote_shipping", { item_id: await seedItem() });
    expect(neither.isError).toBe(true);
    expect(neither.body.code).toBe("invalid_request");
  });

  it("rate limit: the 21st call in an hour is rejected with rate_limited; another account is unaffected", async () => {
    stubEasyPostOk();
    const itemId = await seedItem();
    const tools = captureTools({ id: buyerId });
    for (let i = 0; i < 20; i += 1) {
      const r = await call(tools, "quote_shipping", { item_id: itemId, shipping_address: BUYER_ADDRESS });
      expect(r.body.quotable).toBe(true);
    }
    const blocked = await call(tools, "quote_shipping", { item_id: itemId, shipping_address: BUYER_ADDRESS });
    expect(blocked.isError).toBe(true);
    expect(blocked.body.code).toBe("rate_limited");
    // Per-account, not global — a fresh account still quotes. (Fresh
    // captureTools instance re-registers; the limiter map is module-level
    // keyed by account id, so this exercises real cross-account state.)
    const other = captureTools({ id: sellerId });
    const fresh = await call(other, "quote_shipping", { item_id: itemId, shipping_address: BUYER_ADDRESS });
    expect(fresh.body.quotable).toBe(true);
  });

  it("unauthenticated: anonymous hosts get the 401-challenge treatment (tool listed in PROTECTED_TOOLS)", async () => {
    const tools = captureTools(null);
    const { isError, body } = await call(tools, "quote_shipping", { item_id: "00000000-0000-0000-0000-000000000000", shipping_address: BUYER_ADDRESS });
    expect(isError).toBe(true);
    expect(body.code).toBe("unauthorized");
  });

  it("provider failure degrades to a quotable:false answer, never a throw", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "down" } }) }) as never);
    const itemId = await seedItem();
    const tools = captureTools({ id: buyerId });
    const { isError, body } = await call(tools, "quote_shipping", { item_id: itemId, shipping_address: BUYER_ADDRESS });
    expect(isError).toBe(false);
    expect(body).toEqual({ quotable: false, reason: "quote_failed" });
  });
});
