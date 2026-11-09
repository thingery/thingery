// Seller-set shipping price: validation at the single write choke point
// (createItem/updateItem), the pickup rule, buyer-facing totals, and the money
// path (Checkout lines, payout netting, refund). DB-free except the final
// block, which exercises the order snapshot through the real tools.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import type { ZodTypeAny } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeUpdateArgs, signChatConfirmToken, TOOLS, verifyChatConfirmToken } from "../src/chat.js";
import { pool, type ItemRow, type SellerRow } from "../src/db.js";
import { createItem, MAX_SHIPPING_PRICE_CENTS, ShippingPriceError, updateItem } from "../src/items.js";
import { cancelOrder } from "../src/order-flow.js";
import { createCheckoutSession, createRefundForOrder, createTransferForOrder, orderAmountCents, setStripeForTests } from "../src/stripe.js";
import { itemToPublic, registerTools } from "../src/tools.js";

delete process.env.EMBED_API_KEY;

type ToolResult = { isError?: boolean; content: { text: string }[] };
type RegisteredTool = {
  schema: Record<string, ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function toolsFor(seller: Pick<SellerRow, "id" | "display_name"> | null): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerTools(
    {
      registerTool: (name: string, config: { inputSchema: Record<string, ZodTypeAny> }, handler: RegisteredTool["handler"]) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    },
    { seller: seller as SellerRow | null },
  );
  return tools;
}

const callTool = async (tools: Map<string, RegisteredTool>, name: string, args: Record<string, unknown>) => {
  const result = await tools.get(name)!.handler(args);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
};

const itemRow = (overrides: Partial<ItemRow> = {}): ItemRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  seller_id: "seller-1",
  title: "Oak desk",
  description: "",
  category: "other",
  condition: "good",
  brand: null,
  price_cents: 12000,
  currency: "EUR",
  location: null,
  weight_grams: null,
  dimensions_mm: null,
  shipping_tier: "parcel",
  shipping_price_cents: 700,
  images: [],
  attributes: {},
  status: "active",
  photo_required: true,
  created_at: new Date("2026-10-01T00:00:00Z"),
  ...overrides,
});

/** Routes pool.query by statement; `tier: null` models a missing/non-owned row. */
function fakePool(tier: string | null = "parcel") {
  const queries: { text: string; params: unknown[] }[] = [];
  vi.spyOn(pool, "query").mockImplementation((async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (text.includes("COUNT(*) FILTER")) return { rows: [{ creates_24h: "0", active: "0" }] };
    if (text.startsWith("SELECT shipping_tier")) return { rows: tier ? [{ shipping_tier: tier }] : [] };
    if (text.includes("FROM categories")) return { rows: [{ name: "other", description: "", attribute_definitions: [] }] };
    if (text.includes("FROM wanted_items")) {
      return { rows: [{ id: "w1", buyer_id: "buyer-1", status: "active", expires_at: new Date(Date.now() + 3_600_000) }] };
    }
    if (text.includes("FROM wanted_responses")) return { rows: [{ count: "0" }] };
    if (text.includes("INSERT INTO wanted_responses")) return { rows: [{ id: "r1", published_at: null }] };
    if (text.includes("INSERT INTO items")) return { rows: [itemRow({ shipping_price_cents: params[15] as number })] };
    if (text.startsWith("UPDATE items")) return { rows: tier ? [itemRow()] : [] };
    return { rows: [] };
  }) as never);
  return queries;
}

const writes = (queries: { text: string }[]) =>
  queries.filter((q) => q.text.includes("INSERT INTO items") || q.text.startsWith("UPDATE items"));

const listingInput = (overrides: Partial<Parameters<typeof createItem>[0]> = {}) => ({
  seller_id: "seller-1",
  title: "Oak desk",
  description: "",
  category: "other",
  condition: "good",
  price_cents: 12000,
  currency: "EUR",
  shipping_tier: "parcel",
  images: [],
  ...overrides,
});

const seller = { id: "seller-1", display_name: "Seller" };
const invalidValues: [string, unknown][] = [
  ["negative", -1],
  ["fractional", 1.5],
  ["above the cap", MAX_SHIPPING_PRICE_CENTS + 1],
  ["a numeric string", "500"],
  ["NaN", Number.NaN],
];

describe("createItem shipping_price_cents", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(invalidValues)("rejects %s before any query runs", async (_label, value) => {
    const queries = fakePool();
    await expect(createItem(listingInput({ shipping_price_cents: value as number }))).rejects.toBeInstanceOf(ShippingPriceError);
    expect(queries).toHaveLength(0);
  });

  it.each([0, 1, MAX_SHIPPING_PRICE_CENTS])("stores %i", async (value) => {
    const queries = fakePool();
    const item = await createItem(listingInput({ shipping_price_cents: value }));
    expect(item.shipping_price_cents).toBe(value);
    expect(writes(queries)[0].text).toContain("shipping_price_cents");
  });

  it("defaults to 0 (free shipping) when unset", async () => {
    fakePool();
    expect((await createItem(listingInput())).shipping_price_cents).toBe(0);
  });

  it("rejects a non-zero charge on a local pickup listing, and accepts 0 or unset", async () => {
    const queries = fakePool();
    await expect(createItem(listingInput({ shipping_tier: "local", shipping_price_cents: 1 }))).rejects.toMatchObject({
      code: "invalid_shipping_price",
    });
    expect(writes(queries)).toHaveLength(0);
    await expect(createItem(listingInput({ shipping_tier: "local", shipping_price_cents: 0 }))).resolves.toBeTruthy();
    await expect(createItem(listingInput({ shipping_tier: "local" }))).resolves.toBeTruthy();
  });
});

describe("updateItem shipping_price_cents", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the new price through a parameter", async () => {
    const queries = fakePool("parcel");
    await updateItem("item-1", "seller-1", { shipping_price_cents: 900 });
    const [update] = writes(queries);
    expect(update.text).toMatch(/shipping_price_cents = \$1/);
    expect(queries.at(-1)?.params[0]).toBe(900);
  });

  it.each(invalidValues)("rejects %s without writing", async (_label, value) => {
    const queries = fakePool("parcel");
    await expect(updateItem("item-1", "seller-1", { shipping_price_cents: value as number })).rejects.toBeInstanceOf(ShippingPriceError);
    expect(writes(queries)).toHaveLength(0);
  });

  it("rejects a non-zero charge on a local listing, and accepts 0", async () => {
    const queries = fakePool("local");
    await expect(updateItem("item-1", "seller-1", { shipping_price_cents: 500 })).rejects.toBeInstanceOf(ShippingPriceError);
    expect(writes(queries)).toHaveLength(0);
    await expect(updateItem("item-1", "seller-1", { shipping_price_cents: 0 })).resolves.toBeTruthy();
  });

  it("a missing or non-owned listing stays not-found, with no pickup error to leak its tier", async () => {
    fakePool(null);
    await expect(updateItem("item-1", "seller-1", { shipping_price_cents: 500 })).resolves.toBeNull();
  });
});

describe("listing tool surface", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["create_listing", "update_listing", "respond_to_wanted"])("%s validates shipping_price_cents bounds", (name) => {
    const field = toolsFor(seller).get(name)!.schema.shipping_price_cents;
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse(0).success).toBe(true);
    expect(field.safeParse(MAX_SHIPPING_PRICE_CENTS).success).toBe(true);
    expect(field.safeParse(MAX_SHIPPING_PRICE_CENTS + 1).success).toBe(false);
    expect(field.safeParse(-1).success).toBe(false);
    expect(field.safeParse(1.5).success).toBe(false);
    expect(field.safeParse("500").success).toBe(false);
  });

  it("create_listing reports the pickup rejection with its typed code", async () => {
    fakePool();
    const out = await callTool(toolsFor(seller), "create_listing", {
      title: "Sofa", price_cents: 1000, shipping_tier: "local", shipping_price_cents: 500,
    });
    expect(out.isError).toBe(true);
    expect(out.body.code).toBe("invalid_shipping_price");
  });

  it("update_listing reports the pickup rejection with its typed code", async () => {
    fakePool("local");
    const out = await callTool(toolsFor(seller), "update_listing", {
      id: "00000000-0000-4000-8000-000000000001", shipping_price_cents: 500,
    });
    expect(out.isError).toBe(true);
    expect(out.body.code).toBe("invalid_shipping_price");
  });

  it("respond_to_wanted stores the shipping price and applies the pickup rule", async () => {
    const queries = fakePool();
    const tools = toolsFor(seller);
    const base = { wanted_id: "00000000-0000-4000-8000-00000000000a", title: "Oak desk", price_cents: 12000 };
    const ok = await callTool(tools, "respond_to_wanted", { ...base, shipping_tier: "parcel", shipping_price_cents: 700 });
    expect(ok.body.item.shipping_price_cents).toBe(700);
    expect(ok.body.item.total_price_cents).toBe(12700);
    expect(writes(queries)).toHaveLength(1);

    const pickup = await callTool(tools, "respond_to_wanted", { ...base, shipping_tier: "local", shipping_price_cents: 700 });
    expect(pickup.isError).toBe(true);
    expect(pickup.body.code).toBe("invalid_shipping_price");
    expect(writes(queries)).toHaveLength(1);
  });

  it("itemToPublic returns the shipping price and the buyer total", () => {
    const shipped = itemToPublic(itemRow());
    expect(shipped.shipping_price_cents).toBe(700);
    expect(shipped.total_price_cents).toBe(12700);
    expect(itemToPublic(itemRow({ shipping_price_cents: 0 })).total_price_cents).toBe(12000);
  });

  it("the total of a local listing never includes shipping, matching the order snapshot", () => {
    expect(itemToPublic(itemRow({ shipping_tier: "local", shipping_price_cents: 700 })).total_price_cents).toBe(12000);
  });
});

describe("chat surface", () => {
  it("exposes shipping_price_cents on create_listing and update_listing with the shared cap", () => {
    for (const name of ["create_listing", "update_listing"]) {
      const tool = TOOLS.find((t) => t.function.name === name)!;
      const properties = tool.function.parameters.properties as Record<string, { maximum?: number }>;
      expect(properties.shipping_price_cents.maximum).toBe(MAX_SHIPPING_PRICE_CENTS);
    }
  });

  it("normalizeUpdateArgs keeps a valid value and fails closed on anything else", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(normalizeUpdateArgs({ id, shipping_price_cents: 700 })).toEqual({ ok: true, args: { id, shipping_price_cents: 700 } });
    for (const value of ["700", 1.5, -1, MAX_SHIPPING_PRICE_CENTS + 1]) {
      expect(normalizeUpdateArgs({ id, shipping_price_cents: value }).ok).toBe(false);
    }
  });

  it("a shipping confirmation op survives signing and verification", () => {
    const token = signChatConfirmToken("abc", "shipping=0", Math.floor(Date.now() / 1000) + 60);
    expect(verifyChatConfirmToken(token)).toEqual({ itemId: "abc", op: "shipping=0" });
  });
});

describe("money path includes shipping", () => {
  const order = { id: "o1", payment_intent_id: "pi_1", price_cents: 12000, shipping_price_cents: 700, currency: "EUR" };

  const stripeWithCharge = (amount: number, fee: number) => {
    const transfers: { amount: number }[] = [];
    const client = {
      paymentIntents: {
        retrieve: async () => ({
          latest_charge: { id: "ch_1", status: "succeeded", balance_transaction: { amount, currency: "eur", fee } },
        }),
      },
      transfers: { create: async (params: { amount: number }) => { transfers.push(params); return { id: "tr_1" }; } },
    } as unknown as Stripe;
    return { client, transfers };
  };

  it("Checkout charges the item and shipping as separate lines summing to the order amount", async () => {
    let params: Stripe.Checkout.SessionCreateParams | undefined;
    const client = {
      checkout: { sessions: { create: async (p: Stripe.Checkout.SessionCreateParams) => { params = p; return { id: "cs_1" }; } } },
    } as unknown as Stripe;
    await createCheckoutSession(
      {
        orderId: "o1",
        item: { title: "Oak desk", currency: "EUR", price_cents: 12000 },
        shippingPriceCents: 700,
        expiresAt: new Date(Date.now() + 3_600_000),
        baseUrl: "https://thingery.test",
      },
      client,
    );
    const amounts = params!.line_items!.map((line) => line.price_data!.unit_amount);
    expect(amounts).toEqual([12000, 700]);
    expect(params!.line_items![1].price_data!.product_data!.name).toBe("Shipping");
    expect(amounts[0]! + amounts[1]!).toBe(orderAmountCents(order));
  });

  it("pays the seller price plus shipping minus the Stripe fee on the whole charge", async () => {
    const { client, transfers } = stripeWithCharge(12700, 216);
    await createTransferForOrder(order, "acct_1", client);
    expect(transfers[0].amount).toBe(12700 - 216);
  });

  it("refuses to pay out when the charge excludes shipping", async () => {
    const { client, transfers } = stripeWithCharge(12000, 216);
    await expect(createTransferForOrder(order, "acct_1", client)).rejects.toThrow(/payout_charge_mismatch/);
    expect(transfers).toHaveLength(0);
  });

  it("refunds the buyer price plus shipping", async () => {
    let refunded: number | undefined;
    const client = {
      refunds: { create: async (p: { amount: number }) => { refunded = p.amount; return { id: "re_1" }; } },
    } as unknown as Stripe;
    await createRefundForOrder(order, "pi_1", client);
    expect(refunded).toBe(12700);
  });
});

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

describe.skipIf(!available)("shipping price through the order flow (DB)", () => {
  let db: pg.Client;
  let sellerTools: Map<string, RegisteredTool>;
  let buyerTools: Map<string, RegisteredTool>;
  let sellerId = "";
  let buyerId = "";
  const address = { name: "B", line1: "Via Roma 1", city: "Milan", postal_code: "20100", country: "IT" };

  const list = async (args: Record<string, unknown> = {}) => {
    const created = await callTool(sellerTools, "create_listing", {
      title: "Oak desk", price_cents: 12000, shipping_tier: "parcel", shipping_price_cents: 700,
      images: ["https://cdn.test/desk.jpg"], ...args,
    });
    expect(created.isError).toBe(false);
    return created.body.item as { id: string; shipping_price_cents: number; total_price_cents: number };
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
    vi.spyOn(console, "log").mockImplementation(() => {});
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    const { rows } = await db.query<{ id: string; display_name: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ('ship-fixture-s', 'ship-seller', 'ship-s@t.dev'), ('ship-fixture-b', 'ship-buyer', 'ship-b@t.dev')
       RETURNING id, display_name`,
    );
    sellerId = rows[0].id;
    buyerId = rows[1].id;
    sellerTools = toolsFor(rows[0]);
    buyerTools = toolsFor(rows[1]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("returns the shipping price and total on get_item, search_items and my_listings", async () => {
    const item = await list();
    expect(item.shipping_price_cents).toBe(700);
    expect(item.total_price_cents).toBe(12700);

    const got = await callTool(buyerTools, "get_item", { id: item.id });
    expect(got.body.item).toMatchObject({ shipping_price_cents: 700, total_price_cents: 12700 });
    const found = await callTool(buyerTools, "search_items", {});
    expect(found.body.results[0]).toMatchObject({ shipping_price_cents: 700, total_price_cents: 12700 });
    const mine = await callTool(sellerTools, "my_listings", {});
    expect(mine.body.items[0]).toMatchObject({ shipping_price_cents: 700, total_price_cents: 12700 });
  });

  it("a pickup listing charges no shipping", async () => {
    const rejected = await callTool(sellerTools, "create_listing", {
      title: "Oak desk", price_cents: 12000, shipping_tier: "local", shipping_price_cents: 700,
    });
    expect(rejected.body.code).toBe("invalid_shipping_price");
    expect((await db.query("SELECT COUNT(*)::int AS n FROM items")).rows[0].n).toBe(0);

    const item = await list({ shipping_tier: "local", shipping_price_cents: undefined });
    const ordered = await callTool(buyerTools, "create_order", { item_id: item.id });
    expect(ordered.body.order).toMatchObject({ fulfillment: "pickup", shipping_price_cents: 0, total_price_cents: 12000 });
  });

  it("changing the listing's shipping price leaves an existing order's snapshot untouched", async () => {
    const item = await list();
    const ordered = await callTool(buyerTools, "create_order", { item_id: item.id, shipping_address: address });
    expect(ordered.body.order).toMatchObject({ shipping_price_cents: 700, total_price_cents: 12700 });

    const updated = await callTool(sellerTools, "update_listing", { id: item.id, shipping_price_cents: 1500 });
    expect(updated.body.item).toMatchObject({ shipping_price_cents: 1500, total_price_cents: 13500 });

    const order = await callTool(buyerTools, "get_order", { order_id: ordered.body.order.id });
    expect(order.body.order).toMatchObject({ shipping_price_cents: 700, total_price_cents: 12700 });
    const row = await db.query("SELECT shipping_price_cents FROM orders WHERE id = $1", [ordered.body.order.id]);
    expect(row.rows[0].shipping_price_cents).toBe(700);
  });

  it("Stripe orders charge, refund and pay out the snapshot including shipping", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_shipping";
    await db.query("UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now() WHERE id = $1", [sellerId]);
    let session: Stripe.Checkout.SessionCreateParams | undefined;
    let refunded: number | undefined;
    let transferred: number | undefined;
    const client = {
      checkout: { sessions: { create: async (p: Stripe.Checkout.SessionCreateParams) => { session = p; return { id: "cs_ship", url: "https://pay.test/ship" }; } } },
      paymentIntents: {
        retrieve: async () => ({
          latest_charge: { id: "ch_1", status: "succeeded", balance_transaction: { amount: 12700, currency: "eur", fee: 216 } },
        }),
      },
      transfers: { create: async (p: { amount: number }) => { transferred = p.amount; return { id: "tr_ship" }; } },
      refunds: { create: async (p: { amount: number }) => { refunded = p.amount; return { id: "re_ship" }; } },
    } as unknown as Stripe;
    setStripeForTests(client);

    const item = await list();
    const ordered = await callTool(buyerTools, "create_order", { item_id: item.id, shipping_address: address });
    expect(ordered.body.payment_url).toBe("https://pay.test/ship");
    expect(ordered.body.order).toMatchObject({ payment_mode: "stripe", shipping_price_cents: 700, total_price_cents: 12700 });
    expect(session!.line_items!.map((line) => line.price_data!.unit_amount)).toEqual([12000, 700]);

    // The seller raises shipping after the buyer ordered: money still follows the snapshot.
    await callTool(sellerTools, "update_listing", { id: item.id, shipping_price_cents: 1500 });
    const orderId = ordered.body.order.id as string;
    await db.query("UPDATE orders SET status = 'sold', payment_intent_id = 'pi_ship', status_changed_at = now() WHERE id = $1", [orderId]);
    await db.query("UPDATE items SET status = 'sold' WHERE id = $1", [item.id]);

    const snapshot = (await db.query("SELECT * FROM orders WHERE id = $1", [orderId])).rows[0];
    await createTransferForOrder(snapshot, "acct_x", client);
    expect(transferred).toBe(12700 - 216);

    await cancelOrder(orderId, buyerId, "changed mind");
    expect(refunded).toBe(12700);
  });
});
