// Category taxonomy PR 1 (spec THI-734 / GH #218): registry resolution +
// two-level expansion plumbing. Covers the src/categories.ts helpers, the
// converging seed (D7), parent-aware search filters (D2), describe_category's
// tree output (D5), alias resolution + canonical echo on write paths (D4),
// and the intent matching closure (§5.6). DB-backed; skips when no Postgres
// is reachable. Test-only registry rows are prefixed thi734- and cleaned up
// in afterAll; seed-row mutations (sneakers/clothing parent, aliases) are
// converged back by re-applying schema.sql.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { ItemRow, SellerRow } from "../src/db.js";
import {
  categoryClosureForItem,
  categoryFilterNames,
  resolveCategory,
} from "../src/categories.js";
import { searchItems } from "../src/items.js";
import { evaluateListingForIntents } from "../src/intents.js";
import { registerTools } from "../src/tools.js";

delete process.env.EMBED_API_KEY; // keyword leg only — no embeddings API in CI

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

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

describe.skipIf(!available)("category taxonomy PR 1 (THI-734)", () => {
  let client: pg.Client;
  let seller: SellerRow;
  let buyer: SellerRow;
  let searchHandler!: (args: Record<string, unknown>) => Promise<unknown>;
  let describeHandler!: (args: Record<string, unknown>) => Promise<unknown>;
  let createHandler!: (args: Record<string, unknown>) => Promise<unknown>;
  let intentHandler!: (args: Record<string, unknown>) => Promise<unknown>;

  /** Parses a captured MCP tool result body. */
  function body(result: unknown): Record<string, unknown> {
    const r = result as { content: { text: string }[] };
    return JSON.parse(r.content[0].text) as Record<string, unknown>;
  }

  /** True when a captured MCP tool result is a typed error result. */
  function isErr(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("TRUNCATE intent_matches, buyer_intents, items, sellers RESTART IDENTITY CASCADE");
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES
        ('thg_734_a', 'cat-a', 'cat-a@t.dev'),
        ('thg_734_b', 'cat-b', 'cat-b@t.dev')`,
    );
    // Test tree (PR 1 ships plumbing only — content lands in PR 2, so the
    // parent/alias relationships are seeded here):
    //   thi734dept (department) ├─ sneakers (existing slug, alias: trainers)
    //                            ├─ clothing (existing slug)
    //                            └─ thi734leaf (new leaf)
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions, parent, aliases) VALUES
         ('thi734dept', 'PR1 test department', '[]', NULL, '{}')
       ON CONFLICT (name) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions, parent, aliases) VALUES
         ('thi734leaf', 'PR1 test leaf', '[]', 'thi734dept', '{}')
       ON CONFLICT (name) DO NOTHING`,
    );
    await client.query(
      `UPDATE categories SET parent = 'thi734dept', aliases = '{trainers}' WHERE name = 'sneakers'`,
    );
    await client.query(`UPDATE categories SET parent = 'thi734dept' WHERE name = 'clothing'`);
    // Feed-visible items: one dept-assigned, two leaf-assigned, one outside.
    let n = 0;
    const seedItem = async (category: string) => {
      n += 1;
      await client.query(
        `INSERT INTO items (seller_id, title, price_cents, category, images, status)
         SELECT id, $1, 1000, $2, ARRAY['https://img.example.com/cat.jpg'], 'active'
         FROM sellers WHERE email = 'cat-a@t.dev'`,
        [`PR1 item ${n}`, category],
      );
    };
    await seedItem("thi734dept");
    await seedItem("sneakers");
    await seedItem("clothing");
    await seedItem("books"); // sibling outside the department

    ({ rows: [seller] } = await client.query<SellerRow>(
      "SELECT id, display_name FROM sellers WHERE email = 'cat-a@t.dev'",
    ));
    ({ rows: [buyer] } = await client.query<SellerRow>(
      "SELECT id, display_name FROM sellers WHERE email = 'cat-b@t.dev'",
    ));

    registerTools(
      {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          if (name === "search_items") searchHandler = handler;
          if (name === "describe_category") describeHandler = handler;
          if (name === "create_listing") createHandler = handler;
          if (name === "save_intent") intentHandler = handler;
        },
      },
      { seller },
    );
  });

  afterAll(async () => {
    // Converge the 14 seed rows back (proves D7 in passing) and drop the
    // test-only rows; items/sellers truncate keeps other files' counts clean.
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("DELETE FROM categories WHERE name LIKE 'thi734%'");
    await client.query("TRUNCATE intent_matches, buyer_intents, items RESTART IDENTITY CASCADE");
    await client.end();
  });

  // --- resolution (D4) ----------------------------------------------------

  it("resolveCategory: exact name wins, case is normalized, aliases resolve, unknown is null", async () => {
    expect(await resolveCategory("sneakers")).toEqual({ canonical: "sneakers", viaAlias: false });
    expect(await resolveCategory("Sneakers")).toEqual({ canonical: "sneakers", viaAlias: false });
    expect(await resolveCategory("trainers")).toEqual({ canonical: "sneakers", viaAlias: true });
    expect(await resolveCategory("thi734nope")).toBeNull();
  });

  it("resolveCategory: an alias never shadows a canonical name (exact precedence)", async () => {
    // 'clothing' is canonical even though a sibling row could in principle
    // carry it as an alias (invariant: none does — exact match still wins by
    // construction in the ORDER BY, Security review N2).
    expect(await resolveCategory("clothing")).toEqual({ canonical: "clothing", viaAlias: false });
  });

  // --- expansion (D2) + closure (§5.6) -------------------------------------

  it("categoryFilterNames: department expands to dept + children (dept first), leaf to itself, unknown passes through", async () => {
    expect(await categoryFilterNames("thi734dept")).toEqual([
      "thi734dept",
      "clothing",
      "sneakers",
      "thi734leaf",
    ]);
    expect(await categoryFilterNames("sneakers")).toEqual(["sneakers"]);
    expect(await categoryFilterNames("other")).toEqual(["other"]);
    expect(await categoryFilterNames("thi734nope")).toEqual(["thi734nope"]);
  });

  it("categoryClosureForItem: leaf → leaf+parent, department-assigned → itself, parentless → itself", async () => {
    expect(await categoryClosureForItem("sneakers")).toEqual(["sneakers", "thi734dept"]);
    expect(await categoryClosureForItem("thi734dept")).toEqual(["thi734dept"]);
    expect(await categoryClosureForItem("other")).toEqual(["other"]);
  });

  // --- registry invariants (spec §5.2; asserted by tests, not triggers) ----

  it("registry invariants: parents exist, two levels max, aliases unique and never canonical, 'other' parentless", async () => {
    const { rows } = await client.query<{ name: string; parent: string | null; aliases: string[] }>(
      "SELECT name, parent, aliases FROM categories",
    );
    const names = new Set(rows.map((r) => r.name));
    const aliasOwners = new Map<string, string>();
    for (const row of rows) {
      if (row.parent !== null) {
        expect(names.has(row.parent)).toBe(true);
        const parent = rows.find((r) => r.name === row.parent);
        expect(parent?.parent ?? null).toBeNull(); // two-level invariant
      }
      for (const alias of row.aliases) {
        expect(names.has(alias)).toBe(false); // never shadows a canonical name
        expect(aliasOwners.has(alias)).toBe(false); // one alias → one canonical
        aliasOwners.set(alias, row.name);
        expect(alias).toBe(alias.toLowerCase());
      }
    }
    expect(rows.find((r) => r.name === "other")?.parent ?? null).toBeNull();
  });

  // --- search expansion (D2/D4) -------------------------------------------

  it("searchItems: department filter matches dept-assigned + children and excludes siblings; leaf excludes dept-assigned; alias resolves; unknown matches nothing", async () => {
    const titles = async (category: string) =>
      (await searchItems({ category, limit: 50 })).map((r) => r.title).sort();
    expect(await titles("thi734dept")).toEqual(["PR1 item 1", "PR1 item 2", "PR1 item 3"]);
    expect(await titles("sneakers")).toEqual(["PR1 item 2"]);
    expect(await titles("trainers")).toEqual(["PR1 item 2"]);
    expect(await titles("thi734nope")).toEqual([]);
  });

  it("search_items tool: unknown category → typed unknown_category with the available list", async () => {
    const result = await searchHandler({ category: "thi734nope" });
    expect(isErr(result)).toBe(true);
    const parsed = body(result) as { error: string; code: string };
    expect(parsed.code).toBe("unknown_category");
    expect(parsed.error).toContain("Available:");
    expect(parsed.error).toContain("sneakers");
  });

  // --- describe_category tree output (D5) ----------------------------------

  it("describe_category: no-arg rows carry parent (null for departments)", async () => {
    const parsed = body(await describeHandler({})) as {
      categories: { name: string; parent: string | null }[];
    };
    const dept = parsed.categories.find((c) => c.name === "thi734dept");
    const leaf = parsed.categories.find((c) => c.name === "sneakers");
    expect(dept?.parent).toBeNull();
    expect(leaf?.parent).toBe("thi734dept");
  });

  it("describe_category: department returns own row + children with listing counts", async () => {
    const parsed = body(await describeHandler({ category: "thi734dept" })) as {
      category: { name: string; parent: string | null };
      children: { name: string; listing_count: number }[];
      note: string;
    };
    expect(parsed.category.name).toBe("thi734dept");
    expect(parsed.category.parent).toBeNull();
    expect(parsed.children.map((c) => c.name)).toEqual(["clothing", "sneakers", "thi734leaf"]);
    expect(parsed.children.find((c) => c.name === "sneakers")?.listing_count).toBe(1);
    expect(parsed.note).toContain("department");
  });

  it("describe_category: leaf carries parent and no children field; alias resolves with a note", async () => {
    const leaf = body(await describeHandler({ category: "sneakers" })) as {
      category: { name: string; parent: string | null };
      children?: unknown;
    };
    expect(leaf.category.parent).toBe("thi734dept");
    expect(leaf.children).toBeUndefined();

    const alias = body(await describeHandler({ category: "trainers" })) as {
      category: { name: string };
      note: string;
    };
    expect(alias.category.name).toBe("sneakers");
    expect(alias.note).toContain("resolved to canonical slug 'sneakers'");
  });

  it("describe_category: unknown → unknown_category", async () => {
    const result = await describeHandler({ category: "thi734nope" });
    expect(isErr(result)).toBe(true);
    expect((body(result) as { code: string }).code).toBe("unknown_category");
  });

  // --- write paths: alias → canonical stored + echoed (D4) -----------------

  it("create_listing: alias stored as canonical slug, resolution echoed as note", async () => {
    const parsed = body(
      await createHandler({
        title: "PR1 alias create",
        category: "trainers",
        price_cents: 900,
        attributes: { size_eu: 43 },
      }),
    ) as { item: { category: string }; note?: string };
    expect(parsed.item.category).toBe("sneakers");
    expect(parsed.note).toContain("resolved to canonical slug 'sneakers'");
    // Canonical echo only — exact input keeps today's payload (no note).
    const exact = body(
      await createHandler({
        title: "PR1 exact create",
        category: "sneakers",
        price_cents: 900,
        attributes: { size_eu: 44 },
      }),
    ) as { item: { category: string }; note?: string };
    expect(exact.item.category).toBe("sneakers");
    expect(exact.note).toBeUndefined();
  });

  it("save_intent: alias resolved at save — intent stores the canonical slug", async () => {
    const parsed = body(await intentHandler({ category: "trainers" })) as {
      intent: { filters: { category?: string } };
      note: string;
    };
    expect(parsed.intent.filters.category).toBe("sneakers");
    expect(parsed.note).toContain("resolved to canonical slug 'sneakers'");
  });

  // --- intent matching closure (§5.6) ---------------------------------------

  it("department intent matches a child-leaf listing; leaf intent never matches a department-assigned listing", async () => {
    const { rows } = await client.query<ItemRow>(
      "SELECT * FROM items WHERE category IN ('sneakers', 'thi734dept') ORDER BY created_at",
    );
    // Full rows: the seller who owns them is cat-a; the buyer (cat-b) holds
    // the intent, so the not-your-own-listing guard passes.
    const deptItem = rows.find((i) => i.category === "thi734dept")!;
    const sneakersItem = rows.find((i) => i.category === "sneakers")!;

    await client.query(
      `INSERT INTO buyer_intents (buyer_id, category) VALUES ($1, 'thi734dept')`,
      [buyer.id],
    );
    expect(await evaluateListingForIntents(sneakersItem)).toBe(1);

    await client.query(`DELETE FROM buyer_intents WHERE buyer_id = $1`, [buyer.id]);
    await client.query(
      `INSERT INTO buyer_intents (buyer_id, category) VALUES ($1, 'sneakers')`,
      [buyer.id],
    );
    expect(await evaluateListingForIntents(deptItem)).toBe(0);
  });

  // --- converging seed (D7) --------------------------------------------------

  it("re-applying schema.sql converges hand-edited registry rows back to the seed", async () => {
    await client.query(`UPDATE categories SET description = 'hand edit' WHERE name = 'sneakers'`);
    await client.query(readFileSync(schemaPath, "utf8"));
    const { rows } = await client.query<{
      description: string;
      parent: string | null;
      aliases: string[];
    }>(
      "SELECT description, parent, aliases FROM categories WHERE name = 'sneakers'",
    );
    expect(rows[0].description).toBe("Trainers and sneakers"); // converged, not DO NOTHING
    expect(rows[0].parent).toBeNull(); // and back to the PR-1 seed state
    expect(rows[0].aliases).toEqual([]);
  });
});
