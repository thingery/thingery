// THI-180 (spec §7, PR-C routes tests): /api/chat hard limits wiring —
// daily-budget pre-flight 429 (+ rate_limit event attribution), hourly
// limiters fed from CHAT_* env config, the client payload keeping its exact
// pre-THI-180 shape (no `usage` key), and one chat_usage line per
// LLM-backed turn. DB-backed over real HTTP, following the
// image-upload-route test pattern (seller session via signSession).

import { readFileSync } from "node:fs";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountApiRoutes, chatAnonLimiter, chatAuthedLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { dailyTokenBudget } from "../src/chat-limits.js";
import { LLM_CREDENTIALS_MASTER_KEY_ENV, upsertLlmCredential } from "../src/llm-credentials.js";

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

describe.skipIf(!available)("/api/chat hard limits (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;
  let sellerCookie = "";

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE items, sellers RESTART IDENTITY CASCADE");
    // Chat is "configured" (passes the 503 branch) without any network: the
    // LLM fetch is stubbed where a 200 is needed and never reached otherwise.
    process.env.LLM_API_KEY = "test-key";
    // THI-197: BYO store usable in these tests (no rows exist unless a test
    // stores one, so every pre-existing test stays a company turn).
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "17".repeat(31) + "ef";
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
    server.close();
    await db.end();
    delete process.env.LLM_API_KEY;
    delete process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
  });

  beforeEach(() => {
    chatAnonLimiter.reset();
    chatAuthedLimiter.reset();
    dailyTokenBudget.reset();
    n += 1;
  });

  afterEach(() => {
    dailyTokenBudget.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedCookie(): Promise<string> {
    const tag = `thi184-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    return `${SESSION_COOKIE}=${signSession(seller.rows[0].id as string)}`;
  }

  const post = (body: unknown, cookie: string | null) =>
    fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("budget-exhausted pre-flight: 429, exact message, rate_limit event with seller attribution", async () => {
    sellerCookie = await seedCookie();
    dailyTokenBudget.record(null, Number.MAX_SAFE_INTEGER); // exhausted for today
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ message: "hello" }, sellerCookie);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Daily chat budget exhausted — please try again tomorrow." });
    // Order pin: limiter → configured → budget — the 429 is the budget's, not the hourly's.
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({ type: "rate_limit", route: "/api/chat" });
    expect(event.sellerId).toBeTypeOf("string"); // limiter key was the seller, so is the attribution
    expect(event.ip).toBeNull();
  });

  it("budget-exhausted pre-flight: anonymous turn attributes to ip", async () => {
    dailyTokenBudget.record(null, Number.MAX_SAFE_INTEGER);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ message: "hello" }, null);
    expect(res.status).toBe(429);
    const event = JSON.parse(String(spy.mock.calls[0][0]));
    expect(event).toMatchObject({ type: "rate_limit", route: "/api/chat" });
    expect(event.ip).toBeTypeOf("string");
    expect(event.sellerId).toBeNull();
  });

  /** Stubs only the provider LLM call: route requests (URL starts with our
   * ephemeral base) pass through to the real fetch — the route helper and
   * chatTurn share the global, so a blind stub would answer the route itself. */
  function stubLlm(payload: string) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).startsWith(base)) return realFetch(url, init);
        return new Response(payload, { status: 200 });
      }),
    );
  }

  /** Capturing LLM stub (THI-197): records url/auth/body of every provider
   * call; route requests still pass through to the real fetch. */
  function stubLlmCapture(respond: () => Response) {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith(base)) return realFetch(url, init);
        calls.push({
          url: u,
          auth: String((init?.headers as Record<string, string> | undefined)?.authorization),
          body: JSON.parse(String(init?.body)),
        });
        return respond();
      }),
    );
    return calls;
  }

  /** Fresh seller + (optionally) a stored BYO credential row; returns the
   * session cookie. Fixtures use byo_test_… keys (gitleaks convention). */
  async function seedByoSeller(cred: { apiKey: string; model: string; baseUrl: string | null } | null): Promise<string> {
    const tag = `thi197-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    if (cred) await upsertLlmCredential(sellerId, { label: "test key", ...cred });
    return `${SESSION_COOKIE}=${signSession(sellerId)}`;
  }

  it("THI-197 BYO turn: stored credential wins — user url/key/model in the request, budget uncharged, chat_usage labels user", async () => {
    const cookie = await seedByoSeller({ apiKey: "byo_test_chat_key_1", model: "gpt-4.1", baseUrl: "https://byo-chat.example.com/v1" });
    const calls = stubLlmCapture(
      () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Understood." } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }), { status: 200 }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await post({ message: "hello" }, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reply: { text: "Understood." } }); // client shape byte-identical
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://byo-chat.example.com/v1/chat/completions"); // stored base_url normalized
      expect(calls[0].auth).toBe("Bearer byo_test_chat_key_1"); // user key, not the env company key
      expect(calls[0].body.model).toBe("gpt-4.1"); // stored model
      expect(calls[0].body.max_tokens).toBe(1200); // safety rail unchanged
      expect(dailyTokenBudget.used()).toBe(0); // company meter untouched by a user turn
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_usage"'));
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event).toMatchObject({
        type: "chat_usage",
        model: "gpt-4.1", // actual resolved model, not process.env.LLM_MODEL
        credential_source: "user",
        rounds: 1,
        tokens_in: 80,
        tokens_out: 20,
        usage_source: "provider",
      });
      expect(event.daily_total).toBe(0); // meter still reports company state only
    } finally {
      await db.query("DELETE FROM llm_credentials");
    }
  });

  it("THI-197 budget exhausted + stored credential → 200 (BYO bypasses the company budget); no credential → 429 (test above)", async () => {
    const cookie = await seedByoSeller({ apiKey: "byo_test_chat_key_2", model: "gpt-4o-mini", baseUrl: null });
    dailyTokenBudget.record(null, Number.MAX_SAFE_INTEGER); // company budget gone for today
    const calls = stubLlmCapture(() => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await post({ message: "hello" }, cookie);
      expect(res.status).toBe(200); // NOT the budget 429 — the user's key pays
      expect(calls).toHaveLength(1);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_usage"'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).credential_source).toBe("user");
    } finally {
      await db.query("DELETE FROM llm_credentials");
    }
  });

  it("THI-197 user-key 401: friendly text to the client, exactly one LLM call (no company fallback), error-outcome usage lines", async () => {
    const cookie = await seedByoSeller({ apiKey: "byo_test_chat_key_3", model: "gpt-4.1", baseUrl: null });
    const calls = stubLlmCapture(() => new Response("unauthorized", { status: 401 }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await post({ message: "hello" }, cookie);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual(["reply"]); // error text rides reply.text — no shape change
      expect((json.reply as { text: string }).text).toContain("Your saved model key was rejected");
      expect((json.reply as { text: string }).text).toContain("Model settings");
      expect(calls).toHaveLength(1); // never a second, company-key call
      const usage = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_usage"')).map((l) => JSON.parse(l));
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ credential_source: "user", model: "gpt-4.1" });
      const turn = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_turn_usage"')).map((l) => JSON.parse(l));
      expect(turn).toHaveLength(1);
      expect(turn[0].outcome).toBe("error");
    } finally {
      await db.query("DELETE FROM llm_credentials");
    }
  });

  it("THI-197 decrypt failure (wrong master key over the stored row): byo_credential_error slug + company turn still succeeds", async () => {
    const cookie = await seedByoSeller({ apiKey: "byo_test_chat_key_4", model: "gpt-4.1", baseUrl: "https://byo-chat.example.com/v1" });
    const savedMaster = process.env[LLM_CREDENTIALS_MASTER_KEY_ENV];
    // Rotate the master key under the stored row: GCM auth fails → resolveLlmCredential throws → wrapper catches.
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "2b".repeat(31) + "cd";
    const calls = stubLlmCapture(() => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "company ok" } }] }), { status: 200 }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await post({ message: "hello" }, cookie);
      expect(res.status).toBe(200); // falls back to company — never a 500
      expect((await res.json()).reply.text).toBe("company ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions"); // env/company URL, not the stored base_url
      const events = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"byo_credential_error"')).map((l) => JSON.parse(l));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "byo_credential_error", route: "/api/chat" });
      expect(events[0].sellerId).toBeTypeOf("string");
      expect(JSON.stringify(events[0])).not.toContain("byo-chat.example.com"); // no base_url in the log
      expect(JSON.stringify(events[0])).not.toContain("byo_test_chat_key_4"); // no key material in the log
      const usage = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_usage"')).map((l) => JSON.parse(l));
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ credential_source: "company", model: "gpt-4o-mini" });
    } finally {
      process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = savedMaster;
      await db.query("DELETE FROM llm_credentials");
    }
  });

  it("hourly-limit 429 also logs a rate_limit line (N3): exhausted anonymous limiter", async () => {
    chatAnonLimiter.reset();
    dailyTokenBudget.reset();
    // Drain the default anon budget (10/h) with cheap offline LLM replies,
    // then pin that the 11th is the limiter's 429 — and that it now logs a
    // rate_limit line (N3: chat 429s were the only ones without one).
    stubLlm(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    );
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ message: `m${i}` }, null);
      expect(res.status).toBe(200);
    }
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ message: "one too many" }, null);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("Anonymous chat limit reached");
    const event = JSON.parse(String(spy.mock.calls.find((c) => String(c[0]).includes("rate_limit"))?.[0] ?? "{}"));
    expect(event).toMatchObject({ type: "rate_limit", route: "/api/chat" });
    expect(event.ip).toBeTypeOf("string");
  });

  it("success: chat_usage line emitted, client JSON has exactly { reply } — no usage key leaks", async () => {
    stubLlm(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Understood." } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ message: "hello" }, sellerCookie);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // Client payload regression pin: byte-identical shape to pre-THI-180.
    expect(Object.keys(json)).toEqual(["reply"]);
    expect(json.reply).toEqual({ text: "Understood." });
    expect(JSON.stringify(json)).not.toContain("usage");
    // Exactly one chat_usage line, numbers only, provider source, seller attribution.
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chat_usage"));
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      type: "chat_usage",
      model: "gpt-4o-mini", // env default, not request data
      credential_source: "company", // no stored row ⇒ company turn (THI-197)
      rounds: 1,
      tokens_in: 120,
      tokens_out: 30,
      usage_source: "provider",
    });
    expect(event.daily_total).toBe(150);
    expect(event.budget).toBe(2_000_000);
    expect(event.sellerId).toBeTypeOf("string");
  });
});

describe("chat limiter values come from CHAT_* env config (THI-180 §3.1)", () => {
  it("CHAT_TURNS_HOURLY_ANON bounds the anonymous limiter at boot", async () => {
    // chatLimits + the route's limiters are boot singletons — reload the
    // module graph with a tiny env value to prove the wiring (no LLM call
    // happens: the first two posts pass the limiter and stop at the 503
    // branch because LLM_API_KEY is unset here; the third is the limiter's).
    vi.resetModules();
    process.env.CHAT_TURNS_HOURLY_ANON = "2";
    delete process.env.LLM_API_KEY;
    try {
      const { mountApiRoutes: mount } = await import("../src/routes.js");
      const app = express();
      app.use(express.json({ limit: "100kb" }));
      mount(app);
      const { base, close } = await new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
        const srv = app.listen(0, "127.0.0.1", () =>
          resolve({
            base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
            close: () => new Promise<void>((r) => srv.close(() => r())),
          }),
        );
      });
      const post = (message: string) =>
        fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        });
      expect((await post("one")).status).toBe(503); // limiter allowed, chat unconfigured
      expect((await post("two")).status).toBe(503);
      const third = await post("three");
      expect(third.status).toBe(429);
      expect((await third.json()).error).toContain("Anonymous chat limit reached");
      await close();
    } finally {
      delete process.env.CHAT_TURNS_HOURLY_ANON;
      vi.resetModules();
    }
  });
});
