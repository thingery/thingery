// Per-seller listing velocity caps (docs/security.md §6 H4 fix 1, THI-113):
// MAX_LISTING_CREATES_PER_SELLER_PER_DAY / MAX_ACTIVE_LISTINGS_PER_SELLER,
// enforced in createItem before the embeddings call, surfaced from the MCP
// create_listing tool as code `rate_limited` and from the chat path with the
// same bare message.
//
// Part 1 is pure: the error class contract. Part 2 is DB-backed (skipped when
// no Postgres is reachable): both caps, boundaries, delete-then-create, the
// rolling 24h window, and MCP/chat parity. Unlike items.test.ts this file
// never TRUNCATEs — parallel CI workers share the database — it seeds only
// its own uniquely-emailed sellers and cleans up just those rows.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  MAX_ACTIVE_LISTINGS_PER_SELLER,
  MAX_LISTING_CREATES_PER_SELLER_PER_DAY,
  ListingLimitError,
  createItem,
} from "../src/items.js";
import { executeTool } from "../src/chat.js";
import { registerTools } from "../src/tools.js";
import type { SellerRow } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// ---------------------------------------------------------------------------
// Part 1 — error class contract (pure)

describe("ListingLimitError", () => {
  it("is an Error with name, typed MCP code rate_limited, and the exact support message", () => {
    const e = new ListingLimitError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ListingLimitError");
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe(
      `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
        `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`,
    );
  });

  it("caps are the documented §6 H4 numbers", () => {
    expect(MAX_LISTING_CREATES_PER_SELLER_PER_DAY).toBe(100);
    expect(MAX_ACTIVE_LISTINGS_PER_SELLER).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — enforcement (DB-backed, skips without a reachable Postgres)

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

describe.skipIf(!available)("createItem velocity caps (DB)", () => {
  let client: pg.Client;

  /** Minimal valid create payload for `sellerId`. */
  const input = (sellerId: string) => ({
    seller_id: sellerId,
    title: "THI-113 test item",
    description: "velocity cap test",
    category: "other",
    condition: "good" as const,
    price_cents: 1000,
    currency: "EUR",
    shipping_tier: "unknown" as const,
    images: [],
    attributes: {},
  });

  /** Fresh seller row; items rows are mine alone so counts can't be skewed
   *  by parallel test files. */
  async function seedSeller(email: string): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ($1, $2, $3) RETURNING id, display_name`,
      [`thg_thi113_${email}`, email, email],
    );
    return rows[0];
  }

  /** Bulk-seed `count` items for `sellerId` with the given status and age. */
  async function seedItems(
    sellerId: string,
    count: number,
    status: string,
    ageHours: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, category, status, created_at)
       SELECT $1, 'seed', 100, 'other', $2, now() - ($3 * interval '1 hour')
       FROM generate_series(1, $4)`,
      [sellerId, status, ageHours, count],
    );
  }

  async function itemCount(sellerId: string): Promise<number> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM items WHERE seller_id = $1`,
      [sellerId],
    );
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    // Only my own rows from a previous run (CASCADE takes the items with it).
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-%@t.dev'`);
  });

  afterAll(async () => {
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-%@t.dev'`).catch(() => {});
    await client.end();
  });

  it("rejects the 101st create in the 24h window and inserts nothing", async () => {
    const seller = await seedSeller("thi113-vel@t.dev");
    // 100 recent creates, status 'sold' — isolates the velocity cap from the
    // active cap (active count stays 0).
    await seedItems(seller.id, MAX_LISTING_CREATES_PER_SELLER_PER_DAY, "sold", 0);
    await expect(createItem(input(seller.id))).rejects.toBeInstanceOf(ListingLimitError);
    await expect(createItem(input(seller.id))).rejects.toThrow(/max 100 creates\/day/);
    expect(await itemCount(seller.id)).toBe(MAX_LISTING_CREATES_PER_SELLER_PER_DAY);
  });

  it("allows the 100th create in the window (boundary is >, not >=)", async () => {
    const seller = await seedSeller("thi113-vel-ok@t.dev");
    await seedItems(seller.id, MAX_LISTING_CREATES_PER_SELLER_PER_DAY - 1, "sold", 0);
    const item = await createItem(input(seller.id));
    expect(item.seller_id).toBe(seller.id);
    expect(item.status).toBe("active");
    expect(await itemCount(seller.id)).toBe(MAX_LISTING_CREATES_PER_SELLER_PER_DAY);
  });

  it("rejects the 201st active listing (backdated: velocity cap not involved)", async () => {
    const seller = await seedSeller("thi113-act@t.dev");
    await seedItems(seller.id, MAX_ACTIVE_LISTINGS_PER_SELLER, "active", 48);
    await expect(createItem(input(seller.id))).rejects.toBeInstanceOf(ListingLimitError);
    await expect(createItem(input(seller.id))).rejects.toThrow(/200 active/);
  });

  it("delete-then-create stays under the active cap", async () => {
    const seller = await seedSeller("thi113-act-del@t.dev");
    await seedItems(seller.id, MAX_ACTIVE_LISTINGS_PER_SELLER, "active", 48);
    // Soft-delete one listing: status 'deleted' no longer counts as active.
    await client.query(
      `UPDATE items SET status = 'deleted' WHERE seller_id = $1
       AND id = (SELECT id FROM items WHERE seller_id = $1 LIMIT 1)`,
      [seller.id],
    );
    const item = await createItem(input(seller.id));
    expect(item.status).toBe("active");
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM items WHERE seller_id = $1 AND status = 'active'`,
      [seller.id],
    );
    expect(Number(rows[0].n)).toBe(MAX_ACTIVE_LISTINGS_PER_SELLER);
  });

  it("creates older than 24h fall out of the rolling velocity window", async () => {
    const seller = await seedSeller("thi113-window@t.dev");
    // 150 old items, none active (reserved) — over both caps numerically,
    // under both after the window/status filters.
    await seedItems(seller.id, 150, "reserved", 48);
    const item = await createItem(input(seller.id));
    expect(item.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Part 3 — surface parity: MCP typed error + chat message (DB-backed)

describe.skipIf(!available)("listing limit error surfaces (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-surf-%@t.dev'`);
  });

  afterAll(async () => {
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-surf-%@t.dev'`).catch(() => {});
    await client.end();
  });

  async function sellerAtCap(email: string): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ($1, $2, $3) RETURNING id, display_name`,
      [`thg_thi113_${email}`, email, email],
    );
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, category, status, created_at)
       SELECT $1, 'seed', 100, 'other', 'active', now() - interval '48 hours'
       FROM generate_series(1, $2)`,
      [rows[0].id, MAX_ACTIVE_LISTINGS_PER_SELLER],
    );
    return rows[0];
  }

  const validArgs = {
    title: "THI-113 surface test item",
    category: "other",
    condition: "good",
    price_cents: 1000,
    currency: "EUR",
    shipping_tier: "unknown",
    images: [],
    attributes: {},
  };

  it("MCP create_listing returns the typed rate_limited code with the bare message", async () => {
    const seller = await sellerAtCap("thi113-surf-mcp@t.dev");
    const registered = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >();
    registerTools(
      {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          registered.set(name, handler);
        },
      },
      { seller },
    );
    const handler = registered.get("create_listing");
    expect(handler).toBeDefined();

    const result = (await handler!(validArgs)) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    expect(result.isError).toBe(true);
    const body = result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null;
    expect(body.code).toBe("rate_limited");
    expect(body.error).toBe(
      `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
        `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`,
    );
  });

  it("chat executeTool throws ListingLimitError with the identical message (chatTurn renders { error })", async () => {
    const seller = await sellerAtCap("thi113-surf-chat@t.dev");
    const e = await executeTool("create_listing", { ...validArgs }, seller).catch(
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ListingLimitError);
    // chatTurn's catch turns any thrown Error into { error: e.message } — the
    // MCP body above must match it byte for byte (no prefix divergence).
    expect((e as ListingLimitError).message).toBe(
      `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
        `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`,
    );
  });
});
