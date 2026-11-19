// Review-notify backfill sweep (spec docs/specs/item-reports.md §backfill,
// THI-1068): bounded retry for open reports with NULL board_issue_ref —
// attempts/backoff/dead-letter/skip state machine, staleness cutoff, batch
// cap, race-safe claims. DB-backed + local mock HTTP endpoint; skips
// without Postgres (CI runs it). The backfill-relevant assertions
// (backoff-honored, 409-terminal, dead-never-reclaimed) are written to fail
// against a naive always-retry implementation: such a sweep would re-POST on
// the second pass and double `received` counts.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REVIEW_BACKFILL_ATTEMPTS,
  reviewBackoffMs,
  runReportReviewBackfill,
} from "../src/report-review-backfill.js";
import {
  DEFAULT_REPORT_REVIEW_MAX_AGE_HOURS,
  reportReviewMaxAgeHours,
  type ReportReviewConfig,
} from "../src/report-review-notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

interface Received {
  body: any;
}

describe.skipIf(!available)("report-review backfill sweep (THI-1068)", () => {
  let db: pg.Client;
  let mock: Server;
  let mockBase = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  const savedEnv: Record<string, string | undefined> = {};
  let received: Received[] = [];
  let respond: { status: number; json: unknown } = { status: 200, json: { id: "triage-backfill-1" } };
  let delayMs = 0;
  let config: ReportReviewConfig;

  async function mkSeller(): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'backfill') RETURNING id`,
      [`thi1068-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
    );
    return r.rows[0].id;
  }

  async function mkItem(ownerId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'backfill fixture', 100, 'other') RETURNING id`,
      [ownerId],
    );
    return r.rows[0].id;
  }

  /** A report row with a NULL ref, due now (or with the given overrides). */
  async function mkReport(overrides: { createdAgoMs?: number; attempts?: number; nextInMs?: number } = {}): Promise<string> {
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const createdAgoMs = overrides.createdAgoMs ?? 60_000;
    const r = await db.query<{ id: string }>(
      `INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation, created_at,
                            review_notify_attempts, review_notify_next_attempt_at)
       VALUES ($1, $2, 'other', 'backfill sweep fixture motivation', now() - ($5 || ' milliseconds')::interval,
               $3, now() + ($4 || ' milliseconds')::interval)
       RETURNING id`,
      [reporter, item, overrides.attempts ?? 0, overrides.nextInMs ?? -1000, String(createdAgoMs)],
    );
    return r.rows[0].id;
  }

  interface StateRow {
    board_issue_ref: string | null;
    review_notify_attempts: number;
    review_notify_status: string;
    review_notify_last_error: string | null;
    review_notify_next_attempt_at: Date;
  }

  async function state(reportId: string): Promise<StateRow> {
    const r = await db.query<StateRow>(
      `SELECT board_issue_ref, review_notify_attempts, review_notify_status,
              review_notify_last_error, review_notify_next_attempt_at
         FROM reports WHERE id = $1`,
      [reportId],
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    mock = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const body = JSON.parse(raw || "{}");
        received.push({ body });
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        res.statusCode = respond.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(respond.json));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => {
      mockBase = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
      resolve();
    }));
    config = {
      createUrl: `${mockBase}/create`,
      apiToken: "test-token",
      timeoutMs: 2_000,
      maxAgeHours: DEFAULT_REPORT_REVIEW_MAX_AGE_HOURS,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mock ? mock.close(() => resolve()) : resolve());
    await db.end();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    received = [];
    respond = { status: 200, json: { id: "triage-backfill-1" } };
    delayMs = 0;
    // Test isolation: every fixture seller carries the run tag; deleting
    // them cascades to their items and reports so later sweeps (and later
    // tests) never claim leftovers from earlier cases.
    await db.query(`DELETE FROM sellers WHERE email LIKE $1`, [`thi1068-${runTag}-%`]);
  });

  function setEnv(vars: Record<string, string | undefined>): void {
    for (const k of Object.keys(vars)) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("disabled seam: sweep is a no-op — no claim, no HTTP call", async () => {
    setEnv({ REPORT_REVIEW_CREATE_URL: undefined, REPORT_REVIEW_API_TOKEN: undefined });
    const reportId = await mkReport();
    const r = await runReportReviewBackfill(); // reads env → null config
    expect(r).toEqual({ claimed: 0, recovered: 0, retried: 0, dead: 0, conflictSkipped: 0, staleSkipped: 0 });
    expect(received).toHaveLength(0);
    expect((await state(reportId)).review_notify_status).toBe("pending");
  });

  it("recovers a due NULL-ref report: one POST with the report idempotency key, ref stored", async () => {
    const reportId = await mkReport();
    const r = await runReportReviewBackfill(config);
    expect(r).toMatchObject({ claimed: 1, recovered: 1, retried: 0, dead: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].body.idempotencyKey).toBe(`report-review:${reportId}`);
    expect(received[0].body.title).toContain("Board review: item");
    const s = await state(reportId);
    expect(s.board_issue_ref).toBe("triage-backfill-1");
    expect(s.review_notify_attempts).toBe(1);
    expect(s.review_notify_last_error).toBeNull();
    // Delivered row is outside the claim filter forever: second pass no-op.
    const r2 = await runReportReviewBackfill(config);
    expect(r2.claimed).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("409 conflict: terminal skip, no retry on later passes (fails vs naive always-retry)", async () => {
    respond = { status: 409, json: { error: "duplicate" } };
    const reportId = await mkReport();
    const r = await runReportReviewBackfill(config);
    expect(r).toMatchObject({ claimed: 1, conflictSkipped: 1, recovered: 0 });
    expect((await state(reportId)).review_notify_status).toBe("skipped");
    expect((await state(reportId)).review_notify_last_error).toBe("conflict:409");
    // Even making the row "due" again must not re-POST: terminal.
    await db.query(`UPDATE reports SET review_notify_next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [reportId]);
    const r2 = await runReportReviewBackfill(config);
    expect(r2.claimed).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("5xx failure: one attempt burned, backoff scheduled — next immediate pass claims nothing (fails vs naive always-retry)", async () => {
    respond = { status: 503, json: { error: "overloaded" } };
    const reportId = await mkReport();
    const r = await runReportReviewBackfill(config);
    expect(r).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
    const s = await state(reportId);
    expect(s.review_notify_attempts).toBe(1);
    expect(s.review_notify_status).toBe("pending");
    expect(s.review_notify_last_error).toContain("503");
    expect(s.review_notify_next_attempt_at.getTime()).toBeGreaterThan(Date.now()); // backoff pending
    const r2 = await runReportReviewBackfill(config); // runs immediately — must not claim
    expect(r2.claimed).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("attempts exhaustion: dead-letter, visible error, never re-claimed", async () => {
    respond = { status: 500, json: { error: "boom" } };
    const reportId = await mkReport({ attempts: MAX_REVIEW_BACKFILL_ATTEMPTS - 1 });
    const r = await runReportReviewBackfill(config);
    expect(r).toMatchObject({ claimed: 1, dead: 1 });
    const s = await state(reportId);
    expect(s.review_notify_status).toBe("dead");
    expect(s.review_notify_attempts).toBe(MAX_REVIEW_BACKFILL_ATTEMPTS);
    expect(s.review_notify_last_error).toContain("500");
    await db.query(`UPDATE reports SET review_notify_next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [reportId]);
    const r2 = await runReportReviewBackfill(config);
    expect(r2.claimed).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("staleness cutoff: report older than the window is skipped:stale without a POST", async () => {
    const reportId = await mkReport({ createdAgoMs: (DEFAULT_REPORT_REVIEW_MAX_AGE_HOURS * 3_600_000) + 3_600_000 });
    const r = await runReportReviewBackfill(config);
    expect(r.staleSkipped).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(0);
    const s = await state(reportId);
    expect(s.review_notify_status).toBe("skipped");
    expect(s.review_notify_last_error).toBe("skipped:stale");
  });

  it("claim filter: ref already set, resolved reports, and future next_attempt are never claimed", async () => {
    const withRef = await mkReport();
    await db.query(`UPDATE reports SET board_issue_ref = 'manual-ref' WHERE id = $1`, [withRef]);
    const resolved = await mkReport();
    await db.query(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [resolved]);
    const future = await mkReport({ nextInMs: 60 * 60_000 });
    const r = await runReportReviewBackfill(config);
    expect(r.claimed).toBe(0);
    expect(r.staleSkipped).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("batch cap: more due rows than the cap — one pass claims at most the cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await mkReport());
    const r = await runReportReviewBackfill(config);
    expect(r.claimed).toBe(25);
    expect(r.recovered).toBe(25);
    expect(received).toHaveLength(25);
    // The remaining 5 land on the next pass.
    const r2 = await runReportReviewBackfill(config);
    expect(r2.claimed).toBe(5);
    expect(received).toHaveLength(30);
  });

  it("race safety: two concurrent sweeps never double-POST a row (SKIP LOCKED)", async () => {
    delayMs = 150; // hold responses so both sweeps overlap in-flight
    const reportId = await mkReport();
    const [a, b] = await Promise.all([
      runReportReviewBackfill(config),
      runReportReviewBackfill(config),
    ]);
    expect(a.claimed + b.claimed).toBe(1); // exactly one sweep claimed the row
    expect(received).toHaveLength(1); // exactly one POST — no double-delivery
    expect((await state(reportId)).board_issue_ref).toBe("triage-backfill-1");
  });

  it("2xx without a usable id is retryable: attempts burned, not terminal", async () => {
    respond = { status: 200, json: { ok: true } }; // no id field
    const reportId = await mkReport();
    const r = await runReportReviewBackfill(config);
    expect(r).toMatchObject({ claimed: 1, retried: 1 });
    const s = await state(reportId);
    expect(s.review_notify_status).toBe("pending");
    expect(s.board_issue_ref).toBeNull();
    expect(s.review_notify_last_error).toContain("without usable");
  });

  it("guard: the sweep's success write is idempotent against an existing ref", async () => {
    const reportId = await mkReport();
    await db.query(`UPDATE reports SET board_issue_ref = 'pre-existing-ref' WHERE id = $1`, [reportId]);
    const r = await runReportReviewBackfill(config);
    expect(r.claimed).toBe(0); // ref set ⇒ outside the claim filter
    expect((await state(reportId)).board_issue_ref).toBe("pre-existing-ref");
  });
});

describe("review backoff ladder + max-age parser (pure)", () => {
  it("backoff doubles from 1m and caps at 6h", () => {
    expect(reviewBackoffMs(1)).toBe(60_000);
    expect(reviewBackoffMs(2)).toBe(120_000);
    expect(reviewBackoffMs(3)).toBe(240_000);
    expect(reviewBackoffMs(9)).toBe(15_360_000); // 2^8 minutes — still under the cap
    expect(reviewBackoffMs(10)).toBe(6 * 3_600_000); // capped
    expect(reviewBackoffMs(50)).toBe(6 * 3_600_000);
  });

  it("max-age parser: unset/empty → default 48; clamps to [1, 168]", () => {
    expect(reportReviewMaxAgeHours(undefined)).toBe(48);
    expect(reportReviewMaxAgeHours("")).toBe(48);
    expect(reportReviewMaxAgeHours("24")).toBe(24);
    expect(reportReviewMaxAgeHours("0")).toBe(1);
    expect(reportReviewMaxAgeHours("9999")).toBe(168);
    expect(reportReviewMaxAgeHours("garbage")).toBe(48);
    expect(reportReviewMaxAgeHours("12.5")).toBe(48);
  });
});
