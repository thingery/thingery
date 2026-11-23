// THI-760 plan Phase 2 / THI-780 PR 2: daily/weekly digest. Pure seams first
// (period keys, weekly Monday gate, unsubscribe token, template render), then
// the sweep + one-click unsubscribe route end-to-end (DB; skips without
// Postgres — CI runs it). The invariants: opt-in only, at most one digest per
// recipient per period (dedupe key), no empty digests, and an unsubscribe
// between planning and sending cancels the digest at the delivery gate.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dayKey,
  digestPeriodKey,
  digestUnsubscribeToken,
  runNotifyDigest,
  shouldRunFrequency,
  verifyDigestUnsubscribeToken,
  weekKey,
} from "../src/notify/digest.js";
import { renderDigest } from "../src/notify/templates.js";
import { runNotifyDelivery } from "../src/notify/delivery.js";
import type { Mailer, MailMessage, MailSendResult } from "../src/mailer.js";
import { notifyConfig } from "../src/config.js";
import { mountApiRoutes } from "../src/routes.js";

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

const MONDAY = new Date("2024-01-01T12:00:00Z"); // a known Monday
const TUESDAY = new Date("2024-01-02T12:00:00Z");

class ScriptedMailer implements Mailer {
  // THI-1046: the sweep refuses to claim from a dry_run mailer — this double
  // simulates a healthy provider.
  readonly kind = "provider" as const;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push({ ...message });
    return { ok: true };
  }
}

describe("digest period keys + weekly gate (THI-780 PR 2 — pure)", () => {
  it("day/week keys are the dedupe periods", () => {
    expect(dayKey(new Date("2024-01-01T23:59:59Z"))).toBe("2024-01-01");
    expect(weekKey(MONDAY)).toBe("2024-W01");
    expect(digestPeriodKey("daily", TUESDAY)).toBe("2024-01-02");
    expect(digestPeriodKey("weekly", TUESDAY)).toBe("2024-W01"); // Tue is still the Mon week
  });
  it("weekly runs Mondays only; daily always", () => {
    expect(shouldRunFrequency("daily", TUESDAY)).toBe(true);
    expect(shouldRunFrequency("weekly", MONDAY)).toBe(true);
    expect(shouldRunFrequency("weekly", TUESDAY)).toBe(false);
    expect(shouldRunFrequency("weekly", new Date("2024-01-07T12:00:00Z"))).toBe(false); // Sunday
  });
});

describe("unsubscribe token (THI-780 PR 2 — pure)", () => {
  it("round-trips; tampering fails closed", () => {
    const id = crypto.randomUUID();
    const token = digestUnsubscribeToken(id);
    expect(verifyDigestUnsubscribeToken(token)).toBe(id);
    expect(verifyDigestUnsubscribeToken(token.toUpperCase())).toBeNull(); // hex is case-folded by attacker? sig mismatch → null
    expect(verifyDigestUnsubscribeToken(`${crypto.randomUUID()}.deadbeef`)).toBeNull();
    expect(verifyDigestUnsubscribeToken("no-dot")).toBeNull();
    expect(verifyDigestUnsubscribeToken(undefined)).toBeNull();
    expect(verifyDigestUnsubscribeToken("")).toBeNull();
  });
});

describe("renderDigest (THI-780 PR 2 — pure)", () => {
  const rendered = renderDigest({
    frequency: "daily",
    count: 7,
    items: [
      { eventType: "seller.item_sold", itemTitle: "Vintage denim jacket", url: "https://thingery.test/item/abc" },
      { eventType: "buyer.order_placed", itemTitle: "Lava lamp" },
    ],
    unsubscribeUrl: "https://thingery.test/api/notifications/unsubscribe?token=x.y",
  });
  it("states the count, links items, carries unsubscribe + canonical footer", () => {
    expect(rendered.subject).toContain("7 updates");
    expect(rendered.text).toContain("Vintage denim jacket");
    expect(rendered.text).toContain("… and 5 more");
    expect(rendered.text).toContain("unsubscribe?token=x.y");
    expect(rendered.html).toContain("Turn off daily digests");
    expect(rendered.text).toContain("open item database and MCP server");
  });
  it("no PII: item titles only, no counterparties", () => {
    expect(rendered.text).not.toContain("@");
    expect(rendered.text).not.toMatch(/buyer@|seller@/);
  });
});

describe.skipIf(!available)("digest sweep + unsubscribe route (THI-780 PR 2 — DB)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  const cfg = notifyConfig({ NOTIFY_EMAIL_ENABLED: "1", NOTIFY_PUBLIC_BASE_URL: "https://thingery.test" });
  let dailyId = "";
  let dailyEmail = "";
  let quietId = "";

  async function seedAccount(prefs: unknown): Promise<{ id: string; email: string }> {
    const email = `thi780dg-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name, email_verified_at, profile)
       VALUES ($1, 'x', 'THI-780 Digest', now(), $2::jsonb) RETURNING id`,
      [email, JSON.stringify({ notification_prefs: prefs })],
    );
    return { id: r.rows[0].id, email };
  }

  async function seedNotification(recipientId: string, title: string): Promise<void> {
    await db.query(
      `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key)
       VALUES ($1, 'seller.item_sold', 'seller', $2::jsonb, $3)`,
      [recipientId, JSON.stringify({ item_title: title, item_id: crypto.randomUUID() }), `thi780dg:${crypto.randomUUID()}`],
    );
  }

  async function digestRows(email: string): Promise<Array<{ id: string; template: string; payload: Record<string, unknown>; status: string }>> {
    const r = await db.query(
      "SELECT id, template, payload, status FROM email_outbox WHERE to_email = $1 AND template LIKE 'digest.%' ORDER BY created_at",
      [email],
    );
    return r.rows as Array<{ id: string; template: string; payload: Record<string, unknown>; status: string }>;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    const daily = await seedAccount({ digest: "daily" });
    dailyId = daily.id;
    dailyEmail = daily.email;
    await seedNotification(dailyId, "Vintage denim jacket");
    await seedNotification(dailyId, "Lava lamp");
    const quiet = await seedAccount({ digest: "daily" });
    quietId = quiet.id; // opted in, but nothing happened

    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    server?.close();
    await db.end().catch(() => {});
  });

  it("plans exactly one digest per day for an opted-in recipient with activity", async () => {
    const now = new Date();
    const r1 = await runNotifyDigest(cfg, now);
    expect(r1.digestsPlanned).toBeGreaterThanOrEqual(1);
    const rows = await digestRows(dailyEmail);
    expect(rows).toHaveLength(1);
    expect(rows[0].template).toBe("digest.daily.v1");
    expect(rows[0].payload.count).toBe(2);
    expect(Array.isArray(rows[0].payload.items)).toBe(true);
    expect(rows[0].payload.items).toHaveLength(2);
    // Unsubscribe URL in the payload carries a token that verifies back to the account.
    const url = rows[0].payload.unsubscribe_url as string;
    const token = new URL(url).searchParams.get("token") ?? "";
    expect(verifyDigestUnsubscribeToken(token)).toBe(dailyId);

    // Re-run same day → still one row (dedupe key digest:daily:{id}:{day}).
    await runNotifyDigest(cfg, new Date(now.getTime() + 3_600_000));
    expect(await digestRows(dailyEmail)).toHaveLength(1);
  });

  it("no empty digests: opted-in recipient with no activity gets nothing", async () => {
    const quiet = await db.query<{ email: string }>("SELECT email FROM sellers WHERE id = $1", [quietId]);
    await runNotifyDigest(cfg, new Date());
    expect(await digestRows(quiet.rows[0].email)).toHaveLength(0);
  });

  it("weekly digest: planned on Monday, deduped per ISO week; non-Mondays are pure-gated", async () => {
    // Non-Monday gating is shouldRunFrequency (pure, above). Here: a weekly
    // recipient with activity gets exactly one digest.weekly.v1 on a Monday,
    // and a re-run the following Monday (same ISO week) adds nothing.
    const wk = await seedAccount({ digest: "weekly" });
    await seedNotification(wk.id, "Weekly item");
    await runNotifyDigest(cfg, MONDAY);
    const rows = await digestRows(wk.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].template).toBe("digest.weekly.v1");
    await runNotifyDigest(cfg, new Date("2024-01-05T12:00:00Z")); // Friday, same week
    expect(await digestRows(wk.email)).toHaveLength(1);
  });

  it("delivery sends the digest with List-Unsubscribe headers", async () => {
    // Make it claimable now.
    await db.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE to_email = $1 AND template LIKE 'digest.%'", [dailyEmail]);
    const mailer = new ScriptedMailer();
    await runNotifyDelivery(cfg, mailer);
    const rows = await digestRows(dailyEmail);
    expect(rows[0].status).toBe("sent");
    const msg = mailer.sent.find((m) => m.headers?.["List-Unsubscribe"]);
    expect(msg).toBeDefined();
    expect(msg?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(msg?.subject).toContain("Thingery digest");
  });

  it("one-click unsubscribe: valid token turns digest off, idempotent, pending digest cancelled", async () => {
    // Fresh activity + a new day so a new digest would be planned. (Past-day
    // sweep runs may have added rows for this recipient; the invariants are
    // about the latest row and total growth, not a fixed count.)
    await seedNotification(dailyId, "Late sale");
    const tomorrow = new Date(Date.now() + 86_400_000);
    await runNotifyDigest(cfg, tomorrow);
    const rowsBefore = await digestRows(dailyEmail);
    const latest = rowsBefore[rowsBefore.length - 1];
    expect(rowsBefore.length).toBeGreaterThanOrEqual(2); // a new day's digest was planned
    expect(latest.status).toBe("pending");

    const res = await fetch(`${base}/api/notifications/unsubscribe?token=${encodeURIComponent(digestUnsubscribeToken(dailyId))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preferences.digest).toBe("none");

    // Pref is persisted.
    const pref = await db.query<{ digest: string }>(
      "SELECT profile->'notification_prefs'->>'digest' AS digest FROM sellers WHERE id = $1", [dailyId],
    );
    expect(pref.rows[0].digest).toBe("none");

    // Clicking again is a uniform 200 (idempotent).
    const again = await fetch(`${base}/api/notifications/unsubscribe?token=${encodeURIComponent(digestUnsubscribeToken(dailyId))}`);
    expect(again.status).toBe(200);

    // The planned-but-unsent digest is cancelled at the delivery gate.
    await db.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE to_email = $1 AND template LIKE 'digest.%'", [dailyEmail]);
    await runNotifyDelivery(cfg, new ScriptedMailer());
    const rows = await digestRows(dailyEmail);
    expect(rows[rows.length - 1].status).toBe("skipped"); // cancelled by the unsubscribe

    // And no further digests are planned after unsubscribing.
    await runNotifyDigest(cfg, new Date(tomorrow.getTime() + 86_400_000));
    expect((await digestRows(dailyEmail)).length).toBe(rows.length); // nothing new
  });

  it("invalid unsubscribe token → 400", async () => {
    const res = await fetch(`${base}/api/notifications/unsubscribe?token=bogus.sig`);
    expect(res.status).toBe(400);
  });
});
