// Report-review notification seam (spec docs/specs/item-reports.md,
// THI-788 step 3): after commit, one best-effort POST to the configured
// external triage endpoint; ref stored on success; a failure never fails
// the report. DB-backed + local mock HTTP endpoint; skips without
// Postgres (CI runs it).

import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createItemReport } from "../src/reports.js";
import { reportReviewConfig, reportReviewDescription, type ReportReviewConfig } from "../src/report-review-notify.js";

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
  auth: string | undefined;
  body: any;
}

describe.skipIf(!available)("report review notification (THI-788 step 3)", () => {
  let db: pg.Client;
  let mock: Server;
  let mockBase = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  const savedEnv: Record<string, string | undefined> = {};
  let received: Received[] = [];
  let respond: { status: number; json: unknown; headers?: Record<string, string> } = { status: 200, json: { id: "triage-1" } };

  async function mkSeller(): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'notify') RETURNING id`,
      [`thi788n-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
    );
    return r.rows[0].id;
  }

  async function mkItem(ownerId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'notify fixture', 100, 'other') RETURNING id`,
      [ownerId],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    mock = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
        res.statusCode = respond.status;
        for (const [k, v] of Object.entries(respond.headers ?? {})) res.setHeader(k, v);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(respond.json));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => {
      mockBase = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
      resolve();
    }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mock ? mock.close(() => resolve()) : resolve());
    await db.end();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    received = [];
    respond = { status: 200, json: { id: "triage-1" } };
  });

  function setEnv(vars: Record<string, string | undefined>): void {
    for (const k of Object.keys(vars)) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("disabled without config: report saved, no HTTP call, ref NULL", async () => {
    setEnv({ REPORT_REVIEW_CREATE_URL: undefined, REPORT_REVIEW_API_TOKEN: undefined });
    expect(reportReviewConfig()).toBeNull();
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const report = await createItemReport({
      itemId: item, reporterAccountId: reporter, reason: "scam_fraud",
      motivation: "No config set, notification must be a silent no-op.",
    });
    expect(report.status).toBe("open");
    const row = await db.query<{ board_issue_ref: string | null }>(
      "SELECT board_issue_ref FROM reports WHERE id = $1", [report.id],
    );
    expect(row.rows[0].board_issue_ref).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("success: one POST with bearer, idempotency key = report id, ref stored", async () => {
    setEnv({
      REPORT_REVIEW_CREATE_URL: `${mockBase}/create`,
      REPORT_REVIEW_API_TOKEN: "test-token",
      REPORT_REVIEW_ASSIGNEE_ID: "assignee-123",
      REPORT_REVIEW_ITEM_URL_TEMPLATE: "https://example.test/item/{id}",
    });
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const report = await createItemReport({
      itemId: item, reporterAccountId: reporter, reason: "explicit_images",
      motivation: "The second photo is explicit content beyond the listing bounds.",
    });
    expect(received).toHaveLength(1);
    const call = received[0];
    expect(call.auth).toBe("Bearer test-token");
    expect(call.body.title).toBe(`Board review: item ${item} — explicit_images`);
    expect(call.body.assigneeAgentId).toBe("assignee-123");
    expect(call.body.idempotencyKey).toBe(`report-review:${report.id}`);
    expect(call.body.description).toContain(`https://example.test/item/${item}`);
    expect(call.body.description).toContain(reporter);
    expect(call.body.description).toContain("explicit_images");
    const row = await db.query<{ board_issue_ref: string | null }>(
      "SELECT board_issue_ref FROM reports WHERE id = $1", [report.id],
    );
    expect(row.rows[0].board_issue_ref).toBe("triage-1");
  });

  it("endpoint failure: report still saved, ref NULL, no throw", async () => {
    setEnv({
      REPORT_REVIEW_CREATE_URL: `${mockBase}/create`,
      REPORT_REVIEW_API_TOKEN: "test-token",
    });
    respond = { status: 500, json: { error: "boom" } };
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const report = await createItemReport({
      itemId: item, reporterAccountId: reporter, reason: "other",
      motivation: "The endpoint will fail but my report must survive it.",
    });
    expect(report.status).toBe("open");
    const row = await db.query<{ board_issue_ref: string | null }>(
      "SELECT board_issue_ref FROM reports WHERE id = $1", [report.id],
    );
    expect(row.rows[0].board_issue_ref).toBeNull();
  });

  it("over-long id (>256) treated as no usable id: ref NULL (THI-792)", async () => {
    setEnv({
      REPORT_REVIEW_CREATE_URL: `${mockBase}/create`,
      REPORT_REVIEW_API_TOKEN: "test-token",
    });
    respond = { status: 200, json: { id: "x".repeat(300) } };
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const report = await createItemReport({
      itemId: item, reporterAccountId: reporter, reason: "other",
      motivation: "Endpoint echoes a misbehaving over-long reference id.",
    });
    expect(report.status).toBe("open");
    const row = await db.query<{ board_issue_ref: string | null }>(
      "SELECT board_issue_ref FROM reports WHERE id = $1", [report.id],
    );
    expect(row.rows[0].board_issue_ref).toBeNull();
  });

  it("3xx redirect answered with the bearer must not be followed: ref NULL, no throw (THI-792)", async () => {
    setEnv({
      REPORT_REVIEW_CREATE_URL: `${mockBase}/create`,
      REPORT_REVIEW_API_TOKEN: "test-token",
    });
    respond = { status: 302, json: {}, headers: { Location: `${mockBase}/elsewhere` } };
    const reporter = await mkSeller();
    const item = await mkItem(await mkSeller());
    const report = await createItemReport({
      itemId: item, reporterAccountId: reporter, reason: "other",
      motivation: "A redirect answer must fail closed, never follow it.",
    });
    expect(report.status).toBe("open");
    const row = await db.query<{ board_issue_ref: string | null }>(
      "SELECT board_issue_ref FROM reports WHERE id = $1", [report.id],
    );
    expect(row.rows[0].board_issue_ref).toBeNull();
    expect(received).toHaveLength(1); // original call only — no second hop
  });

  it("description truncates long motivations and works without a URL template", () => {
    const config: ReportReviewConfig = { createUrl: "x", apiToken: "y" };
    const desc = reportReviewDescription(
      {
        report: { id: "r1" }, itemId: "i1", reason: "other",
        motivation: "z".repeat(600), reporterAccountId: "a1", createdAt: new Date("2026-11-14T12:00:00Z"),
      },
      config,
    );
    expect(desc).toContain("item i1");
    expect(desc).not.toContain("https://");
    expect(desc).toContain("…");
    expect(desc).toContain("UNTRUSTED user-submitted content");
    expect(desc.length).toBeLessThan(700);
  });
});
