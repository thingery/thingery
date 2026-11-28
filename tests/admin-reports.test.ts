// Report-moderation spec PR 3: the moderator's reports queue —
// GET /api/admin/reports (open item reports, newest first, motivation
// included, page-class limiter) and POST /api/admin/reports/:id/dismiss
// (open → dismissed, optional note, strict attempt limiter), plus the
// auto-resolution side effect of suspend/takedown (open reports on the
// item resolve in the same transaction as the status change, carrying
// resolution_action + resolved_at). DB-backed over real HTTP; skips
// without Postgres (DATABASE_URL or localhost:5432).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, adminAttemptLimiter, adminPageLimiter } from "../src/routes.js";

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

describe.skipIf(!available)("admin reports queue + resolution side effects (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomUUID().slice(0, 8);
  const KEY = "a".repeat(40);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  async function seedSeller(): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'AdminReports seed', now()) RETURNING id`,
      [`adminreports-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
    );
    return r.rows[0].id;
  }

  async function seedItem(sellerId: string, status = "active"): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, category, price_cents, currency, status)
       VALUES ($1, $2, 'other', 5000, 'EUR', $3) RETURNING id`,
      [sellerId, `Queue item ${runTag} ${crypto.randomUUID().slice(0, 6)}`, status],
    );
    return r.rows[0].id;
  }

  /** One open report by a fresh reporter against `itemId`. */
  async function seedReport(itemId: string, motivation = `Reported for policy review ${runTag}`): Promise<string> {
    const reporter = await seedSeller();
    const r = await db.query<{ id: string }>(
      `INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation)
       VALUES ($1, $2, 'other', $3) RETURNING id`,
      [reporter, itemId, motivation],
    );
    return r.rows[0].id;
  }

  const get = (url: string, key = KEY) =>
    fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const post = (url: string, body: string, key = KEY) =>
    fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body });

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    // Re-apply schema.sql: also proves the PR-3 column block is
    // replay-idempotent on an already-migrated database.
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers, reports RESTART IDENTITY CASCADE");
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
  });

  afterAll(async () => {
    await server.close();
    await db.end();
  });

  afterEach(() => {
    adminAttemptLimiter.reset();
    adminPageLimiter.reset();
  });

  it("queue auth matrix: wrong key 401, missing key 401, unset key 404 (boot gate)", async () => {
    const url = `${base}/api/admin/reports`;
    expect((await get(url, "wrong")).status).toBe(401);
    expect((await fetch(url)).status).toBe(401);
    const had = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      expect((await fetch(url)).status).toBe(404);
    } finally {
      process.env.ADMIN_API_KEY = had;
    }
  });

  it("queue: open item reports newest first with motivation + joined title; resolved/dismissed excluded", async () => {
    const seller = await seedSeller();
    const older = await seedItem(seller);
    const newer = await seedItem(seller);
    const olderReport = await seedReport(older, `Older motivation ${runTag}`);
    const newerReport = await seedReport(newer, `Newer motivation ${runTag}`);
    // One already-closed report must not appear.
    const closed = await seedReport(older);
    await db.query(`UPDATE reports SET status = 'dismissed', resolved_at = now() WHERE id = $1`, [closed]);

    const res = await get(`${base}/api/admin/reports`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { reports: Array<{ id: string; reason: string; motivation: string; item_id: string; item_title: string; reporter_account_id: string; created_at: string }> };
    const ids = body.reports.map((r) => r.id);
    expect(ids).toContain(olderReport);
    expect(ids).toContain(newerReport);
    expect(ids).not.toContain(closed);
    // Newest first.
    expect(ids.indexOf(newerReport)).toBeLessThan(ids.indexOf(olderReport));
    const newerRow = body.reports.find((r) => r.id === newerReport)!;
    expect(newerRow).toMatchObject({
      reason: "other",
      motivation: `Newer motivation ${runTag}`,
      item_id: newer,
    });
    expect(newerRow.item_title).toMatch(/^Queue item/);
    expect(newerRow.reporter_account_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(newerRow.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("queue is capped at 100 rows", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    // One distinct reporter per report — the durable dedupe is
    // UNIQUE (reporter_account_id, target_item_id).
    await db.query(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       SELECT 'cap-' || $1 || '-' || g || '@example.test', 'x', 'cap probe', now()
       FROM generate_series(1, 105) g`,
      [runTag],
    );
    await db.query(
      `INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation)
       SELECT s.id, $1, 'other', 'Bulk queue cap probe'
       FROM sellers s WHERE s.email LIKE 'cap-' || $2 || '-%@example.test'`,
      [item, runTag],
    );
    const res = await get(`${base}/api/admin/reports`);
    const body = await res.json() as { reports: unknown[] };
    expect(body.reports).toHaveLength(100);
  });

  it("dismiss: open → dismissed with note; terminal (second dismiss 404); validation matrix", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const reportId = await seedReport(item);
    const url = `${base}/api/admin/reports/${reportId}/dismiss`;

    // Auth + validation matrix (strict attempt-limiter bucket).
    expect((await post(url, "{}", "wrong")).status).toBe(401);
    expect((await post(url, JSON.stringify({ note: "x".repeat(501) }))).status).toBe(400);

    // Happy path: dismissed, note stored, resolved_at set, resolution_action NULL.
    const ok = await post(url, JSON.stringify({ note: "reviewed — listing is fine" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ report_id: reportId, status: "dismissed" });
    const row = (await db.query<{ status: string; dismiss_note: string; resolution_action: string | null; resolved_at: Date }>(
      "SELECT status, dismiss_note, resolution_action, resolved_at FROM reports WHERE id = $1", [reportId],
    )).rows[0];
    expect(row.status).toBe("dismissed");
    expect(row.dismiss_note).toBe("reviewed — listing is fine");
    expect(row.resolution_action).toBeNull();
    expect(row.resolved_at).not.toBeNull();

    // Terminal: no transition route out of dismissed — replay 404s, note unchanged.
    expect((await post(url, JSON.stringify({ note: "again" }))).status).toBe(404);
    expect((await db.query<{ status: string }>("SELECT dismiss_note FROM reports WHERE id = $1", [reportId])).rows[0].dismiss_note)
      .toBe("reviewed — listing is fine");

    // Unknown id → 404.
    expect((await post(`${base}/api/admin/reports/00000000-0000-0000-0000-000000000000/dismiss`, "{}")).status).toBe(404);

    // Boot gate: unset key → 404.
    const had = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      expect((await post(url, "{}")).status).toBe(404);
    } finally {
      process.env.ADMIN_API_KEY = had;
    }
  });

  it("suspend resolves the item's open reports in the same transaction ('suspended'), queue empties", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const r1 = await seedReport(item);
    const r2 = await seedReport(item);
    // An unrelated open report on another item must stay open.
    const otherItem = await seedItem(seller);
    const untouched = await seedReport(otherItem);

    const res = await post(`${base}/api/admin/items/${item}/suspend`, JSON.stringify({ reason: "under policy review" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "suspended", reports_resolved: 2 });

    const rows = (await db.query<{ id: string; status: string; resolution_action: string | null; resolved_at: Date | null }>(
      "SELECT id, status, resolution_action, resolved_at FROM reports WHERE id = ANY($1)", [[r1, r2]],
    )).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("resolved");
      expect(row.resolution_action).toBe("suspended");
      expect(row.resolved_at).not.toBeNull();
    }
    const other = (await db.query<{ status: string }>("SELECT status FROM reports WHERE id = $1", [untouched])).rows[0];
    expect(other.status).toBe("open");

    // The queue no longer lists the suspended item's reports.
    const queue = await get(`${base}/api/admin/reports`);
    const ids = ((await queue.json()) as { reports: Array<{ id: string }> }).reports.map((r) => r.id);
    expect(ids).not.toContain(r1);
    expect(ids).not.toContain(r2);
    expect(ids).toContain(untouched);
  });

  it("takedown resolves open reports ('deleted'); item without reports reports_resolved: 0", async () => {
    const seller = await seedSeller();
    const withReport = await seedItem(seller);
    const r1 = await seedReport(withReport);
    const bare = await seedItem(seller);

    const res = await post(`${base}/api/admin/items/${withReport}/takedown`, JSON.stringify({ reason: "confirmed prohibited" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "deleted", reports_resolved: 1 });
    const row = (await db.query<{ status: string; resolution_action: string | null }>(
      "SELECT status, resolution_action FROM reports WHERE id = $1", [r1],
    )).rows[0];
    expect(row).toMatchObject({ status: "resolved", resolution_action: "deleted" });

    const bareRes = await post(`${base}/api/admin/items/${bare}/takedown`, JSON.stringify({ reason: "confirmed prohibited" }));
    expect(bareRes.status).toBe(200);
    expect((await bareRes.json()).reports_resolved).toBe(0);
  });

  it("queue reads stay off the strict attempt budget: 10 GETs, then a dismiss POST still allowed (N-2)", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const reportId = await seedReport(item);
    for (let i = 0; i < 10; i++) {
      expect((await get(`${base}/api/admin/reports`)).status).toBe(200);
    }
    // The strict bucket is untouched by page-class reads → dismiss succeeds
    // even though 10 POSTs would have exhausted adminAttemptLimiter.
    expect((await post(`${base}/api/admin/reports/${reportId}/dismiss`, "{}")).status).toBe(200);
  });
});
