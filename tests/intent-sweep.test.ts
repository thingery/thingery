// Intent retention sweeps (spec THI-360 rev 2 §3.4): each rule deletes only
// what is past its window and keeps everything still live. Requires
// Postgres. Mirrors tests/oauth-sweep.test.ts; never TRUNCATEs — uniquely
// tagged fixtures, explicit cleanup.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { runIntentSweeps } from "../src/intent-sweep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { await client.end().catch(() => {}); return false; }
}

const available = await dbAvailable();

describe.skipIf(!available)("intent retention sweeps (THI-360 §3.4)", () => {
  let client: pg.Client;
  let buyerId: string;
  let sellerId: string;
  let itemA: string;
  let itemB: string;
  const intentIds: string[] = [];
  const ago = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));

    const nonce = randomUUID();
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`isweep-fixture-${nonce}`, "Intent Sweep Tester", `isweep-${nonce}@t.dev`],
    );
    sellerId = seller.rows[0].id;
    const buyer = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`isweep-fixture-b-${nonce}`, "Intent Sweep Buyer", `isweep-b-${nonce}@t.dev`],
    );
    buyerId = buyer.rows[0].id;

    for (const n of [1, 2, 3, 4]) {
      const item = await client.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, category, price_cents, images)
         VALUES ($1, $2, 'other', 1000, ARRAY['/img/items/seed.png']) RETURNING id`,
        [sellerId, `sweep probe item ${n}`],
      );
      if (n === 1) itemA = item.rows[0].id;
      if (n === 2) itemB = item.rows[0].id;
    }
    for (const n of [1, 2, 3, 4]) {
      const intent = await client.query<{ id: string }>(
        `INSERT INTO buyer_intents (buyer_id, q) VALUES ($1, $2) RETURNING id`,
        [buyerId, `sweep probe intent ${n}`],
      );
      intentIds.push(intent.rows[0].id);
    }
  });

  afterAll(async () => {
    await client.query(`DELETE FROM intent_matches WHERE buyer_id = $1`, [buyerId]);
    await client.query(`DELETE FROM buyer_intents WHERE buyer_id = $1`, [buyerId]);
    await client.query(`DELETE FROM sellers WHERE id = ANY($1::uuid[])`, [[buyerId, sellerId]]);
    await client.end();
  });

  it("deletes only what is due: read > 30 d and any > 180 d; the rest survive", async () => {
    const seed = async (
      intent: string, item: string, read: Date | null, created: Date,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO intent_matches (intent_id, buyer_id, item_id, score, read_at, created_at)
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [intent, buyerId, item, read, created],
      );
    };
    await seed(intentIds[0], itemA, ago(31), ago(31)); // stale-read → swept (rule 1)
    await seed(intentIds[1], itemA, ago(5), ago(5)); // fresh-read → kept
    await seed(intentIds[2], itemB, null, ago(181)); // unread-but-ancient → swept (rule 2)
    await seed(intentIds[3], itemB, null, ago(40)); // unread, inside window → kept

    await runIntentSweeps();

    const { rows } = await client.query<{ intent_id: string }>(
      `SELECT intent_id FROM intent_matches WHERE buyer_id = $1 ORDER BY intent_id`,
      [buyerId],
    );
    expect(rows.map((r) => r.intent_id).sort()).toEqual([intentIds[1], intentIds[3]].sort());

    // Idempotent: a second run sweeps nothing more.
    await runIntentSweeps();
    const again = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM intent_matches WHERE buyer_id = $1`,
      [buyerId],
    );
    expect(Number(again.rows[0].count)).toBe(2);
  });
});
