// Item reports endpoint (spec docs/specs/item-reports.md, THI-788 step 2 /
// THI-617 MVP): POST /api/items/:id/report — auth, canned reason + required
// motivation, durable per-reporter-per-item dedupe, hourly cap. DB-backed,
// skip-guarded without Postgres (CI runs it); session cookie pattern as
// tests/notify-routes.test.ts.

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

describe.skipIf(!available)("POST /api/items/:id/report (THI-788 step 2)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let reporterCookie = "";
  let reporterId = "";
  let sellerId = "";
  let itemId = "";

  async function mkSeller(name: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`thi788r-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
    );
    return r.rows[0].id;
  }

  async function mkItem(ownerId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'report target fixture', 100, 'other') RETURNING id`,
      [ownerId],
    );
    return r.rows[0].id;
  }

  function postReport(item: string, body: unknown, cookie: string | null): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    return fetch(`${base}/api/items/${item}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    reporterId = await mkSeller("Reporter");
    sellerId = await mkSeller("Target seller");
    reporterCookie = `${SESSION_COOKIE}=${signSession(reporterId)}`;
    itemId = await mkItem(sellerId);

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
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await db.end();
  });

  it("rejects anonymous callers with 401", async () => {
    const r = await postReport(itemId, { reason: "scam_fraud", motivation: "This listing is a fake resale scam." }, null);
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/log in/i);
  });

  it("creates a report row: status open, board_issue_ref NULL", async () => {
    const r = await postReport(itemId, { reason: "scam_fraud", motivation: "Seller asks for payment off-platform via wire transfer." }, reporterCookie);
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.report_id).toBeTruthy();
    const row = await db.query<{ status: string; board_issue_ref: string | null; reason: string }>(
      "SELECT status, board_issue_ref, reason FROM reports WHERE id = $1",
      [r.json.report_id],
    );
    expect(row.rows[0]).toMatchObject({ status: "open", board_issue_ref: null, reason: "scam_fraud" });
  });

  it("rejects an invalid reason slug with 400", async () => {
    const other = await mkSeller("Reason tester");
    const item = await mkItem(sellerId);
    const r = await postReport(item, { reason: "spam", motivation: "Whatever reason that is long enough." }, `${SESSION_COOKIE}=${signSession(other)}`);
    expect(r.status).toBe(400);
  });

  it("enforces motivation length: 9 chars and 1001 chars are 400", async () => {
    const other = await mkSeller("Length tester");
    const item = await mkItem(sellerId);
    const cookie = `${SESSION_COOKIE}=${signSession(other)}`;
    const short = await postReport(item, { reason: "other", motivation: "too short" }, cookie);
    expect(short.status).toBe(400);
    const long = await postReport(item, { reason: "other", motivation: "x".repeat(1001) }, cookie);
    expect(long.status).toBe(400);
    // Zod trims nothing: 10 chars incl. whitespace-only is still invalid at
    // the module layer (whitespace-only is rejected by trim() there).
    const blank = await postReport(item, { reason: "other", motivation: "          " }, cookie);
    expect(blank.status).toBe(400);
  });

  it("duplicate report per reporter per item → friendly 409, exactly one row", async () => {
    const dup = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM reports WHERE reporter_account_id = $1 AND target_item_id = $2",
      [reporterId, itemId],
    );
    expect(dup.rows[0].n).toBe(1);
    const r = await postReport(itemId, { reason: "explicit_images", motivation: "Second attempt at reporting the same item." }, reporterCookie);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/already reported/i);
    const still = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM reports WHERE reporter_account_id = $1 AND target_item_id = $2",
      [reporterId, itemId],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it("rejects reporting your own item with 400", async () => {
    const own = await mkItem(reporterId);
    const r = await postReport(own, { reason: "other", motivation: "I want to test my own listing report." }, reporterCookie);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/own item/i);
  });

  it("unknown item id → 404", async () => {
    const r = await postReport(crypto.randomUUID(), { reason: "other", motivation: "This item does not exist at all." }, reporterCookie);
    expect(r.status).toBe(404);
  });

  it("rate limit: 6th report within the hour → 429 (fresh reporter, distinct items)", async () => {
    const flooder = await mkSeller("Flooder");
    const cookie = `${SESSION_COOKIE}=${signSession(flooder)}`;
    const items: string[] = [];
    for (let i = 0; i < 6; i++) items.push(await mkItem(sellerId));
    for (let i = 0; i < 5; i++) {
      const r = await postReport(items[i], { reason: "other", motivation: `Flooder report number ${i + 1} of six total.` }, cookie);
      expect(r.status).toBe(201);
    }
    const sixth = await postReport(items[5], { reason: "other", motivation: "This is the sixth report past the cap." }, cookie);
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toMatch(/too many/i);
  });
});
