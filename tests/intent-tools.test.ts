// Buyer alerts PR 2 (spec THI-360 rev 2 §5, tools 1–4): intent tool
// roundtrips through the registered handlers with a seller in ctx — save /
// list / mute / unmute / delete, unauthorized refusals, tool-layer
// validation (≥1 of q/filters, unknown category, attribute shape caps,
// max<min), ownership not_found, the daily-save quota surfacing
// rate_limited, and tool-layer intent_write events (R5). DB-backed, skips
// without Postgres. Like tests/intents.test.ts it never TRUNCATEs (parallel
// CI workers share the database): uniquely-emailed sellers, explicit
// cleanup (buyer_intent_quota has no FK). The exact PROTECTED_TOOLS match is
// enforced by tests/protected-tools.test.ts; the 401 challenge by mcp-auth.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { registerTools, PROTECTED_TOOLS } from "../src/tools.js";
import type { SellerRow } from "../src/db.js";

delete process.env.EMBED_API_KEY; // deterministic embedText, as intents tests

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

// Mirrors the registration capture in tests/protected-tools.test.ts.
function captureTools(seller: SellerRow | null): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerTools(
    { registerTool(name: string, _config: unknown, handler: Handler) { handlers.set(name, handler); } },
    { seller },
  );
  return handlers;
}

async function call(handlers: Map<string, Handler>, name: string, args: Record<string, unknown> = {}) {
  const result = (await handlers.get(name)!(args)) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { await client.end().catch(() => {}); return false; }
}

const available = await dbAvailable();

describe.skipIf(!available)("intent tools (DB)", () => {
  let client: pg.Client;
  const sellerRows: SellerRow[] = [];

  async function seedSeller(tag: string): Promise<SellerRow> {
    const nonce = randomUUID();
    const { rows } = await client.query<SellerRow>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3)
       RETURNING id, display_name`,
      // Non-thg_ fixture (gitleaks): the column is a plain-text hash slot,
      // any unique string works.
      [`intent-tools-fixture-${nonce}`, `itools-${tag}`, `itools-${tag}-${nonce}@t.dev`],
    );
    sellerRows.push(rows[0]);
    return rows[0];
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    await client.query(`DELETE FROM buyer_intent_quota WHERE buyer_id = ANY($1::uuid[])`, [sellerRows.map((s) => s.id)]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerRows.map((s) => s.id)]);
    await client.end();
  });

  it("save → my_intents → mute → unmute → delete roundtrip", async () => {
    const tools = captureTools(await seedSeller("rt"));

    const saved = await call(tools, "save_intent", { q: "  vintage watch  ", category: "other", max_price_cents: 50000 });
    expect(saved.isError).toBe(false);
    const intent = saved.body.intent as Record<string, unknown>;
    expect(intent.q).toBe("vintage watch"); // N3: trimmed
    expect(intent.muted).toBe(false);
    expect(typeof intent.id).toBe("string");
    expect(String(saved.body.note)).toContain("my_matches");
    expect(intent).not.toHaveProperty("embedding"); // internals never leave
    expect(intent).not.toHaveProperty("buyer_id");

    const list = await call(tools, "my_intents");
    expect(list.body.count).toBe(1);
    const listed = (list.body.intents as Record<string, unknown>[])[0];
    expect(listed.id).toBe(intent.id);
    expect(listed.unread_matches).toBe(0);

    const muted = await call(tools, "update_intent", { intent_id: intent.id, muted: true });
    expect((muted.body.intent as Record<string, unknown>).muted).toBe(true);
    expect(String(muted.body.note)).toContain("my_matches");
    const unmuted = await call(tools, "update_intent", { intent_id: intent.id, muted: false });
    expect((unmuted.body.intent as Record<string, unknown>).muted).toBe(false);

    expect((await call(tools, "delete_intent", { intent_id: intent.id })).body.deleted).toBe(true);
    expect((await call(tools, "my_intents")).body.count).toBe(0);
    expect((await call(tools, "delete_intent", { intent_id: intent.id })).body.code).toBe("not_found");
  });

  it("rejects anonymous callers with unauthorized", async () => {
    const anon = captureTools(null);
    for (const name of ["save_intent", "my_intents", "update_intent", "delete_intent"]) {
      const r = await call(anon, name, name === "save_intent" ? { q: "anything at all" } : {});
      expect(r.isError).toBe(true);
      expect(r.body.code).toBe("unauthorized");
    }
  });

  it("tool-layer validation: ≥1 of q/filters, unknown category, bad attributes", async () => {
    const tools = captureTools(await seedSeller("valid"));
    // whitespace q is no q (N3) — neither q nor filter present
    for (const args of [{}, { q: "   " }]) {
      expect((await call(tools, "save_intent", args)).body.code).toBe("invalid_request");
    }
    const cat = await call(tools, "save_intent", { category: "no-such-category" });
    expect(cat.body.code).toBe("unknown_category"); // create_listing parity
    expect(String(cat.body.error)).toContain("Available");
    const attrs = await call(tools, "save_intent", { q: "sneakers", attributes: { colorway: "x".repeat(501) } });
    expect(attrs.body.code).toBe("invalid_attributes");
  });

  it("module shape error surfaces as invalid_intent (max < min)", async () => {
    const tools = captureTools(await seedSeller("minmax"));
    expect((await call(tools, "save_intent", { min_price_cents: 5000, max_price_cents: 4000 })).body.code)
      .toBe("invalid_intent");
  });

  it("ownership: another account's intent_id → not_found (missing and non-owned identical)", async () => {
    const toolsA = captureTools(await seedSeller("own-a"));
    const toolsB = captureTools(await seedSeller("own-b"));
    const id = ((await call(toolsA, "save_intent", { q: "warm winter jacket" })).body.intent as Record<string, unknown>).id as string;
    expect((await call(toolsB, "update_intent", { intent_id: id, muted: true })).body.code).toBe("not_found");
    expect((await call(toolsB, "delete_intent", { intent_id: id })).body.code).toBe("not_found");
    expect((await call(toolsA, "my_intents")).body.count).toBe(1); // untouched
  });

  it("over the daily save quota → rate_limited (R2 surfaced)", async () => {
    const seller = await seedSeller("quota");
    await client.query(`INSERT INTO buyer_intent_quota (buyer_id, day, saves) VALUES ($1, CURRENT_DATE, 50)`, [seller.id]);
    expect((await call(captureTools(seller), "save_intent", { q: "one query too many" })).body.code).toBe("rate_limited");
  });

  it("tool-layer validation rejections emit intent_write events (R5, sellerId only)", async () => {
    const seller = await seedSeller("r5");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await call(captureTools(seller), "save_intent", { category: "no-such-category" });
    const events = spy.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string")
      .map((line) => JSON.parse(line))
      .filter((o) => o.type === "intent_write");
    expect(events).toEqual([
      { ts: expect.any(String), type: "intent_write", action: "save", outcome: "rejected", sellerId: seller.id, ip: null },
    ]);
  });

  it("the four intent tools are in PROTECTED_TOOLS", () => {
    for (const name of ["save_intent", "my_intents", "update_intent", "delete_intent"]) {
      expect(PROTECTED_TOOLS.has(name)).toBe(true);
    }
  });
});
