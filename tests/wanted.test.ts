// Wanted listings v1 core (spec THI-439 rev 1 §3.1–§3.3) — src/wanted.ts:
// create/list/edit/expire/renew roundtrips, validation classes, contact-info
// scrub rejections, the state machine's illegal transitions, ownership,
// caps (10 active, 10 creates/day, 20 edits/day), expire-cycling, R1
// caps-before-embedText ordering, and wanted_write events (ids only).
//
// Part 1 is pure (pool.query mocked, mirroring tests/intents.test.ts).
// Part 2 is DB-backed (skips when no Postgres is reachable). Like
// tests/intents.test.ts it never TRUNCATEs — it seeds uniquely-emailed
// sellers and cleans up just those rows (wanted_buyer_quota has no FK, so
// its rows are deleted explicitly).

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { pool } from "../src/db.js";
import * as embed from "../src/embed.js";
import {
  MAX_ACTIVE_WANTEDS_PER_BUYER,
  MAX_WANTED_CREATES_PER_BUYER_PER_DAY,
  MAX_WANTED_EDITS_PER_BUYER_PER_DAY,
  WANTED_TTL_DAYS,
  WantedLimitError,
  WantedValidationError,
  ContactInfoError,
  WantedNotFoundError,
  createWanted,
  updateWanted,
  listMyWanted,
  wantedToPublic,
  type CreateWantedInput,
} from "../src/wanted.js";

// Deterministic embedText (null when unconfigured) — same convention as
// tests/intents.test.ts.
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
function wantedEvents(spy: ReturnType<typeof spyLog>): Record<string, unknown>[] {
  return events(spy).filter((e) => e.type === "wanted_write");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Part 1 — R1 ordering (pure: pool.query mocked)

describe("createWanted rejections skip the embeddings call (R1)", () => {
  const input = (): CreateWantedInput => ({ title: "Nintendo Switch OLED" });

  it("invalid shape rejects before any query or embedText call", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    const querySpy = vi.spyOn(pool, "query");
    await expect(
      createWanted("00000000-0000-0000-0000-0000000000a1", { title: "ab" }),
    ).rejects.toBeInstanceOf(WantedValidationError);
    expect(querySpy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("contact-info scrub trip rejects before any query or embedText call", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    const querySpy = vi.spyOn(pool, "query");
    await expect(
      createWanted("00000000-0000-0000-0000-0000000000a1", {
        title: "Nintendo Switch OLED",
        notes: "call me on whatsapp for details",
      }),
    ).rejects.toBeInstanceOf(ContactInfoError);
    expect(querySpy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("rejects over the active cap without ever calling embedText", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ active: String(MAX_ACTIVE_WANTEDS_PER_BUYER) }] } as never);
    await expect(
      createWanted("00000000-0000-0000-0000-0000000000a1", input()),
    ).rejects.toBeInstanceOf(WantedLimitError);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("rejects over the daily create quota without ever calling embedText", async () => {
    const embedSpy = vi.spyOn(embed, "embedText");
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ name: "other" }] } as never) // getCategory
      .mockResolvedValueOnce({ rows: [{ active: "0" }] } as never) // active cap
      .mockResolvedValueOnce({ rows: [] } as never); // R2 upsert returns zero rows
    await expect(
      createWanted("00000000-0000-0000-0000-0000000000a1", input()),
    ).rejects.toBeInstanceOf(WantedLimitError);
    expect(embedSpy).not.toHaveBeenCalled();
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

describe.skipIf(!available)("wanted core (DB)", () => {
  let client: pg.Client;
  const buyerIds: string[] = [];

  async function seedBuyer(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      // Not a thg_ prefixed value — gitleaks' custom seller-key rule flags
      // thg_ + 20+ word chars; this column is plain TEXT (a hash).
      [`wanted-fixture-${nonce}`, `wanted-${tag}`, `wanted-${tag}-${nonce}@t.dev`],
    );
    buyerIds.push(rows[0].id);
    return rows[0].id;
  }

  const create = (buyerId: string, input: CreateWantedInput = { title: "Nintendo Switch OLED" }) =>
    createWanted(buyerId, input);

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    // wanted_buyer_quota deliberately has no FK — delete explicitly, then the
    // sellers delete cascades wanted_items + responses.
    await client.query(`DELETE FROM wanted_buyer_quota WHERE buyer_id = ANY($1::uuid[])`, [buyerIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [buyerIds]);
    await client.end();
  });

  it("roundtrip: create (30d TTL) → list mine → edit → expire → renew inside grace", async () => {
    const buyer = await seedBuyer("rt");
    const created = await create(buyer, {
      title: "Nintendo Switch OLED",
      notes: "White joycons, box would be nice",
      category: "games",
      condition: "good",
      budget_min_cents: 15000,
      budget_max_cents: 20000,
      currency: "EUR",
      reference_images: ["https://example.com/switch.jpg"],
    });
    expect(created.status).toBe("active");
    expect(created.category).toBe("games");
    expect(created.condition).toBe("good");
    expect(created.reference_images).toEqual(["https://example.com/switch.jpg"]);
    expect(created.embedding).toBeNull(); // embeddings unconfigured in tests
    const ttlDays = (created.expires_at.getTime() - created.created_at.getTime()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(29.9);
    expect(ttlDays).toBeLessThanOrEqual(WANTED_TTL_DAYS);

    const mine = await listMyWanted(buyer);
    expect(mine.wanteds.map((w) => w.id)).toEqual([created.id]);
    expect(mine.wanteds[0].response_count).toBe(0);
    expect(mine.wanteds[0].unread_responses).toBe(0);
    expect(mine.wanteds[0].renewable).toBe(false); // fresh active, >7d left

    const edited = await updateWanted(created.id, buyer, {
      fields: { budget_max_cents: 22000, notes: "White joycons, any box state" },
    });
    expect(edited.budget_max_cents).toBe(22000);
    expect(edited.notes).toBe("White joycons, any box state");
    expect(edited.title).toBe("Nintendo Switch OLED"); // wholesale replace keeps untouched fields

    const expired = await updateWanted(created.id, buyer, { expire: true });
    expect(expired.status).toBe("expired");

    const renewed = await updateWanted(created.id, buyer, { renew: true });
    expect(renewed.status).toBe("active");
    expect(renewed.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("validates shape: title length, inverted budget, unknown category, image rules, notes cap", async () => {
    const buyer = await seedBuyer("val");
    await expect(create(buyer, { title: "ab" })).rejects.toThrow(WantedValidationError);
    await expect(create(buyer, { title: "x".repeat(201) })).rejects.toThrow(WantedValidationError);
    await expect(
      create(buyer, { title: "E-bike", budget_min_cents: 50000, budget_max_cents: 10000 }),
    ).rejects.toThrow(WantedValidationError);
    await expect(
      create(buyer, { title: "E-bike", budget_min_cents: -1 }),
    ).rejects.toThrow(WantedValidationError);
    await expect(
      create(buyer, { title: "E-bike", category: "nope-category" }),
    ).rejects.toThrow(/Unknown category/);
    await expect(
      create(buyer, { title: "E-bike", reference_images: ["javascript:alert(1)"] }),
    ).rejects.toThrow(/http\(s\)/);
    await expect(
      create(buyer, { title: "E-bike", reference_images: Array.from({ length: 4 }, () => "https://e.com/a.jpg") }),
    ).rejects.toThrow(/at most 3/);
    await expect(
      create(buyer, { title: "E-bike", reference_images: [`https://e.com/${"a".repeat(2100)}`] }),
    ).rejects.toThrow(/2048/);
    await expect(
      create(buyer, { title: "E-bike", notes: "n".repeat(2001) }),
    ).rejects.toThrow(/2000/);
    await expect(
      create(buyer, { title: "E-bike", currency: "EUROS" }),
    ).rejects.toThrow(/currency/);
    await expect(
      create(buyer, { title: "E-bike", condition: "mint" }),
    ).rejects.toThrow(/condition/);
  });

  it("rejects contact info in title/notes with the typed contact_info error", async () => {
    const buyer = await seedBuyer("scrub");
    const cases: Array<[string, CreateWantedInput]> = [
      ["email", { title: "Vintage lamp", notes: "reach me at me@example.com" }],
      ["phone", { title: "Vintage lamp", notes: "call +39 02 1234 5678 thanks" }],
      ["url", { title: "Vintage lamp", notes: "see https://mysite.example/wishlist" }],
      ["www-url", { title: "Vintage lamp", notes: "see www.mysite.example/wishlist" }],
      ["handle", { title: "Vintage lamp", notes: "ping @lamp_hunter on socials" }],
      ["service word", { title: "Vintage lamp", notes: "whatsapp me if you have one" }],
      ["title field", { title: "Text me for a vintage lamp", notes: "" }],
    ];
    for (const [, input] of cases) {
      await expect(create(buyer, input)).rejects.toBeInstanceOf(ContactInfoError);
    }
    // And on the edit path.
    const w = await create(buyer);
    await expect(
      updateWanted(w.id, buyer, { fields: { notes: "dm me for details" } }),
    ).rejects.toBeInstanceOf(ContactInfoError);

    // Benign text with digits must pass (no phone false positive).
    const clean = await create(buyer, { title: "Sneakers", notes: "size 43, max budget 150 euro, from 2020" });
    expect(clean.status).toBe("active");
  });

  it("state machine: edit expired → invalid; renew fresh active → invalid; renew past grace → invalid", async () => {
    const buyer = await seedBuyer("sm");
    const w = await create(buyer);
    await updateWanted(w.id, buyer, { expire: true });

    await expect(updateWanted(w.id, buyer, { fields: { title: "New title here" } })).rejects.toThrow(
      /renew it first/,
    );
    const fresh = await create(buyer, { title: "Another thing to find" });
    await expect(updateWanted(fresh.id, buyer, { renew: true })).rejects.toThrow(/not renewable yet/);
    await expect(updateWanted(w.id, buyer, { expire: true, renew: true })).rejects.toThrow(
      WantedValidationError,
    );

    // Past grace: expires_at older than 30 days.
    await client.query(`UPDATE wanted_items SET expires_at = now() - interval '40 days' WHERE id = $1`, [w.id]);
    await expect(updateWanted(w.id, buyer, { renew: true })).rejects.toThrow(/permanently expired/);

    // Renewal from expiring-active (<= 7 days left) is allowed.
    await client.query(`UPDATE wanted_items SET status = 'active', expires_at = now() + interval '2 days' WHERE id = $1`, [w.id]);
    const renewed = await updateWanted(w.id, buyer, { renew: true });
    expect(renewed.status).toBe("active");
    expect(renewed.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("ownership: updating another buyer's wanted is not_found (indistinguishable)", async () => {
    const a = await seedBuyer("owna");
    const b = await seedBuyer("ownb");
    const w = await create(a);
    await expect(updateWanted(w.id, b, { expire: true })).rejects.toBeInstanceOf(WantedNotFoundError);
  });

  it("caps: 11th active rejected; expire-cycling cannot exceed 10 live", async () => {
    const buyer = await seedBuyer("cap");
    // Isolate from the daily create quota: reset the day row between batches.
    for (let i = 0; i < MAX_ACTIVE_WANTEDS_PER_BUYER; i++) {
      await create(buyer, { title: `Wanted thing number ${i} for cap test` });
    }
    await expect(create(buyer, { title: "The eleventh wanted thing" })).rejects.toBeInstanceOf(WantedLimitError);

    // Expire all, clear the daily quota (to exercise the ACTIVE cap, not the
    // quota), create 10 more, then renewing an expired one must hit the cap.
    await client.query(`UPDATE wanted_items SET status = 'expired' WHERE buyer_id = $1`, [buyer]);
    await client.query(`UPDATE wanted_buyer_quota SET creates = 0 WHERE buyer_id = $1`, [buyer]);
    for (let i = 0; i < MAX_ACTIVE_WANTEDS_PER_BUYER; i++) {
      await create(buyer, { title: `Second batch wanted thing ${i}` });
    }
    const old = await client.query<{ id: string }>(
      `SELECT id FROM wanted_items WHERE buyer_id = $1 AND status = 'expired' LIMIT 1`,
      [buyer],
    );
    await expect(updateWanted(old.rows[0].id, buyer, { renew: true })).rejects.toBeInstanceOf(WantedLimitError);
  });

  it("daily quota: 11th create in a day rejected; 21st edit in a day rejected", async () => {
    const buyer = await seedBuyer("quota");
    for (let i = 0; i < MAX_WANTED_CREATES_PER_BUYER_PER_DAY; i++) {
      await create(buyer, { title: `Quota test wanted number ${i}` });
    }
    await expect(create(buyer, { title: "Over the daily quota now" })).rejects.toBeInstanceOf(WantedLimitError);

    const w = (await listMyWanted(buyer)).wanteds[0];
    for (let i = 0; i < MAX_WANTED_EDITS_PER_BUYER_PER_DAY; i++) {
      await updateWanted(w.id, buyer, { fields: { notes: `edit number ${i}` } });
    }
    await expect(updateWanted(w.id, buyer, { fields: { notes: "one edit too many" } })).rejects.toBeInstanceOf(
      WantedLimitError,
    );
  });

  it("wantedToPublic: no buyer_id, no embedding, budget as a range, days_left, url", async () => {
    const buyer = await seedBuyer("pub");
    const w = await create(buyer, { title: "Public shape check", budget_min_cents: 100, budget_max_cents: 200 });
    const pub = wantedToPublic(w);
    expect(pub).not.toHaveProperty("buyer_id");
    expect(pub).not.toHaveProperty("embedding");
    expect(pub.budget).toEqual({ min_cents: 100, max_cents: 200, currency: "EUR" });
    expect(pub.days_left).toBe(30);
    expect(pub.url).toContain(`/wanted/${w.id}`);
  });

  it("wanted_write events: success and every rejection class, ids only", async () => {
    const spy = spyLog();
    const buyer = await seedBuyer("evt");
    await create(buyer); // success
    await expect(create(buyer, { title: "ab" })).rejects.toThrow(); // shape rejection
    const w = await create(buyer, { title: "Eventful wanted item" });
    await updateWanted(w.id, buyer, { expire: true }); // expire success
    await expect(updateWanted(w.id, buyer, { fields: { title: "Edit after expiry" } })).rejects.toThrow(); // transition rejection
    const lines = wantedEvents(spy);
    const byAction = (action: string, outcome: string) =>
      lines.filter((l) => l.action === action && l.outcome === outcome);
    expect(byAction("create", "success").length).toBeGreaterThanOrEqual(2);
    expect(byAction("create", "rejected").length).toBe(1);
    expect(byAction("expire", "success").length).toBe(1);
    expect(byAction("update", "rejected").length).toBe(1);
    for (const line of lines) {
      expect(line.sellerId).toBe(buyer);
      expect(line).not.toHaveProperty("title");
      expect(line).not.toHaveProperty("notes");
    }
  });
});
