// Buyer alerts v1 core (spec THI-360 rev 2, PR 1 of 5): saved buyer intent
// CRUD + Security-approved caps (THI-380). Pure foundation — nothing calls
// this module yet: PR 2 wires the MCP tools, PR 3 the publish evaluation
// (MAX_MATCHES_PER_LISTING / MAX_NEW_MATCHES_PER_BUYER_PER_DAY), PR 4 the
// match reads. Mirrors src/items.ts conventions throughout.

import { pool } from "./db.js";
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
