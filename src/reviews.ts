// Order reviews — write side (spec docs/specs/order-reviews.md, PR 1).
//
// The buyer of an order whose terminal state left the seller paid and the
// buyer keeping the item — `completed` (off_platform) or `paid_out`
// (stripe) — reviews the seller once per order: 1–5 stars + optional text
// ≤ 500 chars, editable for 30 days anchored on created_at (never moved).
// Both eligible states are terminal with no outgoing transitions, so an
// order can never leave eligibility after a review is posted: no
// keep/hide/delete-on-refund machinery exists or is needed.
//
// Layering mirrors src/reports.ts: typed module errors, all SQL
// parameterized, identity never trusted from the client — seller_id,
// buyer_id, item_id and the display snapshots (buyer_first_name,
// item_title) are read from the order/items/sellers rows server-side in
// the same INSERT path. src/routes.ts only wires auth + validation.
//
// F1 on the review surface (finding SR-5 on PR #319, THI-979): signup
// defaults display_name to the email local-part, so the first-name
// snapshot can be an email-derived handle. The snapshot is masked at
// insert with the shared F1 exact-match mask (src/display-names.ts,
// maskEmailDerivedHandle — the same rule sellerToPublic applies, with the
// buyer-shaped constant), and listSellerReviews re-masks at read time so
// rows already stored unmasked before this fix never publish a handle
// either. The buyer's email is fetched in both paths as mask input only
// and is never serialized.
//
// Abuse posture (spec §abuse rules):
// - one RateLimiter bucket for review WRITES (POST + PATCH alike),
//   reviews:acct:<account id>, 20/hour; 429s log a security_events line.
// - UNIQUE (order_id) is the dedupe barrier; a racing double-submit hits
//   23505 and is mapped to the same friendly 409 as any duplicate.
// - review text goes through the same reject-never-rewrite contact
//   screening as wanted listings (screenReviewText), on POST and PATCH
//   alike — an edit is as much a publish as the original post. The
//   rejection message is generic and never names which rule tripped.
// - 404 (not 403) for unknown OR not-owned orders: the buyer's own order
//   page is the only caller, and an unknown/not-owned id must not become
//   an order-existence oracle — same posture as the web order-status page.
//
// Off-platform farming signal (spec §defenses, b): when a buyer→seller
// pair's terminal review-eligible orders cross
// REVIEW_PAIR_ANOMALY_THRESHOLD, emitReviewPairAnomalyIfCrossing logs
// exactly one `review_pair_anomaly` line — the hook rides the
// applyTransition commit path (src/orders.ts), never this module's writes.

import type { OrderStatus } from "./orders.js";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { RateLimiter } from "./rate-limit.js";
import { logSecurityEvent } from "./security-events.js";
import { screenReviewText } from "./contact-scrub.js";
import { emailLocalPart, maskEmailDerivedHandle, MASKED_BUYER_FIRST_NAME } from "./display-names.js";

// The review-surface F1 constant lives with the shared mask rule in
// src/display-names.ts (one rule, one home — sellerToPublic masks through
// the same helper). Re-exported so review-surface import sites keep their
// module-local path.
export { MASKED_BUYER_FIRST_NAME } from "./display-names.js";

/** Terminal statuses a review may attach to — exactly the states where the
 *  deal ended with the seller paid and the buyer keeping the item (spec
 *  §eligibility). Terminal ⇒ an order can never leave this set. */
export const REVIEW_ELIGIBLE_STATUSES: readonly OrderStatus[] = ["completed", "paid_out"];

/** Edit window, days from created_at (spec rule). */
export const REVIEW_EDIT_WINDOW_DAYS = 30;

/** Text hard cap (spec rule); mirrored by the DB CHECK. */
export const MAX_REVIEW_TEXT_CHARS = 500;

/** First-name snapshot cap, the DB CHECK's upper bound: trim → first token
 *  → cap 40. Also the projection width for the read-time legacy mask. */
export const MAX_BUYER_FIRST_NAME_CHARS = 40;

/** Per-pair aggregate cap K (spec §farming defenses, a): the public summary
 *  — average + count, profile and item card — counts at most the K newest
 *  published reviews per distinct buyer→seller pair. The list itself is
 *  uncapped. Consumed by the read path (src/reviews.ts listSellerReviews,
 *  PR 2); the constant lives here so the spec's v1 values are one home. */
export const REVIEW_AGGREGATE_PAIR_CAP = 3;

/** Pair anomaly threshold N (spec §farming defenses, b): a buyer→seller pair
 *  reaching this many terminal review-eligible orders emits exactly one
 *  `review_pair_anomaly` operator signal (see emitReviewPairAnomalyIfCrossing). */
export const REVIEW_PAIR_ANOMALY_THRESHOLD = 10;

/** Spec: 20 review writes per account per hour (POST + PATCH, one bucket).
 *  Injectable so tests can exercise the DB-side paths without tripping the
 *  shared bucket. */
export const reviewWriteLimiter = new RateLimiter(20, 60 * 60_000);

/** Generic contact-screening rejection — never names which rule tripped
 *  (no one-rule-at-a-time evasion oracle). */
export const REVIEW_CONTACT_MESSAGE =
  "Reviews can't include contact details — please describe the order in words.";

export type ReviewErrorCode =
  | "not_found" // unknown order, or caller is not the buyer (no oracle: same 404)
  | "not_eligible" // order not in completed/paid_out yet
  | "duplicate" // UNIQUE (order_id) — friendly, not a fault
  | "validation" // rating/text shape
  | "contact_info" // screening hit (generic message)
  | "rate_limited" // hourly account bucket
  | "none_yet" // PATCH/GET on an unreviewed order
  | "edit_window_closed" // past the 30-day window
  | "hidden"; // under moderation: read-only

export class ReviewError extends Error {
  constructor(readonly code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

/** A review row as stored (write-side shape; the public read shape is
 *  narrower — spec §display data and privacy). */
export interface ReviewRow {
  id: string;
  order_id: string;
  seller_id: string;
  buyer_id: string;
  item_id: string;
  rating: number;
  text: string | null;
  status: "published" | "hidden";
  buyer_first_name: string;
  item_title: string;
  created_at: Date;
  edited_at: Date | null;
}

/** The caller's own review as returned by the order routes — full row
 *  data (their own), plus the edit-window projection. */
export interface OwnReviewView {
  rating: number;
  text: string | null;
  status: "published" | "hidden";
  created_at: Date;
  edited_at: Date | null;
  editable_until: Date;
  editable: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display snapshot for the meta line: trim, then the first
 *  whitespace-separated token, capped at 40 chars; empty-after-trim names
 *  fall back to the literal "Buyer" so the INSERT can never violate the
 *  NOT NULL + 1–40 CHECK (spec §display data, F6). */
export function buyerFirstName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return "Buyer";
  return trimmed.split(/\s+/)[0]!.slice(0, MAX_BUYER_FIRST_NAME_CHARS);
}

/** The first-name snapshot actually stored (THI-979): the plain projection
 *  above, but with the F1 exact-match mask decided on the UNCAPPED first
 *  word — a local-part longer than the 40-char column cap must still mask,
 *  not publish a 40-char prefix of the handle. Unmasked inputs keep the
 *  existing projection (first token, cap, "Buyer" fallback). */
export function buyerFirstNameSnapshot(displayName: string, email: string | null): string {
  const trimmed = displayName.trim();
  const firstWord = trimmed ? trimmed.split(/\s+/)[0]! : "";
  const masked = maskEmailDerivedHandle(firstWord, emailLocalPart(email), MASKED_BUYER_FIRST_NAME);
  return masked === firstWord ? buyerFirstName(displayName) : masked;
}

/** Editable-until anchor: created_at + window. The only clock in the
 *  module is `now` (injectable); created_at is never moved. */
function editableUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60_000);
}

function toOwnView(row: ReviewRow, now: Date): OwnReviewView {
  const until = editableUntil(row.created_at);
  return {
    rating: row.rating,
    text: row.text,
    status: row.status,
    created_at: row.created_at,
    edited_at: row.edited_at,
    editable_until: until,
    editable: row.status === "published" && now.getTime() <= until.getTime(),
  };
}

interface OrderForReview {
  seller_id: string;
  buyer_id: string;
  status: OrderStatus;
  item_id: string;
  item_title: string;
  buyer_display_name: string;
  /** Mask input for the first-name snapshot only — never serialized. */
  buyer_email: string | null;
}

/** The order join the write/read paths share: order row FOR SHARE (TOCTOU
 *  guard, reports precedent) + the item title and buyer display name for
 *  the server-side snapshots. Null when the order does not exist. */
async function orderForReview(
  db: PoolClient | typeof pool,
  orderId: string,
): Promise<OrderForReview | null> {
  const { rows } = await db.query<OrderForReview>(
    `SELECT o.seller_id, o.buyer_id, o.status, o.item_id,
            i.title AS item_title, s.display_name AS buyer_display_name,
            s.email AS buyer_email
       FROM orders o
       JOIN items i ON i.id = o.item_id
       JOIN sellers s ON s.id = o.buyer_id
      WHERE o.id = $1
        FOR SHARE OF o`,
    [orderId],
  );
  return rows[0] ?? null;
}

/** Validates rating/text shape; returns the validated rating and the
 *  stored text (null when empty or whitespace-only). Throws
 *  ReviewError("validation"|"contact_info"). */
function validateWrite(rating: unknown, text: unknown): { rating: number; text: string | null } {
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ReviewError("validation", "Pick a star rating from 1 to 5.");
  }
  if (text !== undefined && text !== null && typeof text !== "string") {
    throw new ReviewError("validation", "Review text must be a string.");
  }
  const trimmed = typeof text === "string" ? text.trim() : "";
  const stored = trimmed.length ? trimmed : null;
  if (stored !== null && stored.length > MAX_REVIEW_TEXT_CHARS) {
    throw new ReviewError("validation", `Review text is limited to ${MAX_REVIEW_TEXT_CHARS} characters.`);
  }
  if (stored !== null && screenReviewText(stored) !== null) {
    throw new ReviewError("contact_info", REVIEW_CONTACT_MESSAGE);
  }
  return { rating, text: stored };
}

/** The shared hourly write bucket (spec key: reviews:acct:<id>), POST and
 *  PATCH alike. 429 logs the security_events rate_limit line. */
function allowWrite(accountId: string, limiter: RateLimiter): void {
  if (!limiter.allow(`reviews:acct:${accountId}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/orders/:id/review" }, { sellerId: accountId });
    throw new ReviewError("rate_limited", "Too many review writes — try again later.");
  }
}

export interface PostReviewInput {
  orderId: string;
  buyerId: string;
  rating: unknown;
  text?: unknown;
  limiter?: RateLimiter;
}

/** absent → published (spec state machine). Throws ReviewError; returns the
 *  stored row and the own-view projection for the 201 body. */
export async function postReview(
  input: PostReviewInput,
  limiter: RateLimiter = reviewWriteLimiter,
): Promise<{ review: ReviewRow; view: OwnReviewView }> {
  if (!UUID_RE.test(input.orderId)) {
    throw new ReviewError("not_found", "Order not found.");
  }
  const { rating, text } = validateWrite(input.rating, input.text);
  allowWrite(input.buyerId, limiter);

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      const order = await orderForReview(db, input.orderId);
      // Unknown order and not-your-order are the same 404 — no oracle.
      if (!order || order.buyer_id !== input.buyerId) {
        throw new ReviewError("not_found", "Order not found.");
      }
      if (!REVIEW_ELIGIBLE_STATUSES.includes(order.status)) {
        throw new ReviewError("not_eligible", "You can review once the order is complete.");
      }
      const inserted = await db.query<ReviewRow>(
        `INSERT INTO order_reviews
           (order_id, seller_id, buyer_id, item_id, rating, text, buyer_first_name, item_title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, order_id, seller_id, buyer_id, item_id, rating, text, status,
                   buyer_first_name, item_title, created_at, edited_at`,
        [
          input.orderId, order.seller_id, order.buyer_id, order.item_id,
          rating, text,
          buyerFirstNameSnapshot(order.buyer_display_name, order.buyer_email), order.item_title,
        ],
      );
      await db.query("COMMIT");
      const review = inserted.rows[0]!;
      return { review, view: toOwnView(review, new Date()) };
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      // Concurrent double-submit lost the UNIQUE (order_id) race — the
      // same friendly duplicate a second POST would see.
      if ((err as { code?: string }).code === "23505") {
        throw new ReviewError("duplicate", "You already reviewed this order. You can edit it for 30 days.");
      }
      throw err;
    }
  } finally {
    db.release();
  }
}

export interface EditReviewInput {
  orderId: string;
  buyerId: string;
  rating: unknown;
  /** Form semantics: replaces both fields; omitted text ⇒ cleared to NULL. */
  text?: unknown;
  limiter?: RateLimiter;
  now?: Date;
}

/** published → published (edited, ≤ 30 d from created_at); hidden → 403;
 *  past the window → 403. Throws ReviewError; returns the updated row. */
export async function editReview(
  input: EditReviewInput,
  limiter: RateLimiter = reviewWriteLimiter,
): Promise<{ review: ReviewRow; view: OwnReviewView }> {
  if (!UUID_RE.test(input.orderId)) {
    throw new ReviewError("not_found", "Order not found.");
  }
  const { rating, text } = validateWrite(input.rating, input.text);
  allowWrite(input.buyerId, limiter);
  const now = input.now ?? new Date();

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      const order = await orderForReview(db, input.orderId);
      if (!order || order.buyer_id !== input.buyerId) {
        throw new ReviewError("not_found", "Order not found.");
      }
      const found = await db.query<ReviewRow>(
        `SELECT id, order_id, seller_id, buyer_id, item_id, rating, text, status,
                buyer_first_name, item_title, created_at, edited_at
           FROM order_reviews WHERE order_id = $1 FOR UPDATE`,
        [input.orderId],
      );
      const row = found.rows[0];
      if (!row) {
        throw new ReviewError("none_yet", "No review yet for this order.");
      }
      if (row.status === "hidden") {
        throw new ReviewError("hidden", "This review is under moderation and can't be edited.");
      }
      if (now.getTime() > editableUntil(row.created_at).getTime()) {
        throw new ReviewError("edit_window_closed", "Reviews can be edited for 30 days.");
      }
      const updated = await db.query<ReviewRow>(
        `UPDATE order_reviews SET rating = $2, text = $3, edited_at = now()
          WHERE id = $1
          RETURNING id, order_id, seller_id, buyer_id, item_id, rating, text, status,
                    buyer_first_name, item_title, created_at, edited_at`,
        [row.id, rating, text],
      );
      await db.query("COMMIT");
      const review = updated.rows[0]!;
      return { review, view: toOwnView(review, now) };
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    db.release();
  }
}

/** The order page's posted-state + Edit view: the caller's own review in
 *  full (their data) or null; 404 for unknown/not-the-buyer orders (no
 *  oracle). `editable` is false once past the window or under moderation. */
export async function getOrderReview(
  input: { orderId: string; callerId: string; now?: Date },
): Promise<OwnReviewView | null> {
  if (!UUID_RE.test(input.orderId)) {
    throw new ReviewError("not_found", "Order not found.");
  }
  const order = await orderForReview(pool, input.orderId);
  if (!order || order.buyer_id !== input.callerId) {
    throw new ReviewError("not_found", "Order not found.");
  }
  const { rows } = await pool.query<ReviewRow>(
    `SELECT id, order_id, seller_id, buyer_id, item_id, rating, text, status,
            buyer_first_name, item_title, created_at, edited_at
       FROM order_reviews WHERE order_id = $1`,
    [input.orderId],
  );
  const row = rows[0];
  return row ? toOwnView(row, input.now ?? new Date()) : null;
}

/** Farming defense (b), spec: counts the pair's terminal review-eligible
 *  orders and emits exactly one `review_pair_anomaly` line when the count
 *  is N at the check (the crossing; monotonicity makes it once per pair —
 *  no transition leaves a terminal state, so the count only grows). Called
 *  by applyTransition after a successful transition into completed/paid_out;
 *  never throws to the caller (a signal must not fail an order transition).
 *  Reads committed data on the pool: for caller-owned transactions the row
 *  may not be committed yet, in which case the count lags one order and the
 *  crossing fires on the pair's next terminal transition — still exactly
 *  once, just one order later. */
export async function emitReviewPairAnomalyIfCrossing(buyerId: string, sellerId: string): Promise<void> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE buyer_id = $1 AND seller_id = $2 AND status IN ('completed', 'paid_out')`,
    [buyerId, sellerId],
  );
  const n = rows[0]?.n ?? 0;
  if (n === REVIEW_PAIR_ANOMALY_THRESHOLD) {
    logSecurityEvent({ type: "review_pair_anomaly", buyer_id: buyerId, seller_id: sellerId, terminal_orders: n });
  }
}

// ---------------------------------------------------------------------------
// Public read side (spec PR 2): the seller's published review list and the
// per-pair-capped summary, shared byte-for-byte by the public HTTP route and
// the get_seller_reviews MCP tool (the tool adds exactly one field,
// content_provenance). Serialization happens here, once, so both surfaces
// cannot drift.

/** The public shape of one published review (privacy: buyer's first-name
 *  snapshot + item-title snapshot — never buyer ids, emails or order ids;
 *  the review's own unguessable `id` is exposed because that is the value
 *  the report route accepts, closing the moderation loop). */
/** The public summary shape: average (one decimal, null when there are no
 *  published reviews) + count over the per-pair capped set. */
export interface SellerReviewSummary {
  average: number | null;
  count: number;
}

/** The public summary — average (one decimal) + count over the per-pair
 *  capped published set (K = REVIEW_AGGREGATE_PAIR_CAP newest per distinct
 *  buyer, spec §farming defense a). Hidden rows are invisible here. One home
 *  for the aggregate: listSellerReviews (below) and getSellerSummary's
 *  seller card (src/sellers.ts, THI-1755 seam wiring) both consume it, so
 *  the two public surfaces cannot drift. Caller must pass a well-formed
 *  seller id (listSellerReviews validates; getSellerSummary has already
 *  resolved the seller row). */
export async function sellerReviewSummary(sellerId: string): Promise<SellerReviewSummary> {
  const summary = await pool.query<{ n: number; avg: string | null }>(
    `WITH capped AS (
       SELECT rating FROM (
         SELECT rating, ROW_NUMBER() OVER (
                  PARTITION BY buyer_id ORDER BY created_at DESC, id DESC) AS rn
           FROM order_reviews
          WHERE seller_id = $1 AND status = 'published'
       ) t WHERE rn <= $2
     )
     SELECT COUNT(*)::int AS n, AVG(rating) AS avg FROM capped`,
    [sellerId, REVIEW_AGGREGATE_PAIR_CAP],
  );
  const count = summary.rows[0]?.n ?? 0;
  const average = count > 0 && summary.rows[0]?.avg != null ? Math.round(Number(summary.rows[0].avg) * 10) / 10 : null;
  return { average, count };
}

export interface PublicSellerReviews {
  seller_id: string;
  summary: { average: number | null; count: number };
  reviews: Array<{
    id: string;
    rating: number;
    text: string | null;
    first_name: string;
    item_title: string;
    created_at: string;
  }>;
  next_before: string | null;
}

/** Encodes the `(created_at, id)` pagination cursor. */
function reviewCursor(row: { created_at: Date; id: string }): string {
  return `${row.created_at.toISOString()}|${row.id}`;
}

/** Decodes a cursor handed back by a previous response; null when malformed.
 *  Format: "<created_at ISO 8601>|<review id>" — exactly two parts, a
 *  parseable timestamp and a UUID. Malformed ⇒ the caller sees a 400, never
 *  a silently-widened first page. */
export function parseReviewCursor(raw: string): { createdAt: Date; id: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 2) return null;
  const createdAt = new Date(parts[0]!);
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(parts[1]!)) return null;
  return { createdAt, id: parts[1]! };
}

export interface ListSellerReviewsInput {
  sellerId: string;
  /** 0–50; 0 = summary only (the item-page seller card). */
  limit: number;
  /** Opaque cursor from a previous response's next_before. */
  before?: string;
}

/** The shared public read: published reviews of one seller, newest first
 *  `(created_at DESC, id DESC)`, plus the per-pair-capped summary
 *  (K = REVIEW_AGGREGATE_PAIR_CAP newest per distinct buyer — farming
 *  defense a). The list itself is uncapped. Throws ReviewError:
 *  not_found (unknown seller) | validation (malformed cursor). */
export async function listSellerReviews(input: ListSellerReviewsInput): Promise<PublicSellerReviews> {
  if (!UUID_RE.test(input.sellerId)) {
    throw new ReviewError("not_found", "Seller not found.");
  }
  let before: { createdAt: Date; id: string } | undefined;
  if (input.before !== undefined) {
    const parsed = parseReviewCursor(input.before);
    if (!parsed) {
      throw new ReviewError("validation", "Invalid pagination cursor.");
    }
    before = parsed;
  }

  const seller = await pool.query("SELECT 1 FROM sellers WHERE id = $1", [input.sellerId]);
  if (seller.rowCount === 0) {
    throw new ReviewError("not_found", "Seller not found.");
  }

  // Summary over the per-pair capped set — the shared aggregate above, so
  // the reviews surface and the seller card (get_seller_summary) serve the
  // exact same numbers (spec §farming defense a).
  const { average, count } = await sellerReviewSummary(input.sellerId);

  // The list: uncapped, newest first, tie-break by id so same-second rows
  // are never skipped or repeated across pages. LIMIT n+1 detects has-more
  // without a second COUNT. The cursor predicate is one static SQL string:
  // NULL params (first page) short-circuit the row comparison. The buyers'
  // emails join in as F1 mask input only (read-time mask below) — never
  // serialized.
  if (input.limit === 0) {
    return { seller_id: input.sellerId, summary: { average, count }, reviews: [], next_before: null };
  }
  const rows = await pool.query<{ id: string; rating: number; text: string | null; buyer_first_name: string; item_title: string; created_at: Date; buyer_email: string | null }>(
    `SELECT r.id, r.rating, r.text, r.buyer_first_name, r.item_title, r.created_at,
            s.email AS buyer_email
       FROM order_reviews r
       JOIN sellers s ON s.id = r.buyer_id
      WHERE r.seller_id = $1 AND r.status = 'published'
        AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $4`,
    [input.sellerId, before?.createdAt ?? null, before?.id ?? null, input.limit + 1],
  );
  const page = rows.rows.slice(0, input.limit);
  const hasMore = rows.rows.length > input.limit;
  return {
    seller_id: input.sellerId,
    summary: { average, count },
    reviews: page.map((r) => ({
      id: r.id,
      rating: r.rating,
      text: r.text,
      // Read-time F1 mask (THI-979): rows stored before the insert-path fix
      // can carry an email-derived handle, so the public surface never
      // trusts the stored snapshot alone. The stored snapshot is a first
      // word capped at MAX_BUYER_FIRST_NAME_CHARS, hence a snapshot taken
      // from a longer local-part is its prefix — compare in that projection
      // space (a no-op slice, i.e. the plain exact match, for normal
      // handles). Runs on every published row, so the invariant
      // "public payloads never carry an email-derived first name" holds for
      // both legacy and new rows.
      first_name: maskEmailDerivedHandle(
        r.buyer_first_name,
        emailLocalPart(r.buyer_email)?.slice(0, MAX_BUYER_FIRST_NAME_CHARS),
        MASKED_BUYER_FIRST_NAME,
      ),
      item_title: r.item_title,
      created_at: r.created_at.toISOString(),
    })),
    next_before: hasMore && page.length > 0 ? reviewCursor(page[page.length - 1]!) : null,
  };
}
