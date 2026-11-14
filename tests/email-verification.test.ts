// THI-762 / THI-760 plan Phase 0, PR 1 (email verification groundwork):
// schema columns exist and stay NULL on existing accounts; signup mints a
// single-use expiring token stored hash-only; the plaintext surfaces ONLY in
// non-production signup responses. No mailer, no routes, no sending yet —
// this deploy is dark by construction. Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountApiRoutes } from "../src/routes.js";
import { pool } from "../src/db.js";
import {
  createAccount,
  emailVerificationTokenHash,
  EMAIL_VERIFICATION_TOKEN_PREFIX,
  EMAIL_VERIFICATION_TTL_S,
  EMAIL_VERIFICATION_TOKEN_RE,
  issueEmailVerification,
  verifyEmailToken,
} from "../src/auth.js";
import { buildMailer, DryRunMailer, type MailMessage } from "../src/mailer.js";
import { EMAIL_TEMPLATE_KEYS, renderEmailVerification } from "../src/notify/templates.js";

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

describe.skipIf(!available)("email verification groundwork (THI-762 PR 1)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
  });
  afterAll(async () => {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("signup stores only the token hash, with a ~48h expiry, unverified", async () => {
    const account = await createAccount(`thi762-pr1-hash-${runTag}@example.test`, "correct horse battery", "THI-762");
    expect(account.email_verification_token.startsWith(EMAIL_VERIFICATION_TOKEN_PREFIX)).toBe(true);
    // 256-bit random body → 43 base64url chars after the prefix.
    expect(account.email_verification_token).toHaveLength(EMAIL_VERIFICATION_TOKEN_PREFIX.length + 43);

    const { rows } = await db.query(
      `SELECT email_verified_at, email_verification_token_hash, email_verification_expires_at, email_bounced_at
         FROM sellers WHERE id = $1`,
      [account.id],
    );
    const row = rows[0];
    expect(row.email_verified_at).toBeNull(); // new accounts start unverified
    expect(row.email_bounced_at).toBeNull(); // groundwork column, never set in Phase 0
    expect(row.email_verification_token_hash).toBe(emailVerificationTokenHash(account.email_verification_token));
    expect(row.email_verification_token_hash).not.toContain(account.email_verification_token); // hash-only at rest
    const ttlMs = new Date(row.email_verification_expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan((EMAIL_VERIFICATION_TTL_S - 60) * 1000);
    expect(ttlMs).toBeLessThan(EMAIL_VERIFICATION_TTL_S * 1000);
  });

  it("tokens are single-issue and unique (no two accounts share a hash)", async () => {
    const a = await createAccount(`thi762-pr1-a-${runTag}@example.test`, "correct horse battery", "A");
    const b = await createAccount(`thi762-pr1-b-${runTag}@example.test`, "correct horse battery", "B");
    expect(a.email_verification_token).not.toBe(b.email_verification_token);
  });

  it("signup response surfaces the token only outside production", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    mountApiRoutes(app);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const res = await fetch(`${base}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `thi762-pr1-dev-${runTag}@example.test`, password: "correct horse battery" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        seller: { email: string };
        email_verification?: { token: string; expires_in_s: number };
      };
      expect(body.seller.email).toBe(`thi762-pr1-dev-${runTag}@example.test`);
      expect(body.email_verification?.token.startsWith(EMAIL_VERIFICATION_TOKEN_PREFIX)).toBe(true);
      expect(body.email_verification?.expires_in_s).toBe(EMAIL_VERIFICATION_TTL_S);

      vi.stubEnv("NODE_ENV", "production");
      try {
        const resProd = await fetch(`${base}/api/signup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `thi762-pr1-prod-${runTag}@example.test`, password: "correct horse battery" }),
        });
        expect(resProd.status).toBe(200);
        const bodyProd = (await resProd.json()) as { email_verification?: unknown };
        expect(bodyProd.email_verification).toBeUndefined(); // never surfaced in production
        // ...and the account still got its token at rest:
        const { rows } = await db.query(
          `SELECT email_verification_token_hash FROM sellers WHERE email = $1`,
          [`thi762-pr1-prod-${runTag}@example.test`],
        );
        expect(rows[0].email_verification_token_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        vi.unstubAllEnvs();
      }
    } finally {
      server.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("schema columns are additive: existing sellers rows keep NULLs (deployable dark)", async () => {
    // A pre-Phase-0-shaped row (no verification columns set) — the ALTER
    // defaults. Legacy/NULL-email accounts are simply "not verified".
    const { rows } = await db.query(
      `INSERT INTO sellers (display_name) VALUES ($1)
       RETURNING id, email, email_verified_at, email_verification_token_hash`,
      [`thi762-legacy-${runTag}`],
    );
    const legacy = rows[0];
    expect(legacy.email).toBeNull(); // OAuth-style account, no address at all
    expect(legacy.email_verified_at).toBeNull();
    expect(legacy.email_verification_token_hash).toBeNull();
  });

  it("verifyEmailToken: consumes once, then replay/expiry/malformed all fail uniformly", async () => {
    const account = await createAccount(`thi762-pr2-verify-${runTag}@example.test`, "correct horse battery", "T");
    // 1) valid token verifies exactly this account
    const sellerId = await verifyEmailToken(account.email_verification_token);
    expect(sellerId).toBe(account.id);
    const after = await db.query(`SELECT email_verified_at, email_verification_token_hash FROM sellers WHERE id = $1`, [account.id]);
    expect(after.rows[0].email_verified_at).not.toBeNull();
    expect(after.rows[0].email_verification_token_hash).toBeNull(); // single-use: hash cleared in the same UPDATE
    // 2) replay of the consumed token
    expect(await verifyEmailToken(account.email_verification_token)).toBeNull();
    // 3) expired token (fresh account; force the expiry into the past)
    const expired = await createAccount(`thi762-pr2-expired-${runTag}@example.test`, "correct horse battery", "T");
    await db.query(`UPDATE sellers SET email_verification_expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    expect(await verifyEmailToken(expired.email_verification_token)).toBeNull();
    expect(
      (await db.query(`SELECT email_verified_at FROM sellers WHERE id = $1`, [expired.id])).rows[0].email_verified_at,
    ).toBeNull(); // expiry never transitions the state machine
    // 4) malformed / wrong-shape tokens never reach the DB
    expect(await verifyEmailToken("not-a-token")).toBeNull();
    expect(await verifyEmailToken("thge_short")).toBeNull();
    // 5) re-verifying a second account's token after it was replaced is the same null
    const replaced = await createAccount(`thi762-pr2-replaced-${runTag}@example.test`, "correct horse battery", "T");
    const oldToken = replaced.email_verification_token;
    await issueEmailVerification(replaced.id); // mints a new one, old dies
    expect(await verifyEmailToken(oldToken)).toBeNull();
  });

  it("issueEmailVerification: states for unverified/verified/no-email/unknown", async () => {
    const account = await createAccount(`thi762-pr2-resend-${runTag}@example.test`, "correct horse battery", "T");
    const issued = await issueEmailVerification(account.id);
    expect(issued?.status).toBe("issued");
    if (issued?.status === "issued") {
      expect(issued.email).toBe(`thi762-pr2-resend-${runTag}@example.test`);
      expect(EMAIL_VERIFICATION_TOKEN_RE.test(issued.token)).toBe(true);
    }
    expect((await issueEmailVerification("00000000-0000-4000-8000-000000000000"))).toBeNull(); // unknown id → null
    // Already verified → no new token.
    await verifyEmailToken(issued && issued.status === "issued" ? issued.token : "");
    expect((await issueEmailVerification(account.id))?.status).toBe("already_verified");
    // OAuth-style NULL-email account → no_email (legacy accounts are simply unverified).
    const legacy = await db.query(`INSERT INTO sellers (display_name) VALUES ($1) RETURNING id`, [`thi762-pr2-null-${runTag}`]);
    expect((await issueEmailVerification(legacy.rows[0].id))?.status).toBe("no_email");
    // Bounce-suppressed address (Phase 1 groundwork) is never re-armed.
    const bounced = await createAccount(`thi762-pr2-bounce-${runTag}@example.test`, "correct horse battery", "T");
    await db.query(`UPDATE sellers SET email_bounced_at = now() WHERE id = $1`, [bounced.id]);
    expect((await issueEmailVerification(bounced.id))?.status).toBe("suppressed");
  });
});

describe("mailer seam + templates (THI-762, no DB required)", () => {
  it("buildMailer: every Phase 0 configuration resolves to DryRunMailer (fail-closed, deployable dark)", () => {
    expect(buildMailer({}).kind).toBe("dry_run");
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "" }).kind).toBe("dry_run");
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "nope" }).kind).toBe("dry_run"); // F1: unknown value ≠ enabled
    // Even with the flag on there is no provider adapter until Phase 1 —
    // no configuration can send email in Phase 0.
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "1" }).kind).toBe("dry_run");
    expect(buildMailer({ NOTIFY_EMAIL_ENABLED: "true" }).kind).toBe("dry_run");
  });

  it("DryRunMailer records sends, logs metadata only (never bodies), always succeeds", async () => {
    const mailer = new DryRunMailer("test");
    const msg: MailMessage = {
      to: "someone@example.test",
      subject: "s",
      text: "body with thge_secret_link",
      html: "<p>body with thge_secret_link</p>",
      idempotencyKey: "k-1",
    };
    await expect(mailer.send(msg)).resolves.toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: msg.to, idempotencyKey: "k-1" });
  });

  it("renderEmailVerification: keyed template, PII-free, link + TTL present, escaped HTML", () => {
    expect(EMAIL_TEMPLATE_KEYS.emailVerification).toBe("account.email_verification.v1");
    const rendered = renderEmailVerification({
      verifyUrl: "https://thingery.dev/api/verify-email?token=thge_ABC",
      ttlHours: 48,
    });
    expect(rendered.subject).toContain("Thingery");
    expect(rendered.text).toContain("https://thingery.dev/api/verify-email?token=thge_ABC");
    expect(rendered.text).toContain("expires in 48 hours");
    expect(rendered.html).not.toContain("href=&quot;"); // attribute quoting normal — URL not double-escaped
    expect(rendered.html).toContain('<a href="https://thingery.dev/api/verify-email?token=thge_ABC">');
    // No order data or contact PII in the body — the link is the only payload
    // ("address" the word is fine; postal/address/contact data is not).
    expect(rendered.text).not.toMatch(/order|invoice|tracking|\+?\d[\d -]{6,}/i);
    expect(rendered.text.match(/@/g) ?? []).toHaveLength(0); // no embedded email addresses
  });
});
