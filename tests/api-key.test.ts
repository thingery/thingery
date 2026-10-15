// THI-114 (expand) + THI-158 (contract) regression tests (security doc §6
// H2.1): sha256 hash-only round-trip (the expand-phase plaintext fallback is
// gone with the column), the contract drop of sellers.api_key, show-once key
// semantics on /api/* (signup/regenerate — THI-125 verdict: login no longer
// returns the key), and the regenerate endpoint (rotation revokes the old
// key atomically). Requires Postgres; skips otherwise.
//
// The pre-expand → contract migration itself is covered by
// tests/api-key-contract.test.ts on a throwaway schema.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";
import { mountApiRoutes } from "../src/routes.js";
import { pool } from "../src/db.js";
import { apiKeyHash, sellerFromApiKey, SESSION_COOKIE, signSession } from "../src/auth.js";

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

/** Extracts the `thingery_session=<value>` pair from a response's Set-Cookie
 * (the regenerate endpoint re-signs the acting session after the epoch bump). */
function sessionCookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie");
  expect(raw).toBeTruthy();
  const part = String(raw)
    .split(",")
    .find((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
  expect(part).toBeTruthy();
  return part!.trim().split(";")[0];
}

describe.skipIf(!available)("API key hash at rest (THI-114 + THI-158)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it("drops sellers.api_key — steady-state schema re-apply (THI-158 contract)", async () => {
    // Re-applying db/schema.sql on the shared test database (idempotent, the
    // same thing scripts/migrate.ts runs) must migrate it to the contract
    // state: plaintext column gone, hash column the only key storage.
    await pool.query(readFileSync(schemaPath, "utf8"));
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sellers' AND column_name LIKE 'api_key%'`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["api_key_hash"]);
  });

  it("resolves a key by hash (round-trip) and rejects a wrong key", async () => {
    const key = `thg_hashed_${runTag}`;
    await db.query(
      `INSERT INTO sellers (api_key_hash, display_name) VALUES ($1, $2)`,
      [apiKeyHash(key), "Hashed Test"],
    );
    const seller = await sellerFromApiKey(key);
    expect(seller?.display_name).toBe("Hashed Test");
    expect(seller).not.toHaveProperty("api_key"); // auth rows carry no plaintext
    expect(await sellerFromApiKey(`thg_wrong_${runTag}`)).toBeNull();
  });

  it("has no plaintext fallback — hash-only lookup (contract)", async () => {
    // The expand-phase dual-read window is closed: a key whose hash isn't
    // stored can never authenticate, because there is no plaintext column
    // left to fall back to.
    const key = `thg_nofallback_${runTag}`;
    expect(await sellerFromApiKey(key)).toBeNull();
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sellers' AND column_name = 'api_key'`,
    );
    expect(cols.rows).toEqual([]);
  });

  describe("HTTP surface", () => {
    let server: Server;
    let base: string;
    let cookie: string;
    let signupKey: string;
    let regenCookie: string;
    const email = `thi114-${runTag}@example.com`;

    beforeAll(async () => {
      const app = express();
      app.set("trust proxy", 1);
      app.use(express.json({ limit: "256kb" }));
      mountApiRoutes(app);
      server = app.listen(0);
      const address = server.address();
      if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;

      const signup = await fetch(`${base}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ email, password: "password123", name: "Key Tester" }),
      });
      expect(signup.status).toBe(200);
      const body = (await signup.json()) as { seller: { api_key: string } };
      // Show-once moment #1: signup reveals the key exactly once.
      expect(body.seller.api_key).toMatch(/^thg_[A-Za-z0-9_-]+$/);
      signupKey = body.seller.api_key;
      cookie = `${SESSION_COOKIE}=${encodeURIComponent(
        signSession(
          (await db.query<{ id: string }>(`SELECT id FROM sellers WHERE email = $1`, [email])).rows[0].id,
        ),
      )}`;
    });

    afterAll(() => {
      server.close();
    });

    it("/api/me is logged-in but carries no api_key", async () => {
      const me = await fetch(`${base}/api/me`, { headers: { cookie } });
      expect(me.status).toBe(200);
      const body = (await me.json()) as { seller: { name: string } | null };
      expect(body.seller?.name).toBe("Key Tester");
      expect(body.seller).not.toHaveProperty("api_key");
    });

    it("POST /api/me/api-key requires a session", async () => {
      const res = await fetch(`${base}/api/me/api-key`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Log in to manage your API key." });
    });

    it("regenerate returns a new key once and revokes the old one atomically", async () => {
      // The signup key authenticates before rotation.
      expect((await sellerFromApiKey(signupKey))?.display_name).toBe("Key Tester");

      const regen = await fetch(`${base}/api/me/api-key`, {
        method: "POST",
        headers: { cookie, "x-forwarded-for": "203.0.113.51" },
      });
      expect(regen.status).toBe(200);
      expect(regen.headers.get("cache-control")).toBe("no-store"); // never cache the plaintext key
      regenCookie = sessionCookieFrom(regen); // re-signed at the bumped epoch
      const body = (await regen.json()) as { api_key: string };
      expect(body.api_key).toMatch(/^thg_[A-Za-z0-9_-]+$/);
      expect(body.api_key).not.toBe(signupKey);
      expect(Object.keys(body)).toEqual(["api_key"]);

      // New key works (hash lookup); old key is dead — neither hash nor the
      // plaintext fallback resolves it anymore.
      expect((await sellerFromApiKey(body.api_key))?.display_name).toBe("Key Tester");
      expect(await sellerFromApiKey(signupKey)).toBeNull();
    });

    it("regenerate revokes other sessions but keeps the acting one (THI-115 epoch bump)", async () => {
      // The pre-rotation cookie (epoch 0) is revoked by the epoch bump in the
      // regenerate UPDATE (THI-114 spec item 3)…
      const stale = await fetch(`${base}/api/me`, { headers: { cookie } });
      expect(stale.status).toBe(200);
      expect(((await stale.json()) as { seller: unknown }).seller).toBeNull();
      // …while the cookie re-signed in the regenerate response authenticates.
      const fresh = await fetch(`${base}/api/me`, { headers: { cookie: regenCookie } });
      expect(fresh.status).toBe(200);
      expect(((await fresh.json()) as { seller: { name: string } }).seller?.name).toBe("Key Tester");
    });

    it("login no longer returns the key (THI-125 verdict / THI-158 contract)", async () => {
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.52" },
        body: JSON.stringify({ email, password: "password123" }),
      });
      expect(login.status).toBe(200);
      // Login authenticates and returns name+email only — the key is show-once
      // (signup/regenerate), and the plaintext column it used to be read from
      // no longer exists.
      const body = (await login.json()) as { seller: { name?: string; email?: string; api_key?: string } };
      expect(body.seller).toEqual({ name: "Key Tester", email });
      expect(body.seller).not.toHaveProperty("api_key");
    });

    it("rotation is rate-limited per seller", async () => {
      let status = 0;
      for (let i = 0; i < 12 && status !== 429; i++) {
        const res = await fetch(`${base}/api/me/api-key`, {
          method: "POST",
          headers: { cookie: regenCookie, "x-forwarded-for": "203.0.113.53" },
        });
        status = res.status;
        // Each successful rotation bumps the epoch again — follow the latest
        // re-signed cookie or the next request would 401 on a stale epoch.
        if (status === 200) regenCookie = sessionCookieFrom(res);
      }
      expect(status).toBe(429);
    });
  });
});
