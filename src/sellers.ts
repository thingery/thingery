// Public read-only seller summary (THI-923 "Who's selling", spec v2 on
// THI-933). Backs the get_seller_summary MCP tool: the item-page seller card
// and the public seller profile. Follows the src/wanted.ts precedent — an
// own-parameterized query layer over sellers/items/orders with an allowlist
// view-model (sellerToPublic). No schema change: every field is derivable
// from tables that exist today.
//
// Privacy invariants (spec v2, F1): the seller's email is consumed
// server-side ONLY for the display-name guard below and is never serialized;
// nothing outside the allowlist (stripe ids, timestamps, profile JSONB,
// verification state, API keys) ever leaves this module.

import { pool, type ItemRow } from "./db.js";
import { sellerPayoutReady } from "./order-flow.js";
import { orderFlowConfig } from "./config.js";
import { SOLD_COUNT_STATUSES } from "./orders.js";
import { emailLocalPart, maskEmailDerivedHandle, MASKED_DISPLAY_NAME } from "./display-names.js";

// The F1 mask rule and its seller-surface constant live in src/display-names.ts
// (one rule, one home — reviews mask through the same helper). Re-exported so
// existing import sites keep their surface-local path.
export { MASKED_DISPLAY_NAME } from "./display-names.js";

/** Input page size cap, the search_items convention (limit 1–50). */
export const SELLER_LISTINGS_MAX_LIMIT = 50;
/** Input offset cap, the SEARCH_MAX_OFFSET convention (0–450). */
export const SELLER_LISTINGS_MAX_OFFSET = 450;

/** F1 display-name guard (spec v2): signup names a new account after the
 *  email local-part (src/routes.ts /signup → email.split("@")[0]), so
 *  publishing display_name raw would publish an email-derived handle for
 *  sellers who never chose a name. sellerToPublic substitutes the neutral
 *  handle on an exact local-part match, via the shared rule in
 *  src/display-names.ts (maskEmailDerivedHandle + MASKED_DISPLAY_NAME,
 *  re-exported above). Deliberately-chosen names that happen to equal the
 *  local-part are masked too — accepted over-blocking for a public surface
 *  (CEO decision, THI-923). */

/** Thrown when sellerId matches no seller row; the tool layer maps it to the
 *  typed `not_found` error (same treatment as getItem's callers). */
export class SellerNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Seller not found");
    this.name = "SellerNotFoundError";
  }
}

/** The seller object inside a get_seller_summary reply — the allowlist.
 *  No email, no stripe fields, no timestamps beyond joined_month. */
export interface SellerSummarySeller {
  id: string;
  display_name: string;
  /** YYYY-MM (UTC) — month precision on purpose: a public surface must not
   *  leak the exact account-creation timestamp. */
  joined_month: string;
  /** Modal location over the seller's located feed-visible listings, or null
   *  when none has a location. */
  ships_from: string | null;
  /** Orders that reached payment (SOLD_COUNT_STATUSES). */
  sold_count: number;
  /** Feed-visible active listings (status active + photo gate), any page. */
  active_listings_total: number;
  /** Whether card payment through Thingery is available for this seller
   *  today — same expression as create_order/the item page (F-parity). */
  payment_available: boolean;
  /** THI-925 seam: reviews land in a later PR; constant zeros until then. */
  reviews: { count: 0; average: null };
}

/** Minimal shape sellerToPublic consumes. `email` is the sensitive input for
 *  the F1 guard — it must not appear in the returned object. */
export interface SellerSummaryInputRow {
  id: string;
  display_name: string;
  email: string | null;
  joined_month: string;
}

/** Allowlist view-model: the only seller fields that cross the public
 *  boundary, built from the row + the aggregates this module computed. */
export function sellerToPublic(
  row: SellerSummaryInputRow,
  aggregates: {
    ships_from: string | null;
    sold_count: number;
    active_listings_total: number;
    payment_available: boolean;
  },
): SellerSummarySeller {
  // F1 guard via the shared helper: an email-derived handle is never
  // published silently. The email exists only as mask input — the object
  // literal below cannot include it (allowlist construction, not spread).
  return {
    id: row.id,
    display_name: maskEmailDerivedHandle(row.display_name, emailLocalPart(row.email), MASKED_DISPLAY_NAME),
    joined_month: row.joined_month,
    ships_from: aggregates.ships_from,
    sold_count: aggregates.sold_count,
    active_listings_total: aggregates.active_listings_total,
    payment_available: aggregates.payment_available,
    reviews: { count: 0, average: null },
  };
}

export interface SellerSummary {
  seller: SellerSummarySeller;
  /** One page of the seller's feed-visible active listings, newest first.
   *  Rows carry the joined seller_payout_ready so the tool layer can map
   *  them through itemToPublic exactly like getItem rows. */
  listings: ItemRow[];
  /** Number of listings on this page (≤ limit). */
  count: number;
  /** One-row lookahead: offset + count accepted another page. */
  hasMore: boolean;
}

/** Aggregates + one page of listings for one seller, in four round trips.
 *  Read-only; throws SellerNotFoundError for an unknown id. */
export async function getSellerSummary(
  sellerId: string,
  opts: { limit: number; offset: number },
): Promise<SellerSummary> {
  const { limit, offset } = opts;

  // 1. Seller row. `email` is read here solely for the F1 guard inside
  //    sellerToPublic; `joined_month` is truncated to YYYY-MM server-side
  //    (UTC) so the exact creation timestamp never reaches JS.
  const seller = await pool.query<{
    id: string;
    display_name: string;
    email: string | null;
    joined_month: string;
  }>(
    `SELECT id, display_name, email,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS joined_month
       FROM sellers WHERE id = $1`,
    [sellerId],
  );
  const row = seller.rows[0];
  if (!row) throw new SellerNotFoundError();

  // 2. Item aggregates in one round trip. FEED_VISIBLE is the exact public
  //    predicate from src/items.ts (status active + photo gate); ships_from
  //    is the modal location over located feed-visible listings with a
  //    deterministic tie-break (count DESC, location ASC).
  const agg = await pool.query<{
    active_listings_total: number;
    ships_from: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE i.status = 'active'
                        AND (NOT i.photo_required OR cardinality(i.images) > 0))::int
         AS active_listings_total,
       (
         SELECT i2.location FROM items i2
          WHERE i2.seller_id = $1 AND i2.status = 'active'
            AND (NOT i2.photo_required OR cardinality(i2.images) > 0)
            AND i2.location IS NOT NULL AND i2.location <> ''
          GROUP BY i2.location
          ORDER BY count(*) DESC, i2.location ASC
          LIMIT 1
       ) AS ships_from
     FROM items i WHERE i.seller_id = $1`,
    [sellerId],
  );

  // 3. sold_count. The status set lives ONLY in SOLD_COUNT_STATUSES
  //    (src/orders.ts) — this query consumes it and must not restate it
  //    (F3: drift here = buyers misled about who actually sells).
  const sold = await pool.query<{ sold_count: number }>(
    `SELECT COUNT(*)::int AS sold_count FROM orders
      WHERE seller_id = $1 AND status = ANY($2)`,
    [sellerId, [...SOLD_COUNT_STATUSES]],
  );

  // 4. Listings page: the getItem select (i.* + joined seller_payout_ready),
  //    feed-visible actives only, newest first, LIMIT+1 for the one-row
  //    lookahead (the search_items has_more convention). N.B. `s` here is
  //    the same join getItem uses — a full seller row join is NOT needed;
  //    only the two payout columns are read, and neither is serialized (the
  //    boolean seller_payout_ready is the public part; itemToPublic allows
  //    it through as payment_available inputs).
  const page = await pool.query<ItemRow>(
    `SELECT i.*, (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL)
              AS seller_payout_ready
       FROM items i LEFT JOIN sellers s ON s.id = i.seller_id
      WHERE i.seller_id = $1 AND i.status = 'active'
        AND (NOT i.photo_required OR cardinality(i.images) > 0)
      ORDER BY i.created_at DESC, i.id
      LIMIT $2 OFFSET $3`,
    [sellerId, limit + 1, offset],
  );

  // Seller-level payment availability: the shared expression, imported and
  // reused verbatim (spec v2) — orderFlowConfig().stripePaymentsEnabled &&
  // sellerPayoutReady(), never a local reimplementation (drift = buyers
  // misled about payment). Same inputs as create_order's gate.
  const paymentAvailable =
    orderFlowConfig().stripePaymentsEnabled && (await sellerPayoutReady(sellerId));

  return {
    seller: sellerToPublic(row, {
      ships_from: agg.rows[0].ships_from,
      sold_count: sold.rows[0].sold_count,
      active_listings_total: agg.rows[0].active_listings_total,
      payment_available: paymentAvailable,
    }),
    listings: page.rows.slice(0, limit),
    count: Math.min(page.rows.length, limit),
    hasMore: page.rows.length > limit,
  };
}
