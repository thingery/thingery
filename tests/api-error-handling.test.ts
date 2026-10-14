// THI-58 PR-1 regression tests (spec §7): every fault on the /api surface —
// handler rejections, router-internal parser limits, pre-router JSON-parser
// errors — must degrade to a generic JSON error response with an accurate
// status: no unhandled rejection, no process crash, no internal detail, and
// the server keeps serving. Non-/api surfaces are unchanged. Mirrors the
// THI-42 harness (tests/oauth-error-handling.test.ts). No database required:
// pool.query is fault-injected via vi.spyOn before any real query runs.

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mountOauthRoutes } from "../src/oauth.js";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { MAX_IMAGE_BYTES } from "../src/images.js";
import { pool } from "../src/db.js";

// Mount-order-equivalent to src/index.ts (F3 topology): the JSON parser is
// app-level BEFORE the routers, so pre-router parse errors exercise the same
// dispatch path as production. trust proxy 1 (production setting) also lets
// each test own a rate-limiter bucket via a distinct X-Forwarded-For — the
// limiters in src/routes.ts are module-level singletons shared across tests.
function buildApp(): Server {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "256kb" }));
  mountOauthRoutes(app);
  mountApiRoutes(app);
  return app.listen(0);
}

async function withServer(fn: (base: () => string) => Promise<void>): Promise<void> {
  const server = buildApp();
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await fn(() => `http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Turns the Node >= 15 unhandled-rejection kill into an assertion value. */
async function captureUnhandled(fn: () => Promise<void>): Promise<unknown> {
  let unhandled: unknown = null;
  const listener = (e: unknown) => {
    unhandled = e;
  };
  process.on("unhandledRejection", listener);
  try {
    await fn();
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

function sellerCookie(): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession("00000000-0000-0000-0000-000000000003"))}`;
}

const JSON_HEADERS = { "content-type": "application/json" };
const signupBody = JSON.stringify({ email: "who@example.com", password: "password123", name: "Who" });
const loginBody = JSON.stringify({ email: "who@example.com", password: "password123" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api surface fails as generic JSON on backend faults (THI-58)", () => {
  it("T1 /api/login DB fault: 500 JSON generic body, no unhandled rejection (F1)", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated connection reset"));
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        const res = await fetch(`${base()}/api/login`, {
          method: "POST",
          headers: { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.1" },
          body: loginBody,
        });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "Something went wrong. Please try again." });
      });
      expect(unhandled).toBeNull();
    });
  });

  it("T2 /api/signup faults: generic 500 JSON for both the pre-check and createAccount (F1/F5)", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated deadlock detected"));
    const headers = { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.2" };
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        // Pre-check (accountByEmail) fault — used to be an unhandled rejection.
        let res = await fetch(`${base()}/api/signup`, { method: "POST", headers, body: signupBody });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Something went wrong. Please try again." });
        // createAccount fault after an empty pre-check — used to leak
        // "Signup failed: <raw driver detail>" (F5).
        vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("simulated insert leak"));
        res = await fetch(`${base()}/api/signup`, { method: "POST", headers, body: signupBody });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Something went wrong. Please try again." });
      });
      expect(unhandled).toBeNull();
    });
  });

  it("T3 non-error /api paths unchanged: 400 zod, 409 duplicate, 429 limiter", async () => {
    const headers = { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.3" };
    await withServer(async (base) => {
      let res = await fetch(`${base()}/api/signup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "not-an-email", password: "x" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email and a password of at least 8 characters are required." });

      vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [{ id: "seller-existing" }] });
      res = await fetch(`${base()}/api/signup`, { method: "POST", headers, body: signupBody });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "An account with this email already exists." });

      // Exhaust the 10/hour per-IP bucket; allowed logins complete against a
      // mocked empty lookup (401) so no real DB is consulted.
      vi.spyOn(pool, "query").mockResolvedValue({ rows: [] });
      let status = 0;
      for (let i = 0; i < 12 && status !== 429; i++) {
        status = (await fetch(`${base()}/api/login`, { method: "POST", headers, body: loginBody })).status;
      }
      expect(status).toBe(429);
    });
  });

  it("T4 /api/items/:id/images upload fault: 500 JSON, no unhandled rejection (F2)", async () => {
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ id: "seller-1", api_key: "thg_x", display_name: "S" }] }) // session lookup
      .mockRejectedValueOnce(new Error("simulated failover")); // addItemImage ownership check
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        const res = await fetch(`${base()}/api/items/item-1/images`, {
          method: "POST",
          headers: { "content-type": "image/png", cookie: sellerCookie() },
          body: Buffer.alloc(16),
        });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({ error: "Something went wrong. Please try again." });
      });
      expect(unhandled).toBeNull();
    });
  });

  it("T5 malformed JSON on /api/*: 400 JSON, not the Express HTML default handler (F3)", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base()}/api/login`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Request body could not be read." });
    });
  });

  it("T6 oversized JSON and oversized image body: 413 JSON (F3/F4)", async () => {
    await withServer(async (base) => {
      const b = base();
      const json = await fetch(`${b}/api/login`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: `${"a".repeat(300_000)}@b.co`, password: "password123" }),
      });
      expect(json.status).toBe(413);
      expect(json.headers.get("content-type")).toContain("application/json");
      expect(await json.json()).toEqual({ error: "Request body too large." });

      // The router-internal express.raw limit used to be clobbered into a 500 (F4).
      const image = await fetch(`${b}/api/items/item-1/images`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: Buffer.alloc(MAX_IMAGE_BYTES + 64 * 1024 + 1),
      });
      expect(image.status).toBe(413);
      expect(await image.json()).toEqual({ error: "Request body too large." });
    });
  });

  it("T7 case-varied /API/LOGIN malformed JSON stays in scope: 400 JSON (THI-52 F1 lesson)", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base()}/API/LOGIN`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Request body could not be read." });
    });
  });

  it("T8 OAuth pass-through guard: /oauth faults keep THI-42 handling, not the /api JSON body", async () => {
    // /oauth/register (the spec's T8 example) has a local catch that answers
    // 500 JSON server_error; /oauth/token exercises the actual THI-42 HTML
    // terminal middleware. Both prove the /api middleware did not intercept.
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated serialization failure"));
    await withServer(async (base) => {
      const b = base();
      const token = await fetch(`${b}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "thgc_fault",
          code: "thga_fault",
          redirect_uri: "http://localhost:51721/callback",
          code_verifier: "v".repeat(64),
        }).toString(),
      });
      expect(token.status).toBe(500);
      expect(token.headers.get("content-type")).toContain("text/html");
      expect(await token.text()).toContain("Something went wrong"); // the THI-42 page, not our JSON body

      vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated insert failure"));
      const register = await fetch(`${b}/oauth/register`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ redirect_uris: ["https://example.com/cb"] }),
      });
      expect(register.status).toBe(500);
      expect(await register.json()).toEqual({ error: "server_error" });
    });
  });

  it("T9 keeps serving: after a login fault the next /api/login answers normally", async () => {
    const headers = { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.9" };
    await withServer(async (base) => {
      vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated connection reset"));
      const faulted = await fetch(`${base()}/api/login`, { method: "POST", headers, body: loginBody });
      expect(faulted.status).toBe(500);
      // Fault injection consumed; a normal (empty) account lookup answers the
      // ordinary 401 JSON — the process survived the earlier fault.
      vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [] });
      const next = await fetch(`${base()}/api/login`, { method: "POST", headers, body: loginBody });
      expect(next.status).toBe(401);
      expect(await next.json()).toEqual({ error: "Wrong email or password." });
    });
  });

  it("T11 signup concurrent-email race: insert 23505 → 409, other insert faults stay generic 500 (THI-61)", async () => {
    const headers = { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.11" };
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        // Pre-check resolves empty (both racing signups passed it); the insert
        // then loses on the sellers email unique constraint (pg 23505) — the
        // same 409 body as the pre-check, not the generic 500 (Security N3).
        vi.spyOn(pool, "query")
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(
            Object.assign(new Error("duplicate key value violates unique constraint \"sellers_email_key\""), { code: "23505" }),
          );
        let res = await fetch(`${base()}/api/signup`, { method: "POST", headers, body: signupBody });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "An account with this email already exists." });

        // Non-23505 insert faults keep the terminal generic 500 JSON (F5).
        vi.spyOn(pool, "query")
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(new Error("simulated insert fault"));
        res = await fetch(`${base()}/api/signup`, { method: "POST", headers, body: signupBody });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Something went wrong. Please try again." });
      });
      expect(unhandled).toBeNull();
    });
  });

  it("T10 residual pin (Security N2): /api%2Flogin and /api./login keep the Express-default HTML response", async () => {
    await withServer(async (base) => {
      for (const path of ["/api%2Flogin", "/api./login"]) {
        const res = await fetch(`${base()}${path}`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("text/html"); // default handler, not ours
        expect(await res.text()).not.toContain("Request body could not be read.");
      }
    });
  });

  it("THI-55: non-string email/password on /api/login answer 401, never a 500", async () => {
    // Repeated params are one way an array reaches a string-typed consumer;
    // a JSON body can carry arrays (or any non-string) directly. On main an
    // array email reaches email.toLowerCase() → TypeError → generic 500.
    // Guards must treat non-strings as absent credentials (fail-closed 401).
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        const arrayEmail = await fetch(`${base()}/api/login`, {
          method: "POST",
          headers: { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.21" },
          body: JSON.stringify({ email: ["who@example.com", "other@example.com"], password: "password123" }),
        });
        expect(arrayEmail.status).toBe(401);
        expect(await arrayEmail.json()).toEqual({ error: "Wrong email or password." });

        const arrayPassword = await fetch(`${base()}/api/login`, {
          method: "POST",
          headers: { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.22" },
          body: JSON.stringify({ email: "who@example.com", password: ["password123", "password456"] }),
        });
        expect(arrayPassword.status).toBe(401);
        expect(await arrayPassword.json()).toEqual({ error: "Wrong email or password." });

        // Non-object bodies (JSON array/string top level) must also 401.
        const arrayBody = await fetch(`${base()}/api/login`, {
          method: "POST",
          headers: { ...JSON_HEADERS, "x-forwarded-for": "203.0.113.23" },
          body: JSON.stringify(["who@example.com", "password123"]),
        });
        expect(arrayBody.status).toBe(401);
        expect(await arrayBody.json()).toEqual({ error: "Wrong email or password." });
      });
      expect(unhandled).toBeNull();
    });
  });
});
