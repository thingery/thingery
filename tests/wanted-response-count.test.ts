// Public answer count on search_wanted / get_wanted. Part 1 is pure (pool
// mocked): the count is a correlated aggregate in the SQL, not a join that
// could carry responder rows. Part 2 is DB-backed and skips without Postgres:
// only published responses on non-deleted listings count, and no responder
// identity reaches the payload.

import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db.js";
import { registerTools } from "../src/tools.js";

delete process.env.EMBED_API_KEY;

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface Captured {
  config: { description?: string; inputSchema: z.ZodRawShape };
  handler: Handler;
}

function anonTools(): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  registerTools(
    { registerTool(name: string, config: Captured["config"], handler: Handler) { tools.set(name, { config, handler }); } },
    { seller: null },
  );
  return tools;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = (await anonTools().get(name)!.handler(args)) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, any> };
}

describe("public wanted response_count SQL (pure)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["search_wanted", { limit: 5 }],
    ["search_wanted", { q: "switch", limit: 5 }],
    ["get_wanted", { wanted_id: "11111111-1111-4111-8111-111111111111" }],
  ])("%s selects a published-only count scalar", async (name, args) => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    await call(name, args);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/\(SELECT COUNT\(\*\)::int\s+FROM wanted_responses wr/);
    expect(sql).toContain("wr.published_at IS NOT NULL");
    expect(sql).toContain("i.status <> 'deleted'");
    expect(sql).not.toMatch(/wr\.seller_id|wr\.item_id AS/);
  });

  it.each(["search_wanted", "get_wanted"])("%s documents response_count", (name) => {
    expect(anonTools().get(name)!.config.description).toContain("response_count");
  });
});

const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});

describe.skipIf(!available)("public wanted response_count (DB)", () => {
  let db: pg.Client;
  const sellerIds: string[] = [];
  let buyerId: string;
  let responderId: string;

  async function seedSeller(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`wanted-count-fixture-${nonce}`, `wc-${tag}`, `wc-${tag}-${nonce}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return rows[0].id;
  }

  async function insertWanted(title: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO wanted_items (buyer_id, title, category, status, expires_at)
       VALUES ($1, $2, 'other', 'active', now() + interval '30 days') RETURNING id`,
      [buyerId, title],
    );
    return rows[0].id;
  }

  /** One response from the responder: a listing in `status`, published or not. */
  async function respond(wantedId: string, opts: { published: boolean; status?: string }): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category, status, images)
       VALUES ($1, 'Answer listing', 1000, 'other', $2, ARRAY['https://img.example.com/a.jpg']) RETURNING id`,
      [responderId, opts.status ?? "active"],
    );
    await db.query(
      `INSERT INTO wanted_responses (wanted_item_id, seller_id, item_id, published_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)`,
      [wantedId, responderId, rows[0].id, opts.published],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    buyerId = await seedSeller("buyer");
    responderId = await seedSeller("responder");
  });

  afterAll(async () => {
    await db.query(`DELETE FROM wanted_responses WHERE seller_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM items WHERE seller_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM wanted_items WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerIds]);
    await db.end();
  });

  it("counts published answers on live listings, on both list and detail", async () => {
    const title = `Count probe ${randomUUID()}`;
    const wantedId = await insertWanted(title);
    await respond(wantedId, { published: true });
    await respond(wantedId, { published: true, status: "sold" });
    await respond(wantedId, { published: false }); // pending photo: not visible yet
    await respond(wantedId, { published: true, status: "deleted" }); // taken down

    const listed = await call("search_wanted", { q: title, limit: 5 });
    expect(listed.body.results).toHaveLength(1);
    expect(listed.body.results[0].response_count).toBe(2);

    const detail = await call("get_wanted", { wanted_id: wantedId });
    expect(detail.body.wanted.response_count).toBe(2);
  });

  it("is 0 for a post nobody has answered", async () => {
    const wantedId = await insertWanted(`Quiet probe ${randomUUID()}`);
    expect((await call("get_wanted", { wanted_id: wantedId })).body.wanted.response_count).toBe(0);
  });

  it("never exposes who answered or which listing", async () => {
    const wantedId = await insertWanted(`Privacy probe ${randomUUID()}`);
    const itemId = await respond(wantedId, { published: true });
    const text = JSON.stringify((await call("get_wanted", { wanted_id: wantedId })).body);
    expect(text).not.toContain(responderId);
    expect(text).not.toContain(itemId);
    expect(text).not.toContain(buyerId);
  });
});
