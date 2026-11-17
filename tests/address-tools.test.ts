// Saved addresses MCP surface (spec docs/specs/saved-addresses.md, rollout
// step 2) — the list/save/delete_address tools and create_order's
// address_id wiring. Pure part: the C1 tool-level guards (anonymous →
// unauthorized), create_order's mutual exclusion and typed-country ISO
// rejection (both short-circuit before any query), and the 30/hour write
// bucket wiring. DB-backed part (skips without Postgres): the C2 summary
// shape at the tool boundary (name/street/postal never in a tool
// response), owner-scoped 404 discipline, the 10-address cap through the
// tool, and the address_id → order snapshot copy incl. last_used_at.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.js";
import { addressWriteLimiter } from "../src/addresses.js";
import type { SellerRow } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

/** The chat-order-tools capture harness: registers every tool against an
 *  in-memory map with the given context, no zod layer (callers pass
 *  well-formed args; the MCP server validates in production). */
function mcpTools(seller: SellerRow | null) {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }>>();
  registerTools(
    {
      registerTool(name: string, _config: unknown, handler: never) {
        handlers.set(name, handler as never);
      },
    } as never,
    { seller },
  );
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool ${name} was not registered`);
      const r = await handler(args);
      return { isError: r.isError === true, payload: JSON.parse(r.content![0].text!) as Record<string, unknown> };
    },
  };
}

const fakeSeller = { id: "11111111-1111-4111-8111-111111111111", display_name: "T" } as SellerRow;
const ADDRESS_INPUT = {
  label: "Home",
  name: "Ada Lovelace",
  line1: "Via Roma 1",
  city: "Milano",
  postal_code: "20121",
  country: "IT",
};

beforeAll(() => {
  addressWriteLimiter.reset(); // bucket state isolation for this file
});

// ---------------------------------------------------------------------------
// Pure: guards and short-circuits (no DB touched)

describe("address tools — guards (pure)", () => {
  it("anonymous callers get unauthorized on all three tools (C1 tool-level guard)", async () => {
    const anon = mcpTools(null);
    for (const tool of ["list_addresses", "save_address", "delete_address"]) {
      const r = await anon.call(tool, tool === "delete_address" ? { address_id: randomUUID() } : tool === "save_address" ? ADDRESS_INPUT : {});
      expect(r.isError, tool).toBe(true);
      expect(r.payload.code, tool).toBe("unauthorized");
    }
  });

  it("create_order: address_id and shipping_address are mutually exclusive", async () => {
    const mcp = mcpTools(fakeSeller);
    const r = await mcp.call("create_order", {
      item_id: randomUUID(),
      address_id: randomUUID(),
      shipping_address: { ...ADDRESS_INPUT },
    });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe("invalid_request");
  });

  it("create_order: a typed non-ISO country is rejected before any order work", async () => {
    const mcp = mcpTools(fakeSeller);
    const r = await mcp.call("create_order", {
      item_id: randomUUID(),
      shipping_address: { ...ADDRESS_INPUT, country: "XX" },
    });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe("invalid_address");
  });

  it("save/delete share the module's 30/hour write bucket (wired at the tool)", async () => {
    const mcp = mcpTools(fakeSeller);
    const allow = vi.spyOn(addressWriteLimiter, "allow").mockReturnValue(false);
    try {
      for (const [tool, args] of [
        ["save_address", { ...ADDRESS_INPUT }],
        ["delete_address", { address_id: randomUUID() }],
      ] as const) {
        const r = await mcp.call(tool, args as Record<string, unknown>);
        expect(r.isError, tool).toBe(true);
        expect(r.payload.code, tool).toBe("rate_limited");
      }
    } finally {
      allow.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed: the tool surface over the real store

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

describe.skipIf(!available)("address tools over the store (DB)", () => {
  let client: pg.Client;
  let buyerId = "";
  let otherId = "";

  const buyerTools = () => mcpTools({ id: buyerId, display_name: "buyer" } as SellerRow);
  const otherTools = () => mcpTools({ id: otherId, display_name: "other" } as SellerRow);

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("TRUNCATE order_events, webhook_events, orders, items, account_addresses, sellers RESTART IDENTITY CASCADE");
    buyerId = randomUUID();
    otherId = randomUUID();
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES
        ($1, 'thg_addr_a', 'addr-buyer', $2),
        ($3, 'thg_addr_b', 'addr-other', $4)`,
      [buyerId, `addr-a-${randomUUID()}@t.dev`, otherId, `addr-b-${randomUUID()}@t.dev`],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it("save_address returns the C2 summary only — never name, street or postal code", async () => {
    const r = await buyerTools().call("save_address", { ...ADDRESS_INPUT });
    expect(r.isError).toBe(false);
    const summary = r.payload.address as Record<string, unknown>;
    expect(summary.verification).toBe("not_checked"); // no EasyPost wiring yet (step 4)
    // The C2 boundary at the tool surface: banned values absent from the
    // entire serialized response, not just the summary object.
    const all = JSON.stringify(r.payload);
    for (const banned of ["Ada Lovelace", "Via Roma 1", "20121"]) {
      expect(all).not.toContain(banned);
    }
    expect(Object.keys(summary).sort()).toEqual(["city", "country", "id", "is_default", "label", "verification"]);
  });

  it("list_addresses returns summaries only", async () => {
    const r = await buyerTools().call("list_addresses", {});
    expect(r.isError).toBe(false);
    expect(r.payload.count).toBe(1);
    const addresses = r.payload.addresses as Record<string, unknown>[];
    expect(addresses).toHaveLength(1);
    const all = JSON.stringify(r.payload);
    for (const banned of ["Ada Lovelace", "Via Roma 1", "20121"]) {
      expect(all).not.toContain(banned);
    }
  });

  it("delete_address deletes, then the same id is not_found", async () => {
    const mcp = buyerTools();
    const list = await mcp.call("list_addresses", {});
    const id = (list.payload.addresses as { id: string }[])[0].id;
    const del = await mcp.call("delete_address", { address_id: id });
    expect(del.isError).toBe(false);
    expect(del.payload.deleted).toBe(true);
    const again = await mcp.call("delete_address", { address_id: id });
    expect(again.isError).toBe(true);
    expect(again.payload.code).toBe("not_found");
  });

  it("a foreign address id is not_found to another account (no existence leak)", async () => {
    const save = await buyerTools().call("save_address", { ...ADDRESS_INPUT, label: "Mine" });
    const id = (save.payload.address as { id: string }).id;
    const r = await otherTools().call("delete_address", { address_id: id });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe("not_found");
  });

  it("the 10-address cap surfaces as rate_limited through the tool", async () => {
    const mcp = buyerTools();
    // 1 row already saved above; fill to 10, then the 11th is over the cap.
    for (let i = 0; i < 9; i++) {
      const r = await mcp.call("save_address", { ...ADDRESS_INPUT, label: `Extra ${i}` });
      expect(r.isError).toBe(false);
    }
    const over = await mcp.call("save_address", { ...ADDRESS_INPUT, label: "One too many" });
    expect(over.isError).toBe(true);
    expect(over.payload.code).toBe("rate_limited");
  });

  it("create_order with address_id copies the saved address into the order and stamps last_used_at", async () => {
    // A seller of the item distinct from the buyer (and from the rows above).
    const sellerId = randomUUID();
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES ($1, 'thg_addr_c', 'addr-seller', $2)`,
      [sellerId, `addr-c-${randomUUID()}@t.dev`],
    );
    const item = await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status, shipping_tier)
       VALUES ($1, 'Saved-address lamp', 5000, 700, 'home', '{}'::jsonb, 'active', 'parcel') RETURNING id`,
      [sellerId],
    );
    // A clean account for the order test (the cap-filled one is at 10).
    const freshBuyer = randomUUID();
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES ($1, 'thg_addr_d', 'addr-fresh', $2)`,
      [freshBuyer, `addr-d-${randomUUID()}@t.dev`],
    );
    const freshTools = mcpTools({ id: freshBuyer, display_name: "fresh" } as SellerRow);
    const save = await freshTools.call("save_address", { ...ADDRESS_INPUT, country: "it" });
    expect(save.isError).toBe(false);
    const addressId = (save.payload.address as { id: string }).id;

    const r = await freshTools.call("create_order", {
      item_id: item.rows[0].id,
      address_id: addressId,
      payment_mode: "off_platform",
    });
    expect(r.isError).toBe(false);
    // The tool response never carries the address (orderToPublic strips).
    const all = JSON.stringify(r.payload);
    for (const banned of ["Ada Lovelace", "Via Roma 1", "20121"]) {
      expect(all).not.toContain(banned);
    }

    const order = await client.query<{ shipping_address: Record<string, string>; status: string }>(
      `SELECT shipping_address, status FROM orders WHERE buyer_id = $1`,
      [freshBuyer],
    );
    expect(order.rows[0].status).toBe("pending_payment");
    // Copied as if typed — lowercase 'it' was normalized to 'IT' at save.
    expect(order.rows[0].shipping_address).toEqual({
      name: "Ada Lovelace",
      line1: "Via Roma 1",
      city: "Milano",
      postal_code: "20121",
      country: "IT",
    });

    const stamp = await client.query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM account_addresses WHERE id = $1`,
      [addressId],
    );
    expect(stamp.rows[0].last_used_at).not.toBeNull();
  });

  it("create_order with a foreign address_id is not_found (404 discipline)", async () => {
    const sellerId = randomUUID();
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES ($1, 'thg_addr_e', 'addr-seller2', $2)`,
      [sellerId, `addr-e-${randomUUID()}@t.dev`],
    );
    const item = await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status, shipping_tier)
       VALUES ($1, 'Foreign-address chair', 3000, 500, 'home', '{}'::jsonb, 'active', 'parcel') RETURNING id`,
      [sellerId],
    );
    // otherId owns an address; buyerId tries to order with it.
    const otherSave = await otherTools().call("save_address", { ...ADDRESS_INPUT, label: "Other" });
    const foreignId = (otherSave.payload.address as { id: string }).id;
    const r = await buyerTools().call("create_order", { item_id: item.rows[0].id, address_id: foreignId });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe("not_found");
  });
});
