// Wanted search (spec THI-439 rev 1 §3.4) — src/wanted.ts searchWanted:
// the lazy visibility guard (expired rows never return, even before the
// sweep runs), hybrid parity with searchItems (cosine + keyword legs, and
// keyword-only fallback when embeddings are unconfigured), the N2 shape
// (q with embedding vs wanted without → keyword leg only), filters
// (category/condition/currency/budget_max_cents_gte incl. open budgets),
// and pagination. DB-backed; skips without a reachable Postgres.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as embed from "../src/embed.js";
import {
  createWanted,
  searchWanted,
  type CreateWantedInput,
} from "../src/wanted.js";

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

/** A fixed 1536-dim vector for embedText mocking (pgvector vector(1536)). */
function fakeVector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => ((i * 7 + seed * 13) % 11) / 110 - 0.05);
}

describe.skipIf(!available)("wanted search (DB)", () => {
  let client: pg.Client;
  const buyerIds: string[] = [];

  async function seedBuyer(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`wanted-search-fixture-${nonce}`, `wsearch-${tag}`, `wsearch-${tag}-${nonce}@t.dev`],
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lazy visibility guard: expired status or past expires_at never returns, even before the sweep", async () => {
    const buyer = await seedBuyer("vis");
    const a = await createWanted(buyer, { title: "Standing desk wanted" });
    const b = await createWanted(buyer, { title: "Ergonomic chair wanted" });
    const c = await createWanted(buyer, { title: "Monitor arm wanted" });
    // a: status flipped expired via direct UPDATE (simulates the sweep).
    // b: status still active but expires_at in the past (sweep lag).
    // c: healthy control.
    await client.query(`UPDATE wanted_items SET status = 'expired' WHERE id = $1`, [a.id]);
    await client.query(`UPDATE wanted_items SET expires_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);

    const results = await searchWanted({ q: "wanted", limit: 50 });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("keyword fallback (embeddings unconfigured): ILIKE on title and notes", async () => {
    const buyer = await seedBuyer("kw");
    const hit = await createWanted(buyer, {
      title: "Nintendo Switch OLED",
      notes: "white joycons, handheld mostly",
    });
    const noteHit = await createWanted(buyer, { title: "Anything retro", notes: "gameboy color, teal preferred" });
    await createWanted(buyer, { title: "Coffee grinder", notes: "hand-cranked burr" });

    const byTitle = await searchWanted({ q: "switch" });
    expect(byTitle.map((r) => r.id)).toEqual([hit.id]);
    const byNotes = await searchWanted({ q: "gameboy" });
    expect(byNotes.map((r) => r.id)).toEqual([noteHit.id]);
    const none = await searchWanted({ q: "xylophone" });
    expect(none).toHaveLength(0);
  });

  it("ILIKE metacharacters in q are escaped (no wildcard injection, no errors)", async () => {
    const buyer = await seedBuyer("esc");
    await createWanted(buyer, { title: "100% wool sweater wanted" });
    const results = await searchWanted({ q: "100%wool%" });
    expect(results).toHaveLength(0); // literal match fails, does not match everything
    const underscore = await searchWanted({ q: "swe_ter" });
    expect(underscore).toHaveLength(0);
  });
  it("hybrid: embedding-bearing wanteds match by cosine or keyword; keyword leg saves the mismatched-vector case", async () => {
    const buyer = await seedBuyer("hyb");
    // Vector 1 indexes the wanted; vector 2 (orthogonal-ish) is the query.
    const embedSpy = vi.spyOn(embed, "embedText").mockResolvedValue(fakeVector(1));
    const semantic = await createWanted(buyer, { title: "ZZQ quixotic blorptone", notes: "zzq filler notes" });
    embedSpy.mockResolvedValue(fakeVector(1) as never); // create indexes with vector 1
    const keywordOnly = await createWanted(buyer, { title: "Special edition console", notes: "with box" });
    expect(semantic.embedding).not.toBeNull();
    expect(keywordOnly.embedding).not.toBeNull();
    embedSpy.mockRestore();

    // Both wanteds have embeddings; q textually matches the second — the
    // keyword leg returns it even though cosine to vector 2 is below floor.
    const embedSpy2 = vi.spyOn(embed, "embedText").mockResolvedValue(fakeVector(2));
    const results = await searchWanted({ q: "special edition console" });
    expect(results.map((r) => r.id)).toContain(keywordOnly.id);
    // Cosine leg in isolation: query text does NOT ILIKE-match anything, but
    // its embedding (vector 1) equals the indexed one → cosine 1 > 0.15.
    embedSpy2.mockResolvedValue(fakeVector(1) as never);
    const cosine = await searchWanted({ q: "totally unrelated query wording" });
    expect(cosine.map((r) => r.id)).toContain(semantic.id);
    expect(cosine.find((r) => r.id === semantic.id)?.score).toBeGreaterThan(0.15);
    embedSpy2.mockRestore();
  });

  it("N2 shape: q with an embedding vs wanted without one → keyword leg only", async () => {
    const buyer = await seedBuyer("n2");
    // Create with embeddings "unconfigured" (null) — no spy, env deleted.
    const noVector = await createWanted(buyer, { title: "Unindexed leather jacket" });
    expect(noVector.embedding).toBeNull();

    const embedSpy = vi.spyOn(embed, "embedText").mockResolvedValue(fakeVector(3));
    const results = await searchWanted({ q: "leather jacket" });
    expect(results.map((r) => r.id)).toEqual([noVector.id]); // keyword leg
    embedSpy.mockRestore();
  });

  it("filters: category, condition (exact), currency, budget_max_cents_gte (open budgets match)", async () => {
    const buyer = await seedBuyer("fil");
    const shoes = await createWanted(buyer, { title: "Running shoes any brand", category: "shoes", condition: "good" });
    const open = await createWanted(buyer, { title: "Any smartphone works", category: "phones", budget_max_cents: null });
    const capped = await createWanted(buyer, { title: "Cheap mechanical keyboard", category: "computers", budget_max_cents: 8000 });
    const anyCond = await createWanted(buyer, { title: "Vintage camera", category: "collectibles" });

    expect((await searchWanted({ category: "shoes" })).map((r) => r.id)).toEqual([shoes.id]);
    // Condition filter is exact: 'good' wanted does not match 'like_new';
    // NULL condition (any) does not match a condition filter either.
    expect((await searchWanted({ condition: "good" })).map((r) => r.id)).toEqual([shoes.id]);
    expect((await searchWanted({ condition: "like_new" })).map((r) => r.id)).toEqual([]);
    expect((await searchWanted({ category: "collectibles", condition: "good" })).map((r) => r.id)).toEqual([]);
    expect(anyCond.condition).toBeNull();

    // budget_max_cents_gte: "wants at least my price" — open budgets (NULL
    // max) always match. Subset assertions: the shared DB may hold other
    // buyers' open-budget rows, so assert membership, not the whole page.
    const withGte = async (x: number) =>
      (await searchWanted({ budget_max_cents_gte: x, limit: 50 })).map((r) => r.id);
    for (const x of [5000, 9000, 100000]) {
      const got = await withGte(x);
      expect(got).toContain(open.id);   // open budget matches any price
      expect(got).toContain(anyCond.id);
      expect(got).toContain(shoes.id);
    }
    expect(await withGte(5000)).toContain(capped.id);      // 8000 >= 5000
    expect(await withGte(9000)).not.toContain(capped.id);  // 8000 < 9000

    // Currency default EUR; a USD wanted is invisible to the EUR filter.
    const usd = await createWanted(buyer, { title: "American basketball card", currency: "USD" });
    expect((await searchWanted({ currency: "EUR", limit: 50 })).map((r) => r.id)).not.toContain(usd.id);
    expect((await searchWanted({ currency: "usd" })).map((r) => r.id)).toEqual([usd.id]);
  });

  it("pagination: limit and offset, newest-first without q", async () => {
    const buyer = await seedBuyer("page");
    for (let i = 0; i < 3; i++) {
      await createWanted(buyer, { title: `Pagination wanted item ${i}` });
      await new Promise((r) => setTimeout(r, 15)); // distinct created_at
    }
    const page1 = await searchWanted({ q: "pagination", limit: 2 });
    expect(page1).toHaveLength(2);
    const rest = await searchWanted({ q: "pagination", limit: 2, offset: 2 });
    expect(rest).toHaveLength(1);
    const all = await searchWanted({ q: "pagination", limit: 50 });
    expect(all.map((r) => r.id)).toEqual([...page1.map((r) => r.id), ...rest.map((r) => r.id)]);
    // Newest first (created_at DESC).
    expect(all[0].created_at.getTime()).toBeGreaterThanOrEqual(all[1].created_at.getTime());
  });
});
