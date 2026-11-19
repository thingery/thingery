// Review-notify backfill sweep (spec docs/specs/item-reports.md §backfill,
// THI-1068): bounded automatic retry for open reports whose initial
// off-path triage notify missed (board_issue_ref NULL — timeout abort,
// endpoint 5xx, process exit mid-flight). The email-outbox delivery sweep
// (src/notify/delivery.ts) applied to reports: attempts counter, exponential
// backoff ladder, dead-letter state, small claim batches, staleness cutoff.
//
// Explicit state machine (review_notify_status on reports; success is NOT a
// status — board_issue_ref NOT NULL is the success marker, and the claim
// filter ref IS NULL ends the lifecycle for recovered rows):
//
//   pending --2xx with usable id-->            delivered (ref := id; attempts+1; last_error NULL)
//   pending --409-->                           skipped    (terminal; last_error 'conflict:409')
//   pending --older than max-age window-->     skipped    (terminal; last_error 'skipped:stale')
//   pending --other failure, attempts < MAX--> pending    (attempts+1; next_attempt_at = now + backoff)
//   pending --other failure, attempts >= MAX-> dead       (terminal; last_error kept)
//
// Nothing writes a terminal status back to 'pending' and delivered rows sit
// outside the claim filter, so illegal transitions are unrepresentable.
// 409 is terminal-success (spec §conflict): the task exists on the tracker
// side but the answer carries no recoverable id — retrying it forever would
// be unbounded resource consumption aimed at our own control plane, exactly
// what the attempt state exists to prevent. Every POST rides the unchanged
// idempotency key `report-review:<report id>`, so a replay can never mint a
// duplicate task (within the tracker's key retention — the staleness window
// is clamped below it).
//
// Claims are FOR UPDATE SKIP LOCKED inside one transaction: a second app
// instance can never double-POST a row. The claim holds row locks across
// the external POSTs (same posture as the email sweep's mailer calls);
// the batch is small and every attempt is bounded by the shared
// REPORT_REVIEW_TIMEOUT_MS budget. No-op while the triage seam is disabled
// (URL/token unset) — the dark-deploy posture of the email sweep.

import { pool } from "./db.js";
import type { PoolClient } from "pg";
import {
  createReportReviewTask,
  ReportReviewHttpError,
  reportReviewConfig,
  type ReportReviewConfig,
} from "./report-review-notify.js";

/** Claim batch per pass (spec §sweep mechanics: "small claim batches"). */
const CLAIM_BATCH = 25;
/** Dead-letter after this many failed sweep attempts (email-sweep parity). */
export const MAX_REVIEW_BACKFILL_ATTEMPTS = 8;
/** Exponential backoff: 1m, 2m, 4m, … capped at 6h (email-sweep ladder). */
export function reviewBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), 6 * 3_600_000);
}

/** Sweep cadence: boot run + every 5 minutes, unref'd (reports are rare —
 *  the 5/account/hour limiter bounds the table's growth rate). */
const SWEEP_INTERVAL_MINUTES = 5;

interface ClaimedReport {
  id: string;
  target_item_id: string | null;
  target_review_id: string | null;
  reason: string;
  motivation: string;
  reporter_account_id: string;
  created_at: Date;
  review_notify_attempts: number;
}

export interface ReportReviewBackfillReport {
  claimed: number;
  /** Ref recovered this pass (2xx with usable id — fresh create or replay). */
  recovered: number;
  retried: number;
  dead: number;
  /** Rows terminally skipped on a 409 conflict answer (spec §conflict). */
  conflictSkipped: number;
  /** Rows bulk-skipped by the staleness cutoff this pass. */
  staleSkipped: number;
}

/** One sweep pass. `config` and `now` are injectable for tests; the config
 *  defaults to the deployment env (null ⇒ seam disabled ⇒ no-op). */
export async function runReportReviewBackfill(
  config: ReportReviewConfig | null = reportReviewConfig(),
  now: Date = new Date(),
): Promise<ReportReviewBackfillReport> {
  const report: ReportReviewBackfillReport = {
    claimed: 0, recovered: 0, retried: 0, dead: 0, conflictSkipped: 0, staleSkipped: 0,
  };
  if (!config) return report; // seam disabled: claim nothing

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Staleness cutoff before the claim (spec §staleness cutoff, the email
    // sweep's THI-1043 shape): pending rows older than the max-age window
    // are bulk-skipped so an old backlog never gets triaged days late — and
    // so it cannot crowd fresh rows out of the claim batch. Same SKIP LOCKED
    // concurrency contract as the claim below; 'skipped:stale' keeps the
    // reason distinguishable from conflict skips.
    const cutoff = new Date(now.getTime() - config.maxAgeHours * 3_600_000);
    const stale = await client.query(
      `UPDATE reports r
          SET review_notify_status = 'skipped',
              review_notify_attempts = r.review_notify_attempts + 1,
              review_notify_last_error = 'skipped:stale'
         FROM (SELECT id FROM reports
                WHERE board_issue_ref IS NULL AND status = 'open'
                  AND review_notify_status = 'pending' AND created_at < $1
                FOR UPDATE SKIP LOCKED) s
        WHERE r.id = s.id`,
      [cutoff],
    );
    report.staleSkipped = stale.rowCount ?? 0;
    // Claim due rows (SKIP LOCKED: multi-instance safe), oldest first.
    const claimed = await client.query<ClaimedReport>(
      `SELECT id, target_item_id, target_review_id, reason, motivation,
              reporter_account_id, created_at, review_notify_attempts
         FROM reports
        WHERE board_issue_ref IS NULL AND status = 'open'
          AND review_notify_status = 'pending'
          AND review_notify_next_attempt_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [CLAIM_BATCH],
    );
    report.claimed = claimed.rows.length;

    for (const row of claimed.rows) {
      try {
        const ref = await createReportReviewTask(
          {
            report: { id: row.id },
            itemId: row.target_item_id ?? undefined,
            reviewId: row.target_review_id ?? undefined,
            reason: row.reason,
            motivation: row.motivation,
            reporterAccountId: row.reporter_account_id,
            createdAt: row.created_at,
          },
          config,
        );
        if (ref) {
          // Guarded success write: a ref landed concurrently (the off-path
          // initial notify) is never overwritten — idempotency makes the
          // values equal anyway; the guard is belt-and-braces.
          await client.query(
            `UPDATE reports
                SET board_issue_ref = $2, review_notify_attempts = review_notify_attempts + 1,
                    review_notify_last_error = NULL
              WHERE id = $1 AND board_issue_ref IS NULL`,
            [row.id, ref],
          );
          report.recovered++;
        } else {
          // 2xx without a usable id — the endpoint contract is broken for
          // this answer, but a replay may yet return the id; retryable.
          const outcome = await markFailure(client, row, "2xx without usable task id");
          report[outcome]++;
        }
      } catch (err) {
        if (err instanceof ReportReviewHttpError && err.status === 409) {
          // Terminal-success (spec §conflict): the task exists tracker-side
          // but this answer yields no recoverable id — stop retrying it.
          await client.query(
            `UPDATE reports
                SET review_notify_status = 'skipped',
                    review_notify_attempts = review_notify_attempts + 1,
                    review_notify_last_error = 'conflict:409'
              WHERE id = $1`,
            [row.id],
          );
          report.conflictSkipped++;
          console.warn(`[report-review-backfill] 409 conflict for report ${row.id} — task exists, ref unrecoverable; skipped`);
          continue;
        }
        const outcome = await markFailure(client, row, err instanceof Error ? err.message : String(err));
        report[outcome]++;
      }
    }
    await client.query("COMMIT");
    return report;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Failure transition — same-connection update (the claim holds the row
 *  locks; a pool connection would deadlock against this sweep's own
 *  transaction). Retries until MAX, then dead-letters visibly. */
async function markFailure(
  client: PoolClient,
  row: ClaimedReport,
  error: string,
): Promise<"retried" | "dead"> {
  const attempts = row.review_notify_attempts + 1;
  if (attempts >= MAX_REVIEW_BACKFILL_ATTEMPTS) {
    await client.query(
      `UPDATE reports SET review_notify_status = 'dead', review_notify_attempts = $2,
              review_notify_last_error = $3 WHERE id = $1`,
      [row.id, attempts, error],
    );
    console.error(`[report-review-backfill] report ${row.id} dead-lettered after ${attempts} attempts: ${error.slice(0, 200)}`);
    return "dead";
  }
  await client.query(
    `UPDATE reports SET review_notify_attempts = $2, review_notify_last_error = $3,
            review_notify_next_attempt_at = now() + ($4 || ' milliseconds')::interval
       WHERE id = $1`,
    [row.id, attempts, error, String(reviewBackoffMs(attempts))],
  );
  return "retried";
}

/** Boot run + interval, same posture as the other sweep timers. */
export function startReportReviewBackfillTimer(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReportReviewBackfill();
      if (r.claimed > 0 || r.staleSkipped > 0) console.log(`[report-review-backfill] ${JSON.stringify(r)}`);
    } catch (err) {
      console.error("[report-review-backfill] sweep failed:", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
