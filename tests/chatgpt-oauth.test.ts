// ChatGPT OAuth bundle store tests (spec THI-193 §3.3/§4/§7 PR-1, rev
// fa3288ff). DB-backed (skip-if-no-postgres, same pattern as
// tests/llm-credentials.test.ts): bundle round-trip, AAD binding, whole-
// bundle rotation rewrite, refresh single-flight + DB compare-and-swap,
// terminal-refresh kill + slug, fingerprint stability across rotation, and
// the flag-off dormant-row contract. The token endpoint (fetch) is stubbed;
// fixtures use chatgpt_test_… strings (gitleaks: keep entropy low — prefix
// is not a defense, exact-string allowlist is the fallback per THI-191 N1).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_OAUTH_TOKEN_URL,
  chatgptOauthEnabled,
  deleteChatgptConnection,
  getChatgptConnection,
  refreshChatgptTokens,
  resolveChatgptCredential,
  upsertChatgptConnection,
  type ChatgptTokenBundle,
} from "../src/chatgpt-oauth.js";
import { LLM_CREDENTIALS_MASTER_KEY_ENV, decryptSecret, encryptSecret } from "../src/llm-credentials.js";
import { pool } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

/** Valid 32-byte master key in hex (test fixture — not a secret). */
const MASTER_HEX = "5a".repeat(31) + "b7";
const FULL_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const SUB = "auth0|chatgpt_test_sub";
const MIN = 60_000;
const HOUR = 60 * MIN;

function setEnv(): void {
  process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = MASTER_HEX;
  process.env.CHATGPT_OAUTH_ENABLED = "1";
  process.env.CHATGPT_OAUTH_CLIENT_ID = "chatgpt_test_client";
}

function clearEnv(): void {
  delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
  delete process.env.CHATGPT_OAUTH_ENABLED;
  delete process.env.CHATGPT_OAUTH_CLIENT_ID;
  delete process.env.CHATGPT_OAUTH_CLIENT_SECRET;
}

/** Bundle with sane defaults (unexpired access token, refreshable now). */
function bundle(o: {
  at: string;
  rt: string;
  expMs?: number;
  earliestMs?: number;
  scopes?: string;
  sub?: string;
  idt?: string;
}): ChatgptTokenBundle {
  return {
    accessToken: o.at,
    refreshToken: o.rt,
    idToken: o.idt ?? "chatgpt_test_idt",
    scopes: o.scopes ?? FULL_SCOPES,
    accessExpiresAt: new Date(o.expMs ?? Date.now() + HOUR),
    earliestRefreshAt: new Date(o.earliestMs ?? Date.now() - MIN),
    sub: o.sub ?? SUB,
  };
}

/** The stored-bundle JSON (spec §3.3 field names) for direct row surgery. */
function bundleJson(o: { at: string; rt: string; expMs?: number; earliestMs?: number }): string {
  return JSON.stringify({
    access_token: o.at,
    refresh_token: o.rt,
    id_token: "chatgpt_test_idt",
    scopes: FULL_SCOPES,
    access_expires_at: new Date(o.expMs ?? Date.now() + HOUR).toISOString(),
    earliest_refresh_at: new Date(o.earliestMs ?? Date.now() - MIN).toISOString(),
    sub: SUB,
  });
}

/** A successful token-endpoint response (rotated refresh token included). */
function tokenResponse(o: { at: string; rt: string; expiresIn?: number; earliestMs?: number; scope?: string }): Response {
  return new Response(
    JSON.stringify({
      access_token: o.at,
      refresh_token: o.rt,
      id_token: "chatgpt_test_idt_new",
      scope: o.scope ?? FULL_SCOPES,
      expires_in: o.expiresIn ?? 3600,
      earliest_refresh_at: new Date(o.earliestMs ?? Date.now() + 30_000).toISOString(),
      token_type: "Bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    connectionTimeoutMillis: 1500,
  });
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

describe.skipIf(!available)("chatgpt_oauth store (DB, spec §3.3)", () => {
  const sellerId = "44444444-4444-4444-4444-444444444444";
  const otherSellerId = "55555555-5555-5555-5555-555555555555";
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await pool.query(readFileSync(schemaPath, "utf8"));
    for (const [id, name] of [
      [sellerId, "chatgpt-test-seller"],
      [otherSellerId, "chatgpt-test-other"],
    ] as const) {
      await pool.query(
        `INSERT INTO sellers (id, api_key_hash, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, `thg_cg_${id.slice(0, 8)}_${Date.now()}`, name],
      );
    }
  });

  beforeEach(async () => {
    setEnv();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await pool.query(`DELETE FROM llm_credentials WHERE seller_id = ANY($1)`, [[sellerId, otherSellerId]]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    clearEnv();
  });

  async function storedJson(seller: string): Promise<string> {
    const { rows } = await pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`,
      [seller],
    );
    return decryptSecret(seller, "chatgpt_oauth", rows[0].ciphertext);
  }

  it("chatgptOauthEnabled is flag AND client id (fail closed, §3.1)", () => {
    expect(chatgptOauthEnabled()).toBe(true);
    delete process.env.CHATGPT_OAUTH_ENABLED;
    expect(chatgptOauthEnabled()).toBe(false);
    process.env.CHATGPT_OAUTH_ENABLED = "0";
    expect(chatgptOauthEnabled()).toBe(false);
    process.env.CHATGPT_OAUTH_ENABLED = "1";
    delete process.env.CHATGPT_OAUTH_CLIENT_ID;
    expect(chatgptOauthEnabled()).toBe(false);
  });

  it("round-trips a bundle: metadata never carries tokens, resolve does", async () => {
    await upsertChatgptConnection(sellerId, bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }), "gpt-5.1");
    const meta = await getChatgptConnection(sellerId);
    expect(meta).toMatchObject({
      connected: true,
      model: "gpt-5.1",
      oauth_sub: SUB,
      access_expires_at: expect.any(Date),
    });
    expect(meta?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(meta).includes("chatgpt_test_at_a")).toBe(false);
    expect(JSON.stringify(meta).includes("chatgpt_test_rt_a")).toBe(false);
    expect(await resolveChatgptCredential(sellerId)).toEqual({ accessToken: "chatgpt_test_at_a", model: "gpt-5.1" });
    await deleteChatgptConnection(sellerId);
    expect(await getChatgptConnection(sellerId)).toBeNull();
    expect(await resolveChatgptCredential(sellerId)).toBeNull();
    await deleteChatgptConnection(sellerId); // idempotent
  });

  it("binds the ciphertext to seller+kind via AAD (§3.3)", async () => {
    // Wrong kind: a chatgpt_oauth ciphertext read as api_key fails GCM.
    const ct = encryptSecret(sellerId, "chatgpt_oauth", bundleJson({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }));
    expect(() => decryptSecret(sellerId, "api_key", ct)).toThrow();
    // Wrong seller: a row swapped between sellers fails GCM.
    await upsertChatgptConnection(sellerId, bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }), "gpt-5.1");
    const stolen = (await pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`,
      [sellerId],
    )).rows[0].ciphertext;
    await pool.query(
      `INSERT INTO llm_credentials (seller_id, kind, label, model, ciphertext, key_fingerprint)
       VALUES ($1, 'chatgpt_oauth', 'ChatGPT plan', 'gpt-5.1', $2, '000000000000')`,
      [otherSellerId, stolen],
    );
    await expect(resolveChatgptCredential(otherSellerId)).rejects.toThrow();
  });

  it("rewrites the WHOLE bundle on rotation (refresh token rotated every refresh, §2)", async () => {
    await upsertChatgptConnection(sellerId, bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }), "gpt-5.1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" })),
    );
    const result = await refreshChatgptTokens(sellerId);
    expect(result).toEqual({ ok: true, accessToken: "chatgpt_test_at_b" });
    const stored = JSON.parse(await storedJson(sellerId)) as Record<string, string>;
    expect(stored.access_token).toBe("chatgpt_test_at_b");
    expect(stored.refresh_token).toBe("chatgpt_test_rt_b");
    expect(stored.refresh_token).not.toBe("chatgpt_test_rt_a"); // old token gone, not kept
    expect(stored.id_token).toBe("chatgpt_test_idt_new");
    // Still exactly one row.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`,
      [sellerId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("keeps the fingerprint stable across rotation (it fingerprints sub, §3.3)", async () => {
    const before = await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }),
      "gpt-5.1",
    );
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" })));
    await refreshChatgptTokens(sellerId);
    expect((await getChatgptConnection(sellerId))?.fingerprint).toBe(before.fingerprint);
  });

  it("refreshes on a single flight: concurrent callers share one token call (§3.3)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    const fetchMock = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    vi.stubGlobal("fetch", fetchMock);
    const [r1, r2] = await Promise.all([refreshChatgptTokens(sellerId), refreshChatgptTokens(sellerId)]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second refresh would burn the rotated token
    expect(r1).toEqual({ ok: true, accessToken: "chatgpt_test_at_b" });
    expect(r2).toEqual(r1);
  });

  it("loses the CAS race gracefully: concurrent winner is not clobbered, loser re-reads once (§3.3)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    let releaseFetch!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (releaseFetch = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const pending = refreshChatgptTokens(sellerId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // doRefresh read bundle A, is in-flight
    // A concurrent turn wins the rotation while our token call is in flight.
    const winnerCt = encryptSecret(
      sellerId,
      "chatgpt_oauth",
      bundleJson({ at: "chatgpt_test_at_w", rt: "chatgpt_test_rt_w", expMs: Date.now() + HOUR }),
    );
    await pool.query(
      `UPDATE llm_credentials SET ciphertext = $2, updated_at = now() WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`,
      [sellerId, winnerCt],
    );
    releaseFetch(tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    const result = await pending;
    expect(result).toEqual({ ok: true, accessToken: "chatgpt_test_at_w" }); // the winner's token
    const stored = JSON.parse(await storedJson(sellerId)) as Record<string, string>;
    expect(stored.refresh_token).toBe("chatgpt_test_rt_w"); // winner's rotation survived, not clobbered
  });

  it("deletes the row and logs a slug on terminal refresh errors (§3.3)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    for (const code of ["invalid_grant", "token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"]) {
      await upsertChatgptConnection(
        sellerId,
        bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
        "gpt-5.1",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: code, error_description: "chatgpt_test_rt_a echoed" }), { status: 400 })),
      );
      const result = await refreshChatgptTokens(sellerId);
      expect(result).toEqual({ ok: false, reason: code });
      expect(await getChatgptConnection(sellerId)).toBeNull(); // row deleted — fail closed
    }
    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chatgpt_oauth_error"));
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.type).toBe("chatgpt_oauth_error");
      expect(["invalid_grant", "token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"]).toContain(parsed.reason);
      expect(parsed.sellerId).toBe(sellerId);
      expect(line.includes("chatgpt_test_")).toBe(false); // no token material in the log
    }
  });

  it("keeps the row and sanitizes text on non-terminal provider errors", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "chatgpt_test_rt_a echoed" }), { status: 503 })),
    );
    const result = await refreshChatgptTokens(sellerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider_error");
      expect(result.message?.includes("chatgpt_test_rt_a")).toBe(false); // token stripped
      expect(result.message).toContain("«redacted»");
    }
    expect(await getChatgptConnection(sellerId)).not.toBeNull(); // row survives a 503
    expect(logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chatgpt_oauth_error"))).toHaveLength(0);
  });

  it("uses Basic auth only when a client secret is configured (§3.1)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    const fetchMock = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshChatgptTokens(sellerId); // public client
    let [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(CHATGPT_OAUTH_TOKEN_URL);
    expect(init.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("chatgpt_test_client");
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.get("scope")).toBeNull(); // §2: scope omitted to retain the grant

    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_c", rt: "chatgpt_test_rt_c", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    process.env.CHATGPT_OAUTH_CLIENT_SECRET = "chatgpt_test_secret";
    const fetchMock2 = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_d", rt: "chatgpt_test_rt_d" }));
    vi.stubGlobal("fetch", fetchMock2);
    await refreshChatgptTokens(sellerId); // confidential client
    [, init] = fetchMock2.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from("chatgpt_test_client:chatgpt_test_secret").toString("base64")}`,
    );
  });

  it("resolve triggers exactly one refresh when the access token is expired and refreshable (§3.3)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN, earliestMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    const fetchMock = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveChatgptCredential(sellerId)).toEqual({ accessToken: "chatgpt_test_at_b", model: "gpt-5.1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await storedJson(sellerId))).toMatchObject({ access_token: "chatgpt_test_at_b" });
  });

  it("resolve returns null inside the earliest_refresh_at window (no dead-token send, no burn)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", expMs: Date.now() - MIN, earliestMs: Date.now() + HOUR }),
      "gpt-5.1",
    );
    const fetchMock = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveChatgptCredential(sellerId)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // refresh would burn the token early
  });

  it("resolve returns null when the plan-usage scope is missing (§2 gate)", async () => {
    await upsertChatgptConnection(
      sellerId,
      bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a", scopes: "openid profile email", expMs: Date.now() - MIN }),
      "gpt-5.1",
    );
    const fetchMock = vi.fn(async () => tokenResponse({ at: "chatgpt_test_at_b", rt: "chatgpt_test_rt_b" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveChatgptCredential(sellerId)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // never refresh a scope-less connection
  });

  it("flag off ⇒ resolve returns null even with a stored row (dormant, §3.1)", async () => {
    await upsertChatgptConnection(sellerId, bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }), "gpt-5.1");
    delete process.env.CHATGPT_OAUTH_ENABLED;
    expect(await resolveChatgptCredential(sellerId)).toBeNull();
    process.env.CHATGPT_OAUTH_ENABLED = "1";
    delete process.env.CHATGPT_OAUTH_CLIENT_ID;
    expect(await resolveChatgptCredential(sellerId)).toBeNull();
    expect(await getChatgptConnection(sellerId)).not.toBeNull(); // the row itself survives, untouched
  });

  it("resolve returns null when the master key is unset (fail closed, THI-191 N2 pattern)", async () => {
    await upsertChatgptConnection(sellerId, bundle({ at: "chatgpt_test_at_a", rt: "chatgpt_test_rt_a" }), "gpt-5.1");
    delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    try {
      expect(await resolveChatgptCredential(sellerId)).toBeNull(); // silent fallback, no exception
    } finally {
      process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = MASTER_HEX;
    }
  });
});
