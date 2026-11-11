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
//   3. The canonical /mcp (no param) is unchanged: all 34 tools, every
//      excluded order/payment/payout/intent tool still present.
//
// Also covers the profile plumbing: parseToolProfile semantics, the fail-closed
// 400 on unknown profile values, and — over real HTTP — that the method-aware
// 401 gate (spec THI-11 §2.10c) still challenges anonymous calls to included
// seller tools on the profile URL while public reads stay anonymous. The HTTP
// block is DB-free (anonymous initialize/tools/list never reach Postgres).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mcpRoutes, TOOL_NAMES } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";
import { registerTools, parseToolProfile, DIRECTORY_PROFILE_TOOLS, PROTECTED_TOOLS } from "../src/tools.js";

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

/** The money/order/PII/intent surface that must NEVER appear in the
 *  directory listing (THI-614 exclude list — the other 19 of the 34). */
const EXCLUDED_PIN: readonly string[] = [
  "buy_shipping_label",
  "cancel_order",
  "confirm_payment",
  "confirm_receipt",
  "create_order",
  "delete_intent",
  "get_order",
  "get_payout_setup",
  "list_order_messages",
  "my_intents",
  "my_matches",
  "my_orders",
  "open_dispute",
  "record_tracking",
  "release_funds",
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

  it("default registration (no profile arg) is unchanged: all 34 tools incl. every excluded one", () => {
    const { server, registered } = captureServer();
    registerTools(server, { seller: null });
    expect(registered.size).toBe(34);
    for (const name of EXCLUDED_PIN) {
      expect(registered.has(name)).toBe(true);
    }
    // Cross-drift with the funnel instrumentation set: the full registration
    // is still exactly what mcp-gate logs (same invariant as
    // tests/tool-call-events.test.ts, from the directory side).
    expect([...registered.keys()].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("the directory subset is a strict subset of the full surface", () => {
    const full = captureServer();
    registerTools(full.server, { seller: null });
    for (const name of DIRECTORY_PROFILE_TOOLS) {
      expect(full.registered.has(name)).toBe(true);
    }
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

  it("default /mcp (no param) still serves all 34 tools", async () => {
    const names = await toolNames("/mcp");
    expect(names.length).toBe(34);
    for (const name of EXCLUDED_PIN) {
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
