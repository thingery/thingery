// THI-760 plan Phase 1 / THI-763, PR 1 (schema + config): the three Phase-1
// tables exist exactly as plan §2 specifies (dedupe keys, partial indexes,
// CHECK constraints) and the notify config knobs parse fail-closed with the
// right defaults. Additive-only — no existing table or column changes.
// Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../src/db.js";
import { notifyConfig } from "../src/config.js";

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

describe.skipIf(!available)("notify schema (THI-763 PR 1)", () => {
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");
    await db.query(schema); // idempotent — proves re-runs are safe too
  });
  afterAll(async () => {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("notifications table matches plan §2.1 (columns, dedupe, partial index)", async () => {
    const { rows } = await db.query(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'notifications'`,
    );
    const cols = new Map(rows.map((r) => [r.column_name, r]));
    for (const required of [
      "id", "recipient_id", "order_id", "event_type", "role", "payload",
      "dedupe_key", "read_at", "created_at",
    ]) {
      expect(cols.has(required), `notifications.${required}`).toBe(true);
    }
    // recipient_id NOT NULL, order_id nullable (account-level events), dedupe_key NOT NULL.
    expect(cols.get("recipient_id")!.is_nullable).toBe("NO");
    expect(cols.get("order_id")!.is_nullable).toBe("YES");
    expect(cols.get("dedupe_key")!.is_nullable).toBe("NO");
    // role restricted to buyer|seller (plan §2.1 CHECK).
    const role = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass AND contype = 'c' AND conname LIKE '%role%'`,
    );
    expect(role.rows[0]?.def).toContain("buyer");
    expect(role.rows[0]?.def).toContain("seller");
    // dedupe_key UNIQUE → at-most-once fan-out (column-level UNIQUE constraint).
    const uniq = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass AND contype = 'u'`,
    );
    expect(uniq.rows.some((r) => r.def.includes("dedupe_key"))).toBe(true);
    // Partial unread index + full recipient listing index.
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'notifications_recipient_unread_idx'`,
    );
    expect(idx.rows[0]?.indexdef).toContain("WHERE read_at IS NULL");
  });

  it("email_outbox matches plan §2.2 (state CHECK, dedupe, due index)", async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'email_outbox'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const required of [
      "id", "notification_id", "to_email", "subject", "template", "locale", "payload",
      "status", "attempts", "next_attempt_at", "last_error", "provider_message_id",
      "sent_at", "created_at", "dedupe_key",
    ]) {
      expect(cols.has(required), `email_outbox.${required}`).toBe(true);
    }
    // Explicit state machine: only the four named states are representable.
    const check = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'email_outbox'::regclass AND contype = 'c' AND conname LIKE '%status%'`,
    );
    const def = check.rows[0]?.def ?? "";
    for (const s of ["pending", "sent", "skipped", "dead"]) {
      expect(def).toContain(s);
    }
    const bad = await db.query(
      `INSERT INTO email_outbox (to_email, subject, template, status, dedupe_key)
       VALUES ('x@example.test', 's', 't.v1', 'exploded', 'thi763-bad-status')`,
    ).catch((err) => err);
    expect(bad.code).toBe("23514"); // check_violation — illegal states rejected by the DB
    const dup = await db.query(
      `INSERT INTO email_outbox (to_email, subject, template, dedupe_key)
       VALUES ('x@example.test', 's', 't.v1', 'thi763-outbox-dedupe')`,
    );
    const dup2 = await db.query(
      `INSERT INTO email_outbox (to_email, subject, template, dedupe_key)
       VALUES ('y@example.test', 's', 't.v1', 'thi763-outbox-dedupe')`,
    ).catch((err) => err);
    expect(dup.rowCount).toBe(1);
    expect(dup2.code).toBe("23505"); // unique_violation — one email per notification
    const due = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'email_outbox' AND indexname = 'email_outbox_due_idx'`,
    );
    expect(due.rows[0]?.indexdef).toContain("WHERE status = 'pending'");
  });

  it("notify_watermarks holds one fan-out source row shape", async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'notify_watermarks'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const required of ["name", "last_event_id", "last_event_at", "updated_at"]) {
      expect(cols.has(required), `notify_watermarks.${required}`).toBe(true);
    }
  });
});

describe("notify config (THI-763 PR 1)", () => {
  it("defaults are dark: email disabled, dev base URL, plan §3/§4 knobs", () => {
    const cfg = notifyConfig({});
    expect(cfg.emailEnabled).toBe(false);
    expect(cfg.resendApiKey).toBeUndefined();
    expect(cfg.fromAddress).toBe("notifications@thingery.dev");
    expect(cfg.publicBaseUrl).toBe("http://localhost:3000");
    expect(cfg.sweepIntervalMinutes).toBe(1);
    expect(cfg.maxEmailsPerRecipientPerHour).toBe(6);
    expect(cfg.maxSendsPerSweep).toBe(50);
  });

  it("NOTIFY_PUBLIC_BASE_URL overrides PUBLIC_BASE_URL; empty values are unset (F1)", () => {
    expect(notifyConfig({ NOTIFY_PUBLIC_BASE_URL: "https://n.example.dev/", PUBLIC_BASE_URL: "https://p.example.dev" }).publicBaseUrl)
      .toBe("https://n.example.dev");
    expect(notifyConfig({ PUBLIC_BASE_URL: "https://p.example.dev///" }).publicBaseUrl)
      .toBe("https://p.example.dev");
    expect(notifyConfig({ NOTIFY_PUBLIC_BASE_URL: "   " }).publicBaseUrl).toBe("http://localhost:3000");
    expect(notifyConfig({ NOTIFY_FROM_ADDRESS: "  " }).fromAddress).toBe("notifications@thingery.dev");
  });

  it("email flag accepts only 1/true; malformed ints fall back to defaults", () => {
    expect(notifyConfig({ NOTIFY_EMAIL_ENABLED: "1" }).emailEnabled).toBe(true);
    expect(notifyConfig({ NOTIFY_EMAIL_ENABLED: "true" }).emailEnabled).toBe(true);
    expect(notifyConfig({ NOTIFY_EMAIL_ENABLED: "yes" }).emailEnabled).toBe(false);
    expect(notifyConfig({ NOTIFY_EMAIL_ENABLED: "" }).emailEnabled).toBe(false);
    expect(notifyConfig({ NOTIFY_SWEEP_INTERVAL_MINUTES: "5" }).sweepIntervalMinutes).toBe(5);
    expect(notifyConfig({ NOTIFY_SWEEP_INTERVAL_MINUTES: "zero" }).sweepIntervalMinutes).toBe(1);
    expect(notifyConfig({ NOTIFY_MAX_SENDS_PER_SWEEP: "0" }).maxSendsPerSweep).toBe(50);
  });
});
