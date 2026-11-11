// update_listing condition: the seller can regrade a listing after publishing.
// DB-free except the final block, which exercises the real tools end to end
// (ownership, the CHECK backstop, and listings with a live order).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ZodTypeAny } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeUpdateArgs, TOOLS } from "../src/chat.js";
import { CONDITIONS, pool, type SellerRow } from "../src/db.js";
import { updateItem } from "../src/items.js";
import { registerTools } from "../src/tools.js";

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

const listingId = "00000000-0000-4000-8000-000000000001";

describe("update_listing condition input", () => {
  it("accepts every create_listing condition and nothing else", () => {
    const tools = toolsFor({ id: "seller-1", display_name: "Seller" });
    const updateField = tools.get("update_listing")!.schema.condition;
    const createField = tools.get("create_listing")!.schema.condition;
    expect(updateField.safeParse(undefined).success).toBe(true);
    for (const condition of CONDITIONS) {
      expect(updateField.safeParse(condition).success).toBe(true);
      expect(createField.safeParse(condition).success).toBe(true);
    }
    for (const value of ["mint", "GOOD", "", 3, null]) {
      expect(updateField.safeParse(value).success).toBe(false);
    }
  });
});

describe("updateItem condition", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the new condition through a parameter", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const queries: { text: string; params: unknown[] }[] = [];
    vi.spyOn(pool, "query").mockImplementation((async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rows: [{ id: listingId, condition: "fair" }] };
    }) as never);

    await updateItem(listingId, "seller-1", { condition: "fair" });

    expect(queries).toHaveLength(1);
    expect(queries[0].text).toMatch(/SET condition = \$1\s/);
    expect(queries[0].text).toMatch(/WHERE id = \$2 AND seller_id = \$3/);
    expect(queries[0].params).toEqual(["fair", listingId, "seller-1"]);
  });
});

describe("chat surface", () => {
  it("exposes condition on update_listing with the shared enum", () => {
    const tool = TOOLS.find((t) => t.function.name === "update_listing")!;
    const properties = tool.function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(properties.condition.enum).toEqual([...CONDITIONS]);
  });

  it("normalizeUpdateArgs keeps a valid condition and fails closed on anything else", () => {
    expect(normalizeUpdateArgs({ id: listingId, condition: "like_new" })).toEqual({
      ok: true,
      args: { id: listingId, condition: "like_new" },
    });
    for (const value of ["mint", "Good", 1, null]) {
      expect(normalizeUpdateArgs({ id: listingId, condition: value }).ok).toBe(false);
    }
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

describe.skipIf(!available)("update_listing condition (DB)", () => {
  let db: pg.Client;
  let sellerTools: Map<string, RegisteredTool>;
  let otherTools: Map<string, RegisteredTool>;
  let sellerId = "";

  const list = async () => {
    const created = await callTool(sellerTools, "create_listing", {
      title: "Oak desk", price_cents: 12000, shipping_tier: "parcel", condition: "good",
      images: ["https://cdn.test/desk.jpg"],
    });
    expect(created.isError).toBe(false);
    return created.body.item as { id: string; condition: string };
  };
  const storedCondition = async (id: string) =>
    (await db.query<{ condition: string }>("SELECT condition FROM items WHERE id = $1", [id])).rows[0].condition;

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
       VALUES ('cond-fixture-s', 'cond-seller', 'cond-s@t.dev'), ('cond-fixture-o', 'cond-other', 'cond-o@t.dev')
       RETURNING id, display_name`,
    );
    sellerId = rows[0].id;
    sellerTools = toolsFor(rows[0]);
    otherTools = toolsFor(rows[1]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("updates the condition and returns it, leaving other fields untouched", async () => {
    const item = await list();
    const updated = await callTool(sellerTools, "update_listing", { id: item.id, condition: "fair" });
    expect(updated.isError).toBe(false);
    expect(updated.body.item).toMatchObject({ condition: "fair", title: "Oak desk" });
    const row = await db.query("SELECT condition, title, price_cents FROM items WHERE id = $1", [item.id]);
    expect(row.rows[0]).toEqual({ condition: "fair", title: "Oak desk", price_cents: 12000 });
  });

  it("a listing someone else owns stays not-found and unchanged", async () => {
    const item = await list();
    const updated = await callTool(otherTools, "update_listing", { id: item.id, condition: "poor" });
    expect(updated.body.code).toBe("not_found");
    expect(await storedCondition(item.id)).toBe("good");
  });

  it("the CHECK constraint backs up the input validation", async () => {
    const item = await list();
    await expect(updateItem(item.id, sellerId, { condition: "mint" })).rejects.toThrow();
    expect(await storedCondition(item.id)).toBe("good");
  });

  it("can be edited while an order is live, like price and title", async () => {
    const item = await list();
    const buyer = await db.query<{ id: string; display_name: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ('cond-fixture-b', 'cond-buyer', 'cond-b@t.dev') RETURNING id, display_name`,
    );
    const ordered = await callTool(toolsFor(buyer.rows[0]), "create_order", {
      item_id: item.id,
      shipping_address: { name: "B", line1: "Via Roma 1", city: "Milan", postal_code: "20100", country: "IT" },
    });
    expect(ordered.isError).toBe(false);

    const updated = await callTool(sellerTools, "update_listing", { id: item.id, condition: "like_new" });
    expect(updated.isError).toBe(false);
    expect(await storedCondition(item.id)).toBe("like_new");
  });
});
