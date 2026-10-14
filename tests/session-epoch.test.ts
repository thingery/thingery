// DB-backed revocation proof (spec THI-115 §3): sellerFromSession reads
// sellers.session_epoch in its single SELECT, so a bumped epoch (the future
// key-regeneration trigger) invalidates outstanding cookies, and a cookie
// re-signed at the new epoch works again. Requires Postgres; skips otherwise
// (same pattern as schema.test.ts).

import crypto from "node:crypto";
import pg from "pg";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, sellerFromSession } from "../src/auth.js";

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

function reqWithCookie(cookie: string): Request {
  return { headers: { cookie } } as unknown as Request;
}

describe.skipIf(!available)("session epoch revocation (THI-115)", () => {
  let db: pg.Client;
  let sellerId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    // Tolerate a local DB that hasn't re-run db/schema.sql yet.
    await db.query(`ALTER TABLE sellers ADD COLUMN IF NOT EXISTS session_epoch INT NOT NULL DEFAULT 0`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_${crypto.randomBytes(24).toString("base64url")}`, "thi115-epoch-test"],
    );
    sellerId = rows[0].id;
  });

  afterAll(async () => {
    if (sellerId) await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]).catch(() => {});
    await db.end();
  });

  it("validates a cookie signed at the seller's current epoch", async () => {
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId, 0))}`;
    expect((await sellerFromSession(reqWithCookie(cookie)))?.id).toBe(sellerId);
  });

  it("a bumped epoch invalidates outstanding cookies; re-signing at the new epoch works", async () => {
    const staleCookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId, 0))}`;
    await db.query(`UPDATE sellers SET session_epoch = 1 WHERE id = $1`, [sellerId]);
    expect(await sellerFromSession(reqWithCookie(staleCookie))).toBeNull();
    const freshCookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId, 1))}`;
    expect((await sellerFromSession(reqWithCookie(freshCookie)))?.id).toBe(sellerId);
  });

  it("a >30-day-old cookie is rejected even at the matching epoch", async () => {
    const old = `${SESSION_COOKIE}=${encodeURIComponent(
      signSession(sellerId, 1, Date.now() - 31 * 24 * 3600 * 1000),
    )}`;
    expect(await sellerFromSession(reqWithCookie(old))).toBeNull();
  });
});
