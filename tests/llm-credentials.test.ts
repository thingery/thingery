// BYO LLM credential store tests (spec THI-186 Phase 1 / THI-189).
// Part 1 is pure (no DB): AES-256-GCM framing, AAD binding, fingerprints,
// master-key parsing, model gate, base-URL normalization, verify probe
// (fetch stubbed). Part 2 is DB-backed (skip-if-no-postgres, same pattern
// as tests/schema.test.ts): upsert/rotate/delete, one-row-per-seller,
// cascade on seller delete, runtime gate fallback.
//
// Fixtures use byo_test_… strings so no real provider key format is matched;
// NOTE (gitleaks, THI-191 N1): prefix alone does NOT defeat the
// generic-api-key rule — entropy is the trigger (byo_test_key_verify_ok
// crossed 3.5). The two flagged fixtures are allowlisted as exact strings in
// .gitleaks.toml; everything else must stay under the entropy floor.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BYO_COMPLETIONS_URL,
  LLM_CREDENTIALS_MASTER_KEY_ENV,
  byoMasterKey,
  byoMasterKeyConfigured,
  decryptSecret,
  deleteLlmCredential,
  encryptSecret,
  getLlmCredential,
  keyFingerprint,
  modelAllowedForByo,
  normalizeBaseUrl,
  resolveLlmCredential,
  upsertLlmCredential,
  verifyLlmCredential,
} from "../src/llm-credentials.js";
import { pool } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

/** Valid 32-byte master key in hex (test fixture — not a secret). */
const MASTER_HEX = "5a".repeat(31) + "b7";

function setMasterKey(): void {
  process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = MASTER_HEX;
}

function clearMasterKey(): void {
  delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
}

beforeEach(() => {
  setMasterKey();
});

afterEach(() => {
  clearMasterKey();
});

// ---------------------------------------------------------------------------
// Part 1 — pure: crypto, gate, URL handling, verify probe

describe("BYO master key parsing (spec §1)", () => {
  it("accepts exactly 64 hex chars (32 bytes)", () => {
    expect(byoMasterKey()?.length).toBe(32);
    expect(byoMasterKeyConfigured()).toBe(true);
  });

  it("rejects unset, wrong-length, and non-hex values (fail closed)", () => {
    clearMasterKey();
    expect(byoMasterKey()).toBeNull();
    expect(byoMasterKeyConfigured()).toBe(false);
    for (const bad of ["", "xyz", "ab".repeat(31), "ab".repeat(33), `${"ab".repeat(32)}g`]) {
      process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = bad;
      expect(byoMasterKey(), `value=${bad.slice(0, 8)}…`).toBeNull();
    }
  });
});

describe("AES-256-GCM secret framing (spec §1)", () => {
  const sellerA = "11111111-1111-1111-1111-111111111111";
  const sellerB = "22222222-2222-2222-2222-222222222222";

  it("round-trips a secret", () => {
    const stored = encryptSecret(sellerA, "api_key", "byo_test_secret_1");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(decryptSecret(sellerA, "api_key", stored)).toBe("byo_test_secret_1");
  });

  it("uses a fresh IV per encryption (identical inputs → different ciphertext)", () => {
    const a = encryptSecret(sellerA, "api_key", "byo_test_secret_2");
    const b = encryptSecret(sellerA, "api_key", "byo_test_secret_2");
    expect(a).not.toBe(b);
    expect(decryptSecret(sellerA, "api_key", a)).toBe("byo_test_secret_2");
    expect(decryptSecret(sellerA, "api_key", b)).toBe("byo_test_secret_2");
  });

  it("never stores plaintext (base64url blob only)", () => {
    const stored = encryptSecret(sellerA, "api_key", "byo_test_plaintext_marker");
    expect(stored.includes("byo_test_plaintext_marker")).toBe(false);
  });

  it("binds ciphertext to the seller via AAD: a row swapped between sellers fails", () => {
    const stored = encryptSecret(sellerA, "api_key", "byo_test_secret_3");
    expect(() => decryptSecret(sellerB, "api_key", stored)).toThrow();
  });

  it("binds ciphertext to the kind via AAD (THI-187 seam)", () => {
    const stored = encryptSecret(sellerA, "api_key", "byo_test_secret_4");
    expect(() => decryptSecret(sellerA, "oauth_access", stored)).toThrow();
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const stored = encryptSecret(sellerA, "api_key", "byo_test_secret_5");
    const blob = Buffer.from(stored.slice(3), "base64url");
    blob[blob.length - 1] ^= 0xff;
    const tampered = `v1.${blob.toString("base64url")}`;
    expect(() => decryptSecret(sellerA, "api_key", tampered)).toThrow();
  });

  it("rejects truncated blobs and unknown versions", () => {
    expect(() => decryptSecret(sellerA, "api_key", "v1.YQ")).toThrow(/truncated/);
    expect(() => decryptSecret(sellerA, "api_key", "v2.YQ")).toThrow(/version/);
  });

  it("fails closed (throws) when the master key is unset", () => {
    clearMasterKey();
    expect(() => encryptSecret(sellerA, "api_key", "x")).toThrow(/unconfigured/);
    expect(() => decryptSecret(sellerA, "api_key", encryptSecret(sellerA, "api_key", "x"))).toThrow(/unconfigured/);
  });
});

describe("key fingerprint (spec §1)", () => {
  it("is stable for a key, differs between keys, and never contains the key", () => {
    const f1 = keyFingerprint("byo_test_key_alpha");
    const f2 = keyFingerprint("byo_test_key_beta");
    expect(f1).toBe(keyFingerprint("byo_test_key_alpha"));
    expect(f1).not.toBe(f2);
    expect(f1).toMatch(/^[0-9a-f]{12}$/);
    expect(f1.includes("byo_test_key_alpha")).toBe(false);
  });

  it("changes when the master key changes (HMAC-keyed, not plain hash)", () => {
    const withA = keyFingerprint("byo_test_key_gamma");
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "cd".repeat(32);
    const withB = keyFingerprint("byo_test_key_gamma");
    expect(withA).not.toBe(withB);
  });
});

describe("model allow-gate (spec §4)", () => {
  it("allows tool-calling model families by substring, case-insensitively", () => {
    expect(modelAllowedForByo("gpt-4o-mini")).toBe(true);
    expect(modelAllowedForByo("GPT-4.1-2025-04-14")).toBe(true);
    expect(modelAllowedForByo("claude-sonnet-4-5")).toBe(true);
    expect(modelAllowedForByo("deepseek-chat")).toBe(true);
  });

  it("denies everything else", () => {
    expect(modelAllowedForByo("gpt-3.5-turbo")).toBe(false);
    expect(modelAllowedForByo("davinci-002")).toBe(false);
    expect(modelAllowedForByo("")).toBe(false);
  });

  it("honors the LLM_BYO_ALLOWED_MODELS override", () => {
    process.env.LLM_BYO_ALLOWED_MODELS = " gpt-4o , llama ";
    try {
      expect(modelAllowedForByo("gpt-4o-2024-08-06")).toBe(true);
      expect(modelAllowedForByo("llama-3.3-70b")).toBe(true);
      expect(modelAllowedForByo("claude-sonnet-4-5")).toBe(false);
    } finally {
      delete process.env.LLM_BYO_ALLOWED_MODELS;
    }
  });
});

describe("base URL normalization (spec §3)", () => {
  it("uses the full URL when it already ends with /chat/completions", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("appends /chat/completions to a bare base URL (slash variants)", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions");
  });

  it("defaults to the OpenAI endpoint when omitted or blank", () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_BYO_COMPLETIONS_URL);
    expect(normalizeBaseUrl("  ")).toBe(DEFAULT_BYO_COMPLETIONS_URL);
  });

  it("rejects non-https except for local dev hosts", () => {
    expect(normalizeBaseUrl("http://api.example.com/v1")).toBeNull();
    expect(normalizeBaseUrl("ftp://api.example.com/v1")).toBeNull();
    expect(normalizeBaseUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1/chat/completions");
    expect(normalizeBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("rejects garbage", () => {
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("https://")).toBeNull();
  });
});

describe("verify probe (spec §3): 1-token call with tools attached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: string) {
    const mock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("sends tools + max_tokens 1 and accepts a 200", async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_verify_ok",
      completionsUrl: "https://api.example.com/v1/chat/completions",
      model: "gpt-4o-mini",
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.max_tokens).toBe(1);
    expect(Array.isArray(body.tools)).toBe(true);
    expect((init as RequestInit & { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer byo_test_key_verify_ok",
    );
  });

  it("classifies 401/403 as unauthorized", async () => {
    stubFetch(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_verify_401",
      completionsUrl: DEFAULT_BYO_COMPLETIONS_URL,
      model: "gpt-4o-mini",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("classifies 404 / model_not_found as model_rejected", async () => {
    stubFetch(404, JSON.stringify({ error: { message: "The model 'x' does not exist" } }));
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_verify_404",
      completionsUrl: DEFAULT_BYO_COMPLETIONS_URL,
      model: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("model_rejected");
  });

  it("classifies tool-rejecting endpoints as bad_endpoint", async () => {
    stubFetch(400, "tools is not supported by this endpoint");
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_verify_tools",
      completionsUrl: DEFAULT_BYO_COMPLETIONS_URL,
      model: "gpt-4o-mini",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_endpoint");
  });

  it("never lets the API key ride into the sanitized message", async () => {
    // Hostile endpoint echoes the Authorization value back in the error body.
    stubFetch(400, "Bad key byo_test_key_echoed_value");
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_echoed_value",
      completionsUrl: DEFAULT_BYO_COMPLETIONS_URL,
      model: "gpt-4o-mini",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.includes("byo_test_key_echoed_value")).toBe(false);
      expect(result.message.includes("«redacted»")).toBe(true);
      expect(result.message.length).toBeLessThanOrEqual(300);
    }
  });

  it("reports timeouts as timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("signal timed out", "TimeoutError");
      }),
    );
    const result = await verifyLlmCredential({
      apiKey: "byo_test_key_verify_timeout",
      completionsUrl: DEFAULT_BYO_COMPLETIONS_URL,
      model: "gpt-4o-mini",
    });
    expect(result).toEqual({ ok: false, reason: "timeout", message: "endpoint timed out" });
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed: the store itself

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

describe.skipIf(!available)("BYO credential store (DB, spec §1–§2)", () => {
  const sellerId = "33333333-3333-3333-3333-333333333333";

  beforeAll(async () => {
    await pool.query(readFileSync(schemaPath, "utf8"));
    await pool.query(
      `INSERT INTO sellers (id, api_key_hash, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [sellerId, `thg_byo_${Date.now()}`, "byo-test-seller"],
    );
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM llm_credentials WHERE seller_id = $1`, [sellerId]);
    setMasterKey();
  });

  it("stores, resolves, and deletes a credential; the key is never in metadata", async () => {
    await upsertLlmCredential(sellerId, {
      label: "My OpenAI key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "byo_test_key_store_1",
    });
    const meta = await getLlmCredential(sellerId);
    expect(meta).toMatchObject({
      label: "My OpenAI key",
      model: "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
    });
    expect(JSON.stringify(meta).includes("byo_test_key_store_1")).toBe(false);
    expect(meta?.key_fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const resolved = await resolveLlmCredential(sellerId);
    expect(resolved).toEqual({
      apiKey: "byo_test_key_store_1",
      model: "gpt-4o-mini",
      completionsUrl: "https://api.openai.com/v1/chat/completions",
    });

    await deleteLlmCredential(sellerId);
    expect(await getLlmCredential(sellerId)).toBeNull();
    expect(await resolveLlmCredential(sellerId)).toBeNull();
  });

  it("upsert replaces (rotate): still exactly one row, new fingerprint", async () => {
    await upsertLlmCredential(sellerId, {
      label: "old",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_store_2_old",
    });
    await upsertLlmCredential(sellerId, {
      label: "new",
      model: "gpt-4.1",
      baseUrl: null,
      apiKey: "byo_test_key_store_2_new",
    });
    const { rows } = await pool.query<{ count: string; fingerprint: string }>(
      `SELECT count(*)::text AS count, max(key_fingerprint) AS fingerprint FROM llm_credentials WHERE seller_id = $1`,
      [sellerId],
    );
    expect(Number(rows[0].count)).toBe(1);
    expect(await getLlmCredential(sellerId)).toMatchObject({ label: "new", model: "gpt-4.1" });
    expect((await resolveLlmCredential(sellerId))?.apiKey).toBe("byo_test_key_store_2_new");
  });

  it("default base URL resolves to the OpenAI completions endpoint", async () => {
    await upsertLlmCredential(sellerId, {
      label: "",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_store_3",
    });
    expect((await resolveLlmCredential(sellerId))?.completionsUrl).toBe(DEFAULT_BYO_COMPLETIONS_URL);
  });

  it("resolves to null (never throws) with a stored row when the master key is unset (N2)", async () => {
    await upsertLlmCredential(sellerId, {
      label: "",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_n2",
    });
    clearMasterKey();
    try {
      expect(await resolveLlmCredential(sellerId)).toBeNull(); // silent company fallback, no exception
    } finally {
      setMasterKey();
    }
  });

  it("falls back (null) at runtime when the stored model left the allow-gate", async () => {
    await upsertLlmCredential(sellerId, {
      label: "",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_store_4",
    });
    process.env.LLM_BYO_ALLOWED_MODELS = "claude-only-token";
    try {
      expect(await resolveLlmCredential(sellerId)).toBeNull(); // spec §4: company fallback
    } finally {
      delete process.env.LLM_BYO_ALLOWED_MODELS;
    }
  });

  it("cascades on seller deletion (no orphaned credentials)", async () => {
    const temp = await pool.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_byo_cascade_${Date.now()}`, "byo-cascade"],
    );
    const tempId = temp.rows[0].id;
    await upsertLlmCredential(tempId, {
      label: "",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_cascade",
    });
    await pool.query(`DELETE FROM sellers WHERE id = $1`, [tempId]);
    expect(await getLlmCredential(tempId)).toBeNull();
  });

  it("stores ciphertext that is bound to this seller (cross-seller swap fails)", async () => {
    await upsertLlmCredential(sellerId, {
      label: "",
      model: "gpt-4o-mini",
      baseUrl: null,
      apiKey: "byo_test_key_aad",
    });
    const { rows } = await pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM llm_credentials WHERE seller_id = $1`,
      [sellerId],
    );
    // A second seller reusing this row's ciphertext must not decrypt.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_byo_aad_${Date.now()}`, "byo-aad"],
    );
    await pool.query(
      `INSERT INTO llm_credentials (seller_id, label, model, ciphertext, key_fingerprint)
       VALUES ($1, '', 'gpt-4o-mini', $2, '000000000000')`,
      [other.rows[0].id, rows[0].ciphertext],
    );
    await expect(resolveLlmCredential(other.rows[0].id)).rejects.toThrow();
    await pool.query(`DELETE FROM sellers WHERE id = $1`, [other.rows[0].id]);
  });
});
