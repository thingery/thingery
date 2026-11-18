// Order reviews — moderation (spec docs/specs/order-reviews.md, PR 3):
// POST /api/reviews/:id/report (any signed-in account except the author)
// and POST /api/admin/reviews/:id/hide (Bearer ADMIN_API_KEY, the takedown
// pattern). DB-backed, skip-guarded without Postgres; session cookie +
// mountApiRoutes pattern as tests/order-reviews.test.ts. Spec test items
// 12 (reports) and 13 (admin hide).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

const ADMIN_KEY = "k".repeat(40); // ≥32 chars: adminRouteEnabled boots true

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

describe.skipIf(!available)("order reviews — moderation (spec docs/specs/order-reviews.md, PR 3)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let sellerId = "";
  let buyerId = "";
  let buyerCookie = "";
  let reporterCookie = "";
  let reviewId = ""; // published review of buyer on seller

  async function mkSeller(name: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`thi941m-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
    );
    return r.rows[0].id;
  }

  /** A published review by `buyer` on `seller`, seeded directly (the write
   *  side is covered by tests/order-reviews.test.ts; moderation only needs
   *  a row in the published state). */
  async function mkReview(buyer: string, seller: string, title: string): Promise<string> {
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, $2, 100, 'other') RETURNING id`,
      [seller, title],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, status)
       VALUES ($1, $2, $3, 100, 0, 'EUR', 'pickup', 'off_platform', 'completed') RETURNING id`,
      [item.rows[0].id, seller, buyer],
    );
    const review = await db.query<{ id: string }>(
      `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, text, buyer_first_name, item_title)
       VALUES ($1, $2, $3, $4, $5, $6, 'Luca', $7) RETURNING id`,
      [order.rows[0].id, seller, buyer, item.rows[0].id, 4, "Smooth trade.", title],
    );
    return review.rows[0].id;
  }

  function call(
    method: "POST",
    url: string,
    body: unknown,
    cookie: string | null,
    auth?: string,
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    if (auth) headers.Authorization = auth;
    return fetch(`${base}${url}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  }

  /** Sets (or clears) the boot key without the `process.env.x = undefined`
   *   stringify trap; restores the prior value. */
  function withAdminKey(key: string | null, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.ADMIN_API_KEY;
    if (key === null) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = key;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = prev;
    });
  }

  async function publicReviews(): Promise<{ count: number; average: number | null; ids: string[] }> {
    const res = await fetch(`${base}/api/sellers/${sellerId}/reviews?limit=50`);
    const body = (await res.json()) as {
      summary: { count: number; average: number | null };
      reviews: Array<{ id: string }>;
    };
    return { count: body.summary.count, average: body.summary.average, ids: body.reviews.map((r) => r.id) };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    sellerId = await mkSeller("Marta Seller");
    buyerId = await mkSeller("Luca Rossi");
    const reporter = await mkSeller("Nadia Reporter");
    buyerCookie = `${SESSION_COOKIE}=${signSession(buyerId)}`;
    reporterCookie = `${SESSION_COOKIE}=${signSession(reporter)}`;

    reviewId = await mkReview(buyerId, sellerId, "Film camera");

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
    await db.end();
  });

  // --- spec test 12: review reports ---

  it("anonymous report 401s; a signed-in reporter gets 201 and the row targets the review", async () => {
    const anon = await call("POST", `/api/reviews/${reviewId}/report`, { reason: "scam_fraud", motivation: "This review is defamatory." }, null);
    expect(anon.status).toBe(401);

    await withAdminKey(ADMIN_KEY, async () => {
      const r = await call("POST", `/api/reviews/${reviewId}/report`, { reason: "scam_fraud", motivation: "This review is defamatory." }, reporterCookie);
      expect(r.status).toBe(201);
      expect(r.json.ok).toBe(true);
      const row = await db.query<{ target_item_id: string | null; target_review_id: string | null; reason: string; status: string }>(
        "SELECT target_item_id, target_review_id, reason, status FROM reports WHERE id = $1",
        [r.json.report_id],
      );
      expect(row.rows[0]).toMatchObject({
        target_item_id: null,
        target_review_id: reviewId,
        reason: "scam_fraud",
        status: "open",
      });
    });
  });

  it("duplicate report 409s; own review 400s; unknown review 404s; bad shape 400s", async () => {
    const dup = await call("POST", `/api/reviews/${reviewId}/report`, { reason: "other", motivation: "Same problem again, reporting twice." }, reporterCookie);
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/already reported/i);

    const own = await call("POST", `/api/reviews/${reviewId}/report`, { reason: "other", motivation: "I want to flag my own review here." }, buyerCookie);
    expect(own.status).toBe(400);
    expect(own.json.error).toMatch(/own review/i);

    const unknown = await call("POST", `/api/reviews/${crypto.randomUUID()}/report`, { reason: "other", motivation: "A review that does not exist." }, reporterCookie);
    expect(unknown.status).toBe(404);

    const bad = await call("POST", `/api/reviews/${reviewId}/report`, { reason: "weird", motivation: "x".repeat(20) }, reporterCookie);
    expect(bad.status).toBe(400);
  });

  it("shares the hourly account bucket: 429 after five report attempts", async () => {
    const floodCookie = `${SESSION_COOKIE}=${signSession(await mkSeller("Flood Reporter"))}`;
    for (let i = 0; i < 5; i++) {
      const r = await call("POST", `/api/reviews/${crypto.randomUUID()}/report`, { reason: "other", motivation: `Attempt number ${i} of the flood.` }, floodCookie);
      expect(r.status).toBe(404); // unknown review — but the bucket was consumed
    }
    const limited = await call("POST", `/api/reviews/${crypto.randomUUID()}/report`, { reason: "other", motivation: "One past the hourly limit." }, floodCookie);
    expect(limited.status).toBe(429);
  });

  it("item reports keep working: the endpoint lands rows with target_item_id only", async () => {
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'Reported film camera', 100, 'other') RETURNING id`,
      [sellerId],
    );
    const r = await call("POST", `/api/items/${item.rows[0].id}/report`, { reason: "other", motivation: "Item-side regression check for PR 3." }, reporterCookie);
    expect(r.status).toBe(201);
    const row = await db.query<{ target_item_id: string | null; target_review_id: string | null }>(
      "SELECT target_item_id, target_review_id FROM reports WHERE id = $1",
      [r.json.report_id],
    );
    expect(row.rows[0]).toEqual({ target_item_id: item.rows[0].id, target_review_id: null });
  });

  // --- spec test 13: admin hide ---

  it("masked when the boot key is absent: 404 without any auth oracle", async () => {
    await withAdminKey(null, async () => {
      const r = await call("POST", `/api/admin/reviews/${reviewId}/hide`, { reason: "policy violation" }, null, `Bearer ${ADMIN_KEY}`);
      expect(r.status).toBe(404);
    });
  });

  it("no key / wrong key: 401; bad body: 400", async () => {
    await withAdminKey(ADMIN_KEY, async () => {
      expect((await call("POST", `/api/admin/reviews/${reviewId}/hide`, { reason: "policy violation" }, null)).status).toBe(401);
      expect((await call("POST", `/api/admin/reviews/${reviewId}/hide`, { reason: "policy violation" }, null, "Bearer wrong-key-not-even-long")).status).toBe(401);
      expect((await call("POST", `/api/admin/reviews/${reviewId}/hide`, {}, null, `Bearer ${ADMIN_KEY}`)).status).toBe(400);
      expect((await call("POST", `/api/admin/reviews/${crypto.randomUUID()}/hide`, { reason: "policy violation" }, null, `Bearer ${ADMIN_KEY}`)).status).toBe(404);
    });
  });

  it("hides the review once: gone from list and summary, author notified, second hide 404s", async () => {
    await withAdminKey(ADMIN_KEY, async () => {
      const before = await publicReviews();
      expect(before.ids).toContain(reviewId);
      const second = await mkReview(buyerId, sellerId, "Typewriter");
      // Seed a second published review so the summary visibly changes.
      await db.query("UPDATE order_reviews SET rating = 2 WHERE id = $1", [second]);

      const r = await call("POST", `/api/admin/reviews/${reviewId}/hide`, { reason: "policy violation" }, null, `Bearer ${ADMIN_KEY}`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ review_id: reviewId, status: "hidden", author_notified: true });

      const row = await db.query<{ status: string }>("SELECT status FROM order_reviews WHERE id = $1", [reviewId]);
      expect(row.rows[0].status).toBe("hidden");

      const after = await publicReviews();
      expect(after.ids).not.toContain(reviewId);
      expect(after.ids).toContain(second);
      expect(after.count).toBe(before.count); // one hidden, one added
      expect(after.average).toBe(2); // only the 2-star review remains

      const notif = await db.query<{ event_type: string; role: string; dedupe_key: string }>(
        "SELECT event_type, role, dedupe_key FROM notifications WHERE dedupe_key = $1",
        [`review-hidden:${reviewId}`],
      );
      expect(notif.rows[0]).toMatchObject({ event_type: "buyer.review_hidden", role: "buyer" });

      const again = await call("POST", `/api/admin/reviews/${reviewId}/hide`, { reason: "policy violation" }, null, `Bearer ${ADMIN_KEY}`);
      expect(again.status).toBe(404);
    });
  });
});
