// Admin reports queue UI (report-moderation spec §5, PR-4): the human path
// beside the disputes queue — GET /admin/reports (open item reports with
// motivation, newest first, overflow note only past the cap) and the three
// CSRF-protected action POSTs (suspend / takedown / dismiss) running the
// exact same cores as the Bearer JSON routes. Uniform 404 off the open
// queue; output encoding (B2) and no-store pinned; limiter buckets kept
// apart (reads page-class, actions strict). DB-backed over real HTTP;
// skips without Postgres (DATABASE_URL or localhost:5432).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, adminAttemptLimiter, adminPageLimiter, signAdminSession } from "../src/routes.js";

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

describe.skipIf(!available)("admin reports queue UI (spec report-moderation §5, PR-4)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let cookie: string;
  let csrf: string;
  const runTag = crypto.randomUUID().slice(0, 8);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  async function seedSeller(): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'ReportsUI seed', now()) RETURNING id`,
      [`reportsui-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
    );
    return r.rows[0].id;
  }

  async function seedItem(sellerId: string, title?: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, category, price_cents, currency, status)
       VALUES ($1, $2, 'other', 5000, 'EUR', 'active') RETURNING id`,
      [sellerId, title ?? `ReportsUI item ${runTag} ${crypto.randomUUID().slice(0, 6)}`],
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

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE reports, items, sellers RESTART IDENTITY CASCADE");
    process.env.ADMIN_API_KEY = "a".repeat(40);
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
    consoleError.mockRestore();
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

  it("boots closed: without a session the queue redirects to the login page", async () => {
    const res = await get("/admin/reports", false);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  it("empty queue renders the empty state", async () => {
    await db.query("TRUNCATE reports RESTART IDENTITY CASCADE");
    const res = await get("/admin/reports");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("No open reports right now.");
    // OQ1 discipline (THI-566): unlinked + noindex, like every admin page.
    expect(body).toContain('name="robots" content="noindex"');
  });

  it("renders open reports newest-first with the motivation; omits resolved and dismissed rows", async () => {
    const seller = await seedSeller();
    const older = await seedItem(seller);
    const newer = await seedItem(seller);
    const olderReport = await seedReport(older, `Older motivation ${runTag}`);
    const newerReport = await seedReport(newer, `Newer motivation ${runTag}`);
    // A pre-resolved and a pre-dismissed row must never render.
    const goneItem = await seedItem(seller);
    const resolvedReport = await seedReport(goneItem, `Resolved motivation ${runTag}`);
    const dismissedReport = await seedReport(goneItem, `Dismissed motivation ${runTag}`);
    await db.query(
      `UPDATE reports SET status = 'resolved', resolution_action = 'suspended', resolved_at = now() WHERE id = $1`,
      [resolvedReport],
    );
    await db.query(
      `UPDATE reports SET status = 'dismissed', resolved_at = now() WHERE id = $1`,
      [dismissedReport],
    );
    const body = await (await get("/admin/reports")).text();
    const newerAt = body.indexOf(`Newer motivation ${runTag}`);
    const olderAt = body.indexOf(`Older motivation ${runTag}`);
    expect(newerAt).toBeGreaterThan(-1);
    expect(olderAt).toBeGreaterThan(-1);
    expect(newerAt).toBeLessThan(olderAt); // newest first
    expect(body).not.toContain(`Resolved motivation ${runTag}`);
    expect(body).not.toContain(`Dismissed motivation ${runTag}`);
    expect(body).toContain(`/admin/reports/${newerReport}/suspend`);
    expect(body).toContain(`/admin/reports/${olderReport}/dismiss`);
  });

  it("escapes reporter- and seller-controlled content (B2)", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller, `<b>Title ${runTag}</b>`);
    await seedReport(item, `<script>alert("${runTag}")</script>`);
    const body = await (await get("/admin/reports")).text();
    expect(body).not.toContain(`<script>alert`);
    expect(body).not.toContain(`<b>Title ${runTag}</b>`);
    expect(body).toContain(`&lt;script&gt;alert(&quot;${runTag}&quot;)&lt;/script&gt;`);
    expect(body).toContain(`&lt;b&gt;Title ${runTag}&lt;/b&gt;`);
  });

  it("suspend via form: PRG redirect, item suspended, report auto-resolved, queue drops it", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item, `Suspend-me motivation ${runTag}`);
    const res = await postForm(`/admin/reports/${report}/suspend`, {
      csrf,
      reason: `Suspend reason ${runTag}`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/reports?done=${report}&action=suspend`);
    const itemRow = await db.query<{ status: string }>("SELECT status FROM items WHERE id = $1", [item]);
    expect(itemRow.rows[0]?.status).toBe("suspended");
    const reportRow = await db.query<{ status: string; resolution_action: string | null }>(
      "SELECT status, resolution_action FROM reports WHERE id = $1",
      [report],
    );
    expect(reportRow.rows[0]?.status).toBe("resolved");
    expect(reportRow.rows[0]?.resolution_action).toBe("suspended");
    // PRG: the confirmation line renders on the redirected GET, the acted
    // report has left the queue.
    const body = await (await get(res.headers.get("location") as string)).text();
    expect(body).toContain(`Report ${report.slice(0, 8)}…`);
    expect(body).toContain("listing suspended");
    expect(body).not.toContain(`Suspend-me motivation ${runTag}`);
    // Owner notified exactly once per item lifetime: the notification row's
    // dedupe key has no epoch (suspended:{item} — a re-suspension after a
    // reinstate does not re-notify); the email rides email_outbox keyed by
    // the notification id.
    const planned = await db.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM notifications WHERE dedupe_key = $1",
      [`suspended:${item}`],
    );
    expect(planned.rows.length).toBe(1);
  });

  it("takedown via form: item deleted, report resolved with 'deleted'", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item, `Delete-me motivation ${runTag}`);
    const res = await postForm(`/admin/reports/${report}/takedown`, {
      csrf,
      reason: `Takedown reason ${runTag}`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/reports?done=${report}&action=takedown`);
    const itemRow = await db.query<{ status: string }>("SELECT status FROM items WHERE id = $1", [item]);
    expect(itemRow.rows[0]?.status).toBe("deleted");
    const reportRow = await db.query<{ status: string; resolution_action: string | null }>(
      "SELECT status, resolution_action FROM reports WHERE id = $1",
      [report],
    );
    expect(reportRow.rows[0]?.status).toBe("resolved");
    expect(reportRow.rows[0]?.resolution_action).toBe("deleted");
  });

  it("dismiss via form stores the note; resolution_action stays NULL", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item, `Dismiss-me motivation ${runTag}`);
    const res = await postForm(`/admin/reports/${report}/dismiss`, {
      csrf,
      note: `Dismiss note ${runTag}`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/reports?done=${report}&action=dismiss`);
    const row = await db.query<{ status: string; dismiss_note: string; resolution_action: string | null }>(
      "SELECT status, dismiss_note, resolution_action FROM reports WHERE id = $1",
      [report],
    );
    expect(row.rows[0]?.status).toBe("dismissed");
    expect(row.rows[0]?.dismiss_note).toBe(`Dismiss note ${runTag}`);
    expect(row.rows[0]?.resolution_action).toBeNull();
    // Dismissal notifies nobody: no notifications row exists for the report
    // (PII-free discipline — the note is stored, never emailed).
    const planned = await db.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM notifications WHERE recipient_id = (SELECT seller_id FROM items WHERE id = $1) AND event_type LIKE 'seller.%' AND dedupe_key LIKE 'dismiss%'",
      [item],
    );
    expect(planned.rows.length).toBe(0);
  });

  it("the explicit state machine: dismissing a non-open report 404s (replay-safe)", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item);
    await postForm(`/admin/reports/${report}/dismiss`, { csrf });
    const replay = await postForm(`/admin/reports/${report}/dismiss`, { csrf, note: "second" });
    expect(replay.status).toBe(404);
  });

  it("action POSTs fail closed: CSRF, field validation, unknown and malformed ids", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item);
    const noCsrf = await postForm(`/admin/reports/${report}/suspend`, { reason: "r" });
    expect(noCsrf.status).toBe(400);
    const badCsrf = await postForm(`/admin/reports/${report}/suspend`, { csrf: "wrong", reason: "r" });
    expect(badCsrf.status).toBe(400);
    const longReason = await postForm(`/admin/reports/${report}/takedown`, { csrf, reason: "x".repeat(501) });
    expect(longReason.status).toBe(400);
    const emptyReason = await postForm(`/admin/reports/${report}/takedown`, { csrf, reason: "" });
    expect(emptyReason.status).toBe(400);
    const longNote = await postForm(`/admin/reports/${report}/dismiss`, { csrf, note: "x".repeat(501) });
    expect(longNote.status).toBe(400);
    // Unknown but well-formed id → uniform 404 (no existence oracle).
    const unknown = await postForm(`/admin/reports/${crypto.randomUUID()}/suspend`, { csrf, reason: "r" });
    expect(unknown.status).toBe(404);
    const malformed = await postForm("/admin/reports/not-a-uuid/suspend", { csrf, reason: "r" });
    expect(malformed.status).toBe(404);
    // GET detailless surface: the page itself still works (the queue is a list, no detail route).
    const list = await get("/admin/reports");
    expect(list.status).toBe(200);
  });

  it("bucket separation: queue page reads never consume the strict attempt budget", async () => {
    const seller = await seedSeller();
    const item = await seedItem(seller);
    const report = await seedReport(item);
    for (let i = 0; i < 6; i += 1) {
      expect((await get("/admin/reports")).status).toBe(200);
    }
    const res = await postForm(`/admin/reports/${report}/dismiss`, { csrf });
    expect(res.status).toBe(303);
  });

  it("overflow note and card cap only past 100 open reports", async () => {
    await db.query("TRUNCATE reports RESTART IDENTITY CASCADE");
    const seller = await seedSeller();
    const item = await seedItem(seller);
    // One report per (reporter, item) is a schema constraint — 101 distinct
    // reporters, one open report each against the same item.
    await db.query(
      `WITH reps AS (
         INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
         SELECT 'reportsui-bulk-${runTag}-' || g || '@example.test', 'x', 'Bulk reporter', now()
         FROM generate_series(1, 101) g RETURNING id
       )
       INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation)
       SELECT id, $1, 'other', 'Bulk motivation ${runTag}' FROM reps`,
      [item],
    );
    const body = await (await get("/admin/reports")).text();
    expect(body).toContain("More than 100 open reports — showing the 100 most recent");
    expect(body.split('class="card"').length - 1).toBe(100);
  });
});
