// Admin resolve form (spec docs/specs/admin-dispute-ui.md, THI-562 work
// item 3, PR-C): POST /admin/disputes/:id/resolve — session + CSRF + the
// resolveDisputeCore shared with the JSON endpoint (one code path, two
// transports; the JSON transport's contract is pinned by
// tests/admin-route.test.ts). PRG on success, re-render on 409-class,
// uniform 404 for 404-class. DB-backed over real HTTP.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, adminAttemptLimiter, adminPageLimiter, signAdminSession } from "../src/routes.js";
import { applyTransition } from "../src/orders.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET ??= "s".repeat(64);
});

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

describe.skipIf(!available)("admin resolve form (spec admin-dispute-ui PR-C)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const KEY = "a".repeat(40);
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    process.env.ADMIN_API_KEY = KEY;
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
    const s = signAdminSession();
    cookie = `admin_session=${s.cookie}`;
    csrf = s.csrf;
  });
  afterAll(async () => {
    delete process.env.ADMIN_API_KEY;
    server.close();
    await db.end();
  });
  beforeEach(() => {
    adminAttemptLimiter.reset();
    adminPageLimiter.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (pathName: string, withSession = true) =>
    fetch(`${base}${pathName}`, { redirect: "manual", headers: withSession ? { cookie } : {} });
  const postForm = (pathName: string, body: Record<string, string>, withSession = true) =>
    fetch(`${base}${pathName}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(withSession ? { cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
  const postJson = (pathName: string, body: unknown, key: string) =>
    fetch(`${base}${pathName}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  let n = 0;
  /** Walks a real off_platform order to disputed (no Stripe side effects). */
  async function seedDisputed(): Promise<string> {
    n += 1;
    const s = `rf${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
      [`thg_${s}s`, `${s}s`, `${s}s@t.dev`, `thg_${s}b`, `${s}b`, `${s}b@t.dev`],
    );
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents) SELECT id, $1, 5000 FROM sellers WHERE email = $2 RETURNING id",
      [`Resolve item ${n}`, `${s}s@t.dev`],
    );
    const order = await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, currency, fulfillment, payment_mode, shipping_address)
       SELECT $1, s.id, b.id, 5000, 'EUR', 'shipping', 'off_platform', $2::jsonb
       FROM sellers s, sellers b WHERE s.email = $3 AND b.email = $4 RETURNING id`,
      [item.rows[0].id, JSON.stringify({ name: "X", line1: "Y", city: "Z", postal_code: "1", country: "DE" }), `${s}s@t.dev`, `${s}b@t.dev`],
    );
    const orderId = order.rows[0].id as string;
    const sellerId = (await db.query("SELECT id FROM sellers WHERE email = $1", [`${s}s@t.dev`])).rows[0].id;
    await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: sellerId } });
    await applyTransition({ orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "b" } });
    await applyTransition({ orderId, trigger: "open_dispute", actor: { type: "buyer", id: "b" }, reason: "damaged" });
    return orderId;
  }

  it("detail renders the resolve form (radios, note, CSRF, action)", async () => {
    const orderId = await seedDisputed();
    const html = await (await get(`/admin/disputes/${orderId}`)).text();
    expect(html).toContain(`action="/admin/disputes/${orderId}/resolve"`);
    expect(html).toContain('name="outcome" value="refund"');
    expect(html).toContain('name="outcome" value="release"');
    expect(html).toContain('name="note"');
    expect(html).toContain(`name="csrf" value="${csrf}"`);
    expect(html).toContain("status-only"); // off_platform note in the form labels
  });

  it("resolve requires a session, then CSRF — before anything else runs", async () => {
    const orderId = await seedDisputed();
    const noSession = await fetch(`${base}/admin/disputes/${orderId}/resolve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, outcome: "refund", note: "x".repeat(5) }).toString(),
    });
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("location")).toBe("/admin/login");
    const stillDisputed = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status;
    expect(stillDisputed).toBe("disputed");

    const badCsrf = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf: "nope", outcome: "refund", note: "nope!" });
    expect(badCsrf.status).toBe(400);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status).toBe("disputed");
  });

  it("invalid fields re-render the detail with the error, no state change", async () => {
    const orderId = await seedDisputed();
    const r = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "sidequest", note: "" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Pick an outcome");
    expect(html).toContain("Resolve dispute");
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status).toBe("disputed");
  });

  it("refund via form resolves an off_platform dispute: PRG + note, status cancelled, audited", async () => {
    const orderId = await seedDisputed();
    const r = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "refund", note: "Buyer showed proof of damage" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/admin/disputes?resolved=${orderId}`);
    // PRG target shows the confirmation (and escapes the param).
    const list = await get(`/admin/disputes?resolved=${orderId}`);
    expect(list.status).toBe(200);
    expect((await list.text())).toContain(`Resolved order ${orderId.slice(0, 8)}…`);
    // off_platform + admin_refund → cancelled (#18b), reason on the audit row.
    const row = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(row.status).toBe("cancelled");
    const ev = (
      await db.query("SELECT actor_type, reason FROM order_events WHERE order_id = $1 AND event_type = 'transition' ORDER BY created_at DESC LIMIT 1", [orderId])
    ).rows[0];
    expect(ev).toMatchObject({ actor_type: "admin", reason: "Buyer showed proof of damage" });
    // The resolved order is gone from the queue (detail now 404s — uniform).
    expect((await get(`/admin/disputes/${orderId}`)).status).toBe(404);
  });

  it("release via form resolves to completed (#19b)", async () => {
    const orderId = await seedDisputed();
    const r = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "release", note: "Tracking proves delivery" });
    expect(r.status).toBe(303);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status).toBe("completed");
  });

  it("409-class: already-resolved order → error page; non-existent → uniform 404", async () => {
    const orderId = await seedDisputed();
    await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "refund", note: "first" });
    const second = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "refund", note: "second" });
    expect(second.status).toBe(409);
    const html = await second.text();
    expect(html).toContain("only disputed orders can be resolved");
    expect(html).not.toContain("Order history"); // no dispute detail content leaked
    expect(second.headers.get("cache-control")).toBe("no-store");

    expect((await postForm(`/admin/disputes/not-a-uuid/resolve`, { csrf, outcome: "refund", note: "x" })).status).toBe(404);
    expect(
      (await postForm(`/admin/disputes/00000000-0000-0000-0000-000000000000/resolve`, { csrf, outcome: "refund", note: "x" })).status,
    ).toBe(404);
  });

  it("same core, two transports: JSON endpoint contract unchanged after extraction", async () => {
    const orderId = await seedDisputed();
    // Form transport succeeds …
    await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "release", note: "via form" });
    // … and the JSON endpoint now reports the same 409 class with its exact body.
    const json = await postJson(`/api/admin/orders/${orderId}/resolve-dispute`, { outcome: "release", note: "via json" }, KEY);
    expect(json.status).toBe(409);
    expect(await json.json()).toMatchObject({ error: "Order is completed; only disputed orders can be resolved." });
    // Auth path unchanged: no session cookie is consulted by the JSON endpoint.
    const unauth = await postJson(`/api/admin/orders/${orderId}/resolve-dispute`, { outcome: "release", note: "x" }, "b".repeat(40));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ error: "Not authorized." });
  });

  it("resolve is metered by the strict limiter, not the page bucket (B1)", async () => {
    const orderId = await seedDisputed();
    let last = 200;
    for (let i = 0; i < 11 && last !== 429; i++) {
      const r = await postForm(`/admin/disputes/${orderId}/resolve`, { csrf, outcome: "sidequest", note: "" });
      last = r.status;
    }
    expect(last).toBe(429);
    // Page GETs unaffected (separate bucket).
    expect((await get("/admin/disputes")).status).toBe(200);
  });
});
