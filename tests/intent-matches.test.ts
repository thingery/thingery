// Buyer alerts PR 3 (spec THI-360 rev 2 §3.2/§3.4, THI-380 riders) —
// evaluateListingForIntents: exact-match fan-out semantics. DB-backed (skips
// when no Postgres is reachable). Like tests/intents.test.ts it never
// TRUNCATEs — it seeds uniquely-emailed sellers and cleans up just those
// rows, matches first (their item FK has no ON DELETE action). Every test
// uses its own q/category so sibling tests' intents cannot interfere.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { pool, type ItemRow } from "../src/db.js";
import {
  evaluateListingForIntents,
  MAX_MATCHES_PER_LISTING,
  MAX_NEW_MATCHES_PER_BUYER_PER_DAY,
} from "../src/intents.js";

// Keyword-leg testing: no embeddings API in CI — items and seeded intents get
// NULL embeddings unless a test sets the column directly.
delete process.env.EMBED_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// Two distinct embedding directions: an all-0.1 vector and a unit basis
// vector. Cosine between them is ~0.026 — far under the 0.15 floor — so the
// N2 test's intents can never cosine-match the cosine test's items (and vice
// versa) even though both tests seed embeddings.
const V_FILL = JSON.stringify(Array<number>(1536).fill(0.1));
const V_BASIS = JSON.stringify([1, ...Array<number>(1535).fill(0)]);

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

describe.skipIf(!available)("evaluateListingForIntents (DB)", () => {
  let client: pg.Client;
  const sellerIds: string[] = [];

  async function seedSeller(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      // Plain hash fixture — never a thg_ live-key shape (gitleaks rule).
      [`matches-fixture-${nonce}`, `matches-${tag}`, `matches-${tag}-${nonce}@t.dev`],
    );
    sellerIds.push(rows[0].id);
    return rows[0].id;
  }

  interface SeedIntent {
    buyer: string;
    q?: string | null;
    category?: string | null;
    muted?: boolean;
    embedding?: string | null; // vector as JSON text, as pg receives it
  }

  async function seedIntent(s: SeedIntent): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO buyer_intents (buyer_id, q, category, muted, embedding)
       VALUES ($1, $2, $3, $4, $5::vector) RETURNING id`,
      [s.buyer, s.q ?? null, s.category ?? null, s.muted ?? false, s.embedding ?? null],
    );
    return rows[0].id;
  }

  async function seedItem(
    seller: string,
    item: { title: string; category?: string; price_cents?: number; embedding?: string | null },
  ): Promise<ItemRow> {
    const { rows } = await client.query<ItemRow>(
      `INSERT INTO items (seller_id, title, description, category, price_cents, images, embedding)
       VALUES ($1, $2, 'seed description', $3, $4, ARRAY['/img/items/seed.png'], $5::vector)
       RETURNING *`,
      [seller, item.title, item.category ?? "bikes", item.price_cents ?? 20000, item.embedding ?? null],
    );
    return rows[0];
  }

  async function matchesForItem(itemId: string): Promise<{ intent_id: string; score: number }[]> {
    const { rows } = await client.query<{ intent_id: string; score: number }>(
      `SELECT intent_id, score FROM intent_matches WHERE item_id = $1`,
      [itemId],
    );
    return rows;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    // Matches first: their item_id FK would otherwise block the items cascade.
    await client.query(`DELETE FROM intent_matches WHERE buyer_id = ANY($1::uuid[])`, [sellerIds]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [sellerIds]);
    await client.end();
  });

  it("one match per matching intent; re-run is idempotent (ON CONFLICT)", async () => {
    const phrase = "steel frame classic";
    const buyer = await seedSeller("main-b");
    const seller = await seedSeller("main-s");
    const intent = await seedIntent({ buyer, q: `${phrase} bike` });
    const item = await seedItem(seller, { title: `${phrase} bike, serviced` });
    expect(await evaluateListingForIntents(item)).toBe(1);
    const first = await matchesForItem(item.id);
    expect(first.map((m) => m.intent_id)).toEqual([intent]);
    expect(first[0].score).toBe(0); // keyword leg → score 0 by spec
    expect(await evaluateListingForIntents(item)).toBe(0); // replay-safe
    expect((await matchesForItem(item.id)).length).toBe(1);
  });

  it("seller's own intent and muted intents never match", async () => {
    const phrase = "own muted probe";
    const seller = await seedSeller("own-s");
    const buyer = await seedSeller("own-b");
    await seedIntent({ buyer: seller, q: `${phrase} bike` }); // own listing
    await seedIntent({ buyer, q: `${phrase} bike`, muted: true });
    const item = await seedItem(seller, { title: `${phrase} bike` });
    expect(await evaluateListingForIntents(item)).toBe(0);
    expect(await matchesForItem(item.id)).toEqual([]);
  });

  it("filter-only intent matches on filters (q NULL leg)", async () => {
    const cat = "filterbikes";
    const buyer = await seedSeller("filter-b");
    const seller = await seedSeller("filter-s");
    const intent = await seedIntent({ buyer, category: cat });
    await seedIntent({ buyer, category: `${cat}-other` }); // non-matching filter
    const item = await seedItem(seller, { title: "Anything at all", category: cat });
    expect(await evaluateListingForIntents(item)).toBe(1);
    expect((await matchesForItem(item.id)).map((m) => m.intent_id)).toEqual([intent]);
  });

  it("non-matching q never matches", async () => {
    const buyer = await seedSeller("q-b");
    await seedIntent({ buyer, q: "unobtainium widget" });
    const item = await seedItem(await seedSeller("q-s"), { title: "Just a plain bicycle" });
    expect(await evaluateListingForIntents(item)).toBe(0);
  });

  it("q with ILIKE wildcards is escaped in-SQL, not treated as a pattern (N4)", async () => {
    const phrase = "100% vintage_ bike";
    const buyer = await seedSeller("esc-b");
    await seedIntent({ buyer, q: phrase }); // literal % and _
    const seller = await seedSeller("esc-s");
    const hit = await seedItem(seller, { title: `${phrase}, literally` });
    const miss = await seedItem(seller, { title: "100 percent vintageX bike" });
    expect(await evaluateListingForIntents(hit)).toBe(1); // literal match
    expect(await evaluateListingForIntents(miss)).toBe(0); // not a wildcard
  });

  it("N2 parity: embedding-bearing intent + item without embedding → no match", async () => {
    const phrase = "parity probe";
    const buyer = await seedSeller("n2-b");
    await seedIntent({ buyer, q: `${phrase} bike`, embedding: V_FILL });
    // Title would ILIKE-match, but the parity gate requires the item's
    // embedding before that leg counts — under-notifies, never over-notifies.
    const item = await seedItem(await seedSeller("n2-s"), { title: `${phrase} bike` });
    expect(await evaluateListingForIntents(item)).toBe(0);
  });

  it("cosine leg: parallel embeddings match past the 0.15 floor with similarity score", async () => {
    const buyer = await seedSeller("cos-b");
    await seedIntent({ buyer, q: "zzz no text overlap at all", embedding: V_BASIS });
    const item = await seedItem(await seedSeller("cos-s"), {
      title: "Something else entirely",
      embedding: V_BASIS, // identical direction → cosine 1.0 > 0.15
    });
    expect(await evaluateListingForIntents(item)).toBe(1);
    expect((await matchesForItem(item.id))[0].score).toBeGreaterThan(0.9);
  });

  it(`a buyer at ${MAX_NEW_MATCHES_PER_BUYER_PER_DAY} matches in 24h is skipped (11th never sent)`, async () => {
    const cat = "capbikes";
    const buyer = await seedSeller("cap-b");
    const fillerSeller = await seedSeller("cap-fs");
    const intent = await seedIntent({ buyer, category: cat });
    // Ten matches in the last 24h (created_at defaults to now()).
    for (let i = 0; i < MAX_NEW_MATCHES_PER_BUYER_PER_DAY; i++) {
      const { rows: filler } = await client.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, category, price_cents) VALUES ($1, $2, $3, 100) RETURNING id`,
        [fillerSeller, `cap filler ${i}`, cat],
      );
      await client.query(
        `INSERT INTO intent_matches (intent_id, buyer_id, item_id, score) VALUES ($1, $2, $3, 0)`,
        [intent, buyer, filler[0].id],
      );
    }
    const item = await seedItem(await seedSeller("cap-s"), { title: "Fresh bicycle", category: cat });
    expect(await evaluateListingForIntents(item)).toBe(0);
    expect(await matchesForItem(item.id)).toEqual([]);
  });

  it(`caps fan-out at ${MAX_MATCHES_PER_LISTING} matching intents`, async () => {
    const cat = "fanbikes";
    const seller = await seedSeller("fan-s");
    const item = await seedItem(seller, { title: "Fan-out probe", category: cat });
    // MAX + 1 distinct buyers, one filter-only matching intent each — every
    // intent matches; the statement keeps the first MAX by score.
    for (let i = 0; i <= MAX_MATCHES_PER_LISTING; i++) {
      const buyer = await seedSeller(`fan-b${i}`);
      await seedIntent({ buyer, category: cat });
    }
    expect(await evaluateListingForIntents(item)).toBe(MAX_MATCHES_PER_LISTING);
    expect((await matchesForItem(item.id)).length).toBe(MAX_MATCHES_PER_LISTING);
  });
});
