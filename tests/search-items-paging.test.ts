// Stable ordering across search_items pages. Part 1 asserts the generated SQL
// with a stubbed pool (no database). Part 2 pages real rows that deliberately
// tie on the ranking key, and is skipped when no Postgres is reachable.

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { embedText } = vi.hoisted(() => ({ embedText: vi.fn() }));
vi.mock("../src/embed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/embed.js")>()),
  embedText,
}));

import { pool } from "../src/db.js";
import { searchItems, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET } from "../src/items.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});
const QUERY_VECTOR = Array.from({ length: 1536 }, () => 0.1);
const RANK_WINDOW = SEARCH_MAX_OFFSET + SEARCH_MAX_LIMIT + 1;

describe("searchItems paging SQL (stubbed pool)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    embedText.mockReset();
  });

  function capturedQuery(): { sql: () => string; params: () => unknown[] } {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    return {
      sql: () => String(query.mock.calls[0][0]),
      params: () => query.mock.calls[0][1] as unknown[],
    };
  }

  it.each([["browse", undefined], ["keyword-only", "lamp"]])("breaks ties by id on the %s path", async (_path, q) => {
    embedText.mockResolvedValue(null);
    const captured = capturedQuery();
    await searchItems({ q, limit: 10, offset: 20 });
    expect(captured.sql()).toContain("ORDER BY i.created_at DESC, i.id");
    expect(captured.params().slice(-2)).toEqual([10, 20]);
  });

  it("ranks a fixed window, then breaks ties by id outside it", async () => {
    embedText.mockResolvedValue(QUERY_VECTOR);
    const captured = capturedQuery();
    await searchItems({ q: "lamp", limit: 10, offset: 20 });
    // The inner ORDER BY must stay distance-only so ivfflat stays usable.
    expect(captured.sql()).toMatch(/ORDER BY i\.embedding <=> \$\d+::vector\s+LIMIT \$\d+\s+\) ranked/);
    expect(captured.sql()).toMatch(/ORDER BY ranked\.embedding <=> \$\d+::vector, ranked\.id/);
    expect(captured.params().slice(-3)).toEqual([RANK_WINDOW, 10, 20]);
  });

  it.each([
    ["keeps the window at the MCP bound", SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET, true, RANK_WINDOW, SEARCH_MAX_LIMIT + 1],
    ["widens the window for deeper /browse pages", 30, 2970, false, 3000, 30],
  ])("%s", async (_case, limit, offset, lookahead, window, fetched) => {
    embedText.mockResolvedValue(QUERY_VECTOR);
    const captured = capturedQuery();
    await searchItems({ q: "lamp", limit, offset, lookahead });
    expect(captured.params().slice(-3)).toEqual([window, fetched, offset]);
  });

  it.each([[false, SEARCH_MAX_LIMIT], [true, SEARCH_MAX_LIMIT + 1]])("lookahead %s fetches %i rows at the clamp", async (lookahead, fetched) => {
    const captured = capturedQuery();
    await searchItems({ limit: 500, lookahead });
    expect(captured.params().slice(-2)).toEqual([fetched, 0]);
  });
});

describe.skipIf(!available)("searchItems paging over tied rows (DB)", () => {
  const CATEGORY = "search-paging-test";
  const TIED_ITEMS = 9;
  const PAGE_SIZE = 2;
  let client: pg.Client;

  /** Walks every page; a stable order yields each item exactly once. */
  async function walk(q?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; offset < TIED_ITEMS + PAGE_SIZE; offset += PAGE_SIZE) {
      const page = await searchItems({ q, category: CATEGORY, currency: "EUR", limit: PAGE_SIZE, offset });
      ids.push(...page.map((row) => row.id));
    }
    return ids;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(`DELETE FROM items WHERE category = $1`, [CATEGORY]);
    await client.query(`DELETE FROM sellers WHERE email = 'search-paging@t.dev'`);
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions)
       VALUES ($1, 'search paging test category', '[]') ON CONFLICT (name) DO NOTHING`,
      [CATEGORY],
    );
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ('thg_search_paging', 'search-paging', 'search-paging@t.dev')`,
    );
    // One statement, so now() gives every row the same created_at, and one
    // vector, so every row ties on distance: only the id can order them.
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, images, embedding)
       SELECT s.id, 'Tied paging lamp ' || n, 1000, 100, $1, ARRAY['https://img.example.com/a.jpg'], $2::vector
       FROM sellers s, generate_series(1, ${TIED_ITEMS}) n
       WHERE s.email = 'search-paging@t.dev'`,
      [CATEGORY, JSON.stringify(QUERY_VECTOR)],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM items WHERE category = $1`, [CATEGORY]);
    await client.query(`DELETE FROM sellers WHERE email = 'search-paging@t.dev'`);
    await client.query(`DELETE FROM categories WHERE name = $1`, [CATEGORY]);
    await client.end();
  });

  it.each([
    ["browse", undefined, null],
    ["keyword", "paging lamp", null],
    ["semantic", "paging lamp", QUERY_VECTOR],
  ])("%s path returns every tied row exactly once", async (_path, q, embedding) => {
    embedText.mockResolvedValue(embedding);
    const ids = await walk(q);
    expect(ids).toHaveLength(TIED_ITEMS);
    expect(new Set(ids).size).toBe(TIED_ITEMS);
  });
});
