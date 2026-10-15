// HTTP integration tests: discovery metadata serving, DCR endpoint, and the
// trust-proxy spoof regression (F1). Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";

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

describe.skipIf(!available)("oauth http surface (discovery + DCR)", () => {
  let server: Server;
  let baseUrl: string;
  let client: pg.Client;

  beforeAll(async () => {
    const app = express();
    // Mirrors src/index.ts exactly: trust proxy 1 (F1) + JSON parser + routes.
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    mountOauthRoutes(app);
    app.get("/__test/ip", (req, res) => res.json({ ip: req.ip }));
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves RFC 9728 protected-resource metadata at both well-known paths", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(doc.resource).toBe(`${baseUrl}/mcp`);
      expect(doc.authorization_servers).toEqual([baseUrl]);
    }
  });

  it("serves RFC 8414 authorization-server metadata with the normative fields", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(baseUrl);
    expect(doc.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${baseUrl}/oauth/token`);
    expect(doc.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
    expect(doc.revocation_endpoint).toBe(`${baseUrl}/oauth/revoke`);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.scopes_supported).toEqual(["mcp"]);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("registers a client (201) and persists the normalized redirect URIs", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Inspector",
        redirect_uris: ["http://LOCALHOST:6274/oauth/callback"],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.client_id).toMatch(/^thgc_[A-Za-z0-9_-]{22}$/);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.response_types).toEqual(["code"]);
    expect(doc.scope).toBe("mcp");
    expect(typeof doc.client_id_issued_at).toBe("number");

    const { rows } = await client.query<{ redirect_uris: string[]; client_name: string }>(
      `SELECT redirect_uris, client_name FROM oauth_clients WHERE client_id = $1`,
      [doc.client_id],
    );
    expect(rows[0].redirect_uris).toEqual(["http://localhost:6274/oauth/callback"]);
    expect(rows[0].client_name).toBe("Inspector");
  });

  it("rejects invalid registrations with RFC 7591 error codes", async () => {
    const cases: [string, unknown][] = [
      ["myapp://callback", "invalid_redirect_uri"],
      ["http://example.com/cb", "invalid_redirect_uri"],
    ];
    for (const [uri, code] of cases) {
      const res = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it("rejects reserved brand client names with invalid_client_metadata (THI-220 N1)", async () => {
    const reservedNames = [
      "ChatGPT", // exact
      " chat gpt\u200b", // spacing + zero-width space
      "My Claude Helper", // contains-match
    ];
    for (const client_name of reservedNames) {
      const res = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name, redirect_uris: ["https://reserved-test.example/cb"] }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const doc = (await res.json()) as { error: string; error_description: string };
      expect(doc.error).toBe("invalid_client_metadata");
      expect(doc.error_description).toContain("reserved brand");
    }
  });

  it("F1 regression: client-injected XFF entries do not change the resolved IP", async () => {
    // With trust proxy 1, only the single trusted hop's appended entry counts;
    // leftmost (client-controlled) entries are ignored. Behind Caddy the real
    // client IP is the rightmost entry; a spoofed prefix must not win.
    const res = await fetch(`${baseUrl}/__test/ip`, {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" },
    });
    const { ip } = (await res.json()) as { ip: string };
    expect(ip).toBe("203.0.113.9"); // the trusted hop's entry — not the spoofed prefix
  });

  it("rate-limits DCR per IP (10/hour default): 429 once exhausted", async () => {
    // Requests already spent above (every POST counts): keep bursting until 429.
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://rate-limit-test.example/cb"] }),
      });
      if (res.status === 429) {
        saw429 = true;
        expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
        break;
      }
      expect(res.status).toBe(201);
      await client.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [
        ((await res.json()) as { client_id: string }).client_id,
      ]);
    }
    expect(saw429).toBe(true);
  });
});
