// Buyer alerts v1 core (spec THI-360 rev 2, PR 1 of 5): saved buyer intent
// CRUD + Security-approved caps (THI-380). Pure foundation — nothing calls
// this module yet: PR 2 wires the MCP tools, PR 3 the publish evaluation
// (MAX_MATCHES_PER_LISTING / MAX_NEW_MATCHES_PER_BUYER_PER_DAY), PR 4 the
// match reads. Mirrors src/items.ts conventions throughout.

import { pool, type ItemRow } from "./db.js";
import { embedText } from "./embed.js";
import { logSecurityEvent } from "./security-events.js";
import type { Attributes } from "./attributes.js";

// Fan-out controls (spec §3.4 — Security-approved numbers, THI-380): module
// constants, deliberately not env-configurable (same posture as the listing
// caps in src/items.ts). Security owns the numbers; changing them here is
// one place and the error message follows.
export const MAX_INTENTS_PER_BUYER = 25;
export const MAX_INTENT_SAVES_PER_BUYER_PER_DAY = 50;
export const MAX_MATCHES_PER_LISTING = 100;
export const MAX_NEW_MATCHES_PER_BUYER_PER_DAY = 10;

/** Thrown by saveIntent when the buyer is over either cap. `code` is the MCP
 *  error code the tool layer reports — rate_limited, the same choice as
 *  ListingLimitError (THI-113): the rejection is quota-shaped, and agents
 *  already treat that code as back-off-and-retry-later. */
export class IntentLimitError extends Error {
  readonly code = "rate_limited";
  constructor() {
    super(
      `Intent limit reached (max ${MAX_INTENTS_PER_BUYER} stored, ` +
        `${MAX_INTENT_SAVES_PER_BUYER_PER_DAY} saves/day). Delete an intent or try again tomorrow.`,
    );
    this.name = "IntentLimitError";
  }
}

/** Thrown by saveIntent on invalid shape (no q and no filters, q outside
 *  3–400 chars after trim, negative or inverted prices) — before any query
 *  or embeddings call. */
export class IntentValidationError extends Error {
  readonly code = "invalid_intent";
  constructor(message: string) {
    super(message);
    this.name = "IntentValidationError";
  }
}

export interface SaveIntentInput {
  q?: string;
  category?: string;
  condition?: string;
  min_price_cents?: number;
  max_price_cents?: number;
  currency?: string;
  shipping_tier?: string;
  attributes?: Attributes;
}

export interface IntentRow {
  id: string;
  buyer_id: string;
  q: string | null;
  category: string | null;
  condition: string | null;
  min_price_cents: number | null;
  max_price_cents: number | null;
  currency: string;
  shipping_tier: string | null;
  attributes: Record<string, unknown>;
  muted: boolean;
  created_at: Date;
  updated_at: Date;
  /** Aggregated by listIntents (LEFT JOIN); absent on save/update rows. */
  unread_matches?: number;
}

/** R5 (THI-380 rider): every intent write logs one intent_write event —
 *  buyer id only, never q or filters (THI-112/113 no-payload rule). */
function logIntentWrite(action: "save" | "update" | "delete", outcome: "success" | "rejected", buyerId: string): void {
  logSecurityEvent({ type: "intent_write", action, outcome }, { sellerId: buyerId });
}

export async function saveIntent(buyerId: string, input: SaveIntentInput): Promise<IntentRow> {
  // N3: q is trimmed at save; a whitespace-only q is no q.
  const trimmed = input.q?.trim();
  const q = trimmed ? trimmed : null;

  // Shape validation first — free, no query, no embeddings call.
  const { min_price_cents: min, max_price_cents: max } = input;
  const hasFilter = Boolean(
    input.category || input.condition || input.shipping_tier ||
    min !== undefined || max !== undefined ||
    (input.attributes && Object.keys(input.attributes).length > 0),
  );
  const errors: string[] = [];
  if (q !== null && (q.length < 3 || q.length > 400)) {
    errors.push(`q must be 3-400 characters after trimming (got ${q.length})`);
  }
  if (q === null && !hasFilter) {
    errors.push("at least one of q or a filter (category, condition, price range, shipping_tier, attributes) is required");
  }
  if ((min !== undefined && min < 0) || (max !== undefined && max < 0) ||
    (min !== undefined && max !== undefined && max < min)) {
    errors.push("min_price_cents/max_price_cents must be >= 0 and max must be >= min");
  }
  if (errors.length > 0) {
    logIntentWrite("save", "rejected", buyerId);
    throw new IntentValidationError(errors.join("; "));
  }

  // R1 ordering is load-bearing (THI-380): caps run BEFORE embedText — every
  // save costs one embeddings request, so rejecting after embedding would
  // still pay the abuser's bill. The 25-stored check is check-then-insert
  // (same pragmatic-90% posture as the listing caps in src/items.ts); the
  // daily quota below is the strict one.
  const { rows: countRows } = await pool.query<{ stored: string }>(
    `SELECT COUNT(*) AS stored FROM buyer_intents WHERE buyer_id = $1`,
    [buyerId],
  );
  if (Number(countRows[0].stored) >= MAX_INTENTS_PER_BUYER) {
    logIntentWrite("save", "rejected", buyerId);
    throw new IntentLimitError();
  }

  // R2 (THI-380 rider): daily quota as one atomic conditional upsert
  // (mirrors seller_upload_quota in src/images.ts): the increment applies
  // only while saves < cap, so concurrent saves serialize on the row lock.
  // Zero rows back = over quota. Hard-delete cannot reset it — delete-cycling
  // a count-at-save cap is the exact defeat this table closes. The quota is
  // consumed before the embeddings call; a save that later fails still spent
  // it — the safe direction: the embeddings call is the protected resource.
  const quota = await pool.query(
    `INSERT INTO buyer_intent_quota (buyer_id, day, saves)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (buyer_id, day) DO UPDATE
       SET saves = buyer_intent_quota.saves + 1
     WHERE buyer_intent_quota.saves < $2
     RETURNING saves`,
    [buyerId, MAX_INTENT_SAVES_PER_BUYER_PER_DAY],
  );
  if (quota.rows.length === 0) {
    logIntentWrite("save", "rejected", buyerId);
    throw new IntentLimitError();
  }

  const embedding = q ? await embedText(q) : null;
  const { rows } = await pool.query<IntentRow>(
    `INSERT INTO buyer_intents (
       buyer_id, q, category, condition, min_price_cents, max_price_cents,
       currency, shipping_tier, attributes, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::vector)
     RETURNING *`,
    [
      buyerId,
      q,
      input.category ?? null,
      input.condition ?? null,
      input.min_price_cents ?? null,
      input.max_price_cents ?? null,
      input.currency ?? "EUR",
      input.shipping_tier ?? null,
      JSON.stringify(input.attributes ?? {}),
      embedding ? JSON.stringify(embedding) : null,
    ],
  );
  logIntentWrite("save", "success", buyerId);
  return rows[0];
}

export async function listIntents(buyerId: string): Promise<Array<IntentRow & { unread_matches: number }>> {
  const { rows } = await pool.query<IntentRow & { unread_matches: number }>(
    `SELECT i.*, COALESCE(u.unread_matches, 0)::int AS unread_matches
     FROM buyer_intents i
     LEFT JOIN (
       SELECT intent_id, COUNT(*)::int AS unread_matches
       FROM intent_matches
       WHERE read_at IS NULL
       GROUP BY intent_id
     ) u ON u.intent_id = i.id
     WHERE i.buyer_id = $1
     ORDER BY i.created_at DESC`,
    [buyerId],
  );
  return rows;
}

export async function updateIntentMute(
  intentId: string,
  buyerId: string,
  muted: boolean,
): Promise<IntentRow | null> {
  const { rows } = await pool.query<IntentRow>(
    `UPDATE buyer_intents SET muted = $3
     WHERE id = $1 AND buyer_id = $2
     RETURNING *`,
    [intentId, buyerId, muted],
  );
  // Null means missing or non-owned — indistinguishable by design (the caller
  // maps both to not_found); the rejection is still worth an event (R5).
  logIntentWrite("update", rows[0] ? "success" : "rejected", buyerId);
  return rows[0] ?? null;
}

export async function deleteIntent(intentId: string, buyerId: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM buyer_intents WHERE id = $1 AND buyer_id = $2 RETURNING id`,
    [intentId, buyerId],
  );
  logIntentWrite("delete", rows[0] ? "success" : "rejected", buyerId);
  return rows.length > 0;
}

/** One match row as my_matches returns it (PR 4 of 5): the joined intent
 *  and item rows shaped for intentToPublic / itemToPublic. `read` is the
 *  fetch-time state; item columns are selected explicitly — the embedding
 *  vector is never fetched, so it cannot leak into tool output (R4). */
export interface MatchRow {
  id: string;
  score: number;
  read: boolean;
  created_at: Date;
  intent: IntentRow;
  item: ItemRow & { seller_payout_ready?: boolean };
}

/** Reads the caller's match inbox newest-first (spec THI-360 §5 tool 5).
 *  Scoped WHERE buyer_id = caller; matches whose item has since been
 *  soft-deleted are silently skipped. unread_only keeps read_at IS NULL
 *  rows. mark_read stamps read_at = now() on the returned unread rows only —
 *  the `read_at IS NULL` guard makes read → read a no-op (never an error)
 *  and the deliberately absent un-read transition cannot be expressed.
 *  Returns the page plus how many rows the mark touched. */
export async function listMatches(
  buyerId: string,
  opts: { limit: number; unreadOnly: boolean; markRead: boolean },
): Promise<{ matches: MatchRow[]; markedRead: number }> {
  // Explicit aliases, never SELECT *: three joined tables share column
  // names (id/created_at/currency/…) and node-postgres keeps only the last
  // of a duplicated name — a collision here would silently swap fields.
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT m.id AS match_id, m.score, m.read_at, m.created_at AS match_created_at,
            bi.id AS intent_id, bi.q, bi.category AS intent_category,
            bi.condition AS intent_condition, bi.min_price_cents, bi.max_price_cents,
            bi.currency AS intent_currency, bi.shipping_tier AS intent_shipping_tier,
            bi.attributes AS intent_attributes, bi.muted,
            bi.created_at AS intent_created_at, bi.updated_at AS intent_updated_at,
            i.id AS item_id, i.seller_id, i.title, i.description, i.category, i.condition,
            i.brand, i.price_cents, i.currency, i.location, i.weight_grams, i.dimensions_mm,
            i.shipping_tier, i.shipping_price_cents, i.images, i.attributes, i.status,
            i.photo_required, i.created_at,
            (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL)
              AS seller_payout_ready
     FROM intent_matches m
     JOIN buyer_intents bi ON bi.id = m.intent_id
     JOIN items i ON i.id = m.item_id
     JOIN sellers s ON s.id = i.seller_id
     WHERE m.buyer_id = $1
       AND i.status <> 'deleted'
       ${opts.unreadOnly ? "AND m.read_at IS NULL" : ""}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [buyerId, opts.limit],
  );
  const matches: MatchRow[] = rows.map((r) => ({
    id: r.match_id as string,
    score: r.score as number,
    read: r.read_at !== null,
    created_at: r.match_created_at as Date,
    intent: {
      id: r.intent_id as string,
      buyer_id: buyerId,
      q: r.q as string | null,
      category: r.intent_category as string | null,
      condition: r.intent_condition as string | null,
      min_price_cents: r.min_price_cents as number | null,
      max_price_cents: r.max_price_cents as number | null,
      currency: r.intent_currency as string,
      shipping_tier: r.intent_shipping_tier as string | null,
      attributes: r.intent_attributes as Record<string, unknown>,
      muted: r.muted as boolean,
      created_at: r.intent_created_at as Date,
      updated_at: r.intent_updated_at as Date,
    },
    item: {
      id: r.item_id as string,
      seller_id: r.seller_id as string,
      title: r.title as string,
      description: r.description as string,
      category: r.category as string,
      condition: r.condition as string,
      brand: r.brand as string | null,
      price_cents: r.price_cents as number,
      currency: r.currency as string,
      location: r.location as string | null,
      weight_grams: r.weight_grams as number | null,
      dimensions_mm: r.dimensions_mm as string | null,
      shipping_tier: r.shipping_tier as string,
      shipping_price_cents: r.shipping_price_cents as number,
      images: r.images as string[],
      attributes: r.attributes as Record<string, unknown>,
      status: r.status as string,
      photo_required: r.photo_required as boolean,
      created_at: r.created_at as Date,
      seller_payout_ready: r.seller_payout_ready as boolean,
    },
  }));
  let markedRead = 0;
  if (opts.markRead) {
    const ids = matches.filter((m) => !m.read).map((m) => m.id);
    if (ids.length > 0) {
      const marked = await pool.query(
        `UPDATE intent_matches SET read_at = now()
         WHERE buyer_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
        [buyerId, ids],
      );
      markedRead = marked.rowCount ?? 0;
    }
  }
  return { matches, markedRead };
}

/**
 * Match evaluation at publish (spec THI-360 §3.2/§6, PR 3 of 5): one bounded,
 * idempotent, replay-safe INSERT…SELECT that records a match for every
 * intent whose search would have returned this item — minus muted intents,
 * the seller's own intents, and buyers already over the daily new-match cap.
 * Called only from the two publish transitions (createItem / addItemImage),
 * always wrapped so alerting can never fail the publish.
 *
 * Parity with searchItems is exact by construction (N2 gate): the text leg is
 * the same two branches — intent without an embedding (embeddings
 * unconfigured) matches keyword-only; intent WITH an embedding requires the
 * item to have one too, then matches on ILIKE or cosine over the 0.15 floor.
 * Under-notifies, never over-notifies (spec §3.2's accepted asymmetry).
 *
 * `esc` below escapes `\` then `%`/`_` inside bi.q IN SQL — tighter than
 * searchItems' JS escape (Security N4). Do NOT port searchItems' escape here;
 * backporting is OQ7, an independent ticket.
 *
 * The per-buyer daily guard is approximate within one statement (N1): a buyer
 * with k simultaneously matching intents can overshoot by ≤ k−1 (≤ 24) — the
 * documented pragmatic-90% posture, same as THI-110/113.
 *
 * Returns the number of matches inserted (0 when nothing matched or
 * everything was a duplicate/over-cap). `score` = cosine similarity, or 0
 * when either side has no embedding.
 */
export async function evaluateListingForIntents(item: ItemRow): Promise<number> {
  const { rows } = await pool.query(
    `WITH capped AS (
       SELECT bi.id, bi.buyer_id,
              COALESCE(1 - (bi.embedding <=> $10::vector), 0) AS score
       FROM buyer_intents bi
       CROSS JOIN LATERAL (
         SELECT '%' || replace(replace(replace(bi.q, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' AS pat
       ) e
       WHERE bi.muted = false
         AND bi.buyer_id <> $1
         AND (bi.category IS NULL OR bi.category = $2)
         AND (bi.condition IS NULL OR bi.condition = $3)
         AND (bi.shipping_tier IS NULL OR bi.shipping_tier = $4)
         AND bi.currency = $5
         AND (bi.min_price_cents IS NULL OR bi.min_price_cents <= $6)
         AND (bi.max_price_cents IS NULL OR bi.max_price_cents >= $6)
         AND (bi.attributes = '{}'::jsonb OR $7::jsonb @> bi.attributes)
         AND (bi.q IS NULL
              OR (bi.embedding IS NULL AND ($8 ILIKE e.pat OR $9 ILIKE e.pat))
              OR (bi.embedding IS NOT NULL AND $10::vector IS NOT NULL
                  AND ($8 ILIKE e.pat OR $9 ILIKE e.pat
                       OR 1 - (bi.embedding <=> $10::vector) > 0.15)))
         AND (SELECT count(*) FROM intent_matches m
              WHERE m.buyer_id = bi.buyer_id
                AND m.created_at > now() - interval '24 hours') < $11
       ORDER BY 1 - (bi.embedding <=> $10::vector) DESC NULLS LAST
       LIMIT $12
     )
     INSERT INTO intent_matches (intent_id, buyer_id, item_id, score)
     SELECT id, buyer_id, $13, score FROM capped
     ON CONFLICT (intent_id, item_id) DO NOTHING
     RETURNING intent_id`,
    [
      item.seller_id,
      item.category,
      item.condition,
      item.shipping_tier,
      item.currency,
      item.price_cents,
      JSON.stringify(item.attributes ?? {}),
      item.title,
      item.description,
      item.embedding ?? null,
      MAX_NEW_MATCHES_PER_BUYER_PER_DAY,
      MAX_MATCHES_PER_LISTING,
      item.id,
    ],
  );
  return rows.length;
}
