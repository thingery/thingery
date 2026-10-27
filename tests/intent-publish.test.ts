// Buyer alerts PR 3 (spec THI-360 rev 2 §6) — publish transitions. The two
// hooks: createItem fans out only when the new listing is already
// feed-visible (photo at create); addItemImage fans out only when appending
// the first photo publishes a pending listing (THI-308). Alerting must never
// fail the publish. DB-backed (skips when no Postgres is reachable); seed and
// cleanup conventions follow tests/intent-matches.test.ts.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createItem } from "../src/items.js";
import { addItemImage } from "../src/images.js";
import * as intents from "../src/intents.js";

delete process.env.EMBED_API_KEY; // keyword leg only in CI

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

describe.skipIf(!available)("intent evaluation at publish transitions (DB)", () => {
  let client: pg.Client;
  let uploadsDir: string;
  const sellerIds: string[] = [];

  async function seedSeller(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      // Plain hash fixture — never a thg_ live-key shape (gitleaks rule).
      [`publish-fixture-${nonce}`, `publish-${tag}`, `publish-${tag}-${nonce}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return rows[0].id;
  }

  async function seedMatchingIntent(buyer: string, q: string): Promise<void> {
    await client.query(
      `INSERT INTO buyer_intents (buyer_id, q, category) VALUES ($1, $2, 'bikes')`,
      [buyer, q],
    );
  }

  async function matchCount(itemId: string): Promise<string> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM intent_matches WHERE item_id = $1`,
      [itemId],
    );
    return rows[0].n;
  }

  const input = (sellerId: string, images: string[], title: string) => ({
    seller_id: sellerId,
    title,
    description: "road season cleanup",
    category: "bikes",
    condition: "good",
    price_cents: 20000,
    currency: "EUR",
    shipping_tier: "locker",
    images,
  });

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    uploadsDir = mkdtempSync(path.join(tmpdir(), "thi360-publish-"));
    process.env.UPLOADS_DIR = uploadsDir;
  });

  afterAll(async () => {
    delete process.env.UPLOADS_DIR;
    if (uploadsDir) rmSync(uploadsDir, { recursive: true, force: true });
    await client.query(`DELETE FROM intent_matches WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerIds]);
    await client.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pending listing (no photo at create) never triggers evaluation", async () => {
    const seller = await seedSeller("pend-s");
    await seedMatchingIntent(await seedSeller("pend-b"), "pending publish probe bike");
    const spy = vi.spyOn(intents, "evaluateListingForIntents");
    const item = await createItem(input(seller, [], "Pending publish probe bike")); // photo_required default
    expect(item.photo_required).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // THI-308: not feed-visible
    expect(await matchCount(item.id)).toBe("0");
  });

  it("create with a photo (feed-visible) fans out to matching intents", async () => {
    const seller = await seedSeller("crt-s");
    const buyer = await seedSeller("crt-b");
    await seedMatchingIntent(buyer, "create publish probe bike");
    const item = await createItem(input(seller, ["https://cdn.t.dev/bike.png"], "Create publish probe bike"));
    expect(await matchCount(item.id)).toBe("1");
  });

  it("first addItemImage publishes a pending listing → match appears exactly once", async () => {
    const seller = await seedSeller("img-s");
    const buyer = await seedSeller("img-b");
    await seedMatchingIntent(buyer, "image publish probe bike");
    const item = await createItem(input(seller, [], "Image publish probe bike"));
    expect(await matchCount(item.id)).toBe("0");
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .png()
      .toBuffer();
    const added = await addItemImage(seller, item.id, png, "image/png");
    expect("url" in added).toBe(true);
    expect(await matchCount(item.id)).toBe("1");
    // Second photo: already published, no transition → no re-evaluation.
    const again = await addItemImage(seller, item.id, png, "image/png");
    expect("url" in again).toBe(true);
    expect(await matchCount(item.id)).toBe("1"); // idempotent either way
  });

  it("forced evaluation failure never fails the publish (create and image)", async () => {
    const seller = await seedSeller("err-s");
    vi.spyOn(intents, "evaluateListingForIntents").mockRejectedValue(new Error("forced evaluation outage"));
    const created = await createItem(input(seller, ["https://cdn.t.dev/ok.png"], "Error publish probe bike"));
    expect(created.id).toBeTruthy(); // publish survived
    const pending = await createItem(input(seller, [], "Error publish probe bike two"));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .png()
      .toBuffer();
    const added = await addItemImage(seller, pending.id, png, "image/png");
    expect("url" in added).toBe(true); // image append survived too
  });
});
