// BYO LLM credential routes (spec THI-186 Phase 1 / THI-189 PR-2):
// GET/PUT/DELETE /api/me/llm-credential over real HTTP + DB, following the
// image-upload route test pattern. The provider verify probe is exercised
// with a stubbed global fetch (no network, no real keys — fixtures are
// byo_test_… strings so the pinned gitleaks scan can never match them).
//
// The invariant under test: the plaintext key exists only in the PUT request
// body — no response, no cache, no DB plaintext (checked from raw JSON).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes, llmCredentialLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { keyFingerprint, LLM_CREDENTIALS_MASTER_KEY_ENV } from "../src/llm-credentials.js";

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

describe.skipIf(!available)("BYO LLM credential routes (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;

  beforeAll(async () => {
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "17".repeat(31) + "ef";
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
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    server.close();
    await db.end();
  });

  beforeEach(() => {
    llmCredentialLimiter.reset();
    vi.unstubAllGlobals();
  });

  async function seed(): Promise<{ sellerId: string; cookie: string }> {
    n += 1;
    const tag = `thi189-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    return { sellerId, cookie: `${SESSION_COOKIE}=${signSession(sellerId)}` };
  }

  const call = (method: string, cookie: string | null, body?: unknown) =>
    fetch(`${base}/api/me/llm-credential`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  /** Stubbed provider endpoint: anything NOT aimed at the test server itself
   *  returns the canned Response; calls to `base` proxy to the real fetch so
   *  the test client keeps working while global fetch is stubbed. */
  function stubProvider(status: number, body: string) {
    const realFetch = globalThis.fetch;
    const mock = vi.fn(async (url: unknown, init?: RequestInit) =>
      String(url).startsWith(base)
        ? realFetch(url as Parameters<typeof fetch>[0], init)
        : new Response(body, { status }),
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  function stubProviderOk() {
    return stubProvider(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  }

  /** Provider calls made during a test (the stub proxies the test client's
   *  own requests to `base`, which are not provider calls). */
  const providerCalls = (mock: { mock: { calls: unknown[][] } }) =>
    mock.mock.calls.filter(([url]) => !String(url).startsWith(base));

  const validBody = {
    api_key: "byo_test_route_key_1",
    model: "gpt-4o-mini",
  };

  it("requires a session on all three verbs", async () => {
    await seed();
    expect((await call("GET", null)).status).toBe(401);
    expect((await call("PUT", null, validBody)).status).toBe(401);
    expect((await call("DELETE", null)).status).toBe(401);
  });

  it("GET: nothing stored → byo_enabled + null credential, no-store", async () => {
    const { cookie } = await seed();
    const res = await call("GET", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ byo_enabled: true, credential: null });
  });

  it("PUT: stores after a passing verify; response is metadata only, no plaintext anywhere", async () => {
    const { sellerId, cookie } = await seed();
    stubProviderOk();
    const res = await call("PUT", cookie, { ...validBody, label: "My key", base_url: "https://api.openai.com/v1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw.includes("byo_test_route_key_1")).toBe(false); // plaintext never returns

    const data = JSON.parse(raw) as { credential: { label: string; model: string; base_url: string; key_fingerprint: string } };
    expect(data.credential).toMatchObject({
      label: "My key",
      model: "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
    });
    expect(data.credential.key_fingerprint).toBe(keyFingerprint("byo_test_route_key_1"));

    // Stored ciphertext-only: raw table text must not contain the plaintext.
    const stored = await db.query("SELECT ciphertext FROM llm_credentials WHERE seller_id = $1", [sellerId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].ciphertext.startsWith("v1.")).toBe(true);
    expect(stored.rows[0].ciphertext.includes("byo_test_route_key_1")).toBe(false);
  });

  it("PUT: failed verify → 400 and nothing written (verify-before-write)", async () => {
    const { sellerId, cookie } = await seed();
    stubProvider(401, JSON.stringify({ error: { message: "bad key" } }));
    const res = await call("PUT", cookie, validBody);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("rejected this API key");
    const rows = await db.query("SELECT * FROM llm_credentials WHERE seller_id = $1", [sellerId]);
    expect(rows.rows).toHaveLength(0);
  });

  it("PUT: gate-rejected model → 400 without calling the provider", async () => {
    const { sellerId, cookie } = await seed();
    const provider = stubProvider(200, "{}");
    const res = await call("PUT", cookie, { ...validBody, model: "gpt-3.5-turbo" });
    expect(res.status).toBe(400);
    expect(providerCalls(provider)).toHaveLength(0);
    const rows = await db.query("SELECT * FROM llm_credentials WHERE seller_id = $1", [sellerId]);
    expect(rows.rows).toHaveLength(0);
  });

  it("PUT: invalid base_url → 400; malformed body → 400", async () => {
    const { cookie } = await seed();
    stubProviderOk();
    expect((await call("PUT", cookie, { ...validBody, base_url: "http://evil.example.com/v1" })).status).toBe(400);
    expect((await call("PUT", cookie, { model: "gpt-4o-mini" })).status).toBe(400); // no api_key
    expect((await call("PUT", cookie, { api_key: "x".repeat(500), model: "gpt-4o-mini" })).status).toBe(400);
  });

  it("PUT: master key unset → 503, feature off (fail closed)", async () => {
    const { cookie } = await seed();
    const had = process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    try {
      const res = await call("PUT", cookie, validBody);
      expect(res.status).toBe(503);
    } finally {
      process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = had;
    }
  });

  it("rotate: second PUT replaces — still one row, new label and fingerprint", async () => {
    const { sellerId, cookie } = await seed();
    stubProviderOk();
    await call("PUT", cookie, { ...validBody, label: "old" });
    await call("PUT", cookie, { api_key: "byo_test_route_key_2", model: "gpt-4.1", label: "new" });
    const rows = await db.query<{ label: string; key_fingerprint: string }>(
      "SELECT label, key_fingerprint FROM llm_credentials WHERE seller_id = $1",
      [sellerId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].label).toBe("new");
    expect(rows.rows[0].key_fingerprint).toBe(keyFingerprint("byo_test_route_key_2"));
  });

  it("DELETE: removes (and stays idempotent); GET reflects it", async () => {
    const { sellerId, cookie } = await seed();
    stubProviderOk();
    await call("PUT", cookie, validBody);
    const res = await call("DELETE", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect((await call("DELETE", cookie)).status).toBe(200); // idempotent
    const rows = await db.query("SELECT * FROM llm_credentials WHERE seller_id = $1", [sellerId]);
    expect(rows.rows).toHaveLength(0);
    expect((await call("GET", cookie)).status).toBe(200);
    expect(((await (await call("GET", cookie)).json()) as { credential: unknown }).credential).toBeNull();
  });

  it("rate-limits writes: the 11th PUT in an hour is 429", async () => {
    const { cookie } = await seed();
    stubProviderOk();
    for (let i = 0; i < 10; i++) {
      expect((await call("PUT", cookie, validBody)).status).toBe(200);
    }
    const res = await call("PUT", cookie, validBody);
    expect(res.status).toBe(429);
  });
});
