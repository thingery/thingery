// Order reviews — public read side (spec docs/specs/order-reviews.md, PR 2):
// GET /api/sellers/:id/reviews and the get_seller_reviews MCP tool. Covers
// the read arms of the spec test plan: 10 (public list, privacy shape),
// 11 (MCP tool parity + content_provenance), 15 (per-pair aggregate cap K)
// and 17 (same-timestamp cursor tie-break). DB-backed, skip-guarded without
// Postgres (CI runs it); harness as tests/order-reviews.test.ts, but rows
// are seeded directly with explicit created_at (the PR-1 clock approach:
// back-date in SQL) so ordering, caps and ties are deterministic.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountApiRoutes } from "../src/routes.js";
import { registerTools } from "../src/tools.js";
import { MASKED_BUYER_FIRST_NAME } from "../src/reviews.js";
import type { SellerRow } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

describe.skipIf(!available)("order reviews — public read (spec docs/specs/order-reviews.md, PR 2)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let sellerId = "";
  const createdOrderIds: string[] = [];
  const createdSellerIds: string[] = [];

  async function mkSeller(name: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`thi941r-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
    );
    createdSellerIds.push(r.rows[0].id);
    return r.rows[0].id;
  }

  /** Seeds one published (or hidden) review on a fresh completed order for
   *  `buyer`, sold by `seller` (defaults to the file seller), with an
   *  explicit created_at and first-name snapshot (default "Luca", the
   *  pre-THI-979 fixture name). */
  async function seedReview(opts: {
    buyer: string;
    rating: number;
    createdAt: Date;
    text?: string | null;
    status?: "published" | "hidden";
    title?: string;
    seller?: string;
    firstName?: string;
  }): Promise<string> {
    const seller = opts.seller ?? sellerId;
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, $2, 100, 'other') RETURNING id`,
      [seller, opts.title ?? "Film camera"],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, status)
       VALUES ($1, $2, $3, 100, 0, 'EUR', 'pickup', 'off_platform', 'completed') RETURNING id`,
      [item.rows[0].id, seller, opts.buyer],
    );
    createdOrderIds.push(order.rows[0].id);
    const r = await db.query<{ id: string }>(
      `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, text, status, buyer_first_name, item_title, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        order.rows[0].id,
        seller,
        opts.buyer,
        item.rows[0].id,
        opts.rating,
        opts.text ?? null,
        opts.status ?? "published",
        opts.firstName ?? "Luca",
        opts.title ?? "Film camera",
        opts.createdAt,
      ],
    );
    return r.rows[0].id;
  }

  function get(query: string, seller = sellerId): Promise<{ status: number; json: any; text: string }> {
    return fetch(`${base}/api/sellers/${seller}/reviews${query}`).then(async (r) => {
      const text = await r.text(); // one read; json is a parse of it
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body stays null */
      }
      return { status: r.status, json, text };
    });
  }

  /** The address-tools capture harness: registers every tool against an
   *  in-memory map with an anonymous context (get_seller_reviews is a
   *  public read — it must work with no seller at all). */
  function mcpTools() {
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }>>();
    registerTools(
      {
        registerTool(name: string, _config: unknown, handler: never) {
          handlers.set(name, handler as never);
        },
      } as never,
      { seller: null },
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

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    sellerId = await mkSeller("Marta Seller");

    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    // Cleanup in FK order: reviews → orders → items → sellers.
    if (createdOrderIds.length > 0) {
      await db.query(`DELETE FROM order_reviews WHERE order_id = ANY($1)`, [createdOrderIds]);
      await db.query(`DELETE FROM orders WHERE id = ANY($1)`, [createdOrderIds]);
    }
    await db.query(`DELETE FROM items WHERE seller_id = ANY($1)`, [createdSellerIds]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1)`, [createdSellerIds]);
    await db.end();
  });

  // Test 10 — the public list: newest-first, published only, summary shape,
  // and the privacy contract (no buyer ids / emails / order ids anywhere in
  // the payload; each review's own unguessable id IS present).
  it("lists published reviews newest-first with a rounded summary and no identity leakage", async () => {
    const t0 = new Date("2026-01-01T12:00:00Z");
    const buyerA = await mkSeller("Anna Alpha");
    const buyerB = await mkSeller("Bruno Beta");
    const hidden = await seedReview({ buyer: buyerA, rating: 1, createdAt: t0, status: "hidden", text: "should never appear" });
    const old = await seedReview({ buyer: buyerA, rating: 5, createdAt: new Date(t0.getTime() + 60_000) });
    const mid = await seedReview({ buyer: buyerB, rating: 4, createdAt: new Date(t0.getTime() + 120_000) });
    const new_ = await seedReview({ buyer: buyerB, rating: 1, createdAt: new Date(t0.getTime() + 180_000) });

    const r = await get("");
    expect(r.status).toBe(200);
    expect(r.json.reviews.map((x: { id: string }) => x.id)).toEqual([new_, mid, old]); // newest first
    expect(r.json.reviews.every((x: { id: string }) => x.id !== hidden)).toBe(true);
    expect(r.json.next_before).toBeNull(); // everything fit in the default page
    expect(r.json.summary).toEqual({ average: 3.3, count: 3 }); // (5+4+1)/3, one decimal

    // Privacy: no identity/order keys, no leaked UUIDs, review ids present.
    for (const review of r.json.reviews) {
      expect(Object.keys(review).sort()).toEqual(["created_at", "first_name", "id", "item_title", "rating", "text"]);
    }
    const orderIds = (
      await db.query<{ order_id: string }>("SELECT order_id FROM order_reviews WHERE seller_id = $1", [sellerId])
    ).rows.map((x) => x.order_id);
    const buyerIds = [buyerA, buyerB];
    for (const secret of [...orderIds, ...buyerIds]) {
      expect(r.text).not.toContain(secret);
    }
  });

  it("limit=0 returns the summary only (item-page seller card)", async () => {
    const r = await get("?limit=0");
    expect(r.status).toBe(200);
    expect(r.json.reviews).toEqual([]);
    expect(r.json.next_before).toBeNull();
    expect(typeof r.json.summary.count).toBe("number");
  });

  it("unknown seller → 404; malformed before / bad limit → 400", async () => {
    const unknown = await fetch(`${base}/api/sellers/${crypto.randomUUID()}/reviews`);
    expect(unknown.status).toBe(404);
    const badCursor = await get("?before=not-a-cursor");
    expect(badCursor.status).toBe(400);
    expect(badCursor.json.error).toMatch(/cursor/i);
    const badLimit = await get("?limit=51");
    expect(badLimit.status).toBe(400);
    const nanLimit = await get("?limit=abc");
    expect(nanLimit.status).toBe(400);
    const nonUuidSeller = await fetch(`${base}/api/sellers/not-a-uuid/reviews`);
    expect(nonUuidSeller.status).toBe(404);
  });

  // Test 17 — same-created_at rows: the cursor's id tie-break orders and
  // pages them with no skip and no duplicate. Dedicated seller so the walk
  // sees exactly the two tied rows.
  it("pages same-timestamp reviews via the (created_at, id) tie-break without skipping or repeating", async () => {
    const tieSeller = await mkSeller("Tie Seller");
    const tie = new Date("2026-02-01T09:00:00Z");
    const b1 = await mkSeller("Tie One");
    const b2 = await mkSeller("Tie Two");
    const ids = [
      await seedReview({ buyer: b1, rating: 3, createdAt: tie, seller: tieSeller }),
      await seedReview({ buyer: b2, rating: 4, createdAt: tie, seller: tieSeller }),
    ];
    const expected = [...ids].sort().reverse(); // (created_at, id) DESC

    const seen: string[] = [];
    let query = "?limit=1";
    for (let i = 0; i < 3; i++) {
      const r = await get(query, tieSeller);
      expect(r.status).toBe(200);
      expect(r.json.reviews).toHaveLength(1);
      seen.push(r.json.reviews[0].id);
      if (!r.json.next_before) break;
      query = `?limit=1&before=${encodeURIComponent(r.json.next_before)}`;
    }
    expect(seen).toEqual(expected);
  });

  // Test 15 — per-pair aggregate cap (K = 3): one buyer's 5 published
  // reviews compress to count 3 / average over the 3 newest, while the list
  // still returns all 5; a second buyer's 3 add fully (count 6). Dedicated
  // seller so the counts are exact.
  it("caps the summary per buyer→seller pair (K=3) but never the list", async () => {
    const capSeller = await mkSeller("Cap Seller");
    const t0 = new Date("2026-03-01T10:00:00Z");
    const farmer = await mkSeller("Farmer Pair");
    // Oldest→newest ratings 1,1,1,5,5: capped set is the 3 newest {1,5,5} → 3.7.
    for (let i = 0; i < 5; i++) {
      await seedReview({ buyer: farmer, rating: i < 3 ? 1 : 5, createdAt: new Date(t0.getTime() + i * 60_000), seller: capSeller });
    }
    const capped = await get("?limit=0", capSeller);
    expect(capped.json.summary).toEqual({ average: 3.7, count: 3 });
    const fullList = await get("?limit=50", capSeller);
    expect(fullList.json.reviews).toHaveLength(5);

    // A distinct second buyer × 3 published reviews counts in full: 3 + 3 = 6.
    const honest = await mkSeller("Honest Repeat");
    for (let i = 0; i < 3; i++) {
      await seedReview({ buyer: honest, rating: 5, createdAt: new Date(t0.getTime() + (10 + i) * 60_000), seller: capSeller });
    }
    const six = await get("?limit=0", capSeller);
    expect(six.json.summary.count).toBe(6);
  });

  // THI-979 (SR-5 on PR #319): rows stored before the insert-path F1 fix can
  // carry an email-derived handle in buyer_first_name. The public read
  // re-masks with the shared exact-match rule so legacy rows never publish
  // the handle either; chosen names pass through untouched (exact match
  // only, same semantics as the seller-surface guard). Fails against the
  // unmasked read, which published the stored snapshot verbatim.
  it("masks email-derived first names on already-stored rows at read time (THI-979 F1)", async () => {
    const t0 = new Date("2026-04-01T08:00:00Z");
    const legacySeller = await mkSeller("Legacy Seller");
    // Signup-default buyer: display_name = email local-part (src/routes.ts).
    const localPart = `legacy${crypto.randomUUID().slice(0, 8)}`;
    const handleBuyer = (
      await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
        [`${localPart}@example.test`, localPart],
      )
    ).rows[0]!.id;
    createdSellerIds.push(handleBuyer);
    // A >40-char local-part: the old unmasked path stored its 40-char prefix
    // (buyerFirstName cap = the column CHECK), so the read mask must catch
    // the prefix too.
    const longHandle = `long-${crypto.randomUUID().slice(0, 8)}-with-a-local-part-well-past-forty`;
    expect(longHandle.length).toBeGreaterThan(40);
    const longBuyer = (
      await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
        [`${longHandle}@example.test`, longHandle],
      )
    ).rows[0]!.id;
    createdSellerIds.push(longBuyer);
    // Chosen name that differs from a handle only by case: NOT masked
    // (exact match, same as the seller-surface guard).
    const aliceBuyer = await mkSeller("Alice");

    const legacy = await seedReview({ buyer: handleBuyer, rating: 5, createdAt: t0, seller: legacySeller, firstName: localPart });
    const prefix = await seedReview({ buyer: longBuyer, rating: 4, createdAt: t0, seller: legacySeller, firstName: longHandle.slice(0, 40) });
    const chosen = await seedReview({ buyer: aliceBuyer, rating: 5, createdAt: t0, seller: legacySeller, firstName: "Alice" });

    const r = await get("?limit=50", legacySeller);
    expect(r.status).toBe(200);
    const byId = new Map<string, string>(
      r.json.reviews.map((x: { id: string; first_name: string }) => [x.id, x.first_name]),
    );
    expect(byId.get(legacy)).toBe(MASKED_BUYER_FIRST_NAME);
    expect(byId.get(prefix)).toBe(MASKED_BUYER_FIRST_NAME);
    expect(byId.get(chosen)).toBe("Alice");
    expect(r.text).not.toContain(localPart);
    expect(r.text).not.toContain(longHandle.slice(0, 40));

    // The MCP tool shares the read, so it masks identically.
    const mcp = mcpTools();
    const tool = await mcp.call("get_seller_reviews", { seller_id: legacySeller, limit: 50 });
    expect(tool.isError).toBe(false);
    const toolById = new Map<string, string>(
      (tool.payload.reviews as Array<{ id: string; first_name: string }>).map((x) => [x.id, x.first_name]),
    );
    expect(toolById.get(legacy)).toBe(MASKED_BUYER_FIRST_NAME);
    expect(toolById.get(prefix)).toBe(MASKED_BUYER_FIRST_NAME);
  });

  // Test 11 — the MCP tool: identical shape and rules (capped summary,
  // ordering, cursor), plus exactly one added field, content_provenance.
  it("get_seller_reviews serves the same read anonymously with content_provenance stamped", async () => {
    const mcp = mcpTools();
    const r = await mcp.call("get_seller_reviews", { seller_id: sellerId, limit: 50 });
    expect(r.isError).toBe(false);
    expect(r.payload.seller_id).toBe(sellerId);
    expect(r.payload.content_provenance).toBe("user_generated");
    expect(r.payload.next_before).toBeNull();
    for (const review of r.payload.reviews as Record<string, unknown>[]) {
      expect(Object.keys(review).sort()).toEqual(["created_at", "first_name", "id", "item_title", "rating", "text"]);
    }
    // The ordering matches HTTP byte-for-byte on the same fixture.
    const http = await get("?limit=50");
    expect((r.payload.reviews as { id: string }[]).map((x) => x.id)).toEqual(
      http.json.reviews.map((x: { id: string }) => x.id),
    );
    expect(r.payload.summary).toEqual(http.json.summary);

    // Error discipline mirrors HTTP: unknown seller → not_found, malformed
    // cursor → validation (400-class), both as tool errors.
    const unknown = await mcp.call("get_seller_reviews", { seller_id: crypto.randomUUID(), limit: 10 });
    expect(unknown.isError).toBe(true);
    expect(unknown.payload.code).toBe("not_found");
    const badCursor = await mcp.call("get_seller_reviews", { seller_id: sellerId, limit: 10, before: "garbage" });
    expect(badCursor.isError).toBe(true);
    expect(badCursor.payload.code).toBe("validation");
  });
});
