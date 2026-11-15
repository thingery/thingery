// THI-760 plan Phase 1 / THI-763 PR 4: delivery sweep. Pure seams first
// (backoff ladder, Resend adapter request shape, buildMailer fail-closed
// matrix — no DB needed), then DB state-machine walks (run everywhere with
// Postgres; CI executes).
//
// The outbox transitions asserted here are exactly plan §2.2:
//   pending → sent | skipped{no_address,not_verified} | pending(backoff) | dead

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { backoffMs, MAX_ATTEMPTS, runNotifyDelivery } from "../src/notify/delivery.js";
import { buildMailer, DryRunMailer, type MailMessage, type Mailer, type MailSendResult } from "../src/mailer.js";
import { ResendMailer } from "../src/resend.js";
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

/** Mailer double: scriptable results + captured sends. */
class ScriptedMailer implements Mailer {
  readonly kind = "dry_run" as const;
  readonly sent: MailMessage[] = [];
  constructor(private readonly results: MailSendResult[] = []) {}
  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push({ ...message });
    return this.results.shift() ?? { ok: true };
  }
}

const failing = (error: string): MailSendResult => ({ ok: false, error });

describe("backoff ladder + caps (THI-763 PR 4 — pure)", () => {
  it("1m → 2m → 4m … capped at 6h; dead at 8 attempts", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(10)).toBe(6 * 3_600_000); // 2^9 min ≈ 8.5h → capped
    expect(backoffMs(20)).toBe(6 * 3_600_000);
    expect(MAX_ATTEMPTS).toBe(8);
  });
});

describe("buildMailer fail-closed matrix (THI-763 PR 4 — pure)", () => {
  it("disabled flag → DryRunMailer, regardless of key", () => {
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "false", RESEND_API_KEY: "re_test" }).kind).toBe("dry_run");
    expect(buildMailer({ RESEND_API_KEY: "re_test" }).kind).toBe("dry_run");
  });
  it("enabled without key → DryRunMailer (never an open send path)", () => {
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "true" }).kind).toBe("dry_run");
  });
  it("enabled + key → provider mailer", () => {
    const m = buildMailer({ NOTIFY_EMAIL_ENABLED: "1", RESEND_API_KEY: "re_test", NOTIFY_FROM_ADDRESS: "no-reply@example.test" });
    expect(m.kind).toBe("provider");
  });
});

describe("ResendMailer adapter (THI-763 PR 4 — pure)", () => {
  const base = { apiKey: "re_test", baseUrl: "https://resend.test", fromAddress: "no-reply@example.test" };

  it("POSTs to /emails with bearer auth + stable idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    }) as typeof fetch;
    const mailer = new ResendMailer({ ...base, fetchImpl });
    const r = await mailer.send({ to: "a@example.test", subject: "s", text: "t", html: "<p>h</p>", idempotencyKey: "outbox-x" });
    expect(r).toEqual({ ok: true, providerMessageId: "msg-1" });
    expect(calls[0].url).toBe("https://resend.test/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Idempotency-Key"]).toBe("outbox-x");
    expect(JSON.parse(String(calls[0].init.body)).from).toBe("no-reply@example.test");
  });

  it("non-2xx and network errors come back as ok:false (never thrown)", async () => {
    const httpErr = new ResendMailer({ ...base, fetchImpl: (async () => new Response("nope", { status: 422 })) as typeof fetch });
    expect(await httpErr.send({ to: "a@b.test", subject: "s", text: "t", html: "h", idempotencyKey: "k" })).toEqual({ ok: false, error: "resend: HTTP 422" });
    const netErr = new ResendMailer({ ...base, fetchImpl: (async () => { throw new Error("timeout"); }) as typeof fetch });
    expect(await netErr.send({ to: "a@b.test", subject: "s", text: "t", html: "h", idempotencyKey: "k" })).toEqual({ ok: false, error: "resend: timeout" });
  });

  it("constructing without a key throws (loud, not open)", () => {
    expect(() => new ResendMailer({ apiKey: undefined, baseUrl: "https://x.test", fromAddress: "f@x.test" })).toThrow(/RESEND_API_KEY/);
  });
});

describe.skipIf(!available)("delivery sweep (THI-763 PR 4 — DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  const enabledCfg = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });
  const disabledCfg = notifyConfig({});

  interface Seed {
    to?: string; // undefined = the account's address; "" = deliberately no address
    verified: boolean;
    subject?: string;
    template?: string;
    nextAttemptPast?: boolean;
    attempts?: number;
    accountId?: string; // reuse an account (per-recipient cap test)
  }

  async function seedAccount(verified: boolean): Promise<{ id: string; email: string }> {
    const email = `thi763d-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const account = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at)
       VALUES ($1, 'x', 'THI-763 Delivery', $2) RETURNING id`,
      [email, verified ? new Date() : null],
    );
    return { id: account.rows[0].id, email };
  }

  async function seedOutbox(s: Seed): Promise<string> {
    const account = s.accountId
      ? { id: s.accountId, email: (await db.query<{ email: string }>("SELECT email FROM sellers WHERE id = $1", [s.accountId])).rows[0].email }
      : await seedAccount(s.verified);
    const email = s.to !== undefined ? s.to : account.email;
    const payload = JSON.stringify({
      order_id: crypto.randomUUID(), item_id: crypto.randomUUID(), item_title: "Vintage denim jacket",
      amount_cents: 1234, currency: "EUR", order_status: "pending",
    });
    const notif = await db.query<{ id: string }>(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'buyer.order_placed', 'buyer', $2::jsonb, $3) RETURNING id`,
      [account.id, payload, `thi763d:${crypto.randomUUID()}`],
    );
    const outbox = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $8 THEN now() - interval '1 minute' ELSE now() + interval '1 hour' END)
       RETURNING id`,
      [notif.rows[0].id, email, s.subject ?? "Order placed", s.template ?? "buyer.order_placed.v1",
       payload, notif.rows[0].id, s.attempts ?? 0, s.nextAttemptPast ?? true],
    );
    return outbox.rows[0].id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");
    await db.query(schema);
  });
  afterAll(async () => {
    await db.end().catch(() => {});
  });

  it("disabled sweep claims nothing (dark deploy)", async () => {
    const id = await seedOutbox({ to: "", verified: false });
    const r = await runNotifyDelivery(disabledCfg, new ScriptedMailer());
    expect(r.claimed).toBe(0);
    const row = await db.query<{ status: string }>("SELECT status FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("pending"); // untouched
  });

  it("sent: provider ok → status sent, attempts counted, provider id stored; body rendered from template+payload", async () => {
    const id = await seedOutbox({ verified: true, subject: "Order placed: Vintage denim jacket — Thingery" });
    const mailer = new ScriptedMailer([{ ok: true, providerMessageId: "re-123" }]);
    const r = await runNotifyDelivery(enabledCfg, mailer);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ status: string; provider_message_id: string; attempts: number }>(
      "SELECT status, provider_message_id, attempts FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("sent");
    expect(row.rows[0].provider_message_id).toBe("re-123");
    const mine = mailer.sent.find((m) => m.idempotencyKey === `outbox-${id}`);
    expect(mine).toBeDefined();
    expect(mine!.to).toContain("@example.test");
    expect(mine!.subject).toBe("Order placed: Vintage denim jacket — Thingery");
    expect(mine!.text).toContain("Vintage denim jacket");
    expect(mine!.html).toContain("/order/");
  });

  it("skipped: no address / unverified recipient — permanent, no retry", async () => {
    const noAddr = await seedOutbox({ to: "", verified: false });
    const unverified = await seedOutbox({ to: "", verified: false });
    // noAddr: to_email '' ; unverified: real address but verified=false
    await db.query("UPDATE email_outbox SET to_email = $2 WHERE id = $1", [unverified, `real-${runTag}@example.test`]);
    const r = await runNotifyDelivery(enabledCfg, new ScriptedMailer());
    expect(r.skipped).toBeGreaterThanOrEqual(2);
    for (const id of [noAddr, unverified]) {
      const row = await db.query<{ status: string; last_error: string }>(
        "SELECT status, last_error FROM email_outbox WHERE id = $1", [id]);
      expect(row.rows[0].status).toBe("skipped");
      expect(row.rows[0].last_error).toMatch(/^skipped:(no_address|not_verified)$/);
    }
  });

  it("failure ladder: retry with backoff, then dead at the cap", async () => {
    const id = await seedOutbox({ to: "", verified: true, attempts: MAX_ATTEMPTS - 2 });
    await db.query("UPDATE email_outbox SET to_email = $2 WHERE id = $1", [id, `ladder-${runTag}@example.test`]);
    const failTwice = new ScriptedMailer([failing("boom"), failing("boom")]);
    const r1 = await runNotifyDelivery(enabledCfg, failTwice); // attempt 7 → pending w/ backoff
    expect(r1.retried).toBeGreaterThanOrEqual(1);
    let row = await db.query<{ status: string; attempts: number; next_attempt_at: Date }>(
      "SELECT status, attempts, next_attempt_at FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].attempts).toBe(MAX_ATTEMPTS - 1);
    const due = await db.query<{ next_attempt_at: Date }>("SELECT next_attempt_at FROM email_outbox WHERE id = $1", [id]);
    expect(new Date(due.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // future

    await db.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
    const r2 = await runNotifyDelivery(enabledCfg, new ScriptedMailer([failing("boom")])); // attempt 8 → dead
    expect(r2.dead).toBeGreaterThanOrEqual(1);
    row = await db.query("SELECT status, attempts, next_attempt_at FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("dead");
    expect(row.rows[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it("per-recipient hourly cap: over-cap row stays pending, no attempt burned", async () => {
    const account = await seedAccount(true);
    // Pre-consume the hourly allowance (default cap 6) with fresh sent rows.
    for (let i = 0; i < enabledCfg.maxEmailsPerRecipientPerHour; i++) {
      const id = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
      await db.query(
        "UPDATE email_outbox SET status = 'sent', sent_at = now() - interval '30 minutes', attempts = 1 WHERE id = $1",
        [id],
      );
    }
    // One more due row for the same recipient: over cap → stays pending, 0 attempts.
    const queued = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    const mailer = new ScriptedMailer();
    const r = await runNotifyDelivery(enabledCfg, mailer);
    expect(r.rateLimited).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM email_outbox WHERE id = $1", [queued]);
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].attempts).toBe(0); // cap ≠ failure: no attempt burned
    expect(mailer.sent).toHaveLength(0); // nothing sent for this recipient
  });

  it("idempotency key is stable across retries (no double provider send)", async () => {
    const id = await seedOutbox({ to: "", verified: true });
    await db.query("UPDATE email_outbox SET to_email = $2 WHERE id = $1", [id, `idem-${runTag}@example.test`]);
    const m1 = new ScriptedMailer([failing("timeout")]);
    await runNotifyDelivery(enabledCfg, m1);
    await db.query("UPDATE email_outbox SET next_attempt_at = now() WHERE id = $1", [id]);
    const m2 = new ScriptedMailer([{ ok: true, providerMessageId: "re-9" }]);
    await runNotifyDelivery(enabledCfg, m2);
    expect(m1.sent[0]?.idempotencyKey).toBe(`outbox-${id}`);
    expect(m2.sent[0]?.idempotencyKey).toBe(`outbox-${id}`);
  });
});

// DryRunMailer remains the test/dev default.
describe("DryRunMailer still records without sending", () => {
  it("kind + record", async () => {
    const m = new DryRunMailer("test");
    const r = await m.send({ to: "a@b.test", subject: "s", text: "t", html: "h", idempotencyKey: "k" });
    expect(r.ok).toBe(true);
    expect(m.sent).toHaveLength(1);
    expect(m.kind).toBe("dry_run");
  });
});
