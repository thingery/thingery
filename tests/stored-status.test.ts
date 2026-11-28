// P1-3 (spec THI-813 §P1-3 + ADR 0010): `stored` private-inventory status —
// the updateItem transition table (only active⇄stored, stored→deleted; typed
// invalid_item_transition / item_in_order errors), create-time status,
// owner-only visibility (get_item / search / chat / public item page),
// my_listings --status stored, and the zero-re-entry toggle roundtrip that
// preserves all data. Pure tests run anywhere; the DB block needs Postgres
// (DATABASE_URL or localhost:5432) and skips otherwise.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request, Response } from "express";
import { pool } from "../src/db.js";
import { createItem, updateItem, ItemTransitionError, visibleInFeeds } from "../src/items.js";
import { registerTools } from "../src/tools.js";
import { executeTool } from "../src/chat.js";
import { itemPage } from "../src/web-pages.js";
import { signSession, SESSION_COOKIE } from "../src/auth.js";
import type { ItemRow, SellerRow } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// ---------------------------------------------------------------------------
// Pure: the ADR-0010 transition table on updateItem
// ---------------------------------------------------------------------------

interface FakeRowOptions {
  status?: string;
  images?: string[];
  photo_required?: boolean;
  id?: string;
}

function fakeItemRow(opts: FakeRowOptions = {}): ItemRow {
  return {
    id: opts.id ?? "11111111-1111-4111-8111-111111111111",
    seller_id: "22222222-2222-4222-8222-222222222222",
    title: "Stored probe",
    description: "",
    category: "other",
    condition: "good",
    brand: null,
    price_cents: 1000,
    currency: "EUR",
    location: null,
    weight_grams: null,
    dimensions_mm: null,
    shipping_tier: "parcel",
    images: opts.images ?? [],
    photo_required: opts.photo_required ?? true,
    attributes: {},
    embedding: null,
    shipping_price_cents: 0,
    status: opts.status ?? "active",
    photo_gate_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as ItemRow;
}

/** Mock pool.query so the transition pre-read returns `from`, the live-order
 *  guard sees `liveOrders` rows, and the UPDATE returns a RETURNING row. */
function mockUpdateFlow(from: string | null, returning: ItemRow | null, liveOrders = 0) {
  return vi.spyOn(pool, "query").mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes("SELECT status FROM items")) return { rows: from === null ? [] : [{ status: from }] };
    if (text.includes("FROM orders WHERE item_id")) return { rows: liveOrders > 0 ? [{ ok: 1 }] : [] };
    if (text.includes("UPDATE items SET")) return { rows: returning ? [returning] : [] };
    // attribute validation happens before any SELECT; anything else is a bug
    throw new Error(`unexpected query in test: ${text.slice(0, 80)}`);
  });
}

describe("ADR-0010 transition table on updateItem (pure)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    // [from, to, allowed]
    ["active", "stored", true], // the inventory save
    ["stored", "active", true], // the zero-re-entry flip to for-sale
    ["stored", "deleted", true], // inventory discard
    ["stored", "stored", true], // same-status no-op
    ["active", "active", true],
    // legacy free-form moves among the four pre-existing statuses are
    // deliberately unchanged (ADR 0010: one behavior change per PR)
    ["active", "reserved", true],
    ["reserved", "sold", true],
    ["sold", "active", true],
    ["reserved", "deleted", true],
    // report-moderation spec PR 2: 'suspended' is the moderator-only status —
    // same-status writes stay no-ops like every other status
    ["suspended", "suspended", true],
  ])("%s → %s is allowed", async (from, to) => {
    const mock = mockUpdateFlow(from, fakeItemRow({ status: to as string }));
    const row = await updateItem("item-1", "seller-1", { status: to });
    expect(row?.status).toBe(to);
    expect(mock).toHaveBeenCalled();
  });

  it.each([
    ["stored", "reserved"],
    ["stored", "sold"],
    ["reserved", "stored"],
    ["sold", "stored"],
    ["deleted", "stored"],
    // report-moderation spec PR 2: the suspended fence — any seller move into
    // or out of 'suspended' is rejected in both directions, from every status
    ["active", "suspended"],
    ["stored", "suspended"],
    ["reserved", "suspended"],
    ["sold", "suspended"],
    ["deleted", "suspended"],
    ["suspended", "active"],
    ["suspended", "stored"],
    ["suspended", "reserved"],
    ["suspended", "sold"],
    ["suspended", "deleted"],
  ])("%s → %s is rejected with invalid_item_transition", async (from, to) => {
    mockUpdateFlow(from, null);
    await expect(updateItem("item-1", "seller-1", { status: to })).rejects.toMatchObject({
      code: "invalid_item_transition",
    });
    await expect(updateItem("item-1", "seller-1", { status: to })).rejects.toBeInstanceOf(
      ItemTransitionError,
    );
  });

  it("active → stored with a live order is rejected with item_in_order", async () => {
    mockUpdateFlow("active", null, 1);
    await expect(updateItem("item-1", "seller-1", { status: "stored" })).rejects.toMatchObject({
      code: "item_in_order",
    });
  });

  it("row missing/not owned (null status) skips enforcement and returns null", async () => {
    const mock = mockUpdateFlow(null, null);
    expect(await updateItem("item-1", "seller-1", { status: "stored" })).toBeNull();
    // enforcement never fired: no invalid_item_transition, UPDATE still ran
    expect(mock.mock.calls.some((c) => String(c[0]).includes("UPDATE items SET"))).toBe(true);
  });

  it("attribute shape violations still win without touching the DB (fail-fast order)", async () => {
    const mock = vi.spyOn(pool, "query").mockImplementation(async () => {
      throw new Error("no query should run before local validation");
    });
    await expect(
      updateItem("item-1", "seller-1", { status: "stored", attributes: { k: "x".repeat(501) } }),
    ).rejects.not.toBeInstanceOf(ItemTransitionError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("stored → active fan-out never fails the toggle (posture)", async () => {
    // intent fan-out + wanted stamping run after a successful UPDATE; a
    // failure in either must not bubble (same posture as createItem publish)
    const mock = vi.spyOn(pool, "query").mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT status FROM items")) return { rows: [{ status: "stored" }] };
      if (text.includes("FROM orders WHERE item_id")) return { rows: [] };
      if (text.includes("UPDATE items SET")) return { rows: [fakeItemRow({ status: "active", images: ["https://x/y.jpg"], photo_required: false })] };
      // every fan-out query (category closure, intents, wanted stamp) explodes
      throw new Error(`fan-out failure injected: ${text.slice(0, 60)}`);
    });
    const row = await updateItem("item-1", "seller-1", { status: "active" });
    expect(row?.status).toBe("active");
    expect(mock).toHaveBeenCalled();
  });
});

describe("create-time status (pure)", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockInsert() {
    return vi.spyOn(pool, "query").mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO items")) return { rows: [fakeItemRow()] };
      if (text.includes("COUNT(*) FILTER")) {
        // listingQuota pre-read: an old seller (full caps) keeps the branch out
        return { rows: [{ creates_24h: "0", active: "0", seller_created_at: new Date("2020-01-01T00:00:00Z") }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    });
  }

  const base = {
    seller_id: "seller-1",
    title: "Camping stove",
    description: "",
    category: "other",
    condition: "good" as const,
    price_cents: 2500,
    currency: "EUR",
    shipping_tier: "parcel" as const,
    images: [],
  };

  it("defaults to active (byte-identical legacy create)", async () => {
    const mock = mockInsert();
    await createItem(base);
    const params = mock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO items"))![1] as unknown[];
    expect(params.at(-1)).toBe("active");
  });

  it("status: stored lands in the INSERT", async () => {
    const mock = mockInsert();
    await createItem({ ...base, status: "stored" });
    const params = mock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO items"))![1] as unknown[];
    expect(params.at(-1)).toBe("stored");
  });

  it("rejects create-illegal statuses before any query (reserved/sold/deleted)", async () => {
    const mock = mockInsert();
    for (const status of ["reserved", "sold", "deleted", "for_sale"] as const) {
      await expect(createItem({ ...base, status: status as "stored" })).rejects.toThrow(/status must be one of/);
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("visibleInFeeds excludes stored (pure)", () => {
  it("stored is never feed-visible, even with photos", () => {
    expect(visibleInFeeds(fakeItemRow({ status: "stored", images: ["https://x/y.jpg"], photo_required: false }))).toBe(false);
    expect(visibleInFeeds(fakeItemRow({ status: "active", images: ["https://x/y.jpg"], photo_required: false }))).toBe(true);
    expect(visibleInFeeds(fakeItemRow({ status: "stored" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed end-to-end (skips without Postgres)
// ---------------------------------------------------------------------------

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

interface Captured {
  config: { description?: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function toolsFor(seller: SellerRow | null): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  registerTools(
    { registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) { tools.set(name, { config, handler }); } },
    { seller },
  );
  return tools;
}

async function callTool(tools: Map<string, Captured>, name: string, args: Record<string, unknown>) {
  // SDK parity (THI-958): the real server parses args through the tool's
  // zod shape (applying schema defaults) before the handler runs — mirror
  // that here, since handlers now trust their parsed args type.
  const parsed = z.object(tools.get(name)!.config.inputSchema as z.ZodRawShape).parse(args) as Record<string, unknown>;
  const result = (await tools.get(name)!.handler(parsed)) as {
    isError?: boolean;
    content: { text: string }[];
  };
  if (result.isError) console.log(`tool ${name} errored:`, result.content[0].text.slice(0, 300));
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, any> };
}

describe.skipIf(!available)("stored status end-to-end (DB)", () => {
  let db: pg.Client;
  let owner: SellerRow;
  let other: SellerRow;
  const sellerIds: string[] = [];
  const itemIds: string[] = [];

  const seedSeller = async (name: string): Promise<SellerRow> => {
    const { rows } = await db.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING *`,
      [`hash-${name}-${randomUUID()}`, name, `${name}-${randomUUID()}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return rows[0];
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    // Re-apply schema.sql: also proves the ADR-0010 widening DO-block is
    // idempotent on an already-widened database.
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    owner = await seedSeller("owner");
    other = await seedSeller("other");
  });

  afterAll(async () => {
    await db.end();
  });

  it("roundtrip: stored create → invisible everywhere → flip to active → instantly queryable → flip back", async () => {
    const title = `Roundtrip stove ${randomUUID()}`;
    const ownerTools = toolsFor(owner);

    // 1. create straight into inventory
    const created = await callTool(ownerTools, "create_listing", {
      title, description: "gas stove, used twice", category: "other",
      condition: "good", price_cents: 2500, currency: "EUR",
      shipping_tier: "parcel", images: ["https://img.example.com/stove.jpg"],
      attributes: { fuel: "gas" }, status: "stored",
    });
    expect(created.isError).toBe(false);
    expect(created.body.item.status).toBe("stored");
    expect(created.body.visible).toBe(false);
    const id = created.body.item.id as string;
    itemIds.push(id);

    // 2. stored is invisible to buyers: search, anonymous get_item, chat
    const search = await callTool(toolsFor(null), "search_items", { q: "stove", limit: 50 });
    expect((search.body.results ?? []).some((r: { id: string }) => r.id === id)).toBe(false);
    const anonGet = await callTool(toolsFor(null), "get_item", { id });
    expect(anonGet.isError).toBe(true);
    expect(anonGet.body).toMatchObject({ code: "not_found" });
    const otherGet = await callTool(toolsFor(other), "get_item", { id });
    expect(otherGet.isError).toBe(true);
    const chatAnon = await executeTool("get_item", { id }, null);
    expect(chatAnon).toMatchObject({ error: "not found" });
    const chatOther = await executeTool("get_item", { id }, other);
    expect(chatOther).toMatchObject({ error: "not found" });

    // …and the public item page 404s for everyone but the owner
    const anonPage = stubResponse(id);
    await itemPage(anonPage.req, anonPage.res as unknown as Response);
    expect(anonPage.res.statusCode).toBe(404);

    // 3. the owner still sees it — my_listings --status stored, get_item
    const mine = await callTool(ownerTools, "my_listings", { status: "stored", limit: 100 });
    expect((mine.body.items ?? []).some((r: { id: string }) => r.id === id)).toBe(true);
    const activeOnly = await callTool(ownerTools, "my_listings", { status: "active", limit: 100 });
    expect((activeOnly.body.items ?? []).some((r: { id: string }) => r.id === id)).toBe(false);
    const ownerGet = await callTool(ownerTools, "get_item", { id });
    expect(ownerGet.isError).toBe(false);
    expect(ownerGet.body.item.status).toBe("stored");
    const chatOwner = await executeTool("get_item", { id }, owner);
    expect(chatOwner).toMatchObject({ item: { id, status: "stored" } });

    // 4. flip to for-sale — everything preserved, instantly queryable
    const flipped = await callTool(ownerTools, "update_listing", { id, status: "active" });
    expect(flipped.isError).toBe(false);
    expect(flipped.body.item.status).toBe("active");
    expect(flipped.body.item.title).toBe(title);
    expect(flipped.body.item.images).toEqual(["https://img.example.com/stove.jpg"]);
    expect(flipped.body.item.attributes).toMatchObject({ fuel: "gas" });
    const search2 = await callTool(toolsFor(null), "search_items", { q: "stove", limit: 50 });
    expect((search2.body.results ?? []).some((r: { id: string }) => r.id === id)).toBe(true);
    const anonGet2 = await callTool(toolsFor(null), "get_item", { id });
    expect(anonGet2.isError).toBe(false);
    const pubPage = stubResponse(id);
    await itemPage(pubPage.req, pubPage.res as unknown as Response);
    expect(pubPage.res.statusCode).toBe(200);

    // 5. flip back to stored — invisible again, data still intact
    const back = await callTool(ownerTools, "update_listing", { id, status: "stored" });
    expect(back.isError).toBe(false);
    expect(back.body.item.status).toBe("stored");
    expect(back.body.item.attributes).toMatchObject({ fuel: "gas" });
    const search3 = await callTool(toolsFor(null), "search_items", { q: "stove", limit: 50 });
    expect((search3.body.results ?? []).some((r: { id: string }) => r.id === id)).toBe(false);

    // DB truth: status flipped, no columns lost
    const { rows } = await db.query(`SELECT status, images, attributes FROM items WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("stored");
    expect(rows[0].images).toEqual(["https://img.example.com/stove.jpg"]);
  });

  it("illegal transitions are typed errors (DB): reserved→stored, stored→reserved/sold", async () => {
    const title = `Matrix lamp ${randomUUID()}`;
    const ownerTools = toolsFor(owner);
    const created = await callTool(ownerTools, "create_listing", {
      title, category: "other", price_cents: 100, currency: "EUR", shipping_tier: "parcel",
      images: ["https://img.example.com/l.jpg"], status: "active",
    });
    const id = created.body.item.id as string;
    itemIds.push(id);

    // active → reserved (legacy, allowed) → stored must now be rejected
    await callTool(ownerTools, "update_listing", { id, status: "reserved" });
    const reject = await callTool(ownerTools, "update_listing", { id, status: "stored" });
    expect(reject.isError).toBe(true);
    expect(reject.body).toMatchObject({ code: "invalid_item_transition" });
    const { rows } = await db.query(`SELECT status FROM items WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("reserved"); // nothing changed

    // stored → reserved / sold rejected without side effects
    const flip = await callTool(ownerTools, "update_listing", { id, status: "active" });
    expect(flip.isError).toBe(false);
    await callTool(ownerTools, "update_listing", { id, status: "stored" });
    for (const to of ["reserved", "sold"]) {
      const r = await callTool(ownerTools, "update_listing", { id, status: to });
      expect(r.isError).toBe(true);
      expect(r.body).toMatchObject({ code: "invalid_item_transition" });
    }
  });

  it("active → stored with a live order is rejected with item_in_order (DB)", async () => {
    const title = `Orderguard desk ${randomUUID()}`;
    const ownerTools = toolsFor(owner);
    const created = await callTool(ownerTools, "create_listing", {
      title, category: "other", price_cents: 5000, currency: "EUR", shipping_tier: "parcel",
      images: ["https://img.example.com/d.jpg"], status: "active",
    });
    const id = created.body.item.id as string;
    itemIds.push(id);

    // Direct order row (pending = live): the guard must refuse the save.
    await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, price_cents, currency, fulfillment)
       VALUES ($1, $2, $3, 'pending', 5000, 'EUR', 'shipping')`,
      [id, owner.id, other.id],
    );
    const rejected = await callTool(ownerTools, "update_listing", { id, status: "stored" });
    expect(rejected.isError).toBe(true);
    expect(rejected.body).toMatchObject({ code: "item_in_order" });
    const { rows } = await db.query(`SELECT status FROM items WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("active");

    // Once the order is terminal, storing is allowed again.
    await db.query(`UPDATE orders SET status = 'cancelled' WHERE item_id = $1`, [id]);
    const ok = await callTool(ownerTools, "update_listing", { id, status: "stored" });
    expect(ok.isError).toBe(false);
    expect(ok.body.item.status).toBe("stored");
  });

  it("suspended (report-moderation PR 2): hidden everywhere, owner-visible in my_listings, edits inert, restorable", async () => {
    const title = `Suspend radio ${randomUUID()}`;
    const ownerTools = toolsFor(owner);
    const created = await callTool(ownerTools, "create_listing", {
      title, category: "other", price_cents: 900, currency: "EUR", shipping_tier: "parcel",
      images: ["https://img.example.com/s.jpg"], status: "active",
    });
    const id = created.body.item.id as string;
    itemIds.push(id);

    // Admin-leg equivalence: exactly the suspend route's write (the route
    // itself — auth matrix, eligibility, owner email — is covered in
    // notify-item-events.test.ts).
    await db.query(`UPDATE items SET status = 'suspended' WHERE id = $1`, [id]);

    // Hidden from the MCP surface for everyone — including the owner (no
    // carve-out, unlike stored; the owner's visibility is my_listings below).
    for (const viewer of [null, other, owner]) {
      const get = await callTool(toolsFor(viewer), "get_item", { id });
      expect(get.isError).toBe(true);
      expect(get.body).toMatchObject({ code: "not_found" });
    }

    // Public item page 404s like a deleted item.
    const page = stubResponse(id);
    await itemPage(page.req, page.res as unknown as Response);
    expect(page.res.statusCode).toBe(404);

    // The seller still sees it in their own listings — with the status that
    // explains why it vanished from the marketplace.
    const mine = await callTool(ownerTools, "my_listings", {});
    const listed = (mine.body.items as Array<{ id: string; status: string }>).find((i) => i.id === id);
    expect(listed).toBeTruthy();
    expect(listed!.status).toBe("suspended");

    // Field edits stay possible (inert while hidden) — only status moves are
    // fenced. The fence keeps the listing from being un-suspended or stored.
    const edit = await callTool(ownerTools, "update_listing", { id, price_cents: 750 });
    expect(edit.isError).toBe(false);
    expect(edit.body.item.status).toBe("suspended");
    const move = await callTool(ownerTools, "update_listing", { id, status: "stored" });
    expect(move.isError).toBe(true);
    expect(move.body).toMatchObject({ code: "invalid_item_transition" });

    // Reinstatement leg: exactly the reinstate route's write — visible again
    // everywhere, nothing lost.
    await db.query(`UPDATE items SET status = 'active' WHERE id = $1`, [id]);
    const backGet = await callTool(toolsFor(null), "get_item", { id });
    expect(backGet.isError).toBe(false);
    const backPage = stubResponse(id);
    await itemPage(backPage.req, backPage.res as unknown as Response);
    expect(backPage.res.statusCode).toBe(200);
  });

  it("item page shows stored items to the signed-in owner (200)", async () => {
    const title = `Owner page radio ${randomUUID()}`;
    const ownerTools = toolsFor(owner);
    const created = await callTool(ownerTools, "create_listing", {
      title, category: "other", price_cents: 700, currency: "EUR", shipping_tier: "parcel",
      images: ["https://img.example.com/r.jpg"], status: "stored",
    });
    const id = created.body.item.id as string;
    itemIds.push(id);

    const secret = process.env.SESSION_SECRET ?? "dev-secret";
    void secret; // MAC key comes from SESSION_SECRET env inside signSession
    const cookie = `${SESSION_COOKIE}=${signSession(owner.id)}`;
    const ownPage = stubResponse(id, cookie);
    await itemPage(ownPage.req, ownPage.res as unknown as Response);
    expect(ownPage.res.statusCode).toBe(200);
  });
});

/** Minimal Request/Response doubles for itemPage: protocol/get feed
 *  baseUrlFromRequest; headers.cookie feeds sellerFromSession. */
function stubResponse(itemId: string, cookie?: string) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  const req = { params: { id: itemId }, headers, protocol: "http", get: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
  const res: { statusCode: number; body: string; status(code: number): unknown; send(html: string): unknown } = {
    statusCode: 0,
    body: "",
    status(code) { this.statusCode = code; return this; },
    send(html) { this.body = html; if (this.statusCode === 0) this.statusCode = 200; return this; },
  };
  return { req, res };
}
