// Wanted listings v1 core (spec THI-439 rev 1, PR 1 of the B1+B4 backend):
// public buyer-demand records — create/edit/expire/renew with the §3.2 state
// machine, caps + delete-cycle-proof daily quota (§3.3), contact-info
// screening (src/contact-scrub.ts), hybrid search with exact searchItems
// predicate parity (§3.4), and wanted_write security events. Foundation
// first — nothing calls this module until the response loop (PR 3), /wanted
// pages (PR 4) and /api/wanted routes (PR 5) wire it. Mirrors src/intents.ts
// conventions (THI-360) throughout.

import { pool, CONDITIONS } from "./db.js";
import { embedText } from "./embed.js";
import { logSecurityEvent } from "./security-events.js";
import { screenContactInfo, contactInfoMessage } from "./contact-scrub.js";

// Fan-out controls (spec §3.3 — Security-owned numbers, THI-442 review gate):
// module constants, deliberately not env-configurable (same posture as the
// listing caps in src/items.ts and intent caps in src/intents.ts). Changing
// them is one reviewed edit and the error messages follow.
export const MAX_ACTIVE_WANTEDS_PER_BUYER = 10;
export const MAX_WANTED_CREATES_PER_BUYER_PER_DAY = 10;
export const MAX_WANTED_EDITS_PER_BUYER_PER_DAY = 20;
export const MAX_RESPONSES_PER_SELLER_PER_WANTED = 3; // consumed by respondToWanted (PR 3)
export const WANTED_TTL_DAYS = 30;
export const WANTED_RENEWAL_GRACE_DAYS = 30;
export const WANTED_RETENTION_DAYS = 180; // consumed by src/wanted-sweep.ts (PR 4)

/** Over the active-wanted cap or a daily quota. `code` is the MCP error code
 *  the tool layer reports — rate_limited, the same choice as
 *  ListingLimitError (THI-113) and IntentLimitError (THI-380): the rejection
 *  is quota-shaped and agents already treat it as back-off-and-retry-later. */
export class WantedLimitError extends Error {
  readonly code = "rate_limited";
  constructor() {
    super(
      `Wanted limit reached (max ${MAX_ACTIVE_WANTEDS_PER_BUYER} active, ` +
        `${MAX_WANTED_CREATES_PER_BUYER_PER_DAY} creates/day, ` +
        `${MAX_WANTED_EDITS_PER_BUYER_PER_DAY} edits/day). Expire one or try again tomorrow.`,
    );
    this.name = "WantedLimitError";
  }
}

/** Invalid shape or an illegal state-machine transition (§3.2) — thrown
 *  before any quota, query or embeddings call for shape errors. */
export class WantedValidationError extends Error {
  readonly code = "invalid_wanted";
  constructor(message: string) {
    super(message);
    this.name = "WantedValidationError";
  }
}

/** Title/notes tripped a contact-scrub rule (§3.3). The message names the
 *  rule family and field; rejected, never rewritten. */
export class ContactInfoError extends Error {
  readonly code = "contact_info";
  constructor(message: string) {
    super(message);
    this.name = "ContactInfoError";
  }
}

/** Wanted not found or not owned by the caller — indistinguishable by
 *  design (same posture as update_intent; the caller maps to not_found). */
export class WantedNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Wanted item not found");
    this.name = "WantedNotFoundError";
  }
}

export interface CreateWantedInput {
  title: string;
  notes?: string;
  category?: string;
  condition?: string | null;
  budget_min_cents?: number | null;
  budget_max_cents?: number | null;
  currency?: string;
  reference_images?: string[];
}

/** The editable field set — wholesale replace, update_listing semantics. */
export type WantedFieldUpdate = Partial<Pick<CreateWantedInput,
  "title" | "notes" | "category" | "condition" | "budget_min_cents" | "budget_max_cents" | "currency" | "reference_images"
>>;

export interface WantedRow {
  id: string;
  buyer_id: string;
  title: string;
  notes: string;
  category: string;
  condition: string | null;
  budget_min_cents: number | null;
  budget_max_cents: number | null;
  currency: string;
  reference_images: string[];
  /** Present on RETURNING * / SELECT *; pg hands the vector back as its
   *  string form. Never selected by searchWanted (R4 discipline). */
  embedding?: string | null;
  status: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** §3.3: one wanted_write event per write — buyer id only, never
 *  title/notes/filters (THI-112 no-payload rule). */
function logWantedWrite(action: "create" | "update" | "renew" | "expire", outcome: "success" | "rejected", buyerId: string): void {
  logSecurityEvent({ type: "wanted_write", action, outcome }, { sellerId: buyerId });
}

/** The text a wanted item is indexed by (spec §7): mirrors itemEmbeddingText
 *  weighting — title twice, category, condition (underscores spaced), notes. */
export function wantedEmbeddingText(input: {
  title: string;
  notes: string;
  category: string;
  condition?: string | null;
}): string {
  return [
    input.title,
    input.title,
    input.category,
    input.condition ? input.condition.replace(/_/g, " ") : "",
    input.notes,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Reference-image validation — same rules as create_listing images
 * (THI-111 scheme allowlist + THI-130 length cap): ≤ 3, each http(s) and
 *  ≤ 2048 chars. URL pass-through only in V1 (no upload route). */
function referenceImageErrors(images: string[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  if (images.length > 3) return [`at most 3 reference images (got ${images.length})`];
  const errors: string[] = [];
  images.forEach((url, i) => {
    if (!/^https?:\/\//i.test(url)) errors.push(`reference_images[${i}] must be http(s)`);
    else if (url.length > 2048) errors.push(`reference_images[${i}] must be at most 2048 characters`);
  });
  return errors;
}

/** Shape + scrub + category validation shared by create and edit (§3.3).
 *  Runs before any cap check, quota consumption or embeddings call — free
 *  rejections first (R1 ordering, load-bearing). */
async function validateWantedFields(input: CreateWantedInput): Promise<{
  title: string;
  notes: string;
  category: string;
  condition: string | null;
  budget_min_cents: number | null;
  budget_max_cents: number | null;
  currency: string;
  reference_images: string[];
}> {
  const title = input.title.trim();
  const notes = (input.notes ?? "").trim();
  const currency = (input.currency ?? "EUR").toUpperCase();

  const errors: string[] = [];
  if (title.length < 3 || title.length > 200) {
    errors.push(`title must be 3-200 characters after trimming (got ${title.length})`);
  }
  if (notes.length > 2000) {
    errors.push(`notes must be at most 2000 characters (got ${notes.length})`);
  }
  if (input.condition !== undefined && input.condition !== null && !CONDITIONS.includes(input.condition as never)) {
    errors.push(`condition must be one of ${CONDITIONS.join(", ")}`);
  }
  const min = input.budget_min_cents ?? null;
  const max = input.budget_max_cents ?? null;
  if ((min !== null && (!Number.isInteger(min) || min < 0)) || (max !== null && (!Number.isInteger(max) || max < 0))) {
    errors.push("budget_min_cents/budget_max_cents must be integers >= 0");
  } else if (min !== null && max !== null && min > max) {
    errors.push("budget_min_cents must be <= budget_max_cents");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push("currency must be a 3-letter code, e.g. EUR");
  }
  errors.push(...referenceImageErrors(input.reference_images));
  if (errors.length > 0) {
    throw new WantedValidationError(errors.join("; "));
  }

  // Contact-info screening (§3.3): reject, never rewrite.
  const hit = screenContactInfo({ title, notes });
  if (hit) {
    throw new ContactInfoError(contactInfoMessage(hit));
  }

  // Category registry check — same check + available-list error as
  // create_listing (spec §3.1). 'other' is the registry default. Queried
  // directly (not via items.ts getCategory) to keep this module a leaf —
  // items.ts imports wanted.ts for the publish-stamp hook (PR 3).
  const category = (input.category ?? "other").toLowerCase();
  const { rows: catRows } = await pool.query<{ name: string }>(
    `SELECT name FROM categories WHERE name = $1`,
    [category],
  );
  if (catRows.length === 0) {
    throw new WantedValidationError(`Unknown category '${category}'. Use describe_category to list them.`);
  }

  return {
    title,
    notes,
    category,
    condition: (input.condition as string | null) ?? null,
    budget_min_cents: min,
    budget_max_cents: max,
    currency,
    reference_images: input.reference_images ?? [],
  };
}

/** Active-cap check shared by create and renew (§3.3): expire-cycling must
 *  not be able to exceed 10 live wanteds. Check-then-insert pragmatism, the
 *  same documented posture as the listing caps (THI-113). */
async function assertUnderActiveCap(buyerId: string): Promise<void> {
  const { rows } = await pool.query<{ active: string }>(
    `SELECT COUNT(*) AS active FROM wanted_items WHERE buyer_id = $1 AND status = 'active'`,
    [buyerId],
  );
  if (Number(rows[0].active) >= MAX_ACTIVE_WANTEDS_PER_BUYER) {
    throw new WantedLimitError();
  }
}

/** Daily quota as one atomic conditional upsert (THI-380 R2 pattern,
 *  mirrored from buyer_intent_quota): the increment applies only while the
 *  count is under the cap, so concurrent writes serialize on the row lock
 *  and zero rows back = over quota. Expire-cycling cannot reset it — the
 *  exact defeat this table closes. Consumed BEFORE embedText (R1): every
 *  create/edit costs an embeddings request, so the quota must reject first. */
async function consumeWantedQuota(
  buyerId: string,
  column: "creates" | "edits",
  cap: number,
): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO wanted_buyer_quota (buyer_id, day, ${column})
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (buyer_id, day) DO UPDATE
       SET ${column} = wanted_buyer_quota.${column} + 1
     WHERE wanted_buyer_quota.${column} < $2
     RETURNING ${column}`,
    [buyerId, cap],
  );
  if (rows.length === 0) {
    throw new WantedLimitError();
  }
}

export async function createWanted(buyerId: string, input: CreateWantedInput): Promise<WantedRow> {
  // R1 ordering (load-bearing): shape + scrub + category (free) → active cap
  // → quota consume → then the one embedText call. A rejection after
  // embedding would still pay the abuser's bill (THI-380 R1).
  let fields;
  try {
    fields = await validateWantedFields(input);
  } catch (e) {
    logWantedWrite("create", "rejected", buyerId);
    throw e;
  }
  try {
    await assertUnderActiveCap(buyerId);
    await consumeWantedQuota(buyerId, "creates", MAX_WANTED_CREATES_PER_BUYER_PER_DAY);
  } catch (e) {
    logWantedWrite("create", "rejected", buyerId);
    throw e;
  }

  const embedding = await embedText(
    wantedEmbeddingText({
      title: fields.title,
      notes: fields.notes,
      category: fields.category,
      condition: fields.condition,
    }),
  );

  const { rows } = await pool.query<WantedRow>(
    `INSERT INTO wanted_items (
       buyer_id, title, notes, category, condition,
       budget_min_cents, budget_max_cents, currency, reference_images, embedding,
       status, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,'active', now() + ($11 || ' days')::interval)
     RETURNING *`,
    [
      buyerId,
      fields.title,
      fields.notes,
      fields.category,
      fields.condition,
      fields.budget_min_cents,
      fields.budget_max_cents,
      fields.currency,
      fields.reference_images,
      embedding ? JSON.stringify(embedding) : null,
      String(WANTED_TTL_DAYS),
    ],
  );
  logWantedWrite("create", "success", buyerId);
  return rows[0];
}

export interface WantedUpdateInput {
  expire?: boolean;
  renew?: boolean;
  fields?: WantedFieldUpdate;
}

/** State-machine owner update (§3.2): exactly one of expire / renew, or a
 *  field edit (wholesale replace). Illegal transitions throw
 *  WantedValidationError — never coerced. Missing/non-owned ids throw
 *  WantedNotFoundError (indistinguishable by design).
 *
 *  Renewal semantics per the spec's guard text — "renewable in the final 7
 *  days or after expiry": allowed from an expiring active item (≤ 7 days
 *  left; created_at DESC ordering means renewal never bumps feed position)
 *  or from an expired one inside the 30-day grace. Both reset
 *  expires_at = now()+30d and re-check the active cap (shared with create,
 *  so expire-cycling cannot exceed 10 live). */
export async function updateWanted(
  wantedId: string,
  buyerId: string,
  update: WantedUpdateInput,
): Promise<WantedRow> {
  if (update.expire && update.renew) {
    logWantedWrite("update", "rejected", buyerId);
    throw new WantedValidationError("provide at most one of expire or renew");
  }

  const { rows: found } = await pool.query<WantedRow>(
    `SELECT * FROM wanted_items WHERE id = $1 AND buyer_id = $2`,
    [wantedId, buyerId],
  );
  const current = found[0];
  if (!current) {
    logWantedWrite("update", "rejected", buyerId);
    throw new WantedNotFoundError();
  }

  if (update.expire) {
    if (current.status !== "active") {
      logWantedWrite("expire", "rejected", buyerId);
      throw new WantedValidationError("wanted item is already expired");
    }
    const { rows } = await pool.query<WantedRow>(
      `UPDATE wanted_items SET status = 'expired' WHERE id = $1 RETURNING *`,
      [wantedId],
    );
    logWantedWrite("expire", "success", buyerId);
    return rows[0];
  }

  if (update.renew) {
    const expiredWithinGrace =
      current.status === "expired" &&
      current.expires_at.getTime() > Date.now() - WANTED_RENEWAL_GRACE_DAYS * 86_400_000;
    const expiringActive =
      current.status === "active" &&
      current.expires_at.getTime() - Date.now() <= 7 * 86_400_000;
    if (!expiredWithinGrace && !expiringActive) {
      logWantedWrite("renew", "rejected", buyerId);
      throw new WantedValidationError(
        current.status === "active"
          ? "not renewable yet — renewal opens in the final 7 days or after expiry"
          : "permanently expired — the 30-day renewal grace has passed",
      );
    }
    try {
      await assertUnderActiveCap(buyerId);
    } catch (e) {
      logWantedWrite("renew", "rejected", buyerId);
      throw e;
    }
    const { rows } = await pool.query<WantedRow>(
      `UPDATE wanted_items
       SET status = 'active', expires_at = now() + ($2 || ' days')::interval
       WHERE id = $1 RETURNING *`,
      [wantedId, String(WANTED_TTL_DAYS)],
    );
    logWantedWrite("renew", "success", buyerId);
    return rows[0];
  }

  // Field edit — active only (§3.2: editing an expired item is rejected;
  // renew first). Wholesale replace of the provided fields.
  const fields = update.fields ?? {};
  if (Object.keys(fields).length === 0) {
    logWantedWrite("update", "rejected", buyerId);
    throw new WantedValidationError("nothing to update — provide fields, expire: true, or renew: true");
  }
  if (current.status !== "active") {
    logWantedWrite("update", "rejected", buyerId);
    throw new WantedValidationError("expired wanted items cannot be edited — renew it first");
  }

  const merged: CreateWantedInput = {
    title: fields.title !== undefined ? fields.title : current.title,
    notes: fields.notes !== undefined ? fields.notes : current.notes,
    category: fields.category !== undefined ? fields.category : current.category,
    condition: fields.condition !== undefined ? fields.condition : current.condition,
    budget_min_cents: fields.budget_min_cents !== undefined ? fields.budget_min_cents : current.budget_min_cents,
    budget_max_cents: fields.budget_max_cents !== undefined ? fields.budget_max_cents : current.budget_max_cents,
    currency: fields.currency !== undefined ? fields.currency : current.currency,
    reference_images: fields.reference_images !== undefined ? fields.reference_images : current.reference_images,
  };
  let validated;
  try {
    validated = await validateWantedFields(merged);
  } catch (e) {
    logWantedWrite("update", "rejected", buyerId);
    throw e;
  }
  try {
    await consumeWantedQuota(buyerId, "edits", MAX_WANTED_EDITS_PER_BUYER_PER_DAY);
  } catch (e) {
    logWantedWrite("update", "rejected", buyerId);
    throw e;
  }

  // Re-embed only when the indexed text changed (spec §3.2) — and always
  // AFTER the quota was consumed (R1: edit-spam costs embeddings).
  const textChanged =
    validated.title !== current.title ||
    validated.notes !== current.notes ||
    validated.category !== current.category ||
    validated.condition !== current.condition;
  const embedding = textChanged
    ? await embedText(wantedEmbeddingText({
        title: validated.title,
        notes: validated.notes,
        category: validated.category,
        condition: validated.condition,
      }))
    : null;

  const { rows } = await pool.query<WantedRow>(
    `UPDATE wanted_items SET
       title = $3, notes = $4, category = $5, condition = $6,
       budget_min_cents = $7, budget_max_cents = $8, currency = $9,
       reference_images = $10,
       embedding = CASE WHEN $12 THEN $11::vector ELSE embedding END
     WHERE id = $1 AND buyer_id = $2
     RETURNING *`,
    [
      wantedId,
      buyerId,
      validated.title,
      validated.notes,
      validated.category,
      validated.condition,
      validated.budget_min_cents,
      validated.budget_max_cents,
      validated.currency,
      validated.reference_images,
      embedding ? JSON.stringify(embedding) : null,
      textChanged,
    ],
  );
  logWantedWrite("update", "success", buyerId);
  return rows[0];
}

export interface MyWantedRow extends WantedRow {
  response_count: number;
  unread_responses: number;
  /** True when a renew call would be accepted right now (expiring active or
   *  expired within grace) — the CTA flag for my_wanted views. */
  renewable: boolean;
}

/** The buyer's own wanteds, all statuses, newest first — the my_wanted read
 *  (spec §5 tool 2; /api/wanted/mine). Response counts skip soft-deleted
 *  response items; unread counts only published-unread responses. markRead
 *  stamps read_at on the returned wanteds' unread published responses —
 *  read → read is a no-op (the read_at IS NULL guard), never an error. */
export async function listMyWanted(
  buyerId: string,
  opts: { limit?: number; markRead?: boolean } = {},
): Promise<{ wanteds: MyWantedRow[]; markedRead: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
  const { rows } = await pool.query<MyWantedRow>(
    `SELECT w.id, w.buyer_id, w.title, w.notes, w.category, w.condition,
            w.budget_min_cents, w.budget_max_cents, w.currency, w.reference_images,
            w.status, w.expires_at, w.created_at, w.updated_at,
            COALESCE(r.total, 0)::int AS response_count,
            COALESCE(r.unread, 0)::int AS unread_responses,
            ((w.status = 'active' AND w.expires_at <= now() + interval '7 days')
             OR (w.status = 'expired' AND w.expires_at > now() - interval '30 days')) AS renewable
     FROM wanted_items w
     LEFT JOIN (
       SELECT wr.wanted_item_id,
              COUNT(*) FILTER (WHERE i.status <> 'deleted') AS total,
              COUNT(*) FILTER (WHERE i.status <> 'deleted'
                               AND wr.published_at IS NOT NULL AND wr.read_at IS NULL) AS unread
       FROM wanted_responses wr
       JOIN items i ON i.id = wr.item_id
       GROUP BY wr.wanted_item_id
     ) r ON r.wanted_item_id = w.id
     WHERE w.buyer_id = $1
     ORDER BY w.created_at DESC
     LIMIT $2`,
    [buyerId, limit],
  );
  let markedRead = 0;
  if (opts.markRead) {
    const ids = rows.filter((w) => w.unread_responses > 0).map((w) => w.id);
    if (ids.length > 0) {
      const marked = await pool.query(
        `UPDATE wanted_responses wr SET read_at = now()
         FROM wanted_items w
         WHERE w.id = wr.wanted_item_id AND w.buyer_id = $1
           AND wr.wanted_item_id = ANY($2::uuid[])
           AND wr.published_at IS NOT NULL AND wr.read_at IS NULL`,
        [buyerId, ids],
      );
      markedRead = marked.rowCount ?? 0;
    }
  }
  return { wanteds: rows, markedRead };
}

export interface WantedSearchFilters {
  q?: string;
  category?: string;
  condition?: string;
  currency?: string;
  /** "Wants at least my price": budget_max_cents IS NULL OR >= x — open
   *  budgets always match (spec §3.4). */
  budget_max_cents_gte?: number;
  limit: number;
  offset?: number;
}

/** THI-380 N4-style ILIKE escape — tighter than searchItems' JS escape
 *  (escapes backslash first): do NOT port searchItems' version here. */
function escapeLike(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/[%_]/g, (m) => `\\${m}`);
}

/** Public wanted search (spec §3.4) — exact predicate parity with
 *  searchItems, run against wanted_items: visibility = active AND not yet
 *  expired (the lazy guard — sweep lag never shows stale demand); NO photo
 *  requirement (a wanted is intent, not inventory); hybrid q with cosine
 *  0.15 floor + ILIKE union when embeddings configured, keyword ILIKE on
 *  title+notes otherwise; created_at DESC freshness ordering without q.
 *  Explicit columns only — buyer_id and the embedding vector are never
 *  selected (R4 discipline: they cannot leak into payloads). */
export async function searchWanted(
  filters: WantedSearchFilters,
): Promise<Array<WantedRow & { score: number }>> {
  const where: string[] = [`w.status = 'active'`, `w.expires_at > now()`];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.category) where.push(`w.category = ${add(filters.category.toLowerCase())}`);
  if (filters.condition) where.push(`w.condition = ${add(filters.condition)}`);
  if (filters.currency) where.push(`w.currency = ${add(filters.currency.toUpperCase())}`);
  if (filters.budget_max_cents_gte !== undefined) {
    where.push(`(w.budget_max_cents IS NULL OR w.budget_max_cents >= ${add(filters.budget_max_cents_gte)})`);
  }

  const q = filters.q?.trim();
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const cols = `w.id, w.buyer_id, w.title, w.notes, w.category, w.condition,
                w.budget_min_cents, w.budget_max_cents, w.currency, w.reference_images,
                w.status, w.expires_at, w.created_at, w.updated_at`;

  if (q) {
    const embedding = await embedText(q);
    const keywordParam = add(`%${escapeLike(q)}%`);
    if (embedding) {
      const vecParam = add(JSON.stringify(embedding));
      // Keyword leg applies to every wanted (a wanted created while
      // embeddings were unconfigured stays findable by keyword — the
      // evaluateListingForIntents asymmetry, N2); the cosine leg requires
      // the wanted to have an embedding (under-notifies, never over-notifies).
      // NULLS LAST: keyword-only wanteds rank after cosine-ranked ones.
      const { rows } = await pool.query<WantedRow & { score: number }>(
        `SELECT ${cols}, 1 - (w.embedding <=> ${vecParam}::vector) AS score
         FROM wanted_items w
         WHERE ${where.join(" AND ")}
           AND (w.title ILIKE ${keywordParam} OR w.notes ILIKE ${keywordParam}
                OR (w.embedding IS NOT NULL
                    AND 1 - (w.embedding <=> ${vecParam}::vector) > 0.15))
         ORDER BY w.embedding <=> ${vecParam}::vector NULLS LAST
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        params,
      );
      return rows;
    }
    const { rows } = await pool.query<WantedRow & { score: number }>(
      `SELECT ${cols}, 0 AS score
       FROM wanted_items w
       WHERE ${where.join(" AND ")}
         AND (w.title ILIKE ${keywordParam} OR w.notes ILIKE ${keywordParam})
       ORDER BY w.created_at DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return rows;
  }

  const { rows } = await pool.query<WantedRow & { score: number }>(
    `SELECT ${cols}, 0 AS score
     FROM wanted_items w
     WHERE ${where.join(" AND ")}
     ORDER BY w.created_at DESC
     LIMIT ${add(limit)} OFFSET ${add(offset)}`,
    params,
  );
  return rows;
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Column list shared by the single-wanted read paths (respond validation,
 *  getWantedById). buyer_id is included because these rows stay internal —
 *  wantedToPublic strips it before any external surface sees the row. */
export const WANTED_ROW_COLS = `id, buyer_id, title, notes, category, condition,
                                 budget_min_cents, budget_max_cents, currency, reference_images,
                                 status, expires_at, created_at, updated_at`;

/** Single-wanted public read for /wanted/:id — the same lazy visibility
 *  guard as searchWanted (§3.4): null for unknown ids AND for ended ones
 *  (expired status or past expires_at), so the page renders one 404 shape
 *  with no existence oracle. */
export async function getWantedById(id: string): Promise<WantedRow | null> {
  const { rows } = await pool.query<WantedRow>(
    `SELECT ${WANTED_ROW_COLS} FROM wanted_items
     WHERE id = $1 AND status = 'active' AND expires_at > now()`,
    [id],
  );
  return rows[0] ?? null;
}

/** Public wanted payload (spec §5): id/title/notes/category/condition,
 *  budget as a range object, reference images, timestamps, days_left, url.
 *  Never buyer_id, never the embedding vector, never a single price badge —
 *  the budget is a range by construction (§6.3). */
export function wantedToPublic(wanted: WantedRow) {
  const { id, buyer_id: _buyer, embedding: _embedding, ...rest } = wanted;
  return {
    ...rest,
    id,
    budget: {
      min_cents: wanted.budget_min_cents,
      max_cents: wanted.budget_max_cents,
      currency: wanted.currency,
    },
    days_left: Math.max(
      0,
      Math.ceil((wanted.expires_at.getTime() - Date.now()) / 86_400_000),
    ),
    url: `${publicBaseUrl()}/wanted/${id}`,
  };
}


/** Publish stamping (spec §5 publish hook, consumed by createItem and
 *  addItemImage in PR 3): when a listing becomes feed-visible (create with
 *  photos, or the first-photo publish), every pending response for that item
 *  is stamped now — once, idempotently. `published_at IS NULL` keeps
 *  re-publishes (and a respond-birth stamp racing this hook) from
 *  double-stamping. Pool-only on purpose: wanted.ts stays a leaf module so
 *  items.ts can import this without a cycle. Returns how many rows stamped
 *  so callers log counts only (no payload, docs/security.md §6). */
export async function markWantedResponsesPublished(itemId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE wanted_responses SET published_at = now()
     WHERE item_id = $1 AND published_at IS NULL`,
    [itemId],
  );
  return rowCount ?? 0;
}
