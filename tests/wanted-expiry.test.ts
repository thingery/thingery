// Wanted sweeps (spec THI-439 rev 1 §3.2/§3.3 — B1, PR 4): the expiry sweep
// flips past-due actives to expired (boot + hourly), the retention rule
// purges expired rows older than 180 days (responses cascade), and both are
// idempotent on re-run. DB-backed (skips without a reachable Postgres);
// expires_at is forced via direct UPDATE to avoid waiting 30 days.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createWanted } from "../src/wanted.js";
import { expirePastDueWanted, purgeExpiredWantedRetention } from "../src/wanted-sweep.js";

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

describe.skipIf(!available)("wanted sweeps (DB)", () => {
  let client: pg.Client;
  const buyerIds: string[] = [];

  async function seedBuyer(tag: string): Promise<string> {
    const nonce = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`sweep-fixture-${nonce}`, `sweep-${tag}`, `sweep-${tag}-${nonce}@t.dev`],
    );
    buyerIds.push(rows[0].id);
    return rows[0].id;
  }

  const statusOf = async (id: string): Promise<string> => {
    const { rows } = await client.query<{ status: string }>(`SELECT status FROM wanted_items WHERE id = $1`, [id]);
    return rows[0].status;
  };

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

  it("expiry sweep flips past-due actives to expired, leaves healthy ones alone", async () => {
    const buyer = await seedBuyer("exp");
    const due = await createWanted(buyer, { title: "Sweep probe overdue wanted" });
    const healthy = await createWanted(buyer, { title: "Sweep probe healthy wanted" });
    // Force the state machine's sweep edge without waiting: expires_at past.
    await client.query(`UPDATE wanted_items SET expires_at = now() - interval '1 minute' WHERE id = $1`, [due.id]);

    const flipped = await expirePastDueWanted();
    expect(flipped).toBeGreaterThanOrEqual(1);
    expect(await statusOf(due.id)).toBe("expired");
    expect(await statusOf(healthy.id)).toBe("active");

    // Idempotent: a re-run finds nothing to flip.
    expect(await expirePastDueWanted()).toBe(0);
    expect(await statusOf(due.id)).toBe("expired");
    expect(await statusOf(healthy.id)).toBe("active");
  });

  it("retention sweep purges expired rows past 180 days, cascading responses; fresher ones stay", async () => {
    const buyer = await seedBuyer("ret");
    const seller = await seedBuyer("ret-s");
    const old = await createWanted(buyer, { title: "Sweep probe ancient wanted" });
    const recent = await createWanted(buyer, { title: "Sweep probe recent wanted" });
    // End both, age one past the retention horizon.
    await client.query(`UPDATE wanted_items SET status = 'expired' WHERE id IN ($1, $2)`, [old.id, recent.id]);
    await client.query(
      `UPDATE wanted_items SET expires_at = now() - interval '181 days' WHERE id = $1`,
      [old.id],
    );
    await client.query(
      `UPDATE wanted_items SET expires_at = now() - interval '5 days' WHERE id = $1`,
      [recent.id],
    );
    // A response row hanging off the ancient one must cascade away.
    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, description, category, condition, price_cents, currency, shipping_tier)
       VALUES ($1, 'Sweep cascade listing', '', 'other', 'good', 1000, 'EUR', 'unknown') RETURNING id`,
      [seller],
    );
    await client.query(
      `INSERT INTO wanted_responses (wanted_item_id, item_id, seller_id, published_at)
       VALUES ($1, $2, $3, now())`,
      [old.id, itemRows[0].id, seller],
    );

    const purged = await purgeExpiredWantedRetention();
    expect(purged).toBeGreaterThanOrEqual(1);
    const gone = await client.query(`SELECT 1 FROM wanted_items WHERE id = $1`, [old.id]);
    expect(gone.rowCount).toBe(0);
    const cascaded = await client.query(`SELECT 1 FROM wanted_responses WHERE wanted_item_id = $1`, [old.id]);
    expect(cascaded.rowCount).toBe(0);
    expect(await statusOf(recent.id)).toBe("expired"); // within horizon: kept

    // Idempotent.
    expect(await purgeExpiredWantedRetention()).toBe(0);
  });
});

// runWantedSweeps' failure isolation (a failing rule does not stop the
// other) is covered by construction — two independent try/catch blocks, the
// oauth-sweep convention; forcing pool failures here would only re-test
// vitest mocks.
describe("wanted sweeps export shape", () => {
  it("exposes boot-run and timer entry points (index.ts wiring)", async () => {
    const mod = await import("../src/wanted-sweep.js");
    expect(typeof mod.runWantedSweeps).toBe("function");
    expect(typeof mod.startWantedSweepTimer).toBe("function");
    expect(typeof mod.expirePastDueWanted).toBe("function");
    expect(typeof mod.purgeExpiredWantedRetention).toBe("function");
  });
});
