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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, type SellerRow } from "../src/db.js";
import * as embed from "../src/embed.js";
import * as intentsModule from "../src/intents.js";
import { CONTENT_PROVENANCE_NOTE, PROTECTED_TOOLS, registerTools } from "../src/tools.js";
import { MAX_ACTIVE_WANTEDS_PER_BUYER, MAX_WANTED_CREATES_PER_BUYER_PER_DAY } from "../src/wanted.js";
import { wantedCreateShape, wantedWriteLimiter } from "../src/wanted-writes.js";

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
    // THI-734: category resolution (+ child expansion) runs before the search
    // query; satisfy the registry lookups so the search itself executes.
    const query = vi
      .spyOn(pool, "query")
      .mockImplementation((sqlText: string) =>
        Promise.resolve(
          String(sqlText).includes("FROM categories")
            ? ({ rows: [{ name: "music" }] } as never)
            : ({ rows: [] } as never),
        ));
    await call(anon, "search_wanted", { q: "x%'; DROP", category: "Music", budget_max_cents_gte: 100, limit: 5, offset: 10 });
    const searchCall = query.mock.calls
      .map(([sql, params]) => [String(sql), params] as [string, unknown[]])
      .find(([, params]) => Array.isArray(params) && params.includes(100))!;
    expect(searchCall[0]).not.toContain("DROP");
    // the category filter is a bound text[] parameter (dept + children), never SQL text
    expect(searchCall[1].some((p) => Array.isArray(p) && p.includes("music"))).toBe(true);
    expect(searchCall[1]).toEqual(expect.arrayContaining([100, 5, 10]));
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

const ACCOUNT_TOOLS = ["create_wanted", "my_wanted", "update_wanted", "expire_wanted", "renew_wanted"];
const EVIL_REFERENCE_IMAGES = [
  ["javascript:alert(1)"],
  ["data:image/png;base64,AAAA"],
  ["ftp://example.com/a.png"],
  ["not a url"],
  [`https://example.com/${"a".repeat(2048)}.png`],
  ["https://a.dev/1.png", "https://a.dev/2.png", "https://a.dev/3.png", "https://a.dev/4.png"],
];

describe("wanted account tools (pure)", () => {
  const seller = { id: "33333333-3333-4333-8333-333333333333", display_name: "buyer" } as SellerRow;
  const authed = captureTools(seller);
  const mockQueries = (...results: Array<{ rows: unknown[] }>) => {
    const query = vi.spyOn(pool, "query");
    for (const result of results) query.mockResolvedValueOnce(result as never);
    return query;
  };
  /** The pool results of a create that passes every check, in query order:
   *  category lookup, active-cap count, quota upsert, insert. */
  const createPasses = () => [
    { rows: [{ name: "other" }] },
    { rows: [{ active: "0" }] },
    { rows: [{ creates: 1 }] },
    { rows: [row()] },
  ];

  beforeEach(() => wantedWriteLimiter.reset());

  it.each(ACCOUNT_TOOLS)("%s refuses anonymous callers before any query and is in PROTECTED_TOOLS", async (name) => {
    const query = vi.spyOn(pool, "query");
    const { isError, body } = await call(captureTools(null), name, { wanted_id: WANTED_ID, title: "Vintage watch" });
    expect(isError).toBe(true);
    expect(body.code).toBe("unauthorized");
    expect(query).not.toHaveBeenCalled();
    expect(PROTECTED_TOOLS.has(name)).toBe(true);
  });

  it.each(ACCOUNT_TOOLS)("%s description carries the provenance note", (name) => {
    expect(authed.get(name)!.config.description).toContain(CONTENT_PROVENANCE_NOTE);
  });

  it("create_wanted uses the exact input shape the HTTP route validates with", () => {
    expect(authed.get("create_wanted")!.config.inputSchema).toBe(wantedCreateShape);
  });

  it.each(["create_wanted", "update_wanted"])("%s rejects unsafe reference image URLs", (name) => {
    const schema = z.object(authed.get(name)!.config.inputSchema);
    const base = { wanted_id: WANTED_ID, title: "Vintage watch" };
    for (const reference_images of EVIL_REFERENCE_IMAGES) {
      expect(schema.safeParse({ ...base, reference_images }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, reference_images: ["https://a.dev/1.png"] }).success).toBe(true);
  });

  it("update_wanted input has no defaults that would overwrite unsent fields", () => {
    const schema = z.object(authed.get("update_wanted")!.config.inputSchema);
    expect(schema.parse({ wanted_id: WANTED_ID })).toEqual({ wanted_id: WANTED_ID });
  });

  it("create_wanted returns the public shape, marked user_generated, and saves the alert", async () => {
    mockQueries(...createPasses());
    const saveIntent = vi.spyOn(intentsModule, "saveIntent").mockResolvedValue({} as never);
    const { isError, body } = await call(authed, "create_wanted", { title: "Nintendo Switch OLED", budget_max_cents: 20000 });
    expect(isError).toBe(false);
    expect(body.created).toBe(true);
    expect(body.alert_saved).toBe(true);
    expect(body.wanted.content_provenance).toBe("user_generated");
    expect(body.wanted).not.toHaveProperty("buyer_id");
    expect(body.wanted).not.toHaveProperty("embedding");
    expect(saveIntent).toHaveBeenCalledWith(seller.id, expect.objectContaining({ q: "Nintendo Switch OLED", max_price_cents: 20000 }));
  });

  it("create_wanted skips the alert when alert_me is false", async () => {
    mockQueries(...createPasses());
    const saveIntent = vi.spyOn(intentsModule, "saveIntent");
    const { body } = await call(authed, "create_wanted", { title: "Nintendo Switch OLED", alert_me: false });
    expect(body.alert_saved).toBe(false);
    expect(saveIntent).not.toHaveBeenCalled();
  });

  it("an alert failure never fails the create", async () => {
    mockQueries(...createPasses());
    vi.spyOn(intentsModule, "saveIntent").mockRejectedValue(new intentsModule.IntentLimitError());
    const { isError, body } = await call(authed, "create_wanted", { title: "Nintendo Switch OLED" });
    expect(isError).toBe(false);
    expect(body.created).toBe(true);
    expect(body.alert_saved).toBe(false);
  });

  it("the active cap rejects with rate_limited before the embeddings call", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    mockQueries({ rows: [{ name: "other" }] }, { rows: [{ active: String(MAX_ACTIVE_WANTEDS_PER_BUYER) }] });
    const { isError, body } = await call(authed, "create_wanted", { title: "Nintendo Switch OLED" });
    expect(isError).toBe(true);
    expect(body.code).toBe("rate_limited");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("the daily create quota rejects with rate_limited", async () => {
    mockQueries({ rows: [{ name: "other" }] }, { rows: [{ active: "0" }] }, { rows: [] });
    expect((await call(authed, "create_wanted", { title: "Nintendo Switch OLED" })).body.code).toBe("rate_limited");
  });

  it("contact details are rejected before any query, in text and in reference images", async () => {
    const query = vi.spyOn(pool, "query");
    const inNotes = await call(authed, "create_wanted", { title: "Nintendo Switch OLED", notes: "write to bob@example.com" });
    const inImage = await call(authed, "create_wanted", { title: "Nintendo Switch OLED", reference_images: ["https://wa.me/34600111222"] });
    expect(inNotes.body.code).toBe("contact_info");
    expect(inImage.body.code).toBe("contact_info");
    expect(query).not.toHaveBeenCalled();
  });

  it("invalid fields map to invalid_wanted", async () => {
    const { body } = await call(authed, "create_wanted", { title: "Nintendo Switch OLED", budget_min_cents: 500, budget_max_cents: 100 });
    expect(body.code).toBe("invalid_wanted");
  });

  it("the hourly bucket is shared with the routes and logs a rate_limit event", async () => {
    for (let i = 0; i < 20; i++) expect(wantedWriteLimiter.allow(`seller:${seller.id}`)).toBe(true);
    const query = vi.spyOn(pool, "query");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const name of ["create_wanted", "update_wanted", "expire_wanted", "renew_wanted"]) {
      expect((await call(authed, name, { wanted_id: WANTED_ID, title: "Nintendo Switch OLED" })).body.code).toBe("rate_limited");
    }
    expect(query).not.toHaveBeenCalled();
    const events = log.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
    expect(events.filter((e) => e.type === "rate_limit" && e.route === "/mcp")).toHaveLength(4);
  });

  it("my_wanted is not rate-limited by the write bucket", async () => {
    for (let i = 0; i < 20; i++) wantedWriteLimiter.allow(`seller:${seller.id}`);
    mockQueries({ rows: [{ ...row(), response_count: 2, unread_responses: 1, renewable: true }] });
    const { isError, body } = await call(authed, "my_wanted", {});
    expect(isError).toBe(false);
    expect(body.count).toBe(1);
    expect(body.note).toBe(CONTENT_PROVENANCE_NOTE);
    expect(body.wanteds[0]).toMatchObject({ response_count: 2, unread_responses: 1, renewable: true, content_provenance: "user_generated" });
    expect(body.wanteds[0]).not.toHaveProperty("buyer_id");
  });

  it.each(["update_wanted", "expire_wanted", "renew_wanted"])("%s looks the post up by id AND owner, and reports not_found", async (name) => {
    const query = mockQueries({ rows: [] });
    const { isError, body } = await call(authed, name, { wanted_id: WANTED_ID, title: "New title" });
    expect(isError).toBe(true);
    expect(body.code).toBe("not_found");
    expect(query.mock.calls[0][1]).toEqual([WANTED_ID, seller.id]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("update_wanted with no fields is invalid_wanted and does not suggest parameters it lacks", async () => {
    mockQueries({ rows: [row({ buyer_id: seller.id })] });
    const { body } = await call(authed, "update_wanted", { wanted_id: WANTED_ID });
    expect(body.code).toBe("invalid_wanted");
    expect(body.error).not.toContain("expire");
  });

  it("update_wanted rejects an expired post without consuming the edit quota", async () => {
    const query = mockQueries({ rows: [row({ buyer_id: seller.id, status: "expired" })] });
    expect((await call(authed, "update_wanted", { wanted_id: WANTED_ID, title: "New title" })).body.code).toBe("invalid_wanted");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("renew_wanted rejects an active post outside the final 7 days", async () => {
    mockQueries({ rows: [row({ buyer_id: seller.id, expires_at: new Date(Date.now() + 20 * 86_400_000) })] });
    expect((await call(authed, "renew_wanted", { wanted_id: WANTED_ID })).body.code).toBe("invalid_wanted");
  });

  it("expire_wanted returns the ended post marked user_generated", async () => {
    mockQueries({ rows: [row({ buyer_id: seller.id })] }, { rows: [row({ buyer_id: seller.id, status: "expired" })] });
    const { body } = await call(authed, "expire_wanted", { wanted_id: WANTED_ID });
    expect(body.wanted.status).toBe("expired");
    expect(body.wanted.content_provenance).toBe("user_generated");
  });

  it("an unexpected failure is a tool error naming the tool", async () => {
    vi.spyOn(pool, "query").mockRejectedValue(new Error("boom"));
    const { isError, body } = await call(authed, "expire_wanted", { wanted_id: WANTED_ID });
    expect(isError).toBe(true);
    expect(body.error).toContain("expire_wanted failed");
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

  describe("account writes", () => {
    beforeEach(() => wantedWriteLimiter.reset());

    const statusOf = async (id: string) =>
      (await db.query<{ title: string; status: string }>(`SELECT title, status FROM wanted_items WHERE id = $1`, [id])).rows[0];

    it("create → my_wanted → update → expire → renew roundtrip", async () => {
      const tools = captureTools(await seedSeller("rt"));
      // Fixed text: a uuid's digit runs can trip the contact scrub's phone rule.
      const title = "Roundtrip probe post";
      const created = await call(tools, "create_wanted", { title, budget_max_cents: 20000, alert_me: false });
      expect(created.isError).toBe(false);
      const id = created.body.wanted.id as string;

      const mine = await call(tools, "my_wanted", { limit: 10 });
      expect(mine.body.wanteds.map((w: { id: string }) => w.id)).toEqual([id]);

      const updated = await call(tools, "update_wanted", { wanted_id: id, notes: "Boxed preferred", budget_max_cents: null });
      expect(updated.body.wanted).toMatchObject({ notes: "Boxed preferred", title });
      expect(updated.body.wanted.budget.max_cents).toBeNull();

      expect((await call(tools, "expire_wanted", { wanted_id: id })).body.wanted.status).toBe("expired");
      expect((await call(anon(), "get_wanted", { wanted_id: id })).body.code).toBe("not_found");
      expect((await call(tools, "expire_wanted", { wanted_id: id })).body.code).toBe("invalid_wanted");
      expect((await call(tools, "update_wanted", { wanted_id: id, notes: "x" })).body.code).toBe("invalid_wanted");

      expect((await call(tools, "renew_wanted", { wanted_id: id })).body.wanted.status).toBe("active");
      expect((await call(anon(), "get_wanted", { wanted_id: id })).isError).toBe(false);
    });

    it("another user's post is not_found on every write and stays unchanged", async () => {
      const owner = await seedSeller("owner");
      const intruder = captureTools(await seedSeller("intruder"));
      const title = "Owned probe post";
      const id = await insertWanted(owner.id, title, { expiresIn: "2 days" });
      for (const [name, args] of [
        ["update_wanted", { wanted_id: id, title: "Hijacked title" }],
        ["expire_wanted", { wanted_id: id }],
        ["renew_wanted", { wanted_id: id }],
      ] as const) {
        const { isError, body } = await call(intruder, name, args);
        expect(isError).toBe(true);
        expect(body.code).toBe("not_found");
      }
      expect(await statusOf(id)).toEqual({ title, status: "active" });
      expect((await call(intruder, "my_wanted", {})).body.count).toBe(0);
    });

    it("the active cap applies to create_wanted", async () => {
      const buyer = await seedSeller("cap");
      for (let i = 0; i < MAX_ACTIVE_WANTEDS_PER_BUYER; i++) await insertWanted(buyer.id, `Cap probe ${i}`);
      const { body } = await call(captureTools(buyer), "create_wanted", { title: "One post too many", alert_me: false });
      expect(body.code).toBe("rate_limited");
    });

    it("the daily create quota applies to create_wanted", async () => {
      const buyer = await seedSeller("quota");
      await db.query(
        `INSERT INTO wanted_buyer_quota (buyer_id, day, creates) VALUES ($1, CURRENT_DATE, $2)`,
        [buyer.id, MAX_WANTED_CREATES_PER_BUYER_PER_DAY],
      );
      const { body } = await call(captureTools(buyer), "create_wanted", { title: "Over the daily quota", alert_me: false });
      expect(body.code).toBe("rate_limited");
    });

    it("an unknown category is invalid_wanted", async () => {
      const buyer = await seedSeller("cat");
      const { body } = await call(captureTools(buyer), "create_wanted", { title: "Bad category post", category: "no-such-category" });
      expect(body.code).toBe("invalid_wanted");
    });
  });
});
