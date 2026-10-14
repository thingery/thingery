// THI-112 (docs/security.md §6 H4.2): structured security event logging.
// Part 1 pins the JSON-line contract of logSecurityEvent itself — one line,
// fixed whitelist of fields, and the no-payload guarantee (secret-looking
// content passed anywhere must never reach the log). Part 2 spies the
// console output at one representative call site per event family
// (signup success, login failure, rate-limit 429, listing create,
// upload reject) — no database required: pool.query is mocked via vi.spyOn,
// mirroring tests/api-error-handling.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountOauthRoutes } from "../src/oauth.js";
import { mountApiRoutes } from "../src/routes.js";
import { mcpRoutes } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";
import { logSecurityEvent, type SecurityEvent, type SecurityEventContext } from "../src/security-events.js";
import { createItem, updateItem } from "../src/items.js";
import { addItemImage } from "../src/images.js";
import { registerTools } from "../src/tools.js";
import { executeTool } from "../src/chat.js";
import type { SellerRow } from "../src/db.js";
import { AttributeValidationError } from "../src/attributes.js";
import { pool } from "../src/db.js";
import { hashPassword, SESSION_COOKIE, signSession } from "../src/auth.js";

// Deterministic embedText (null when unconfigured) — createItem must not
// depend on an embedding endpoint existing in the test environment.
delete process.env.EMBED_API_KEY;

function spyLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

type LogSpy = ReturnType<typeof spyLog>;

/** Parsed security-event lines captured by a console.log spy. */
function events(spy: LogSpy): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((v): v is string => typeof v === "string")
    .map((line) => JSON.parse(line))
    .filter((o) => typeof o === "object" && o !== null && "type" in o && "ts" in o);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Part 1 — the JSON-line contract (pure unit)

describe("logSecurityEvent JSON line", () => {
  it("emits exactly one line per event with ts/type/outcome/sellerId/ip", () => {
    const spy = spyLog();
    logSecurityEvent({ type: "signup", outcome: "success" }, { sellerId: "seller-1", ip: "203.0.113.10" });
    expect(spy).toHaveBeenCalledTimes(1);
    const raw = spy.mock.calls[0][0] as string;
    expect(raw).not.toContain("\n"); // one JSON line, not pretty-printed
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      ts: parsed.ts,
      type: "signup",
      outcome: "success",
      sellerId: "seller-1",
      ip: "203.0.113.10",
    });
    expect(Object.keys(parsed)).toEqual(["ts", "type", "outcome", "sellerId", "ip"]);
    expect(new Date(parsed.ts).toString()).not.toBe("Invalid Date");
    // The timestamp is fresh (ISO 8601 UTC), not a frozen or bogus value.
    expect(Math.abs(Date.now() - new Date(parsed.ts).getTime())).toBeLessThan(5_000);
  });

  it("carries action for listing_write and route (not outcome) for rate_limit; null for absent ctx", () => {
    const spy = spyLog();
    logSecurityEvent({ type: "listing_write", action: "delete", outcome: "rejected" });
    logSecurityEvent({ type: "rate_limit", route: "/mcp" }, { ip: "198.51.100.1" });
    const [write, limit] = events(spy);
    expect(write).toMatchObject({ type: "listing_write", action: "delete", outcome: "rejected", sellerId: null, ip: null });
    expect(limit).toMatchObject({ type: "rate_limit", route: "/mcp", ip: "198.51.100.1", sellerId: null });
    expect(limit).not.toHaveProperty("outcome"); // rate_limit has no outcome in the schema
    expect(write).not.toHaveProperty("route");
  });

  it("carries reason for image_upload rejections only when set", () => {
    const spy = spyLog();
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "too_large" }, { sellerId: "s" });
    logSecurityEvent({ type: "image_upload", outcome: "success" }, { sellerId: "s" });
    const [rej, ok] = events(spy);
    expect(rej).toMatchObject({ type: "image_upload", outcome: "rejected", reason: "too_large" });
    expect(ok).toMatchObject({ type: "image_upload", outcome: "success" });
    expect(ok).not.toHaveProperty("reason");
  });

  it("no-payload guarantee: secret-looking extra properties never reach the log", () => {
    const spy = spyLog();
    const SECRET = "hunter2-sk-SECRET-mothers-maiden-name";
    // Fixture: a caller (or a future refactor) smuggles payload-ish fields
    // onto the event and context at runtime. TypeScript would reject these;
    // the log builder must too, by construction.
    const leakyEvent = {
      type: "listing_write",
      action: "create",
      outcome: "success",
      title: `Vintage ${SECRET} sneakers`,
      description: `password: ${SECRET}`,
      images: [`https://evil.example/${SECRET}.png`],
    } as unknown as SecurityEvent;
    const leakyCtx = {
      sellerId: "seller-1",
      ip: "203.0.113.99",
      cookie: `sid=${SECRET}`,
      authorization: `Bearer ${SECRET}`,
      body: { password: SECRET },
    } as unknown as SecurityEventContext;
    logSecurityEvent(leakyEvent, leakyCtx);
    expect(spy).toHaveBeenCalledTimes(1);
    const raw = spy.mock.calls[0][0] as string;
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("title");
    expect(raw).not.toContain("description");
    expect(JSON.parse(raw)).toEqual({
      ts: expect.any(String),
      type: "listing_write",
      action: "create",
      outcome: "success",
      sellerId: "seller-1",
      ip: "203.0.113.99",
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2 — call-site families (spy on console.log at each site; no database)

describe("call sites emit their events (THI-112)", () => {
  it("listing create: createItem success logs listing_write/create/success with the seller id", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ id: "item-1", status: "active" }] } as never);
    const spy = spyLog();
    const item = await createItem({
      seller_id: "seller-create-1",
      title: "Nike Air Max 90 with api_key hunter2 inside",
      description: "super secret description text",
      category: "sneakers",
      condition: "good",
      price_cents: 12500,
      currency: "EUR",
      shipping_tier: "locker",
      images: [],
    });
    expect(item.id).toBe("item-1");
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "listing_write", action: "create", outcome: "success", sellerId: "seller-create-1", ip: null },
    ]);
    // The no-payload guarantee holds on the real call site too.
    expect(String(spy.mock.calls[0][0])).not.toContain("hunter2");
    expect(String(spy.mock.calls[0][0])).not.toContain("secret description");
  });

  it("listing update/delete: rejected on attribute shape violation, success maps status→deleted to delete", async () => {
    const spy = spyLog();
    await expect(
      updateItem("00000000-0000-0000-0000-000000000001", "seller-upd", { status: "deleted", attributes: { k: "x".repeat(501) } }),
    ).rejects.toBeInstanceOf(AttributeValidationError);
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "listing_write", action: "delete", outcome: "rejected", sellerId: "seller-upd", ip: null },
    ]);

    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ id: "item-1", status: "deleted" }] } as never);
    await updateItem("item-1", "seller-upd", { status: "deleted" });
    expect(events(spy)).toHaveLength(2);
    expect(events(spy)[1]).toMatchObject({ type: "listing_write", action: "delete", outcome: "success", sellerId: "seller-upd" });

    vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    await updateItem("item-1", "seller-upd", { price_cents: 999 });
    expect(events(spy)).toHaveLength(3);
    expect(events(spy)[2]).toMatchObject({ type: "listing_write", action: "update", outcome: "rejected", sellerId: "seller-upd" });
  });

  it("upload reject: unsupported media type logs image_upload/rejected with a slug reason (no media type echoed)", async () => {
    const spy = spyLog();
    const result = await addItemImage("seller-img", "item-1", Buffer.alloc(4), "application/octet-stream");
    expect(result).toEqual({ error: expect.stringContaining("unsupported media type") });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "image_upload", outcome: "rejected", reason: "unsupported_media_type", sellerId: "seller-img", ip: null },
    ]);
    expect(String(spy.mock.calls[0][0])).not.toContain("octet-stream");
  });

  it("upload accept: a stored image logs image_upload/success", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "thi112-uploads-"));
    process.env.UPLOADS_DIR = dir;
    try {
      vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ 1: 1 }] } as never);
      const spy = spyLog();
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      const result = await addItemImage("seller-img", "00000000-0000-0000-0000-000000000002", png, "image/png");
      expect("url" in result).toBe(true);
      expect(events(spy)).toEqual([
        { ts: expect.any(String), type: "image_upload", outcome: "success", sellerId: "seller-img", ip: null },
      ]);
    } finally {
      delete process.env.UPLOADS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// THI-133 F2 — create-time validation rejects (the family row the THI-112
// table allowed but no call site emitted): both create_listing surfaces must
// log listing_write/create/rejected before createItem ever runs.

describe("create-time validation rejects emit listing_write/create/rejected (THI-133)", () => {
  const seller: SellerRow = { id: "seller-create-rej", api_key: "thg_test", display_name: "Tester" };
  const sneakersRow = {
    name: "sneakers",
    description: "",
    attribute_definitions: [{ key: "size_eu", type: "number" as const, required: true }],
  };
  const rejectedEvent = {
    ts: expect.any(String),
    type: "listing_write",
    action: "create",
    outcome: "rejected",
    sellerId: "seller-create-rej",
    ip: null,
  };

  it("MCP create_listing (src/tools.ts): unknown_category and invalid_attributes both log the reject", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    registerTools(
      {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          handlers.set(name, handler);
        },
      },
      { seller },
    );
    const createListing = handlers.get("create_listing");
    if (!createListing) throw new Error("create_listing tool was not registered");

    const spy = spyLog();
    // unknown_category: getCategory finds nothing, listCategories feeds the hint.
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const unknown = (await createListing({
      title: "Vintage sneakers",
      price_cents: 12500,
      category: "nope",
    })) as { isError?: boolean; content?: { text?: string }[] };
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.content![0].text!).code).toBe("unknown_category");

    // invalid_attributes: category declares a required number; a string fails.
    vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [sneakersRow] } as never);
    const invalid = (await createListing({
      title: "Vintage sneakers",
      price_cents: 12500,
      category: "sneakers",
      attributes: { size_eu: "forty-three" },
    })) as { isError?: boolean; content?: { text?: string }[] };
    expect(JSON.parse(invalid.content![0].text!).code).toBe("invalid_attributes");

    expect(events(spy)).toEqual([rejectedEvent, rejectedEvent]);
  });

  it("chat create_listing (src/chat.ts): unknown category and invalid attributes both log the reject", async () => {
    const spy = spyLog();
    vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const unknown = (await executeTool(
      "create_listing",
      { title: "Vintage sneakers", price_cents: 12500, category: "nope" },
      seller,
    )) as { error?: string };
    expect(unknown.error).toContain("unknown category");

    vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [sneakersRow] } as never);
    const invalid = (await executeTool(
      "create_listing",
      { title: "Vintage sneakers", price_cents: 12500, category: "sneakers", attributes: { size_eu: "forty-three" } },
      seller,
    )) as { error?: string };
    expect(invalid.error).toContain("size_eu");

    expect(events(spy)).toEqual([rejectedEvent, rejectedEvent]);
  });
});

// --- HTTP families -----------------------------------------------------------

function buildApiApp(): Server {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "256kb" }));
  mountOauthRoutes(app);
  mountApiRoutes(app);
  return app.listen(0);
}

async function withApiServer(fn: (base: () => string) => Promise<void>): Promise<void> {
  const server = buildApiApp();
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await fn(() => `http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("HTTP call sites emit their events (THI-112)", () => {
  const JSON_HEADERS = { "content-type": "application/json" };

  it("signup success logs signup/success with seller id and client IP", async () => {
    // accountByEmail pre-check: empty; createAccount INSERT: one row.
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: "seller-signup-1", api_key: "thg_new", display_name: "Who", email: "who@example.com" }],
      } as never);
    const spy = spyLog();
    await withApiServer(async (base) => {
      const res = await fetch(`${base()}/api/signup`, {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ email: "who@example.com", password: "password123" }),
      });
      expect(res.status).toBe(200);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "signup", outcome: "success", sellerId: "seller-signup-1", ip: "198.51.100.7" },
    ]);
  });

  it("login failure logs login/failure with the IP and no credential material", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    const spy = spyLog();
    await withApiServer(async (base) => {
      const res = await fetch(`${base()}/api/login`, {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.8" },
        body: JSON.stringify({ email: "who@example.com", password: "definitely-wrong-hunter2" }),
      });
      expect(res.status).toBe(401);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "login", outcome: "failure", sellerId: null, ip: "198.51.100.8" },
    ]);
    // No email, no password fragment — failure events are not a credential oracle.
    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("who@example.com");
    expect(raw).not.toContain("definitely-wrong");
  });

  it("login success logs login/success with the seller id", async () => {
    vi.spyOn(pool, "query").mockResolvedValue({
      rows: [{
        id: "seller-login-1",
        api_key: "thg_x",
        display_name: "Who",
        email: "who@example.com",
        password_hash: hashPassword("password123"),
      }],
    } as never);
    const spy = spyLog();
    await withApiServer(async (base) => {
      const res = await fetch(`${base()}/api/login`, {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.9" },
        body: JSON.stringify({ email: "who@example.com", password: "password123" }),
      });
      expect(res.status).toBe(200);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "login", outcome: "success", sellerId: "seller-login-1", ip: "198.51.100.9" },
    ]);
  });

  it("signup rate-limit 429 logs rate_limit on the auth route", async () => {
    // Fresh module-level authAttemptLimiter bucket per distinct IP: exhaust
    // the 10/hour bucket, then assert the 11th attempt is both a 429 and an
    // event (same convention as tests/api-error-handling.test.ts T3).
    const spy = spyLog();
    const headers = { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.10" };
    await withApiServer(async (base) => {
      vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
      let status = 0;
      for (let i = 0; i < 11; i++) {
        status = (await fetch(`${base()}/api/signup`, { method: "POST", headers, body: JSON.stringify({ email: "a@b.co", password: "password123" }) })).status;
      }
      expect(status).toBe(429);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "rate_limit", route: "/api/signup", sellerId: null, ip: "198.51.100.10" },
    ]);
  });

  it("upload IP-gate 429 logs rate_limit on the upload route, pre-auth (THI-144)", async () => {
    // Same convention as the signup 429 above, for the THI-140 pre-auth IP
    // gate: exhaust the 120/hour bucket for a distinct IP with anonymous
    // requests (no cookie — the gate must reject before any session lookup,
    // which is the point of the gate), then assert the 121st is both a 429
    // and an event carrying the IP and nothing else.
    const spy = spyLog();
    const headers = { "x-forwarded-for": "198.51.100.12" };
    await withApiServer(async (base) => {
      let status = 0;
      for (let i = 0; i < 121; i++) {
        status = (await fetch(`${base()}/api/items/00000000-0000-0000-0000-000000000001/images`, { method: "POST", headers })).status;
      }
      expect(status).toBe(429);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "rate_limit", route: "/api/items/:id/images", sellerId: null, ip: "198.51.100.12" },
    ]);
  });

  it("upload seller-limiter 429 logs rate_limit with the seller id (THI-144)", async () => {
    // The THI-110 per-seller bucket: authenticated requests from a distinct
    // IP (under the 120/h gate) exhaust the 30/hour seller bucket; the 31st
    // is a 429 that logs the seller id — the attribution the seller key
    // exists for. The first 30 pass the limiter and 400 on the non-image
    // body (no content-type → not a Buffer, THI-140 guard), so no DB writes
    // beyond the mocked session lookup.
    vi.spyOn(pool, "query").mockResolvedValue({
      rows: [{ id: "00000000-0000-0000-0000-0000000000f1", api_key: "thg_x", display_name: "Flood", session_epoch: 0 }],
    } as never);
    const headers = {
      "x-forwarded-for": "198.51.100.13",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSession("00000000-0000-0000-0000-0000000000f1"))}`,
    };
    const spy = spyLog();
    await withApiServer(async (base) => {
      let status = 0;
      for (let i = 0; i < 31; i++) {
        status = (await fetch(`${base()}/api/items/00000000-0000-0000-0000-000000000001/images`, { method: "POST", headers })).status;
      }
      expect(status).toBe(429);
    });
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "rate_limit", route: "/api/items/:id/images", sellerId: "00000000-0000-0000-0000-0000000000f1", ip: null },
    ]);
  });

  it("/mcp rate-limit 429 logs rate_limit with route /mcp (mcp-gate)", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(mcpRoutes({ authedLimiter: new RateLimiter(1, 60_000), anonLimiter: new RateLimiter(1, 60_000) }));
    const server = app.listen(0);
    const spy = spyLog();
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;
      const headers = { "x-forwarded-for": "198.51.100.11" };
      const first = await fetch(`${base}/mcp`, { method: "POST", headers, body: "" });
      expect(first.status).toBe(400); // limiter passed; empty body is a parse error
      const second = await fetch(`${base}/mcp`, { method: "POST", headers, body: "" });
      expect(second.status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(events(spy)).toEqual([
      { ts: expect.any(String), type: "rate_limit", route: "/mcp", sellerId: null, ip: "198.51.100.11" },
    ]);
  });
});
