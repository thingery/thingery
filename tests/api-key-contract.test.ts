// THI-158 contract-phase regression tests (security doc §6 H2.1): the
// schema migration that drops sellers.api_key must be hash-before-drop — a
// database still on the pre-expand schema (plaintext api_key, no hash
// column) must migrate without locking any seller out (Security review
// requirement R1: material). A naive DROP COLUMN without backfill would
// leave api_key_hash NULL for every existing row and silently invalidate
// every direct upgrader's key; the hash-equality assertion below fails on
// that variant (verified during THI-158 development).
//
// The throwaway environment is a dedicated schema (search_path-isolated) in
// the shared test database — the thingery role cannot CREATE DATABASE
// locally, and the migration under test is table-local anyway. The full
// db/schema.sql is applied end-to-end so the shipped file itself is what
// gets proven, and re-applied to lock idempotency in the steady state
// (fresh databases never have the column; the guarded backfill must
// tolerate its absence). Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";
import { apiKeyHash } from "../src/auth.js";

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

/** The sellers table exactly as a pre-THI-114 (expand) database had it:
 * plaintext api_key as a required unique column, no api_key_hash. */
const PRE_EXPAND_SELLERS = `
  CREATE TABLE sellers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key       TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    email         TEXT UNIQUE,
    password_hash TEXT,
    session_epoch INT NOT NULL DEFAULT 0
  )`;

describe.skipIf(!available)("api_key contract drop (THI-158)", () => {
  let db: pg.Client;
  const schema = `thi158_${crypto.randomBytes(4).toString("hex")}`;
  const key = `thg_contract_${crypto.randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    // public stays on the search_path so the pgvector extension types used by
    // the items table resolve; every unqualified object schema.sql creates
    // lands in the throwaway schema (first entry), like a fresh database.
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}, public`);
    await db.query(PRE_EXPAND_SELLERS);
    await db.query(`INSERT INTO sellers (api_key, display_name) VALUES ($1, $2)`, [
      key,
      "Direct Upgrader",
    ]);
  });

  afterAll(async () => {
    // search_path is reset by the explicit qualification; the pool must not
    // hold the throwaway schema as its default.
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await db.end();
  });

  it("migrates a pre-expand database hash-before-drop (R1: no seller locked out)", async () => {
    // The full shipped file, applied as one multi-statement query exactly
    // like scripts/migrate.ts and the rest of the test suite do.
    await db.query(readFileSync(schemaPath, "utf8"));

    // Plaintext column gone; hash column present.
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sellers' AND column_name LIKE 'api_key%'`,
      [schema],
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["api_key_hash"]);

    // The upgrader's pre-migration key still authenticates: the stored hash
    // equals what sellerFromApiKey computes for it. This is the assertion a
    // naive DROP COLUMN-without-backfill fails (hash stays NULL).
    const after = await db.query<{ api_key_hash: string | null }>(
      `SELECT api_key_hash FROM sellers WHERE display_name = 'Direct Upgrader'`,
    );
    expect(after.rows[0].api_key_hash).toBe(apiKeyHash(key));
  });

  it("re-applying schema.sql in the steady state is idempotent", async () => {
    // Second apply: column already dropped — the guarded backfill's
    // undefined_column handler must keep the file a clean no-op.
    await db.query(readFileSync(schemaPath, "utf8"));
    const after = await db.query<{ api_key_hash: string | null }>(
      `SELECT api_key_hash FROM sellers WHERE display_name = 'Direct Upgrader'`,
    );
    expect(after.rows[0].api_key_hash).toBe(apiKeyHash(key));
  });
});
