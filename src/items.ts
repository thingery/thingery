import { pool, type ItemRow } from "./db.js";
import { embedText, itemEmbeddingText } from "./embed.js";
import { logSecurityEvent } from "./security-events.js";
import {
  attributeShapeErrors,
  AttributeValidationError,
  attributeFilterClause,
  UNDECLARED_KEY_PATTERN,
  type Attributes,
  type CategoryRow,
} from "./attributes.js";

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

// Per-seller listing velocity caps (docs/security.md §6 H4 fix 1, THI-113) —
// module constants, deliberately not env-configurable (same posture as the
// undeclared-key thresholds further down). Security owns the final numbers;
// changing them here is one place and the error message follows.
export const MAX_LISTING_CREATES_PER_SELLER_PER_DAY = 100;
export const MAX_ACTIVE_LISTINGS_PER_SELLER = 200;

/** Thrown by createItem when the seller is over either velocity cap. `code`
 *  is the MCP error code create_listing reports — `rate_limited`, the
 *  documented choice (THI-113): the rejection is quota-shaped, and agents
 *  already treat that code as back-off-and-retry-later. */
export class ListingLimitError extends Error {
  readonly code = "rate_limited";
  constructor() {
    super(
      `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
        `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`,
    );
    this.name = "ListingLimitError";
  }
}

/** THI-112: listing_write event action — a status update to 'deleted' is the
 * delete path (listings are never row-deleted); everything else is an update. */
function writeAction(status: string | undefined): "update" | "delete" {
  return status === "deleted" ? "delete" : "update";
}

export async function createItem(input: CreateItemInput): Promise<ItemRow> {
  // Caps run BEFORE the embeddings call: every create costs an embeddings-API
  // request (the cost-DoS in security doc §6 H4), so rejecting after embedding
  // would still pay the abuser's bill. One indexed COUNT round trip
  // (items_seller_idx) covers both caps. Check-then-insert is not atomic —
  // concurrent creates can overshoot by the width of the race; that is the
  // documented pragmatic-90% posture, not a strict quota.
  const { rows: capRows } = await pool.query<{ creates_24h: string; active: string }>(
    `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS creates_24h,
            COUNT(*) FILTER (WHERE status = 'active') AS active
     FROM items WHERE seller_id = $1`,
    [input.seller_id],
  );
  if (
    Number(capRows[0].creates_24h) >= MAX_LISTING_CREATES_PER_SELLER_PER_DAY ||
    Number(capRows[0].active) >= MAX_ACTIVE_LISTINGS_PER_SELLER
  ) {
    // THI-112 × THI-113 merge synthesis: the cap rejection is the create path's
    // "rejected" listing_write outcome (shape already in SecurityEvent; updateItem
    // logs its rejections the same way). Seller id only — no-payload rule, §6.
    logSecurityEvent({ type: "listing_write", action: "create", outcome: "rejected" }, { sellerId: input.seller_id });
    throw new ListingLimitError();
  }

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
  // THI-112 (H4.2): successful listing create — seller id only, never the
  // title/description (no-payload rule in docs/security.md §6).
  logSecurityEvent({ type: "listing_write", action: "create", outcome: "success" }, { sellerId: input.seller_id });
  return rows[0];
}

export async function getCategory(name: string): Promise<CategoryRow | null> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT name, description, attribute_definitions FROM categories WHERE name = $1`,
    [name.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** THI-308 (spec rev 2): derived feed-visibility predicate. An item is
 *  visible in feeds iff active AND (grandfathered OR has >= 1 photo).
 *  Defined once as a fragment so every feed surface (searchItems,
 *  listCategories counts, undeclaredKeyUsage) derives it identically —
 *  visibility is never stored per-transition, it is a pure function of
 *  items.status/photo_required/images. getItem/myItems stay unfiltered:
 *  direct URLs render pending items and owners see their own. */
const FEED_VISIBLE = `(NOT i.photo_required OR cardinality(i.images) > 0)`;

export async function listCategories(): Promise<Array<Pick<CategoryRow, "name" | "description"> & { listing_count: number }>> {
  const { rows } = await pool.query(
    `SELECT c.name, c.description, COUNT(i.id)::int AS listing_count
     FROM categories c
     LEFT JOIN items i ON i.category = c.name AND i.status = 'active' AND ${FEED_VISIBLE}
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
  // THI-308: searchItems is the single feed choke point (browse grid + MCP
  // search_items) — pending zero-photo items are excluded here.
  const where: string[] = [`i.status = 'active'`, FEED_VISIBLE];
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
        `SELECT i.*, 1 - (i.embedding <=> ${vecParam}::vector) AS score,
                (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready
         FROM items i LEFT JOIN sellers s ON s.id = i.seller_id
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
      `SELECT i.*, 0 AS score,
              (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready
       FROM items i LEFT JOIN sellers s ON s.id = i.seller_id
       WHERE ${where.join(" AND ")}
         AND (i.title ILIKE ${keywordParam} OR i.description ILIKE ${keywordParam})
       ORDER BY i.created_at DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return rows;
  }

  const { rows } = await pool.query<ItemRow & { score: number }>(
    `SELECT i.*, 0 AS score,
            (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready
     FROM items i LEFT JOIN sellers s ON s.id = i.seller_id
     WHERE ${where.join(" AND ")}
     ORDER BY i.created_at DESC
     LIMIT ${add(limit)} OFFSET ${add(offset)}`,
    params,
  );
  return rows;
}

export async function getItem(id: string): Promise<ItemRow | null> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT i.*, (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready
     FROM items i LEFT JOIN sellers s ON s.id = i.seller_id WHERE i.id = $1`,
    [id],
  );
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
  // modify, write. Keeps the semantics predictable. Shape caps (THI-83 §3.5)
  // are enforced here: update_listing historically validated nothing, and
  // this is the single choke point for both MCP and chat callers.
  if (update.attributes !== undefined) {
    const shapeErrors = attributeShapeErrors(update.attributes);
    if (shapeErrors.length > 0) {
      logSecurityEvent({ type: "listing_write", action: writeAction(update.status), outcome: "rejected" }, { sellerId });
      throw new AttributeValidationError(shapeErrors);
    }
    sets.push(`attributes = ${add(JSON.stringify(update.attributes))}::jsonb`);
  }
  if (sets.length === 0) return getItem(id);

  params.push(id, sellerId);
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET ${sets.join(", ")}
     WHERE id = $${params.length - 1} AND seller_id = $${params.length}
     RETURNING *`,
    params,
  );
  // THI-112 (H4.2): update/delete outcome — null means the item was not
  // found or not owned by this seller, which is the rejection worth logging.
  logSecurityEvent(
    { type: "listing_write", action: writeAction(update.status), outcome: rows[0] ? "success" : "rejected" },
    { sellerId },
  );
  return rows[0] ?? null;
}

// Undeclared-key surfacing thresholds and cap (spec THI-83 §3.3) — module
// constants, deliberately not env-configurable (same posture as CONDITIONS
// in db.ts). Passed as query parameters ($4/$5/$6), not interpolated, so
// making anything here configurable later can't become an injection vector
// (Security review THI-90 rider: the safe path is the easy path).
const UNDECLARED_KEY_MIN_ITEMS = 2;
const UNDECLARED_KEY_MIN_SELLERS = 2;
const UNDECLARED_KEY_LIMIT = 20;

export interface UndeclaredKeyUsage {
  key: string;
  items: number;
  sellers: number;
}

/** Which undeclared attribute keys are actually in shared use in a category:
 *  keys on >= 2 active listings from >= 2 distinct sellers, sorted by items
 *  desc then key asc, capped at 20. Feed-visibility applies (THI-314 F2):
 *  attributes of pending (zero-photo) listings never surface in hints.
 *  `declaredKeys` is always an array
 *  (default []) — passing a null array would silently surface every key, so
 *  callers must never propagate null from the DB. */
export async function undeclaredKeyUsage(
  category: string,
  declaredKeys: string[] = [],
): Promise<UndeclaredKeyUsage[]> {
  const { rows } = await pool.query<UndeclaredKeyUsage>(
    `SELECT k AS key, COUNT(*)::int AS items, COUNT(DISTINCT i.seller_id)::int AS sellers
     FROM items i
     CROSS JOIN LATERAL jsonb_object_keys(i.attributes) AS k
     WHERE i.category = $1 AND i.status = 'active' AND ${FEED_VISIBLE}
       AND NOT (k = ANY($2::text[]))
       AND k ~ $3
     GROUP BY k
     HAVING COUNT(*) >= $4
       AND COUNT(DISTINCT i.seller_id) >= $5
     ORDER BY items DESC, key ASC
     LIMIT $6`,
    [
      category.toLowerCase(),
      declaredKeys,
      UNDECLARED_KEY_PATTERN,
      UNDECLARED_KEY_MIN_ITEMS,
      UNDECLARED_KEY_MIN_SELLERS,
      UNDECLARED_KEY_LIMIT,
    ],
  );
  return rows;
}
