import { pool, type ItemRow } from "./db.js";
import { embedText, itemEmbeddingText } from "./embed.js";
import { evaluateListingForIntents } from "./intents.js";
import { logSecurityEvent, type ListingWriteLimit } from "./security-events.js";
import { markWantedResponsesPublished } from "./wanted.js";
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
  shipping_price_cents?: number;
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

// New-account write ramp (GH #212 / THI-542, spec docs/specs/account-write-ramp.md):
// sellers younger than NEW_SELLER_RAMP_DAYS write under tighter caps until the
// account ages out — per-account caps alone do not bound total write volume
// because farmed accounts are cheap (signup is one limiter hit). Regime is a
// pure function of sellers.created_at at call time: no stored state, nothing
// to migrate, every account older than the ramp at deploy is grandfathered
// into the full caps automatically. Numbers confirmed by the THI-543 Security
// design review — Security owns tuning, do not adjust here.
export const NEW_SELLER_RAMP_DAYS = 7;
export const NEW_SELLER_MAX_LISTING_CREATES_PER_DAY = 10;
export const NEW_SELLER_MAX_ACTIVE_LISTINGS = 20;

/** Thrown by createItem when the seller is over either cap. `code`
 *  is the MCP error code create_listing reports — `rate_limited`, the
 *  documented choice (THI-113): the rejection is quota-shaped, and agents
 *  already treat that code as back-off-and-retry-later. `limit` says which
 *  regime rejected (it mirrors the listing_write security-event field), and
 *  both messages interpolate the cap constants above — THI-543 Q2: never a
 *  hardcoded string that can drift from the numbers. */
export class ListingLimitError extends Error {
  readonly code = "rate_limited";
  readonly limit: ListingWriteLimit;
  constructor(limit: ListingWriteLimit) {
    super(
      limit === "new_seller_ramp"
        ? `New-account limit reached (max ${NEW_SELLER_MAX_LISTING_CREATES_PER_DAY} creates/day, ` +
          `${NEW_SELLER_MAX_ACTIVE_LISTINGS} active during your first ${NEW_SELLER_RAMP_DAYS} days). ` +
          `Full limits unlock automatically after ${NEW_SELLER_RAMP_DAYS} days.`
        : `Listing limit reached (max ${MAX_LISTING_CREATES_PER_SELLER_PER_DAY} creates/day, ` +
          `${MAX_ACTIVE_LISTINGS_PER_SELLER} active). Contact support if you need more.`,
    );
    this.name = "ListingLimitError";
    this.limit = limit;
  }
}

// Upper bound for a seller-set shipping price: 1,000.00 in a two-decimal
// currency. Palletised EU freight for a single second-hand item stays well
// under it, while a cents/euros unit slip (or a price moved into shipping to
// look cheap in price-filtered search) is rejected instead of reaching a buyer.
export const MAX_SHIPPING_PRICE_CENTS = 100_000;

/** Code create_listing, update_listing and respond_to_wanted report. Thrown
 *  from items.ts because the chat tools reach it without zod validation. */
export class ShippingPriceError extends Error {
  readonly code = "invalid_shipping_price";
  constructor(message: string) {
    super(message);
    this.name = "ShippingPriceError";
  }
}

function assertValidShippingPrice(cents: number, shippingTier: string): void {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_SHIPPING_PRICE_CENTS) {
    throw new ShippingPriceError(
      `shipping_price_cents must be a whole number of cents from 0 to ${MAX_SHIPPING_PRICE_CENTS}.`,
    );
  }
  if (shippingTier === "local" && cents > 0) {
    throw new ShippingPriceError(
      "Pickup-only (local tier) listings cannot charge shipping: omit shipping_price_cents or set it to 0.",
    );
  }
}

/** What the buyer pays for shipping on this listing; pickup is always 0,
 *  matching the snapshot create_order takes. */
export function buyerShippingCents(item: Pick<ItemRow, "shipping_price_cents" | "shipping_tier">): number {
  return item.shipping_tier === "local" ? 0 : item.shipping_price_cents;
}

/** THI-112: listing_write event action — a status update to 'deleted' is the
 * delete path (listings are never row-deleted); everything else is an update. */
function writeAction(status: string | undefined): "update" | "delete" {
  return status === "deleted" ? "delete" : "update";
}

export async function createItem(input: CreateItemInput): Promise<ItemRow> {
  try {
    assertValidShippingPrice(input.shipping_price_cents ?? 0, input.shipping_tier);
  } catch (err) {
    logSecurityEvent({ type: "listing_write", action: "create", outcome: "rejected" }, { sellerId: input.seller_id });
    throw err;
  }

  // Caps run BEFORE the embeddings call: every create costs an embeddings-API
  // request (the cost-DoS in security doc §6 H4), so rejecting after embedding
  // would still pay the abuser's bill. One indexed COUNT round trip
  // (items_seller_idx) covers both caps and — GH #212 write ramp — also fetches
  // the seller's created_at in the same round trip (scalar subselect on the
  // sellers PK), so the regime costs no extra query. Check-then-insert is not
  // atomic — concurrent creates can overshoot by the width of the race; that is
  // the documented pragmatic-90% posture, not a strict quota.
  const { rows: capRows } = await pool.query<{
    creates_24h: string;
    active: string;
    seller_created_at: Date | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS creates_24h,
            COUNT(*) FILTER (WHERE status = 'active') AS active,
            (SELECT created_at FROM sellers WHERE id = $1) AS seller_created_at
     FROM items WHERE seller_id = $1`,
    [input.seller_id],
  );
  // GH #212 / THI-542: effective caps are computed here, in TypeScript — age
  // < 7 days (GH #212 ramp) → 10/day + 20 active, else the full 100/200; the
  // comparison below proceeds exactly as before. A missing created_at cannot
  // happen (NOT NULL, and the row is the authenticated seller) — it fails
  // strict into the ramp rather than granting the full caps.
  const sellerAgeMs = capRows[0].seller_created_at
    ? Date.now() - new Date(capRows[0].seller_created_at).getTime()
    : Number.NaN;
  const ramped = !(sellerAgeMs >= NEW_SELLER_RAMP_DAYS * 24 * 60 * 60 * 1000);
  const maxCreatesPerDay = ramped
    ? NEW_SELLER_MAX_LISTING_CREATES_PER_DAY
    : MAX_LISTING_CREATES_PER_SELLER_PER_DAY;
  const maxActive = ramped ? NEW_SELLER_MAX_ACTIVE_LISTINGS : MAX_ACTIVE_LISTINGS_PER_SELLER;
  if (Number(capRows[0].creates_24h) >= maxCreatesPerDay || Number(capRows[0].active) >= maxActive) {
    // THI-112 × THI-113 merge synthesis: the cap rejection is the create path's
    // "rejected" listing_write outcome (shape already in SecurityEvent; updateItem
    // logs its rejections the same way). `limit` names the regime (THI-543 Q4):
    // new_seller_ramp vs seller_cap — three states, no null-handling ambiguity
    // in monitoring queries. Seller id only — no-payload rule, §6.
    const limit: ListingWriteLimit = ramped ? "new_seller_ramp" : "seller_cap";
    logSecurityEvent(
      { type: "listing_write", action: "create", outcome: "rejected", limit },
      { sellerId: input.seller_id },
    );
    throw new ListingLimitError(limit);
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
       shipping_tier, images, attributes, embedding, shipping_price_cents
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::vector,$16)
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
      input.shipping_price_cents ?? 0,
    ],
  );
  // THI-112 (H4.2): successful listing create — seller id only, never the
  // title/description (no-payload rule in docs/security.md §6).
  logSecurityEvent({ type: "listing_write", action: "create", outcome: "success" }, { sellerId: input.seller_id });

  // THI-360 §6, publish transition 1 of 2 (PR 3): a create that is already
  // feed-visible (photo attached at create — THI-308 photo-gated visibility)
  // fans out to buyer intents. Alerting must never fail the publish: errors
  // are caught and logged here; the log line carries counts only, never
  // listing or intent payload.
  if (visibleInFeeds(rows[0])) {
    try {
      const inserted = await evaluateListingForIntents(rows[0]);
      if (inserted > 0) {
        console.log(JSON.stringify({ type: "intent_fanout", count: inserted }));
      }
    } catch (err) {
      console.error("buyer-intent evaluation failed (publish unaffected)", err instanceof Error ? err.message : err);
    }
    // THI-439 §5 (B4, PR 3): the same publish transition stamps pending
    // wanted_responses published_at — idempotent (IS NULL guard), separate
    // try so a stamping failure can never skip the intent fanout above nor
    // fail the publish. Counts only.
    try {
      const stamped = await markWantedResponsesPublished(rows[0].id);
      if (stamped > 0) {
        logSecurityEvent(
          { type: "wanted_response", action: "publish", outcome: "success", count: stamped },
          { sellerId: input.seller_id },
        );
      }
    } catch (err) {
      console.error("wanted-response stamping failed (publish unaffected)", err instanceof Error ? err.message : err);
    }
  }
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

/** JS twin of FEED_VISIBLE (THI-308 PR 2): the same derived predicate,
 *  applied to a row. create_listing reports it at create time (status is
 *  always 'active' on insert, so it reduces to the photo gate) and
 *  add_item_image reports the post-append state — the first photo on a
 *  pending listing publishes it, no stored flag to flip. */
export function visibleInFeeds(item: Pick<ItemRow, "status" | "photo_required" | "images">): boolean {
  return item.status === "active" && (!item.photo_required || item.images.length > 0);
}

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
  /** Any of these conditions. Combined with `condition` as one allowed set (union). */
  conditions?: string[];
  min_price_cents?: number;
  max_price_cents?: number;
  currency?: string;
  shipping_tier?: string;
  attributes?: Attributes;
  limit: number;
  /** Rows to skip, for offset pagination (1-based pages in callers). Defaults to 0. */
  offset?: number;
  /** Fetch one row past `limit`, so a caller can tell whether another page exists without a COUNT. */
  lookahead?: boolean;
}

export const SEARCH_MAX_LIMIT = 50;
/** Deepest `offset` search_items accepts: with a full page that is rows 451-500, ten
 *  pages of 50. Beyond that a caller should refine the query rather than walk it. */
export const SEARCH_MAX_OFFSET = 450;
/** Rows the semantic query ranks before paging. Constant across every search_items page
 *  (deepest offset + full page + lookahead row), so the planner sees the same inner LIMIT
 *  on each page; LIMIT 10 and OFFSET 5000 otherwise pick different plans with different
 *  recall (ivfflat vs. exact sort) and pages stop lining up. */
const SEARCH_RANK_WINDOW = SEARCH_MAX_OFFSET + SEARCH_MAX_LIMIT + 1;

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
  // `condition` and `conditions` form one allowed set, so a caller that sends both
  // widens the match instead of intersecting to nothing.
  const conditions = [...new Set([...(filters.condition ? [filters.condition] : []), ...(filters.conditions ?? [])])];
  if (conditions.length > 0) where.push(`i.condition = ANY(${add(conditions)}::text[])`);
  if (filters.shipping_tier) where.push(`i.shipping_tier = ${add(filters.shipping_tier)}`);
  if (filters.currency) where.push(`i.currency = ${add(filters.currency)}`);
  if (filters.min_price_cents !== undefined) where.push(`i.price_cents >= ${add(filters.min_price_cents)}`);
  if (filters.max_price_cents !== undefined) where.push(`i.price_cents <= ${add(filters.max_price_cents)}`);
  if (filters.attributes && Object.keys(filters.attributes).length > 0) {
    where.push(attributeFilterClause(filters.attributes, add));
  }

  const q = filters.q?.trim();
  const limit = Math.min(Math.max(filters.limit, 1), SEARCH_MAX_LIMIT) + (filters.lookahead ? 1 : 0);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);

  if (q) {
    const embedding = await embedText(q);
    if (embedding) {
      const vecParam = add(JSON.stringify(embedding));
      const keywordParam = add(`%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      // The id tie-break lives in the outer query on purpose: a second sort key next
      // to the distance stops Postgres 16 from using the ivfflat index at all.
      // /browse can page past the MCP cap, hence the Math.max.
      const { rows } = await pool.query<ItemRow & { score: number }>(
        `SELECT * FROM (
           SELECT i.*, 1 - (i.embedding <=> ${vecParam}::vector) AS score,
                  (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready
           FROM items i LEFT JOIN sellers s ON s.id = i.seller_id
           WHERE ${where.join(" AND ")}
             AND i.embedding IS NOT NULL
             AND (i.title ILIKE ${keywordParam} OR i.description ILIKE ${keywordParam}
                  OR 1 - (i.embedding <=> ${vecParam}::vector) > 0.15)
           ORDER BY i.embedding <=> ${vecParam}::vector
           LIMIT ${add(Math.max(SEARCH_RANK_WINDOW, offset + limit))}
         ) ranked
         ORDER BY ranked.embedding <=> ${vecParam}::vector, ranked.id
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
       ORDER BY i.created_at DESC, i.id
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
     ORDER BY i.created_at DESC, i.id
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
  shipping_price_cents?: number;
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
  if (update.shipping_price_cents !== undefined) {
    // shipping_tier has no update path, so this read cannot go stale. A row
    // that is missing or not owned falls through to the UPDATE's not-found.
    const { rows: tierRows } = await pool.query<Pick<ItemRow, "shipping_tier">>(
      "SELECT shipping_tier FROM items WHERE id = $1 AND seller_id = $2",
      [id, sellerId],
    );
    try {
      assertValidShippingPrice(update.shipping_price_cents, tierRows[0]?.shipping_tier ?? "unknown");
    } catch (err) {
      logSecurityEvent({ type: "listing_write", action: writeAction(update.status), outcome: "rejected" }, { sellerId });
      throw err;
    }
    sets.push(`shipping_price_cents = ${add(update.shipping_price_cents)}`);
  }
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
