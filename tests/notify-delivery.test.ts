// THI-760 plan Phase 1 / THI-763 PR 4: delivery sweep. Pure seams first
// (backoff ladder, Resend adapter request shape, buildMailer fail-closed
// matrix — no DB needed), then DB state-machine walks (run everywhere with
// Postgres; CI executes).
//
// The outbox transitions asserted here are exactly plan §2.2:
//   pending → sent | skipped{no_address,not_verified} | pending(backoff) | dead

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  // THI-1046: the sweep refuses to claim from a dry_run mailer, so this
  // double simulates a healthy provider (scripted results incl. provider ids).
  readonly kind = "provider" as const;
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

describe("NOTIFY_MAX_AGE_HOURS config (THI-1043 — pure)", () => {
  it("defaults to 48; positive ints parse; zero/garbage/blank fall back", () => {
    expect(notifyConfig({}).maxAgeHours).toBe(48);
    expect(notifyConfig({ NOTIFY_MAX_AGE_HOURS: "24" }).maxAgeHours).toBe(24);
    expect(notifyConfig({ NOTIFY_MAX_AGE_HOURS: "0" }).maxAgeHours).toBe(48); // no off-value: set a large horizon instead
    expect(notifyConfig({ NOTIFY_MAX_AGE_HOURS: "abc" }).maxAgeHours).toBe(48);
    expect(notifyConfig({ NOTIFY_MAX_AGE_HOURS: " " }).maxAgeHours).toBe(48); // F1 empty-is-unset
  });
});

describe("RESEND_WEBHOOK_SECRET_PREVIOUS config (THI-1537 — pure)", () => {
  it("parses only while the current secret is set; blank counts as unset (F1)", () => {
    // Secure default: previous alone must never arm a webhook.
    expect(notifyConfig({ RESEND_WEBHOOK_SECRET_PREVIOUS: "old" }).resendWebhookSecretPrevious).toBeUndefined();
    expect(notifyConfig({ RESEND_WEBHOOK_SECRET: " " }).resendWebhookSecretPrevious).toBeUndefined();
    expect(notifyConfig({ RESEND_WEBHOOK_SECRET: "cur", RESEND_WEBHOOK_SECRET_PREVIOUS: " " }).resendWebhookSecretPrevious).toBeUndefined();
    expect(notifyConfig({ RESEND_WEBHOOK_SECRET: "cur", RESEND_WEBHOOK_SECRET_PREVIOUS: "old" }).resendWebhookSecretPrevious).toBe("old");
  });
});

describe("sender identities (THI-1280 — pure)", () => {
  it("notifyConfig defaults: noreply@ transactional, notifications@ digests, support@ Reply-To", () => {
    const cfg = notifyConfig({});
    expect(cfg.fromAddress).toBe("noreply@thingery.dev");
    expect(cfg.digestFromAddress).toBe("notifications@thingery.dev");
    expect(cfg.replyToAddress).toBe("support@thingery.dev");
  });
  it("env overrides parse; blank counts as unset (F1)", () => {
    const cfg = notifyConfig({ NOTIFY_FROM_ADDRESS: "x@y.test", NOTIFY_DIGEST_FROM_ADDRESS: "d@y.test", NOTIFY_REPLY_TO_ADDRESS: " " });
    expect(cfg.fromAddress).toBe("x@y.test");
    expect(cfg.digestFromAddress).toBe("d@y.test");
    expect(cfg.replyToAddress).toBe("support@thingery.dev");
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

  it("reply_to: config default applied when the message sets none (THI-1280)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    }) as typeof fetch;
    const mailer = new ResendMailer({ ...base, replyToAddress: "support@example.test", fetchImpl });
    await mailer.send({ to: "a@example.test", subject: "s", text: "t", html: "<p>h</p>", idempotencyKey: "outbox-x" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.reply_to).toBe("support@example.test");
    expect(body.from).toBe("no-reply@example.test");
  });

  it("message-level from/replyTo override the configured defaults (THI-1280)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg-2" }), { status: 200 });
    }) as typeof fetch;
    const mailer = new ResendMailer({ ...base, replyToAddress: "support@example.test", fetchImpl });
    await mailer.send({ to: "a@example.test", subject: "s", text: "t", html: "<p>h</p>", idempotencyKey: "outbox-x", from: "notifications@example.test", replyTo: "desk@example.test" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.from).toBe("notifications@example.test");
    expect(body.reply_to).toBe("desk@example.test");
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
  // THI-1043: explicit cutoff so the staleness tests pin the knob, not the default.
  const staleCfg = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_MAX_AGE_HOURS: "48", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });

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
  beforeEach(async () => {
    // Hermetic reset (THI-993 PR 4): this file asserts exact provider ids on
    // rows it seeds itself, but the delivery sweep claims ALL due rows
    // (created_at ASC) — a due pending row left by an earlier test file
    // steals the single scripted mailer response and the assertion reads a
    // null provider id. Files share one DB; clean slate per test.
    await db.query("TRUNCATE email_outbox, notifications RESTART IDENTITY CASCADE");
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
    // THI-780 PR 1: the gate resolves accounts by to_email — the ladder row
    // must point at a real verified account, else it is skipped:not_verified
    // before any send attempt (correct behavior, wrong fixture here).
    const account = await seedAccount(true);
    const id = await seedOutbox({ to: account.email, verified: true, attempts: MAX_ATTEMPTS - 2, accountId: account.id });
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
    // Real verified account for the same THI-780 PR 1 reason as above.
    const account = await seedAccount(true);
    const id = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    const m1 = new ScriptedMailer([failing("timeout")]);
    await runNotifyDelivery(enabledCfg, m1);
    await db.query("UPDATE email_outbox SET next_attempt_at = now() WHERE id = $1", [id]);
    const m2 = new ScriptedMailer([{ ok: true, providerMessageId: "re-9" }]);
    await runNotifyDelivery(enabledCfg, m2);
    expect(m1.sent[0]?.idempotencyKey).toBe(`outbox-${id}`);
    expect(m2.sent[0]?.idempotencyKey).toBe(`outbox-${id}`);
  });

  // THI-1043: staleness cutoff. `now` is injected so the boundary is
  // deterministic — created_at is seeded relative to the same instant the
  // sweep will judge against (strict <: a row exactly at the cutoff is
  // still fresh).
  const ageTo = (id: string, created: Date) =>
    db.query("UPDATE email_outbox SET created_at = $2 WHERE id = $1", [id, created]);

  it("staleness cutoff: stale row skips (skipped:stale), fresh row sends; oldest-first claim unaffected", async () => {
    const now = new Date();
    const account = await seedAccount(true);
    // Oldest row is stale (49h > 48h cutoff): without the cutoff it would be
    // claimed first (created_at ASC) and steal the single scripted send.
    const staleId = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    await ageTo(staleId, new Date(now.getTime() - 49 * 3_600_000));
    const freshId = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    const mailer = new ScriptedMailer([{ ok: true, providerMessageId: "re-fresh" }]);
    const r = await runNotifyDelivery(staleCfg, mailer, now);
    expect(r.staleSkipped).toBe(1);
    expect(r.sent).toBe(1);
    const staleRow = await db.query<{ status: string; last_error: string; attempts: number; sent_at: Date }>(
      "SELECT status, last_error, attempts, sent_at FROM email_outbox WHERE id = $1", [staleId]);
    expect(staleRow.rows[0].status).toBe("skipped");
    expect(staleRow.rows[0].last_error).toBe("skipped:stale"); // distinguishable from gate + manual skips
    expect(staleRow.rows[0].attempts).toBe(1); // same bookkeeping as markSkipped
    expect(staleRow.rows[0].sent_at).toBeNull();
    const freshRow = await db.query<{ status: string; provider_message_id: string }>(
      "SELECT status, provider_message_id FROM email_outbox WHERE id = $1", [freshId]);
    expect(freshRow.rows[0].status).toBe("sent");
    expect(freshRow.rows[0].provider_message_id).toBe("re-fresh"); // the stale row did not consume the send
  });

  it("staleness cutoff boundary: exactly at the cutoff still sends, past it skips", async () => {
    const now = new Date();
    const account = await seedAccount(true);
    const atEdge = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    await ageTo(atEdge, new Date(now.getTime() - 48 * 3_600_000)); // == cutoff → fresh (strict <)
    const pastEdge = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    await ageTo(pastEdge, new Date(now.getTime() - 48 * 3_600_000 - 1_000)); // 1s past → stale
    const mailer = new ScriptedMailer([{ ok: true, providerMessageId: "re-edge" }]);
    const r = await runNotifyDelivery(staleCfg, mailer, now);
    expect(r.staleSkipped).toBe(1);
    expect(r.sent).toBe(1);
    const edge = await db.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [atEdge]);
    expect(edge.rows[0].status).toBe("sent");
    const past = await db.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [pastEdge]);
    expect(past.rows[0].status).toBe("skipped");
    expect(past.rows[0].last_error).toBe("skipped:stale");
  });

  it("staleness applies to not-yet-due rows too (a rate-limited backlog ages out)", async () => {
    const now = new Date();
    const account = await seedAccount(true);
    // next_attempt_at in the future (rate-capped posture): age alone must decide.
    const id = await seedOutbox({ to: account.email, verified: true, accountId: account.id, nextAttemptPast: false });
    await ageTo(id, new Date(now.getTime() - 50 * 3_600_000));
    const mailer = new ScriptedMailer();
    const r = await runNotifyDelivery(staleCfg, mailer, now);
    expect(r.staleSkipped).toBe(1);
    expect(r.claimed).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    const row = await db.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("skipped");
    expect(row.rows[0].last_error).toBe("skipped:stale");
  });

  // THI-1046 (Security THI-1042, fail-securely): NOTIFY_EMAIL_ENABLED on +
  // RESEND_API_KEY missing boots a DryRunMailer whose send() always succeeds
  // with no provider id — the sweep must refuse to claim, or it would mark
  // rows 'sent' with nothing delivered (terminal, false-positive ops signal).
  // Misconfiguration window = dark window: even stale rows stay pending; the
  // THI-1043 cutoff ages the backlog out on the first healthy sweep.
  it("dry-run mailer + enabled flag claims nothing — rows stay pending, never 'sent' (THI-1046)", async () => {
    const account = await seedAccount(true);
    const fresh = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    const stale = await seedOutbox({ to: account.email, verified: true, accountId: account.id });
    await ageTo(stale, new Date(Date.now() - 100 * 3_600_000)); // far past the 48h cutoff
    const dryRun = new DryRunMailer("enabled without RESEND_API_KEY (fail-closed)");
    const r = await runNotifyDelivery(enabledCfg, dryRun);
    expect(r).toEqual({ claimed: 0, sent: 0, skipped: 0, retried: 0, dead: 0, rateLimited: 0, staleSkipped: 0 });
    expect(dryRun.sent).toHaveLength(0); // nothing even handed to the send path
    for (const id of [fresh, stale]) {
      const row = await db.query<{ status: string; attempts: number; provider_message_id: string | null }>(
        "SELECT status, attempts, provider_message_id FROM email_outbox WHERE id = $1", [id]);
      expect(row.rows[0].status).toBe("pending"); // recoverable — never 'sent' via dry-run
      expect(row.rows[0].attempts).toBe(0); // misconfiguration burns no attempts
      expect(row.rows[0].provider_message_id).toBeNull();
    }
  });

  it("disabled sweep leaves even stale rows pending (dark posture unchanged)", async () => {
    const id = await seedOutbox({ to: "", verified: false });
    await db.query("UPDATE email_outbox SET created_at = now() - interval '100 hours' WHERE id = $1", [id]);
    const r = await runNotifyDelivery(disabledCfg, new ScriptedMailer());
    expect(r).toEqual({ claimed: 0, sent: 0, skipped: 0, retried: 0, dead: 0, rateLimited: 0, staleSkipped: 0 });
    const row = await db.query<{ status: string }>("SELECT status FROM email_outbox WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("pending"); // untouched while dark
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
