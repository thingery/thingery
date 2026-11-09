// MCP wanted-board tools (src/tools.ts). Part 1 is pure (pool.query mocked,
// handlers captured from registerTools, input schemas parsed directly). Part 2
// is DB-backed and skips without Postgres; it never TRUNCATEs (parallel CI
// workers share the database) and removes only the sellers it seeded.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, type SellerRow } from "../src/db.js";
import { CONTENT_PROVENANCE_NOTE, PROTECTED_TOOLS, registerTools } from "../src/tools.js";

// Deterministic embedText (null when unconfigured).
delete process.env.EMBED_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface Captured {
  config: { description?: string; inputSchema: z.ZodRawShape };
  handler: Handler;
}

function captureTools(seller: SellerRow | null): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  registerTools(
    { registerTool(name: string, config: Captured["config"], handler: Handler) { tools.set(name, { config, handler }); } },
    { seller },
  );
  return tools;
}

async function call(tools: Map<string, Captured>, name: string, args: Record<string, unknown> = {}) {
  const result = (await tools.get(name)!.handler(args)) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, any> };
}

const WANTED_ID = "11111111-1111-4111-8111-111111111111";
const row = (over: Record<string, unknown> = {}) => ({
  id: WANTED_ID,
  buyer_id: "22222222-2222-4222-8222-222222222222",
  title: "Nintendo Switch OLED",
  notes: "Boxed preferred",
  category: "other",
  condition: null,
  budget_min_cents: 15000,
  budget_max_cents: 20000,
  currency: "EUR",
  reference_images: [],
  embedding: "[0.1]",
  status: "active",
  expires_at: new Date(Date.now() + 5 * 86_400_000),
  created_at: new Date(),
  updated_at: new Date(),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("wanted public read tools (pure)", () => {
  const anon = captureTools(null);

  it("are public: neither is in PROTECTED_TOOLS", () => {
    expect(PROTECTED_TOOLS.has("search_wanted")).toBe(false);
    expect(PROTECTED_TOOLS.has("get_wanted")).toBe(false);
  });

  it.each(["search_wanted", "get_wanted"])("%s description carries the provenance note", (name) => {
    expect(anon.get(name)!.config.description).toContain(CONTENT_PROVENANCE_NOTE);
  });

  it("search_wanted marks results user_generated and strips buyer_id and embedding", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ ...row(), score: 0 }] } as never);
    const { isError, body } = await call(anon, "search_wanted", { limit: 5 });
    expect(isError).toBe(false);
    expect(body.count).toBe(1);
    expect(body.note).toBe(CONTENT_PROVENANCE_NOTE);
    expect(body.results[0].content_provenance).toBe("user_generated");
    expect(body.results[0].budget).toEqual({ min_cents: 15000, max_cents: 20000, currency: "EUR" });
    expect(body.results[0]).not.toHaveProperty("buyer_id");
    expect(body.results[0]).not.toHaveProperty("embedding");
  });

  it("search_wanted passes filters as bound parameters, never into the SQL text", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    await call(anon, "search_wanted", { q: "x%'; DROP", category: "Music", budget_max_cents_gte: 100, limit: 5, offset: 10 });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toContain("DROP");
    expect(params).toEqual(expect.arrayContaining(["music", 100, 5, 10]));
  });

  it("search_wanted bounds limit and offset in its input schema", () => {
    const schema = z.object(anon.get("search_wanted")!.config.inputSchema);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ offset: 1001 }).success).toBe(false);
  });

  it("search_wanted reports a database failure as a tool error", async () => {
    vi.spyOn(pool, "query").mockRejectedValue(new Error("boom"));
    const { isError, body } = await call(anon, "search_wanted", {});
    expect(isError).toBe(true);
    expect(body.error).toContain("search_wanted failed");
  });

  it("get_wanted marks the post user_generated and strips buyer_id and embedding", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [row()] } as never);
    const { body } = await call(anon, "get_wanted", { wanted_id: WANTED_ID });
    expect(body.note).toBe(CONTENT_PROVENANCE_NOTE);
    expect(body.wanted.content_provenance).toBe("user_generated");
    expect(body.wanted).not.toHaveProperty("buyer_id");
    expect(body.wanted).not.toHaveProperty("embedding");
  });

  it("get_wanted returns not_found when no visible post exists", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    const { isError, body } = await call(anon, "get_wanted", { wanted_id: WANTED_ID });
    expect(isError).toBe(true);
    expect(body.code).toBe("not_found");
  });

  it("get_wanted requires a uuid", () => {
    const schema = z.object(anon.get("get_wanted")!.config.inputSchema);
    expect(schema.safeParse({ wanted_id: "not-a-uuid" }).success).toBe(false);
    expect(schema.safeParse({ wanted_id: WANTED_ID }).success).toBe(true);
  });
});

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { await client.end().catch(() => {}); return false; }
}
const available = await dbAvailable();

describe.skipIf(!available)("wanted tools (DB)", () => {
  let db: pg.Client;
  const sellerIds: string[] = [];

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    await db.query(`DELETE FROM wanted_buyer_quota WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM buyer_intents WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerIds]);
    await db.end();
  });

  async function seedSeller(tag: string): Promise<SellerRow> {
    const nonce = randomUUID();
    const { rows } = await db.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3)
       RETURNING id, display_name`,
      [`wanted-tools-fixture-${nonce}`, `wt-${tag}`, `wt-${tag}-${nonce}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return rows[0];
  }

  async function insertWanted(buyerId: string, title: string, over: { status?: string; expiresIn?: string } = {}): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO wanted_items (buyer_id, title, category, status, expires_at)
       VALUES ($1, $2, 'other', $3, now() + $4::interval) RETURNING id`,
      [buyerId, title, over.status ?? "active", over.expiresIn ?? "30 days"],
    );
    return rows[0].id;
  }

  const anon = () => captureTools(null);

  it("search_wanted finds an active post by keyword; get_wanted returns it", async () => {
    const buyer = await seedSeller("read");
    const title = `Wanted probe ${randomUUID()}`;
    const id = await insertWanted(buyer.id, title);
    const found = await call(anon(), "search_wanted", { q: title, limit: 5 });
    expect(found.body.results.map((r: { id: string }) => r.id)).toContain(id);
    const one = await call(anon(), "get_wanted", { wanted_id: id });
    expect(one.body.wanted.title).toBe(title);
    expect(one.body.wanted).not.toHaveProperty("buyer_id");
  });

  it("ended posts are invisible to search_wanted and get_wanted", async () => {
    const buyer = await seedSeller("ended");
    const title = `Ended probe ${randomUUID()}`;
    const expired = await insertWanted(buyer.id, title, { status: "expired", expiresIn: "-1 day" });
    const lapsed = await insertWanted(buyer.id, title, { status: "active", expiresIn: "-1 day" });
    expect((await call(anon(), "search_wanted", { q: title, limit: 5 })).body.count).toBe(0);
    expect((await call(anon(), "get_wanted", { wanted_id: expired })).body.code).toBe("not_found");
    expect((await call(anon(), "get_wanted", { wanted_id: lapsed })).body.code).toBe("not_found");
  });
});
