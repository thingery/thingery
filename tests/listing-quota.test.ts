// listing_quota: the remaining-creates read on create_listing and my_listings,
// derived by listingQuota() from the same counts createItem's caps use (GH
// #212 ramp included). DB-backed; skipped when no Postgres is reachable.
// Seeds only its own uniquely-emailed sellers and removes just those rows.

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, type SellerRow } from "../src/db.js";
import {
  MAX_ACTIVE_LISTINGS_PER_SELLER,
  MAX_LISTING_CREATES_PER_SELLER_PER_DAY,
  NEW_SELLER_MAX_ACTIVE_LISTINGS,
  NEW_SELLER_MAX_LISTING_CREATES_PER_DAY,
  NEW_SELLER_RAMP_DAYS,
  createItem,
  ListingLimitError,
  listingQuota,
} from "../src/items.js";
import { registerTools } from "../src/tools.js";

delete process.env.EMBED_API_KEY;

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function tools(seller: SellerRow): Map<string, { description?: string; handler: Handler }> {
  const registered = new Map<string, { description?: string; handler: Handler }>();
  registerTools(
    {
      registerTool(name: string, config: { description?: string }, handler: Handler) {
        registered.set(name, { description: config.description, handler });
      },
    },
    { seller },
  );
  return registered;
}

async function call(seller: SellerRow, name: string, args: Record<string, unknown>) {
  const result = await tools(seller).get(name)!.handler(args);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const createArgs = {
  title: "Quota test lamp",
  category: "other",
  condition: "good",
  price_cents: 1000,
  currency: "EUR",
  shipping_tier: "unknown",
  images: [],
  attributes: {},
};

describe.skipIf(!available)("listing_quota (DB)", () => {
  let client: pg.Client;
  let counter = 0;

  async function seedSeller(ageHours: number): Promise<SellerRow & { created_at: Date }> {
    const email = `listing-quota-${process.pid}-${++counter}@t.dev`;
    const { rows } = await client.query<SellerRow & { created_at: Date }>(
      `INSERT INTO sellers (api_key_hash, display_name, email, created_at)
       VALUES ($1, $2, $3, now() - ($4 * interval '1 hour')) RETURNING id, display_name, created_at`,
      [`thg_quota_${email}`, email, email, ageHours],
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

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(`DELETE FROM sellers WHERE email LIKE 'listing-quota-%@t.dev'`);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await client.query(
      `DELETE FROM items WHERE seller_id IN (SELECT id FROM sellers WHERE email LIKE 'listing-quota-%@t.dev')`,
    );
    await client.query(`DELETE FROM sellers WHERE email LIKE 'listing-quota-%@t.dev'`);
    await client.end();
  });

  it("a brand-new account gets the ramp limits and the date they lift", async () => {
    const seller = await seedSeller(0);
    const quota = await listingQuota(seller.id);
    expect(quota).toMatchObject({
      remaining: NEW_SELLER_MAX_LISTING_CREATES_PER_DAY,
      daily_limit: NEW_SELLER_MAX_LISTING_CREATES_PER_DAY,
      created_last_24h: 0,
      active_limit: NEW_SELLER_MAX_ACTIVE_LISTINGS,
      active: 0,
      new_account_ramp: true,
    });
    expect(quota.full_limits_at?.getTime()).toBe(seller.created_at.getTime() + NEW_SELLER_RAMP_DAYS * DAY_MS);
  });

  it("counts every create in the rolling 24 hours, deleted ones included", async () => {
    const seller = await seedSeller(0);
    await seedItems(seller.id, 2, "deleted", 1);
    await seedItems(seller.id, 1, "sold", 1);
    await seedItems(seller.id, 4, "sold", 25); // outside the window
    const quota = await listingQuota(seller.id);
    expect(quota.created_last_24h).toBe(3);
    expect(quota.remaining).toBe(NEW_SELLER_MAX_LISTING_CREATES_PER_DAY - 3);
  });

  it("remaining is capped by the active limit when that is tighter", async () => {
    const seller = await seedSeller(0);
    await seedItems(seller.id, NEW_SELLER_MAX_ACTIVE_LISTINGS - 1, "active", 48);
    const quota = await listingQuota(seller.id);
    expect(quota.created_last_24h).toBe(0);
    expect(quota.remaining).toBe(1);
  });

  it("an account past the ramp gets the full limits and no unlock date", async () => {
    const seller = await seedSeller(NEW_SELLER_RAMP_DAYS * 24 + 1);
    await seedItems(seller.id, 5, "active", 1);
    expect(await listingQuota(seller.id)).toEqual({
      remaining: MAX_LISTING_CREATES_PER_SELLER_PER_DAY - 5,
      daily_limit: MAX_LISTING_CREATES_PER_SELLER_PER_DAY,
      created_last_24h: 5,
      active_limit: MAX_ACTIVE_LISTINGS_PER_SELLER,
      active: 5,
      new_account_ramp: false,
      full_limits_at: null,
    });
  });

  it("remaining 0 is exactly when createItem rejects", async () => {
    const seller = await seedSeller(0);
    await seedItems(seller.id, NEW_SELLER_MAX_LISTING_CREATES_PER_DAY - 1, "sold", 1);
    expect((await listingQuota(seller.id)).remaining).toBe(1);
    await createItem({ seller_id: seller.id, ...createArgs, description: "" });
    expect((await listingQuota(seller.id)).remaining).toBe(0);
    await expect(createItem({ seller_id: seller.id, ...createArgs, description: "" })).rejects.toBeInstanceOf(
      ListingLimitError,
    );
  });

  it("create_listing returns the quota left after the create", async () => {
    const seller = await seedSeller(0);
    const body = await call(seller, "create_listing", createArgs);
    expect(body.created).toBe(true);
    expect(body.listing_quota).toMatchObject({
      remaining: NEW_SELLER_MAX_LISTING_CREATES_PER_DAY - 1,
      created_last_24h: 1,
      active: 1,
      new_account_ramp: true,
    });
    expect(typeof body.listing_quota.full_limits_at).toBe("string");
  });

  it("a failed quota read after the create still reports the create", async () => {
    const seller = await seedSeller(0);
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let quotaReads = 0;
    vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).includes("AS creates_24h") && ++quotaReads === 2) {
        return Promise.reject(new Error("quota read down"));
      }
      return query(...args);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await call(seller, "create_listing", createArgs);
    expect(body.created).toBe(true);
    expect(body).not.toHaveProperty("listing_quota");
  });

  it("my_listings carries the quota as a lightweight read", async () => {
    const seller = await seedSeller(0);
    await seedItems(seller.id, 2, "active", 1);
    const body = await call(seller, "my_listings", { limit: 1 });
    expect(body.count).toBe(1);
    expect(body.listing_quota).toMatchObject({ remaining: NEW_SELLER_MAX_LISTING_CREATES_PER_DAY - 2, active: 2 });
  });

  it("both tools document listing_quota", async () => {
    const seller = await seedSeller(0);
    for (const name of ["create_listing", "my_listings"]) {
      expect(tools(seller).get(name)!.description).toContain("listing_quota.remaining");
    }
  });
});
