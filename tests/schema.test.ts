// Schema migration test (spec THI-11 rev 2, PR 1).
// Applies db/schema.sql to a fresh database and asserts the OAuth tables exist
// with the normative columns; re-applies to prove idempotency (expand-only).
// Skips when no Postgres is reachable so bare `npm test` stays green locally.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    connectionTimeoutMillis: 1500,
  });
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

describe.skipIf(!available)("db schema", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("applies the schema to a fresh database without error", async () => {
    // Hermetic: drop the OAuth tables so every run exercises a true fresh apply
    // (the file uses CREATE TABLE IF NOT EXISTS, which would otherwise no-op).
    // Wrapped in a transaction: vitest runs test files in parallel workers, so
    // the drop/recreate must be atomic to concurrent DB users (THI-31) — without
    // the txn, oauth-register.test.ts can observe a window with no oauth
    // tables and fail with 42P01-driven 500s.
    await client.query("BEGIN");
    try {
      await client.query(
        `DROP TABLE IF EXISTS oauth_codes, oauth_tokens, oauth_grants, oauth_clients CASCADE`,
      );
      await client.query(readFileSync(schemaPath, "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  it("is idempotent: re-applying the schema is a no-op", async () => {
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  it("creates the OAuth tables with the normative columns (THI-11 §3)", async () => {
    const expected: Record<string, string[]> = {
      oauth_clients: ["client_id", "client_name", "client_uri", "redirect_uris", "created_at", "authorized_at"],
      oauth_grants: ["id", "seller_id", "client_id", "scope", "created_at", "revoked_at"],
      oauth_tokens: [
        "id",
        "grant_id",
        "kind",
        "token_hash",
        "expires_at",
        "revoked_at",
        "created_at",
        "last_used_at",
      ],
      oauth_codes: [
        "code_hash",
        "grant_id",
        "client_id",
        "seller_id",
        "redirect_uri",
        "code_challenge",
        "resource",
        "scope",
        "expires_at",
        "consumed_at",
        "created_at",
      ],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const actual = rows.map((r) => r.column_name).sort();
      expect(actual).toEqual([...columns].sort());
    }
  });

  it("enforces the token kind CHECK and unique token hash", async () => {
    await expect(
      client.query(`INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at)
                    VALUES (gen_random_uuid(), 'macaroon', 'x', now())`),
    ).rejects.toThrow();
  });

  it("cascades seller deletion through grants and tokens", async () => {
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_schema_${Date.now()}`, "schema-test"],
    );
    const sellerId = seller.rows[0].id;
    const oauthClient = await client.query<{ client_id: string }>(
      `INSERT INTO oauth_clients (client_id, redirect_uris) VALUES ($1, $2) RETURNING client_id`,
      [`thgc_schema_${Date.now()}`, ["http://localhost:6274/callback"]],
    );
    const grant = await client.query<{ id: string }>(
      `INSERT INTO oauth_grants (seller_id, client_id) VALUES ($1, $2) RETURNING id`,
      [sellerId, oauthClient.rows[0].client_id],
    );
    await client.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES ($1, 'access', $2, now())`,
      [grant.rows[0].id, `hash_${Date.now()}`],
    );
    await client.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    const tokens = await client.query(`SELECT 1 FROM oauth_tokens WHERE grant_id = $1`, [grant.rows[0].id]);
    expect(tokens.rowCount).toBe(0);
  });
});
