// HTTP integration tests for the token + revocation endpoints (spec THI-11
// §2.6/§2.7): PKCE exchange, single-use codes, replay → family revocation,
// refresh rotation, F9 wrong-client revocation, RFC 7009 no-oracle revoke.
// Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";
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

const REDIRECT_URI = "http://localhost:51717/callback";

describe.skipIf(!available)("oauth token + revoke endpoints (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let issuer: string;
  let db: pg.Client;
  let cookie: string;
  let sellerId: string;
  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const clients: string[] = [];

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    mountOauthRoutes(app);
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
      issuer = baseUrl;
    }
    db = new pg.Client({ connectionString });
    await db.connect();

    const runTag = crypto.randomBytes(4).toString("hex");
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`thg_test_${runTag}`, "Token Tester", `token-test-${runTag}@example.com`, "x"],
    );
    sellerId = seller.rows[0].id;
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId))}`;

    for (const [id, name] of [
      ["thgc_tok1", "Token Client One"],
      ["thgc_tok2", "Token Client Two"],
    ] as const) {
      await db.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)
         ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
        [id, name, [REDIRECT_URI]],
      );
      clients.push(id);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_codes WHERE client_id = ANY($1)`, [clients]);
    await db.query(`DELETE FROM oauth_tokens t USING oauth_grants g WHERE t.grant_id = g.id AND g.client_id = ANY($1)`, [clients]);
    await db.query(`DELETE FROM oauth_grants WHERE client_id = ANY($1)`, [clients]);
    await db.query(`DELETE FROM oauth_clients WHERE client_id = ANY($1)`, [clients]);
    await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Drives the real authorize flow and returns a live code (bound to `client`). */
  async function mintCode(clientId: string, overrides: Record<string, string | undefined> = {}): Promise<string> {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      ...overrides,
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
    return (new URL(allow.headers.get("location") as string)).searchParams.get("code") as string;
  }

  async function tokenRequest(body: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  async function grantAlive(grantId: string): Promise<boolean> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_grants WHERE id = $1 AND revoked_at IS NULL`,
      [grantId],
    );
    return rows[0].n === 1;
  }

  async function grantIdOfCode(code: string): Promise<string> {
    const { rows } = await db.query<{ grant_id: string }>(`SELECT grant_id FROM oauth_codes WHERE code_hash = $1`, [
      crypto.createHash("sha256").update(code).digest("hex"),
    ]);
    return rows[0].grant_id;
  }

  /** Captures `code_replay` security events for one grant while `fn` runs
   * (securityEvent writes JSON lines to console.error — spec §4.5). */
  async function captureCodeReplays(grantId: string, fn: () => Promise<void>): Promise<number> {
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== "string") continue;
        try {
          const parsed = JSON.parse(arg) as { security_event?: string; grant_id?: string };
          if (parsed.security_event === "code_replay" && parsed.grant_id === grantId) seen.push(arg);
        } catch {
          /* not a security-event line */
        }
      }
    };
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return seen.length;
  }

  it("exchanges a code for an access+refresh pair and consumes the code exactly once", async () => {
    const code = await mintCode("thgc_tok1");
    const res = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "thgc_tok1",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const pair = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(pair.access_token).toMatch(/^thgo_[A-Za-z0-9_-]{43}$/);
    expect(pair.refresh_token).toMatch(/^thgr_[A-Za-z0-9_-]{43}$/);
    expect(pair.expires_in).toBe(1800);
    expect(pair.scope).toBe("mcp");

    // Replay of the consumed code: invalid_grant AND family revocation.
    const grantId = await grantIdOfCode(code);
    const replay = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "thgc_tok1",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect(await grantAlive(grantId)).toBe(false);
    // The minted refresh token is dead too (family revocation).
    const deadRefresh = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair.refresh_token });
    expect(((await deadRefresh.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier without consuming the code (retry then succeeds)", async () => {
    const code = await mintCode("thgc_tok1");
    const wrong = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "thgc_tok1",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: "w".repeat(64),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");

    const good = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "thgc_tok1",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(good.status).toBe(200);
    await good.json();
  });

  it("rejects malformed verifiers, wrong redirect_uri, and wrong resource", async () => {
    const code = await mintCode("thgc_tok1");
    const base = { grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI };
    const malformed = await tokenRequest({ ...base, code_verifier: "short" });
    expect(((await malformed.json()) as { error: string }).error).toBe("invalid_grant");

    const wrongRedirect = await tokenRequest({ ...base, code_verifier: verifier, redirect_uri: "http://localhost:51717/other" });
    expect(((await wrongRedirect.json()) as { error: string }).error).toBe("invalid_grant");

    const codeWithResource = await mintCode("thgc_tok1", { resource: `${issuer}/mcp` });
    const wrongResource = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "thgc_tok1",
      code: codeWithResource,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: "https://api.evil.com/mcp",
    });
    expect(((await wrongResource.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects unknown clients and unsupported grant types", async () => {
    const unknown = await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_missing", code: "x", redirect_uri: REDIRECT_URI, code_verifier: verifier });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_client");

    const unsupported = await tokenRequest({ grant_type: "password", client_id: "thgc_tok1" });
    expect(((await unsupported.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("rotates refresh tokens; replaying the rotated one kills the whole family", async () => {
    const code = await mintCode("thgc_tok1");
    const first = (await (
      await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    ).json()) as { access_token: string; refresh_token: string };

    const second = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    const pair2 = (await second.json()) as { access_token: string; refresh_token: string };
    expect(pair2.refresh_token).not.toBe(first.refresh_token);

    // Replay the rotated (now revoked) refresh → family revocation.
    const replay = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: first.refresh_token });
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    // The successor pair died with the grant.
    const successor = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair2.refresh_token });
    expect(((await successor.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("F9: a valid refresh token presented with the wrong client_id revokes the grant", async () => {
    const code = await mintCode("thgc_tok1");
    const pair = (await (
      await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    ).json()) as { refresh_token: string };

    const wrongClient = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok2", refresh_token: pair.refresh_token });
    expect(wrongClient.status).toBe(400);
    expect(((await wrongClient.json()) as { error: string }).error).toBe("invalid_client");

    const retry = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair.refresh_token });
    expect(((await retry.json()) as { error: string }).error).toBe("invalid_grant"); // grant revoked
  });

  it("revocation endpoint: always 200, no oracle; right client ends the connection", async () => {
    const unknown = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "thgr_unknown", client_id: "thgc_tok1" }).toString(),
    });
    expect(unknown.status).toBe(200);

    const code = await mintCode("thgc_tok1");
    const pair = (await (
      await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    ).json()) as { refresh_token: string };

    // Revoke from the WRONG client: 200, but must not disconnect the owner.
    const wrongClient = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: pair.refresh_token, client_id: "thgc_tok2" }).toString(),
    });
    expect(wrongClient.status).toBe(200);
    const stillAlive = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair.refresh_token });
    expect(stillAlive.status).toBe(200);
    await stillAlive.json();

    // Revoke from the RIGHT client: connection ends.
    const right = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: pair.refresh_token, client_id: "thgc_tok1" }).toString(),
    });
    expect(right.status).toBe(200);
    const dead = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair.refresh_token });
    expect(((await dead.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("THI-41: the racing-replay loser of the code consume fires code_replay and revokes the family", async () => {
    const code = await mintCode("thgc_tok1");
    const grantId = await grantIdOfCode(code);

    // Winner-in-flight: consume the code and mint a token, but hold the
    // transaction open so the HTTP request below blocks on its conditional
    // UPDATE — forcing the exact loser path (pre-check passed, consume lost).
    const winner = new pg.Client({ connectionString });
    await winner.connect();
    await winner.query("BEGIN");
    await winner.query(`UPDATE oauth_codes SET consumed_at = now() WHERE code_hash = $1`, [
      crypto.createHash("sha256").update(code).digest("hex"),
    ]);
    await winner.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at)
       VALUES ($1, 'access', $2, now() + interval '30 minutes')`,
      [grantId, crypto.createHash("sha256").update(`thgo_${crypto.randomBytes(24).toString("hex")}`).digest("hex")],
    );

    let res!: Response;
    const replays = await captureCodeReplays(grantId, async () => {
      const pending = tokenRequest({
        grant_type: "authorization_code",
        client_id: "thgc_tok1",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      // Wait until the request is blocked on the winner's row lock, then let
      // the winner commit: the blocked UPDATE re-checks and loses the race.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND state = 'active'
             AND query LIKE '%oauth_codes SET consumed_at = now() WHERE code_hash = $1 AND consumed_at IS NULL%'`,
        );
        if (rows[0].n >= 1) break;
        if (Date.now() > deadline) throw new Error("code-consume UPDATE never blocked on the winner's lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await winner.query("COMMIT");
      res = await pending;
    });
    await winner.end();

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    // The loser is not silent: exactly one code_replay event for this grant.
    expect(replays).toBe(1);
    // And the whole family died — including the winner's just-minted token.
    expect(await grantAlive(grantId)).toBe(false);
    const alive = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_tokens WHERE grant_id = $1 AND revoked_at IS NULL`, [grantId]);
    expect(alive.rows[0].n).toBe(0);
  });

  it("THI-41: N-way race on one code — every 400 loser emits code_replay; family revoked", async () => {
    const code = await mintCode("thgc_tok1");
    const grantId = await grantIdOfCode(code);
    const responses: Response[] = [];
    const replays = await captureCodeReplays(grantId, async () => {
      responses.push(
        ...(await Promise.all(
          Array.from({ length: 12 }, () =>
            tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
          ),
        )),
      );
    });
    await Promise.all(responses.map((r) => r.json())); // drain bodies
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1); // exactly one winner
    const losers = statuses.filter((s) => s === 400).length;
    expect(losers).toBe(11);
    expect(replays).toBe(losers); // no silent losers (main fails here)
    expect(await grantAlive(grantId)).toBe(false);
  });

  it("expired codes and expired refresh tokens are invalid_grant without grant damage", async () => {
    const code = await mintCode("thgc_tok1");
    await db.query(`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [
      crypto.createHash("sha256").update(code).digest("hex"),
    ]);
    const expiredCode = await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    expect(((await expiredCode.json()) as { error: string }).error).toBe("invalid_grant");
    const grantId = await grantIdOfCode(code);
    expect(await grantAlive(grantId)).toBe(true); // expiry never revokes (§2.9)

    const code2 = await mintCode("thgc_tok1");
    const pair = (await (
      await tokenRequest({ grant_type: "authorization_code", client_id: "thgc_tok1", code: code2, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    ).json()) as { refresh_token: string };
    await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
      crypto.createHash("sha256").update(pair.refresh_token).digest("hex"),
    ]);
    const expiredRefresh = await tokenRequest({ grant_type: "refresh_token", client_id: "thgc_tok1", refresh_token: pair.refresh_token });
    expect(((await expiredRefresh.json()) as { error: string }).error).toBe("invalid_grant");
  });
});
