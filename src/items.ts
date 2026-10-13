import { pool, type ItemRow } from "./db.js";
import { embedText, itemEmbeddingText } from "./embed.js";
import { attributeFilterClause, type Attributes, type CategoryRow } from "./attributes.js";

export interface CreateItemInput {
  seller_id: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  brand?: string | null;
  price_cents: number;
  currency: string;
  location?: string | null;
  weight_grams?: number | null;
  dimensions_mm?: string | null;
  shipping_tier: string;
  images: string[];
  attributes?: Attributes;
}

export async function createItem(input: CreateItemInput): Promise<ItemRow> {
  const embedding = await embedText(
    itemEmbeddingText({
      title: input.title,
      description: input.description,
      category: input.category,
      condition: input.condition,
      brand: input.brand,
      attributes: input.attributes,
    }),
  );

  const { rows } = await pool.query<ItemRow>(
    `INSERT INTO items (
       seller_id, title, description, category, condition, brand,
       price_cents, currency, location, weight_grams, dimensions_mm,
       shipping_tier, images, attributes, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::vector)
     RETURNING *`,
    [
      input.seller_id,
      input.title,
      input.description,
      input.category,
      input.condition,
      input.brand ?? null,
      input.price_cents,
      input.currency,
      input.location ?? null,
      input.weight_grams ?? null,
      input.dimensions_mm ?? null,
      input.shipping_tier,
      input.images,
      JSON.stringify(input.attributes ?? {}),
      embedding ? JSON.stringify(embedding) : null,
    ],
  );
  return rows[0];
}

export async function getCategory(name: string): Promise<CategoryRow | null> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT name, description, attribute_definitions FROM categories WHERE name = $1`,
    [name.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function listCategories(): Promise<Array<Pick<CategoryRow, "name" | "description"> & { listing_count: number }>> {
  const { rows } = await pool.query(
    `SELECT c.name, c.description, COUNT(i.id)::int AS listing_count
     FROM categories c
     LEFT JOIN items i ON i.category = c.name AND i.status = 'active'
     GROUP BY c.name, c.description
     ORDER BY listing_count DESC, c.name ASC`,
  );
  return rows;
}

export interface SearchFilters {
  q?: string;
  category?: string;
  condition?: string;
  min_price_cents?: number;
  max_price_cents?: number;
  currency?: string;
  shipping_tier?: string;
  attributes?: Attributes;
  limit: number;
  /** Rows to skip, for offset pagination (1-based pages in callers). Defaults to 0. */
  offset?: number;
}

/**
 * Hybrid search: hard filters (status/price/category/attributes...) always apply.
 * With embeddings configured, results are ranked by cosine similarity;
 * otherwise it falls back to keyword ILIKE on title and description.
 */
export async function searchItems(filters: SearchFilters): Promise<Array<ItemRow & { score: number }>> {
  const where: string[] = [`i.status = 'active'`];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.category) where.push(`i.category = ${add(filters.category.toLowerCase())}`);
  if (filters.condition) where.push(`i.condition = ${add(filters.condition)}`);
  if (filters.shipping_tier) where.push(`i.shipping_tier = ${add(filters.shipping_tier)}`);
  if (filters.currency) where.push(`i.currency = ${add(filters.currency)}`);
  if (filters.min_price_cents !== undefined) where.push(`i.price_cents >= ${add(filters.min_price_cents)}`);
  if (filters.max_price_cents !== undefined) where.push(`i.price_cents <= ${add(filters.max_price_cents)}`);
  if (filters.attributes && Object.keys(filters.attributes).length > 0) {
    where.push(attributeFilterClause(filters.attributes, add));
  }

  const q = filters.q?.trim();
  const limit = Math.min(Math.max(filters.limit, 1), 50);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);

  if (q) {
    const embedding = await embedText(q);
    if (embedding) {
      const vecParam = add(JSON.stringify(embedding));
      const keywordParam = add(`%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      const { rows } = await pool.query<ItemRow & { score: number }>(
        `SELECT i.*, 1 - (i.embedding <=> ${vecParam}::vector) AS score
         FROM items i
         WHERE ${where.join(" AND ")}
           AND i.embedding IS NOT NULL
           AND (i.title ILIKE ${keywordParam} OR i.description ILIKE ${keywordParam}
                OR 1 - (i.embedding <=> ${vecParam}::vector) > 0.15)
         ORDER BY i.embedding <=> ${vecParam}::vector
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        params,
      );
      return rows;
    }
    // Keyword-only fallback
    const keywordParam = add(`%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
    const { rows } = await pool.query<ItemRow & { score: number }>(
      `SELECT i.*, 0 AS score
       FROM items i
       WHERE ${where.join(" AND ")}
         AND (i.title ILIKE ${keywordParam} OR i.description ILIKE ${keywordParam})
       ORDER BY i.created_at DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return rows;
  }

  const { rows } = await pool.query<ItemRow & { score: number }>(
    `SELECT i.*, 0 AS score
     FROM items i
     WHERE ${where.join(" AND ")}
     ORDER BY i.created_at DESC
     LIMIT ${add(limit)} OFFSET ${add(offset)}`,
    params,
  );
  return rows;
}

export async function getItem(id: string): Promise<ItemRow | null> {
  const { rows } = await pool.query<ItemRow>(`SELECT * FROM items WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function myItems(
  sellerId: string,
  status: string | undefined,
  limit: number,
): Promise<ItemRow[]> {
  const capped = Math.min(Math.max(limit, 1), 100);
  if (status) {
    const { rows } = await pool.query<ItemRow>(
      `SELECT * FROM items WHERE seller_id = $1 AND status = $2
       ORDER BY created_at DESC LIMIT $3`,
      [sellerId, status, capped],
    );
    return rows;
  }
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items WHERE seller_id = $1 AND status <> 'deleted'
     ORDER BY created_at DESC LIMIT $2`,
    [sellerId, capped],
  );
  return rows;
}

export interface ItemUpdate {
  status?: string;
  price_cents?: number;
  title?: string;
  description?: string;
  attributes?: Attributes;
}

export async function updateItem(
  id: string,
  sellerId: string,
  update: ItemUpdate,
): Promise<ItemRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (update.status !== undefined) sets.push(`status = ${add(update.status)}`);
  if (update.price_cents !== undefined) sets.push(`price_cents = ${add(update.price_cents)}`);
  if (update.title !== undefined) sets.push(`title = ${add(update.title)}`);
  if (update.description !== undefined) sets.push(`description = ${add(update.description)}`);
  // Attributes are replaced wholesale (not merged) — agents should read,
  // modify, write. Keeps the semantics predictable.
  if (update.attributes !== undefined) sets.push(`attributes = ${add(JSON.stringify(update.attributes))}::jsonb`);
  if (sets.length === 0) return getItem(id);

  params.push(id, sellerId);
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET ${sets.join(", ")}
     WHERE id = $${params.length - 1} AND seller_id = $${params.length}
     RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}
