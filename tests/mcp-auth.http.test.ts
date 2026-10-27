// HTTP integration tests for the /mcp method-aware 401 gate (spec THI-11
// §2.10): dual-token acceptance, present-but-invalid → 401 challenge,
// anonymous protected-tool call → 401 challenge, anonymous size cutoff,
// single 8 MB cap, parse-error parity, and the full OAuth path (minted
// thgo_ token authorizes a protected tool; revocation flips it to 401).
// Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";
import { mcpRoutes, MCP_MAX_BODY_BYTES, MCP_ANON_MAX_BYTES } from "../src/mcp-gate.js";
import { pool } from "../src/db.js";
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

const REDIRECT_URI = "http://localhost:51719/callback";
const verifier = "v".repeat(64);
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe.skipIf(!available)("/mcp method-aware 401 gate (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  let apiKey: string;
  let sellerId: string;
  let cookie: string;
  let accessToken: string;
  let refreshToken: string;
  const clientId = "thgc_gate1";

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }),
    );
    app.use(express.json({ limit: "256kb" }));
    mountOauthRoutes(app);
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    db = new pg.Client({ connectionString });
    await db.connect();

    const runTag = crypto.randomBytes(4).toString("hex");
    apiKey = `thg_gate_${runTag}`;
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [apiKeyHash(apiKey), "Gate Tester", `gate-test-${runTag}@example.com`, "x"],
    );
    sellerId = seller.rows[0].id;
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId))}`;

    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      [clientId, "Gate Client", [REDIRECT_URI]],
    );

    // Full OAuth flow against the real endpoints: authorize → consent → code.
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

    // Exchange for tokens.
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
    const pair = (await token.json()) as { access_token: string; refresh_token: string };
    accessToken = pair.access_token;
    refreshToken = pair.refresh_token;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_codes WHERE client_id = $1`, [clientId]);
    await db.query(
      `DELETE FROM oauth_tokens t USING oauth_grants g WHERE t.grant_id = g.id AND g.client_id = $1`,
      [clientId],
    );
    await db.query(`DELETE FROM oauth_grants WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM items WHERE seller_id = $1`, [sellerId]);
    await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body,
    });
  }

  /** Extracts the first JSON-RPC message from a (possibly SSE) response body. */
  function rpcBody(text: string): any {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  }

  /** Polls a probe until it returns non-null or the timeout elapses. */
  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5000): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("initialize works anonymously (public reads stay free)", async () => {
    const res = await post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect(body.result?.serverInfo?.name).toBe("thingery");
  });

  it("anonymous protected-tool call → 401 Bearer challenge with resource_metadata", async () => {
    const res = await post(rpc("tools/call", { name: "create_listing", arguments: { title: "x", price_cents: 1 } }));
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain("resource_metadata=");
    expect(www).not.toContain("invalid_token"); // no credentials presented → plain challenge
  });

  // THI-360 PR 2: the intent tools carry per-account data — anonymous calls
  // must hit the same method-aware gate (401 challenge, not a tool-level
  // refusal) so OAuth-capable hosts get sent to onboarding.
  it("anonymous save_intent call → 401 Bearer challenge (intent tools are per-account)", async () => {
    const res = await post(rpc("tools/call", { name: "save_intent", arguments: { q: "vintage watch" } }));
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain("resource_metadata=");
  });

  it("anonymous public-tool call passes the gate (tool-level result, not 401)", async () => {
    const res = await post(rpc("tools/call", { name: "search_items", arguments: { q: "anything" } }));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect(body.result?.content?.[0]?.text).toBeDefined();
  });

  it("batch containing any protected-tool call → 401 (per-element check)", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "my_listings", arguments: {} } },
    ]);
    const res = await post(batch);
    expect(res.status).toBe(401);
  });

  it("present-but-invalid thg_ key → 401 invalid_token (no silent anonymous)", async () => {
    const res = await post(rpc("search_items", { q: "x" }), { authorization: "Bearer thg_totally_unknown" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("unrecognized credential format → 401 invalid_token", async () => {
    const res = await post(rpc("search_items", { q: "x" }), { authorization: "Bearer junk-token" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("valid thg_ key still works end-to-end (backward compatibility)", async () => {
    const res = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${apiKey}`,
    });
    expect(res.status).toBe(200);
  });

  it("valid thgo_ OAuth token authorizes a protected tool (dual-token)", async () => {
    const res = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
    expect(payload.seller).toBe("Gate Tester");
  });

  it("thgo_ use advances last_used_at; a second use within 10 min does not (THI-11 rev 2 throttle)", async () => {
    const hash = crypto.createHash("sha256").update(accessToken, "utf8").digest("hex");
    const readLastUsed = async (): Promise<Date | null> => {
      const { rows } = await db.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM oauth_tokens WHERE token_hash = $1`,
        [hash],
      );
      return rows[0]?.last_used_at ?? null;
    };

    // Backdate the row well outside the 10-minute throttle window, then use
    // the token over /mcp: the fire-and-forget touch must advance the stamp.
    await db.query(`UPDATE oauth_tokens SET last_used_at = now() - interval '2 hours' WHERE token_hash = $1`, [hash]);
    const before = await readLastUsed();
    expect(before).not.toBeNull();

    const res = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(200);

    const first = await waitFor(async () => {
      const value = await readLastUsed();
      return value !== null && value.getTime() > (before as Date).getTime() ? value : null;
    });
    if (first === null) throw new Error("last_used_at did not advance after /mcp call with thgo_ token");

    // Second use inside the window: the throttled WHERE matches nothing, so
    // the stamp must be bit-for-bit unchanged.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const res2 = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${accessToken}`,
    });
    expect(res2.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await readLastUsed();
    expect(second?.getTime()).toBe(first.getTime());
  });

  it("expired thgo_ token → 401 invalid_token", async () => {
    const hash = crypto.createHash("sha256").update(accessToken, "utf8").digest("hex");
    await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [hash]);
    const res = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // refresh token rotation should still work — grant is alive, only access expired
    const refreshed = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const pair = (await refreshed.json()) as { access_token: string };
    accessToken = pair.access_token; // keep later assertions on a live token
  });

  it("revoked grant kills the thgo_ token (family revocation → 401)", async () => {
    const revoke = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: accessToken }).toString(),
    });
    expect(revoke.status).toBe(200);
    const res = await post(rpc("tools/call", { name: "my_listings", arguments: {} }), {
      authorization: `Bearer ${accessToken}`,
    });
    expect(res.status).toBe(401);
  });

  it("anonymous body above the 256 kB cutoff → 401 before parsing", async () => {
    const res = await post(`{"jsonrpc":"2.0","id":1,"method":"initialize","padding":"${"x".repeat(MCP_ANON_MAX_BYTES)}"}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("anonymous NON-JSON body above the 256 kB cutoff → 401 without parsing (not 400 parse error)", async () => {
    // Regression (THI-27): the size cutoff must be enforced BEFORE JSON.parse,
    // so anonymous callers never make us pay the parse cost on a big payload.
    // Old code parsed first and returned 400 -32700 for non-JSON bodies.
    const res = await post("x".repeat(MCP_ANON_MAX_BYTES + 1024));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("server survives a client aborting mid-body-upload (no unhandled rejection)", async () => {
    // Regression (THI-27): Express 4 does not forward async rejections, so an
    // aborted raw-request stream in readBodyWithCap crashed the process on
    // Node >= 15. Register a listener so the default crash becomes an
    // assertion instead, then prove liveness with a real request.
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => {
      unhandled = e;
    };
    process.on("unhandledRejection", onUnhandled);
    const port = Number(new URL(baseUrl).port);
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
            "Content-Length: 1000000\r\n\r\n" +
            '{"jsonrpc":"2.0","id":1,"method":"tools/list"',
        );
      });
      sock.on("error", () => {});
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 150);
    });
    await new Promise((r) => setTimeout(r, 400));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toBeNull();
    const res = await post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(res.status).toBe(200);
  });

  it("DB failure during credential resolution → 503, not a process crash", async () => {
    // Regression (THI-27): authenticateRequest's pool.query rejection (e.g.
    // transient Postgres outage) used to escape the async Express 4 handler
    // as an unhandled rejection and crash the process. Fail securely: 503,
    // never a silent anonymous downgrade.
    const querySpy = vi.spyOn(pool, "query").mockRejectedValue(new Error("connection refused"));
    try {
      const res = await post(rpc("search_items", { q: "x" }), { authorization: "Bearer thg_db_down" });
      expect(res.status).toBe(503);
      expect(res.headers.get("www-authenticate")).toBeNull(); // not mislabeled invalid_token
    } finally {
      querySpy.mockRestore();
    }
    // process is alive and serves the next request normally
    const res2 = await post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(res2.status).toBe(200);
  });

  it("authenticated body above 8 MB → 413 (single cap for everyone)", async () => {
    const res = await post(`{"jsonrpc":"2.0","id":1,"method":"initialize","padding":"${"x".repeat(MCP_MAX_BODY_BYTES)}"}`, {
      authorization: `Bearer ${apiKey}`,
    });
    expect(res.status).toBe(413);
  });

  it("unparseable body → 400 parse error, same shape the transport returns", async () => {
    const res = await post("this is not json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32700);
  });

  it("GET /mcp stays 405", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });
});
