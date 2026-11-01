// Response loop (spec THI-439 rev 1 §5, B4 — PR 3): respondToWanted's
// validate→create→link order, the photo-gated publish stamping (birth stamp
// at respond-with-photo; addItemImage's first-photo transition stamps pending
// responses, idempotently), typed rejections (not_found / own_wanted /
// not_active / response_limit, all before any items write), the buyer's
// responses read model with markRead, graceful degradation when the link-row
// insert fails, and wanted_response events. DB-backed (skips without
// Postgres); conventions follow tests/intent-publish.test.ts.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db.js";
import { createItem } from "../src/items.js";
import { addItemImage } from "../src/images.js";
import * as wanted from "../src/wanted.js";
import {
  respondToWanted,
  listWantedResponses,
  WantedResponseError,
} from "../src/wanted-responses.js";
import { createWanted } from "../src/wanted.js";

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

function spyLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
function spyError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
function events(spy: ReturnType<typeof spyLog>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((v): v is string => typeof v === "string")
    .map((line) => JSON.parse(line))
    .filter((o) => typeof o === "object" && o !== null && "type" in o && "ts" in o);
}

describe.skipIf(!available)("wanted response loop (DB)", () => {
  let client: pg.Client;
  let uploadsDir: string;
  const peopleIds: string[] = [];

  async function seedPerson(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      // Plain hash fixture — never a thg_ live-key shape (gitleaks rule).
      [`respond-fixture-${nonce}`, `respond-${tag}`, `respond-${tag}-${nonce}@t.dev`],
    );
    peopleIds.push(rows[0].id);
    return rows[0].id;
  }

  async function seedWanted(buyer: string, title: string): Promise<string> {
    const w = await createWanted(buyer, { title });
    return w.id;
  }

  const listing = (title: string, images: string[] = []) => ({
    title,
    description: "response listing",
    category: "other",
    condition: "good" as const,
    price_cents: 10000,
    currency: "EUR",
    shipping_tier: "locker",
    images,
  });

  const png = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).png().toBuffer();

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    uploadsDir = mkdtempSync(path.join(tmpdir(), "thi440-respond-"));
    process.env.UPLOADS_DIR = uploadsDir;
  });

  afterAll(async () => {
    delete process.env.UPLOADS_DIR;
    if (uploadsDir) rmSync(uploadsDir, { recursive: true, force: true });
    await client.query(`DELETE FROM wanted_buyer_quota WHERE buyer_id = ANY($1::uuid[])`, [peopleIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [peopleIds]);
    await client.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // THI-442 rider W2 (assert-only: THI-380 R4 strip landed via THI-360
  // PR 4): every item-bearing wanted payload must stay embedding-free
  // across surfaces — respond_to_wanted's item and the buyer's response
  // read. The ~1536-dim vector must never ride `...rest` out.
  it("item-bearing wanted payloads carry no embedding (W2, THI-380 R4)", async () => {
    const { itemToPublic } = await import("../src/tools.js");
    const buyer = await seedPerson("rb-w2");
    const seller = await seedPerson("rs-w2");
    const wantedId = await seedWanted(buyer, "W2 embedding probe wanted");
    const { item, response } = await respondToWanted(seller, wantedId, listing("W2 embedding probe listing", ["https://cdn.t.dev/w2.jpg"]));
    expect(response.id).not.toBe("");

    // Tool surface: the item exactly as respond_to_wanted returns it.
    const publicItem = itemToPublic({ ...item, embedding: new Array(1536).fill(0.1) });
    expect("embedding" in publicItem).toBe(false);

    // Buyer read surface: items joined into listWantedResponses responses.
    const { responses, total } = await listWantedResponses(buyer, wantedId);
    expect(total).toBe(1); // photo at respond → born published → total 1
    expect(responses).toHaveLength(1);
    for (const r of responses) {
      expect((r.item as { embedding?: unknown }).embedding ?? null).toBeNull();
    }
  });

  it("respond with a photo: listing published at birth, buyer sees the response unread", async () => {
    const buyer = await seedPerson("rb-a");
    const seller = await seedPerson("rs-a");
    const wantedId = await seedWanted(buyer, "Camera response probe wanted");
    const spy = spyLog();

    const { item, response } = await respondToWanted(seller, wantedId, listing("Camera response probe listing", ["https://cdn.t.dev/cam.jpg"]));
    expect(response.published_at).not.toBeNull(); // photo at respond → born published
    expect(item.images).toHaveLength(1);
    expect(response.id).toBeTruthy();

    const { responses } = await listWantedResponses(buyer, wantedId);
    expect(responses).toHaveLength(1);
    expect(responses[0].item.id).toBe(item.id);
    expect(responses[0].published_at).not.toBeNull();
    expect(responses[0].read).toBe(false);

    // Events: respond success + birth publish, ids only.
    const evts = events(spy).filter((e) => e.type === "wanted_response");
    expect(evts.some((e) => e.action === "respond" && e.outcome === "success" && e.sellerId === seller)).toBe(true);
    expect(evts.some((e) => e.action === "publish" && e.outcome === "success" && e.count === 1)).toBe(true);
  });

  it("respond without a photo: pending response; first photo publishes it; second photo is a no-op", async () => {
    const buyer = await seedPerson("rb-b");
    const seller = await seedPerson("rs-b");
    const wantedId = await seedWanted(buyer, "Keyboard response probe wanted");
    const { item } = await respondToWanted(seller, wantedId, listing("Keyboard response probe listing"));
    expect(item.images).toHaveLength(0); // photo gate: pending

    // Pending responses are invisible to the buyer's read model (§4).
    expect((await listWantedResponses(buyer, wantedId)).responses).toHaveLength(0);

    const first = await addItemImage(seller, item.id, await png(), "image/png");
    expect("url" in first).toBe(true);
    let responses = (await listWantedResponses(buyer, wantedId)).responses;
    expect(responses).toHaveLength(1);
    expect(responses[0].published_at).not.toBeNull();

    const again = await addItemImage(seller, item.id, await png(), "image/png");
    expect("url" in again).toBe(true);
    responses = (await listWantedResponses(buyer, wantedId)).responses;
    expect(responses).toHaveLength(1); // idempotent: no duplicate, no re-stamp
    const stampedAt = responses[0].published_at;
    const { rows: fresh } = await client.query<{ published_at: Date }>(
      `SELECT published_at FROM wanted_responses WHERE item_id = $1`,
      [item.id],
    );
    expect(fresh[0].published_at.getTime()).toBe(stampedAt!.getTime());
  });

  it("createItem with a photo stamps pending responses too (hook transition 1)", async () => {
    const buyer = await seedPerson("rb-c");
    const wantedId = await seedWanted(buyer, "Standalone stamping probe wanted");
    const { item } = await respondToWanted(await seedPerson("rs-c"), wantedId, listing("Standalone stamping probe listing"));
    expect((await listWantedResponses(buyer, wantedId)).responses).toHaveLength(0); // pending
    // A direct createItem with a photo that happens to carry the same item id
    // cannot happen (fresh ids); instead prove the hook via
    // markWantedResponsesPublished, then the addItemImage path above covers
    // transition 2 end-to-end.
    const stamped = await wanted.markWantedResponsesPublished(item.id);
    expect(stamped).toBe(1);
    expect((await listWantedResponses(buyer, wantedId)).responses).toHaveLength(1);
    // Re-stamp is a no-op.
    expect(await wanted.markWantedResponsesPublished(item.id)).toBe(0);
  });

  it("typed rejections all happen before any items write", async () => {
    const buyer = await seedPerson("rb-d");
    const seller = await seedPerson("rs-d");
    const nonexistent = randomUUID();
    const own = await seedWanted(seller, "Own wanted probe");
    const expiredStatus = await seedWanted(buyer, "Expired status probe wanted");
    await wanted.updateWanted(expiredStatus, buyer, { expire: true });
    const staleActive = await seedWanted(buyer, "Stale active probe wanted");
    await client.query(`UPDATE wanted_items SET expires_at = now() - interval '1 hour' WHERE id = $1`, [staleActive]);

    const querySpy = vi.spyOn(pool, "query");
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => respondToWanted(seller, nonexistent, listing("Never created one")), "not_found"],
      [() => respondToWanted(seller, own, listing("Never created two")), "own_wanted"],
      [() => respondToWanted(seller, expiredStatus, listing("Never created three")), "not_active"],
      [() => respondToWanted(seller, staleActive, listing("Never created four")), "not_active"],
    ];
    // Create each promise just before awaiting it — creating them up front
    // would leave later rejections unawaited while earlier ones resolve
    // (node PromiseRejectionHandledWarning → vitest unhandled-error noise).
    for (const [make, code] of cases) {
      await expect(make()).rejects.toMatchObject({ code });
    }
    // No listing INSERT ever ran — the seller's quota was never spent.
    const insertTexts = querySpy.mock.calls.map((c) => String(c[0]));
    expect(insertTexts.some((t) => t.includes("INSERT INTO items"))).toBe(false);
    const { rows: items } = await client.query(`SELECT count(*) AS n FROM items WHERE seller_id = $1`, [seller]);
    expect(items[0].n).toBe("0");
  });

  it("response cap: the 4th response to the same wanted is rejected", async () => {
    const buyer = await seedPerson("rb-e");
    const seller = await seedPerson("rs-e");
    const wantedId = await seedWanted(buyer, "Cap probe wanted");
    for (let i = 0; i < 3; i++) {
      const { response } = await respondToWanted(seller, wantedId, listing(`Cap probe listing ${i}`));
      expect(response.id).toBeTruthy();
    }
    await expect(respondToWanted(seller, wantedId, listing("Cap probe listing over"))).rejects.toMatchObject({
      code: "response_limit",
    });
    // A different seller can still respond.
    const other = await respondToWanted(await seedPerson("rs-e2"), wantedId, listing("Cap probe other seller"));
    expect(other.response.id).toBeTruthy();
  });

  it("listWantedResponses: newest first, markRead stamps once and is a no-op after", async () => {
    const buyer = await seedPerson("rb-f");
    const seller = await seedPerson("rs-f");
    const wantedId = await seedWanted(buyer, "Read model probe wanted");
    const a = await respondToWanted(seller, wantedId, listing("Read model probe one", ["https://cdn.t.dev/1.jpg"]));
    await new Promise((r) => setTimeout(r, 15));
    const b = await respondToWanted(seller, wantedId, listing("Read model probe two", ["https://cdn.t.dev/2.jpg"]));

    const first = (await listWantedResponses(buyer, wantedId)).responses;
    expect(first.map((r) => r.item.id)).toEqual([b.item.id, a.item.id]); // newest first
    expect(first.every((r) => !r.read)).toBe(true);

    const { markedRead } = await listWantedResponses(buyer, wantedId, { markRead: true });
    expect(markedRead).toBe(2);
    // Second markRead: read → read no-op (nothing newly marked).
    const second = await listWantedResponses(buyer, wantedId, { markRead: true });
    expect(second.markedRead).toBe(0);
    expect(second.responses.every((r) => r.read)).toBe(true);

    // Ownership: a different buyer sees nothing for this wanted.
    const outsider = await seedPerson("rb-f2");
    expect((await listWantedResponses(outsider, wantedId)).responses).toHaveLength(0);
  });

  // THI-442 rider W4 regression: responses-per-wanted is bounded per seller
  // (3) but NOT across sellers, so the buyer's read must bound its own
  // payload — latest 20 + exact total. 25 sellers × 1 published response
  // each: the window is the newest 20 (the oldest response falls out) and
  // a caller asking for more still gets 20. Fails against an unclamped
  // read (API4:2023 Unrestricted Resource Consumption — griefer-seller
  // bloat of the buyer's protected read).
  it("W4: 25 published responses clamp to the newest 20 with an exact total", async () => {
    const buyer = await seedPerson("rb-w4");
    const wantedId = await seedWanted(buyer, "W4 window probe wanted");
    const itemIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const seller = await seedPerson(`rs-w4-${i}`);
      const { item } = await respondToWanted(
        seller,
        wantedId,
        listing(`W4 window probe listing ${i}`, [`https://cdn.t.dev/w4-${i}.jpg`]),
      );
      itemIds.push(item.id);
    }

    const page = await listWantedResponses(buyer, wantedId);
    expect(page.total).toBe(25); // exact count beside the truncated window
    expect(page.responses).toHaveLength(20); // clamped, not 25
    expect(page.responses[0].item.id).toBe(itemIds[24]); // newest first
    expect(page.responses.map((r) => r.item.id)).not.toContain(itemIds[0]); // oldest fell out

    // A caller asking for more than 20 still gets 20 (clamp, not default).
    const greedy = await listWantedResponses(buyer, wantedId, { limit: 100 });
    expect(greedy.responses).toHaveLength(20);
    expect(greedy.total).toBe(25);

    // markRead stamps only the returned window.
    const marked = await listWantedResponses(buyer, wantedId, { markRead: true });
    expect(marked.markedRead).toBe(20);
    const unread = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM wanted_responses WHERE wanted_item_id = $1 AND read_at IS NULL`,
      [wantedId],
    );
    expect(unread.rows[0].n).toBe("5"); // the 5 outside the window stay unread
  });

  it("graceful degradation: link-row insert failure keeps the listing, logs, returns empty response id", async () => {
    const buyer = await seedPerson("rb-g");
    const seller = await seedPerson("rs-g");
    const wantedId = await seedWanted(buyer, "Degrade probe wanted");
    const errSpy = spyError();
    const logSpy = spyLog();
    const realQuery = pool.query.bind(pool);
    const querySpy = vi
      .spyOn(pool, "query")
      .mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.includes("INSERT INTO wanted_responses")) {
          return Promise.reject(new Error("forced responses outage"));
        }
        return (realQuery as (t: unknown, ...r: unknown[]) => Promise<unknown>)(text, ...rest);
      }) as typeof pool.query);

    const { item, response } = await respondToWanted(seller, wantedId, listing("Degrade probe listing"));
    expect(item.id).toBeTruthy(); // the listing survived
    expect(response.id).toBe(""); // no link row
    expect(errSpy).toHaveBeenCalled();
    const evts = events(logSpy).filter((e) => e.type === "wanted_response");
    expect(evts.some((e) => e.action === "respond" && e.outcome === "degraded")).toBe(true);
    querySpy.mockRestore();
  });

  it("stamp failure never fails the photo publish (never-fail hook contract)", async () => {
    const buyer = await seedPerson("rb-h");
    const seller = await seedPerson("rs-h");
    const wantedId = await seedWanted(buyer, "Stamp failure probe wanted");
    const { item } = await respondToWanted(seller, wantedId, listing("Stamp failure probe listing"));
    const stampSpy = vi.spyOn(wanted, "markWantedResponsesPublished").mockRejectedValue(new Error("forced stamping outage"));
    const added = await addItemImage(seller, item.id, await png(), "image/png");
    expect("url" in added).toBe(true); // publish survived
    expect(stampSpy).toHaveBeenCalled();
  });

  it("respond_to_wanted rejections map to WantedResponseError codes", async () => {
    const buyer = await seedPerson("rb-i");
    const seller = await seedPerson("rs-i");
    const own = await seedWanted(seller, "Error class probe");
    await expect(respondToWanted(seller, own, listing("Error class listing"))).rejects.toBeInstanceOf(
      WantedResponseError,
    );
    const nonexistent = "00000000-0000-0000-0000-0000000000e1";
    await expect(respondToWanted(seller, nonexistent, listing("Error class listing"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("respond with a photo also runs the full listing rails (intent fanout still fires)", async () => {
    // The response listing is a real listing: createItem's publish hook
    // (intents + stamping) ran at create — proven indirectly by the listing
    // being feed-visible and a wanted_write-independent intent row appearing
    // when a matching intent exists.
    const buyer = await seedPerson("rb-j");
    const intentBuyer = await seedPerson("rb-j2");
    const seller = await seedPerson("rs-j");
    await client.query(
      `INSERT INTO buyer_intents (buyer_id, q, category) VALUES ($1, $2, 'other')`,
      [intentBuyer, "rails probe listing"],
    );
    const wantedId = await seedWanted(buyer, "Rails probe wanted");
    const { item } = await respondToWanted(seller, wantedId, listing("Rails probe listing", ["https://cdn.t.dev/r.jpg"]));
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM intent_matches WHERE item_id = $1`,
      [item.id],
    );
    expect(rows[0].n).toBe("1"); // fanout ran on the response listing's publish
  });
});
