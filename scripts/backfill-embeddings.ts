// THI-466: idempotent embedding backfill for rows written while the embedding
// path was inactive (embedding IS NULL). Covers items, buyer_intents, and
// wanted_items — the three vector(1536) columns in db/schema.sql.
//
// Reuses the exact write-path text builders (itemEmbeddingText /
// wantedEmbeddingText / raw intent q) so backfilled vectors are comparable
// with vectors written live from now on.
//
// Usage: EMBED_API_KEY=… npm run backfill:embeddings [-- --dry-run]
// Exits 1 if EMBED_API_KEY is unset — a silent no-op backfill is worse than
// a loud failure (the runbook step must not claim success without evidence).

import { pool } from "../src/db.js";
import { embedText, itemEmbeddingText, EXPECTED_EMBEDDING_DIMS } from "../src/embed.js";
import { wantedEmbeddingText } from "../src/wanted.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 150; // stay polite to the embeddings API on tiny VPS runs

if (!process.env.EMBED_API_KEY) {
  console.error(
    "EMBED_API_KEY is not set — the embeddings path is unconfigured; nothing to backfill with. Aborting.",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Counters {
  scanned: number;
  embedded: number;
  apiNull: number; // embedText returned null (API error / dims guard / empty text)
}

async function backfill(
  label: string,
  select: { sql: string },
  textForRow: (row: Record<string, unknown>) => string | null,
  update: { sql: string },
): Promise<Counters> {
  const { rows } = await pool.query<Record<string, unknown>>(select.sql);
  const counters: Counters = { scanned: rows.length, embedded: 0, apiNull: 0 };
  console.log(`[${label}] ${rows.length} row(s) with embedding IS NULL`);
  if (DRY_RUN) return counters;

  for (const row of rows) {
    const text = textForRow(row);
    const embedding = text ? await embedText(text) : null;
    if (!embedding) {
      counters.apiNull++;
      continue;
    }
    await pool.query(update.sql, [row.id, JSON.stringify(embedding)]);
    counters.embedded++;
    await sleep(DELAY_MS);
  }
  console.log(
    `[${label}] embedded ${counters.embedded}, skipped (null embedding) ${counters.apiNull}`,
  );
  return counters;
}

const items = await backfill(
  "items",
  {
    sql: `SELECT id, title, description, category, condition, brand, attributes
          FROM items WHERE embedding IS NULL ORDER BY created_at`,
  },
  (row) =>
    itemEmbeddingText({
      title: String(row.title),
      description: String(row.description ?? ""),
      category: String(row.category ?? ""),
      condition: String(row.condition ?? ""),
      brand: row.brand ? String(row.brand) : null,
      attributes: (row.attributes as Record<string, string | number | boolean>) ?? undefined,
    }),
  { sql: `UPDATE items SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL` },
);

const intents = await backfill(
  "buyer_intents",
  { sql: `SELECT id, q FROM buyer_intents WHERE embedding IS NULL AND q IS NOT NULL ORDER BY created_at` },
  (row) => (row.q ? String(row.q) : null),
  { sql: `UPDATE buyer_intents SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL` },
);

const wanted = await backfill(
  "wanted_items",
  {
    sql: `SELECT id, title, notes, category, condition
          FROM wanted_items WHERE embedding IS NULL ORDER BY created_at`,
  },
  (row) =>
    wantedEmbeddingText({
      title: String(row.title),
      notes: String(row.notes ?? ""),
      category: String(row.category ?? ""),
      condition: row.condition ? String(row.condition) : null,
    }),
  { sql: `UPDATE wanted_items SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL` },
);

const totals = [items, intents, wanted].reduce(
  (acc, c) => ({
    scanned: acc.scanned + c.scanned,
    embedded: acc.embedded + c.embedded,
    apiNull: acc.apiNull + c.apiNull,
  }),
  { scanned: 0, embedded: 0, apiNull: 0 },
);
console.log(
  `${DRY_RUN ? "[dry-run] " : ""}backfill complete: scanned ${totals.scanned}, embedded ${totals.embedded}, skipped ${totals.apiNull} (expected ${EXPECTED_EMBEDDING_DIMS}-dim vectors only)`,
);
await pool.end();
