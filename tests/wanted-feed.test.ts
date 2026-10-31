// Wanted UX data seam (spec THI-439 §6): the visual-language helpers
// (budget as a RANGE, never a single price badge; freshness line) and the
// renewal window predicate are pure; the board/demand reads are real
// src/wanted.ts calls since THI-440 PR 4 swapped the seam — DB-backed and
// skip-guarded when Postgres is unreachable.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  budgetRange,
  getWanted,
  renewableNow,
  wantedBoard,
  wantedDemandByCategory,
  wantedFreshness,
} from "../src/wanted-feed.js";
import { createWanted } from "../src/wanted.js";

delete process.env.EMBED_API_KEY;

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

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-01T12:00:00Z");
const iso = (msFromNow: number): string => new Date(NOW.getTime() + msFromNow).toISOString();

describe("budgetRange — budget is always a range, never a single price badge", () => {
  it("renders both bounds as €min–max", () => {
    expect(budgetRange(15000, 20000, "EUR")).toBe("\u20ac150\u2013200");
  });

  it("renders a max-only budget as 'up to'", () => {
    expect(budgetRange(null, 20000, "EUR")).toBe("up to \u20ac200");
  });

  it("renders a min-only budget as '€min+'", () => {
    expect(budgetRange(15000, null, "EUR")).toBe("\u20ac150+");
  });

  it("renders an open budget honestly", () => {
    expect(budgetRange(null, null, "EUR")).toBe("budget open");
  });

  it("keeps fractional cents and falls back to the currency code", () => {
    expect(budgetRange(15050, 20000, "EUR")).toBe("\u20ac150.50\u2013200");
    expect(budgetRange(15000, 20000, "SEK")).toBe("SEK 150\u2013200");
  });

  it("never renders the for-sale single-price format", () => {
    const text = budgetRange(15000, 20000, "EUR");
    expect(text).not.toMatch(/\d+\.\d\d EUR/); // money() badge format
    expect(text).toContain("\u2013"); // en dash range separator
  });
});

describe("wantedFreshness — 'wanted N days ago · expires in M days'", () => {
  const now = NOW;

  it("matches the spec example exactly", () => {
    const f = wantedFreshness(iso(-5 * DAY), iso(25 * DAY), now);
    expect(f.text).toBe("wanted 5 days ago \u00b7 expires in 25 days");
    expect(f.expiringSoon).toBe(false);
    expect(f.expired).toBe(false);
    expect(f.daysLeft).toBe(25);
  });

  it("flags the final-week expiring emphasis", () => {
    const f = wantedFreshness(iso(-23 * DAY), iso(6 * DAY), now);
    expect(f.expiringSoon).toBe(true);
    expect(f.text).toBe("wanted 23 days ago \u00b7 expires in 6 days \u2014 expiring soon");
  });

  it("reports expiry past the deadline", () => {
    const f = wantedFreshness(iso(-40 * DAY), iso(-1 * DAY), now);
    expect(f.expired).toBe(true);
    expect(f.daysLeft).toBe(0);
    expect(f.text).toBe("wanted 40 days ago \u00b7 expired");
  });
});

describe("renewableNow — final week of active, or 30-day grace after expiry (§3.2)", () => {
  const now = NOW;

  it("rejects renewal mid-life (no free bumping)", () => {
    expect(renewableNow(iso(25 * DAY), now)).toBe(false);
  });

  it("allows renewal in the final 7 days", () => {
    expect(renewableNow(iso(7 * DAY), now)).toBe(true);
    expect(renewableNow(iso(1 * DAY), now)).toBe(true);
  });

  it("allows renewal within the 30-day grace after expiry, never after", () => {
    expect(renewableNow(iso(-10 * DAY), now)).toBe(true);
    expect(renewableNow(iso(-30 * DAY - 1), now)).toBe(false);
  });
});

describe.skipIf(!available)("board seam reads real data (THI-440 PR 4)", () => {
  let client: pg.Client;
  const buyerIds: string[] = [];

  async function seedBuyer(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`feed-fixture-${nonce}`, `feed-${tag}`, `feed-${tag}-${nonce}@t.dev`],
    );
    buyerIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    await client.query(`DELETE FROM wanted_buyer_quota WHERE buyer_id = ANY($1::uuid[])`, [buyerIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [buyerIds]);
    await client.end();
  });

  it("wantedBoard returns seeded wanteds, filters, and hides ended rows", async () => {
    const buyer = await seedBuyer("board");
    const a = await createWanted(buyer, { title: "Seam probe sneaker wanted", category: "sneakers", condition: "good" });
    await new Promise((r) => setTimeout(r, 15));
    const b = await createWanted(buyer, { title: "Seam probe lamp wanted", category: "home" });
    const board = await wantedBoard({ limit: 50 });
    const ids = board.map((w) => w.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // ISO-string view-model contract.
    expect(board[0].created_at).toEqual(new Date(board[0].created_at).toISOString());
    // Filter passthrough (searchWanted predicate parity).
    expect((await wantedBoard({ category: "sneakers", limit: 50 })).map((w) => w.id)).toEqual([a.id]);
    // Ended rows never render, even before the sweep runs (lazy guard).
    await client.query(`UPDATE wanted_items SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    expect((await wantedBoard({ limit: 50 })).map((w) => w.id)).not.toContain(b.id);
    expect(await getWanted(b.id)).toBeNull();
    // Unknown ids are null (no existence oracle).
    expect(await getWanted("99999999-9999-4999-8999-999999999999")).toBeNull();
    // Visible single read works.
    expect((await getWanted(a.id))?.id).toBe(a.id);
  });

  it("wantedDemandByCategory aggregates active demand per category", async () => {
    const buyer = await seedBuyer("demand");
    await createWanted(buyer, { title: "Demand probe thing one", category: "toys" });
    await createWanted(buyer, { title: "Demand probe thing two", category: "toys" });
    const demand = await wantedDemandByCategory();
    const toys = demand.find((d) => d.category === "toys");
    expect(toys).toBeDefined();
    expect(toys!.count).toBeGreaterThanOrEqual(2);
    expect(toys!.example_title.length).toBeGreaterThan(0);
    // Sorted by count desc.
    for (let i = 1; i < demand.length; i++) {
      expect(demand[i - 1].count).toBeGreaterThanOrEqual(demand[i].count);
    }
  });
});
