// Order reviews — write side (spec docs/specs/order-reviews.md, PR 1):
// POST/PATCH/GET /api/orders/:id/review. DB-backed, skip-guarded without
// Postgres (CI runs it); session cookie + mountApiRoutes pattern as
// tests/item-reports.test.ts. The pair-anomaly hook (test 16) rides the
// real applyTransition path and is observed through the security-events
// stdout line (logSecurityEvent), captured with a console.log spy.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { applyTransition, type OrderStatus } from "../src/orders.js";
import { MASKED_BUYER_FIRST_NAME } from "../src/reviews.js";

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

describe.skipIf(!available)("order reviews — writes (spec docs/specs/order-reviews.md, PR 1)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let buyerCookie = "";
  let buyerId = "";
  let sellerId = "";
  let otherCookie = "";
  let orderId = ""; // completed (off_platform) fixture
  let paidOutOrderId = ""; // paid_out (stripe) fixture

  async function mkSeller(name: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`thi941w-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
    );
    return r.rows[0].id;
  }

  async function mkItem(ownerId: string, title: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, $2, 100, 'other') RETURNING id`,
      [ownerId, title],
    );
    return r.rows[0].id;
  }

  /** Seeds an order for a given buyer, parked directly in `status`. */
  async function mkOrderFor(
    buyer: string,
    status: OrderStatus,
    opts?: { title?: string; seller?: string; mode?: "stripe" | "off_platform" },
  ): Promise<string> {
    const item = await mkItem(opts?.seller ?? sellerId, opts?.title ?? "Film camera");
    const r = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, status)
       VALUES ($1, $2, $3, 100, 0, 'EUR', 'pickup', $4, $5) RETURNING id`,
      [item, opts?.seller ?? sellerId, buyer, opts?.mode ?? "off_platform", status],
    );
    return r.rows[0].id;
  }

  /** Fresh buyer per order — single-order tests use this and post as that buyer. */
  async function mkOrder(status: OrderStatus, opts?: { title?: string }): Promise<string> {
    return mkOrderFor(await mkSeller("Luca Rossi"), status, opts);
  }

  /** Session cookie for an order's buyer. */
  async function buyerCookieFor(order: string): Promise<string> {
    const r = await db.query<{ buyer_id: string }>("SELECT buyer_id FROM orders WHERE id = $1", [order]);
    return `${SESSION_COOKIE}=${signSession(r.rows[0].buyer_id)}`;
  }

  function call(
    method: "POST" | "PATCH" | "GET",
    order: string,
    body: unknown,
    cookie: string | null,
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    return fetch(`${base}/api/orders/${order}/review`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    sellerId = await mkSeller("Marta Seller");
    buyerId = await mkSeller("Luca Rossi");
    const other = await mkSeller("Nadia Other");
    buyerCookie = `${SESSION_COOKIE}=${signSession(buyerId)}`;
    otherCookie = `${SESSION_COOKIE}=${signSession(other)}`;

    orderId = await mkOrderFor(buyerId, "completed");
    paidOutOrderId = await mkOrderFor(buyerId, "paid_out", { mode: "stripe" });

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1 — anonymous writes 401.
  it("rejects anonymous POST with 401", async () => {
    const r = await call("POST", orderId, { rating: 5 }, null);
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/log in/i);
  });

  // Test 2 — eligible terminal states, snapshots written server-side.
  it("buyer posts on completed and paid_out orders: 201, published, server-side snapshots", async () => {
    const first = await call("POST", orderId, { rating: 4, text: "Well packed and as described." }, buyerCookie);
    expect(first.status).toBe(201);
    expect(first.json.ok).toBe(true);
    expect(first.json.review).toMatchObject({ rating: 4, text: "Well packed and as described." });
    expect(first.json.review.created_at).toBeTruthy();
    expect(first.json.review.editable_until).toBeTruthy();
    const row = await db.query<{ status: string; buyer_first_name: string; item_title: string; buyer_id: string }>(
      "SELECT status, buyer_first_name, item_title, buyer_id FROM order_reviews WHERE order_id = $1",
      [orderId],
    );
    // "Luca Rossi" → first token; item title from the items row.
    expect(row.rows[0]).toMatchObject({ status: "published", buyer_first_name: "Luca", item_title: "Film camera", buyer_id: buyerId });

    const second = await call("POST", paidOutOrderId, { rating: 5 }, buyerCookie);
    expect(second.status).toBe(201);
    expect(second.json.review).toMatchObject({ rating: 5, text: null });
  });

  // THI-979 (SR-5 on PR #319): signup defaults display_name to the email
  // local-part, so a reviewer's first-name snapshot can be an email-derived
  // handle. The F1 exact-match mask (shared rule, src/sellers.ts) substitutes
  // the buyer-shaped constant at insert — this test fails against the
  // unmasked path, which stored and published the local-part itself.
  it("masks a signup-default (email local-part) first-name snapshot at insert (THI-979 F1)", async () => {
    // A buyer who skipped the name field: display_name = email local-part,
    // byte-for-byte the /signup derivation (src/routes.ts).
    const localPart = `handle${runTag}${crypto.randomUUID().slice(0, 8)}`;
    const handleBuyer = (
      await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
        [`${localPart}@example.test`, localPart],
      )
    ).rows[0]!.id;
    const order = await mkOrderFor(handleBuyer, "completed");
    const posted = await call("POST", order, { rating: 5 }, `${SESSION_COOKIE}=${signSession(handleBuyer)}`);
    expect(posted.status).toBe(201);

    // Stored snapshot is the constant, not the handle.
    const row = await db.query<{ buyer_first_name: string }>(
      "SELECT buyer_first_name FROM order_reviews WHERE order_id = $1",
      [order],
    );
    expect(row.rows[0]!.buyer_first_name).toBe(MASKED_BUYER_FIRST_NAME);

    // And the seller's public list carries no trace of the handle.
    const list = await fetch(`${base}/api/sellers/${sellerId}/reviews?limit=50`);
    expect(list.status).toBe(200);
    const json = (await list.json()) as { reviews: Array<{ id: string; first_name: string }> };
    expect(json.reviews.some((x) => x.first_name === MASKED_BUYER_FIRST_NAME)).toBe(true);
    expect(JSON.stringify(json)).not.toContain(localPart);
  });

  // Test 3 — ineligible statuses, unknown order, non-buyer: friendly 400 /
  // oracle-free 404.
  it("rejects ineligible statuses with 400, unknown order and non-buyer with 404", async () => {
    for (const status of ["cancelled", "refunded", "disputed", "delivered"] as OrderStatus[]) {
      const o = await mkOrder(status);
      const cookie = await buyerCookieFor(o);
      const r = await call("POST", o, { rating: 5 }, cookie);
      expect(r.status, status).toBe(400);
      expect(r.json.error, status).toMatch(/once the order is complete/i);
    }
    const unknown = await call("POST", crypto.randomUUID(), { rating: 5 }, buyerCookie);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toMatch(/order not found/i);
    const notBuyer = await call("POST", orderId, { rating: 5 }, otherCookie);
    expect(notBuyer.status).toBe(404); // same message as unknown — no oracle
    expect(notBuyer.json.error).toBe(unknown.json.error);
  });

  // Test 4 — UNIQUE (order_id): plain duplicate and a forced row both map to 409.
  it("duplicate POST → friendly 409, still one row (incl. forced row hitting the UNIQUE)", async () => {
    const dup = await call("POST", orderId, { rating: 3 }, buyerCookie);
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/already reviewed/i);
    // Force the concurrent-insert arm: a row that appears between the checks
    // makes the INSERT itself hit 23505, which must map to the same 409.
    const raced = await mkOrderFor(buyerId, "completed", { title: "Raced order item" });
    const racedItem = await db.query<{ item_id: string }>("SELECT item_id FROM orders WHERE id = $1", [raced]);
    await db.query(
      `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, buyer_first_name, item_title)
       VALUES ($1, $2, $3, $4, 5, 'Luca', 'Raced order item')`,
      [raced, sellerId, buyerId, racedItem.rows[0].item_id],
    );
    const loser = await call("POST", raced, { rating: 5 }, buyerCookie);
    expect(loser.status).toBe(409);
    const count = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM order_reviews WHERE order_id = $1", [raced]);
    expect(count.rows[0].n).toBe(1);
  });

  // Test 5 — shape rules.
  it("rating 0 / 6 / non-integer → 400; text 501 → 400; whitespace text → stored NULL", async () => {
    for (const body of [{ rating: 0 }, { rating: 6 }, { rating: "4" }, { rating: 4.5 }]) {
      const o = await mkOrder("completed");
      const r = await call("POST", o, body, await buyerCookieFor(o));
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const long = await mkOrder("completed");
    const longR = await call("POST", long, { rating: 5, text: "x".repeat(501) }, await buyerCookieFor(long));
    expect(longR.status).toBe(400);
    const blank = await mkOrder("completed");
    const blankR = await call("POST", blank, { rating: 5, text: "   " }, await buyerCookieFor(blank));
    expect(blankR.status).toBe(201);
    const stored = await db.query<{ text: string | null }>("SELECT text FROM order_reviews WHERE order_id = $1", [blank]);
    expect(stored.rows[0].text).toBeNull();
  });

  // Test 6 — contact screening on POST: generic message, never the rule.
  it("contact info in review text → 400 with the generic message", async () => {
    const o = await mkOrder("completed");
    const cookie = await buyerCookieFor(o);
    const hit = await call("POST", o, { rating: 5, text: "email me at luca@example.com please" }, cookie);
    expect(hit.status).toBe(400);
    expect(hit.json.error).toMatch(/contact details/i);
    expect(hit.json.error).not.toMatch(/email/i);
  });

  // Test 6b — screening on PATCH, driving the edit path (fails against
  // POST-only screening).
  it("contact screening also applies on edit (PATCH)", async () => {
    const o = await mkOrder("completed");
    const cookie = await buyerCookieFor(o);
    const post = await call("POST", o, { rating: 5, text: "Fast shipping, well packed." }, cookie);
    expect(post.status).toBe(201);
    const bad = await call("PATCH", o, { rating: 5, text: "reach me on https://t.me/luca" }, cookie);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/contact details/i);
    const clean = await call("PATCH", o, { rating: 4, text: "Editing this to four stars." }, cookie);
    expect(clean.status).toBe(200);
    expect(clean.json.review.rating).toBe(4);
  });

  // Test 7 — edit-window semantics. The anchor is created_at; the "past 30
  // days" arm back-dates the row in SQL instead of injecting a clock, so
  // the whole HTTP path sees the aged anchor.
  it("edit within window: created_at unchanged, edited_at set, editable_until stable; rating required", async () => {
    const o = await mkOrder("completed");
    const cookie = await buyerCookieFor(o);
    const post = await call("POST", o, { rating: 3, text: "A bit slow." }, cookie);
    expect(post.status).toBe(201);
    const before = await db.query<{ created_at: Date }>("SELECT created_at FROM order_reviews WHERE order_id = $1", [o]);
    const edit = await call("PATCH", o, { rating: 4 }, cookie);
    expect(edit.status).toBe(200);
    expect(edit.json.review).toMatchObject({ rating: 4, text: null });
    expect(edit.json.review.editable_until).toBe(post.json.review.editable_until);
    const after = await db.query<{ created_at: Date; edited_at: Date | null }>(
      "SELECT created_at, edited_at FROM order_reviews WHERE order_id = $1", [o],
    );
    expect(after.rows[0].created_at.getTime()).toBe(before.rows[0].created_at.getTime());
    expect(after.rows[0].edited_at).not.toBeNull();
    // rating omitted → 400 (form semantics: replaces both fields).
    const noRating = await call("PATCH", o, { text: "No rating sent." }, cookie);
    expect(noRating.status).toBe(400);
  });

  it("editing past the 30-day window → 403; hidden review → 403", async () => {
    const aged = await mkOrder("completed");
    const agedCookie = await buyerCookieFor(aged);
    const post = await call("POST", aged, { rating: 5 }, agedCookie);
    expect(post.status).toBe(201);
    await db.query("UPDATE order_reviews SET created_at = now() - interval '31 days' WHERE order_id = $1", [aged]);
    const late = await call("PATCH", aged, { rating: 4 }, agedCookie);
    expect(late.status).toBe(403);
    expect(late.json.error).toMatch(/30 days/i);

    const hidden = await mkOrder("completed");
    const hiddenCookie = await buyerCookieFor(hidden);
    const hPost = await call("POST", hidden, { rating: 5 }, hiddenCookie);
    expect(hPost.status).toBe(201);
    await db.query("UPDATE order_reviews SET status = 'hidden' WHERE order_id = $1", [hidden]);
    const hEdit = await call("PATCH", hidden, { rating: 4 }, hiddenCookie);
    expect(hEdit.status).toBe(403);
    expect(hEdit.json.error).toMatch(/moderation/i);
  });

  // Test 8 — the shared POST+PATCH hourly bucket: 21st write 429s and logs
  // the security_events rate_limit line.
  it("rate limit: 21st review write in the hour → 429 + security_events line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const floodBuyer = await mkSeller("Flooder Buyer");
    const cookie = `${SESSION_COOKIE}=${signSession(floodBuyer)}`;
    const orders: string[] = [];
    for (let i = 0; i < 11; i++) orders.push(await mkOrderFor(floodBuyer, "completed"));
    for (const o of orders) {
      const r = await call("POST", o, { rating: 5, text: `Flood review ${o.slice(0, 6)}.` }, cookie);
      expect(r.status).toBe(201);
    }
    for (const o of orders.slice(0, 9)) {
      const r = await call("PATCH", o, { rating: 4 }, cookie);
      expect(r.status).toBe(200);
    }
    // 20 writes done (11 POST + 9 PATCH): the 21st is a PATCH on the 10th order.
    const blocked = await call("PATCH", orders[9], { rating: 4 }, cookie);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/too many/i);
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"type":"rate_limit"'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("/api/orders/:id/review");
  });

  // Test 9 — own-review GET: null pre-post, full row post, editable flips
  // past the window, non-buyer 404, anonymous 401.
  it("GET own review: null → full row → editable flips false past the window; non-buyer 404", async () => {
    const o = await mkOrder("completed");
    const cookie = await buyerCookieFor(o);
    const pre = await call("GET", o, undefined, cookie);
    expect(pre.status).toBe(200);
    expect(pre.json.review).toBeNull();
    await call("POST", o, { rating: 5, text: "Great." }, cookie);
    const posted = await call("GET", o, undefined, cookie);
    expect(posted.status).toBe(200);
    expect(posted.json.review).toMatchObject({ rating: 5, text: "Great.", status: "published", editable: true });
    expect(posted.json.review.edited_at).toBeNull();
    await db.query("UPDATE order_reviews SET created_at = now() - interval '31 days' WHERE order_id = $1", [o]);
    const aged = await call("GET", o, undefined, cookie);
    expect(aged.json.review.editable).toBe(false);
    const notBuyer = await call("GET", o, undefined, otherCookie);
    expect(notBuyer.status).toBe(404);
    const anonymous = await call("GET", o, undefined, null);
    expect(anonymous.status).toBe(401);
  });

  // Test 16 — pair anomaly (N = 10): exactly one line at the crossing,
  // none after, none when a 10-order pair's extras are not review-eligible.
  // Rides the real transition path (applyTransition delivered → completed,
  // off_platform #17b).
  it("pair anomaly: one review_pair_anomaly line at the 10th eligible order, none after", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const anomalyBuyer = await mkSeller("Anomaly Buyer");
    const anomalySeller = await mkSeller("Anomaly Seller");
    const mkDelivered = async (buyer: string, seller: string) =>
      mkOrderFor(buyer, "delivered", { seller, title: "Anomaly item" });
    const linesFor = (id: string) =>
      spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"type":"review_pair_anomaly"') && l.includes(id));

    // 9 direct terminal rows, then the 10th through the real transition.
    for (let i = 0; i < 9; i++) {
      const o = await mkDelivered(anomalyBuyer, anomalySeller);
      await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [o]);
    }
    expect(linesFor(anomalyBuyer).length).toBe(0);
    const tenth = await mkDelivered(anomalyBuyer, anomalySeller);
    await applyTransition({ orderId: tenth, trigger: "release_funds", actor: { type: "buyer", id: anomalyBuyer } });
    const lines = linesFor(anomalyBuyer);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: "review_pair_anomaly",
      buyer_id: anomalyBuyer,
      seller_id: anomalySeller,
      terminal_orders: 10,
    });

    // 11th and 12th terminal orders → no further lines.
    for (let i = 0; i < 2; i++) {
      const o = await mkDelivered(anomalyBuyer, anomalySeller);
      await applyTransition({ orderId: o, trigger: "release_funds", actor: { type: "buyer", id: anomalyBuyer } });
    }
    expect(linesFor(anomalyBuyer).length).toBe(1);

    // A 10-order pair whose extras are cancelled → no line: the eligible
    // count stays under N even though the pair has 10 terminal orders.
    const quietBuyer = await mkSeller("Quiet Buyer");
    const quietSeller = await mkSeller("Quiet Seller");
    for (let i = 0; i < 7; i++) {
      const o = await mkDelivered(quietBuyer, quietSeller);
      await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [o]);
    }
    for (let i = 0; i < 2; i++) {
      await mkOrderFor(quietBuyer, "cancelled", { seller: quietSeller, title: "Quiet item" });
    }
    const quietTenth = await mkDelivered(quietBuyer, quietSeller);
    await applyTransition({ orderId: quietTenth, trigger: "release_funds", actor: { type: "buyer", id: quietBuyer } });
    expect(linesFor(quietBuyer).length).toBe(0);
  });
});
