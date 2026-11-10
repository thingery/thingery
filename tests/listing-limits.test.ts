// Per-seller listing velocity caps (docs/security.md §6 H4 fix 1, THI-113):
// MAX_LISTING_CREATES_PER_SELLER_PER_DAY / MAX_ACTIVE_LISTINGS_PER_SELLER,
// enforced in createItem before the embeddings call, surfaced from the MCP
// create_listing tool as code `rate_limited` and from the chat path with the
// same bare message.
//
// GH #212 / THI-542 (spec docs/specs/account-write-ramp.md) adds the
// new-account write ramp on top: sellers younger than NEW_SELLER_RAMP_DAYS
// write under 10 creates/day + 20 active until the account ages out — the
// regime is derived from sellers.created_at at call time, so tests fixture
// the age explicitly (SQL insert with a controlled created_at).
//
// Part 1 is pure: the error class contract. Part 2 is DB-backed (skipped when
// no Postgres is reachable): both caps, boundaries, delete-then-create, the
// rolling 24h window, MCP/chat parity, and the ramp regime + boundary. Unlike
// items.test.ts this file never TRUNCATEs — parallel CI workers share the
// database — it seeds only its own uniquely-emailed sellers and cleans up just
// those rows.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  MAX_ACTIVE_LISTINGS_PER_SELLER,
  MAX_LISTING_CREATES_PER_SELLER_PER_DAY,
  NEW_SELLER_MAX_ACTIVE_LISTINGS,
  NEW_SELLER_MAX_LISTING_CREATES_PER_DAY,
  NEW_SELLER_RAMP_DAYS,
  ListingLimitError,
  ShippingPriceError,
  createItem,
} from "../src/items.js";
import { executeTool } from "../src/chat.js";
import { registerTools } from "../src/tools.js";
import type { SellerRow } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// The two rejection messages, built from the exported constants — the error
// class must interpolate the same numbers (THI-543 Q2: no drift).
const fullCapMessage =
  `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
  `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`;
const rampMessage =
  `New-account limit reached (max ${NEW_SELLER_MAX_LISTING_CREATES_PER_DAY} creates/day, ` +
  `${NEW_SELLER_MAX_ACTIVE_LISTINGS} active during your first ${NEW_SELLER_RAMP_DAYS} days). ` +
  `Full limits unlock automatically after ${NEW_SELLER_RAMP_DAYS} days.`;

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

// ---------------------------------------------------------------------------
// Part 1 — error class contract (pure)

describe("ListingLimitError", () => {
  it("seller_cap class: Error with name, typed MCP code rate_limited, the exact THI-113 message", () => {
    const e = new ListingLimitError("seller_cap");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ListingLimitError");
    expect(e.code).toBe("rate_limited");
    expect(e.limit).toBe("seller_cap");
    expect(e.message).toBe(fullCapMessage);
  });

  it("new_seller_ramp class: same rate_limited code, message names the ramp and the 7-day unlock", () => {
    const e = new ListingLimitError("new_seller_ramp");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ListingLimitError");
    expect(e.code).toBe("rate_limited");
    expect(e.limit).toBe("new_seller_ramp");
    expect(e.message).toBe(rampMessage);
    expect(e.message).toContain(`Full limits unlock automatically after ${NEW_SELLER_RAMP_DAYS} days.`);
  });

  it("caps are the documented §6 H4 numbers", () => {
    expect(MAX_LISTING_CREATES_PER_SELLER_PER_DAY).toBe(100);
    expect(MAX_ACTIVE_LISTINGS_PER_SELLER).toBe(200);
  });

  it("ramp caps are the THI-543-confirmed numbers (Security owns tuning)", () => {
    expect(NEW_SELLER_RAMP_DAYS).toBe(7);
    expect(NEW_SELLER_MAX_LISTING_CREATES_PER_DAY).toBe(10);
    expect(NEW_SELLER_MAX_ACTIVE_LISTINGS).toBe(20);
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

  /** Fresh seller row, `ageHours` old (default 8 days: past the ramp, so the
   *  full-cap tests below keep pinning the 100/200 regime). Items rows are
   *  mine alone so counts can't be skewed by parallel test files. */
  async function seedSeller(email: string, ageHours = 8 * 24): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email, created_at)
       VALUES ($1, $2, $3, now() - ($4 * interval '1 hour')) RETURNING id, display_name`,
      [`thg_thi113_${email}`, email, email, ageHours],
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
// Part 2b — new-account write ramp (DB-backed, skips without Postgres)
// Spec docs/specs/account-write-ramp.md (GH #212 / THI-542): sellers younger
// than 7 days write under 10 creates/day + 20 active; the regime flips on
// sellers.created_at age, evaluated per call.

describe.skipIf(!available)("createItem new-seller write ramp (DB)", () => {
  let client: pg.Client;

  /** Seller row created exactly `ageHours` ago (spec's fixture note: explicit
   *  created_at via SQL — the regime is age-derived, nothing else controls it). */
  async function seedSeller(email: string, ageHours: number): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email, created_at)
       VALUES ($1, $2, $3, now() - ($4 * interval '1 hour')) RETURNING id, display_name`,
      [`thg_thi113_${email}`, email, email, ageHours],
    );
    return rows[0];
  }

  async function seedItems(sellerId: string, count: number, status: string, ageHours: number): Promise<void> {
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

  /** Parsed listing_write security-event lines captured by a console spy. */
  const listingWriteEvents = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((o) => o.type === "listing_write");

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-ramp-%@t.dev'`);
  });

  afterAll(async () => {
    await client.query(`DELETE FROM sellers WHERE email LIKE 'thi113-ramp-%@t.dev'`).catch(() => {});
    await client.end();
  });

  it("ramp: rejects the create past 10/day with the ramp message; inserts nothing", async () => {
    const seller = await seedSeller("thi113-ramp-vel@t.dev", 0);
    // 10 recent creates, status 'sold' — isolates the ramp velocity cap from
    // the ramp active cap (active count stays 0).
    await seedItems(seller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY, "sold", 0);
    await expect(createItem(input(seller.id))).rejects.toBeInstanceOf(ListingLimitError);
    const err = await createItem(input(seller.id)).catch((e: unknown) => e as ListingLimitError);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toBe(rampMessage);
    expect(await itemCount(seller.id)).toBe(NEW_SELLER_MAX_LISTING_CREATES_PER_DAY);
  });

  it("ramp: allows the 10th create in the window (boundary is >, not >=)", async () => {
    const seller = await seedSeller("thi113-ramp-vel-ok@t.dev", 0);
    await seedItems(seller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY - 1, "sold", 0);
    const item = await createItem(input(seller.id));
    expect(item.status).toBe("active");
    expect(await itemCount(seller.id)).toBe(NEW_SELLER_MAX_LISTING_CREATES_PER_DAY);
  });

  it("ramp: rejects at 20 active (backdated: velocity cap not involved)", async () => {
    const seller = await seedSeller("thi113-ramp-act@t.dev", 0);
    await seedItems(seller.id, NEW_SELLER_MAX_ACTIVE_LISTINGS, "active", 48);
    await expect(createItem(input(seller.id))).rejects.toBeInstanceOf(ListingLimitError);
    await expect(createItem(input(seller.id))).rejects.toThrow(
      /20 active during your first 7 days/,
    );
  });

  it("boundary: 6d 23h old seller is still ramped", async () => {
    const seller = await seedSeller("thi113-ramp-6d23h@t.dev", 6 * 24 + 23);
    await seedItems(seller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY, "sold", 0);
    await expect(createItem(input(seller.id))).rejects.toThrow(/New-account limit reached/);
  });

  it("boundary: 7d 1h old seller writes under the full caps (past both ramp numbers)", async () => {
    const seller = await seedSeller("thi113-ramp-7d1h@t.dev", 7 * 24 + 1);
    // Both ramp caps are at their limit — a ramped seller would reject either
    // way; a day-8 seller creates past 10/day and past 20 active.
    await seedItems(seller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY, "sold", 0);
    await seedItems(seller.id, NEW_SELLER_MAX_ACTIVE_LISTINGS, "active", 48);
    const item = await createItem(input(seller.id));
    expect(item.status).toBe("active");
    expect(await itemCount(seller.id)).toBe(
      NEW_SELLER_MAX_LISTING_CREATES_PER_DAY + NEW_SELLER_MAX_ACTIVE_LISTINGS + 1,
    );
  });

  it("security events: limit names the regime on both cap rejections, absent on validation rejections", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const rampedSeller = await seedSeller("thi113-ramp-ev@t.dev", 0);
      await seedItems(rampedSeller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY, "sold", 0);
      await expect(createItem(input(rampedSeller.id))).rejects.toBeInstanceOf(ListingLimitError);

      const agedSeller = await seedSeller("thi113-ramp-full-ev@t.dev", 8 * 24);
      await seedItems(agedSeller.id, MAX_ACTIVE_LISTINGS_PER_SELLER, "active", 48);
      await expect(createItem(input(agedSeller.id))).rejects.toBeInstanceOf(ListingLimitError);

      // Validation rejection (local tier cannot charge shipping) runs before
      // the cap checkpoint and must not carry a limit field.
      await expect(
        createItem({ ...input(rampedSeller.id), shipping_tier: "local", shipping_price_cents: 500 }),
      ).rejects.toBeInstanceOf(ShippingPriceError);

      const writes = listingWriteEvents(spy);
      expect(writes).toHaveLength(3);
      expect(writes[0]).toMatchObject({
        type: "listing_write",
        action: "create",
        outcome: "rejected",
        limit: "new_seller_ramp",
        sellerId: rampedSeller.id,
      });
      expect(writes[1]).toMatchObject({
        type: "listing_write",
        action: "create",
        outcome: "rejected",
        limit: "seller_cap",
        sellerId: agedSeller.id,
      });
      expect(writes[2]).toMatchObject({
        type: "listing_write",
        action: "create",
        outcome: "rejected",
        sellerId: rampedSeller.id,
      });
      expect("limit" in writes[2]).toBe(false);
    } finally {
      spy.mockRestore();
    }
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

  /** 8-day-old seller at the full active cap (the ramp must not apply). */
  async function sellerAtCap(email: string): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email, created_at)
       VALUES ($1, $2, $3, now() - interval '8 days') RETURNING id, display_name`,
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

  /** Day-0 seller at the ramp velocity cap (10 creates in the window). */
  async function sellerAtRampCap(email: string): Promise<SellerRow> {
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ($1, $2, $3) RETURNING id, display_name`,
      [`thg_thi113_${email}`, email, email],
    );
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, category, status, created_at)
       SELECT $1, 'seed', 100, 'other', 'sold', now()
       FROM generate_series(1, $2)`,
      [rows[0].id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY],
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
    expect(body.error).toBe(fullCapMessage);
  });

  it("MCP create_listing: ramp rejection returns the same rate_limited code with the ramp message", async () => {
    const seller = await sellerAtRampCap("thi113-surf-ramp@t.dev");
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
    expect(body.error).toBe(rampMessage);
  });

  it("chat executeTool throws ListingLimitError with the identical message (chatTurn renders { error })", async () => {
    const seller = await sellerAtCap("thi113-surf-chat@t.dev");
    const e = await executeTool("create_listing", { ...validArgs }, seller).catch(
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ListingLimitError);
    // chatTurn's catch turns any thrown Error into { error: e.message } — the
    // MCP body above must match it byte for byte (no prefix divergence).
    expect((e as ListingLimitError).message).toBe(fullCapMessage);
    expect((e as ListingLimitError).code).toBe("rate_limited");
    expect((e as ListingLimitError).limit).toBe("seller_cap");
  });
});
