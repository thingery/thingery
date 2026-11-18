// LLM_THINKING=disabled asks the server's own model to skip its hidden reasoning (GLM on z.ai),
// and only the server's own endpoint: a user's key may point at any provider.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTurn, serverThinkingOption } from "../src/chat.js";

const USER_KEY = {
  apiKey: "sk-user-test-key-0000000000",
  model: "gpt-4o-mini",
  completionsUrl: "https://byo-test.example.com/v1/chat/completions",
};

function captureRequests() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi" } }] }), {
        status: 200,
      });
    }),
  );
  return bodies;
}

describe("LLM_THINKING", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "sk-server-test-key-000000000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends nothing when unset, so other providers see the same request as before", async () => {
    const bodies = captureRequests();
    await chatTurn([], "hello", null);
    expect(bodies[0]).not.toHaveProperty("thinking");
  });

  it("turns reasoning off on the server's own endpoint when set to disabled", async () => {
    vi.stubEnv("LLM_THINKING", "disabled");
    const bodies = captureRequests();
    await chatTurn([], "hello", null);
    expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("never sends it to a user's own key", async () => {
    vi.stubEnv("LLM_THINKING", "disabled");
    const bodies = captureRequests();
    await chatTurn([], "hello", null, USER_KEY);
    expect(bodies[0]).not.toHaveProperty("thinking");
  });

  it("ignores any other value", () => {
    vi.stubEnv("LLM_THINKING", "off");
    expect(serverThinkingOption()).toEqual({});
  });
});
