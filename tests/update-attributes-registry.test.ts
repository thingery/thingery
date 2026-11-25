// THI-1369 (Security review THI-1366 finding F1, mini-spec on the issue):
// update-path registry validation parity with create_listing. updateItem
// historically enforced shape caps only (THI-83 §3.5); the replacement
// attributes payload must now also satisfy the item's stored category
// definitions — declared-required keys present, declared keys type/enum
// valid — with undeclared keys still passing through.
//
// Part 1 is pure (definitionErrors unit contract). Parts 2–3 are DB-backed
// and skip when no Postgres is reachable, mirroring items.test.ts: Part 2
// covers updateItem parity, Part 3 the MCP update_listing error surface.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  AttributeValidationError,
  definitionErrors,
  validateAttributes,
  type AttributeDefinition,
} from "../src/attributes.js";
import type { SellerRow } from "../src/db.js";
import { updateItem } from "../src/items.js";
import { registerTools } from "../src/tools.js";

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

const GAMES_DEFS: AttributeDefinition[] = [
  { key: "platform", type: "string", enum: ["ps5", "xbox", "switch"], required: true },
  { key: "edition", type: "string" },
  { key: "year", type: "number" },
];

// ---------------------------------------------------------------------------
// Part 1 — pure: definitionErrors contract (the checks create_listing runs)

describe("definitionErrors (THI-1369 extraction)", () => {
  it("flags a missing declared-required key, passes on a complete payload", () => {
    const dropRequired = definitionErrors(GAMES_DEFS, { edition: "gold" });
    expect(dropRequired).toHaveLength(1);
    expect(dropRequired[0]).toContain('missing required attribute "platform"');
    expect(definitionErrors(GAMES_DEFS, { platform: "ps5" })).toEqual([]);
  });

  it("enforces enum (wrong case rejected) and declared types", () => {
    expect(definitionErrors(GAMES_DEFS, { platform: "PS5" })[0]).toContain("must be one of");
    expect(definitionErrors(GAMES_DEFS, { platform: "ps5", year: "2020" })[0]).toContain("must be a number");
    expect(definitionErrors(GAMES_DEFS, { platform: "ps5", year: 2020, edition: 7 })[0]).toContain("must be a string");
  });

  it("passes undeclared keys through and is the defs half of validateAttributes", () => {
    const payload = { platform: "ps5", colorway: "red" };
    expect(definitionErrors(GAMES_DEFS, payload)).toEqual([]);
    expect(validateAttributes(GAMES_DEFS, payload)).toEqual([]);
    // Empty declared set (registry fallback) → shape caps are the only rules.
    expect(definitionErrors([], { anything: "goes" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parts 2–3 — DB-backed (skips without a reachable Postgres)

const available = await dbAvailable();

// Module scope so Part 3 (MCP surface) reuses the pinned fixtures.
let seller!: SellerRow;
let itemId!: string;
let legacyId!: string;
let unknownCatId!: string;
let mcpItemId!: string;
const category = "thi1369games";
const unknownCategory = "thi1369ghost";

describe.skipIf(!available)("updateItem registry parity (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
    await client.query(
      `INSERT INTO sellers (api_key_hash, display_name, email)
       VALUES ('thg_1369', 'thi1369', 'thi1369@t.dev')`,
    );
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions)
       VALUES ($1, 'THI-1369 registry parity', $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET attribute_definitions = EXCLUDED.attribute_definitions`,
      [category, JSON.stringify(GAMES_DEFS)],
    );
    ({ rows: [seller] } = await client.query<SellerRow>(
      "SELECT id, display_name FROM sellers WHERE email = 'thi1369@t.dev'",
    ));
    const seed = async (title: string, cat: string, attrs: Record<string, unknown>) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status)
         VALUES ($1, $2, 2500, 400, $3, $4::jsonb, 'active') RETURNING id`,
        [seller.id, title, cat, JSON.stringify(attrs)],
      );
      return rows[0].id;
    };
    itemId = await seed("THI-1369 item", category, { platform: "ps5" });
    // Legacy row: stored attributes already violate the registry (pre-fix
    // data). Field-only updates must keep working without touching it.
    legacyId = await seed("THI-1369 legacy item", category, { edition: "gold" });
    // Unknown-category row: category not in the registry (no FK) → fallback.
    unknownCatId = await seed("THI-1369 ghost item", unknownCategory, { junk: 1 });
    // Pinned fixture for the Part 3 MCP-surface test (never matched by LIMIT 1).
    mcpItemId = await seed("THI-1369 MCP item", category, { platform: "ps5" });
  });

  afterAll(async () => {
    await client.end();
  });

  const storedAttributes = async (id: string): Promise<Record<string, unknown>> => {
    const { rows } = await client.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM items WHERE id = $1",
      [id],
    );
    return rows[0].attributes;
  };

  it("rejects a payload dropping the declared-required key (F1 case 1), row unchanged", async () => {
    const err = await updateItem(itemId, seller.id, {
      attributes: { edition: "gold" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeValidationError);
    expect((err as AttributeValidationError).code).toBe("invalid_attributes");
    expect((err as AttributeValidationError).message).toContain('missing required attribute "platform"');
    expect(await storedAttributes(itemId)).toEqual({ platform: "ps5" });
  });

  it("rejects a wrong-case enum value (F1 case 2), row unchanged", async () => {
    const err = await updateItem(itemId, seller.id, {
      attributes: { platform: "PS5" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeValidationError);
    expect((err as AttributeValidationError).message).toContain("must be one of");
    expect(await storedAttributes(itemId)).toEqual({ platform: "ps5" });
  });

  it("rejects a wrongly-typed declared key", async () => {
    const err = await updateItem(itemId, seller.id, {
      attributes: { platform: "ps5", year: "2020" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeValidationError);
    expect((err as AttributeValidationError).message).toContain("must be a number");
    expect(await storedAttributes(itemId)).toEqual({ platform: "ps5" });
  });

  it("accepts a create-valid payload and replaces attributes wholesale (undeclared key passes through)", async () => {
    const updated = await updateItem(itemId, seller.id, {
      attributes: { platform: "xbox", edition: "std", colorway: "red" },
    });
    expect(updated?.attributes).toEqual({ platform: "xbox", edition: "std", colorway: "red" });
  });

  it("keeps field-only updates working on legacy rows whose stored attributes violate the registry", async () => {
    const updated = await updateItem(legacyId, seller.id, { price_cents: 999 });
    expect(updated?.price_cents).toBe(999);
    expect(await storedAttributes(legacyId)).toEqual({ edition: "gold" });
  });

  it("falls back to shape caps only for an item whose category is not in the registry", async () => {
    const updated = await updateItem(unknownCatId, seller.id, {
      attributes: { any_key: "still passes" },
    });
    expect(updated?.attributes).toEqual({ any_key: "still passes" });
  });

  it("shape caps still reject before any DB roundtrip (pure-first order preserved)", async () => {
    // Garbage ids + over-long value: the throw must happen without needing
    // the DB read (the ids would otherwise be rejected as not found).
    const err = await updateItem("not-a-uuid", "not-a-seller", {
      attributes: { k: "x".repeat(501) },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeValidationError);
    expect((err as AttributeValidationError).message).toContain("value too long");
  });
});

describe.skipIf(!available)("update_listing MCP invalid_attributes surface (DB)", () => {
  it("returns isError with code invalid_attributes on a registry violation (THI-90 note 1 shape)", async () => {
    let updateHandler!: (args: Record<string, unknown>) => Promise<unknown>;
    registerTools(
      {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          if (name === "update_listing") updateHandler = handler;
        },
      },
      { seller },
    );
    const result = (await updateHandler({
      id: mcpItemId,
      attributes: { edition: "gold" }, // drops required platform
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { error: string; code: string };
    expect(parsed.code).toBe("invalid_attributes");
    expect(parsed.error).toContain("missing required attribute");
  });
});
