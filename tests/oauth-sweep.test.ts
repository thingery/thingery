// Retention sweeps (spec THI-11 §4.5, F6): each rule deletes only what is
// past its window and keeps everything still live. Requires Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import { runOauthSweeps } from "../src/oauth-sweep.js";
import { sha256Hex } from "../src/oauth.js";

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

describe.skipIf(!available)("oauth retention sweeps (§4.5)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  const clientId = `thgc_sweep_${runTag}`;
  let sellerId: string;
  let freshGrant: string;
  let staleGrant: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();

    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_sweep_${runTag}`, "Sweep Tester"],
    );
    sellerId = seller.rows[0].id;

    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, authorized_at)
       VALUES ($1, 'Sweep Client', ARRAY['http://localhost:1/cb'], now() - interval '10 days', now())`,
      [clientId],
    );

    const g1 = await db.query<{ id: string }>(
      `INSERT INTO oauth_grants (seller_id, client_id) VALUES ($1, $2) RETURNING id`,
      [sellerId, clientId],
    );
    freshGrant = g1.rows[0].id;

    // A revoked grant older than 90 days whose tokens are all revoked.
    const g2 = await db.query<{ id: string }>(
      `INSERT INTO oauth_grants (seller_id, client_id, created_at, revoked_at)
       VALUES ($1, $2, now() - interval '100 days', now() - interval '95 days') RETURNING id`,
      [sellerId, clientId],
    );
    staleGrant = g2.rows[0].id;
    await db.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at, revoked_at)
       VALUES ($1, 'refresh', $2, now() - interval '40 days', now() - interval '95 days')`,
      [staleGrant, sha256Hex(`thgr_sweep_${runTag}`)],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_codes WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM oauth_tokens t USING oauth_grants g WHERE t.grant_id = g.id AND g.seller_id = $1`, [sellerId]);
    await db.query(`DELETE FROM oauth_grants WHERE seller_id = $1`, [sellerId]);
    await db.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    await db.end();
  });

  it("deletes stale codes, keeps fresh ones (rule 1)", async () => {
    const staleHash = sha256Hex("thga_sweep_stale_code");
    const freshHash = sha256Hex("thga_sweep_fresh_code");
    await db.query(
      `INSERT INTO oauth_codes (code_hash, grant_id, client_id, seller_id, redirect_uri, code_challenge, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'http://localhost:1/cb', 'c', now(), now() - interval '2 hours')`,
      [staleHash, freshGrant, clientId, sellerId],
    );
    await db.query(
      `INSERT INTO oauth_codes (code_hash, grant_id, client_id, seller_id, redirect_uri, code_challenge, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'http://localhost:1/cb', 'c', now() + interval '30 seconds', now())`,
      [freshHash, freshGrant, clientId, sellerId],
    );
    await runOauthSweeps();
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_codes WHERE code_hash = ANY($1)`,
      [[staleHash, freshHash]],
    );
    expect(rows[0].n).toBe(1); // only the fresh code survives
  });

  it("deletes expired access tokens past 24 h, keeps recent expired ones (rule 2)", async () => {
    const oldHash = sha256Hex("thgo_sweep_old_access");
    const recentHash = sha256Hex("thgo_sweep_recent_access");
    for (const [hash, age] of [
      [oldHash, "2 days"],
      [recentHash, "1 hour"],
    ] as const) {
      await db.query(
        `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at)
         VALUES ($1, 'access', $2, now() - interval '${age}')`,
        [freshGrant, hash],
      );
    }
    await runOauthSweeps();
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1`,
      [oldHash],
    );
    expect(rows[0].n).toBe(0);
    const keep = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1`,
      [recentHash],
    );
    expect(keep.rows[0].n).toBe(1);
  });

  it("deletes never-authorized clients older than 7 days (rule 4)", async () => {
    const spam = `thgc_spam_${runTag}`;
    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
       VALUES ($1, 'DCR Spam', ARRAY['http://localhost:1/cb'], now() - interval '8 days')`,
      [spam],
    );
    await runOauthSweeps();
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = $1`,
      [spam],
    );
    expect(rows[0].n).toBe(0);
  });

  it("deletes long-revoked grants once no live token remains (rule 5), keeps active grants", async () => {
    await runOauthSweeps();
    const gone = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_grants WHERE id = $1`, [staleGrant]);
    expect(gone.rows[0].n).toBe(0);
    const alive = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_grants WHERE id = $1`, [freshGrant]);
    expect(alive.rows[0].n).toBe(1);
  });
});
