// `Authorization: Bearer thgs_<session cookie value>` on /mcp: verification
// parity with the cookie, the no-cookie (CSRF) rule, and proof that the bearer
// reaches nothing beyond /mcp. pool.query is stubbed, so no database is needed;
// the real-SQL path is covered in tests/mcp-auth.http.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import { authenticateRequest, SESSION_COOKIE, SESSION_MAX_AGE_S, signSession } from "../src/auth.js";
import { pool } from "../src/db.js";
import { mcpRoutes, type McpLimiters } from "../src/mcp-gate.js";
import { mountOauthRoutes } from "../src/oauth.js";
import { RateLimiter } from "../src/rate-limit.js";
import { mountApiRoutes } from "../src/routes.js";

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SELLER_ID = "22222222-2222-4222-8222-222222222222";
const EPOCH = 3;
const REDIRECT_URI = "http://localhost:51719/callback";
const INVALID = { seller: null, failure: "invalid_token" };

const validSession = (): string => signSession(SELLER_ID, EPOCH);
const bearer = (session: string) => ({ authorization: `Bearer thgs_${session}` });
const sessionCookie = () => ({ cookie: `${SESSION_COOKIE}=${validSession()}` });
const authenticate = (headers: Record<string, string>) =>
  authenticateRequest({ headers } as unknown as Request);

let queries: string[];

beforeEach(() => {
  queries = [];
  const stub = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("FROM sellers WHERE id") && params[0] === SELLER_ID) {
      // THI-762: the session SELECT now also carries email + email_verified_at.
      return { rows: [{ id: SELLER_ID, display_name: "Web User", session_epoch: EPOCH, email: null, email_verified_at: null }] };
    }
    // my_listings reads the listing quota: an aggregate always returns one row.
    if (sql.includes("AS creates_24h")) {
      return { rows: [{ creates_24h: "0", active: "0", seller_created_at: new Date() }] };
    }
    if (sql.includes("FROM oauth_clients")) {
      return { rows: [{ client_id: "thgc_web", client_name: "C", client_uri: null, redirect_uris: [REDIRECT_URI] }] };
    }
    return { rows: [] };
  };
  vi.spyOn(pool, "query").mockImplementation(stub as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticateRequest: thgs_ session bearer", () => {
  it("accepts a valid session value and resolves its seller", async () => {
    const auth = await authenticate(bearer(validSession()));
    expect(auth.failure).toBe("none");
    expect(auth.seller?.id).toBe(SELLER_ID);
  });

  const parts = () => validSession().split(".");
  it.each<[string, () => string]>([
    ["expired past 30 days", () => signSession(SELLER_ID, EPOCH, Date.now() - (SESSION_MAX_AGE_S + 60) * 1000)],
    ["signed at a revoked epoch", () => signSession(SELLER_ID, EPOCH - 1)],
    ["with a tampered MAC", () => `${validSession().slice(0, -2)}xx`],
    ["with another seller's MAC", () =>
      `${parts()[0]}.${parts()[1]}.${signSession(OTHER_SELLER_ID, EPOCH).split(".")[2]}`],
    ["with a tampered issue time", () => `${parts()[0]}.${Number(parts()[1]) + 1}.${parts()[2]}`],
    ["of an unknown seller", () => signSession(OTHER_SELLER_ID, EPOCH)],
  ])("rejects a session %s as invalid_token", async (_name, buildSession) => {
    expect(await authenticate(bearer(buildSession()))).toEqual(INVALID);
  });

  it.each([
    ["an empty value", ""],
    ["a value with no structure", "garbage"],
    ["a non-UUID seller id (no 22P02 from the SELECT)", `not-a-uuid.1750000000.${"A".repeat(43)}`],
  ])("rejects %s as invalid_token without touching the database", async (_name, session) => {
    expect(await authenticate(bearer(session))).toEqual(INVALID);
    expect(queries).toEqual([]);
  });

  it("requires the prefix: a bare session value is an unrecognized credential", async () => {
    expect(await authenticate({ authorization: `Bearer ${validSession()}` })).toEqual(INVALID);
  });

  it("never reads the session cookie, not even to rescue an invalid bearer", async () => {
    expect(await authenticate(sessionCookie())).toEqual({ seller: null, failure: "none" });
    expect(queries).toEqual([]);
    expect(await authenticate({ ...bearer("garbage"), ...sessionCookie() })).toEqual(INVALID);
  });
});

async function withApp(mount: (app: Express) => void, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  mount(app);
  const server = app.listen(0);
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const generousLimiters = (): McpLimiters =>
  ({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) });

function callTool(baseUrl: string, name: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
}

describe("/mcp gate with a thgs_ session bearer", () => {
  const gate = (limiters: McpLimiters) => (app: Express) => {
    app.use(mcpRoutes(limiters));
  };

  it("authorizes a protected tool and counts the call as credential=session", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await withApp(gate(generousLimiters()), async (baseUrl) => {
      const res = await callTool(baseUrl, "my_listings", bearer(validSession()));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Web User");
    });
    const events = logged.mock.calls.map(([line]) => JSON.parse(String(line)) as { type: string });
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ credential: "session", sellerId: SELLER_ID });
  });

  it("answers an invalid session with a 401 invalid_token challenge, even on a public tool", async () => {
    await withApp(gate(generousLimiters()), async (baseUrl) => {
      const res = await callTool(baseUrl, "search_items", bearer("garbage"));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });
  });

  it("does not accept the session cookie: a protected call gets the anonymous challenge", async () => {
    await withApp(gate(generousLimiters()), async (baseUrl) => {
      const res = await callTool(baseUrl, "my_listings", sessionCookie());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "authentication required" });
    });
  });

  it("rate-limits a valid session in the seller's authed bucket", async () => {
    const limiters = generousLimiters();
    const authedAllow = vi.spyOn(limiters.authedLimiter, "allow").mockReturnValueOnce(false);
    await withApp(gate(limiters), async (baseUrl) => {
      expect((await callTool(baseUrl, "my_listings", bearer(validSession()))).status).toBe(429);
    });
    expect(authedAllow).toHaveBeenCalledWith(`key:${SELLER_ID}`);
  });

  it("never logs the token, on success, rejection or a database fault (503, not anonymous)", async () => {
    const session = validSession();
    const invalidSession = `${SELLER_ID}.1750000000.${"B".repeat(43)}`;
    const sinks = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await withApp(gate(generousLimiters()), async (baseUrl) => {
      await callTool(baseUrl, "my_listings", bearer(session));
      await callTool(baseUrl, "my_listings", bearer(invalidSession));
      vi.spyOn(pool, "query").mockRejectedValue(new Error("connection reset") as never);
      expect((await callTool(baseUrl, "search_items", bearer(session))).status).toBe(503);
    });
    const output = sinks.flatMap((sink) => sink.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
    for (const secret of ["thgs_", session.split(".")[2], invalidSession]) expect(output).not.toContain(secret);
  });
});

describe("a thgs_ bearer has no authority outside /mcp", () => {
  const api = (app: Express) => {
    app.use(express.json({ limit: "256kb" }));
    mountApiRoutes(app);
  };
  const authorize = { client_id: "thgc_web", redirect_uri: REDIRECT_URI, response_type: "code", state: "s",
    code_challenge: "c".repeat(43), code_challenge_method: "S256" };
  const writes = () => queries.filter((sql) => /INSERT|UPDATE/.test(sql));

  it("cannot read the account or mint an API key, while the cookie can read (control)", async () => {
    await withApp(api, async (baseUrl) => {
      const viaBearer = await fetch(`${baseUrl}/api/me`, { headers: bearer(validSession()) });
      expect(await viaBearer.json()).toEqual({ seller: null });
      const viaCookie = await fetch(`${baseUrl}/api/me`, { headers: sessionCookie() });
      expect(await viaCookie.json()).toEqual({ seller: { name: "Web User", email: null, email_verified: false } }); // THI-762: additive /api/me fields
      const mint = await fetch(`${baseUrl}/api/me/api-key`, { method: "POST", headers: bearer(validSession()) });
      expect(mint.status).toBe(401);
    });
    expect(writes()).toEqual([]);
  });

  it("is not a login for OAuth consent, while the cookie is (control)", async () => {
    await withApp(mountOauthRoutes, async (baseUrl) => {
      const url = `${baseUrl}/oauth/authorize?${new URLSearchParams(authorize)}`;
      const viaBearer = await fetch(url, { headers: bearer(validSession()), redirect: "manual" });
      expect(viaBearer.status).toBe(302);
      expect(viaBearer.headers.get("location")).toContain("/login.html");
      expect((await fetch(url, { headers: sessionCookie(), redirect: "manual" })).status).toBe(200);
    });
  });

  it("cannot approve an OAuth grant", async () => {
    await withApp(mountOauthRoutes, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { ...bearer(validSession()), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...authorize, action: "allow" }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login.html");
    });
    expect(writes()).toEqual([]);
  });
});
