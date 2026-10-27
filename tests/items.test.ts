// Attribute write caps on the update path + undeclaredKeyUsage() helper
// (spec THI-83 rev a95419b1 §3.3/§3.5, PR 1).
// Part 1 is pure: updateItem() throws AttributeValidationError before any
// query runs. Part 2 is DB-backed (skipped when no Postgres is reachable):
// thresholds, status/junk-key filtering, sort, cap, the declaredKeys array
// contract, and the pool statement_timeout.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { AttributeValidationError } from "../src/attributes.js";
import { pool } from "../src/db.js";
import { listCategories, myItems, searchItems, undeclaredKeyUsage, updateItem } from "../src/items.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

// ---------------------------------------------------------------------------
// Part 1 — update-path enforcement (pure: the throw happens before pool.query)

describe("updateItem attribute shape caps", () => {
  it("throws AttributeValidationError (code invalid_attributes) on an over-long string value", async () => {
    await expect(
      updateItem("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", {
        attributes: { colorway: "x".repeat(501) },
      }),
    ).rejects.toBeInstanceOf(AttributeValidationError);
  });

  it("carries the joined messages and the MCP error code", async () => {
    const err = await updateItem("i", "s", {
      attributes: { k: "x".repeat(501), ["k".repeat(129)]: "v" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeValidationError);
    expect((err as AttributeValidationError).code).toBe("invalid_attributes");
    expect((err as AttributeValidationError).message).toContain("value too long");
    expect((err as AttributeValidationError).message).toContain("key too long");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed (skips without a reachable Postgres)

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    connectionTimeoutMillis: 1500,
  });
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

describe.skipIf(!available)("undeclaredKeyUsage (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    // Fresh state per run, same convention as orders.test.ts.
    await client.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
    // Three sellers (a, b, c) — enough to cross the 2-seller threshold.
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES
        ('thg_uk_a', 'uk-a', 'uk-a@t.dev'),
        ('thg_uk_b', 'uk-b', 'uk-b@t.dev'),
        ('thg_uk_c', 'uk-c', 'uk-c@t.dev')`,
    );
  });

  afterAll(async () => {
    await client.end();
  });

  let n = 0;
  /** One active item in `category` carrying `attrs`, owned by the seller with
   *  that email. Carries one image so the THI-308 photo gate keeps it
   *  feed-visible — these tests are about key thresholds, not visibility. */
  async function seedItem(
    sellerEmail: string,
    category: string,
    attrs: Record<string, unknown>,
    status = "active",
  ): Promise<void> {
    n += 1;
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, images, attributes, status)
       SELECT id, $1, 1000, 100, $2, ARRAY['https://img.example.com/seed.jpg'], $3::jsonb, $4 FROM sellers WHERE email = $5`,
      [`UK item ${n}`, category, JSON.stringify(attrs), status, sellerEmail],
    );
  }

  const CAT = "thi83uk-main";

  beforeAll(async () => {
    // Thresholds: 2 sellers × 2 items qualifies; 1 seller × 2 items and
    // 1 item alone do not.
    await seedItem("uk-a@t.dev", CAT, { shared_key: 1 });
    await seedItem("uk-b@t.dev", CAT, { shared_key: 2 });
    await seedItem("uk-a@t.dev", CAT, { solo_seller: 1 });
    await seedItem("uk-a@t.dev", CAT, { solo_seller: 2 });
    await seedItem("uk-a@t.dev", CAT, { single_item: 1 });
    // Declared keys are only excluded when actually declared (tested below).
    await seedItem("uk-a@t.dev", CAT, { declared_key: "x" });
    await seedItem("uk-b@t.dev", CAT, { declared_key: "y" });
    // Non-active statuses never count: both items reserved/sold, one deleted.
    await seedItem("uk-a@t.dev", CAT, { status_key: 1 }, "reserved");
    await seedItem("uk-b@t.dev", CAT, { status_key: 2 }, "sold");
    await seedItem("uk-c@t.dev", CAT, { status_key: 3 }, "deleted");
    // Junk keys: each crosses both thresholds, so exclusion is purely the
    // hygiene regex (space, punctuation, 100 chars, 65 chars).
    for (const key of ["has space", "punct!", "a".repeat(100), "b".repeat(65)]) {
      await seedItem("uk-a@t.dev", CAT, { [key]: 1 });
      await seedItem("uk-b@t.dev", CAT, { [key]: 1 });
    }
  });

  it("returns only qualifying keys with items/seller thresholds applied", async () => {
    const rows = await undeclaredKeyUsage(CAT, ["declared_key"]);
    const shared = rows.find((r) => r.key === "shared_key");
    expect(shared).toEqual({ key: "shared_key", items: 2, sellers: 2 });
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("solo_seller"); // 1 seller × 2 items
    expect(keys).not.toContain("single_item"); // 1 item
    expect(keys).not.toContain("status_key"); // reserved/sold/deleted
    expect(keys).not.toContain("has space");
    expect(keys).not.toContain("punct!");
    expect(keys).not.toContain("a".repeat(100));
    expect(keys).not.toContain("b".repeat(65));
  });

  it("declaredKeys is always an array: default [] and explicit [] surface every qualifying key", async () => {
    // Pins the contract — a null/undefined array silently declaring nothing.
    const byDefault = await undeclaredKeyUsage(CAT);
    const byEmpty = await undeclaredKeyUsage(CAT, []);
    expect(byDefault.map((r) => r.key)).toContain("declared_key");
    expect(byEmpty.map((r) => r.key)).toContain("declared_key");
    expect(byEmpty).toEqual(byDefault);
  });

  it("never returns keys passed in declaredKeys", async () => {
    const rows = await undeclaredKeyUsage(CAT, ["declared_key", "shared_key"]);
    expect(rows.map((r) => r.key)).not.toContain("declared_key");
    expect(rows.map((r) => r.key)).not.toContain("shared_key");
  });

  it("sorts by items desc then key asc", async () => {
    const cat = "thi83uk-sort";
    // aaa: 4 items (2 sellers × 2) → first; mmm/zzz tie at 2 → key asc.
    await seedItem("uk-a@t.dev", cat, { aaa_sort: 1 });
    await seedItem("uk-a@t.dev", cat, { aaa_sort: 2 });
    await seedItem("uk-b@t.dev", cat, { aaa_sort: 3 });
    await seedItem("uk-b@t.dev", cat, { aaa_sort: 4 });
    await seedItem("uk-a@t.dev", cat, { zzz_sort: 1 });
    await seedItem("uk-b@t.dev", cat, { zzz_sort: 2 });
    await seedItem("uk-a@t.dev", cat, { mmm_sort: 1 });
    await seedItem("uk-b@t.dev", cat, { mmm_sort: 2 });
    const rows = await undeclaredKeyUsage(cat);
    expect(rows).toEqual([
      { key: "aaa_sort", items: 4, sellers: 2 },
      { key: "mmm_sort", items: 2, sellers: 2 },
      { key: "zzz_sort", items: 2, sellers: 2 },
    ]);
  });

  it("caps the result at 20 rows (ties broken by key asc)", async () => {
    const cat = "thi83uk-cap";
    const attrs = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`k${String(i + 1).padStart(2, "0")}`, i]),
    );
    await seedItem("uk-a@t.dev", cat, attrs);
    await seedItem("uk-b@t.dev", cat, attrs);
    const rows = await undeclaredKeyUsage(cat);
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("returns [] for a category with no qualifying keys", async () => {
    await seedItem("uk-a@t.dev", "thi83uk-clean", { lonely: 1 });
    expect(await undeclaredKeyUsage("thi83uk-clean")).toEqual([]);
  });
});

describe.skipIf(!available)("runtime pool statement timeout (THI-83 §3.5)", () => {
  it("caps statements at 3000ms", async () => {
    const { rows } = await pool.query<{ statement_timeout: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout",
    );
    // Postgres may render the GUC as "3000", "3000ms" or "3s" depending on
    // version — normalize to milliseconds.
    const raw = rows[0].statement_timeout;
    const m = raw.match(/^(\d+)(ms|s|min)?$/);
    expect(m).toBeTruthy();
    const unit = m![2] === "s" ? 1000 : m![2] === "min" ? 60_000 : 1;
    expect(Number(m![1]) * unit).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — photo-gated listing visibility (THI-308 spec rev 2, PR 1).
// The derived predicate `status='active' AND (NOT photo_required OR
// cardinality(images) > 0)` must hide pending zero-photo items from every
// feed surface (searchItems, listCategories counts, undeclaredKeyUsage)
// while grandfathered (photo_required=false) and photo-having items stay
// visible, and getItem/myItems-style direct access stays unfiltered.

describe.skipIf(!available)("photo-gated listing visibility (THI-308 PR 1)", () => {
  let client: pg.Client;
  // ids filled by beforeAll; typed record so each lookup below is checked.
  const seeded: Record<"pendingA" | "pendingB" | "grandfathered" | "photoA" | "photoC", string> =
    {} as Record<"pendingA" | "pendingB" | "grandfathered" | "photoA" | "photoC", string>;

  /** Insert one item. `photoRequired` omitted → the INSERT does not name
   *  the column, so pending seeds pin the post-rollout schema default
   *  (photo_required = true); `false` simulates a grandfathered row. */
  async function seedItem(opts: {
    sellerEmail: string;
    images?: string[];
    photoRequired?: false;
    attributes?: Record<string, unknown>;
  }): Promise<string> {
    const base = [
      `PG item ${Math.random().toString(36).slice(2, 8)}`,
      "thi308-pg",
      opts.images ?? [],
      JSON.stringify(opts.attributes ?? {}),
    ];
    const { rows } =
      opts.photoRequired === undefined
        ? await client.query<{ id: string }>(
            `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, images, attributes)
             SELECT id, $1, 1000, 100, $2, $3::text[], $4::jsonb FROM sellers WHERE email = $5
             RETURNING id`,
            [...base, opts.sellerEmail],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, images, attributes, photo_required)
             SELECT id, $1, 1000, 100, $2, $3::text[], $4::jsonb, $5 FROM sellers WHERE email = $6
             RETURNING id`,
            [...base, opts.photoRequired, opts.sellerEmail],
          );
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
    // Re-apply schema.sql: doubles as the re-run/idempotency check for the
    // THI-308 ALTER block (NULL-guarded backfill is a no-op on re-apply).
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
    // listCategories reads the registry table, so the test category must
    // exist there for its counts to surface at all.
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions)
       VALUES ('thi308-pg', 'THI-308 photo-gate test category', '[]')
       ON CONFLICT (name) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES
        ('thg_pg_a', 'pg-a', 'pg-a@t.dev'),
        ('thg_pg_b', 'pg-b', 'pg-b@t.dev'),
        ('thg_pg_c', 'pg-c', 'pg-c@t.dev')`,
    );
    // Pending (default photo_required=true, zero photos) — hidden from feeds.
    seeded.pendingA = await seedItem({ sellerEmail: "pg-a@t.dev", attributes: { pending_only_key: 1 } });
    seeded.pendingB = await seedItem({ sellerEmail: "pg-b@t.dev", attributes: { pending_only_key: 2 } });
    // Grandfathered zero-photo item (photo_required=false) — stays live.
    seeded.grandfathered = await seedItem({ sellerEmail: "pg-a@t.dev", photoRequired: false });
    // Photo-having items (external URL members count) — live.
    seeded.photoA = await seedItem({
      sellerEmail: "pg-a@t.dev",
      images: ["https://img.example.com/a.jpg"],
      attributes: { visible_key: "a" },
    });
    seeded.photoC = await seedItem({
      sellerEmail: "pg-c@t.dev",
      images: ["https://img.example.com/c.jpg"],
      attributes: { visible_key: "c" },
    });
  });

  afterAll(async () => {
    await client.end();
  });

  it("searchItems hides pending zero-photo items, keeps grandfathered and photo-having ones", async () => {
    const rows = await searchItems({ category: "thi308-pg", limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(seeded.pendingA);
    expect(ids).not.toContain(seeded.pendingB);
    expect(ids).toContain(seeded.grandfathered);
    expect(ids).toContain(seeded.photoA);
    expect(ids).toContain(seeded.photoC);
    // The predicate is derived: rows still carry the flag for callers.
    const grand = rows.find((r) => r.id === seeded.grandfathered);
    expect(grand?.photo_required).toBe(false);
    const photo = rows.find((r) => r.id === seeded.photoA);
    expect(photo?.photo_required).toBe(true);
  });

  it("listCategories counts exclude pending items", async () => {
    const cats = await listCategories();
    const cat = cats.find((c) => c.name === "thi308-pg");
    expect(cat?.listing_count).toBe(3); // grandfathered + two photo-having
  });

  it("undeclaredKeyUsage never surfaces pending items' attributes (F2)", async () => {
    const rows = await undeclaredKeyUsage("thi308-pg");
    // pending_only_key sits on 2 pending items from 2 sellers — it would
    // qualify on thresholds alone; visibility must exclude it.
    expect(rows.map((r) => r.key)).not.toContain("pending_only_key");
    // Control: the same key shape on visible items still surfaces.
    expect(rows.find((r) => r.key === "visible_key")).toEqual({
      key: "visible_key",
      items: 2,
      sellers: 2,
    });
  });

  it("myItems still returns the owner's pending items", async () => {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM sellers WHERE email = 'pg-a@t.dev'`);
    const mine = await myItems(rows[0].id, undefined, 100);
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(seeded.pendingA);
    expect(ids).toContain(seeded.grandfathered);
    expect(ids).toContain(seeded.photoA);
  });
});
