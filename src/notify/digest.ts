// THI-760 plan Phase 2 / THI-780 (plan §5 + deliverable 2): daily/weekly
// digest. Opt-in only (digest pref, default 'none'); at most one digest per
// recipient per period by construction — the outbox dedupe key is
// `digest:{frequency}:{recipient}:{period}` — so replays and re-runs are
// no-ops (webhook-idempotency lens). No new state: the window starts at the
// recipient's last digest (any status) or `now - {1d|7d}`, both derived from
// email_outbox. Digest rows are account-less outbox rows (notification_id
// NULL, template `digest.daily.v1` / `digest.weekly.v1`); the delivery sweep
// is the single choke point that re-checks the digest pref at send time, so
// unsubscribing between insert and send cancels the digest.
//
// Single-instance in-process posture, same as fanout/delivery: boot run +
// setInterval, unref'd. The scan is cheap (a filtered sellers read); weekly
// recipients are only considered on Mondays (UTC), daily dedupe makes the
// hourly cadence send at most once per day.

import crypto from "node:crypto";
import { pool } from "../db.js";
import { notifyConfig, type NotifyConfig } from "../config.js";
import { parseNotificationPrefs } from "./prefs.js";
import { SESSION_SECRET } from "../auth.js";

/** Max item lines per digest (plan: "top 5 + total count"). */
const MAX_ITEMS = 5;
/** Emails per digest pass (one per recipient — a scan safety cap, not a product limit). */
const MAX_RECIPIENTS_PER_PASS = 500;

export interface DigestReport {
  scanned: number;
  digestsPlanned: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** UTC day key `YYYY-MM-DD` — the daily dedupe period. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** ISO-8601 week key `YYYY-Www` — the weekly dedupe period. */
export function weekKey(now: Date): string {
  return isoWeek(now);
}
function isoWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Weekly digests send on Mondays (UTC) only; daily runs every pass. */
export function shouldRunFrequency(frequency: "daily" | "weekly", now: Date): boolean {
  if (frequency === "daily") return true;
  return now.getUTCDay() === 1; // Monday
}

export function digestPeriodKey(frequency: "daily" | "weekly", now: Date): string {
  return frequency === "daily" ? dayKey(now) : weekKey(now);
}

/** One-click unsubscribe token: `{accountId}.{hmac}` over SESSION_SECRET
 * (same secret as sessions — rotation rotates both). Deterministic per
 * account, so tokens stay valid across sweeps; verification is
 * constant-time. The token authorizes exactly one action: setting the
 * digest pref to 'none' — nothing else. */
export function digestUnsubscribeToken(accountId: string): string {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(`digest-unsubscribe:${accountId}`).digest("hex").slice(0, 32);
  return `${accountId}.${sig}`;
}

export function verifyDigestUnsubscribeToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const accountId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`digest-unsubscribe:${accountId}`)
    .digest("hex")
    .slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return accountId;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** One recipient pass: plan a digest outbox row for `account` if anything
 * happened in its window. Returns 1 when a digest was planned. */
async function planDigestFor(
  accountId: string,
  email: string,
  frequency: "daily" | "weekly",
  cfg: NotifyConfig,
  now: Date,
): Promise<0 | 1> {
  // Window start: last digest of any kind this recipient got, else the
  // period length. Derived state, no digest bookkeeping table.
  const last = await pool.query<{ last: Date | null }>(
    `SELECT max(created_at) AS last FROM email_outbox
      WHERE to_email = $1 AND template IN ('digest.daily.v1', 'digest.weekly.v1')`,
    [email],
  );
  const windowDays = frequency === "daily" ? 1 : 7;
  const since = last.rows[0]?.last ?? new Date(now.getTime() - windowDays * 86_400_000);

  const rows = await pool.query<{ count: string; event_type: string; item_title: string | null; item_id: string | null }>(
    `SELECT count(*) OVER () AS count, event_type, payload->>'item_title' AS item_title, payload->>'item_id' AS item_id
       FROM notifications
      WHERE recipient_id = $1 AND created_at > $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [accountId, since, MAX_ITEMS],
  );
  if (rows.rows.length === 0) return 0; // no empty digests, ever
  const total = Number(rows.rows[0].count);

  const items = rows.rows.map((r) => ({
    event_type: r.event_type,
    item_title: r.item_title,
    url: r.item_id ? `${cfg.publicBaseUrl}/item/${r.item_id}` : undefined,
  }));
  const payload = {
    frequency,
    since: since.toISOString(),
    count: total,
    items,
    // Stored so delivery can stamp List-Unsubscribe headers (and the body
    // links) without re-deriving the account id from the address.
    unsubscribe_url: `${cfg.publicBaseUrl}/api/notifications/unsubscribe?token=${digestUnsubscribeToken(accountId)}`,
  };

  await pool.query(
    `INSERT INTO email_outbox (notification_id, to_email, subject, template, payload, dedupe_key, next_attempt_at)
     VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      email,
      total > MAX_ITEMS ? `Your ${frequency} Thingery digest — ${total} updates` : `Your ${frequency} Thingery digest`,
      `digest.${frequency}.v1`,
      JSON.stringify(payload),
      `digest:${frequency}:${accountId}:${digestPeriodKey(frequency, now)}`,
      new Date(now.getTime() + 60_000), // pick up by the next delivery pass
    ],
  );
  return 1;
}

export async function runNotifyDigest(
  cfg: NotifyConfig = notifyConfig(),
  now: Date = new Date(),
): Promise<DigestReport> {
  const report: DigestReport = { scanned: 0, digestsPlanned: 0 };
  // Opt-in recipients only — the pref read here is a filter; the send-time
  // re-check (delivery gate) is what makes unsubscribes cancel pending rows.
  const optIns = await pool.query<{ id: string; email: string; freq: string }>(
    `SELECT id, email, profile->'notification_prefs'->>'digest' AS freq
       FROM sellers
      WHERE profile->'notification_prefs'->>'digest' IN ('daily', 'weekly')
      LIMIT $1`,
    [MAX_RECIPIENTS_PER_PASS],
  );
  for (const r of optIns.rows) {
    if (r.freq !== "daily" && r.freq !== "weekly") continue; // belt + braces
    if (!shouldRunFrequency(r.freq, now)) continue;
    report.scanned += 1;
    try {
      report.digestsPlanned += await planDigestFor(r.id, r.email, r.freq, cfg, now);
    } catch (err) {
      console.error(`[notify-digest] recipient ${r.id} failed:`, err);
    }
  }
  return report;
}

/** Boot run + hourly (default), same posture as the other notify timers. */
export function startNotifyDigestTimer(cfg: NotifyConfig = notifyConfig()): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runNotifyDigest(cfg);
      if (r.digestsPlanned > 0) console.log(`[notify-digest] ${JSON.stringify(r)}`);
    } catch (err) {
      console.error("[notify-digest] sweep failed:", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), cfg.digestIntervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
