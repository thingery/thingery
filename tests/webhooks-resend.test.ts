// THI-760 plan Phase 2 / THI-780 PR 1: Resend bounce webhook. Pure signature
// verification first (fake HMACs computed exactly like Resend's), then the
// handler end-to-end on an express app (skips without Postgres; CI runs it):
// valid bounce → suppression + pending cancellation, invalid signature → 400,
// unset secret → 503 fail-closed, redelivery → no-op (idempotent).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resendWebhookRouter, verifyResendSignature } from "../src/webhooks-resend.js";

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

const SECRET = "whsec_test_secret";

function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("base64");
  return `t=${t},v1=${v1}`;
}

describe("verifyResendSignature (pure)", () => {
  const body = Buffer.from(JSON.stringify({ type: "email.bounced" }));
  it("accepts a correctly signed, fresh payload", () => {
    expect(verifyResendSignature(body, sign(body.toString()), SECRET)).toBe(true);
  });
  it("rejects wrong secret, tampered body, missing/garbled header", () => {
    expect(verifyResendSignature(body, sign(body.toString(), "other"), SECRET)).toBe(false);
    expect(verifyResendSignature(Buffer.from("{}"), sign(body.toString()), SECRET)).toBe(false);
    expect(verifyResendSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyResendSignature(body, "garbage", SECRET)).toBe(false);
  });
  it("rejects stale timestamps (replay window 5 min)", () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(verifyResendSignature(body, sign(body.toString(), SECRET, old), SECRET)).toBe(false);
  });
});

describe.skipIf(!available)("POST /api/webhooks/resend (THI-780 PR 1)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let email = "";
  let sellerId = "";
  let pendingOutboxId = "";

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    email = `thi780w-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-780 Bounce', now()) RETURNING id`, [email],
    );
    sellerId = r.rows[0].id;
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'seller.item_sold', 'seller', '{}'::jsonb, $2) RETURNING id`,
      [sellerId, `thi780w:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
       VALUES ($1, $2, 's', 'seller.item_sold.v1', '{}'::jsonb, $3, now() - interval '1 minute') RETURNING id`,
      [notif.rows[0].id, email, notif.rows[0].id],
    );
    pendingOutboxId = outbox.rows[0].id;

    const app = express();
    app.use(resendWebhookRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    server?.close();
    await db.end().catch(() => {});
  });

  async function post(body: string, signature?: string): Promise<Response> {
    return fetch(`${base}/api/webhooks/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(signature ? { "resend-signature": signature } : {}) },
      body,
    });
  }

  it("invalid or missing signature → 400, nothing changes", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email } });
    for (const sig of [undefined, sign(body, "wrong-secret")]) {
      const res = await post(body, sig);
      expect(res.status).toBe(400);
    }
    const s = await db.query<{ email_bounced_at: Date | null; status: string }>(
      "SELECT (SELECT email_bounced_at FROM sellers WHERE id = $1) AS email_bounced_at, status FROM email_outbox WHERE id = $2",
      [sellerId, pendingOutboxId],
    );
    expect(s.rows[0].email_bounced_at).toBeNull();
    expect(s.rows[0].status).toBe("pending");
  });

  it("valid bounce → account suppressed, pending rows cancelled", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email } });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    const s = await db.query<{ bounced: boolean; status: string; last_error: string | null }>(
      `SELECT (email_bounced_at IS NOT NULL) AS bounced FROM sellers WHERE id = $1`, [sellerId],
    );
    expect(s.rows[0].bounced).toBe(true);
    const outbox = await db.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [pendingOutboxId],
    );
    expect(outbox.rows[0]).toMatchObject({ status: "skipped", last_error: "skipped:bounced" });
  });

  it("redelivery is a no-op (idempotent suppression)", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email } });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    const outbox = await db.query<{ attempts: number; status: string }>(
      "SELECT attempts, status FROM email_outbox WHERE id = $1", [pendingOutboxId],
    );
    expect(outbox.rows[0].status).toBe("skipped"); // unchanged, not re-processed
  });

  it("other event types are acknowledged 200 without action", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email } });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe("email.delivered");
  });

  it("bounce for an unknown email → 200 ok (nothing to suppress; no enumeration)", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email: `nobody-${runTag}@example.test` } });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
  });

  it("unset secret → 503 fail-closed", async () => {
    const saved = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const body = JSON.stringify({ type: "email.bounced", data: { email } });
      const res = await post(body, sign(body));
      expect(res.status).toBe(503);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = saved;
    }
  });
});

// THI-1537: RESEND_WEBHOOK_SECRET_PREVIOUS rotation tolerance. Regression
// against the pre-fix behavior — the old handler verified against the
// single secret only, so a rotation dropped every delivery signed with the
// prior secret (400, zero writes) until the new secret reached both the
// app env and the Resend dashboard atomically. Own seller + outbox row so
// assertions are independent of the blocks above.
describe.skipIf(!available)("POST /api/webhooks/resend previous-secret rotation tolerance (THI-1537)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  const PREVIOUS_SECRET = "whsec_test_secret_previous";
  let email = "";
  let sellerId = "";
  let pendingOutboxId = "";

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    process.env.RESEND_WEBHOOK_SECRET_PREVIOUS = PREVIOUS_SECRET;
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    email = `thi1537p-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-1537 Previous', now()) RETURNING id`, [email],
    );
    sellerId = r.rows[0].id;
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'seller.item_sold', 'seller', '{}'::jsonb, $2) RETURNING id`,
      [sellerId, `thi1537p:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
       VALUES ($1, $2, 's', 'seller.item_sold.v1', '{}'::jsonb, $3, now() - interval '1 minute') RETURNING id`,
      [notif.rows[0].id, email, notif.rows[0].id],
    );
    pendingOutboxId = outbox.rows[0].id;

    const app = express();
    app.use(resendWebhookRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET_PREVIOUS;
    server?.close();
    await db.end().catch(() => {});
  });

  async function post(body: string, signature?: string): Promise<Response> {
    return fetch(`${base}/api/webhooks/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(signature ? { "resend-signature": signature } : {}) },
      body,
    });
  }

  it("signature from the previous secret is accepted → suppression acts (rotation window)", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { email } });
    // Old code: 400 signature verification failed, zero writes — the
    // rotation dropped this delivery. New code: accepted and acted on.
    const res = await post(body, sign(body, PREVIOUS_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressed: true });
    const s = await db.query<{ bounced: boolean }>(
      `SELECT (email_bounced_at IS NOT NULL) AS bounced FROM sellers WHERE id = $1`, [sellerId],
    );
    expect(s.rows[0].bounced).toBe(true);
    const outbox = await db.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [pendingOutboxId],
    );
    expect(outbox.rows[0]).toMatchObject({ status: "skipped", last_error: "skipped:bounced" });
  });

  it("current secret still verifies first (previous is a fallback, not a replacement)", async () => {
    const email2 = `thi1537c-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await db.query(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-1537 Current', now())`, [email2],
    );
    const body = JSON.stringify({ type: "email.bounced", data: { email: email2 } });
    const res = await post(body, sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressed: true });
  });

  it("a secret that is neither current nor previous → 400, nothing changes", async () => {
    const email3 = `thi1537n-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await db.query(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-1537 Neither', now())`, [email3],
    );
    const body = JSON.stringify({ type: "email.bounced", data: { email: email3 } });
    const res = await post(body, sign(body, "whsec_not_configured_at_all"));
    expect(res.status).toBe(400);
    const s = await db.query<{ bounced: boolean }>(
      `SELECT (email_bounced_at IS NOT NULL) AS bounced FROM sellers WHERE email = $1`, [email3],
    );
    expect(s.rows[0].bounced).toBe(false);
  });

  it("unset previous (secure default) → old secret rejected, exactly today's behavior", async () => {
    const saved = process.env.RESEND_WEBHOOK_SECRET_PREVIOUS;
    delete process.env.RESEND_WEBHOOK_SECRET_PREVIOUS;
    try {
      const email4 = `thi1537d-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
      await db.query(
        `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
         VALUES ($1, 'x', 'THI-1537 Default', now())`, [email4],
      );
      const body = JSON.stringify({ type: "email.bounced", data: { email: email4 } });
      const res = await post(body, sign(body, PREVIOUS_SECRET));
      expect(res.status).toBe(400);
      const s = await db.query<{ bounced: boolean }>(
        `SELECT (email_bounced_at IS NOT NULL) AS bounced FROM sellers WHERE email = $1`, [email4],
      );
      expect(s.rows[0].bounced).toBe(false);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET_PREVIOUS = saved;
    }
  });

  it("current secret unset + previous set → 503 fail-closed (no bypass)", async () => {
    const savedCurrent = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const body = JSON.stringify({ type: "email.bounced", data: { email } });
      const res = await post(body, sign(body, PREVIOUS_SECRET));
      expect(res.status).toBe(503);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = savedCurrent;
    }
  });
});

// THI-1486: `email.complained` (spam report) must suppress like a bounce.
// Regression against the pre-fix behavior — the old handler answered
// 200 {"ignored":"email.complained"} with zero writes, so an address that
// reported our mail as spam kept receiving it. Own seller + outbox row so
// assertions are independent of the bounce block's state above.
describe.skipIf(!available)("POST /api/webhooks/resend complaint suppression (THI-1486)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let email = "";
  let sellerId = "";
  let pendingOutboxId = "";

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    email = `thi1486-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-1486 Complaint', now()) RETURNING id`, [email],
    );
    sellerId = r.rows[0].id;
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'seller.item_sold', 'seller', '{}'::jsonb, $2) RETURNING id`,
      [sellerId, `thi1486:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
       VALUES ($1, $2, 's', 'seller.item_sold.v1', '{}'::jsonb, $3, now() - interval '1 minute') RETURNING id`,
      [notif.rows[0].id, email, notif.rows[0].id],
    );
    pendingOutboxId = outbox.rows[0].id;

    const app = express();
    app.use(resendWebhookRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    server?.close();
    await db.end().catch(() => {});
  });

  async function post(body: string): Promise<Response> {
    return fetch(`${base}/api/webhooks/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "resend-signature": sign(body) },
      body,
    });
  }

  it("signed complaint → account suppressed, pending rows cancelled", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { email } });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressed: true });
    const s = await db.query<{ bounced: boolean }>(
      `SELECT (email_bounced_at IS NOT NULL) AS bounced FROM sellers WHERE id = $1`, [sellerId],
    );
    expect(s.rows[0].bounced).toBe(true);
    const outbox = await db.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [pendingOutboxId],
    );
    expect(outbox.rows[0]).toMatchObject({ status: "skipped", last_error: "skipped:complained" });
  });

  it("complaint redelivery is a no-op (idempotent suppression)", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { email } });
    const res = await post(body);
    expect(res.status).toBe(200);
    const outbox = await db.query<{ attempts: number; status: string; last_error: string | null }>(
      "SELECT attempts, status, last_error FROM email_outbox WHERE id = $1", [pendingOutboxId],
    );
    expect(outbox.rows[0]).toMatchObject({ attempts: 0, status: "skipped", last_error: "skipped:complained" });
  });

  it("complaint for an unknown email → 200 ok (nothing to suppress; no enumeration)", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { email: `nobody-${runTag}@example.test` } });
    const res = await post(body);
    expect(res.status).toBe(200);
  });
});
