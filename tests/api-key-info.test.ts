// API key display info for the web Settings page (get_api_key_info).
// Security properties under test: the stored prefix reveals only 24 of the
// key's 192 random bits; the tool never returns the secret or its hash; only
// a thgs_ login session can call it; the last-used stamp is throttled to one
// write per key per hour. Part 1 is pure. Part 2 runs against Postgres
// (skipped when none is reachable).

import crypto from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_KEY_PREFIX_LENGTH,
  apiKeyHash,
  apiKeyPrefix,
  createAccount,
  newApiKey,
  regenerateApiKey,
  sellerFromApiKey,
  signSession,
} from "../src/auth.js";
import { mcpRoutes } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";

describe("API key prefix (pure)", () => {
  it("keeps thg_ plus 4 of the 32 random base64url characters", () => {
    const key = newApiKey();
    expect(key).toMatch(/^thg_[A-Za-z0-9_-]{32}$/); // 24 random bytes = 192 bits
    const prefix = apiKeyPrefix(key);
    expect(API_KEY_PREFIX_LENGTH).toBe(8);
    expect(prefix).toBe(key.slice(0, 8));
    // 4 base64url characters carry 6 bits each: 24 bits revealed, 168 hidden.
    expect((prefix.length - "thg_".length) * 6).toBe(24);
  });
});

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";
const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
const available = await probe.connect().then(() => true, () => false);
await probe.end().catch(() => {});

type RpcResult = { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } };

describe.skipIf(!available)("API key info (DB)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  const tag = crypto.randomBytes(4).toString("hex");
  const legacyKey = `thg_legacy_${tag}`;
  const accessToken = `thgo_aki_${tag}_${crypto.randomBytes(16).toString("hex")}`;
  const clientId = `thgc_aki_${tag}`;
  let sellerId: string;
  let apiKey: string;
  let legacySellerId: string;

  const session = (id: string) => `thgs_${signSession(id)}`;

  async function rpc(authorization: string, method: string, params: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${authorization}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return (data ? JSON.parse(data.slice(6)) : JSON.parse(text)) as RpcResult;
  }

  async function callKeyInfo(authorization: string) {
    const body = await rpc(authorization, "tools/call", { name: "get_api_key_info", arguments: {} });
    const text = body.result?.content?.[0]?.text ?? "";
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { isError: body.result?.isError === true || body.error !== undefined, text, json };
  }

  const keyColumns = async (id: string) =>
    (await db.query<{ api_key_prefix: string | null; api_key_created_at: Date | null; api_key_last_used_at: Date | null }>(
      `SELECT api_key_prefix, api_key_created_at, api_key_last_used_at FROM sellers WHERE id = $1`,
      [id],
    )).rows[0];

  /** The last-used stamp is fire-and-forget; wait for it to land. */
  const waitForLastUsed = (id: string, predicate: (value: Date | null) => boolean) =>
    vi.waitFor(async () => expect(predicate((await keyColumns(id)).api_key_last_used_at)).toBe(true), { timeout: 2000 });

  beforeAll(async () => {
    const app = express();
    app.use(mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }));
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    db = new pg.Client({ connectionString });
    await db.connect();
    const account = await createAccount(`api-key-info-${tag}@t.dev`, "correct horse battery", "Key Owner");
    sellerId = account.id;
    apiKey = account.api_key;
    // A key issued before the display columns existed: hash only.
    legacySellerId = (await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'Legacy Owner', $2) RETURNING id`,
      [apiKeyHash(legacyKey), `api-key-info-legacy-${tag}@t.dev`],
    )).rows[0].id;
    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'Agent', ARRAY['http://localhost/cb'])`,
      [clientId],
    );
    const grant = (await db.query<{ id: string }>(
      `INSERT INTO oauth_grants (seller_id, client_id) VALUES ($1, $2) RETURNING id`,
      [sellerId, clientId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES ($1, 'access', $2, now() + interval '30 minutes')`,
      [grant, crypto.createHash("sha256").update(accessToken).digest("hex")],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
    await db.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [[sellerId, legacySellerId]]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("signup stores the prefix and created_at, never used yet", async () => {
    const row = await keyColumns(sellerId);
    expect(row.api_key_prefix).toBe(apiKey.slice(0, 8));
    expect(row.api_key_created_at).toBeInstanceOf(Date);
    expect(row.api_key_last_used_at).toBeNull();
  });

  it("only the session bearer can call get_api_key_info", async () => {
    for (const credential of [apiKey, accessToken]) {
      const names = ((await rpc(credential, "tools/list")).result?.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("search_items");
      expect(names).not.toContain("get_api_key_info");
      const call = await callKeyInfo(credential);
      expect(call.isError).toBe(true);
      expect(call.text).not.toContain(apiKey.slice(0, 8));
    }
    expect((await rpc(session(sellerId), "tools/list")).result?.tools?.map((tool) => tool.name)).toContain("get_api_key_info");
  });

  it("an API-key request stamps last_used_at, and the session reads it back without the secret", async () => {
    expect(await sellerFromApiKey(apiKey)).not.toBeNull();
    await waitForLastUsed(sellerId, (value) => value !== null);

    const { isError, json, text } = await callKeyInfo(session(sellerId));
    expect(isError).toBe(false);
    expect(json).toEqual({
      has_key: true,
      prefix: apiKey.slice(0, 8),
      created_at: expect.any(String),
      last_used_at: expect.any(String),
    });
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain(apiKeyHash(apiKey));
  });

  it("throttles the stamp: at most one write per hour", async () => {
    await db.query(`UPDATE sellers SET api_key_last_used_at = now() - interval '30 minutes' WHERE id = $1`, [sellerId]);
    const recent = (await keyColumns(sellerId)).api_key_last_used_at!;
    await sellerFromApiKey(apiKey);
    // Give a (wrong) write the chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await keyColumns(sellerId)).api_key_last_used_at).toEqual(recent);

    await db.query(`UPDATE sellers SET api_key_last_used_at = now() - interval '2 hours' WHERE id = $1`, [sellerId]);
    const stale = (await keyColumns(sellerId)).api_key_last_used_at!;
    await sellerFromApiKey(apiKey);
    await waitForLastUsed(sellerId, (value) => value !== null && value.getTime() > stale.getTime());
  });

  it("rotation replaces the prefix, restamps created_at and clears last_used_at", async () => {
    const before = await keyColumns(sellerId);
    const rotated = await regenerateApiKey(sellerId);
    expect(rotated).not.toBeNull();
    const after = await keyColumns(sellerId);
    expect(after.api_key_prefix).toBe(rotated!.apiKey.slice(0, 8));
    expect(after.api_key_created_at!.getTime()).toBeGreaterThanOrEqual(before.api_key_created_at!.getTime());
    expect(after.api_key_last_used_at).toBeNull();

    // The old key no longer authenticates, so it cannot stamp the new one.
    expect(await sellerFromApiKey(apiKey)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await keyColumns(sellerId)).api_key_last_used_at).toBeNull();
    apiKey = rotated!.apiKey;
  });

  it("a key issued before prefixes were recorded reports has_key with null details", async () => {
    const { isError, json } = await callKeyInfo(session(legacySellerId));
    expect(isError).toBe(false);
    expect(json).toEqual({ has_key: true, prefix: null, created_at: null, last_used_at: null });
  });
});
