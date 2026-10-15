// THI-193 PR-3 tests (spec rev fa3288ff §3.4–§3.5, §7): the Responses
// adapter — request mapping (instructions/input/flattened tools, store/stream
// caps), SSE reader through response.completed (deltas, function_call
// round-trip, usage mapping), distinct response.failed / response.incomplete
// failures, fixed friendly OAuth error strings with NO mid-turn fallback,
// budget bypass + provider telemetry, and the rounds cap on OAuth turns.
// Provider fakes reuse the PR-2 stub harness shapes (chatgpt_test_… fixtures,
// STUB_* constants); the chat-completions path is asserted byte-identical
// when no protocol is set. The routes resolution-order matrix lives in the
// DB-backed describe below (skip-if-no-postgres, chat-route.test.ts pattern).

import { readFileSync } from "node:fs";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTurn, wrapToolResult, type ChatUsageSummary } from "../src/chat.js";
import { chatLimits, dailyTokenBudget } from "../src/chat-limits.js";
import type { ResolvedLlmCredential } from "../src/llm-credentials.js";
import {
  CHATGPT_OAUTH_TOKEN_URL,
  getChatgptConnection,
  upsertChatgptConnection,
  type ChatgptTokenBundle,
} from "../src/chatgpt-oauth.js";
import { mountApiRoutes, chatAnonLimiter, chatAuthedLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { LLM_CREDENTIALS_MASTER_KEY_ENV, upsertLlmCredential } from "../src/llm-credentials.js";
import { STUB_DEFAULT_MODEL, STUB_FULL_SCOPES, STUB_SUB } from "./chatgpt-oauth-stub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

/** OAuth credential exactly as resolveChatgptCredential returns it (§3.4). */
const OAUTH_CRED: ResolvedLlmCredential = {
  apiKey: "chatgpt_test_at_1",
  model: STUB_DEFAULT_MODEL,
  completionsUrl: "https://api.openai.com/v1/responses",
  protocol: "responses",
};

const USAGE_LIMIT_TEXT =
  "⚠️ Your ChatGPT plan usage limit was reached — manage it in ChatGPT → Settings → Usage, or disconnect in Account settings.";
const RECONNECT_TEXT =
  "⚠️ Your ChatGPT connection is no longer valid — please reconnect it in Account settings to keep chatting on your plan.";

// --- SSE fakes (provider response shapes, §2/§3.4) ---------------------------

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const delta = (d: string) => ({ type: "response.output_text.delta", delta: d });

const fcItem = (callId: string, name: string, args: string) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: args,
});

function completed(o: { output?: unknown[]; usage?: Record<string, unknown> } = {}) {
  return {
    type: "response.completed",
    response: {
      usage: o.usage ?? { input_tokens: 40, output_tokens: 10 },
      output: o.output ?? [{ type: "message", role: "assistant" }],
    },
  };
}

function failed(code?: string) {
  return {
    type: "response.failed",
    response: code ? { error: { code, message: "provider text chatgpt_test_at_1" } } : {},
  };
}

function incomplete(reason = "max_output_tokens") {
  return { type: "response.incomplete", response: { incomplete_details: { reason } } };
}

/** Capturing provider stub: records url/auth/body of every non-app fetch. */
type ProviderCall = { url: string; auth: string; body: Record<string, unknown> };

function captureFetch(respond: (call: ProviderCall) => Response): ProviderCall[] {
  const calls: ProviderCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: ProviderCall = {
        url: String(url),
        auth: String((init?.headers as Record<string, string> | undefined)?.authorization),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

describe("Responses adapter (THI-193 §3.4, chatTurn on a plan token)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dailyTokenBudget.reset();
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    dailyTokenBudget.reset();
  });

  it("maps the request: instructions, input items, flattened tools, store/stream, the shared cap", async () => {
    const calls = captureFetch(() => sse([delta("Hi."), completed()]));
    const out = await chatTurn([{ role: "user", content: "earlier" }], "hello there", null, OAUTH_CRED);
    expect(out.text).toBe("Hi.");
    expect(calls).toHaveLength(1);
    const { url, auth, body } = calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(auth).toBe("Bearer chatgpt_test_at_1");
    expect(body.model).toBe(STUB_DEFAULT_MODEL);
    expect(body.store).toBe(false); // required for plan usage (§2)
    expect(body.stream).toBe(true); // required for plan usage (§2)
    expect(body.max_output_tokens).toBe(chatLimits.maxTokensPerCall); // caps apply on every source
    // System prompt → top-level instructions; NO system item in input.
    expect(String(body.instructions)).toContain("You are the Thingery assistant");
    expect(String(body.instructions)).toContain("The user is NOT logged in");
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ role: "user", content: "earlier" });
    expect(input[1]).toEqual({ role: "user", content: "hello there" });
    // Tools: flattened Responses defs — no nested chat-completions `function`.
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "function", name: "describe_category" });
    expect(tools[0].parameters).toBeTypeOf("object");
    expect("function" in tools[0]).toBe(false);
  });

  it("protocol absent stays chat-completions byte-identical (max_tokens, not max_output_tokens)", async () => {
    const cred: ResolvedLlmCredential = {
      apiKey: "byo_test_user_key_1",
      model: "gpt-4.1",
      completionsUrl: "https://byo-test.example.com/v1/chat/completions",
    };
    const calls = captureFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 }),
    );
    await chatTurn([], "hello", null, cred);
    expect(calls[0].url).toBe("https://byo-test.example.com/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(1200);
    expect(calls[0].body.max_output_tokens).toBeUndefined();
    expect(calls[0].body.messages).toBeTypeOf("object"); // chat-completions shape
  });

  it("round-trips function_call items: tool_calls back out, results ride function_call_output with H5.1 delimiters", async () => {
    const script = [
      sse([
        { type: "response.output_item.done", item: fcItem("call_1", "bogus_tool", "{}") },
        completed({ output: [fcItem("call_1", "bogus_tool", "{}")] }),
      ]),
      sse([delta("Done."), completed({ usage: { input_tokens: 40, output_tokens: 10 } })]),
    ];
    let i = 0;
    const calls = captureFetch(() => script[i++]);
    const out = await chatTurn([], "please call", null, OAUTH_CRED);
    expect(out.text).toBe("Done.");
    expect(calls).toHaveLength(2);
    // Round 2 request: the prior call + its wrapped tool result.
    const round2 = calls[1].body.input as Array<Record<string, unknown>>;
    const callItem = round2.find((x) => x.type === "function_call");
    expect(callItem).toMatchObject({ call_id: "call_1", name: "bogus_tool", arguments: "{}" });
    const outItem = round2.find((x) => x.type === "function_call_output");
    expect(outItem?.call_id).toBe("call_1");
    expect(String(outItem?.output)).toBe(wrapToolResult("bogus_tool", { error: "unknown tool bogus_tool" }));
    expect(String(outItem?.output)).toContain("<tool_data");
    // Usage accumulated across both rounds; OAuth attribution + budget bypass.
    expect(out.usage).toMatchObject<ChatUsageSummary>({
      rounds: 2,
      tokensIn: 80,
      tokensOut: 20,
      source: "provider",
      model: STUB_DEFAULT_MODEL,
      credentialSource: "user",
      provider: "chatgpt_oauth",
    });
    expect(dailyTokenBudget.used()).toBe(0);
  });

  it("terminal ONLY on response.completed: deltas accumulate, usage maps input/output_tokens", async () => {
    const calls = captureFetch(() => sse([delta("Hello"), delta(" there"), completed({ usage: { input_tokens: 25, output_tokens: 5 } })]));
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toBe("Hello there");
    expect(out.usage?.tokensIn).toBe(25);
    expect(out.usage?.tokensOut).toBe(5);
    expect(out.usage?.provider).toBe("chatgpt_oauth");
    expect(dailyTokenBudget.used()).toBe(0); // user-billed: company meter untouched
    expect(calls).toHaveLength(1);
  });

  it("response.failed (unknown code) fails the turn — provider text never reaches the user path", async () => {
    captureFetch(() => sse([failed("server_error")]));
    await expect(chatTurn([], "hi", null, OAUTH_CRED)).rejects.toThrow(/response\.failed server_error/);
  });

  it("response.incomplete is its own distinct failure", async () => {
    captureFetch(() => sse([delta("partial…"), incomplete()]));
    await expect(chatTurn([], "hi", null, OAUTH_CRED)).rejects.toThrow(/response\.incomplete max_output_tokens/);
  });

  it("a stream that ends without response.completed is a failure (deltas alone are not terminal)", async () => {
    captureFetch(() => sse([delta("orphan text")]));
    await expect(chatTurn([], "hi", null, OAUTH_CRED)).rejects.toThrow(/without response\.completed/);
  });

  it("HTTP 429 usage-limit: exact friendly string, ONE call — never a silent company re-run", async () => {
    const calls = captureFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "provider says no" } }), {
          status: 429,
        }),
    );
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toBe(USAGE_LIMIT_TEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses"); // not the env/company endpoint
    expect(JSON.stringify(out)).not.toContain("provider says no"); // fixed strings only
    expect(out.usage?.provider).toBe("chatgpt_oauth");
  });

  it("mid-stream response.failed with the usage-limit code maps to the same friendly 429 string", async () => {
    captureFetch(() => sse([delta("…"), failed("subscription_sharing_usage_limit_exceeded")]));
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toBe(USAGE_LIMIT_TEXT);
  });

  it("HTTP 403: fixed generic plan string, one call", async () => {
    const calls = captureFetch(
      () => new Response(JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }), { status: 403 }),
    );
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toContain("couldn't be used for chat right now");
    expect(calls).toHaveLength(1);
  });

  it("HTTP 503 usage_unavailable: fixed unavailable string, one call (THI-210 N2)", async () => {
    const calls = captureFetch(
      () => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_unavailable" } }), { status: 503 }),
    );
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toContain("temporarily unavailable");
    expect(JSON.stringify(out)).not.toContain("usage_unavailable"); // fixed strings only, code not leaked
    expect(calls).toHaveLength(1);
  });

  it("HTTP 400 unsupported_capability: plan-rejected string (THI-210 N2)", async () => {
    const calls = captureFetch(
      () => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability" } }), { status: 400 }),
    );
    const out = await chatTurn([], "hi", null, OAUTH_CRED);
    expect(out.text).toContain("couldn't be used for chat right now");
    expect(calls).toHaveLength(1);
  });

  it("caps: roundsPerTurn bounds OAuth turns — 6 calls, then the friendly bound message", async () => {
    let n = 0;
    captureFetch(() => {
      n += 1;
      const callId = `call_${n}`;
      return sse([
        { type: "response.output_item.done", item: fcItem(callId, "bogus_tool", "{}") },
        completed({ output: [fcItem(callId, "bogus_tool", "{}")] }),
      ]);
    });
    const out = await chatTurn([], "loop forever", null, OAUTH_CRED);
    expect(out.text).toBe("Sorry — that took too many steps. Could you simplify the request?");
    expect(out.usage?.rounds).toBe(chatLimits.roundsPerTurn);
    expect(n).toBe(chatLimits.roundsPerTurn);
  });
});

// --- Resolution order matrix (routes seam, §3.4: OAuth → key → company) -------

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const KEY_URL = "https://byo-chat.example.com/v1/chat/completions";
const ENV_URL = "https://api.openai.com/v1/chat/completions"; // no LLM_API_URL set in tests

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

describe.skipIf(!available)("resolution order matrix: user OAuth → user key → company (THI-193 §3.4, DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE items, sellers RESTART IDENTITY CASCADE");
    process.env.LLM_API_KEY = "test-key";
    process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] = "17".repeat(31) + "ef";
    process.env.CHATGPT_OAUTH_ENABLED = "1";
    process.env.CHATGPT_OAUTH_CLIENT_ID = "chatgpt_test_client";
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
    delete process.env.CHATGPT_OAUTH_ENABLED;
    delete process.env.CHATGPT_OAUTH_CLIENT_ID;
  });

  beforeEach(() => {
    chatAnonLimiter.reset();
    chatAuthedLimiter.reset();
    dailyTokenBudget.reset();
    n += 1;
  });

  afterEach(async () => {
    dailyTokenBudget.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.query("DELETE FROM llm_credentials");
  });

  async function seedSeller(): Promise<{ cookie: string; sellerId: string }> {
    const tag = `thi193c-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    return { cookie: `${SESSION_COOKIE}=${signSession(sellerId)}`, sellerId };
  }

  function oauthBundle(
    o: { at?: string; expMs?: number; earliestMs?: number; scopes?: string } = {},
  ): ChatgptTokenBundle {
    return {
      accessToken: o.at ?? "chatgpt_test_at_1",
      refreshToken: "chatgpt_test_rt_1",
      idToken: "chatgpt_test_idt_1",
      scopes: o.scopes ?? STUB_FULL_SCOPES,
      accessExpiresAt: new Date(o.expMs ?? Date.now() + 3_600_000),
      earliestRefreshAt: new Date(o.earliestMs ?? Date.now() - 60_000),
      sub: STUB_SUB,
    };
  }

  async function seedKeyRow(sellerId: string): Promise<void> {
    await upsertLlmCredential(sellerId, { label: "test key", apiKey: "byo_test_chat_key_9", model: "gpt-4.1", baseUrl: "https://byo-chat.example.com/v1" });
  }

  const post = (body: unknown, cookie: string) =>
    fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  /** URL-dispatching provider stub: records every non-app call (url/auth/raw
   * body — the token endpoint posts a form, the LLM endpoints post JSON). */
  function stubProvider(respond: (url: string, raw: string) => Response) {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith(base)) return realFetch(url, init);
        calls.push({ url: u, auth: String((init?.headers as Record<string, string> | undefined)?.authorization), body: String(init?.body ?? "") });
        return respond(u, calls[calls.length - 1].body);
      }),
    );
    return calls;
  }

  const responsesOk = () => sse([delta("plan reply"), completed()]);
  const ccOk = () =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "key reply" } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }),
      { status: 200 },
    );

  const usageEvents = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"chat_usage"'));

  it("fresh OAuth connection WINS over a stored user key: plan token to /v1/responses, provider chatgpt_oauth, budget uncharged", async () => {
    const { cookie, sellerId } = await seedSeller();
    await seedKeyRow(sellerId);
    await upsertChatgptConnection(sellerId, oauthBundle({ at: "chatgpt_test_at_1" }), STUB_DEFAULT_MODEL);
    const calls = stubProvider((u) => (u === RESPONSES_URL ? responsesOk() : new Response(`unexpected ${u}`, { status: 500 })));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe("plan reply");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESPONSES_URL);
    expect(calls[0].auth).toBe("Bearer chatgpt_test_at_1"); // plan token, not the user key or env key
    const body = JSON.parse(calls[0].body);
    expect(body.model).toBe(STUB_DEFAULT_MODEL); // connection model
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({
      type: "chat_usage",
      credential_source: "user",
      provider: "chatgpt_oauth",
      model: STUB_DEFAULT_MODEL,
    });
    expect(dailyTokenBudget.used()).toBe(0); // user-billed turn: company meter untouched
  });

  it("flag off ⇒ dormant row: falls to the stored user key (chat-completions wire), provider user_key", async () => {
    const saved = process.env.CHATGPT_OAUTH_ENABLED;
    delete process.env.CHATGPT_OAUTH_ENABLED; // fail closed, §3.1
    try {
      const { cookie, sellerId } = await seedSeller();
      await seedKeyRow(sellerId);
      await upsertChatgptConnection(sellerId, oauthBundle(), STUB_DEFAULT_MODEL);
      const calls = stubProvider((u) => (u === KEY_URL ? ccOk() : new Response(`unexpected ${u}`, { status: 500 })));
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await post({ message: "hello" }, cookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe("key reply");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(KEY_URL);
      expect(calls[0].auth).toBe("Bearer byo_test_chat_key_9");
      expect(JSON.parse(calls[0].body).max_tokens).toBe(1200); // chat-completions wire
      expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "user_key", credential_source: "user", model: "gpt-4.1" });
    } finally {
      process.env.CHATGPT_OAUTH_ENABLED = saved;
    }
  });

  it("connection missing the plan-usage scope is dormant: falls to the key", async () => {
    const { cookie, sellerId } = await seedSeller();
    await seedKeyRow(sellerId);
    const scopes = STUB_FULL_SCOPES.split(" ").filter((s) => s !== "chatgpt.tokens.use.direct").join(" ");
    await upsertChatgptConnection(sellerId, oauthBundle({ scopes }), STUB_DEFAULT_MODEL);
    const calls = stubProvider((u) => (u === KEY_URL ? ccOk() : new Response(`unexpected ${u}`, { status: 500 })));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([KEY_URL]);
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "user_key" });
  });

  it("no credentials ⇒ company key: provider company, company budget charged", async () => {
    const { cookie } = await seedSeller();
    const calls = stubProvider((u) => (u === ENV_URL ? ccOk() : new Response(`unexpected ${u}`, { status: 500 })));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(ENV_URL);
    expect(calls[0].auth).toBe("Bearer test-key"); // env company key
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "company", credential_source: "company" });
    expect(dailyTokenBudget.used()).toBeGreaterThan(0); // company turn charges the meter
  });

  it("expired access token is refreshed at RESOLUTION (before the turn): one token-endpoint call, turn runs on the NEW token", async () => {
    const { cookie, sellerId } = await seedSeller();
    await upsertChatgptConnection(sellerId, oauthBundle({ at: "chatgpt_test_at_expired", expMs: Date.now() - 600_000 }), STUB_DEFAULT_MODEL);
    const calls = stubProvider((u) => {
      if (u === CHATGPT_OAUTH_TOKEN_URL)
        return new Response(JSON.stringify({ access_token: "chatgpt_test_at_refreshed", refresh_token: "chatgpt_test_rt_2", expires_in: 3600 }), { status: 200 });
      if (u === RESPONSES_URL) return responsesOk();
      return new Response(`unexpected ${u}`, { status: 500 });
    });

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe("plan reply");
    // Exactly one refresh, §2 refresh-grant shape (scope deliberately omitted, PR-1).
    const tokenCalls = calls.filter((c) => c.url === CHATGPT_OAUTH_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("chatgpt_test_rt_1");
    expect(form.get("scope")).toBeNull();
    // The turn itself ran on the refreshed token.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(RESPONSES_URL);
    expect(calls[1].auth).toBe("Bearer chatgpt_test_at_refreshed");
  });

  it("terminal refresh error (invalid_grant): row already deleted (PR-1), turn falls to the key BEFORE starting — no /v1/responses call", async () => {
    const { cookie, sellerId } = await seedSeller();
    await seedKeyRow(sellerId);
    await upsertChatgptConnection(sellerId, oauthBundle({ expMs: Date.now() - 600_000 }), STUB_DEFAULT_MODEL);
    const calls = stubProvider((u) => {
      if (u === CHATGPT_OAUTH_TOKEN_URL) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      if (u === KEY_URL) return ccOk();
      return new Response(`unexpected ${u}`, { status: 500 });
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe("key reply");
    expect(calls.map((c) => c.url)).toEqual([CHATGPT_OAUTH_TOKEN_URL, KEY_URL]); // resolution failure, not a mid-turn switch
    expect(await getChatgptConnection(sellerId)).toBeNull(); // terminal path deleted the row
    expect(spy.mock.calls.some((c) => String(c[0]).includes('"chatgpt_oauth_error"'))).toBe(true);
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "user_key" });
  });

  it("401 subscription_sharing_invalid_user mid-turn: row invalidated, reconnect message, exactly ONE LLM call (no company fallback)", async () => {
    const { cookie, sellerId } = await seedSeller();
    await upsertChatgptConnection(sellerId, oauthBundle(), STUB_DEFAULT_MODEL);
    const calls = stubProvider(
      (u) =>
        u === RESPONSES_URL
          ? new Response(JSON.stringify({ error: { code: "subscription_sharing_invalid_user", message: "dead session" } }), { status: 401 })
          : new Response(`unexpected ${u}`, { status: 500 }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200); // friendly failure, not a 500
    expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe(RECONNECT_TEXT);
    expect(calls).toHaveLength(1); // the failed OAuth turn is NOT re-run on the company key
    expect(await getChatgptConnection(sellerId)).toBeNull(); // invalidated so the NEXT turn resolves key → company
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "chatgpt_oauth", credential_source: "user" });
  });

  it("HTTP 429 usage limit at route level: exact friendly text, chat_usage chatgpt_oauth, budget uncharged", async () => {
    const { cookie, sellerId } = await seedSeller();
    await upsertChatgptConnection(sellerId, oauthBundle(), STUB_DEFAULT_MODEL);
    const calls = stubProvider(
      (u) =>
        u === RESPONSES_URL
          ? new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }), { status: 429 })
          : new Response(`unexpected ${u}`, { status: 500 }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({ message: "hello" }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { text: string } }).reply.text).toBe(USAGE_LIMIT_TEXT);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(usageEvents(spy)[0])).toMatchObject({ type: "chat_usage", provider: "chatgpt_oauth" });
    expect(dailyTokenBudget.used()).toBe(0);
  });
});
