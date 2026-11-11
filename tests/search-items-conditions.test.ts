// search_items `conditions`: input bounds, the SQL it generates (stubbed
// pool, no database) and real filtering over the MCP handler (skipped when no
// Postgres is reachable).

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { embedText } = vi.hoisted(() => ({ embedText: vi.fn() }));
vi.mock("../src/embed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/embed.js")>()),
  embedText,
}));

import { pool } from "../src/db.js";
import { searchItems } from "../src/items.js";
import { registerTools } from "../src/tools.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});

interface Captured {
  config: { description?: string; inputSchema: z.ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

function searchTool(): Captured {
  const registered = new Map<string, Captured>();
  registerTools(
    {
      registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
        registered.set(name, { config, handler });
      },
    },
    { seller: null },
  );
  return registered.get("search_items") as Captured;
}

const tool = searchTool();
const inputSchema = z.object(tool.config.inputSchema);

describe("search_items conditions input", () => {
  it.each([
    ["one value", ["new"]],
    ["two values", ["new", "like_new"]],
    ["every condition", ["new", "like_new", "good", "fair", "poor"]],
  ])("accepts %s", (_label, conditions) => {
    expect(inputSchema.safeParse({ conditions }).success).toBe(true);
  });

  it("is optional, so existing callers are unaffected", () => {
    expect(inputSchema.parse({ condition: "good" })).not.toHaveProperty("conditions");
  });

  it.each([
    ["an empty list", []],
    ["six values", ["new", "like_new", "good", "fair", "poor", "new"]],
    ["an unknown condition", ["mint"]],
    ["a bare string", "new"],
    ["null", null],
  ])("rejects %s", (_label, conditions) => {
    expect(inputSchema.safeParse({ conditions }).success).toBe(false);
  });

  it("documents how condition and conditions combine", () => {
    expect(tool.config.description).toContain("condition and conditions combine as one list");
  });
});

describe("searchItems condition SQL (stubbed pool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capturedQuery(): { sql: () => string; params: () => unknown[] } {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    return {
      sql: () => String(query.mock.calls[0][0]),
      params: () => query.mock.calls[0][1] as unknown[],
    };
  }

  it("filters with one parameterised array, never interpolated values", async () => {
    const captured = capturedQuery();
    await searchItems({ conditions: ["new", "like_new"], limit: 10 });
    expect(captured.sql()).toContain("i.condition = ANY($1::text[])");
    expect(captured.sql()).not.toContain("like_new");
    expect(captured.params()[0]).toEqual(["new", "like_new"]);
  });

  it("keeps a lone condition working through the same filter", async () => {
    const captured = capturedQuery();
    await searchItems({ condition: "good", limit: 10 });
    expect(captured.params()[0]).toEqual(["good"]);
  });

  it("merges condition into conditions without duplicates", async () => {
    const captured = capturedQuery();
    await searchItems({ condition: "new", conditions: ["new", "fair"], limit: 10 });
    expect(captured.params()[0]).toEqual(["new", "fair"]);
  });

  it("adds no condition filter when neither is set", async () => {
    const captured = capturedQuery();
    await searchItems({ limit: 10 });
    expect(captured.sql()).not.toContain("i.condition");
  });
});

describe.skipIf(!available)("search_items conditions over real rows (DB)", () => {
  const CATEGORY = "search-conditions-test";
  const EMAIL = "search-conditions@t.dev";
  let client: pg.Client;

  async function conditionsFound(args: Record<string, unknown>): Promise<string[]> {
    const result = await tool.handler({ category: CATEGORY, currency: "EUR", limit: 50, ...args });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text) as { results: Array<{ condition: string }> };
    return body.results.map((r) => r.condition).sort();
  }

  beforeAll(async () => {
    embedText.mockResolvedValue(null);
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(`DELETE FROM items WHERE category = $1`, [CATEGORY]);
    await client.query(`DELETE FROM sellers WHERE email = $1`, [EMAIL]);
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions)
       VALUES ($1, 'search conditions test category', '[]') ON CONFLICT (name) DO NOTHING`,
      [CATEGORY],
    );
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ('thg_search_conditions', 'search-conditions', $1)`,
      [EMAIL],
    );
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, category, condition, images)
       SELECT s.id, 'Condition lamp ' || c, 1000, $1, c, ARRAY['https://img.example.com/a.jpg']
       FROM sellers s, unnest(ARRAY['new', 'like_new', 'good', 'fair', 'poor']) c
       WHERE s.email = $2`,
      [CATEGORY, EMAIL],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM items WHERE category = $1`, [CATEGORY]);
    await client.query(`DELETE FROM sellers WHERE email = $1`, [EMAIL]);
    await client.query(`DELETE FROM categories WHERE name = $1`, [CATEGORY]);
    await client.end();
  });

  it("returns listings in any of the given conditions", async () => {
    expect(await conditionsFound({ conditions: ["new", "like_new"] })).toEqual(["like_new", "new"]);
  });

  it("keeps the single condition filter unchanged", async () => {
    expect(await conditionsFound({ condition: "fair" })).toEqual(["fair"]);
  });

  it("treats condition plus conditions as one combined list", async () => {
    expect(await conditionsFound({ condition: "poor", conditions: ["new"] })).toEqual(["new", "poor"]);
  });

  it("returns every condition when neither filter is set", async () => {
    expect(await conditionsFound({})).toHaveLength(5);
  });
});
