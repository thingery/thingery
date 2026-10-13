// PR 2 of spec THI-83 (rev a95419b1): surface `undeclared_in_use` in
// describe_category on both surfaces — the MCP tool (src/tools.ts, protected
// path) and the chat handler (src/chat.ts). Covers the parity requirement
// (§8/F3: both surfaces render undeclaredKeyUsage() output identically —
// shape once, render twice), the omit-when-empty contract (§3.1: clean
// categories keep a payload identical to today's), the response note, and
// the update_listing structured invalid_attributes error (§3.5 / THI-90
// note 1). DB-backed; skips when no Postgres is reachable.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { SellerRow } from "../src/db.js";
import { executeTool } from "../src/chat.js";
import { registerTools } from "../src/tools.js";
import { undeclaredKeyUsage } from "../src/items.js";

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

// Today's per-category payloads, pinned: a clean category must stay
// byte-identical to these (spec §3.1 "omitted entirely when empty").
const CLEAN_MCP_NOTE =
  "attribute_definitions are the declared keys — create_listing validates them " +
  "(types, required, enums). Listings may also carry undeclared keys: they pass through " +
  "unvalidated, and search_items attribute filters match any key, declared or not.";
const UNDECLARED_NOTE_SENTENCE =
  " undeclared_in_use lists undeclared keys observed on active listings (item and " +
  "distinct-seller counts); they are NOT validated — treat them as search hints, not contracts.";

describe.skipIf(!available)("describe_category undeclared_in_use (DB)", () => {
  let client: pg.Client;
  let describeHandler!: (args: Record<string, unknown>) => Promise<unknown>;
  let updateHandler!: (args: Record<string, unknown>) => Promise<unknown>;
  let sellerA: SellerRow;

  /** Runs the captured MCP handler and parses its JSON body. */
  async function mcpDescribe(category?: string): Promise<Record<string, unknown>> {
    const result = (await describeHandler(category ? { category } : {})) as {
      content: { text: string }[];
    };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
    await client.query(
      `INSERT INTO sellers (api_key, display_name, email) VALUES
        ('thg_88_a', 'dc-a', 'dc-a@t.dev'),
        ('thg_88_b', 'dc-b', 'dc-b@t.dev')`,
    );
    // Category with two declared keys; undeclared keys land on items below.
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions) VALUES
        ('thi88surf', 'surfacing test', $1::jsonb),
        ('thi88clean', 'clean test', $1::jsonb)
       ON CONFLICT (name) DO UPDATE SET attribute_definitions = EXCLUDED.attribute_definitions`,
      [
        JSON.stringify([
          { key: "size_eu", type: "number", required: true },
          { key: "colorway", type: "string" },
        ]),
      ],
    );

    let n = 0;
    const seed = async (sellerEmail: string, category: string, attrs: Record<string, unknown>) => {
      n += 1;
      await client.query(
        `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status)
         SELECT id, $1, 1000, 100, $2, $3::jsonb, 'active' FROM sellers WHERE email = $4`,
        [`DC item ${n}`, category, JSON.stringify(attrs), sellerEmail],
      );
    };
    // thi88surf: `lacing_style` crosses both thresholds (2 sellers × 2 items);
    // declared keys are heavily used but never surfaced; `solo_key` is one
    // seller's habit and must not appear.
    for (const email of ["dc-a@t.dev", "dc-b@t.dev"]) {
      await seed(email, "thi88surf", { size_eu: 43, colorway: "white", lacing_style: "flat" });
      await seed(email, "thi88surf", { size_eu: 44, colorway: "black", lacing_style: "chunky" });
    }
    await seed("dc-a@t.dev", "thi88surf", { solo_key: 1 });
    // thi88clean: declared keys only — helper returns [], field omitted.
    await seed("dc-a@t.dev", "thi88clean", { size_eu: 42, colorway: "red" });
    await seed("dc-b@t.dev", "thi88clean", { size_eu: 45, colorway: "blue" });

    ({ rows: [sellerA] } = await client.query<SellerRow>(
      "SELECT id, api_key, display_name FROM sellers WHERE email = 'dc-a@t.dev'",
    ));

    registerTools(
      {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          if (name === "describe_category") describeHandler = handler;
          if (name === "update_listing") updateHandler = handler;
        },
      },
      // describe_category is public; seller only matters for update_listing
      // (swap contexts per test via direct handler capture is overkill — the
      // update test re-registers with the seller below).
      { seller: null },
    );
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
      { seller: sellerA },
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it("MCP tool surfaces undeclared_in_use verbatim from the helper (shape + note)", async () => {
    const body = await mcpDescribe("thi88surf");
    const expected = await undeclaredKeyUsage(
      "thi88surf",
      ["size_eu", "colorway"],
    );
    expect(expected).toEqual([{ key: "lacing_style", items: 4, sellers: 2 }]);
    expect(body.undeclared_in_use).toEqual(expected);
    // Declared keys and single-seller keys never appear.
    const keys = (body.undeclared_in_use as { key: string }[]).map((r) => r.key);
    expect(keys).not.toContain("size_eu");
    expect(keys).not.toContain("colorway");
    expect(keys).not.toContain("solo_key");
    // The note documents the field and its not-a-contract semantics.
    expect(body.note).toBe(CLEAN_MCP_NOTE + UNDECLARED_NOTE_SENTENCE);
  });

  it("MCP tool and chat handler return identical undeclared_in_use (parity, §8/F3)", async () => {
    const mcpBody = await mcpDescribe("thi88surf");
    const chatBody = (await executeTool("describe_category", { category: "thi88surf" }, null)) as {
      undeclared_in_use: unknown;
      note: string;
    };
    expect(chatBody.undeclared_in_use).toEqual(mcpBody.undeclared_in_use);
    expect(chatBody.undeclared_in_use).toEqual(await undeclaredKeyUsage("thi88surf", ["size_eu", "colorway"]));
    expect(chatBody.note).toContain("undeclared_in_use");
    expect(chatBody.note).toContain("NOT validated");
  });

  it("omits undeclared_in_use entirely for a clean category (payload stays today's)", async () => {
    const body = await mcpDescribe("thi88clean");
    expect(body).not.toHaveProperty("undeclared_in_use");
    // Byte-identical to today: exactly {category, note} with the old note.
    const category = body.category as { name: string };
    expect(category.name).toBe("thi88clean");
    expect(Object.keys(body).sort()).toEqual(["category", "note"]);
    expect(body.note).toBe(CLEAN_MCP_NOTE);
    // Chat surface: same omission.
    const chatBody = (await executeTool("describe_category", { category: "thi88clean" }, null)) as Record<string, unknown>;
    expect(chatBody).not.toHaveProperty("undeclared_in_use");
  });

  it("no-arg list mode stays clean (no undeclared_in_use)", async () => {
    const body = await mcpDescribe();
    expect(body).not.toHaveProperty("undeclared_in_use");
    expect(body.categories).toBeTruthy();
  });

  it("update_listing returns the structured invalid_attributes error (THI-90 note 1)", async () => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE category = 'thi88surf' LIMIT 1",
    );
    const result = (await updateHandler({
      id: rows[0].id,
      attributes: { size_eu: 43, colorway: "x".repeat(501) },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { error: string; code: string };
    expect(parsed.code).toBe("invalid_attributes");
    expect(parsed.error).toContain("value too long");
  });
});
