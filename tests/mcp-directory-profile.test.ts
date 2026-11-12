// THI-614: the `?profile=directory` subset pin. The Claude Connectors
// Directory rejects connectors that transfer money or other financial assets
// (claude.com/docs/connectors/building/review-criteria, verified 2026-11-11),
// so the directory listing is served a fixed include list (board product
// decision: card ce4cd554 on THI-613, 2026-11-11, "Option A"). These tests
// FAIL on any add or remove:
//
//   1. The literal 15-name list below is the pin — editing it is a deliberate,
//      reviewed act (it changes what the Claude listing can do).
//   2. `?profile=directory` must register exactly those 15 tools — a new
//      money-touching tool added to src/tools.ts cannot silently leak into
//      the directory listing because it is not on the include list.
//   3. The canonical /mcp (no param) is unchanged: the full surface (34
//      registered tools for anonymous/API-key/OAuth callers, plus 3 more
//      session-only account tools under the web session — #249/#250), with
//      every excluded order/payment/payout/intent/account tool still present.
//
// Also covers the profile plumbing: parseToolProfile semantics, the fail-closed
// 400 on unknown profile values, and — over real HTTP — that the method-aware
// 401 gate (spec THI-11 §2.10c) still challenges anonymous calls to included
// seller tools on the profile URL while public reads stay anonymous. The HTTP
// block is DB-free (anonymous initialize/tools/list never reach Postgres).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mcpRoutes, TOOL_NAMES } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";
import { registerTools, parseToolProfile, DIRECTORY_PROFILE_TOOLS, PROTECTED_TOOLS, SESSION_ONLY_TOOLS } from "../src/tools.js";
import { apiKeyHash } from "../src/auth.js";

/** THE PIN (THI-614 include list). Sorted alphabetically. Any change here is
 *  a product decision, not a drive-by — it edits the Claude directory
 *  listing's capabilities and needs the same board-lane review as this one. */
const DIRECTORY_PIN: readonly string[] = [
  "add_item_image",
  "create_listing",
  "create_wanted",
  "describe_category",
  "expire_wanted",
  "get_item",
  "get_wanted",
  "my_listings",
  "my_wanted",
  "renew_wanted",
  "respond_to_wanted",
  "search_items",
  "search_wanted",
  "update_listing",
  "update_wanted",
];

/** The money/order/PII/intent/account surface that must NEVER appear in
 *  the directory listing (THI-614 exclude list — everything except the 15;
 *  grew 19→22 when #249/#250 added session-only account tools, which stay
 *  excluded here deliberately). */
const EXCLUDED_PIN: readonly string[] = [
  "buy_shipping_label",
  "cancel_order",
  "confirm_payment",
  "confirm_receipt",
  "create_order",
  "delete_intent",
  "get_api_key_info",
  "get_order",
  "get_payout_setup",
  "list_connected_apps",
  "list_order_messages",
  "my_intents",
  "my_matches",
  "my_orders",
  "open_dispute",
  "record_tracking",
  "release_funds",
  "revoke_connected_app",
  "save_intent",
  "send_order_message",
  "share_shipping_address",
  "update_intent",
];

interface Captured {
  config: { description?: string };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function captureServer(): { server: { registerTool: Function }; registered: Map<string, Captured> } {
  const registered = new Map<string, Captured>();
  const server = {
    registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
      registered.set(name, { config, handler });
    },
  };
  return { server, registered };
}

describe("parseToolProfile (query-value semantics, THI-614)", () => {
  it("absent / null / empty / 'full' → the canonical full profile", () => {
    expect(parseToolProfile(undefined)).toBe("full");
    expect(parseToolProfile(null)).toBe("full");
    expect(parseToolProfile("")).toBe("full");
    expect(parseToolProfile("   ")).toBe("full");
    expect(parseToolProfile("full")).toBe("full");
  });

  it("'directory' (whitespace-tolerant) → the directory subset", () => {
    expect(parseToolProfile("directory")).toBe("directory");
    expect(parseToolProfile(" directory ")).toBe("directory");
  });

  it("anything else → null (caller must fail closed with 400)", () => {
    expect(parseToolProfile("Directory")).toBe(null); // case-sensitive
    expect(parseToolProfile("directoryy")).toBe(null);
    expect(parseToolProfile("claude")).toBe(null);
    expect(parseToolProfile("0")).toBe(null);
    expect(parseToolProfile(["directory"])).toBe(null); // repeated ?profile=
    expect(parseToolProfile({})).toBe(null);
  });
});

describe("directory profile pin (registration-time gating)", () => {
  it("DIRECTORY_PROFILE_TOOLS is exactly the pinned 15-name include list", () => {
    expect([...DIRECTORY_PROFILE_TOOLS].sort()).toEqual([...DIRECTORY_PIN]);
    expect(DIRECTORY_PIN.length).toBe(15);
  });

  it("profile 'directory' registers exactly the pinned 15 tools — no add, no remove", () => {
    const { server, registered } = captureServer();
    registerTools(server, { seller: null }, "directory");
    expect([...registered.keys()].sort()).toEqual([...DIRECTORY_PIN]);
  });

  it("no excluded tool leaks into the directory registration", () => {
    const { server, registered } = captureServer();
    registerTools(server, { seller: null }, "directory");
    for (const name of EXCLUDED_PIN) {
      expect(registered.has(name)).toBe(false);
    }
  });

  it("default registration (no profile arg) is unchanged: all 34 base tools incl. every excluded one", () => {
    const { server, registered } = captureServer();
    registerTools(server, { seller: null });
    expect(registered.size).toBe(34);
    // The base surface carries every non-session excluded tool; the 3
    // session-only ones join only under a web session (next test).
    const baseExcluded = EXCLUDED_PIN.filter((n) => !SESSION_ONLY_TOOLS.has(n));
    expect(baseExcluded.length).toBe(19);
    for (const name of baseExcluded) {
      expect(registered.has(name)).toBe(true);
    }
    // Cross-drift with the funnel instrumentation set (same invariant as
    // tests/tool-call-events.test.ts, from the directory side): the anonymous
    // registration is exactly TOOL_NAMES minus the session-only tools.
    expect([...registered.keys()].sort()).toEqual(
      [...TOOL_NAMES].filter((n) => !SESSION_ONLY_TOOLS.has(n)).sort(),
    );
  });

  it("the directory subset is a strict subset of the full surface", () => {
    const full = captureServer();
    registerTools(full.server, { seller: null });
    for (const name of DIRECTORY_PROFILE_TOOLS) {
      expect(full.registered.has(name)).toBe(true);
    }
  });

  it("session-only account tools (#249/#250) register on full but NEVER on directory", () => {
    // The web session adds 3 account-settings tools to the full profile (34
    // → 37); on the directory profile the same session still gets exactly
    // the 15 — account management cannot leak into the directory listing.
    const fakeSeller = { id: "11111111-1111-1111-1111-111111111111" } as import("../src/db.js").SellerRow;
    const full = captureServer();
    registerTools(full.server, { seller: fakeSeller, credential: "session" });
    expect(full.registered.size).toBe(37);
    for (const name of SESSION_ONLY_TOOLS) {
      expect(full.registered.has(name)).toBe(true);
    }
    const dir = captureServer();
    registerTools(dir.server, { seller: fakeSeller, credential: "session" }, "directory");
    expect([...dir.registered.keys()].sort()).toEqual([...DIRECTORY_PIN]);
    // And the full session surface is exactly the funnel set (37).
    expect([...full.registered.keys()].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("included per-account tools keep their 401-gate annotation (THI-11 §2.10c)", () => {
    // The gate challenges on PROTECTED_TOOLS regardless of profile; every
    // included tool that carries per-account data must be in that set so the
    // OAuth onboarding path survives on the profile URL.
    for (const name of ["create_listing", "update_listing", "my_listings", "add_item_image",
      "create_wanted", "respond_to_wanted", "my_wanted", "update_wanted", "expire_wanted", "renew_wanted"]) {
      expect(PROTECTED_TOOLS.has(name)).toBe(true);
    }
    // And the public reads stay anonymous — not in the challenge set.
    for (const name of ["describe_category", "search_items", "get_item", "search_wanted", "get_wanted"]) {
      expect(PROTECTED_TOOLS.has(name)).toBe(false);
    }
  });
});

describe("/mcp?profile=directory (HTTP, DB-free)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(
      mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }),
    );
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  async function post(path: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
  }

  /** Extracts the first JSON-RPC message from a (possibly SSE) response body. */
  function rpcBody(text: string): any {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  }

  async function toolNames(path: string): Promise<string[]> {
    const res = await post(path, rpc("tools/list"));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect(body.error).toBeUndefined();
    return (body.result?.tools as { name: string }[]).map((t) => t.name);
  }

  it("?profile=directory serves exactly the pinned 15 tools over tools/list", async () => {
    const names = await toolNames("/mcp?profile=directory");
    expect(names.sort()).toEqual([...DIRECTORY_PIN]);
  });

  it("default /mcp (no param) still serves the full surface (34 tools for a non-session caller)", async () => {
    const names = await toolNames("/mcp");
    expect(names.length).toBe(34);
    for (const name of EXCLUDED_PIN.filter((n) => !SESSION_ONLY_TOOLS.has(n))) {
      expect(names).toContain(name);
    }
  });

  it("?profile=full is the same canonical full surface", async () => {
    const names = await toolNames("/mcp?profile=full");
    expect(names.length).toBe(34);
  });

  it("empty ?profile= value falls back to the full surface", async () => {
    const names = await toolNames("/mcp?profile=");
    expect(names.length).toBe(34);
  });

  it("initialize works anonymously on the profile URL (public reads stay free)", async () => {
    const res = await post("/mcp?profile=directory", rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect(body.result?.serverInfo?.name).toBe("thingery");
  });

  it("anonymous create_listing on the profile URL → 401 Bearer challenge (gate intact, THI-11 §2.10c)", async () => {
    const res = await post("/mcp?profile=directory", rpc("tools/call", { name: "create_listing", arguments: { title: "x", price_cents: 1 } }));
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain("resource_metadata=");
    expect(www).not.toContain("invalid_token");
  });

  it("anonymous create_wanted on the profile URL → 401 Bearer challenge (included per-account tool)", async () => {
    const res = await post("/mcp?profile=directory", rpc("tools/call", { name: "create_wanted", arguments: { title: "Vintage watch" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("unknown profile value → 400 fail-closed, never the full surface", async () => {
    const res = await post("/mcp?profile=claude", rpc("tools/list"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; supported_profiles?: string[] };
    expect(body.error).toContain("unknown profile");
    expect(body.supported_profiles).toEqual(["full", "directory"]);
  });

  it("repeated ?profile= params → 400 (array is not a valid profile)", async () => {
    const res = await post("/mcp?profile=directory&profile=full", rpc("tools/list"));
    expect(res.status).toBe(400);
  });
});

// Authenticated behavior on the profile URL needs Postgres (a real seller
// row for the thg_ key) — same skip-if-unavailable pattern as
// tests/mcp-auth.http.test.ts. Verifies the security-relevant edge: a valid
// credential must NOT resurrect an excluded tool on the profile URL — the
// call is rejected as unknown, cleanly, never executed.
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

const dbUp = await dbAvailable();

describe.skipIf(!dbUp)("/mcp?profile=directory with a valid seller key (HTTP + DB)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  let apiKey: string;
  let sellerId: string;

  beforeAll(async () => {
    const app = express();
    app.use(
      mcpRoutes({ authedLimiter: new RateLimiter(1000, 60_000), anonLimiter: new RateLimiter(1000, 60_000) }),
    );
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

    db = new pg.Client({ connectionString });
    await db.connect();
    const runTag = crypto.randomBytes(4).toString("hex");
    apiKey = `thg_dir_${runTag}`;
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [apiKeyHash(apiKey), "Directory Tester", `dir-test-${runTag}@example.com`, "x"],
    );
    sellerId = seller.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM items WHERE seller_id = $1`, [sellerId]);
    await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  async function postAuthed(path: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });
  }

  function rpcBody(text: string): any {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  }

  it("an included tool stays callable with a valid key on the profile URL", async () => {
    const res = await postAuthed("/mcp?profile=directory", rpc("tools/list"));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect((body.result?.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([...DIRECTORY_PIN]);
  });

  it("a valid key must NOT resurrect an excluded tool: clean unknown-tool rejection, no execution", async () => {
    for (const excluded of ["release_funds", "create_order", "get_payout_setup"]) {
      const res = await postAuthed(
        "/mcp?profile=directory",
        rpc("tools/call", { name: excluded, arguments: { order_id: "00000000-0000-0000-0000-000000000000" } }),
      );
      expect(res.status).toBe(200); // JSON-RPC level rejection, not an HTTP failure
      const body = rpcBody(await res.text());
      // The SDK's unknown-tool rejection: a CallToolResult with isError and a
      // message naming the tool — never a handler execution, never a 500.
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain(`Tool ${excluded} not found`);
      expect(body.error).toBeUndefined();
    }
  });

  it("the same excluded tool still resolves on the canonical /mcp (unchanged surface)", async () => {
    const res = await postAuthed("/mcp", rpc("tools/list"));
    expect(res.status).toBe(200);
    const body = rpcBody(await res.text());
    expect((body.result?.tools as { name: string }[]).map((t) => t.name)).toContain("release_funds");
  });
});
