// THI-814 (P1-2, spec THI-813 §3.3): POST /api/draft-listing wiring tests —
// session auth, zod 400s, the single-photo v1 limit, 503 not-configured, 429
// budget/rate exhaustion, and the happy path with a scripted provider. Same
// DB-backed-over-real-HTTP pattern as tests/chat-route.test.ts (the chat
// hard-limits suite this route deliberately mirrors).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { extractionBudget, extractionSellerLimiter } from "../src/extraction.js";

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

describe.skipIf(!available)("POST /api/draft-listing (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let n = 0;
  let sellerCookie = "";
  let logSpy: ReturnType<typeof vi.spyOn>;

  const DRAFT_JSON = JSON.stringify({
    title: "Vintage wooden puzzle set",
    category: "toys",
    condition: "good",
    attributes: {},
    confidence: { category: 0.8, condition: 0.6, title: 0.7, attributes: {} },
    open_questions: [],
  });

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
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
    delete process.env.LLM_API_KEY;
    await db.query(`DELETE FROM sellers WHERE email LIKE 'draft-route-%'`);
    await db.end();
    server.close();
  });

  beforeEach(() => {
    extractionBudget.reset();
    extractionSellerLimiter.reset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    n += 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  async function seedCookie(): Promise<string> {
    const tag = `draft-route-${Date.now()}-${n}`;
    const seller = await db.query<{ id: string }>(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'draft-route', $2) RETURNING id",
      [`thg_${tag}`, tag],
    );
    return `${SESSION_COOKIE}=${signSession(seller.rows[0].id as string)}`;
  }

  // The client-side fetch must bypass the LLM stub: vi.stubGlobal replaces
  // the same global this helper would call, so keep the real one captured.
  const realFetch = globalThis.fetch;

  function post(body: unknown, cookie: string | null): Promise<Response> {
    return realFetch(`${base}/api/draft-listing`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }

  function stubLlm(content: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  function jsonLines(type: string): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.startsWith('{"ts":'))
      .map((s) => JSON.parse(s))
      .filter((o: Record<string, unknown>) => o.type === type);
  }

  it("anonymous → 401 (session required)", async () => {
    const res = await post({ text: "a bike" }, null);
    expect(res.status).toBe(401);
  });

  it("empty body → 400 with guidance", async () => {
    sellerCookie = await seedCookie();
    const res = await post({}, sellerCookie);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("text");
    expect(json.error).toContain("photo");
  });

  it("two photos → 400 (v1 single-photo limit, spec §11.1)", async () => {
    sellerCookie = await seedCookie();
    const photo = { image_base64: "a".repeat(100), media_type: "image/png" };
    const res = await post({ photos: [photo, photo] }, sellerCookie);
    expect(res.status).toBe(400);
  });

  it("not configured → 503 with the typed code", async () => {
    const saved = process.env.LLM_API_KEY;
    try {
      delete process.env.LLM_API_KEY;
      sellerCookie = await seedCookie();
      const res = await post({ text: "a bike" }, sellerCookie);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "extraction_not_configured" });
    } finally {
      process.env.LLM_API_KEY = saved;
    }
  });

  it("happy path: session seller + scripted provider → 200 draft with FMV and one usage event", async () => {
    sellerCookie = await seedCookie();
    stubLlm(DRAFT_JSON);
    const res = await post({ text: "wooden puzzle set for kids" }, sellerCookie);
        expect(res.status).toBe(200);
    const json = (await res.json()) as {
      draft: { title: string; category: string; condition: string };
      confidence: { category: number };
      fair_market_value: { method: string; min_cents: number | null };
      notes: string[];
    };
    expect(json.draft.title).toBe("Vintage wooden puzzle set");
    expect(json.draft.category).toBe("toys");
    expect(json.draft.condition).toBe("good");
    expect(json.fair_market_value.method).toBe("none"); // no seeded comparables here
    expect(json.fair_market_value.min_cents).toBeNull();
    const usage = jsonLines("extraction_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].sellerId).toBeTypeOf("string");
  });

  it("budget exhausted → 429 with the typed code and a budget event", async () => {
    sellerCookie = await seedCookie();
    extractionBudget.record(null, Number.MAX_SAFE_INTEGER);
    const res = await post({ text: "a bike" }, sellerCookie);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "extraction_budget_exhausted" });
    expect(jsonLines("extraction_budget")[0].action).toBe("token_budget_exhausted");
  });

  it("per-seller hourly limit → 429 after 10 drafts, rate_limit event with the route slug", async () => {
    sellerCookie = await seedCookie();
    stubLlm(DRAFT_JSON);
    for (let i = 0; i < 10; i++) {
      const res = await post({ text: `a bike number ${i}` }, sellerCookie);
            expect(res.status).toBe(200);
    }
    const res = await post({ text: "one too many" }, sellerCookie);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    const limited = jsonLines("rate_limit");
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ route: "/api/draft-listing", sellerId: expect.any(String) });
  });
});
