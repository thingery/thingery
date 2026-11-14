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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createItemReport(
  input: { itemId: string; reporterAccountId: string; reason: string; motivation: string },
  limiter: RateLimiter = itemReportLimiter,
): Promise<ItemReport> {
  // Validation before any I/O — defense in depth under the route's zod
  // schema (which cannot see whitespace-only motivations).
  if (!UUID_RE.test(input.itemId)) {
    throw new ItemReportError("not_found", "Item not found.");
  }
  if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) {
    throw new ItemReportError("validation", "Pick a reason: explicit images, scam or fraud, or something else.");
  }
  const motivation = input.motivation.trim();
  if (motivation.length < MIN_MOTIVATION_CHARS) {
    throw new ItemReportError("validation", `Describe the problem in at least ${MIN_MOTIVATION_CHARS} characters.`);
  }
  if (motivation.length > MAX_MOTIVATION_CHARS) {
    throw new ItemReportError("validation", `The description is limited to ${MAX_MOTIVATION_CHARS} characters.`);
  }

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

/** Board notification seam (THI-788 step 3 fills this in). Exported for
 *  that PR: marks the report's board_issue_ref after a successful issue
 *  creation, outside any report transaction. */
export async function setBoardIssueRef(
  reportId: string,
  boardIssueRef: string,
  db: PoolClient | typeof pool = pool,
): Promise<void> {
  await db.query("UPDATE reports SET board_issue_ref = $2 WHERE id = $1", [reportId, boardIssueRef]);
}
