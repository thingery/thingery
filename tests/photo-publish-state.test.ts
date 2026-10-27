// THI-308 PR 2 — surface photo-gated publish state in MCP tools + chat.
// Spec rev 2 (CEO-accepted 2026-10-27), test-plan bullets: create_listing
// zero-image result has photo_required:true / visible:false + next_steps;
// add_item_image result visible:true after first upload on a pending item;
// itemToPublic.needs_photo both states; chat create result carries the
// photo note; existing tool signatures unchanged (additive assertion).
//
// Part 1 is pure (registration + itemToPublic, no handler runs against the
// DB). Part 2 is DB-backed (skipped when no Postgres is reachable) and
// invokes the captured create_listing / add_item_image handlers plus chat
// executeTool against a seeded schema.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemToPublic, registerTools } from "../src/tools.js";
import { executeTool } from "../src/chat.js";
import { visibleInFeeds } from "../src/items.js";
import type { ItemRow, SellerRow } from "../src/db.js";

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

// ---------------------------------------------------------------------------
// Part 1 — pure: itemToPublic.needs_photo + additive signature assertions

/** Minimal ItemRow fixture; only the fields itemToPublic derives from vary. */
function fakeItem(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    seller_id: "00000000-0000-0000-0000-000000000002",
    title: "Fixture item",
    description: "",
    category: "other",
    condition: "good",
    brand: null,
    price_cents: 12500,
    currency: "EUR",
    location: null,
    weight_grams: null,
    dimensions_mm: null,
    shipping_tier: "unknown",
    shipping_price_cents: 500,
    images: [],
    attributes: {},
    status: "active",
    photo_required: true,
    created_at: new Date("2026-10-27T00:00:00Z"),
    ...overrides,
  };
}

interface Captured {
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Registers the MCP tools against a stub server; handlers are invoked
 *  directly in Part 2 with a real seller in ctx. */
function registerMcp(ctx: { seller: SellerRow | null }): Map<string, Captured> {
  const registered = new Map<string, Captured>();
  registerTools(
    {
      registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
        registered.set(name, { config, handler });
      },
    },
    ctx,
  );
  return registered;
}

/** Unwraps an ok() tool result envelope to its JSON payload. */
function payload(result: unknown): Record<string, unknown> {
  const text = ((result as { content: Array<{ type: string; text: string }> }).content)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("itemToPublic needs_photo (pure)", () => {
  it("pending zero-photo photo-gated item → needs_photo true", () => {
    expect(itemToPublic(fakeItem()).needs_photo).toBe(true);
  });

  it("photo-gated item with images → needs_photo false", () => {
    expect(itemToPublic(fakeItem({ images: ["https://cdn.example/a.jpg"] })).needs_photo).toBe(false);
  });

  it("grandfathered zero-photo item (photo_required=false) → needs_photo false", () => {
    expect(itemToPublic(fakeItem({ photo_required: false })).needs_photo).toBe(false);
  });

  it("existing fields unchanged (additive only)", () => {
    const pub = itemToPublic(fakeItem({ price_cents: 12500, currency: "EUR" }));
    expect(pub.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(pub.title).toBe("Fixture item");
    expect(pub.price).toEqual({ amount: 125, currency: "EUR", cents: 12500 });
    expect(pub.orderable).toBe(true);
    expect(pub.url).toContain("/item/00000000-0000-0000-0000-000000000001");
    expect(pub.images).toEqual([]);
    expect(pub.photo_required).toBe(true); // passthrough column, present pre-PR2
  });
});

describe("tool signatures unchanged (additive, pure)", () => {
  it("create_listing inputSchema keeps exactly its fields (no rename/removal)", () => {
    const schema = registerMcp({ seller: null }).get("create_listing")?.config.inputSchema ?? {};
    expect(Object.keys(schema).sort()).toEqual(
      [
        "title", "description", "category", "condition", "brand", "price_cents",
        "currency", "location", "weight_grams", "dimensions_mm", "shipping_tier",
        "images", "attributes",
      ].sort(),
    );
  });

  it("add_item_image inputSchema keeps exactly its fields", () => {
    const schema = registerMcp({ seller: null }).get("add_item_image")?.config.inputSchema ?? {};
    expect(Object.keys(schema).sort()).toEqual(["item_id", "image_base64", "media_type"].sort());
  });

  it("create_listing description keeps prior sentences and adds the photo-gate sentence", () => {
    const description = registerMcp({ seller: null }).get("create_listing")?.config.description ?? "";
    expect(description).toContain("Requires seller authentication (Bearer API key)");
    expect(description).toContain("call describe_category first");
    expect(description).toContain("Listings are hidden from search until they have at least one photo.");
  });
});

describe("visibleInFeeds — JS twin of FEED_VISIBLE (pure)", () => {
  it("active + photo gate satisfied either way", () => {
    expect(visibleInFeeds(fakeItem({ images: ["x"] }))).toBe(true);
    expect(visibleInFeeds(fakeItem({ photo_required: false }))).toBe(true);
    expect(visibleInFeeds(fakeItem())).toBe(false);
    expect(visibleInFeeds(fakeItem({ images: ["x"], status: "reserved" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed (skips without a reachable Postgres)

// Real image fixture generated with sharp (THI-156 convention): the
// re-encode pipeline decodes every stored upload.
const PNG_BYTES = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 120, b: 160 } } })
  .png()
  .toBuffer();

describe.skipIf(!available)("create_listing publish state (DB)", () => {
  let db: pg.Client;
  let uploadsTmp: string;
  let n = 0;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers, seller_upload_quota RESTART IDENTITY CASCADE");
    uploadsTmp = await mkdtemp(path.join(os.tmpdir(), "thi308-pr2-uploads-"));
    process.env.UPLOADS_DIR = uploadsTmp;
  });

  afterAll(async () => {
    delete process.env.UPLOADS_DIR;
    await rm(uploadsTmp, { recursive: true, force: true });
    await db.end();
  });

  /** Fresh seller row + matching ctx; unique per call. */
  async function seedSeller(): Promise<{ seller: SellerRow; sellerId: string }> {
    n += 1;
    const tag = `thi308-pr2-${n}`;
    const res = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id, display_name",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    return {
      sellerId: res.rows[0].id as string,
      seller: { id: res.rows[0].id as string, display_name: res.rows[0].display_name as string },
    };
  }

  const createArgs = (images: string[]) => ({
    title: "PR2 fixture item",
    description: "fixture",
    category: "other",
    condition: "good",
    price_cents: 12500,
    currency: "EUR",
    shipping_tier: "unknown",
    images,
    attributes: {},
  });

  it("zero-image create: photo_required true, visible false, next_steps tells how to publish", async () => {
    const { seller } = await seedSeller();
    const handler = registerMcp({ seller }).get("create_listing")!.handler;
    const result = payload(await handler(createArgs([])));
    expect(result.created).toBe(true);
    expect(result.photo_required).toBe(true);
    expect(result.visible).toBe(false);
    const item = result.item as Record<string, unknown>;
    expect(item.needs_photo).toBe(true);
    const steps = result.next_steps as string[];
    expect(steps.some((s) => s.includes("add_item_image"))).toBe(true);
    expect(steps.some((s) => s.includes("upload a photo there") && s.includes("/item/"))).toBe(true);
    // The "share with buyers" step must NOT imply the listing is live.
    expect(steps.some((s) => s.includes("Share the item URL with potential buyers"))).toBe(false);
  });

  it("create with one image: visible true, needs_photo false, share-url next_steps", async () => {
    const { seller } = await seedSeller();
    const handler = registerMcp({ seller }).get("create_listing")!.handler;
    const result = payload(await handler(createArgs(["https://cdn.example/a.jpg"])));
    expect(result.photo_required).toBe(true);
    expect(result.visible).toBe(true);
    expect((result.item as Record<string, unknown>).needs_photo).toBe(false);
    expect((result.next_steps as string[]).some((s) => s.includes("Share the item URL with potential buyers"))).toBe(true);
  });

  it("add_item_image first upload on a pending item: visible true (published)", async () => {
    const { seller, sellerId } = await seedSeller();
    const inserted = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) VALUES ($1, $2, 10000, 500) RETURNING id, photo_required",
      [sellerId, "Pending upload item"],
    );
    const itemId = inserted.rows[0].id as string;
    expect(inserted.rows[0].photo_required).toBe(true); // column default: pending
    const handler = registerMcp({ seller }).get("add_item_image")!.handler;
    const result = payload(
      await handler({
        item_id: itemId,
        image_base64: PNG_BYTES.toString("base64"),
        media_type: "image/png",
      }),
    );
    expect(result.added).toBe(true);
    expect(result.image_url).toContain("/img/items/");
    expect(result.visible).toBe(true);
    // ...and the item row itself is now feed-visible with needs_photo cleared.
    const row = await db.query("SELECT images, photo_required FROM items WHERE id = $1", [itemId]);
    expect(visibleInFeeds({ status: "active", photo_required: row.rows[0].photo_required, images: row.rows[0].images })).toBe(true);
  });

  it("chat create_listing result carries photo_required/visible:false + photo note with the item URL", async () => {
    const { seller } = await seedSeller();
    const result = (await executeTool(
      "create_listing",
      { title: "Chat fixture item", price_cents: 9000, category: "other" },
      seller,
    )) as Record<string, unknown>;
    expect(result.created).toBe(true);
    expect(result.photo_required).toBe(true);
    expect(result.visible).toBe(false);
    const note = result.photo_note as string;
    expect(note).toContain("hidden from search");
    expect(note).toContain("add a photo");
    expect(note).toContain(result.url as string);
  });
});
