// Response loop (spec THI-439 rev 1 §5, B4 — PR 3): a seller replies to a
// wanted with a real listing; the buyer finds it in their responses. Lives in
// its own module (not src/wanted.ts) so the import graph stays acyclic —
// these functions touch items.ts (createItem rides the full listing rails),
// while items.ts imports wanted.ts for the publish-stamp hook.

import { pool, type ItemRow } from "./db.js";
import { logSecurityEvent } from "./security-events.js";
import { createItem, visibleInFeeds } from "./items.js";
import type { Attributes } from "./attributes.js";
import { type WantedRow, MAX_RESPONSES_PER_SELLER_PER_WANTED, WANTED_ROW_COLS } from "./wanted.js";

/** A response-loop rejection. `code` is the MCP error code the tool layer
 *  reports; `own_wanted` and `not_active` have their own codes because they
 *  are semantic failures an agent can explain to its user, not back-off. */
export class WantedResponseError extends Error {
  readonly code: string;
  constructor(code: "not_found" | "own_wanted" | "not_active" | "response_limit", message: string) {
    super(message);
    this.name = "WantedResponseError";
    this.code = code;
  }
}

/** §5 step 1–3, in order: validate the wanted (before any listing create —
 *  a rejected response must not burn the seller's listing quota or the
 *  embeddings call), createItem on the full rails (photo gate THI-305/308,
 *  listing caps, listing_write events), then the response row. The UNIQUE
 *  (wanted_item_id, item_id) constraint is the replay barrier; a fresh item
 *  id per response makes replays impossible rather than merely deduplicated.
 *
 *  Failure after the item was created (step 3) degrades gracefully per §5:
 *  the seller keeps the listing, the error is logged, and this still returns
 *  the item so the caller's next_steps are truthful. */
export async function respondToWanted(
  sellerId: string,
  wantedId: string,
  listing: {
    title: string;
    description?: string;
    category?: string;
    condition?: string;
    brand?: string | null;
    price_cents: number;
    currency?: string;
    location?: string | null;
    weight_grams?: number | null;
    dimensions_mm?: string | null;
    shipping_tier?: string;
    images?: string[];
    attributes?: Record<string, unknown>;
  },
): Promise<{ wanted: WantedRow; item: ItemRow; response: { id: string; published_at: Date | null } }> {
  // Step 1 — validate the wanted row before any write.
  const { rows: wantedRows } = await pool.query<WantedRow>(
    `SELECT ${WANTED_ROW_COLS} FROM wanted_items WHERE id = $1`,
    [wantedId],
  );
  const wanted = wantedRows[0];
  const reject = (code: "not_found" | "own_wanted" | "not_active" | "response_limit", message: string) => {
    logSecurityEvent({ type: "wanted_response", action: "respond", outcome: "rejected" }, { sellerId });
    throw new WantedResponseError(code, message);
  };
  if (!wanted) reject("not_found", `Wanted ${wantedId} not found.`);
  if (wanted.buyer_id === sellerId) {
    reject("own_wanted", "This is your own wanted — sellers respond to other buyers' wanteds.");
  }
  if (wanted.status !== "active" || wanted.expires_at.getTime() <= Date.now()) {
    reject("not_active", "This wanted is expired — it no longer accepts responses.");
  }
  const { rows: capRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM wanted_responses
     WHERE wanted_item_id = $1 AND seller_id = $2`,
    [wantedId, sellerId],
  );
  if (Number(capRows[0].count) >= MAX_RESPONSES_PER_SELLER_PER_WANTED) {
    reject(
      "response_limit",
      `You already responded to this wanted ${MAX_RESPONSES_PER_SELLER_PER_WANTED} times (per-wanted response cap).`,
    );
  }

  // Step 2 — the listing rides createItem's full rails: photo gate, listing
  // caps, listing_write events, intent fanout. Nothing is bypassed here; a
  // response is a real listing plus a link row (ADR 0007).
  const item = await createItem({
    seller_id: sellerId,
    title: listing.title,
    description: listing.description ?? "",
    category: listing.category ?? "other",
    condition: listing.condition ?? "good",
    brand: listing.brand ?? null,
    price_cents: listing.price_cents,
    currency: listing.currency ?? "EUR",
    location: listing.location ?? null,
    weight_grams: listing.weight_grams ?? null,
    dimensions_mm: listing.dimensions_mm ?? null,
    shipping_tier: listing.shipping_tier ?? "unknown",
    images: listing.images ?? [],
    attributes: (listing.attributes as Attributes | undefined) ?? {},
  });

  // Step 3 — the link row. A create with photos is already feed-visible: the
  // response is born published (§4 read model: only published responses
  // count toward the buyer's unread badge).
  const published = visibleInFeeds(item);
  try {
    const { rows: responseRows } = await pool.query<{ id: string; published_at: Date | null }>(
      `INSERT INTO wanted_responses (wanted_item_id, item_id, seller_id, published_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)
       RETURNING id, published_at`,
      [wantedId, item.id, sellerId, published],
    );
    logSecurityEvent({ type: "wanted_response", action: "respond", outcome: "success" }, { sellerId });
    if (published) {
      // Idempotent from birth (INSERT ... published_at = now()); stamping it
      // again at the hook would be a no-op, so log the publish here.
      logSecurityEvent(
        { type: "wanted_response", action: "publish", outcome: "success", count: 1 },
        { sellerId },
      );
    }
    return { wanted, item, response: responseRows[0] };
  } catch (err) {
    // Graceful degradation (§5): the seller keeps the listing; the response
    // link is lost but nothing fails from the seller's perspective.
    console.error(
      "wanted_response insert failed (listing unaffected)",
      err instanceof Error ? err.message : err,
    );
    logSecurityEvent({ type: "wanted_response", action: "respond", outcome: "degraded" }, { sellerId });
    return { wanted, item, response: { id: "", published_at: null } };
  }
}

/** Publish stamping (§5 publish hook): when a listing becomes feed-visible
 *  (createItem already-visible, or addItemImage's false→true photo publish),
 *  every pending response for that item is stamped now, once, idempotently —
 *  `published_at IS NULL` keeps re-publishes (and the birth-stamp above
 *  racing the hook) from double-stamping. Returns how many rows stamped so
 *  callers log counts only (no payload, docs/security.md §6). */
export async function markWantedResponsesPublished(itemId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE wanted_responses SET published_at = now()
     WHERE item_id = $1 AND published_at IS NULL`,
    [itemId],
  );
  return rowCount ?? 0;
}

/** The buyer's responses view for one wanted (§4 read model): published
 *  responses newest-first with their listings (soft-deleted or expired
 *  listings still show — the response already happened). Ownership scoping
 *  is the caller's (only the wanted's buyer reaches this via my_wanted);
 *  `markRead` stamps read_at on the listed unread ones and reports the count
 *  — same contract as listMatches (THI-360 PR 4): rows keep their pre-mark
 *  `read` state, read → read is a no-op. */
export async function listWantedResponses(
  buyerId: string,
  wantedId: string,
  opts: { markRead?: boolean; limit?: number } = {},
): Promise<{
  responses: Array<{
    id: string;
    item: ItemRow;
    created_at: Date;
    published_at: Date;
    read: boolean;
  }>;
  markedRead: number;
  /** Exact published-response count for the wanted — the total next to the
   *  truncated latest-`limit` window (THI-442 W4: responses-per-wanted is
   *  bounded per seller, not across sellers, so this read must bound its
   *  own payload). */
  total: number;
}> {
  // W4 cap: latest 20 by default, never more — a griefer seller set cannot
  // bloat the buyer's read. `total` stays exact so nothing is hidden.
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 20);
  const { rows } = await pool.query<{
    id: string;
    item: ItemRow & { created_at: string };
    created_at: Date;
    published_at: Date | null;
    read_at: Date | null;
  }>(
    // to_jsonb(i): a whole-row reference comes back as a row-literal string
    // in node-postgres; JSON form keeps the ItemRow shape (dates re-parsed
    // below — they survive as ISO strings through jsonb).
    `SELECT r.id, r.created_at, r.published_at, r.read_at,
            to_jsonb(i) AS item
     FROM wanted_responses r
     JOIN wanted_items w ON w.id = r.wanted_item_id
     JOIN items i ON i.id = r.item_id
     WHERE r.wanted_item_id = $1 AND w.buyer_id = $2 AND r.published_at IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT $3`,
    [wantedId, buyerId, limit],
  );
  // Exact published total beside the truncated window (W4).
  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM wanted_responses
     WHERE wanted_item_id = $1 AND published_at IS NOT NULL`,
    [wantedId],
  );
  if (opts.markRead) {
    const ids = rows.filter((r) => r.read_at === null).map((r) => r.id);
    if (ids.length > 0) {
      const marked = await pool.query(
        `UPDATE wanted_responses SET read_at = now()
         WHERE id = ANY($1::uuid[]) AND read_at IS NULL`,
        [ids],
      );
      return {
        responses: rows.map((r) => ({
          ...r,
          item: { ...r.item, created_at: new Date(r.item.created_at) },
          published_at: r.published_at as Date, // filtered IS NOT NULL above
          read: r.read_at !== null,
        })),
        markedRead: marked.rowCount ?? 0,
        total: Number(total.rows[0].count),
      };
    }
  }
  return {
    responses: rows.map((r) => ({
      ...r,
      item: { ...r.item, created_at: new Date(r.item.created_at) },
      published_at: r.published_at as Date, // filtered IS NOT NULL above
      read: r.read_at !== null,
    })),
    markedRead: 0,
    total: Number(total.rows[0].count),
  };
}
