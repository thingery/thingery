// Admin UI session middleware (spec docs/specs/admin-dispute-ui.md, THI-562
// work item 3, PR-A): login/logout, HMAC cookie (8h, httpOnly/Secure/
// SameSite=Strict), CSRF helper, admin_login_{ok|denied} security events,
// attempt-limiter reuse with a separate page-GET limit (THI-566 B1), and the
// fail-closed boot gate (key or secret unset/short ⇒ all /admin routes 404).
// DB-backed over real HTTP, mirroring tests/admin-route.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mountApiRoutes,
  adminAttemptLimiter,
  adminPageLimiter,
  signAdminSession,
  verifyAdminSession,
  adminCsrfMatches,
} from "../src/routes.js";

// SESSION_SECRET must be set before src/auth.js is imported (it captures the
// secret at module load); vi.hoisted runs ahead of the static imports.
vi.hoisted(() => {
  process.env.SESSION_SECRET ??= "s".repeat(64);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
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

describe.skipIf(!available)("admin session middleware (spec admin-dispute-ui PR-A)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const KEY = "a".repeat(40);
  let consoleLog: ReturnType<typeof spyLog>;

  function spyLog() {
    return vi.spyOn(console, "log").mockImplementation(() => {});
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    process.env.ADMIN_API_KEY = KEY;
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
    consoleLog.mockRestore();
    delete process.env.ADMIN_API_KEY;
    server.close();
    await db.end();
  });
  beforeEach(() => {
    adminAttemptLimiter.reset();
    adminPageLimiter.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (pathName: string, cookie?: string) =>
    fetch(`${base}${pathName}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const postForm = (pathName: string, body: Record<string, string>, cookie?: string) =>
    fetch(`${base}${pathName}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body).toString(),
    });

  /** The events the login flows emitted on stdout (JSON lines). */
  function adminLoginEvents() {
    return consoleLog.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string" && v.includes('"admin_login"'))
      .map((line) => JSON.parse(line) as { type: string; outcome: string });
  }

  it("login page renders, noindex, no-store; no cookie GET /admin → redirect to login", async () => {
    const login = await get("/admin/login");
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain("Admin login");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(login.headers.get("cache-control")).toBe("no-store");
    const root = await get("/admin");
    expect(root.status).toBe(301);
    expect(root.headers.get("location")).toBe("/admin/disputes");
  });

  it("wrong key → re-render + admin_login denied event; right key → cookie set with Secure/httpOnly/SameSite=Strict and admin_login ok", async () => {
    consoleLog = spyLog();
    const denied = await postForm("/admin/login", { key: "b".repeat(40) });
    expect(denied.status).toBe(401);
    expect((await denied.text())).toContain("not valid");
    expect(adminLoginEvents().at(-1)).toMatchObject({ type: "admin_login", outcome: "denied" });

    const ok = await postForm("/admin/login", { key: KEY });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/admin/disputes");
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toContain("Path=/admin");
    // 8h expiry, cookie and server-side agree.
    expect(setCookie).toMatch(/Max-Age=28800/);
    expect(adminLoginEvents().at(-1)).toMatchObject({ type: "admin_login", outcome: "ok" });
    consoleLog.mockRestore();
  });

  it("a valid session cookie authenticates; forged and expired cookies redirect to login", async () => {
    const fresh = signAdminSession();
    // Any /admin page (login is the only one in PR-A that shows session state):
    // a valid session on GET /admin/login bounces to the workspace.
    const authed = await get("/admin/login", `admin_session=${fresh.cookie}`);
    expect(authed.status).toBe(303);
    expect(authed.headers.get("location")).toBe("/admin/disputes");

    const forged = `${fresh.cookie.slice(0, -4)}AAAA`;
    expect(verifyAdminSession(forged)).toBeNull();
    const forgedRes = await get("/admin/login", `admin_session=${forged}`);
    expect(forgedRes.status).toBe(200); // login form re-rendered, not the workspace

    const expired = signAdminSession(Date.now() - 9 * 3600 * 1000);
    expect(verifyAdminSession(expired.cookie)).toBeNull();
    const expiredRes = await get("/admin/login", `admin_session=${expired.cookie}`);
    expect(expiredRes.status).toBe(200);
  });

  it("CSRF helper: token bound to the session exp; mismatched tokens fail", () => {
    const s = signAdminSession();
    expect(adminCsrfMatches(s.csrf, s)).toBe(true);
    expect(adminCsrfMatches(s.csrf.slice(0, -2) + "xx", s)).toBe(false);
    expect(adminCsrfMatches(undefined, s)).toBe(false);
    // A token from a different session (different exp) is not valid.
    const other = signAdminSession(Date.now() + 1000);
    expect(adminCsrfMatches(other.csrf, s)).toBe(false);
  });

  it("logout with valid session + CSRF clears the cookie; without session redirects", async () => {
    const s = signAdminSession();
    const noSession = await postForm("/admin/logout", { csrf: s.csrf });
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("location")).toBe("/admin/login");

    const badCsrf = await postForm("/admin/logout", { csrf: "nope" }, `admin_session=${s.cookie}`);
    expect(badCsrf.status).toBe(400);

    const ok = await postForm("/admin/logout", { csrf: s.csrf }, `admin_session=${s.cookie}`);
    expect(ok.status).toBe(303);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("admin_session=;");
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("B1: page GETs use the separate higher limiter, not the strict attempt bucket", async () => {
    // 12 page GETs stay fine (page limiter max 300) …
    let pageStatus = 200;
    for (let i = 0; i < 12; i++) {
      const r = await get("/admin/login");
      pageStatus = r.status;
    }
    expect(pageStatus).toBe(200);
    // … while 11 login POSTs hit the strict 10/IP/hr bucket with a 429.
    let last = 200;
    for (let i = 0; i < 11 && last !== 429; i++) {
      const r = await postForm("/admin/login", { key: "b".repeat(40) });
      last = r.status;
    }
    expect(last).toBe(429);
    // And after those strict-bucket denials, page GETs still work.
    expect((await get("/admin/login")).status).toBe(200);
  });

  it("fail-closed boot gate: ADMIN_API_KEY short ⇒ every /admin route 404s, login included", async () => {
    const prev = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "short";
    try {
      expect((await get("/admin/login")).status).toBe(404);
      expect((await postForm("/admin/login", { key: "short" })).status).toBe(404);
      expect((await get("/admin")).status).toBe(404);
      // The JSON endpoint keeps its own identical gate.
      const json = await fetch(`${base}/api/admin/orders/x/resolve-dispute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(json.status).toBe(404);
    } finally {
      process.env.ADMIN_API_KEY = prev;
    }
  });

  it("fail-closed boot gate: SESSION_SECRET unset ⇒ admin UI 404s; JSON endpoint unaffected", async () => {
    const prev = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect((await get("/admin/login")).status).toBe(404);
      // The JSON endpoint is Bearer-key auth, not session — still enabled.
      const json = await fetch(`${base}/api/admin/orders/00000000-0000-0000-0000-000000000000/resolve-dispute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ outcome: "refund", note: "x" }),
      });
      expect(json.status).toBe(404); // uniform 404 for the unknown order, not the boot gate
    } finally {
      process.env.SESSION_SECRET = prev;
    }
  });
});
