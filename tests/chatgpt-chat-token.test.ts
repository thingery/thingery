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
import { STUB_DEFAULT_MODEL, STUB_FULL_SCOPES, STUB_SUB } from "./chatgpt-oauth-stub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

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
