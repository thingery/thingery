// THI-760 plan Phase 1 / THI-763 PR 5: notification read surface
// (`/api/notifications*`, unread count in `/api/me`). Session-auth via the
// same signSession cookie pattern as tests/chat-route.test.ts; DB-backed
// (skips without Postgres — CI runs it).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";

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

describe.skipIf(!available)("/api/notifications + /api/me unread (THI-763 PR 5)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let cookie = "";
  let otherCookie = "";
  let sellerId = "";
  let otherId = "";

  async function seedNotif(recipient: string, read: boolean, title = "Vintage denim jacket"): Promise<string> {
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key, read_at)
       VALUES ($1, 'buyer.order_placed', 'buyer', $2::jsonb, $3, $4) RETURNING id`,
      [recipient, JSON.stringify({ item_title: title, amount_cents: 1234, currency: "EUR" }),
       `thi763r:${crypto.randomUUID()}`, read ? new Date() : null],
    );
    return notif.rows[0].id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    const mk = async (name: string): Promise<string> => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
        [`thi763r-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`, name],
      );
      return r.rows[0].id;
    };
    sellerId = await mk("A");
    otherId = await mk("B");
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
    server.close();
    await db.end().catch(() => {});
  });

  beforeEach(async () => {
    await db.query("DELETE FROM notifications WHERE recipient_id IN ($1, $2)", [sellerId, otherId]);
  });

  it("anonymous → 401 on all three routes; anonymous /api/me shape unchanged", async () => {
    for (const pathName of ["/api/notifications", "/api/notifications/x/read"]) {
      const res = await fetch(`${base}${pathName}`, { method: "POST" });
      expect(res.status).toBe(401);
    }
    expect((await fetch(`${base}/api/notifications`)).status).toBe(401);
    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ seller: null }); // no unread field when anonymous
  });

  it("lists newest-first with unread_count; ?unread=1 filters", async () => {
    const old = await seedNotif(sellerId, false, "Old thing");
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await seedNotif(sellerId, true, "Fresh thing");
    const res = await fetch(`${base}/api/notifications`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<{ id: string; item?: string }>; unread_count: number };
    expect(body.notifications.map((n) => n.id)).toEqual([fresh, old]);
    expect(body.unread_count).toBe(1);
    const unreadOnly = await fetch(`${base}/api/notifications?unread=1`, { headers: { cookie } });
    const ub = (await unreadOnly.json()) as { notifications: string[]; unread_count: number };
    expect(ub.notifications).toHaveLength(1);
  });

  it("mark one read is idempotent and recipient-scoped (404 for other's id)", async () => {
    const mine = await seedNotif(sellerId, false);
    const theirs = await seedNotif(otherId, false);
    const ok = await fetch(`${base}/api/notifications/${mine}/read`, { method: "POST", headers: { cookie } });
    expect(ok.status).toBe(200);
    const again = await fetch(`${base}/api/notifications/${mine}/read`, { method: "POST", headers: { cookie } });
    expect(again.status).toBe(404); // already read — same body as unknown
    const foreign = await fetch(`${base}/api/notifications/${theirs}/read`, { method: "POST", headers: { cookie } });
    expect(foreign.status).toBe(404); // not mine — indistinguishable from unknown
    const stillUnread = await db.query<{ read_at: Date | null }>(
      "SELECT read_at FROM notifications WHERE id = $1", [theirs]);
    expect(stillUnread.rows[0].read_at).toBeNull();
  });

  it("read-all flips every unread and reports the count; /api/me badge follows", async () => {
    await seedNotif(sellerId, false);
    await seedNotif(sellerId, false);
    await seedNotif(sellerId, true); // already read — not counted
    let me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { seller: { unread_notifications: number } };
    expect(me.seller.unread_notifications).toBe(2);
    const res = await fetch(`${base}/api/notifications/read-all`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(2);
    me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { seller: { unread_notifications: number } };
    expect(me.seller.unread_notifications).toBe(0);
    const rerun = await fetch(`${base}/api/notifications/read-all`, { method: "POST", headers: { cookie } });
    expect((await rerun.json()).updated).toBe(0); // idempotent
  });

  it("cross-account isolation: B's notifications never visible to A", async () => {
    await seedNotif(otherId, false, "B's private thing");
    const res = await fetch(`${base}/api/notifications`, { headers: { cookie: otherCookie } });
    const body = (await res.json()) as { notifications: Array<{ id: string }> };
    expect(body.notifications).toHaveLength(1);
    const mine = await fetch(`${base}/api/notifications`, { headers: { cookie } });
    expect(((await mine.json()) as { notifications: unknown[] }).notifications).toHaveLength(0);
  });
});
