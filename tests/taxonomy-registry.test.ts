// Registry-content tests — taxonomy PR 2 (spec THI-734 §5.1–5.3, task THI-736).
// Asserts the seeded registry itself, not the code paths around it (those are
// PR 1's tests): tree shape (8 parentless rows — 7 departments + 'other' —
// over 21 leaves), the two-level invariant, all 14 legacy slugs surviving,
// the §5.3 alias seeds and alias invariants, facet attribute definitions
// (department enum on fashion rows, size_letter on clothing) with legacy
// definitions intact, and D7 convergence (DO UPDATE): a hand-diverged row and
// a slug-colliding local row are restored by re-applying schema.sql, while
// created_at is never touched. Skips when no Postgres is reachable so bare
// `npm test` stays green locally (same convention as tests/schema.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { validateAttributes } from "../src/attributes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

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

// Spec §5.1: department → direct children. 'other' is parentless AND childless.
const TREE: Record<string, string[]> = {
  fashion: ["accessories", "bags", "beauty", "clothing", "shoes", "sneakers"],
  kids: ["baby", "kids-clothing", "toys"],
  electronics: ["cameras", "computers", "games", "phones"],
  home: ["pets", "tools"],
  media: ["books", "music"],
  hobbies: ["board-games", "collectibles", "instruments"],
  sports: ["bikes"],
  other: [],
};

// The 14 legacy slugs (pre-taxonomy registry) — all must survive (D3).
const LEGACY_14 = [
  "sneakers", "shoes", "clothing", "electronics", "phones", "computers",
  "games", "books", "music", "sports", "home", "toys", "collectibles", "other",
];

// Spec §5.3 alias seed. Exact — no other row carries any alias.
const ALIASES: Record<string, string[]> = {
  sneakers: ["trainers"],
  baby: ["stroller", "pram"],
  accessories: ["jewelry"],
  phones: ["smartphone"],
  computers: ["laptop"],
  music: ["vinyl", "records"],
};

interface RegistryRow {
  name: string;
  description: string;
  parent: string | null;
  aliases: string[];
  attribute_definitions: Array<{ key: string; type: string; required?: boolean; enum?: string[] }>;
}

describe.skipIf(!available)("taxonomy registry content (THI-734 §5.1–5.3)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function registry(): Promise<RegistryRow[]> {
    const { rows } = await client.query<RegistryRow>(
      `SELECT name, description, parent, aliases, attribute_definitions FROM categories ORDER BY name`,
    );
    return rows;
  }

  it("applies fresh against an empty categories table (departments-first FK ordering)", async () => {
    // Hermetic fresh apply, atomic for concurrent DB users (schema.test.ts
    // convention): no table references categories (items.category is plain
    // TEXT), so the drop is safe. A fresh apply only succeeds if every
    // department row precedes its leaves inside the single INSERT…SELECT.
    await client.query("BEGIN");
    try {
      await client.query(`DROP TABLE IF EXISTS categories CASCADE`);
      await client.query(readFileSync(schemaPath, "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  it("seeds 29 rows: 8 parentless (7 departments + other) over 21 leaves", async () => {
    const rows = await registry();
    expect(rows).toHaveLength(29);
    const parentless = rows.filter((r) => r.parent === null).map((r) => r.name).sort();
    expect(parentless).toEqual([...Object.keys(TREE)].sort());
    expect(rows.filter((r) => r.parent !== null)).toHaveLength(21);
  });

  it("wires the department → children tree exactly per spec §5.1", async () => {
    const rows = await registry();
    for (const [dept, children] of Object.entries(TREE)) {
      const actual = rows.filter((r) => r.parent === dept).map((r) => r.name).sort();
      expect(actual, `children of ${dept}`).toEqual([...children].sort());
    }
  });

  it("keeps the two-level invariant: every parent exists and every parent's parent is NULL", async () => {
    const { rows } = await client.query<{ violations: string }>(
      `SELECT c.name AS violations
       FROM categories c
       LEFT JOIN categories p ON p.name = c.parent
       WHERE c.parent IS NOT NULL AND (p.name IS NULL OR p.parent IS NOT NULL)`,
    );
    expect(rows).toEqual([]);
  });

  it("all 14 legacy slugs survive unchanged (D3 — no rename, repurpose or delete)", async () => {
    const names = new Set((await registry()).map((r) => r.name));
    for (const slug of LEGACY_14) expect(names.has(slug), slug).toBe(true);
  });

  it("seeds exactly the §5.3 aliases; no alias equals a canonical name or appears in two rows", async () => {
    const rows = await registry();
    const canonical = new Set(rows.map((r) => r.name));
    const seen = new Map<string, string>();
    for (const row of rows) {
      const expected = ALIASES[row.name] ?? [];
      expect(row.aliases, `aliases of ${row.name}`).toEqual(expected);
      for (const alias of row.aliases) {
        expect(canonical.has(alias), `alias '${alias}' must not shadow a canonical name`).toBe(false);
        const first = seen.get(alias);
        expect(first, `alias '${alias}' must map to exactly one canonical row`).toBeUndefined();
        seen.set(alias, row.name);
      }
    }
    expect(seen.size).toBe(Object.values(ALIASES).flat().length);
  });

  it("'other' stays parentless and childless (fallback leaf-dept)", async () => {
    const rows = await registry();
    const other = rows.find((r) => r.name === "other");
    expect(other?.parent).toBeNull();
    expect(rows.filter((r) => r.parent === "other")).toEqual([]);
  });

  it("converges on re-apply: hand-edited and slug-colliding local rows are restored, created_at untouched (D7)", async () => {
    // Simulate a self-hosted database that diverged from the seed (spec §5.6
    // N1 case): a hand-edited description on a legacy row, plus a locally
    // added row whose slug collides with a new seed slug ('bags').
    await client.query(`UPDATE categories SET description = 'hand-edited' WHERE name = 'sneakers'`);
    await client.query(`DELETE FROM categories WHERE name = 'bags'`);
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions, parent, aliases)
       VALUES ('bags', 'my local bags', '[]', NULL, '{}')`,
    );
    await client.query(`UPDATE categories SET created_at = now() - interval '400 days' WHERE name = 'clothing'`);
    const { rows: before } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM categories WHERE name = 'clothing'`,
    );

    await client.query(readFileSync(schemaPath, "utf8")); // migrate re-apply

    const rows = await registry();
    const sneakers = rows.find((r) => r.name === "sneakers");
    const bags = rows.find((r) => r.name === "bags");
    expect(sneakers?.description).toBe("Trainers and sneakers");
    expect(bags?.description).toBe("Handbags, backpacks, luggage");
    expect(bags?.parent).toBe("fashion");
    const { rows: after } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM categories WHERE name = 'clothing'`,
    );
    expect(new Date(after[0].created_at).getTime()).toBe(new Date(before[0].created_at).getTime());
  });

  it("is idempotent: re-applying the schema changes no registry row", async () => {
    const snapshot = async () =>
      (await client.query(
        `SELECT name, description, parent, aliases, attribute_definitions::text AS defs
         FROM categories ORDER BY name`,
      )).rows;
    const before = await snapshot();
    await client.query(readFileSync(schemaPath, "utf8"));
    expect(await snapshot()).toEqual(before);
  });

  it("declares the facet attributes (department enum on fashion, size_letter on clothing) with legacy definitions intact", async () => {
    const rows = await registry();
    const defs = (name: string) => {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      return Object.fromEntries(row!.attribute_definitions.map((d) => [d.key, d]));
    };

    const department = { type: "string", enum: ["women", "men", "unisex", "kids"] };
    // department only where a gender split is a real query axis (§5.1 rationale):
    for (const name of ["fashion", "clothing", "shoes", "sneakers", "bags", "accessories"]) {
      expect(defs(name).department, `${name} department facet`).toMatchObject(department);
    }
    for (const name of ["beauty", "kids-clothing", "kids", "toys"]) {
      expect(defs(name).department, `${name} must not carry the department facet`).toBeUndefined();
    }

    const clothing = defs("clothing");
    expect(clothing.size).toMatchObject({ type: "string", required: true });
    expect(clothing.size_letter).toMatchObject({ type: "string", enum: ["XS", "S", "M", "L", "XL", "XXL"] });

    // Legacy definitions survive verbatim where the spec keeps them.
    expect(defs("sneakers").size_eu).toMatchObject({ type: "number", required: true });
    expect(defs("sneakers").colorway).toBeDefined();
    expect(defs("sneakers").has_original_box).toMatchObject({ type: "boolean" });
    expect(defs("games").platform).toMatchObject({
      type: "string",
      enum: ["nintendo_switch", "ps4", "ps5", "xbox_one", "xbox_series", "pc", "other"],
      required: true,
    });
    expect(defs("music").format).toMatchObject({
      type: "string",
      enum: ["vinyl", "cd", "cassette", "instrument", "other"],
    });

    // New leaves carry their §5.1 definitions.
    expect(defs("bikes").type).toMatchObject({
      type: "string",
      enum: ["road", "mtb", "city", "bmx", "ebike", "kids", "other"],
    });
    expect(defs("instruments").instrument).toMatchObject({ type: "string", required: true });
    expect(defs("board-games").players).toBeDefined();
    expect(defs("cameras").shutter_count).toMatchObject({ type: "number" });
    expect(defs("baby").type).toMatchObject({ type: "string", enum: ["pushchair", "car_seat", "nursery", "other"] });
    expect(defs("kids-clothing").size).toMatchObject({ type: "string", required: true });
  });

  it("validates new facets and keeps legacy values accepted (validateAttributes over the live registry)", async () => {
    const rows = await registry();
    const liveDefs = (name: string) => rows.find((r) => r.name === name)!.attribute_definitions;

    // clothing: legacy free-text size still required and accepted; size_letter
    // and department are validated enums; out-of-enum values are rejected.
    expect(validateAttributes(liveDefs("clothing"), { size: "M", size_letter: "L", department: "men" })).toEqual([]);
    expect(validateAttributes(liveDefs("clothing"), { size: "42" })).toEqual([]);
    expect(validateAttributes(liveDefs("clothing"), { size_letter: "L", department: "men" }).join("; ")).toContain('"size"');
    expect(validateAttributes(liveDefs("clothing"), { size: "M", size_letter: "XXXL" }).join("; ")).toContain("size_letter");
    expect(validateAttributes(liveDefs("clothing"), { size: "M", department: "mens" }).join("; ")).toContain("department");

    // sneakers: legacy size_eu requirement unchanged alongside the new facet.
    expect(validateAttributes(liveDefs("sneakers"), { department: "women" }).join("; ")).toContain("size_eu");

    // games: platform enum unchanged.
    expect(validateAttributes(liveDefs("games"), { platform: "ps5" })).toEqual([]);
    expect(validateAttributes(liveDefs("games"), { platform: "dreamcast" }).join("; ")).toContain("platform");

    // music: 'instrument' stays a valid legacy format value even though new
    // instrument listings are steered to hobbies/instruments by description.
    expect(validateAttributes(liveDefs("music"), { format: "instrument" })).toEqual([]);
  });
});
