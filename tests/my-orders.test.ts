// my_orders: authorization, filters, keyset pagination, and the public shape.
// Registration and SQL-binding checks run without a database; the rest are DB-backed.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SellerRow } from "../src/db.js";
import { pool } from "../src/db.js";
import { PROTECTED_TOOLS, registerTools } from "../src/tools.js";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
interface ToolConfig { inputSchema: z.ZodRawShape }

function captureMyOrders(seller: SellerRow | null) {
  let tool: { config: ToolConfig; handler: Handler } | undefined;
  registerTools(
    {
      registerTool(name: string, config: ToolConfig, handler: Handler) {
        if (name === "my_orders") tool = { config, handler };
      },
    } as never,
    { seller },
  );
  return tool!;
}

async function callMyOrders(seller: SellerRow | null, args: Record<string, unknown> = {}) {
  const result = await captureMyOrders(seller).handler(args);
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0].text) as {
      code?: string; count: number; next_cursor: string | null; orders: Record<string, unknown>[];
    },
  };
}

const NEVER_SELECTED = ["shipping_address", "tracker_id", "checkout_session_id", "payment_intent_id", "transfer_id", "refund_id"];

afterEach(() => vi.restoreAllMocks());

describe("my_orders tool surface", () => {
  it("is in the 401-challenge set and refuses anonymous callers without querying", async () => {
    const query = vi.spyOn(pool, "query");
    expect(PROTECTED_TOOLS.has("my_orders")).toBe(true);
    const { isError, body } = await callMyOrders(null);
    expect(isError).toBe(true);
    expect(body.code).toBe("unauthorized");
    expect(query).not.toHaveBeenCalled();
  });

  it("bounds limit and validates role, status and cursor", () => {
    const schema = z.object(captureMyOrders(null).config.inputSchema);
    expect(schema.parse({})).toMatchObject({ role: "both", limit: 20 });
    expect(schema.safeParse({ limit: 100 }).success).toBe(true);
    for (const invalid of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { role: "admin" }, { status: "nope" }, { cursor: "' OR 1=1 --" },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it("binds caller-controlled values, never selects private columns, and clamps limit", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    const accountId = randomUUID();
    const cursor = randomUUID();
    await callMyOrders({ id: accountId } as SellerRow, { role: "seller", status: "sold", limit: 100000, cursor });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual([accountId, "sold", cursor, 101]);
    expect(sql).not.toContain(accountId);
    expect(sql).not.toContain("o.*");
    for (const column of NEVER_SELECTED) expect(sql).not.toContain(column);
  });
});

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { await client.end().catch(() => {}); return false; }
}

describe.skipIf(!(await dbAvailable()))("my_orders (DB)", () => {
  let client: pg.Client;
  const accountIds: string[] = [];
  const orderIds: string[] = [];

  async function seedAccounts(...tags: string[]): Promise<SellerRow[]> {
    const seeded: SellerRow[] = [];
    for (const tag of tags) {
      const nonce = randomUUID();
      const { rows } = await client.query<SellerRow>(
        "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id, display_name",
        [`my-orders-fixture-${nonce}`, `morders-${tag}`, `morders-${tag}-${nonce}@t.dev`],
      );
      accountIds.push(rows[0].id);
      seeded.push(rows[0]);
    }
    return seeded;
  }

  async function seedOrder(seller: SellerRow, buyer: SellerRow, createdAt: string, status = "cancelled"): Promise<string> {
    const item = await client.query<{ id: string }>(
      "INSERT INTO items (seller_id, title, price_cents, status) VALUES ($1, 'Lamp', 1000, 'reserved') RETURNING id",
      [seller.id],
    );
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, price_cents, shipping_price_cents, currency, fulfillment,
                           shipping_address, tracker_id, checkout_session_id, payment_intent_id, transfer_id, refund_id, created_at)
       VALUES ($1, $2, $3, $4, 1000, 250, 'EUR', 'shipping', $5, $6, $7, $8, $9, $10, $11::timestamptz) RETURNING id`,
      [item.rows[0].id, seller.id, buyer.id, status, JSON.stringify({ name: "Private Person", line1: "Secret St 1" }),
        `trk_${nonce}`, `cs_${nonce}`, `pi_${nonce}`, `tr_${nonce}`, `re_${nonce}`, createdAt],
    );
    orderIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
    await client.query("DELETE FROM items WHERE seller_id = ANY($1::uuid[])", [accountIds]);
    await client.query("DELETE FROM sellers WHERE id = ANY($1::uuid[])", [accountIds]);
    await client.end();
  });

  it("returns only the caller's orders, filtered by role and status, newest first", async () => {
    const [alice, bob, outsider, empty] = await seedAccounts("a", "b", "c", "d");
    const sold = await seedOrder(alice, bob, "2026-01-01T00:00:00Z", "sold");
    const bought = await seedOrder(bob, alice, "2026-01-02T00:00:00Z");
    await seedOrder(bob, outsider, "2026-01-03T00:00:00Z");

    const ids = async (seller: SellerRow, args: Record<string, unknown> = {}) =>
      (await callMyOrders(seller, args)).body.orders.map((o) => o.id);

    expect(await ids(alice)).toEqual([bought, sold]);
    expect(await ids(alice, { role: "buyer" })).toEqual([bought]);
    expect(await ids(alice, { role: "seller" })).toEqual([sold]);
    expect(await ids(alice, { status: "sold" })).toEqual([sold]);
    expect(await ids(alice, { role: "buyer", status: "sold" })).toEqual([]);
    expect(await ids(empty)).toEqual([]);
  });

  it("returns the public shape without private fields, for buyer and seller", async () => {
    const [seller, buyer] = await seedAccounts("s", "b");
    await seedOrder(seller, buyer, "2026-02-01T00:00:00Z");
    for (const viewer of [seller, buyer]) {
      const { body } = await callMyOrders(viewer);
      expect(body.orders[0]).toMatchObject({ item_title: "Lamp", total_price_cents: 1250, status: "cancelled" });
      for (const field of [...NEVER_SELECTED, "buyer_id", "seller_id"]) expect(body.orders[0]).not.toHaveProperty(field);
      expect(JSON.stringify(body)).not.toContain("Secret St");
    }
  });

  it("pages stably across equal timestamps, microsecond gaps and new orders", async () => {
    const [seller, buyer] = await seedAccounts("s", "b");
    const oldest = await seedOrder(seller, buyer, "2026-03-01T00:00:00.000100Z");
    const tiedA = await seedOrder(seller, buyer, "2026-03-01T00:00:00.000200Z");
    const tiedB = await seedOrder(seller, buyer, "2026-03-01T00:00:00.000200Z");
    const newest = await seedOrder(seller, buyer, "2026-03-01T00:00:00.000300Z");

    const first = await callMyOrders(buyer, { limit: 2 });
    expect(first.body.next_cursor).not.toBeNull();
    // An order placed mid-pagination must not shift or repeat later pages.
    await seedOrder(seller, buyer, "2026-04-01T00:00:00Z");
    const second = await callMyOrders(buyer, { limit: 2, cursor: first.body.next_cursor });
    expect(second.body.next_cursor).toBeNull(); // exactly-full last page

    const paged = [...first.body.orders, ...second.body.orders].map((o) => o.id);
    expect(paged).toHaveLength(4);
    expect(new Set(paged)).toEqual(new Set([oldest, tiedA, tiedB, newest]));
    expect([paged[0], paged[3]]).toEqual([newest, oldest]);

    // Paging past the end with the caller's own order is empty, not an error.
    const pastEnd = await callMyOrders(buyer, { cursor: oldest });
    expect(pastEnd.isError).toBe(false);
    expect(pastEnd.body.count).toBe(0);
  });

  it("rejects another account's order id and unknown ids as a cursor identically", async () => {
    const [seller, buyer, outsider] = await seedAccounts("s", "b", "o");
    const foreign = await seedOrder(seller, buyer, "2026-06-01T00:00:00Z");
    await seedOrder(outsider, seller, "2026-05-01T00:00:00Z");

    const viaForeign = await callMyOrders(outsider, { cursor: foreign });
    expect(viaForeign.isError).toBe(true);
    expect(viaForeign.body.code).toBe("invalid_cursor");
    expect((await callMyOrders(outsider, { cursor: randomUUID() })).body).toEqual(viaForeign.body);
  });
});
