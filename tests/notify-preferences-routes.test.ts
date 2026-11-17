// THI-760 plan Phase 2 / THI-780 PR 1: GET/PATCH /api/me/preferences.
// Session-auth via the signSession cookie pattern (tests/notify-routes.test.ts);
// DB-backed (skips without Postgres — CI runs it). Round-trip, strict
// validation incl. the locked money class, anonymous 401, and cross-account
// isolation (a PATCH can only ever touch the caller's own profile row).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { DEFAULT_NOTIFICATION_PREFS } from "../src/notify/prefs.js";

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

describe.skipIf(!available)("/api/me/preferences (THI-780 PR 1)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let cookie = "";
  let otherCookie = "";
  let sellerId = "";

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    const mk = async (): Promise<string> => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'THI-780 Prefs') RETURNING id`,
        [`thi780p-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
      );
      return r.rows[0].id;
    };
    sellerId = await mk();
    const otherId = await mk();
    cookie = `${SESSION_COOKIE}=${signSession(sellerId)}`;
    otherCookie = `${SESSION_COOKIE}=${signSession(otherId)}`;

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
    server?.close();
    await db.end().catch(() => {});
  });

  it("anonymous → 401 on both verbs", async () => {
    for (const init of [undefined, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }]) {
      const res = await fetch(`${base}/api/me/preferences`, init);
      expect(res.status).toBe(401);
    }
  });

  it("GET returns effective defaults before anything is stored", async () => {
    const res = await fetch(`${base}/api/me/preferences`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).preferences).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("PATCH round-trip: legal partial update persists and GET returns it", async () => {
    const res = await fetch(`${base}/api/me/preferences`, {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactional_orders: "in_app", digest: "weekly" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preferences.transactional_orders).toBe("in_app");
    expect(body.preferences.digest).toBe("weekly");
    expect(body.preferences.transactional_money).toBe("email+in_app"); // locked, always present

    const got = await (await fetch(`${base}/api/me/preferences`, { headers: { cookie } })).json();
    expect(got.preferences).toEqual(body.preferences);

    // Stored where the plan says: sellers.profile.notification_prefs.
    const row = await db.query<{ prefs: unknown }>(
      "SELECT profile->'notification_prefs' AS prefs FROM sellers WHERE id = $1", [sellerId],
    );
    expect(row.rows[0].prefs).toEqual({ transactional_orders: "in_app", digest: "weekly" });

    // Revert for later tests.
    await fetch(`${base}/api/me/preferences`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactional_orders: "email", digest: "none" }),
    });
  });

  it("locked money class: PATCH attempts are 400, never applied", async () => {
    for (const value of ["in_app", "none", ""]) {
      const res = await fetch(`${base}/api/me/preferences`, {
        method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ transactional_money: value }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors[0].field).toBe("transactional_money");
    }
    const got = await (await fetch(`${base}/api/me/preferences`, { headers: { cookie } })).json();
    expect(got.preferences.transactional_money).toBe("email+in_app");
  });

  it("illegal values and unknown fields → 400 with per-field errors", async () => {
    const res = await fetch(`${base}/api/me/preferences`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactional_orders: "sms", digest: "hourly", locale: "de", spam: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.map((e: { field: string }) => e.field)).toEqual([
      "transactional_orders", "digest", "locale", "spam",
    ]);
  });

  it("empty/no-op PATCH returns current state (idempotent)", async () => {
    const res = await fetch(`${base}/api/me/preferences`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).preferences).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("cross-account isolation: A's PATCH never touches B's row", async () => {
    await fetch(`${base}/api/me/preferences`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ digest: "daily" }),
    });
    const other = await (await fetch(`${base}/api/me/preferences`, { headers: { cookie: otherCookie } })).json();
    expect(other.preferences.digest).toBe("none"); // B unaffected by A's write
  });
});
