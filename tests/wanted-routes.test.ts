// Wanted browser CRUD routes (spec THI-439 §6.3, PR 5): POST /api/wanted,
// GET /api/wanted/mine, PUT /api/wanted/:id, POST /api/wanted/:id/expire,
// POST /api/wanted/:id/renew — over real HTTP + DB (llm-credential route
// test pattern), with the wantedWriteLimiter reset between tests.
//
// Invariants under test: session-first on every verb; every body flows
// through src/wanted.ts (contact scrub, caps, ownership); the dual-save
// intent (THI-437 §4 step 3) never fails the wanted create; limiter 429s
// log rate_limit events; /mine returns raw field shapes without buyer_id.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mountApiRoutes, wantedWriteLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";

delete process.env.EMBED_API_KEY;

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

describe.skipIf(!available)("wanted browser CRUD routes (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const sellerIds: string[] = [];

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
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
    server.close();
    // Explicit cleanup, no TRUNCATE (suites share this DB): wanted_buyer_quota
    // has no FK back to sellers, so it is deleted first and explicitly.
    await db.query(`DELETE FROM wanted_buyer_quota WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM buyer_intents WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerIds]);
    await db.end();
  });

  beforeEach(() => {
    wantedWriteLimiter.reset();
  });

  async function seed(tag: string): Promise<{ sellerId: string; cookie: string }> {
    const nonce = randomUUID();
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`wr-fixture-${nonce}`, tag, `wr-${tag}-${nonce}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return { sellerId: rows[0].id, cookie: `${SESSION_COOKIE}=${signSession(rows[0].id)}` };
  }

  const call = (method: string, pathSuffix: string, cookie: string | null, body?: unknown) =>
    fetch(`${base}/api/wanted${pathSuffix}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  // Unique titles per test: the scrub test proves no row landed under the
  // shared baseline title, so the baseline itself must be test-local.
  const validCreate = (title: string) => ({ title, category: "music", condition: "good" });

  it("requires a session on all five verbs", async () => {
    await seed("anon");
    expect((await call("POST", "", null, validCreate)).status).toBe(401);
    expect((await call("GET", "/mine", null)).status).toBe(401);
    expect((await call("PUT", `/${randomUUID()}`, null, { title: "x".repeat(3) })).status).toBe(401);
    expect((await call("POST", `/${randomUUID()}/expire`, null)).status).toBe(401);
    expect((await call("POST", `/${randomUUID()}/renew`, null)).status).toBe(401);
  });

  it("POST creates the wanted, dual-saves the alert intent, and returns the public shape", async () => {
    const { sellerId, cookie } = await seed("create");
    const res = await call("POST", "", cookie, { ...validCreate("Route probe create wanted"), budget_min_cents: 1500, alert_me: true });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as { wanted: { id: string; status: string; budget_min_cents: number }; alert_saved: boolean };
    expect(data.wanted.status).toBe("active");
    expect(data.wanted.budget_min_cents).toBe(1500);
    expect(data.alert_saved).toBe(true);
    // The dual-save really wrote a buyer intent with the wanted's shape.
    const intents = await db.query(
      "SELECT q, category, min_price_cents FROM buyer_intents WHERE buyer_id = $1",
      [sellerId],
    );
    expect(intents.rowCount).toBe(1);
    expect(intents.rows[0].q).toBe("Route probe create wanted");
    expect(intents.rows[0].min_price_cents).toBe(1500);
  });

  it("alert_me:false skips the intent; intent quota failure degrades, never fails the wanted", async () => {
    const { sellerId, cookie } = await seed("alert");
    const optedOut = await call("POST", "", cookie, { ...validCreate("Route probe no alert"), alert_me: false });
    expect(optedOut.status).toBe(201);
    expect(((await optedOut.json()) as { alert_saved: boolean }).alert_saved).toBe(false);

    // Quota pressure on intents only: fill the per-buyer intent cap, then
    // create again with alert default-on — the wanted must still succeed and
    // alert_saved must be false.
    for (let i = 0; i < 25; i++) {
      await db.query(
        "INSERT INTO buyer_intents (buyer_id, q, category) VALUES ($1, $2, $3)",
        [sellerId, `filler intent ${i}`, "other"],
      );
    }
    const degraded = await call("POST", "", cookie, { ...validCreate("Route probe quota alert") });
    expect(degraded.status).toBe(201);
    expect(((await degraded.json()) as { alert_saved: boolean }).alert_saved).toBe(false);
  });

  it("contact info in notes is rejected by the module scrub (400, no oracle text)", async () => {
    const { cookie } = await seed("scrub");
    const res = await call("POST", "", cookie, { ...validCreate("Route probe scrub wanted"), notes: "email me at probe@example.com" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The message is fixed (contactInfoMessage): it names the rule class but
    // never echoes the matched content — no oracle to probe the regex with.
    expect(body.error).not.toMatch(/example\.com/i);
    expect(
      (await db.query("SELECT 1 FROM wanted_items WHERE title = $1", ["Route probe scrub wanted"])).rowCount,
    ).toBe(0);
  });

  it("GET /mine lists the buyer's wanteds with counts and without buyer_id", async () => {
    const { sellerId, cookie } = await seed("mine");
    const created = await call("POST", "", cookie, validCreate("Route probe mine wanted"));
    const { wanted } = (await created.json()) as { wanted: { id: string } };

    const res = await call("GET", "/mine", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { wanteds } = (await res.json()) as { wanteds: Record<string, unknown>[] };
    const mine = wanteds.find((w) => w.id === wanted.id);
    expect(mine).toBeDefined();
    expect(mine!.buyer_id).toBeUndefined();
    expect(mine!.response_count).toBe(0);
    expect(mine!.unread_responses).toBe(0);
    expect(mine!.renewable).toBe(false); // fresh active: renew CTA hidden
    // Other buyers' rows never leak into mine.
    const other = await seed("mine-other");
    await call("POST", "", other.cookie, validCreate("Route probe other wanted"));
    const again = (await (await call("GET", "/mine", cookie)).json()) as { wanteds: Record<string, unknown>[] };
    expect(again.wanteds.some((w) => w.title === "Route probe other wanted")).toBe(false);
    expect(mine!.buyer_id).toBeUndefined();
    expect(sellerId.length).toBeGreaterThan(0);
  });

  it("PUT edits owned wanteds; foreign/unknown ids 404 indistinguishably", async () => {
    const mine = await seed("edit");
    const other = await seed("edit-other");
    const created = await call("POST", "", mine.cookie, validCreate("Route probe editable"));
    const id = ((await created.json()) as { wanted: { id: string } }).wanted.id;

    const ok = await call("PUT", `/${id}`, mine.cookie, { title: "Route probe edited", notes: "tighter" });
    expect(ok.status).toBe(200);
    const edited = (await ok.json()) as { wanted: { title: string; notes: string } };
    expect(edited.wanted.title).toBe("Route probe edited");
    expect(edited.wanted.notes).toBe("tighter");

    expect((await call("PUT", `/${id}`, other.cookie, { title: "Route probe steal" })).status).toBe(404);
    expect((await call("PUT", `/${randomUUID()}`, mine.cookie, { title: "Route probe ghost" })).status).toBe(404);
    // Bad body → 400 with a zod message.
    expect((await call("PUT", `/${id}`, mine.cookie, { title: "ab" })).status).toBe(400);
  });

  it("expire and renew drive the state machine through the same limiter budget", async () => {
    const { cookie } = await seed("lifecycle");
    const created = await call("POST", "", cookie, validCreate("Route probe lifecycle"));
    const id = ((await created.json()) as { wanted: { id: string } }).wanted.id;

    const expired = await call("POST", `/${id}/expire`, cookie);
    expect(expired.status).toBe(200);
    expect(((await expired.json()) as { wanted: { status: string } }).wanted.status).toBe("expired");

    const renewed = await call("POST", `/${id}/renew`, cookie);
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { wanted: { status: string; expires_at: string } }).wanted.status).toBe("active");

    expect((await call("POST", `/${randomUUID()}/expire`, cookie)).status).toBe(404);
  });

  it("limiter: the 21st write in an hour 429s and logs a rate_limit event", async () => {
    const { sellerId, cookie } = await seed("limit");
    const events: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = String(args[0] ?? "");
      if (line?.includes('"rate_limit"')) events.push(line);
      origLog(...args);
    };
    try {
      // Burn the budget with cheap failing writes (they still consume limiter
      // tokens — the cap is per-write-attempt, like every other route).
      for (let i = 0; i < 20; i++) {
        await call("PUT", `/${randomUUID()}`, cookie, { title: "Route probe filler" });
      }
      const blocked = await call("POST", "", cookie, validCreate("Route probe over limit"));
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/too many/i);
      // The 429 left a rate_limit security event naming the route slug.
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1]).toContain("/api/wanted");
      // No wanted row was created by the blocked write.
      expect(
        (await db.query("SELECT 1 FROM wanted_items WHERE buyer_id = $1", [sellerId])).rowCount,
      ).toBe(0);
    } finally {
      console.log = origLog;
    }
  });
});
