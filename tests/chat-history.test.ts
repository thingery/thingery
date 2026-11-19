import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import {
  MAX_STORED_CHAT_MESSAGES,
  MAX_STORED_CONTENT_LENGTH,
  appendChatTurn,
  normalizeStoredAssistantMessage,
  normalizeStoredUserMessage,
} from "../src/chat-history.js";
import { dailyTokenBudget } from "../src/chat-limits.js";
import {
  chatAnonLimiter,
  chatAuthedLimiter,
  chatHistoryLimiter,
  mountApiRoutes,
} from "../src/routes.js";

describe("chat-history normalization", () => {
  it("strips signed confirm/decline tokens from stored user messages", () => {
    expect(normalizeStoredUserMessage("chat-confirm signed.jwt.token")).toBe(
      "(confirmed the pending change)",
    );
    expect(normalizeStoredUserMessage("  chat-decline another.token  ")).toBe(
      "(cancelled the pending change)",
    );
  });

  it("trims and caps normal user and assistant text to MAX_STORED_CONTENT_LENGTH", () => {
    expect(normalizeStoredUserMessage("  hello world  ")).toBe("hello world");
    expect(normalizeStoredUserMessage("a".repeat(MAX_STORED_CONTENT_LENGTH + 50))).toHaveLength(
      MAX_STORED_CONTENT_LENGTH,
    );
    expect(
      normalizeStoredAssistantMessage("b".repeat(MAX_STORED_CONTENT_LENGTH + 50)),
    ).toHaveLength(MAX_STORED_CONTENT_LENGTH);
  });
});

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

describe.skipIf(!available)("/api/chat/history (DB + HTTP)", () => {
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
  });

  beforeEach(() => {
    chatAnonLimiter.reset();
    chatAuthedLimiter.reset();
    chatHistoryLimiter.reset();
    dailyTokenBudget.reset();
    n += 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedSeller(): Promise<{ id: string; cookie: string }> {
    const tag = `chathist-${n}-${Math.random().toString(36).slice(2, 8)}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const id = seller.rows[0].id as string;
    return { id, cookie: `${SESSION_COOKIE}=${signSession(id)}` };
  }

  function stubLlmReply(content: string) {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(base)) return originalFetch(input, init);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  }

  it("rejects anonymous GET and DELETE with 401", async () => {
    const getRes = await fetch(`${base}/api/chat/history`);
    expect(getRes.status).toBe(401);
    const delRes = await fetch(`${base}/api/chat/history`, { method: "DELETE" });
    expect(delRes.status).toBe(401);
  });

  it("persists signed-in chat turns, isolates accounts, and clears on DELETE", async () => {
    const alice = await seedSeller();
    const bob = await seedSeller();
    stubLlmReply("I found a red Kanken for 40 EUR.");

    const postRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: alice.cookie },
      body: JSON.stringify({ message: "Find me a backpack", history: [] }),
    });
    expect(postRes.status).toBe(200);

    const aliceHistory = await fetch(`${base}/api/chat/history`, {
      headers: { cookie: alice.cookie },
    });
    expect(aliceHistory.status).toBe(200);
    const aliceBody = (await aliceHistory.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(aliceBody.messages).toHaveLength(2);
    expect(aliceBody.messages[0]).toMatchObject({ role: "user", content: "Find me a backpack" });
    expect(aliceBody.messages[1]).toMatchObject({
      role: "assistant",
      content: "I found a red Kanken for 40 EUR.",
    });

    // Bob does not see Alice's messages.
    const bobHistory = await fetch(`${base}/api/chat/history`, {
      headers: { cookie: bob.cookie },
    });
    expect(bobHistory.status).toBe(200);
    expect(await bobHistory.json()).toEqual({ messages: [] });

    // Clearing Alice's history removes her messages.
    const clearRes = await fetch(`${base}/api/chat/history`, {
      method: "DELETE",
      headers: { cookie: alice.cookie },
    });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ ok: true });

    const afterClear = await fetch(`${base}/api/chat/history`, {
      headers: { cookie: alice.cookie },
    });
    expect(await afterClear.json()).toEqual({ messages: [] });
  });

  it("prunes stored messages beyond MAX_STORED_CHAT_MESSAGES", async () => {
    const alice = await seedSeller();
    const turns = MAX_STORED_CHAT_MESSAGES / 2 + 3;
    for (let i = 1; i <= turns; i++) {
      await appendChatTurn(alice.id, {
        userContent: `msg ${i}`,
        assistantContent: `reply ${i}`,
      });
    }
    const res = await fetch(`${base}/api/chat/history`, { headers: { cookie: alice.cookie } });
    const body = (await res.json()) as { messages: Array<{ content: string }> };
    expect(body.messages).toHaveLength(MAX_STORED_CHAT_MESSAGES);
    expect(body.messages[0]?.content).toBe("msg 4");
    expect(body.messages.at(-1)?.content).toBe(`reply ${turns}`);
  });
});
