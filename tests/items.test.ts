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
import { undeclaredKeyUsage, updateItem } from "../src/items.js";

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
      `INSERT INTO sellers (api_key, display_name, email) VALUES
        ('thg_uk_a', 'uk-a', 'uk-a@t.dev'),
        ('thg_uk_b', 'uk-b', 'uk-b@t.dev'),
        ('thg_uk_c', 'uk-c', 'uk-c@t.dev')`,
    );
  });

  afterAll(async () => {
    await client.end();
  });

  let n = 0;
  /** One active item in `category` carrying `attrs`, owned by the seller with that email. */
  async function seedItem(
    sellerEmail: string,
    category: string,
    attrs: Record<string, unknown>,
    status = "active",
  ): Promise<void> {
    n += 1;
    await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status)
       SELECT id, $1, 1000, 100, $2, $3::jsonb, $4 FROM sellers WHERE email = $5`,
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
