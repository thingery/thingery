// THI-762 / THI-760 Phase 0, PR 2 (HTTP surface): verify-link consumption,
// session-authed resend, /api/me verification state, and the signup→send hook.
// The mailer module is mocked so CI needs no provider key — Phase 0 never
// sends real email; DryRunMailer itself is covered in email-verification.test.ts.
// Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pg from "pg";
import { pool } from "../src/db.js";
import { EMAIL_VERIFICATION_TOKEN_RE } from "../src/auth.js";

vi.mock("../src/mailer.js", () => ({
  sendMail: (message: unknown) => sendSpy(message),
}));
const sendSpy = vi.fn(async () => ({ ok: true as const }));

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

describe.skipIf(!available)("email verification routes (THI-762 PR 2)", () => {
  let server: Server;
  let base: string;
  let db: pg.Client;
  const runTag = Math.random().toString(16).slice(2, 10);

  async function signupAndLogin(email: string): Promise<{ setCookie: string | null; body: any }> {
    const res = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }),
    });
    return { setCookie: res.headers.get("set-cookie"), body: await res.json() };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    const { mountApiRoutes } = await import("../src/routes.js"); // import AFTER vi.mock hoisting
    mountApiRoutes(app);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
  });

  it("signup attempts one verification email through the mailer seam", async () => {
    sendSpy.mockClear();
    const email = `thi762-r-signup-${runTag}@example.test`;
    const { body } = await signupAndLogin(email);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const msg = sendSpy.mock.calls[0][0] as { to: string; subject: string; text: string; idempotencyKey: string };
    expect(msg.to).toBe(email);
    expect(msg.idempotencyKey).toMatch(/^email-verification:[0-9a-f]{64}$/);
    expect(msg.text).toContain(body.email_verification.token); // the link carries the fresh token
  });

  it("GET /api/verify-email: verifies once; replay/malformed are one uniform 400", async () => {
    const email = `thi762-r-verify-${runTag}@example.test`;
    const { body } = await signupAndLogin(email);
    const token: string = body.email_verification.token;

    const ok = await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, email_verified: true });
    const row = await db.query(`SELECT email_verified_at FROM sellers WHERE email = $1`, [email]);
    expect(row.rows[0].email_verified_at).not.toBeNull();

    const bad1 = await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`); // replay
    const bad2 = await fetch(`${base}/api/verify-email?token=garbage`); // malformed
    const bad3 = await fetch(`${base}/api/verify-email`); // no token at all
    for (const res of [bad1, bad2, bad3]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid or expired verification link." }); // identical body — no oracle
    }
  });

  // --- THI-1522 (spec docs/specs/email-verification-confirmation.md):
  // content-negotiated HTML confirmation pages. Browsers (Accept prefers
  // text/html) land on a friendly page; every non-HTML-preferred client —
  // including `Accept: */*` default fetch — keeps the legacy JSON bodies
  // byte-for-byte. Security notes N1–N5 pinned below.

  it("THI-1522: browser Accept gets the HTML confirmation page; token never echoes (test plan 1, N3)", async () => {
    const email = `thi1522-html-ok-${runTag}@example.test`;
    const { body } = await signupAndLogin(email);
    const token: string = body.email_verification.token;

    const res = await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`, {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html"); // N3
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Email confirmed");
    expect(html).not.toContain(token); // N3: the URL secret never echoes into any HTML body
    const row = await db.query(`SELECT email_verified_at FROM sellers WHERE email = $1`, [email]);
    expect(row.rows[0].email_verified_at).not.toBeNull(); // DB effect unchanged (existing assertion shape)
  });

  it("THI-1522: all HTML failure modes are one byte-identical 400 body, ETag-stable (test plan 2, N2)", async () => {
    const email = `thi1522-html-fail-${runTag}@example.test`;
    const { body } = await signupAndLogin(email);
    const token: string = body.email_verification.token;
    await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`); // consume → replay is now a failure

    const accept = { accept: "text/html" };
    const results = [
      await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`, { headers: accept }), // replay
      await fetch(`${base}/api/verify-email?token=garbage`, { headers: accept }), // malformed
      await fetch(`${base}/api/verify-email`, { headers: accept }), // missing
    ];
    const bodies: string[] = [];
    const etags: Array<string | null> = [];
    for (const res of results) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("text/html"); // N3
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      etags.push(res.headers.get("etag"));
      bodies.push(await res.text());
    }
    expect(bodies[0]).toContain("This link didn't work");
    expect(new Set(bodies).size).toBe(1); // byte-identical across replay/malformed/missing — no oracle (N2)
    expect(new Set(etags).size).toBe(1); // ETag-stable for the uniform body (N2)
    for (const html of bodies) expect(html).not.toContain(token); // N3
  });

  it("THI-1522: rate-limited browser request gets a static 429 HTML page (test plan 3, N4)", async () => {
    // Own a fresh limiter bucket via a distinct X-Forwarded-For — the
    // limiters in src/routes.ts are module-level singletons shared across
    // tests (same pattern as tests/api-error-handling.test.ts T3). The 60/h
    // per-IP bucket drains on token-less requests (uniform 400, no DB hit);
    // the next one trips 429.
    const headers = { accept: "text/html", "x-forwarded-for": `203.0.113.152-${runTag}` };
    let res = await fetch(`${base}/api/verify-email`, { headers });
    for (let i = 0; res.status !== 429 && i < 65; i++) {
      res = await fetch(`${base}/api/verify-email`, { headers });
    }
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html"); // N3
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Too many attempts"); // static copy — no counts/retry math (N4)
  });

  it("THI-1522: `Accept: */*` keeps the exact legacy JSON bodies (test plan 4)", async () => {
    const email = `thi1522-json-legacy-${runTag}@example.test`;
    const { body } = await signupAndLogin(email);
    const token: string = body.email_verification.token;
    const headers = { accept: "*/*" }; // what Node/undici default fetch sends

    const ok = await fetch(`${base}/api/verify-email?token=${encodeURIComponent(token)}`, { headers });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");
    expect(await ok.json()).toEqual({ ok: true, email_verified: true }); // legacy contract byte-for-byte

    const bad = await fetch(`${base}/api/verify-email?token=garbage`, { headers });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Invalid or expired verification link." }); // exact legacy body
  });

  it("POST /api/me/resend-email-verification: auth, uniform ok, rate limit", async () => {
    const email = `thi762-r-resend-${runTag}@example.test`;
    const { setCookie } = await signupAndLogin(email);

    const anon = await fetch(`${base}/api/me/resend-email-verification`, { method: "POST" });
    expect(anon.status).toBe(401);

    sendSpy.mockClear();
    const r1 = await fetch(`${base}/api/me/resend-email-verification`, {
      method: "POST",
      headers: { cookie: setCookie ?? "" },
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.ok).toBe(true);
    expect(EMAIL_VERIFICATION_TOKEN_RE.test(b1.email_verification?.token ?? "")).toBe(true); // dev surfacing (show-once rule)
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Already verified → same ok:true, but no new token in body and no send.
    await fetch(`${base}/api/verify-email?token=${encodeURIComponent(b1.email_verification.token)}`);
    sendSpy.mockClear();
    const r2 = await fetch(`${base}/api/me/resend-email-verification`, {
      method: "POST",
      headers: { cookie: setCookie ?? "" },
    });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true });
    expect(sendSpy).not.toHaveBeenCalled();

    // Rate limit: 3/hour per account — this account spent r1 + r2, a third
    // call still passes (already-verified ok:true), the fourth trips 429.
    const r3 = await fetch(`${base}/api/me/resend-email-verification`, {
      method: "POST",
      headers: { cookie: setCookie ?? "" },
    });
    expect(r3.status).toBe(200);
    const r4 = await fetch(`${base}/api/me/resend-email-verification`, {
      method: "POST",
      headers: { cookie: setCookie ?? "" },
    });
    expect(r4.status).toBe(429);
  });

  it("POST /api/me/resend-email-verification never surfaces the token in production", async () => {
    const email = `thi762-r-prod-${runTag}@example.test`;
    const { setCookie } = await signupAndLogin(email);
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await fetch(`${base}/api/me/resend-email-verification`, {
        method: "POST",
        headers: { cookie: setCookie ?? "" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true }); // uniform body, no token field
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("GET /api/me reports email + verification state (additive; anonymous unchanged)", async () => {
    const anon = await fetch(`${base}/api/me`);
    expect(await anon.json()).toEqual({ seller: null });

    const email = `thi762-r-me-${runTag}@example.test`;
    const { setCookie, body } = await signupAndLogin(email);
    const authed = await fetch(`${base}/api/me`, { headers: { cookie: setCookie ?? "" } });
    expect(await authed.json()).toEqual({ seller: { name: body.seller.name, email, email_verified: false, unread_notifications: 0, payouts: { configured: expect.any(Boolean), started: false, onboarded: false } } }); // THI-763 + payouts: additive fields

    await fetch(`${base}/api/verify-email?token=${encodeURIComponent(body.email_verification.token)}`);
    const verified = await fetch(`${base}/api/me`, { headers: { cookie: setCookie ?? "" } });
    expect((await verified.json()).seller.email_verified).toBe(true);
  });
});
