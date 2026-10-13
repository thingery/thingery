// THI-42 regression tests: unguarded async errors in OAuth route handlers
// must degrade to HTTP error responses — never escape as unhandled promise
// rejections that crash the process (Express 4 does not route rejections from
// async handlers to error middleware; Node >= 15 terminates on unhandled
// rejection, so one Postgres blip meant a crash/restart cycle while requests
// were in flight).
//
// No database required: pool.query is fault-injected via vi.spyOn before any
// real query runs.

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mountOauthRoutes } from "../src/oauth.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { pool } from "../src/db.js";

function buildApp(): Server {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "256kb" }));
  mountOauthRoutes(app);
  return app.listen(0);
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = buildApp();
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Registers a process-level unhandledRejection listener around fn so the
 * Node >= 15 default (terminate the process) becomes an assertion value
 * instead. Same technique as the THI-27 /mcp gate regression tests.
 */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth surface fails securely on backend faults (THI-42)", () => {
  it("/apps: a rejected pool.query answers 500 with page headers — no unhandled rejection, server keeps serving", async () => {
    // Old behavior: the grants SELECT (src/oauth.ts /apps handler) rejected
    // outside any try/catch; the rejection escaped the async Express 4
    // handler, no response was ever sent, and the process died.
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated connection reset"));
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession("00000000-0000-0000-0000-000000000001"))}`;
    await withServer(async (baseUrl) => {
      const unhandled = await captureUnhandled(async () => {
        const res = await fetch(`${baseUrl}/apps`, { headers: { cookie } });
        expect(res.status).toBe(500);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
        const body = await res.text();
        expect(body).toContain("Something went wrong");
        // No token material, no error detail — a plain page (fail securely).
        expect(body).not.toMatch(/thgo_|thgr_|thga_|thg_|csrf|nonce|connection reset/i);
      });
      expect(unhandled).toBeNull();
      // The process survived: the next request (no DB involved) is answered.
      const next = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      expect(next.status).toBe(200);
    });
  });

  it("/oauth/token: a rejected pool.query (clientById) answers 500 — token endpoint degrades, never crashes", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated deadlock detected"));
    await withServer(async (baseUrl) => {
      const unhandled = await captureUnhandled(async () => {
        const res = await fetch(`${baseUrl}/oauth/token`, {
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
        expect(res.status).toBe(500);
        expect(res.headers.get("cache-control")).toBe("no-store");
      });
      expect(unhandled).toBeNull();
    });
  });

  it("case-variated OAuth paths stay in scope: /Apps fault answers the hardened 500, logs the security event, leaks nothing (THI-52 F1)", async () => {
    // Express 4 routes case-insensitively; the scope check used to compare
    // req.path prefixes case-sensitively, so /Apps faults fell through to the
    // Express default handler: no security_event logged, and outside
    // production the raw error message was disclosed in the response body.
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated serialization failure"));
    const logged: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession("00000000-0000-0000-0000-000000000002"))}`;
    try {
      await withServer(async (baseUrl) => {
        const unhandled = await captureUnhandled(async () => {
          const res = await fetch(`${baseUrl}/Apps`, { headers: { cookie } });
          expect(res.status).toBe(500);
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(res.headers.get("x-frame-options")).toBe("DENY");
          const body = await res.text();
          expect(body).toContain("Something went wrong"); // hardened page, not the default handler's
          expect(body).not.toContain("simulated serialization failure"); // no raw error disclosure
        });
        expect(unhandled).toBeNull();
      });
      expect(logged.some((line) => line.includes("unhandled_route_error"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("oversized JSON POST to /oauth/register keeps its 413 (body-parser status not swallowed into 500)", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://" + "a".repeat(300_000) + ".example"] }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("oversized JSON POST to a non-OAuth path keeps Express default handling (blast-radius guard)", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/not-an-oauth-route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(300_000),
      });
      expect(res.status).toBe(413);
      const body = await res.text();
      // Passed through to the default handler — NOT our OAuth 500 page.
      expect(body).not.toContain("Back to Thingery");
    });
  });
});
