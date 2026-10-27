// Buyer alerts v1 core (spec THI-360 rev 2 §3.4/§5, THI-380 riders) —
// src/intents.ts: save roundtrip, validation (incl. N3 q trim), ownership,
// the 25-stored cap, the 50/day quota, delete-cycle-proof quota (R2),
// caps-reject-before-embedText ordering (R1), and intent_write events with
// no payload (R5).
//
// Part 1 is pure (pool.query mocked, mirroring the cap-order block in
// tests/security-events.test.ts). Part 2 is DB-backed (skips when no
// Postgres is reachable). Like tests/listing-limits.test.ts it never
// TRUNCATEs — parallel CI workers share the database — it seeds only
// uniquely-emailed sellers and cleans up just those rows
// (buyer_intent_quota has no FK, so its rows are deleted explicitly).

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { pool } from "../src/db.js";
import * as embed from "../src/embed.js";
import {
  MAX_INTENTS_PER_BUYER,
  MAX_INTENT_SAVES_PER_BUYER_PER_DAY,
  IntentLimitError,
  IntentValidationError,
  saveIntent,
  listIntents,
  updateIntentMute,
  deleteIntent,
  type SaveIntentInput,
} from "../src/intents.js";

// Deterministic embedText (null when unconfigured) — same convention as
// tests/security-events.test.ts.
delete process.env.EMBED_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

function spyLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
function events(spy: ReturnType<typeof spyLog>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((v): v is string => typeof v === "string")
    .map((line) => JSON.parse(line))
    .filter((o) => typeof o === "object" && o !== null && "type" in o && "ts" in o);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Part 1 — R1 ordering (pure: pool.query mocked)

describe("saveIntent cap rejection skips the embeddings call (R1)", () => {
  const input = (): SaveIntentInput => ({ q: "vintage road bike" });

  it("rejects over the stored cap without ever calling embedText", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ stored: String(MAX_INTENTS_PER_BUYER) }] } as never);
    await expect(saveIntent("00000000-0000-0000-0000-0000000000a1", input())).rejects.toBeInstanceOf(IntentLimitError);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("rejects over the daily quota without ever calling embedText", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ stored: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never); // R2 upsert returns zero rows
    await expect(saveIntent("00000000-0000-0000-0000-0000000000a1", input())).rejects.toBeInstanceOf(IntentLimitError);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("invalid shape rejects before any query or embedText call", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    const querySpy = vi.spyOn(pool, "query");
    await expect(saveIntent("00000000-0000-0000-0000-0000000000a1", {})).rejects.toBeInstanceOf(IntentValidationError);
    expect(querySpy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("control: the same spy records exactly one embedText call on an allowed save", async () => {
    const embedSpy = vi.spyOn(embed, "embedText").mockResolvedValue([0.1, 0.2]);
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ stored: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [{ saves: 1 }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "intent-r1-ok" }] } as never);
    const intent = await saveIntent("00000000-0000-0000-0000-0000000000a1", input());
    expect(intent.id).toBe("intent-r1-ok");
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed (skips without a reachable Postgres)

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

describe.skipIf(!available)("intents core (DB)", () => {
  let client: pg.Client;
  const buyerIds: string[] = [];

  async function seedBuyer(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`thg_intents_${nonce}`, `intents-${tag}`, `intents-${tag}-${nonce}@t.dev`],
    );
    buyerIds.push(rows[0].id);
    return rows[0].id;
  }

  const save = (buyerId: string, input: SaveIntentInput = { q: "vintage road bike" }) =>
    saveIntent(buyerId, input);

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    // buyer_intent_quota deliberately has no FK — delete explicitly, then the
    // sellers delete cascades intents + matches.
    await client.query(`DELETE FROM buyer_intent_quota WHERE buyer_id = ANY($1::uuid[])`, [buyerIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [buyerIds]);
    await client.end();
  });

  it("roundtrip: save → list newest-first → mute/unmute → delete", async () => {
    const buyer = await seedBuyer("rt");
    const one = await save(buyer);
    expect(one.buyer_id).toBe(buyer);
    expect(one.muted).toBe(false);
    expect(one.currency).toBe("EUR");
    const two = await save(buyer, { q: undefined, category: "bikes", min_price_cents: 5000 });
    expect(two.q).toBeNull();
    expect(two.category).toBe("bikes");
    expect((await listIntents(buyer)).map((i) => i.id)).toEqual([two.id, one.id]);
    expect((await updateIntentMute(one.id, buyer, true))?.muted).toBe(true);
    expect((await updateIntentMute(one.id, buyer, false))?.muted).toBe(false);
    expect(await deleteIntent(one.id, buyer)).toBe(true);
    expect((await listIntents(buyer)).map((i) => i.id)).toEqual([two.id]);
  });

  it("stores q trimmed; whitespace-only q is no q (N3)", async () => {
    const buyer = await seedBuyer("n3");
    expect((await save(buyer, { q: "   yellow raincoat   " })).q).toBe("yellow raincoat");
    expect((await save(buyer, { q: "   ", category: "coats" })).q).toBeNull(); // filters carry it
    await expect(save(buyer, { q: "   " })).rejects.toBeInstanceOf(IntentValidationError);
  });

  it("rejects no q and no filters, and max < min", async () => {
    const buyer = await seedBuyer("valid");
    await expect(saveIntent(buyer, {})).rejects.toBeInstanceOf(IntentValidationError);
    await expect(save(buyer, { q: undefined, min_price_cents: 5000, max_price_cents: 4000 }))
      .rejects.toMatchObject({ code: "invalid_intent" });
  });

  it("update/delete on another account's intent → null/false (ownership)", async () => {
    const [owner, other] = [await seedBuyer("own-a"), await seedBuyer("own-b")];
    const intent = await save(owner);
    expect(await updateIntentMute(intent.id, other, true)).toBeNull();
    expect(await deleteIntent(intent.id, other)).toBe(false);
    expect((await listIntents(owner)).map((i) => i.id)).toContain(intent.id); // untouched
  });

  it("listIntents aggregates unread matches per intent", async () => {
    const buyer = await seedBuyer("unread");
    const intent = await save(buyer);
    const { rows: item } = await client.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, description, category, price_cents)
       VALUES ($1, 'unread count probe', '', 'other', 100) RETURNING id`,
      [await seedBuyer("unread-seller")],
    );
    await client.query(
      `INSERT INTO intent_matches (intent_id, buyer_id, item_id, score) VALUES ($1, $2, $3, 0.9)`,
      [intent.id, buyer, item[0].id],
    );
    expect((await listIntents(buyer))[0].unread_matches).toBe(1);
    await client.query(`UPDATE intent_matches SET read_at = now() WHERE intent_id = $1`, [intent.id]);
    expect((await listIntents(buyer))[0].unread_matches).toBe(0);
  });

  it("26th stored intent is rejected (rate_limited), before any embedText call (R1)", async () => {
    const buyer = await seedBuyer("cap");
    const embedSpy = vi.spyOn(embed, "embedText");
    for (let i = 0; i < MAX_INTENTS_PER_BUYER; i++) await save(buyer, { q: `stored cap probe ${i}` });
    embedSpy.mockClear();
    await expect(save(buyer)).rejects.toMatchObject({ code: "rate_limited", name: "IntentLimitError" });
    expect(embedSpy).not.toHaveBeenCalled();
    expect((await listIntents(buyer)).length).toBe(MAX_INTENTS_PER_BUYER);
  });

  it("51st save of the day is rate_limited — and stays rejected after deleting every intent (R2)", async () => {
    const buyer = await seedBuyer("quota");
    const embedSpy = vi.spyOn(embed, "embedText");
    for (let i = 0; i < MAX_INTENT_SAVES_PER_BUYER_PER_DAY; i++) {
      const intent = await save(buyer, { q: `quota probe ${i}` });
      await deleteIntent(intent.id, buyer); // delete-cycling must not reset the quota
    }
    embedSpy.mockClear();
    await expect(save(buyer)).rejects.toBeInstanceOf(IntentLimitError); // 51st
    expect(embedSpy).not.toHaveBeenCalled(); // R1 on the quota leg too
    expect((await listIntents(buyer)).length).toBe(0); // table verifiably empty…
    await expect(save(buyer)).rejects.toMatchObject({ code: "rate_limited" }); // …quota still guards
  });

  it("logs intent_write events on success and every rejection class, with no payload (R5)", async () => {
    const spy = spyLog();
    const buyer = await seedBuyer("r5");
    const other = await seedBuyer("r5-other");
    await save(buyer, { q: "vintage road bike" }); // save success
    await expect(saveIntent(buyer, {})).rejects.toBeInstanceOf(IntentValidationError); // save rejected (shape)
    const intent = await save(buyer, { q: "yellow raincoat" }); // save success
    await updateIntentMute(intent.id, buyer, true); // update success
    await updateIntentMute(intent.id, other, true); // update rejected (not owned)
    await deleteIntent(intent.id, buyer); // delete success
    await deleteIntent(intent.id, buyer); // delete rejected (already gone)
    const out = (i: number) => ({ ts: expect.any(String), type: "intent_write", ...i, ip: null });
    expect(events(spy).filter((e) => e.type === "intent_write")).toEqual([
      out({ action: "save", outcome: "success", sellerId: buyer }),
      out({ action: "save", outcome: "rejected", sellerId: buyer }),
      out({ action: "save", outcome: "success", sellerId: buyer }),
      out({ action: "update", outcome: "success", sellerId: buyer }),
      out({ action: "update", outcome: "rejected", sellerId: other }),
      out({ action: "delete", outcome: "success", sellerId: buyer }),
      out({ action: "delete", outcome: "rejected", sellerId: buyer }),
    ]);
    // No-payload rule: the raw console output never carries q or filters.
    const raw = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toContain("vintage road bike");
    expect(raw).not.toContain("yellow raincoat");
  });
});
