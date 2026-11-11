// First-party connected-apps tools (list_connected_apps, revoke_connected_app).
// Security property under test: only a thgs_ login-session bearer — held by the
// Thingery web app's server — can see or call them. A third-party OAuth client
// (thgo_) or an API key (thg_) must not be able to list or revoke the user's
// apps. Part 1 is pure registration gating. Part 2 drives the real /mcp gate
// against Postgres (skipped when none is reachable) with real credentials of
// every kind.

import crypto from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiKeyHash, signSession } from "../src/auth.js";
import type { SellerRow } from "../src/db.js";
import { mcpRoutes } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";
import { registerTools, SESSION_ONLY_TOOLS, type CredentialKind } from "../src/tools.js";

const SELLER: SellerRow = { id: "11111111-1111-4111-8111-111111111111", display_name: "Web User" };

function registeredNames(ctx: { seller: SellerRow | null; credential?: CredentialKind }): Set<string> {
  const names = new Set<string>();
  registerTools({ registerTool(name: string) { names.add(name); } }, ctx);
  return names;
}

describe("session-only tool registration (pure)", () => {
  it("registers both tools for a login-session seller", () => {
    const names = registeredNames({ seller: SELLER, credential: "session" });
    for (const tool of SESSION_ONLY_TOOLS) expect(names.has(tool)).toBe(true);
    expect([...SESSION_ONLY_TOOLS].sort()).toEqual(["list_connected_apps", "revoke_connected_app"]);
  });

  it.each<[string, SellerRow | null, CredentialKind | undefined]>([
    ["an OAuth access token", SELLER, "oauth"],
    ["an API key", SELLER, "api_key"],
    ["no credential kind (stdio, tests)", SELLER, undefined],
    ["an anonymous caller", null, "none"],
    ["a session label without a resolved seller", null, "session"],
  ])("registers neither for %s", (_label, seller, credential) => {
    const names = registeredNames({ seller, credential });
    for (const tool of SESSION_ONLY_TOOLS) expect(names.has(tool)).toBe(false);
  });
});

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";
const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});

type RpcResult = { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } };

describe.skipIf(!available)("connected apps over /mcp (DB)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  const tag = crypto.randomBytes(4).toString("hex");
  const clientIds = [`thgc_ca1_${tag}`, `thgc_ca2_${tag}`];
  const apiKey = `thg_ca_${tag}`;
  const accessToken = `thgo_ca_${tag}_${crypto.randomBytes(16).toString("hex")}`;
  let sellerId: string;
  let otherSellerId: string;
  let usedGrant: string;
  let unusedGrant: string;
  let otherGrant: string;

  const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const session = () => `thgs_${signSession(sellerId)}`;

  async function rpc(authorization: string | null, method: string, params: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return { status: res.status, body: (data ? JSON.parse(data.slice(6)) : JSON.parse(text)) as RpcResult };
  }

  async function toolNames(authorization: string | null): Promise<string[]> {
    const { body } = await rpc(authorization, "tools/list");
    return (body.result?.tools ?? []).map((tool) => tool.name);
  }

  async function callTool(authorization: string, name: string, args: Record<string, unknown> = {}) {
    const { body } = await rpc(authorization, "tools/call", { name, arguments: args });
    const text = body.result?.content?.[0]?.text ?? "";
    let parsed: Record<string, any> | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { isError: body.result?.isError === true || body.error !== undefined, text, json: parsed };
  }

  const grantRevoked = async (id: string) =>
    (await db.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM oauth_grants WHERE id = $1`, [id])).rows[0].revoked_at !== null;

  beforeAll(async () => {
    const app = express();
    app.use(mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }));
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    db = new pg.Client({ connectionString });
    await db.connect();
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'Apps Owner', $2) RETURNING id`,
      [apiKeyHash(apiKey), `connected-apps-${tag}@t.dev`],
    );
    sellerId = seller.rows[0].id;
    const other = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'Other Owner', $2) RETURNING id`,
      [apiKeyHash(`thg_ca_other_${tag}`), `connected-apps-other-${tag}@t.dev`],
    );
    otherSellerId = other.rows[0].id;
    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, 'Agent One', ARRAY['http://localhost/cb']), ($2, 'Agent Two', ARRAY['http://localhost/cb'])`,
      clientIds,
    );
    const grant = async (owner: string, clientId: string, age: string) =>
      (await db.query<{ id: string }>(
        `INSERT INTO oauth_grants (seller_id, client_id, created_at) VALUES ($1, $2, now() - $3::interval) RETURNING id`,
        [owner, clientId, age],
      )).rows[0].id;
    usedGrant = await grant(sellerId, clientIds[0], "2 days");
    unusedGrant = await grant(sellerId, clientIds[1], "1 day");
    otherGrant = await grant(otherSellerId, clientIds[0], "3 days");
    await db.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at, last_used_at)
       VALUES ($1, 'access', $2, now() + interval '30 minutes', now() - interval '1 hour'),
              ($1, 'refresh', $3, now() + interval '30 days', NULL)`,
      [usedGrant, sha256(accessToken), sha256(`thgr_ca_${tag}`)],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_clients WHERE client_id = ANY($1::text[])`, [clientIds]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [[sellerId, otherSellerId]]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("only the session bearer sees the tools in tools/list", async () => {
    expect(await toolNames(session())).toEqual(expect.arrayContaining([...SESSION_ONLY_TOOLS]));
    for (const credential of [accessToken, apiKey, null]) {
      const names = await toolNames(credential);
      expect(names).toContain("search_items"); // the list itself worked
      for (const tool of SESSION_ONLY_TOOLS) expect(names).not.toContain(tool);
    }
  });

  it("a connected OAuth app cannot list the user's apps or revoke one, not even itself", async () => {
    for (const credential of [accessToken, apiKey]) {
      const listed = await callTool(credential, "list_connected_apps");
      expect(listed.isError).toBe(true);
      expect(listed.text).not.toContain("Agent Two");
      for (const target of [unusedGrant, usedGrant]) {
        expect((await callTool(credential, "revoke_connected_app", { app_id: target })).isError).toBe(true);
      }
    }
    expect(await grantRevoked(usedGrant)).toBe(false);
    expect(await grantRevoked(unusedGrant)).toBe(false);
  });

  it("lists only the signed-in user's active apps, newest first, with last use", async () => {
    const { isError, json } = await callTool(session(), "list_connected_apps");
    expect(isError).toBe(false);
    expect(json!.count).toBe(2);
    expect(json!.apps.map((app: { id: string }) => app.id)).toEqual([unusedGrant, usedGrant]);
    const [unused, used] = json!.apps;
    expect(unused).toEqual({ id: unusedGrant, client_name: "Agent Two", connected_at: expect.any(String), last_used_at: null });
    expect(used.client_name).toBe("Agent One");
    expect(typeof used.last_used_at).toBe("string");
    expect(JSON.stringify(json)).not.toContain(otherGrant);
  });

  it("another user's app is not_found and stays connected", async () => {
    const { isError, json } = await callTool(session(), "revoke_connected_app", { app_id: otherGrant });
    expect(isError).toBe(true);
    expect(json!.code).toBe("not_found");
    expect(await grantRevoked(otherGrant)).toBe(false);
  });

  it("rejects an app_id that is not a uuid", async () => {
    expect((await callTool(session(), "revoke_connected_app", { app_id: "not-a-uuid" })).isError).toBe(true);
  });

  it("revokes the grant and all its tokens, logs it, and cuts the app off at once", async () => {
    expect((await toolNames(accessToken)).length).toBeGreaterThan(0); // token works before
    const securityLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { isError, json } = await callTool(session(), "revoke_connected_app", { app_id: usedGrant });
    const events = securityLog.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("grant_revoked_manual"));
    securityLog.mockRestore();

    expect(isError).toBe(false);
    expect(json).toEqual({ revoked: true, app_id: usedGrant });
    expect(await grantRevoked(usedGrant)).toBe(true);
    const live = await db.query(`SELECT 1 FROM oauth_tokens WHERE grant_id = $1 AND revoked_at IS NULL`, [usedGrant]);
    expect(live.rowCount).toBe(0);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0])).toMatchObject({ seller_id: sellerId, grant_id: usedGrant, surface: "mcp_session" });

    expect((await rpc(accessToken, "tools/list")).status).toBe(401);
    expect((await callTool(session(), "revoke_connected_app", { app_id: usedGrant })).json!.code).toBe("not_found");
    expect((await callTool(session(), "list_connected_apps")).json!.apps.map((app: { id: string }) => app.id)).toEqual([unusedGrant]);
  });
});
