// Sign in with ChatGPT OAuth browser-flow routes (spec THI-193 §3.2/§5/§7
// PR-2, rev fa3288ff): connect/callback/status/disconnect over real HTTP +
// DB against the local stub provider (tests/chatgpt-oauth-stub.ts — real
// endpoints never hit; global fetch is proxied onto the stub). Fixtures use
// chatgpt_test_… strings only (gitleaks-safe namespace, same convention as
// tests/chatgpt-oauth.test.ts).
//
// Invariants under test: flag-off ⇒ the whole surface 404s with no cookie;
// the tx cookie is single-use and state-bound; no token material ever
// appears in a response body, redirect URL or the raw table (encrypted
// bundle only); provider failures surface as fixed slugs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, chatgptConnectLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { keyFingerprint, LLM_CREDENTIALS_MASTER_KEY_ENV } from "../src/llm-credentials.js";
import { CHATGPT_TX_COOKIE, signChatgptTx } from "../src/chatgpt-oauth-flow.js";
import {
  createProviderFetchProxy,
  STUB_DEFAULT_MODEL,
  STUB_FULL_SCOPES,
  STUB_SUB,
  startChatgptStub,
  type ChatgptStub,
  type ProviderFetchProxy,
} from "./chatgpt-oauth-stub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
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

describe.skipIf(!available)("Sign in with ChatGPT OAuth routes (DB + HTTP + stub provider)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;
  let stub: ChatgptStub;
  let proxy: ProviderFetchProxy;

  beforeAll(async () => {
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "5a".repeat(31) + "b7";
    process.env.CHATGPT_OAUTH_ENABLED = "1";
    process.env.CHATGPT_OAUTH_CLIENT_ID = "chatgpt_test_client";
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE llm_credentials, items, sellers RESTART IDENTITY CASCADE");
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
    process.env.CHATGPT_OAUTH_REDIRECT_URI = `${base}/api/me/chatgpt/callback`;
    stub = await startChatgptStub();
    proxy = createProviderFetchProxy(globalThis.fetch, stub.base, base);
    vi.stubGlobal("fetch", proxy.fetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    delete process.env.CHATGPT_OAUTH_ENABLED;
    delete process.env.CHATGPT_OAUTH_CLIENT_ID;
    delete process.env.CHATGPT_OAUTH_CLIENT_SECRET;
    delete process.env.CHATGPT_OAUTH_REDIRECT_URI;
    delete process.env.CHATGPT_OAUTH_DEFAULT_MODEL;
    await stub.close();
    server.close();
    await db.end();
  });

  beforeEach(() => {
    chatgptConnectLimiter.reset();
    stub.reset();
  });

  async function seed(): Promise<{ sellerId: string; cookie: string }> {
    n += 1;
    const tag = `thi193-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    return { sellerId, cookie: `${SESSION_COOKIE}=${signSession(sellerId)}` };
  }

  /** connect → 302 authorize URL + the raw tx cookie value (HttpOnly — the
   *  test client plays the browser and carries it manually). */
  async function connect(cookie: string): Promise<{ authorize: URL; tx: string }> {
    const res = await fetch(`${base}/api/me/chatgpt/connect`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${CHATGPT_TX_COOKIE}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/me/chatgpt");
    expect(setCookie).toContain("Max-Age=600");
    const tx = (setCookie as string).split(";")[0].slice(CHATGPT_TX_COOKIE.length + 1);
    return { authorize: new URL(res.headers.get("location") as string), tx };
  }

  /** The stub provider's consent: authorize URL in → callback URL (code +
   *  state echo) out, through the proxied pinned URL. */
  async function consent(authorize: URL): Promise<URL> {
    const res = await fetch(authorize, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") as string);
  }

  async function callback(cb: URL, cookie: string, tx: string | null): Promise<string> {
    const res = await fetch(cb, {
      headers: { cookie: tx === null ? cookie : `${cookie}; ${CHATGPT_TX_COOKIE}=${tx}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    return res.headers.get("location") as string;
  }

  /** Full happy-path prefix: connect + consent, returning the callback URL
   *  and tx cookie for the test to finish or tamper with. */
  async function startFlow(cookie: string): Promise<{ cb: URL; tx: string; state: string }> {
    const { authorize, tx } = await connect(cookie);
    const cb = await consent(authorize);
    return { cb, tx, state: authorize.searchParams.get("state") ?? "" };
  }

  const status = async (cookie: string) =>
    (await (await fetch(`${base}/api/me/chatgpt`, { headers: { cookie } })).json()) as {
      enabled: boolean;
      connected: boolean;
      fingerprint: string | null;
      model: string | null;
      plan_usage: boolean;
    };

  const rowCount = async (sellerId: string) =>
    (await db.query("SELECT count(*)::int AS n FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'", [sellerId]))
      .rows[0].n as number;

  it("E2E happy path: connect 302 → consent → callback → row written → status connected", async () => {
    const { sellerId, cookie } = await seed();
    const { authorize, tx } = await connect(cookie);
    // Authorize URL shape (§3.2): pinned endpoint + PKCE + plan scopes.
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("chatgpt_test_client");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/api/me/chatgpt/callback`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("scope")).toBe(STUB_FULL_SCOPES);
    expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(authorize.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const cb = await consent(authorize);
    expect(cb.origin + cb.pathname).toBe(`${base}/api/me/chatgpt/callback`);
    const location = await callback(cb, cookie, tx);
    expect(location).toBe("/login.html?chatgpt=connected");

    // Exchange went through the stub with the PKCE verifier + resource.
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.tokenCalls[0]).toMatchObject({
      grantType: "authorization_code",
      clientId: "chatgpt_test_client",
      redirectUri: `${base}/api/me/chatgpt/callback`,
      resource: "https://api.openai.com/v1",
      basicAuth: null, // public client — no Basic auth without a secret
    });
    // Default model = first visibility=="list" catalog entry.
    expect(stub.modelBearers).toEqual([`Bearer chatgpt_test_at_1`]);

    // Row written: metadata + encrypted bundle only (never plaintext).
    expect(await rowCount(sellerId)).toBe(1);
    const raw = await db.query<{ ciphertext: string; model: string; key_fingerprint: string; oauth_sub: string }>(
      "SELECT ciphertext, model, key_fingerprint, oauth_sub FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'",
      [sellerId],
    );
    expect(raw.rows[0].model).toBe(STUB_DEFAULT_MODEL);
    expect(raw.rows[0].key_fingerprint).toBe(keyFingerprint(STUB_SUB));
    expect(raw.rows[0].oauth_sub).toBe(STUB_SUB);
    expect(raw.rows[0].ciphertext.startsWith("v1.")).toBe(true);
    expect(raw.rows[0].ciphertext.includes("chatgpt_test_at_1")).toBe(false);
    expect(raw.rows[0].ciphertext.includes("chatgpt_test_rt_1")).toBe(false);

    // Status: connected, metadata only — no tokens, no scopes string.
    const res = await fetch(`${base}/api/me/chatgpt`, { headers: { cookie } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rawStatus = await res.text();
    expect(rawStatus.includes("chatgpt_test_at_1")).toBe(false);
    expect(rawStatus.includes("chatgpt.tokens.use.direct")).toBe(false);
    expect(JSON.parse(rawStatus)).toEqual({
      enabled: true,
      connected: true,
      fingerprint: keyFingerprint(STUB_SUB),
      model: STUB_DEFAULT_MODEL,
      plan_usage: true,
    });
  });

  it("state mismatch → error redirect, no exchange", async () => {
    const { sellerId, cookie } = await seed();
    const { cb, tx } = await startFlow(cookie);
    cb.searchParams.set("state", "attacker-state");
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=error");
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("missing tx cookie → error redirect, no exchange", async () => {
    const { sellerId, cookie } = await seed();
    const { cb } = await startFlow(cookie);
    expect(await callback(cb, cookie, null)).toBe("/login.html?chatgpt=error");
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("expired tx cookie → error redirect, no exchange", async () => {
    const { sellerId, cookie } = await seed();
    const { cb } = await startFlow(cookie);
    const stale = signChatgptTx({ v: 1, state: cb.searchParams.get("state")!, nonce: "n", verifier: "v", exp: Date.now() - 1000 });
    expect(await callback(cb, cookie, stale)).toBe("/login.html?chatgpt=error");
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("tampered tx cookie → error redirect (HMAC fails)", async () => {
    const { sellerId, cookie } = await seed();
    const { cb, tx } = await startFlow(cookie);
    const forged = `${tx.slice(0, -3)}aaa`;
    expect(await callback(cb, cookie, forged)).toBe("/login.html?chatgpt=error");
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("replayed callback with the same tx cookie → error redirect, no second exchange", async () => {
    const { sellerId, cookie } = await seed();
    const { cb, tx } = await startFlow(cookie);
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=connected");
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=error"); // burned server-side
    expect(stub.tokenCalls).toHaveLength(1);
    expect(await rowCount(sellerId)).toBe(1); // first write stands
  });

  it("error=access_denied → declined, nothing stored", async () => {
    const { sellerId, cookie } = await seed();
    const { authorize, tx } = await connect(cookie);
    const cb = new URL(`${base}/api/me/chatgpt/callback`);
    cb.searchParams.set("error", "access_denied");
    cb.searchParams.set("state", authorize.searchParams.get("state")!);
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=declined");
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it.each([
    ["bad signature", { signWithWrongKey: true }],
    ["wrong iss", { idTokenOverrides: { iss: "https://evil.example" } }],
    ["wrong aud", { idTokenOverrides: { aud: "other_client" } }],
    ["expired id token", { idTokenOverrides: { exp: Math.floor(Date.now() / 1000) - 100 } }],
    ["iat in the future", { idTokenOverrides: { iat: Math.floor(Date.now() / 1000) + 3600 } }],
    ["wrong nonce", { idTokenOverrides: { nonce: "attacker-nonce" } }],
  ] as const)("ID-token rejection (%s) → error redirect, no row", async (_name, overrides) => {
    const { sellerId, cookie } = await seed();
    Object.assign(stub.state, overrides);
    const { cb, tx } = await startFlow(cookie);
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=error");
    expect(stub.tokenCalls).toHaveLength(1); // exchange happened, verification rejected
    expect(await rowCount(sellerId)).toBe(0);
    expect((await status(cookie)).connected).toBe(false);
  });

  it("missing plan scope → plan_not_enabled, no row", async () => {
    const { sellerId, cookie } = await seed();
    stub.state.scopes = "openid profile email offline_access"; // no chatgpt.tokens.use.direct
    const { cb, tx } = await startFlow(cookie);
    expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=plan_not_enabled");
    expect(await rowCount(sellerId)).toBe(0);
    expect((await status(cookie)).connected).toBe(false);
  });

  it("confidential client: secret travels as Basic auth at the token endpoint, never in the form", async () => {
    const { sellerId, cookie } = await seed();
    process.env.CHATGPT_OAUTH_CLIENT_SECRET = "chatgpt_test_secret";
    try {
      const { cb, tx } = await startFlow(cookie);
      expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=connected");
      expect(stub.tokenCalls[0].basicAuth).toBe("chatgpt_test_client:chatgpt_test_secret");
      // The secret rides ONLY the Basic header — never a form field, never the URL.
      const tokenCall = stub.tokenCalls[0];
      expect(Object.values(tokenCall.form).some((v) => v.includes("chatgpt_test_secret"))).toBe(false);
      const tokenProxyUrl = proxy.calls.find((c) => c.url.includes("/oauth/token"));
      expect(tokenProxyUrl?.url.includes("chatgpt_test_secret")).toBe(false);
      expect(await rowCount(sellerId)).toBe(1);
    } finally {
      delete process.env.CHATGPT_OAUTH_CLIENT_SECRET;
    }
  });

  it("provider failures → fixed error slug redirect, nothing stored", async () => {
    const { sellerId, cookie } = await seed();
    stub.state.tokenStatus = 503;
    let flow = await startFlow(cookie);
    expect(await callback(flow.cb, cookie, flow.tx)).toBe("/login.html?chatgpt=error");
    expect(await rowCount(sellerId)).toBe(0);

    stub.reset();
    stub.state.modelsStatus = 500;
    flow = await startFlow(cookie);
    expect(await callback(flow.cb, cookie, flow.tx)).toBe("/login.html?chatgpt=error");
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("CHATGPT_OAUTH_DEFAULT_MODEL wins over the catalog's first list entry", async () => {
    const { sellerId, cookie } = await seed();
    process.env.CHATGPT_OAUTH_DEFAULT_MODEL = "chatgpt_test_model_list_2";
    try {
      const { cb, tx } = await startFlow(cookie);
      expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=connected");
      const stored = await db.query<{ model: string }>(
        "SELECT model FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'",
        [sellerId],
      );
      expect(stored.rows[0].model).toBe("chatgpt_test_model_list_2");
    } finally {
      delete process.env.CHATGPT_OAUTH_DEFAULT_MODEL;
    }
  });

  it("CHATGPT_OAUTH_DEFAULT_MODEL absent from the catalog falls back to the first list entry (THI-210 N1)", async () => {
    const { sellerId, cookie } = await seed();
    process.env.CHATGPT_OAUTH_DEFAULT_MODEL = "chatgpt_test_model_not_in_catalog";
    try {
      const { cb, tx } = await startFlow(cookie);
      expect(await callback(cb, cookie, tx)).toBe("/login.html?chatgpt=connected");
      const stored = await db.query<{ model: string }>(
        "SELECT model FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'",
        [sellerId],
      );
      expect(stored.rows[0].model).toBe(STUB_DEFAULT_MODEL);
    } finally {
      delete process.env.CHATGPT_OAUTH_DEFAULT_MODEL;
    }
  });

  it("redirect_uri defaults to PUBLIC_BASE_URL when the explicit env is unset", async () => {
    const { cookie } = await seed();
    const had = process.env.CHATGPT_OAUTH_REDIRECT_URI;
    process.env.PUBLIC_BASE_URL = base;
    try {
      delete process.env.CHATGPT_OAUTH_REDIRECT_URI;
      const { authorize } = await connect(cookie);
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/api/me/chatgpt/callback`);
    } finally {
      process.env.CHATGPT_OAUTH_REDIRECT_URI = had;
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  it("flag off → all four routes 404 and connect sets no cookie", async () => {
    const { sellerId, cookie } = await seed();
    const hadEnabled = process.env.CHATGPT_OAUTH_ENABLED;
    try {
      delete process.env.CHATGPT_OAUTH_ENABLED;
      expect((await fetch(`${base}/api/me/chatgpt`, { headers: { cookie } })).status).toBe(404);
      const connectRes = await fetch(`${base}/api/me/chatgpt/connect`, { headers: { cookie }, redirect: "manual" });
      expect(connectRes.status).toBe(404);
      expect(connectRes.headers.getSetCookie()).toEqual([]);
      expect((await fetch(`${base}/api/me/chatgpt/callback?code=x&state=y`, { headers: { cookie }, redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${base}/api/me/chatgpt`, { method: "DELETE", headers: { cookie } })).status).toBe(404);
    } finally {
      process.env.CHATGPT_OAUTH_ENABLED = hadEnabled;
    }
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("requires a session on all four verbs (flag on)", async () => {
    await seed();
    expect((await fetch(`${base}/api/me/chatgpt`)).status).toBe(401);
    expect((await fetch(`${base}/api/me/chatgpt/connect`, { redirect: "manual" })).status).toBe(401);
    expect(
      (await fetch(`${base}/api/me/chatgpt/callback?code=x&state=y`, { redirect: "manual" })).status,
    ).toBe(401);
    expect((await fetch(`${base}/api/me/chatgpt`, { method: "DELETE" })).status).toBe(401);
  });

  it("status with nothing stored → enabled, disconnected, null fingerprint/model", async () => {
    const { cookie } = await seed();
    expect(await status(cookie)).toEqual({
      enabled: true,
      connected: false,
      fingerprint: null,
      model: null,
      plan_usage: true,
    });
  });

  it("rate-limits connect starts: the 11th in an hour is 429", async () => {
    const { cookie } = await seed();
    for (let i = 0; i < 10; i++) {
      expect((await fetch(`${base}/api/me/chatgpt/connect`, { headers: { cookie }, redirect: "manual" })).status).toBe(302);
    }
    const res = await fetch(`${base}/api/me/chatgpt/connect`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(429);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("disconnect: revokes (stub), deletes the row, clears the tx cookie, no unconfirmed flag", async () => {
    const { sellerId, cookie } = await seed();
    const { cb, tx } = await startFlow(cookie);
    await callback(cb, cookie, tx);
    expect(await rowCount(sellerId)).toBe(1);

    const res = await fetch(`${base}/api/me/chatgpt`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    // Revocation carried the stored refresh token + client id.
    expect(stub.revokeCalls).toHaveLength(1);
    expect(stub.revokeCalls[0]).toMatchObject({
      token: "chatgpt_test_rt_1",
      tokenTypeHint: "refresh_token",
      clientId: "chatgpt_test_client",
      basicAuth: null,
    });
    // Tx cookie cleared.
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${CHATGPT_TX_COOKIE}=`) && c.includes("Expires=Thu, 01 Jan 1970"))).toBe(true);
    expect(await rowCount(sellerId)).toBe(0);
    expect((await status(cookie)).connected).toBe(false);
  });

  it("disconnect with revoke 5xx: 1 try + 2 retries, row still deleted, revocation_unconfirmed", async () => {
    const { sellerId, cookie } = await seed();
    const { cb, tx } = await startFlow(cookie);
    await callback(cb, cookie, tx);
    stub.state.revokeStatus = 500;
    const res = await fetch(`${base}/api/me/chatgpt`, { method: "DELETE", headers: { cookie } });
    expect(await res.json()).toEqual({ ok: true, revocation_unconfirmed: true });
    expect(stub.revokeCalls).toHaveLength(3);
    expect(await rowCount(sellerId)).toBe(0);
  });

  it("disconnect with no connection: ok, no revocation attempt, no flag", async () => {
    const { cookie } = await seed();
    const res = await fetch(`${base}/api/me/chatgpt`, { method: "DELETE", headers: { cookie } });
    expect(await res.json()).toEqual({ ok: true });
    expect(stub.revokeCalls).toHaveLength(0);
  });
});
