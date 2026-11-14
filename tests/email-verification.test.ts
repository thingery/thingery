// THI-762 / THI-760 plan Phase 0, PR 1 (email verification groundwork):
// schema columns exist and stay NULL on existing accounts; signup mints a
// single-use expiring token stored hash-only; the plaintext surfaces ONLY in
// non-production signup responses. No mailer, no routes, no sending yet —
// this deploy is dark by construction. Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountApiRoutes } from "../src/routes.js";
import { pool } from "../src/db.js";
import {
  createAccount,
  emailVerificationTokenHash,
  EMAIL_VERIFICATION_TOKEN_PREFIX,
  EMAIL_VERIFICATION_TTL_S,
} from "../src/auth.js";

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

describe.skipIf(!available)("email verification groundwork (THI-762 PR 1)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
  });
  afterAll(async () => {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("signup stores only the token hash, with a ~48h expiry, unverified", async () => {
    const account = await createAccount(`thi762-pr1-hash-${runTag}@example.test`, "correct horse battery", "THI-762");
    expect(account.email_verification_token.startsWith(EMAIL_VERIFICATION_TOKEN_PREFIX)).toBe(true);
    // 256-bit random body → 43 base64url chars after the prefix.
    expect(account.email_verification_token).toHaveLength(EMAIL_VERIFICATION_TOKEN_PREFIX.length + 43);

    const { rows } = await db.query(
      `SELECT email_verified_at, email_verification_token_hash, email_verification_expires_at, email_bounced_at
         FROM sellers WHERE id = $1`,
      [account.id],
    );
    const row = rows[0];
    expect(row.email_verified_at).toBeNull(); // new accounts start unverified
    expect(row.email_bounced_at).toBeNull(); // groundwork column, never set in Phase 0
    expect(row.email_verification_token_hash).toBe(emailVerificationTokenHash(account.email_verification_token));
    expect(row.email_verification_token_hash).not.toContain(account.email_verification_token); // hash-only at rest
    const ttlMs = new Date(row.email_verification_expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan((EMAIL_VERIFICATION_TTL_S - 60) * 1000);
    expect(ttlMs).toBeLessThan(EMAIL_VERIFICATION_TTL_S * 1000);
  });

  it("tokens are single-issue and unique (no two accounts share a hash)", async () => {
    const a = await createAccount(`thi762-pr1-a-${runTag}@example.test`, "correct horse battery", "A");
    const b = await createAccount(`thi762-pr1-b-${runTag}@example.test`, "correct horse battery", "B");
    expect(a.email_verification_token).not.toBe(b.email_verification_token);
  });

  it("signup response surfaces the token only outside production", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    mountApiRoutes(app);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const res = await fetch(`${base}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `thi762-pr1-dev-${runTag}@example.test`, password: "correct horse battery" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        seller: { email: string };
        email_verification?: { token: string; expires_in_s: number };
      };
      expect(body.seller.email).toBe(`thi762-pr1-dev-${runTag}@example.test`);
      expect(body.email_verification?.token.startsWith(EMAIL_VERIFICATION_TOKEN_PREFIX)).toBe(true);
      expect(body.email_verification?.expires_in_s).toBe(EMAIL_VERIFICATION_TTL_S);

      vi.stubEnv("NODE_ENV", "production");
      try {
        const resProd = await fetch(`${base}/api/signup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `thi762-pr1-prod-${runTag}@example.test`, password: "correct horse battery" }),
        });
        expect(resProd.status).toBe(200);
        const bodyProd = (await resProd.json()) as { email_verification?: unknown };
        expect(bodyProd.email_verification).toBeUndefined(); // never surfaced in production
        // ...and the account still got its token at rest:
        const { rows } = await db.query(
          `SELECT email_verification_token_hash FROM sellers WHERE email = $1`,
          [`thi762-pr1-prod-${runTag}@example.test`],
        );
        expect(rows[0].email_verification_token_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        vi.unstubAllEnvs();
      }
    } finally {
      server.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("schema columns are additive: existing sellers rows keep NULLs (deployable dark)", async () => {
    // A pre-Phase-0-shaped row (no verification columns set) — the ALTER
    // defaults. Legacy/NULL-email accounts are simply "not verified".
    const { rows } = await db.query(
      `INSERT INTO sellers (display_name) VALUES ($1)
       RETURNING id, email, email_verified_at, email_verification_token_hash`,
      [`thi762-legacy-${runTag}`],
    );
    const legacy = rows[0];
    expect(legacy.email).toBeNull(); // OAuth-style account, no address at all
    expect(legacy.email_verified_at).toBeNull();
    expect(legacy.email_verification_token_hash).toBeNull();
  });
});
