// Item reports (spec docs/specs/item-reports.md, THI-788 step 2 / THI-617
// MVP): signed-in users flag a listing with a canned cause + required
// motivation; every report is one row for board triage.
//
// Who may report: any signed-in account except the item's own seller
// (self-reports are a client bug, not a signal). Anonymous users never
// reach this module — the route 401s first, and the frontend hides the
// action entirely.
//
// Dedupe is durable: UNIQUE (reporter_account_id, target_item_id) — one
// report per reporter per item, ever. A concurrent double-submit races the
// constraint and the loser is mapped to the same friendly duplicate error
// (23505), so the client can never observe a raw constraint violation.
//
// Abuse is bounded by one layer on top of the dedupe: 5 reports per account
// per hour (rate-limit.ts bucket keyed reports:acct:<id>, scaffold-grade
// like every existing limiter). 429s log a security_events row (THI-144).
//
// State machine (explicit, spec §state machine): status open → resolved |
// dismissed. v1 ships only INSERT (open); the CHECK constraint makes illegal
// values unrepresentable and no v1 path mutates status, so illegal
// transitions are impossible by construction.
//
// board_issue_ref stays NULL in this module: the board notification seam
// (THI-788 step 3) fills it after the INSERT commits — never inside the
// insert transaction (an external API call must not hold a DB lock nor
// fail a committed report).

import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { RateLimiter } from "./rate-limit.js";
import { logSecurityEvent } from "./security-events.js";
import { createReportReviewTask, reportReviewConfig } from "./report-review-notify.js";

/** Spec: canned causes, stable slugs. The DB CHECK mirrors this list
 *  exactly; labels live in the frontend i18n (private repo). */
export const REPORT_REASONS = ["explicit_images", "scam_fraud", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Spec: required motivation, min 10 / hard cap 1000. Mirrored by the DB
 *  CHECK; Postgres char_length never counts more than JS string length, so
 *  a body accepted here can never violate the column constraint. */
export const MIN_MOTIVATION_CHARS = 10;
export const MAX_MOTIVATION_CHARS = 1000;

/** Spec: 5 reports per account per hour. Injectable so tests can exercise
 *  the DB-side paths without tripping the shared bucket. */
export const itemReportLimiter = new RateLimiter(5, 60 * 60_000);

export type ItemReportErrorCode =
  | "not_found" // bad item id — item ids are public, no oracle needed
  | "own_item" // reporter owns the target
  | "duplicate" // UNIQUE (reporter, item) — friendly, not a fault
  | "rate_limited" // hourly account bucket
  | "validation"; // reason/motivation shape

export class ItemReportError extends Error {
  constructor(readonly code: ItemReportErrorCode, message: string) {
    super(message);
    this.name = "ItemReportError";
  }
}

/** One report row as created by createItemReport. */
export interface ItemReport {
  id: string;
  status: "open";
  created_at: Date;
}

/** Best-effort triage notification (spec §board notification): one attempt
 *  after the INSERT committed, outside the transaction. Never throws to the
 *  caller — a notification failure must not fail a saved report. */
async function notifyReview(input: {
  report: ItemReport;
  itemId: string;
  reason: string;
  motivation: string;
  reporterAccountId: string;
}): Promise<void> {
  const config = reportReviewConfig();
  if (!config) return; // notification disabled: rows land, ref stays NULL
  try {
    const ref = await createReportReviewTask(
      {
        report: input.report,
        itemId: input.itemId,
        reason: input.reason,
        motivation: input.motivation,
        reporterAccountId: input.reporterAccountId,
        createdAt: input.report.created_at,
      },
      config,
    );
    if (ref) {
      await setBoardIssueRef(input.report.id, ref);
    } else {
      console.warn(`[reports] review endpoint returned no task id for report ${input.report.id}`);
    }
  } catch (err) {
    console.warn(`[reports] review notification failed for report ${input.report.id}: ${(err as Error).message}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared field validation (order-reviews spec PR 3: review reports use
 *  the same canned slugs and the 10–1000 motivation rule as item reports).
 *  Returns the user-facing message when invalid, else null — each creator
 *  maps it onto its own error class, keeping messages one source. */
function reportFieldError(reason: string, motivation: string): string | null {
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
    return "Pick a reason: explicit images, scam or fraud, or something else.";
  }
  const trimmed = motivation.trim();
  if (trimmed.length < MIN_MOTIVATION_CHARS) {
    return `Describe the problem in at least ${MIN_MOTIVATION_CHARS} characters.`;
  }
  if (trimmed.length > MAX_MOTIVATION_CHARS) {
    return `The description is limited to ${MAX_MOTIVATION_CHARS} characters.`;
  }
  return null;
}

export async function createItemReport(
  input: { itemId: string; reporterAccountId: string; reason: string; motivation: string },
  limiter: RateLimiter = itemReportLimiter,
): Promise<ItemReport> {
  // Validation before any I/O — defense in depth under the route's zod
  // schema (which cannot see whitespace-only motivations).
  if (!UUID_RE.test(input.itemId)) {
    throw new ItemReportError("not_found", "Item not found.");
  }
  const fieldError = reportFieldError(input.reason, input.motivation);
  if (fieldError) {
    throw new ItemReportError("validation", fieldError);
  }
  const motivation = input.motivation.trim();

  // Hourly per-reporter bucket (spec key: reports:acct:<id>).
  if (!limiter.allow(`reports:acct:${input.reporterAccountId}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/items/:id/report" }, { sellerId: input.reporterAccountId });
    throw new ItemReportError("rate_limited", "Too many reports sent in the last hour. Try again later.");
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      // Locking the item row closes the TOCTOU between the existence/owner
      // check and the insert, and serializes concurrent self-checks on the
      // same item. Visibility is deliberately NOT checked (spec): a hidden
      // (photo-pending, THI-308) item is still reportable via its link —
      // a reporter with the URL is exactly the person who saw it.
      const item = await db.query<{ seller_id: string }>(
        "SELECT seller_id FROM items WHERE id = $1 FOR SHARE",
        [input.itemId],
      );
      const row = item.rows[0];
      if (!row) {
        throw new ItemReportError("not_found", "Item not found.");
      }
      if (row.seller_id === input.reporterAccountId) {
        throw new ItemReportError("own_item", "You can't report your own item.");
      }

      const inserted = await db.query<ItemReport>(
        `INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation)
         VALUES ($1, $2, $3, $4)
         RETURNING id, status, created_at`,
        [input.reporterAccountId, input.itemId, input.reason, motivation],
      );
      await db.query("COMMIT");
      // Triage task creation happens after COMMIT (spec): an external call
      // must not hold the insert lock, and a committed report is never lost
      // to a notification failure.
      await notifyReview({
        report: inserted.rows[0],
        itemId: input.itemId,
        reason: input.reason,
        motivation,
        reporterAccountId: input.reporterAccountId,
      });
      return inserted.rows[0];
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      // Concurrent double-submit: the loser hits the UNIQUE constraint —
      // map it to the same friendly duplicate the pre-check would give.
      if ((err as { code?: string }).code === "23505") {
        throw new ItemReportError("duplicate", "You already reported this item.");
      }
      throw err;
    }
  } finally {
    db.release();
  }
}

/** Records the external triage task ref on a report (spec: filled by the
 *  notification seam after a successful create, never inside the insert
 *  transaction). */
export async function setBoardIssueRef(
  reportId: string,
  boardIssueRef: string,
  db: PoolClient | typeof pool = pool,
): Promise<void> {
  await db.query("UPDATE reports SET board_issue_ref = $2 WHERE id = $1", [reportId, boardIssueRef]);
}

// --- review reports (order-reviews spec PR 3) ---
// Same contract as item reports, pointed at a review: any signed-in account
// except the review's author. Dedupe rides the per-kind partial UNIQUE
// (reporter, target_review_id) widened into `reports`; the hourly bucket is
// the same shared one (reports:acct:<id>) so alternating item/review targets
// cannot multiply an account's report budget.

export type ReviewReportErrorCode =
  | "not_found" // bad review id — opaque to strangers
  | "own_review" // reporter wrote the review
  | "duplicate" // partial UNIQUE (reporter, review) — friendly, not a fault
  | "rate_limited" // the shared hourly account bucket
  | "validation"; // reason/motivation shape

export class ReviewReportError extends Error {
  constructor(readonly code: ReviewReportErrorCode, message: string) {
    super(message);
    this.name = "ReviewReportError";
  }
}

/** One report row as created by createReviewReport. */
export interface ReviewReport {
  id: string;
  status: "open";
  created_at: Date;
}

/** Best-effort triage notification, the notifyReview mirror: after COMMIT,
 *  never throws, ref lands via setBoardIssueRef. */
async function notifyReviewReport(input: {
  report: ReviewReport;
  reviewId: string;
  reason: string;
  motivation: string;
  reporterAccountId: string;
}): Promise<void> {
  const config = reportReviewConfig();
  if (!config) return;
  try {
    const ref = await createReportReviewTask(
      {
        report: input.report,
        reviewId: input.reviewId,
        reason: input.reason,
        motivation: input.motivation,
        reporterAccountId: input.reporterAccountId,
        createdAt: input.report.created_at,
      },
      config,
    );
    if (ref) {
      await setBoardIssueRef(input.report.id, ref);
    } else {
      console.warn(`[reports] review endpoint returned no task id for report ${input.report.id}`);
    }
  } catch (err) {
    console.warn(`[reports] review notification failed for report ${input.report.id}: ${(err as Error).message}`);
  }
}

export async function createReviewReport(
  input: { reviewId: string; reporterAccountId: string; reason: string; motivation: string },
  limiter: RateLimiter = itemReportLimiter,
): Promise<ReviewReport> {
  if (!UUID_RE.test(input.reviewId)) {
    throw new ReviewReportError("not_found", "Review not found.");
  }
  const fieldError = reportFieldError(input.reason, input.motivation);
  if (fieldError) {
    throw new ReviewReportError("validation", fieldError);
  }
  const motivation = input.motivation.trim();

  if (!limiter.allow(`reports:acct:${input.reporterAccountId}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/reviews/:id/report" }, { sellerId: input.reporterAccountId });
    throw new ReviewReportError("rate_limited", "Too many reports sent in the last hour. Try again later.");
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      // FOR SHARE closes the TOCTOU between the author check and the
      // insert (the createItemReport pattern). Visibility is deliberately
      // NOT checked: a hidden review reached by link is still reportable —
      // the reporter saw it.
      const review = await db.query<{ buyer_id: string }>(
        "SELECT buyer_id FROM order_reviews WHERE id = $1 FOR SHARE",
        [input.reviewId],
      );
      const row = review.rows[0];
      if (!row) {
        throw new ReviewReportError("not_found", "Review not found.");
      }
      if (row.buyer_id === input.reporterAccountId) {
        throw new ReviewReportError("own_review", "You can't report your own review.");
      }

      const inserted = await db.query<ReviewReport>(
        `INSERT INTO reports (reporter_account_id, target_review_id, reason, motivation)
         VALUES ($1, $2, $3, $4)
         RETURNING id, status, created_at`,
        [input.reporterAccountId, input.reviewId, input.reason, motivation],
      );
      await db.query("COMMIT");
      await notifyReviewReport({
        report: inserted.rows[0],
        reviewId: input.reviewId,
        reason: input.reason,
        motivation,
        reporterAccountId: input.reporterAccountId,
      });
      return inserted.rows[0];
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        throw new ReviewReportError("duplicate", "You already reported this review.");
      }
      throw err;
    }
  } finally {
    db.release();
  }
}
