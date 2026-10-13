// THI-43 regression: the /oauth/token + /oauth/revoke rate-limit composite key
// includes free-form client_id, so rotating it mints a fresh bucket per request
// and the declared per-IP dimension never bites. A coarse per-IP backstop must
// bound both endpoints: 429 before the DB is consulted on /oauth/token, and
// before the missing-parameter early return on /oauth/revoke.
// Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";
import { pool } from "../src/db.js";

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

const BACKSTOP = 6; // mounted via OAUTH_TOKEN_IP_HOURLY_LIMIT before mountOauthRoutes

describe.skipIf(!available)("oauth token/revoke per-IP backstop (THI-43)", () => {
  let server: Server;
  let baseUrl: string;
  const runTag = crypto.randomBytes(4).toString("hex");

  /** Counts pool.query calls while installed — proves whether the DB was consulted. */
  function countPoolQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
    const original = pool.query;
    let queries = 0;
    pool.query = ((...args: never[]) => {
      queries += 1;
      return original.apply(pool, args);
    }) as typeof pool.query;
    return fn().then(
      (result) => {
        pool.query = original;
        return { result, queries };
      },
      (error) => {
        pool.query = original;
        throw error;
      },
    );
  }

  beforeAll(async () => {
    process.env.OAUTH_TOKEN_IP_HOURLY_LIMIT = String(BACKSTOP); // read at mount time
    const app = express();
    app.set("trust proxy", 1);
    mountOauthRoutes(app);
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    delete process.env.OAUTH_TOKEN_IP_HOURLY_LIMIT;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function tokenRequest(clientId: string): Promise<Response> {
    return fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "thgc_nonexistent_code",
        redirect_uri: "http://localhost:51717/callback",
        code_verifier: "v".repeat(64),
      }).toString(),
    });
  }

  async function revokeRequest(body: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  it("rotating client_id from one IP trips the per-IP backstop: 429 before the DB is consulted", async () => {
    // Phase 1 — within the backstop budget: each request rotates to a fresh
    // client_id (fresh composite bucket), reaches the client lookup, and is
    // rejected as invalid_client. Proves the counter sees real queries.
    const within = await countPoolQueries(async () => tokenRequest(`thgc_${runTag}_a0`));
    expect(within.result.status).toBe(400);
    expect(((await within.result.json()) as { error: string }).error).toBe("invalid_client");
    expect(within.queries).toBeGreaterThan(0);

    // Spend the rest of the backstop budget (requests 2..BACKSTOP).
    for (let i = 1; i < BACKSTOP; i++) {
      const res = await tokenRequest(`thgc_${runTag}_a${i}`);
      expect(res.status).toBe(400); // unknown client, not rate-limited yet
      await res.json();
    }

    // Phase 2 — past the backstop with a brand-new client_id: must be 429 with
    // the existing error shape and Cache-Control: no-store, and the DB must not
    // be consulted (the composite bucket alone would have allowed it through).
    const blocked = await countPoolQueries(async () => tokenRequest(`thgc_${runTag}_b1`));
    expect(blocked.result.status).toBe(429);
    expect(blocked.result.headers.get("cache-control")).toBe("no-store");
    expect(await blocked.result.json()).toEqual({
      error: "invalid_request",
      error_description: "rate limit exceeded",
    });
    expect(blocked.queries).toBe(0); // short-circuits before clientById
  });

  it("revoke: backstop precedes the missing-parameter early return (malformed spam is bounded)", async () => {
    // The shared per-IP backstop is already exhausted by the test above (same
    // IP, same process-lifetime bucket), so even malformed revokes must 429.
    const missingParams = await countPoolQueries(async () =>
      revokeRequest({ unrelated: "x" }), // no token, no client_id
    );
    expect(missingParams.result.status).toBe(429);
    expect(((await missingParams.result.json()) as { error: string }).error).toBe("invalid_request");
    expect(missingParams.queries).toBe(0);

    // Well-formed revoke with a rotating client_id: also bounded (a fresh
    // composite bucket must not resurrect the endpoint).
    const rotating = await countPoolQueries(async () =>
      revokeRequest({ token: `thgr_${runTag}_never_issued`, client_id: `thgc_${runTag}_c${crypto.randomUUID()}` }),
    );
    expect(rotating.result.status).toBe(429);
    expect(rotating.queries).toBe(0);
  });
});
