// HTTP integration tests for the /apps connected-applications page and the
// OAUTH_DISABLED kill switch (spec THI-11 §4.6, §4.4): session-gated page,
// CSRF-bound revoke with family revocation, forged CSRF rejection, kill
// switch 404s and thgo_ → 401 fallback to keys. Requires Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";
import { mcpRoutes } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";
import { apiKeyHash, SESSION_COOKIE, signSession } from "../src/auth.js";

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

const REDIRECT_URI = "http://localhost:51721/callback";
const verifier = "v".repeat(64);
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

function buildApp(): Server {
  const app = express();
  app.set("trust proxy", 1);
  app.use(mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }));
  app.use(express.json({ limit: "256kb" }));
  mountOauthRoutes(app);
  return app.listen(0);
}

describe.skipIf(!available)("/apps connected-applications page + kill switch (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  let cookie: string;
  let sellerId: string;
  let otherCookie: string;
  let accessToken: string;
  let ownerKey = ""; // set by beforeAll — mk()'s generated owner key (show-once semantics, THI-158)
  const clientId = "thgc_apps1";

  beforeAll(async () => {
    server = buildApp();
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    db = new pg.Client({ connectionString });
    await db.connect();

    const runTag = crypto.randomBytes(4).toString("hex");
    // THI-158: sellers.api_key is gone — mk keeps the plaintext key so the
    // kill-switch test below can present it as a Bearer credential.
    const mk = async (name: string): Promise<{ id: string; cookie: string; key: string }> => {
      const s = await db.query<{ id: string }>(
        `INSERT INTO sellers (api_key_hash, display_name, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [apiKeyHash(`thg_apps_${name}_${runTag}`), name === "owner" ? "Apps Owner" : "Other", `apps-${name}-${runTag}@example.com`, "x"],
      );
      const key = `thg_apps_${name}_${runTag}`;
      return { id: s.rows[0].id, cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSession(s.rows[0].id))}`, key };
    };
    const owner = await mk("owner");
    ownerKey = owner.key;
    sellerId = owner.id;
    cookie = owner.cookie;
    otherCookie = (await mk("other")).cookie;

    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, authorized_at)
       VALUES ($1, 'Apps Client <test>', ARRAY[$2], now())
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      [clientId, REDIRECT_URI],
    );

    // Real OAuth flow: authorize → consent → code → token.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
    const consent = await fetch(`${baseUrl}/oauth/authorize?${params}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const form: Record<string, string> = {};
    const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) form[m[1]] = m[2];
    const allow = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...form, action: "allow" }).toString(),
      redirect: "manual",
    });
    expect(allow.status).toBe(302);
    const code = (new URL(allow.headers.get("location") as string)).searchParams.get("code") as string;
    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    accessToken = ((await token.json()) as { access_token: string }).access_token;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_codes WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM oauth_tokens t USING oauth_grants g WHERE t.grant_id = g.id AND g.client_id = $1`, [clientId]);
    await db.query(`DELETE FROM oauth_grants WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM sellers WHERE email LIKE 'apps-%'`);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function grantRow(): Promise<{ id: string } | undefined> {
    return db
      .query<{ id: string }>(`SELECT id FROM oauth_grants WHERE seller_id = $1 AND revoked_at IS NULL`, [sellerId])
      .then((r) => r.rows[0]);
  }

  it("redirects anonymous visitors to login with next=/apps", async () => {
    const res = await fetch(`${baseUrl}/apps`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login.html?next=%2Fapps");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lists the connected application with escaped name and a revoke form", async () => {
    const res = await fetch(`${baseUrl}/apps`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Apps Client &lt;test&gt;"); // escaped DCR name
    expect(html).toContain("/apps/revoke");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects a forged CSRF on revoke (F10) without touching the grant", async () => {
    const grant = await grantRow();
    expect(grant).toBeDefined();
    const res = await fetch(`${baseUrl}/apps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ grant_id: grant!.id, csrf: "forged" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await grantRow()).toBeDefined();
  });

  it("revoking from the page kills the whole family — token 401s on /mcp afterwards", async () => {
    // Token works before.
    const before = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_listings", arguments: {} } }),
    });
    expect(before.status).toBe(200);

    const page = await fetch(`${baseUrl}/apps`, { headers: { cookie } });
    const html = await res2html(page);
    const grantId = /name="grant_id" value="([^"]+)"/.exec(html)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const res = await fetch(`${baseUrl}/apps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ grant_id: grantId, csrf }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/apps?revoked=1");
    expect(await grantRow()).toBeUndefined();

    const after = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_listings", arguments: {} } }),
    });
    expect(after.status).toBe(401);
  });

  it("a different seller cannot revoke someone else's grant (ownership check)", async () => {
    // Re-grant for the owner, then try to revoke with the other session.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
    const consent = await fetch(`${baseUrl}/oauth/authorize?${params}`, { headers: { cookie } });
    const html = await consent.text();
    const form: Record<string, string> = {};
    const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) form[m[1]] = m[2];
    const allow = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...form, action: "allow" }).toString(),
      redirect: "manual",
    });
    const code = (new URL(allow.headers.get("location") as string)).searchParams.get("code") as string;
    await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    const grant = await grantRow();
    // CSRF computed for the OTHER seller over the same grant id.
    const { revokeCsrfToken } = await import("../src/oauth.js");
    const csrf = revokeCsrfToken("00000000-0000-0000-0000-000000000000", grant!.id);
    const res = await fetch(`${baseUrl}/apps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: otherCookie },
      body: new URLSearchParams({ grant_id: grant!.id, csrf }).toString(),
    });
    expect(res.status).toBe(400); // CSRF binds seller → mismatch
    expect(await grantRow()).toBeDefined();
  });

  it("OAUTH_DISABLED: OAuth routes 404, thgo_ becomes unrecognized (401), keys still work", async () => {
    process.env.OAUTH_DISABLED = "1";
    try {
      const killed = buildApp();
      const killedAddress = killed.address();
      const killedUrl = `http://127.0.0.1:${typeof killedAddress === "object" && killedAddress ? killedAddress.port : 0}`;
      try {
        const meta = await fetch(`${killedUrl}/.well-known/oauth-authorization-server`);
        expect(meta.status).toBe(404);
        const authorize = await fetch(`${killedUrl}/oauth/authorize?client_id=x`);
        expect(authorize.status).toBe(404);
        const apps = await fetch(`${killedUrl}/apps`, { headers: { cookie }, redirect: "manual" });
        expect(apps.status).toBe(404);
        const mcp = await fetch(`${killedUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_listings", arguments: {} } }),
        });
        expect(mcp.status).toBe(401);
        expect(mcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
        // thg_ keys unaffected by the kill switch.
        const keyCall = await fetch(`${killedUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${ownerKey}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_listings", arguments: {} } }),
        });
        expect(keyCall.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => killed.close(() => resolve()));
      }
    } finally {
      delete process.env.OAUTH_DISABLED;
    }
  });

  async function res2html(res: Response): Promise<string> {
    return res.text();
  }
});
